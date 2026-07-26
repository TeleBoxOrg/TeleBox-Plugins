/**
 * NodeSeek 论坛每日签到插件
 *
 * 命令：
 *   .nodeseek set <cookie>   设置/更新登录 Cookie
 *   .nodeseek now            立即手动签到一次
 *   .nodeseek status         查看 Cookie 与签到状态
 *   .nodeseek auto on|off    开启/关闭每日自动签到（随机时间）
 *   .nodeseek help           查看帮助
 *
 * 签到逻辑参考 xinycai/nodeseek_signin：
 *   直接使用已登录的 Cookie 调用签到接口，无需账号密码登录。
 *   POST https://www.nodeseek.com/api/attendance?random=true
 *
 * 与 Surge 版本的区别：
 *   TeleBox 是常驻 Node.js 进程（PM2 管理），不像手机端代理工具那样
 *   对脚本挂起时长有系统级硬限制，所以这里直接用「cron 固定触发 +
 *   setTimeout 随机延迟」即可让每天的签到时间点不一样，不需要再用
 *   多触发点抽签的折中方案。
 */

import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { TelegramClient } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import axios from "axios";
import * as path from "path";

type NodeSeekData = {
  cookie: string;
  autoEnabled: boolean;
  lastDoneDate: string; // 今天是否已经处理过签到，格式 YYYY-MM-DD
  lastResult: string;
};

const DEFAULT_DATA: NodeSeekData = {
  cookie: "",
  autoEnabled: false,
  lastDoneDate: "",
  lastResult: "",
};

let dbInstance: Low<NodeSeekData> | null = null;

async function getDB(): Promise<Low<NodeSeekData>> {
  if (!dbInstance) {
    const dbPath = path.join(createDirectoryInAssets("nodeseek"), "data.json");
    dbInstance = await JSONFilePreset<NodeSeekData>(dbPath, DEFAULT_DATA);
  }
  return dbInstance;
}

// random=true 表示随机鸡腿奖励（论坛默认收益更高也更随机），改成 false 则为固定档位
const SIGN_RANDOM = true;
const MAX_RETRY = 3;
// 自动签到窗口：cron 在窗口起点触发后，再随机延迟 0~此值分钟才真正签到
const RANDOM_DELAY_MAX_MINUTES = 59;

const COMMON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  origin: "https://www.nodeseek.com",
  referer: "https://www.nodeseek.com/board",
  "Content-Type": "application/json",
};

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SignStatus = "success" | "already" | "invalid" | "fail" | "error";
type SignResult = {
  result: SignStatus;
  msg: string;
  diag?: string; // 失败时的诊断信息：服务器标识 + 响应片段，用于区分 WAF 拦截 vs 真实业务错误
};

function looksLikeWafChallenge(serverHeader: string, bodyText: string): boolean {
  const s = (serverHeader || "").toLowerCase();
  const b = (bodyText || "").toLowerCase();
  return (
    s.includes("cloudflare") ||
    b.includes("cf-browser-verification") ||
    b.includes("just a moment") ||
    b.includes("attention required") ||
    b.includes("checking your browser") ||
    b.includes("sorry, you have been blocked")
  );
}

