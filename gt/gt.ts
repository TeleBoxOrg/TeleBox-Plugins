import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { Api } from "teleproto";
import { safeGetMessages } from "@utils/safeGetMessages";

import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 翻译插件 — gt.ts（TeleBox 插件）
// By: djkyc
//
// 谷歌翻译写法照搬 Firefox-Pro-Coding/iciba-translate-userscript
// 里的 GoogleTranslate（src/provider/GoogleTranslate/translate.ts）：
// 主接口是 translate.google.com 的 batchexecute（rpc MkEWBc），
// POST https://translate.google.com/_/TranslateWebserverUi/data/batchexecute
// f.req = [[[ "MkEWBc", JSON.stringify([[文本, 源语言, 目标语言, true], [null]]), null, "generic" ]]]
// 400 时按它的做法取 xsrf token 再重试一次；主接口失败时再退到
// 旧的免费接口 translate.googleapis.com/translate_a/single?client=gtx
// （那个接口在 iciba 代码里是被注释掉的旧写法）。
// 注意：两个都是谷歌非官方免费接口，不用 key，但没有保障——
// 谷歌可能限流、弹验证码（429 / 302 到 google.com/sorry）。
// 2026-11-07 在这台机上实测：gtx 直接 302 到 /sorry，batchexecute
// 返回 429 验证码页，都是出口 IP 被谷歌挡了；Serv00 的 IP 未必一样，
// 装上后在主机上实测为准，失败时插件会明说“被谷歌挡了”，不会乱编译文。
//
// 用法（只留这几种，其他语言不加）：
//   回复一条消息，发 .gt               → 自动判断：中文翻英文，英文翻中文
//   .gt ja こんにちは / .gt r 你好    → 翻成日文（ja / r 都是日文，r 是“日”拼音首字母）
//   .gt h 你好                        → 翻成韩文（h 是“韩”拼音首字母）
//   .gt t 你好                        → 翻成泰文（t 是“泰”拼音首字母）
// 命令统一叫 .gt，文件名 gt.ts。

const LANG_NAMES: Record<string, string> = {
  "zh-CN": "中文",
  en: "英文",
  ja: "日文",
  ko: "韩文",
  th: "泰文",
};

// 跟 iciba 的 store 一样：默认目标中文，第二目标英文。
// 自动模式下：含中文就翻英文，否则翻中文。
const DEFAULT_TARGET = "zh-CN";
const SECOND_TARGET = "en";

// 进程内缓存的 xsrf token（跟 iciba 的 store.data.xsrfToken 一样），
// 400 拿到了就留着，下次请求直接带上。
let xsrfToken = "";

// 只认这几种，其他语言码不认（会当成要翻的正文）：
// zh / en（默认自动中英互翻）、ja / r（日文）、h（韩文）、t（泰文）
// r = 日（ri）拼音首字母，h = 韩（han）拼音首字母，t = 泰（tai）拼音首字母
function normalizeLang(code: string): string | null {
  const c = code.trim().toLowerCase();
  if (!c) return null;
  if (c === "zh" || c === "cn" || c === "zh-cn" || c === "chinese" || c === "中文") return "zh-CN";
  if (c === "en" || c === "english" || c === "英文") return "en";
  if (c === "ja" || c === "jp" || c === "japanese" || c === "日文" || c === "r" || c === "ri" || c === "日") return "ja";
  if (c === "ko" || c === "korean" || c === "韩文" || c === "h" || c === "han" || c === "韩") return "ko";
  if (c === "th" || c === "thai" || c === "泰文" || c === "t" || c === "tai" || c === "泰") return "th";
  return null;
}

function langName(code: string): string {
  return LANG_NAMES[code] || code;
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

// 语言代码归一化比较：zh / zh-CN 算同一种
function sameLang(a: string, b: string): boolean {
  return a.toLowerCase().split("-")[0] === b.toLowerCase().split("-")[0];
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 从 batchexecute 的报错体里抠 xsrf token（iciba 的做法）。
// 报错体是 )]}' + JSON，里面有个 [.., "er", ..] 项，
// err[10][0][48448350] = ["xsrf", token]。
function extractXsrf(bodyText: string): string {
  try {
    const jsonText = bodyText.startsWith(")]}'") ? bodyText.slice(4) : bodyText;
    const body = JSON.parse(jsonText) as Array<any>;
    const err = body.find((v) => v && v[0] === "er") as Array<any> | undefined;
    const detail = err?.[10]?.[0]?.[48448350] as Array<any> | undefined;
    if (detail && detail[0] === "xsrf" && typeof detail[1] === "string") return detail[1];
    // 兜底：在整个结构里递归找 ["xsrf", token]
    const walk = (v: any): string => {
      if (Array.isArray(v)) {
        if (v[0] === "xsrf" && typeof v[1] === "string") return v[1];
        for (const item of v) {
          const r = walk(item);
          if (r) return r;
        }
      }
      return "";
    };
    return walk(body);
  } catch {
    return "";
  }
}

function parseBatchExecute(bodyText: string): { text: string; detected: string } {
  const jsonText = bodyText.startsWith(")]}'") ? bodyText.slice(4) : bodyText;
  const data = JSON.parse(jsonText) as Array<any>;
  if (data[0]?.[1] !== "MkEWBc") throw new Error("谷歌返回格式变了（不是 MkEWBc）");
  const inner = JSON.parse(data[0][2]) as Array<any>;
  const detected = (inner[0]?.[2] as string) || "auto";
  // iciba：translate = data[1][0][0][5].map(v => v[0])
  const sentences = inner[1]?.[0]?.[0]?.[5] as Array<any> | undefined;
  if (Array.isArray(sentences) && sentences.length > 0) {
    return { text: sentences.map((v) => v[0] as string).join(""), detected };
  }
  // 兜底：有的返回只有单句，落在 [1][0][0][0]
  const single = inner[1]?.[0]?.[0]?.[0];
  if (typeof single === "string" && single) return { text: single, detected };
  throw new Error("谷歌返回里找不到译文");
}

// 主接口：iciba 的 batchexecute 写法
async function googleBatch(
  text: string,
  sl: string,
  tl: string,
): Promise<{ text: string; detected: string }> {
  const buildReq = () =>
    JSON.stringify([
      [
        [
          "MkEWBc",
          JSON.stringify([[text, sl, tl, true], [null]]),
          null,
          "generic",
        ],
      ],
    ]);

  const doRequest = async (withToken: boolean) => {
    const params = new URLSearchParams({ "f.req": buildReq() });
    if (withToken && xsrfToken) params.set("at", xsrfToken);
    const res = await fetchWithTimeout(
      "https://translate.google.com/_/TranslateWebserverUi/data/batchexecute",
      {
        method: "POST",
        headers: {
          Referer: "https://translate.google.com/",
          "Cache-Control": "max-age=0",
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
        body: params.toString(),
      },
    );
    return res;
  };

  let res = await doRequest(!!xsrfToken);
  let body = await res.text();

  // 400 且没带 token：按 iciba 的做法，先拿 xsrf 再重试一次
  if (res.status === 400 && !xsrfToken) {
    const token = extractXsrf(body);
    if (token) {
      xsrfToken = token;
      res = await doRequest(true);
      body = await res.text();
    }
  }

  if (res.status === 429 || res.status === 403) {
    throw new Error(`谷歌限流/要验证码（HTTP ${res.status}），这个 IP 被谷歌暂时挡了，等一会再试`);
  }
  if (body.includes("recaptcha") || body.includes("google.com/sorry")) {
    throw new Error("谷歌弹验证码了，这个 IP 被谷歌暂时挡了，等一会再试");
  }
  if (!res.ok) throw new Error(`谷歌主接口失败（HTTP ${res.status}）`);
  return parseBatchExecute(body);
}

// 备用接口：iciba 代码里注释掉的旧写法，gtx 免费接口
async function googleGtx(
  text: string,
  sl: string,
  tl: string,
): Promise<{ text: string; detected: string }> {
  // gtx 是 GET，URL 不能太长，超 1800 字就按行切开分段翻
  const chunks: string[] = [];
  if (text.length <= 1800) {
    chunks.push(text);
  } else {
    const lines = text.split("\n");
    let cur = "";
    for (const line of lines) {
      if ((cur + "\n" + line).length > 1800 && cur) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + "\n" + line : line;
      }
    }
    if (cur) chunks.push(cur);
  }

  const out: string[] = [];
  let detected = sl;
  for (const chunk of chunks) {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" +
      encodeURIComponent(sl) +
      "&tl=" +
      encodeURIComponent(tl) +
      "&dt=t&q=" +
      encodeURIComponent(chunk);
    const res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    const body = await res.text();
    if (body.includes("google.com/sorry") || body.startsWith("<HTML")) {
      throw new Error("谷歌备用接口也被挡了（跳到 /sorry），这个 IP 被谷歌暂时挡了");
    }
    if (!res.ok) throw new Error(`谷歌备用接口失败（HTTP ${res.status}）`);
    const data = JSON.parse(body) as Array<any>;
    if (!Array.isArray(data?.[0])) throw new Error("谷歌备用接口返回格式变了");
    out.push(data[0].map((s: any) => s[0] as string).join(""));
    if (typeof data[2] === "string" && data[2]) detected = data[2];
  }
  return { text: out.join("\n"), detected };
}

// 先主接口，失败再备用接口；都失败就把两个原因都报出来
async function translateWithGoogle(
  text: string,
  tl: string,
): Promise<{ text: string; detected: string; target: string }> {
  let batchErr: any = null;
  try {
    const r = await googleBatch(text, "auto", tl);
    // 跟 iciba 一样：检测出的语言就是目标语言时，翻到第二目标语言
    if (sameLang(r.detected, tl)) {
      const second = sameLang(tl, "zh-CN") ? SECOND_TARGET : DEFAULT_TARGET;
      const r2 = await googleBatch(text, "auto", second);
      return { ...r2, target: second };
    }
    return { ...r, target: tl };
  } catch (e) {
    batchErr = e;
  }
  try {
    const r = await googleGtx(text, "auto", tl);
    if (sameLang(r.detected, tl)) {
      const second = sameLang(tl, "zh-CN") ? SECOND_TARGET : DEFAULT_TARGET;
      const r2 = await googleGtx(text, "auto", second);
      return { ...r2, target: second };
    }
    return { ...r, target: tl };
  } catch (e: any) {
    throw new Error(`主接口失败：${batchErr?.message || batchErr}；备用接口也失败：${e?.message || e}`);
  }
}

class GtPlugin extends Plugin {
  description: string = `🌐 <b>谷歌翻译</b><br/><br/>
<b>命令</b><br/>
• <code>${mainPrefix}gt [文本]</code>：不写语言就自动翻，中文翻英文，英文翻中文<br/>
• 回复一条消息后发 <code>${mainPrefix}gt</code>，直接翻译那条消息<br/><br/>
<b>指定语言（只这几种）</b><br/>
• <code>${mainPrefix}gt ja こんにちは</code> / <code>${mainPrefix}gt r 你好</code>：翻成日文<br/>
• <code>${mainPrefix}gt h 你好</code>：翻成韩文<br/>
• <code>${mainPrefix}gt t 你好</code>：翻成泰文<br/><br/>
<b>示例</b><br/>
• <code>${mainPrefix}gt hello world</code> → 中文<br/>
• <code>${mainPrefix}gt 你好世界</code> → 英文<br/>
• 回复一条消息后发 <code>${mainPrefix}gt</code>`;

  private handleTranslate = async (msg: Api.Message): Promise<void> => {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    try {
      // 全文保留多行：只拿第一行做命令解析，剩下的行都是要翻的文本
      const full = msg.text?.trim() || "";
      const nl = full.indexOf("\n");
      const firstLine = nl === -1 ? full : full.slice(0, nl);
      const restLines = nl === -1 ? "" : full.slice(nl + 1).trim();
      const parts = firstLine.split(/\s+/).filter(Boolean);
      const [, ...args] = parts; // 跳过命令本身

      // 可选的目标语言：.gt zh hello / .gt to en hello / .gt en
      let explicitTarget: string | null = null;
      let textArgs = args;
      if (args.length > 0) {
        if (args[0].toLowerCase() === "to" && args[1]) {
          explicitTarget = normalizeLang(args[1]);
          if (explicitTarget) textArgs = args.slice(2);
        } else {
          const maybeLang = normalizeLang(args[0]);
          // 只有“语言码 + 还有别的内容”或“语言码 + 回复了消息”时才当成语言码，
          // 不然 .gt en 这种单个词会被误当成语言码吃掉
          if (maybeLang && (args.length > 1 || (msg.replyTo && "replyToMsgId" in msg.replyTo && msg.replyTo.replyToMsgId))) {
            explicitTarget = maybeLang;
            textArgs = args.slice(1);
          }
        }
      }

      let text = [textArgs.join(" "), restLines].filter(Boolean).join("\n").trim();

      // 没给文本就翻回复的那条消息
      if (!text && msg.replyTo && "replyToMsgId" in msg.replyTo && msg.replyTo.replyToMsgId) {
        try {
          const replyMsgId = msg.replyTo.replyToMsgId;
          const messages = await safeGetMessages(client, msg.peerId!, {
            ids: [replyMsgId],
          });
          const replied: any = messages && messages.length > 0 ? messages[0] : null;
          text = (replied?.message || replied?.caption || "").trim();
          if (!text) {
            await msg.edit({
              text: "❌ 回复的那条消息没有文字内容",
              parseMode: "html",
            });
            return;
          }
        } catch {
          await msg.edit({
            text: "❌ 获取回复消息失败",
            parseMode: "html",
          });
          return;
        }
      }

      if (!text) {
        await msg.edit({
          text:
            `❌ <b>参数不足</b>\n\n💡 请提供要翻译的文本，或回复一条消息\n\n` +
            `<b>用法:</b>\n` +
            `• <code>${mainPrefix}gt hello world</code> - 翻译指定文本\n` +
            `• <code>${mainPrefix}gt</code> (回复消息) - 翻译回复的消息\n` +
            `• <code>${mainPrefix}gt zh hello</code> - 指定翻成中文`,
          parseMode: "html",
        });
        return;
      }

      if (text.length > 4000) {
        await msg.edit({
          text: `❌ 文本太长了（${text.length} 字），谷歌免费接口一次最多 4000 字，请分段发`,
          parseMode: "html",
        });
        return;
      }

      const target = explicitTarget || (hasChinese(text) ? "en" : "zh-CN");

      await msg.edit({ text: "🔄 正在翻译...", parseMode: "html" });

      const result = await translateWithGoogle(text, target);
      const fromName = result.detected && result.detected !== "auto" ? langName(result.detected) : "自动检测";
      const toName = langName(result.target);

      // 原文太长只展示前 200 字，免得超 Telegram 单条长度
      const origPreview = text.length > 200 ? text.slice(0, 200) + "…" : text;
      await msg.edit({
        text:
          `<b>🌐 ${htmlEscape(fromName)} → ${htmlEscape(toName)}</b>\n\n` +
          `${htmlEscape(result.text)}\n\n` +
          `—— 原文：${htmlEscape(origPreview)}`,
        parseMode: "html",
      });
    } catch (error: any) {
      console.error("Gt translation error:", error);
      await msg.edit({
        text: `❌ <b>翻译失败:</b> ${htmlEscape(error?.message || String(error))}\n\n💡 谷歌免费接口没有保障，IP 被限流或弹验证码时就会这样，等一会再试，或换个网络再试。`,
        parseMode: "html",
      });
    }
  };

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    gt: async (msg: Api.Message) => {
      await this.handleTranslate(msg);
    },
  };
}

export default new GtPlugin();