async function signInOnce(cookie: string): Promise<SignResult> {
  const url = `https://www.nodeseek.com/api/attendance?random=${SIGN_RANDOM ? "true" : "false"}`;
  try {
    const resp = await axios.post(
      url,
      {},
      {
        headers: { ...COMMON_HEADERS, Cookie: cookie },
        timeout: 15000,
        validateStatus: () => true,
        responseType: "text",
        transformResponse: [(d) => d], // 保留原始字符串，自己决定要不要 JSON.parse
      }
    );
    const status = resp.status;
    const serverHeader = String(resp.headers?.["server"] || resp.headers?.["Server"] || "");
    const rawBody = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || "");

    // NodeSeek 签到接口的约定：成功/失败都用 HTTP 200 返回，真正的状态在 JSON 的
    // code / retcode / success 字段里。401 才代表 Cookie 过期。因此**先解析业务码**，
    // 仅当完全无法解析 JSON 时才退回到状态码判断。
    if (status !== 200) {
      const isWaf = looksLikeWafChallenge(serverHeader, rawBody);
      const snippet = rawBody.replace(/\s+/g, " ").trim().slice(0, 200);
      // 401 是确定的登录态失效；其余非 200 多为 WAF 拦截或网络层问题，不直接判 Cookie 失效
      const res: SignStatus = status === 401 ? "invalid" : isWaf ? "fail" : "error";
      return {
        result: res,
        msg:
          status === 401
            ? "Cookie 已失效，请重新获取"
            : `HTTP ${status}${isWaf ? "（疑似被 Cloudflare/WAF 拦截，并非 Cookie 失效）" : ""}`,
        diag: `server=${serverHeader || "未知"} | body片段: ${snippet}`,
      };
    }

    let data: any = {};
    try {
      data = JSON.parse(rawBody);
    } catch {
      // 200 但响应不是合法 JSON：可能是 WAF 挑战页或网关错误
      const isWaf = looksLikeWafChallenge(serverHeader, rawBody);
      return {
        result: "error",
        msg: isWaf ? "请求被 Cloudflare/WAF 拦截，稍后重试" : "响应格式异常，无法解析",
        diag: `server=${serverHeader || "未知"} | body片段: ${rawBody.replace(/\s+/g, " ").trim().slice(0, 200)}`,
      };
    }

    // 兼容多种业务码字段
    const code = data.code ?? data.retcode ?? data.status;
    const success = data.success === true || data.code === 1 || data.retcode === 1;
    const msg: string = data.message || data.msg || data.reason || "";

    // 登录态失效的多种措辞
    if (/未登录|登录已过期|请先登录|not.*login|unauthorized|invalid.*cookie|cookie/i.test(msg) || code === 401 || code === 4001 || code === 1001) {
      return { result: "invalid", msg: msg || "Cookie 已失效，请重新获取" };
    }
    if (success || /鸡腿|签到成功|成功签到/.test(msg)) {
      return { result: "success", msg: msg || "签到成功" };
    }
    if (/已完成签到|已签到|今天已签到|已经签到/.test(msg) || code === 0) {
      return { result: "already", msg: msg || "今日已签到" };
    }
    // 兜底：业务码明确报错
    return {
      result: "fail",
      msg: msg || `签到失败（业务码 ${typeof code === "number" ? code : "未知"}）`,
      diag: `server=${serverHeader || "未知"} | body片段: ${rawBody.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    };
  } catch (e: any) {
    return { result: "error", msg: e?.message || "网络请求出错" };
  }
}

async function signInWithRetry(cookie: string, maxRetry = MAX_RETRY): Promise<SignResult> {
  let last: SignResult = { result: "fail", msg: "未知错误" };
  for (let i = 0; i < maxRetry; i++) {
    last = await signInOnce(cookie);
    if (last.result !== "fail" && last.result !== "error") return last;
    if (i + 1 < maxRetry) await sleep(3000);
  }
  return last;
}

const EMOJI: Record<SignStatus, string> = {
  success: "🍗",
  already: "✅",
  invalid: "⚠️",
  fail: "❌",
  error: "⚠️",
};

const TITLE: Record<SignStatus, string> = {
  success: "签到成功",
  already: "今日已签到",
  invalid: "Cookie 已失效",
  fail: "签到失败",
  error: "请求出错",
};

const HELP_TEXT = `🍗 <b>NodeSeek 自动签到</b>

<b>用法：</b>
• <code>.nodeseek set &lt;cookie&gt;</code> 设置/更新登录 Cookie
• <code>.nodeseek now</code> 立即手动签到一次
• <code>.nodeseek status</code> 查看 Cookie 与签到状态
• <code>.nodeseek auto on</code> 开启每日自动签到（8:00~8:59 随机一次）
• <code>.nodeseek auto off</code> 关闭每日自动签到
• <code>.nodeseek help</code> 显示本帮助

<b>获取 Cookie：</b>
浏览器登录 nodeseek.com 后按 F12 打开开发者工具 → Network → 刷新页面 → 任意一个请求的 Request Headers 里复制完整的 Cookie 字段值。

<b>说明：</b>
签到逻辑参考 xinycai/nodeseek_signin，直接调用 NodeSeek 签到接口，无需账号密码登录。Cookie 仅保存在本机 assets/nodeseek/data.json 中。`;

class NodeSeekPlugin extends Plugin {
  description = "NodeSeek 论坛每日签到，领取鸡腿";

  cmdHandlers = {
    nodeseek: async (msg: Api.Message) => {
      const args = msg.text?.trim().split(/\s+/).slice(1) || [];
      const sub = (args[0] || "").toLowerCase();
      const db = await getDB();

      try {
        if (!sub || sub === "help") {
          await msg.edit({ text: HELP_TEXT, parseMode: "html" });
          return;
        }

        if (sub === "set") {
          const cookie = msg.text?.trim().split(/\s+/).slice(2).join(" ") || "";
          if (!cookie || cookie.length < 20) {
            await msg.edit({
              text: "❌ 请提供有效的 Cookie，例如：\n<code>.nodeseek set ns_xxx=xxx; other=xxx</code>",
              parseMode: "html",
            });
            return;
          }
          db.data.cookie = cookie;
          db.data.lastDoneDate = "";
          await db.write();
          await msg.edit({
            text: "🍪 Cookie 已保存，可以用 <code>.nodeseek now</code> 测试签到了",
            parseMode: "html",
          });
          return;
        }

        if (sub === "now") {
          if (!db.data.cookie) {
            await msg.edit({
              text: "⚠️ 还没有设置 Cookie，先用 <code>.nodeseek set &lt;cookie&gt;</code> 设置",
              parseMode: "html",
            });
            return;
          }
          await msg.edit({ text: "⏳ 正在签到…" });
          const info = await signInWithRetry(db.data.cookie);
          db.data.lastResult = info.msg;
          if (info.result !== "fail" && info.result !== "error") {
            db.data.lastDoneDate = todayStr();
          }
          await db.write();
          const diagLine = info.diag ? `\n\n<code>${info.diag.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>` : "";
          await msg.edit({
            text: `${EMOJI[info.result]} <b>${TITLE[info.result]}</b>\n${info.msg}${diagLine}`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "status") {
          const lines = [
            `🍪 Cookie：${db.data.cookie ? "已设置" : "未设置"}`,
            `⏰ 自动签到：${db.data.autoEnabled ? "已开启（每天 8:00~8:59 随机一次）" : "未开启"}`,
            `📅 今日是否已处理：${db.data.lastDoneDate === todayStr() ? "是" : "否"}`,
            `📝 最近一次结果：${db.data.lastResult || "无"}`,
          ];
          await msg.edit({ text: lines.join("\n") });
          return;
        }

        if (sub === "auto") {
          const onOff = (args[1] || "").toLowerCase();
          if (onOff !== "on" && onOff !== "off") {
            await msg.edit({
              text: "用法：<code>.nodeseek auto on</code> 或 <code>.nodeseek auto off</code>",
              parseMode: "html",
            });
            return;
          }
          db.data.autoEnabled = onOff === "on";
          await db.write();
          await msg.edit({
            text: db.data.autoEnabled ? "✅ 已开启每日自动签到" : "⏹️ 已关闭每日自动签到",
          });
          return;
        }

        await msg.edit({ text: HELP_TEXT, parseMode: "html" });
      } catch (error: any) {
        await msg.edit({ text: `❌ 出错了: ${error?.message || error}` });
      }
    },
  };

  cronTasks = {
    nodeseek_daily_checkin: {
      cron: "0 8 * * *", // 每天 8:00 触发，内部再随机延迟，模拟“非准点签到”
      description: "NodeSeek 每日自动签到（8:00~8:59 内随机执行一次）",
      handler: async (client: TelegramClient) => {
        const db = await getDB();
        if (!db.data.autoEnabled) return;
        if (!db.data.cookie) return;
        if (db.data.lastDoneDate === todayStr()) return;

        const delayMs = Math.floor(Math.random() * RANDOM_DELAY_MAX_MINUTES * 60 * 1000);
        await sleep(delayMs);

        // 延迟期间状态可能变化（用户手动签到/关闭了自动签到），再确认一次
        if (!db.data.autoEnabled) return;
        if (db.data.lastDoneDate === todayStr()) return;

        const info = await signInWithRetry(db.data.cookie);
        db.data.lastResult = info.msg;
        if (info.result !== "fail" && info.result !== "error") {
          db.data.lastDoneDate = todayStr();
        }
        await db.write();

        try {
          await client.sendMessage("me", {
            message: `${EMOJI[info.result]} NodeSeek ${TITLE[info.result]}\n${info.msg}`,
          });
        } catch (e) {
          // 发送通知失败不影响签到结果本身
        }
      },
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "nodeseek",
    title: "NodeSeek 通知",
    description: "NodeSeek 论坛通知配置",
    category: "插件配置",
    icon: "📢",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "cookie",
            "label": "Cookie",
            "type": "password",
            "secret": true
      },
      {
            "key": "chatId",
            "label": "推送 Chat ID",
            "type": "string"
      },
      {
            "key": "interval",
            "label": "检查间隔 (分钟)",
            "type": "number",
            "min": 1,
            "max": 1440,
            "default": 5
      },
      {
            "key": "maxItems",
            "label": "最大推送条数",
            "type": "number",
            "min": 1,
            "max": 20,
            "default": 5
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("nodeseek"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("nodeseek"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
}

export default new NodeSeekPlugin();
