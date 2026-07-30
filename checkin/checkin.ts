import { Plugin, type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";

interface SignTarget {
  id: string;
  name: string;
  target: string;
  command: string;
  callbackData?: string;
  buttonText?: string;
  enabled: boolean;
  lastSignTime?: string;
}

interface CheckInConfig {
  runTime: string;
  runTimeEnd?: string;
  logChat: string;
  randomDelay: number;
  lastRunDate: string;
  botToken: string;
  pushChatId: string;
  targets: SignTarget[];
  currentRunTime?: string;
}

interface PendingAdd {
  promptMsgId: number;
  id: string;
  name: string;
  target: string;
  matcher: Pick<SignTarget, "callbackData" | "buttonText">;
}

type SignResult = { success: boolean; message?: string; error?: string };

const DEFAULT_CONFIG: CheckInConfig = {
  runTime: "10:00",
  runTimeEnd: "11:30",
  logChat: "",
  randomDelay: 0,
  lastRunDate: "",
  botToken: "",
  pushChatId: "",
  targets: [],
  currentRunTime: undefined,
};

const SH_TZ = "Asia/Shanghai";
const PREFIX = getPrefixes()[0] || ".";

function maskSecret(val: string, visibleChars = 4): string {
  if (!val) return "(未配置)";
  if (val.length <= visibleChars * 2) return "••••••••";
  return `${val.slice(0, visibleChars)}••••••${val.slice(-visibleChars)}`;
}

class ConfigManager {
  private readonly configPath: string;
  private data: CheckInConfig;

  constructor() {
    const dir = createDirectoryInAssets("checkin");
    this.configPath = path.join(dir, "checkin_config.json");
    this.data = this.load();
  }

  private load(): CheckInConfig {
    try {
      if (!fs.existsSync(this.configPath)) return { ...DEFAULT_CONFIG };
      const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      const merged = { ...DEFAULT_CONFIG, ...raw };
      merged.targets = Array.isArray(raw?.targets) ? raw.targets : [];
      return merged;
    } catch (e) {
      console.error("[CheckIn] Config load error:", e);
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): CheckInConfig {
    return this.data;
  }

  save(partial: Partial<CheckInConfig>): void {
    this.data = { ...this.data, ...partial };
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (e) {
      console.error("[CheckIn] Config save error:", e);
    }
  }
}

class CheckInPlugin extends Plugin {
  description = this.helpText();
  private readonly cfg = new ConfigManager();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pendingAdds = new Map<string, PendingAdd>();

  constructor() {
    super();
    this.timer = setInterval(() => void this.checkAndRun(), 60_000);
  }

  cleanup(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    checkin: async (msg: Api.Message) => {
      try {
        const parts = (msg.message || msg.text || "").trim().split(/\s+/);
        const args = parts.slice(1);
        const action = (args[0] || "").toLowerCase();

        if (!action || action === "help" || action === "h") {
          if (!action && this.cfg.get().targets.length > 0) {
            await this.edit(msg, "🚀 开始执行所有签到任务...");
            void this.runAllSigns("手动触发", msg.chatId, msg);
            return;
          }
          await this.edit(msg, this.helpText());
          return;
        }

        if (["add", "del", "delete", "list", "toggle", "test"].includes(action)) {
          await this.handleTargetCommand(action, args, msg);
          return;
        }

        if (["set", "config", "settings", "info"].includes(action)) {
          await this.handleConfigCommand(action, args, msg);
          return;
        }

        if (action === "reset") {
          this.cfg.save({ lastRunDate: "", currentRunTime: undefined });
          await this.edit(msg, "✅ 已重置每日运行状态，定时任务可再次触发。");
          return;
        }

        await this.edit(msg, `❌ 未知命令，请使用 ${PREFIX}checkin help 查看帮助`);
      } catch (e: any) {
        console.error("[CheckIn] Command error:", e);
        try {
          await this.edit(msg, `❌ 命令执行失败: ${this.escape(e?.message || "未知错误")}`);
        } catch {}
      }
    },
  };

  // ── 回复式添加：监听用户回复以获取签到命令 ─
  listenMessageHandler = async (msg: Api.Message, _options?: { isEdited?: boolean }) => {
    if (_options?.isEdited) return;
    const chatId = String(msg.chatId || msg.peerId || "");
    const pending = this.pendingAdds.get(chatId);
    if (!pending) return;

    const replyToMsgId = (msg as any).replyTo?.replyToMsgId ?? (msg as any).replyToMsgId;
    if (replyToMsgId !== pending.promptMsgId) return;

    const command = (msg.message || msg.text || "").trim();
    if (!command) {
      const client = await getGlobalClient();
      await client?.sendMessage(chatId, {
        message: "❌ 签到命令不能为空，请重新回复此消息",
        parseMode: "html",
        linkPreview: false,
      });
      return;
    }

    this.pendingAdds.delete(chatId);

    const conf = this.cfg.get();
    const next: SignTarget = {
      id: pending.id,
      name: pending.name,
      target: pending.target,
      command,
      ...pending.matcher,
      enabled: true,
    };
    const i = conf.targets.findIndex((t) => t.id === pending.id);
    if (i >= 0) conf.targets[i] = next;
    else conf.targets.push(next);
    this.cfg.save({ targets: conf.targets });

    const client = await getGlobalClient();
    await client?.sendMessage(chatId, {
      message: `✅ 已${i >= 0 ? "更新" : "添加"}签到目标: ${pending.name} (${pending.id})\n命令: ${this.escape(command)}`,
      parseMode: "html",
      linkPreview: false,
    });
  };

  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "checkin",
    title: "自动签到",
    description: "定时自动签到任务配置：运行时间、推送设置、签到目标管理",
    category: "插件配置",
    icon: "✅",
    getSchema: (): PanelSettingField[] => [
      {
        key: "runTime",
        label: "运行时间",
        type: "string",
        placeholder: "10:00 (24小时制)",
        default: "10:00",
        description: "每日自动运行时间，格式 HH:MM",
      },
      {
        key: "randomDelay",
        label: "随机延迟 (分钟)",
        type: "number",
        min: 0,
        max: 1440,
        default: 0,
        description: "运行前随机等待 0~N 分钟，避免集中请求",
      },
      {
        key: "logChat",
        label: "日志推送聊天",
        type: "string",
        placeholder: "@channel 或 -100xxxxxx",
        description: "签到结果推送到的群组/频道 (留空不推送)",
      },
      {
        key: "botToken",
        label: "Bot Token (推送用)",
        type: "password",
        secret: true,
        description: "用于推送签到结果的 Bot Token (可选，留空使用 userbot 推送)",
      },
      {
        key: "pushChatId",
        label: "推送 Chat ID",
        type: "string",
        placeholder: "-100xxxxxx",
        description: "Bot 推送目标 Chat ID (配合 botToken 使用)",
      },
      {
        key: "targets",
        label: "签到目标列表",
        type: "textarea",
        description: `JSON 数组，每项: { "id": "唯一标识", "name": "显示名", "target": "@bot或群组", "command": "/start", "callbackData": "回调数据(可选)", "buttonText": "按钮文本(可选)", "enabled": true }`,
      },
    ],
    getValues: async (): Promise<Record<string, unknown>> => {
      const cfg = new ConfigManager().get();
      return {
        runTime: cfg.runTime || "10:00",
        randomDelay: cfg.randomDelay ?? 0,
        logChat: cfg.logChat || "",
        botToken: cfg.botToken ? maskSecret(cfg.botToken) : "",
        pushChatId: cfg.pushChatId || "",
        targets: JSON.stringify(cfg.targets || [], null, 2),
      };
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const cfg = new ConfigManager();
      const updates: Partial<CheckInConfig> = {};

      if (typeof patch.runTime === "string") updates.runTime = patch.runTime;
      if (typeof patch.randomDelay === "number") updates.randomDelay = patch.randomDelay;
      if (typeof patch.logChat === "string") updates.logChat = patch.logChat;
      if (typeof patch.botToken === "string" && !String(patch.botToken).includes("••••••••")) {
        updates.botToken = String(patch.botToken);
      }
      if (typeof patch.pushChatId === "string") updates.pushChatId = patch.pushChatId;
      if (typeof patch.targets === "string") {
        try {
          updates.targets = JSON.parse(patch.targets) as SignTarget[];
        } catch {
          throw new Error("签到目标 JSON 格式错误");
        }
      }

      if (Object.keys(updates).length > 0) {
        cfg.save(updates);
      }
    },
  };

  private async handleTargetCommand(action: string, args: string[], msg: Api.Message): Promise<void> {
    const conf = this.cfg.get();

    if (action === "add") {
      const id = args[1];
      const name = args[2];
      const target = args[3];
      if (!id || !name || !target) {
        await this.edit(msg, `❌ 格式错误：${PREFIX}checkin add [ID] [名称] [目标] [可选: data:xxx | text:xxx]`);
        return;
      }

      const matcher = this.parseButtonMatcher(args.slice(4));
      const chatId = String(msg.chatId || msg.peerId || "");

      const client = await getGlobalClient();
      const prompt = await client.sendMessage(chatId, {
        message: [
          `📝 请<b>回复此消息</b>，发送签到命令（支持空格和特殊字符）`,
          ``,
          `ID: ${this.escape(id)}`,
          `名称: ${this.escape(name)}`,
          `目标: ${this.escape(target)}`,
          matcher.callbackData ? `回调: ${this.escape(matcher.callbackData)}` : "",
          matcher.buttonText ? `按钮: ${this.escape(matcher.buttonText)}` : "",
        ].filter(Boolean).join("\n"),
        parseMode: "html",
        linkPreview: false,
      });

      this.pendingAdds.set(chatId, {
        promptMsgId: Number((prompt as any)?.id || 0),
        id,
        name,
        target,
        matcher,
      });
      return;
    }

    if (action === "del" || action === "delete") {
      const id = args[1];
      if (!id) return void (await this.edit(msg, `❌ 请指定目标ID：${PREFIX}checkin del [ID]`));
      const n = conf.targets.length;
      conf.targets = conf.targets.filter((t) => t.id !== id);
      this.cfg.save({ targets: conf.targets });
      await this.edit(msg, conf.targets.length < n ? `✅ 已删除签到目标: ${id}` : `❌ 未找到目标: ${id}`);
      return;
    }

    if (action === "list") {
      if (!conf.targets.length) return void (await this.edit(msg, "📝 当前没有配置签到目标"));
      const enabled = conf.targets.filter((t) => t.enabled).length;
      const timeRange = conf.runTimeEnd ? `${conf.runTime} ~ ${conf.runTimeEnd}` : conf.runTime;
      const lines = conf.targets
        .map((t, i) => {
          const m = t.callbackData ? `\n   回调: ${this.escape(t.callbackData)}` : t.buttonText ? `\n   按钮: ${this.escape(t.buttonText)}` : "";
          return `${t.enabled ? "🟢" : "🔴"} <b>${i + 1}. ${this.escape(t.name)}</b>\n   ID: ${this.escape(t.id)}\n   目标: ${this.escape(t.target)}\n   命令: ${this.escape(t.command)}${m}\n   ⏰ 设定时间段: ${this.escape(timeRange)}\n   ✅ 实际签到: ${this.escape(t.lastSignTime || "尚未签到")}`;
        })
        .join("\n\n");
      await this.edit(msg, `📝 <b>签到目标列表</b> (${enabled}/${conf.targets.length} 个启用)\n\n${lines}`);
      return;
    }

    if (action === "toggle") {
      const id = args[1];
      if (!id) return void (await this.edit(msg, `❌ 请指定目标ID：${PREFIX}checkin toggle [ID]`));
      const t = conf.targets.find((x) => x.id === id);
      if (!t) return void (await this.edit(msg, `❌ 未找到目标: ${id}`));
      t.enabled = !t.enabled;
      this.cfg.save({ targets: conf.targets });
      await this.edit(msg, `✅ 已${t.enabled ? "启用" : "禁用"}签到目标: ${this.escape(t.name)} (${this.escape(id)})`);
      return;
    }

    if (action === "test") {
      const id = args[1];
      if (!id) return void (await this.edit(msg, `❌ 请指定目标ID：${PREFIX}checkin test [ID]`));
      const t = conf.targets.find((x) => x.id === id);
      if (!t) return void (await this.edit(msg, `❌ 未找到目标: ${id}`));
      await this.edit(msg, `🚀 开始测试签到目标: ${this.escape(t.name)}...`);
      const r = await this.runSingleSign(t);
      await this.edit(msg, r.success ? `✅ <b>${this.escape(t.name)}</b> 测试成功\n\n结果: ${this.escape(r.message || "无")}` : `❌ <b>${this.escape(t.name)}</b> 测试失败\n\n错误: ${this.escape(r.error || "未知错误")}`);
      return;
    }
  }

  private async handleConfigCommand(action: string, args: string[], msg: Api.Message): Promise<void> {
    const conf = this.cfg.get();

    if (action === "settings" || action === "config" || action === "info") {
      const enabled = conf.targets.filter((t) => t.enabled).length;
      const timeRange = conf.runTimeEnd ? `${conf.runTime} ~ ${conf.runTimeEnd}` : conf.runTime;
      const timeMode = conf.runTimeEnd ? "🔄 在设定时间段内随机执行" : "📌 按固定时间执行";

      await this.edit(
        msg,
        `⚙️ <b>CheckIn 配置信息</b>\n\n` +
          `${timeMode}\n` +
          `⏰ 执行时间: ${this.escape(timeRange)}\n` +
          `🎲 额外随机延迟: ${conf.randomDelay} 分钟\n` +
          `🤖 Bot 通知: ${conf.botToken ? "已配置" : "未配置"}\n` +
          `📱 通知目标: ${this.escape(conf.pushChatId || "未设置")}\n` +
          `📅 最近执行日期: ${this.escape(conf.lastRunDate || "无")}\n` +
          `🎯 已启用目标: ${enabled}/${conf.targets.length}`
      );
      return;
    }

    if (action === "set" || action === "config") {
      const type = (args[1] || "").toLowerCase();
      const value = args[2];
      const extra = args[3];

      if (type === "time" || type === "t") {
        if (!value || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
          await this.edit(msg, "❌ 格式错误，请使用 HH:MM (例如 10:30)");
          return;
        }
        
        if (conf.runTimeEnd) {
          const [startH, startM] = value.split(":").map(Number);
          const [endH, endM] = conf.runTimeEnd.split(":").map(Number);
          if (startH * 60 + startM > endH * 60 + endM && endH * 60 + endM > 0) {
            await this.edit(msg, `⚠️ 开始时间 (${value}) 晚于结束时间 (${conf.runTimeEnd})，请调整时间范围`);
            return;
          }
        }
        
        this.cfg.save({ runTime: value });
        await this.edit(msg, `✅ 开始时间已设置为: ${value}`);
        return;
      }

      if (type === "range" || type === "r") {
        if (!value) {
          this.cfg.save({ runTimeEnd: undefined });
          await this.edit(msg, "✅ 已清除执行时间范围，改为固定时间执行");
          return;
        }
        
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
          await this.edit(msg, "❌ 格式错误，请使用 HH:MM (例如 11:30)");
          return;
        }
        
        const [startH, startM] = conf.runTime.split(":").map(Number);
        const [endH, endM] = value.split(":").map(Number);
        if (startH * 60 + startM > endH * 60 + endM && endH * 60 + endM > 0) {
          await this.edit(msg, `⚠️ 开始时间 (${conf.runTime}) 晚于结束时间 (${value})，将允许跨天执行`);
        }
        
        this.cfg.save({ runTimeEnd: value });
        await this.edit(msg, `✅ 执行时间范围已设置为: ${conf.runTime} ~ ${value}（将在该时间段内随机执行）`);
        return;
      }

      if (type === "delay" || type === "d") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 60) {
          await this.edit(msg, "❌ 请输入 0-60 之间的分钟数");
          return;
        }
        this.cfg.save({ randomDelay: n });
        await this.edit(msg, `✅ 随机延迟已设置为: ${n} 分钟`);
        return;
      }

      if (type === "bot" || type === "b") {
        if (!value || !extra) {
          await this.edit(msg, `❌ 格式错误：${PREFIX}checkin set bot [Token] [ChatID]`);
          return;
        }
        this.cfg.save({ botToken: value, pushChatId: extra });
        await this.edit(msg, `✅ Bot配置已更新:\nToken: ${this.mask(value)}\nChatID: ${this.escape(extra)}`);
        return;
      }

      if (type === "log" || type === "l") {
        if (!value) {
          await this.edit(msg, `❌ 请指定日志聊天ID：${PREFIX}checkin set log [ChatID]`);
          return;
        }
        this.cfg.save({ logChat: value });
        await this.edit(msg, `✅ 日志聊天已设置为: ${this.escape(value)}`);
        return;
      }

      await this.edit(msg, `❌ 未知设置项。支持: time, range, delay, bot, log`);
      return;
    }
  }

  private async checkAndRun(): Promise<void> {
    if (this.running) return;
    try {
      const conf = this.cfg.get();
      const now = new Date();
      const shTime = this.getSHTime(now);
      const today = shTime.date;

      // 今天已经执行过了
      if (conf.lastRunDate === today) return;

      // 确定今天的执行时间（优先使用已持久化的时间）
      let runTime = conf.currentRunTime;
      if (!runTime) {
        runTime = this.calculateRunTime();
        if (runTime) {
          this.cfg.save({ currentRunTime: runTime });
        }
      }
      const todayRunTime = runTime || conf.runTime;

      const [h, m] = todayRunTime.split(":").map(Number);

      // 检查时间范围（如果有）
      if (conf.runTimeEnd) {
        const [startH, startM] = conf.runTime.split(":").map(Number);
        const [endH, endM] = conf.runTimeEnd.split(":").map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        const currentMinutes = shTime.hours * 60 + shTime.minutes;

        if (startMinutes <= endMinutes) {
          // 不跨天，例如 10:00 ~ 11:30
          if (currentMinutes > endMinutes) return;
        } else {
          // 跨天，例如 22:00 ~ 02:00
          if (currentMinutes > endMinutes && currentMinutes < startMinutes) return;
        }
      }

      // 时间匹配：当前时间达到或超过目标时刻即触发（避免因轮询错过精确分钟而整天不签到）
      const targetMinutes = h * 60 + m;
      const nowMinutes = shTime.hours * 60 + shTime.minutes;
      if (nowMinutes < targetMinutes) return;

      this.running = true;
      if (conf.randomDelay > 0) {
        await this.sleep(Math.floor(Math.random() * conf.randomDelay * 60_000));
      }
      await this.runAllSigns("自动定时任务");
      this.cfg.save({ lastRunDate: today, currentRunTime: undefined });
    } catch (e) {
      console.error("[CheckIn] Scheduler error:", e);
    } finally {
      this.running = false;
    }
  }

  private getSHTime(now: Date): { hours: number; minutes: number; date: string } {
    const fmt = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || "0";
    return {
      hours: Number(get("hour")),
      minutes: Number(get("minute")),
      date: `${get("year")}/${get("month")}/${get("day")}`
    };
  }

  private calculateRunTime(): string {
    const conf = this.cfg.get();
    const [startH, startM] = conf.runTime.split(":").map(Number);
    const [endH, endM] = conf.runTimeEnd?.split(":").map(Number) || [0, 0];

    const startMinutes = startH * 60 + startM;
    let endMinutes = endH * 60 + endM;

    // 处理跨天
    if (conf.runTimeEnd && endMinutes < startMinutes) {
      endMinutes += 24 * 60;
    }

    if (!conf.runTimeEnd || endMinutes <= startMinutes) {
      return conf.runTime;
    }

    const randomMinute = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));
    const finalMinutes = randomMinute >= 24 * 60 ? randomMinute - 24 * 60 : randomMinute;
    const hours = Math.floor(finalMinutes / 60);
    const minutes = finalMinutes % 60;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  private async runAllSigns(source: string, fallbackPeer?: any, statusMsg?: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;
    const conf = this.cfg.get();
    const enabled = conf.targets.filter((t) => t.enabled);
    if (!enabled.length) {
      if (statusMsg) await this.edit(statusMsg, "❌ 没有启用的签到目标");
      return;
    }

    const results: Array<{ target: SignTarget; result: SignResult }> = [];
    for (let i = 0; i < enabled.length; i++) {
      const t = enabled[i];
      const r = await this.runSingleSign(t);
      results.push({ target: t, result: r });
      if (i < enabled.length - 1) await this.sleep(2000);
    }

    // 记录成功目标的签到时间
    const nowStr = new Date().toLocaleString("zh-CN", { timeZone: SH_TZ });
    for (const x of results) {
      if (x.result.success) {
        const target = conf.targets.find((t) => t.id === x.target.id);
        if (target) target.lastSignTime = nowStr;
      }
    }
    this.cfg.save({ targets: conf.targets });

    const ok = results.filter((x) => x.result.success).length;
    const fail = results.length - ok;
    const lines = results
      .map((x, i) => `${x.result.success ? "✅" : "❌"} <b>${i + 1}. ${this.escape(x.target.name)}</b>\n   ${this.escape(x.result.success ? x.result.message || "成功" : x.result.error || "失败")}`)
      .join("\n");
    const summary = `🤖 <b>CheckIn 签到汇总报告</b>\n时间: ${new Date().toLocaleString("zh-CN", { timeZone: SH_TZ })}\n来源: ${this.escape(source)}\n结果: ${ok} 成功 / ${fail} 失败\n\n${lines}`;

    let sent = false;
    if (conf.botToken && conf.pushChatId) {
      try {
        await this.sendViaBot(conf.botToken, conf.pushChatId, summary);
        sent = true;
      } catch (e) {
        console.error("[CheckIn] Bot push failed:", e);
      }
    }
    if (!sent) {
      const peer = conf.logChat || fallbackPeer;
      if (peer) {
        try {
          await client.sendMessage(peer, { message: summary, parseMode: "html", linkPreview: false });
          sent = true;
        } catch (e) {
          console.error("[CheckIn] Userbot push failed:", e);
        }
      }
    }
    if (statusMsg) {
      try {
        await statusMsg.delete({ revoke: true });
      } catch {}
    }
    if (!sent) console.error("[CheckIn] Failed to send summary report.");
  }

  private async runSingleSign(target: SignTarget): Promise<SignResult> {
    const client = await getGlobalClient();
    if (!client) return { success: false, error: "客户端未初始化" };
    try {
      const sent = await client.sendMessage(target.target, { message: target.command });
      const sentId = Number((sent as any)?.id || 0);
      const start = Math.floor(Date.now() / 1000);

      const first = await this.waitForNewMessage(client, target.target, start, 10_000, (m) => {
        if (m.out) return false;
        if (this.hasMatcher(target)) return !!this.findCallbackButton(m, target);
        return this.isAfterMessage(m, sentId);
      });
      if (!first) return { success: false, error: "未收到签到结果" };

      if (!this.hasMatcher(target)) return { success: true, message: first.message || "签到命令已发送" };
      await this.clickCallbackButton(client, target.target, first, target);

      const second = await this.waitForNewMessage(client, target.target, Math.floor(Date.now() / 1000), 10_000, (m) => !m.out);
      return { success: true, message: second?.message || first.message || "已点击签到按钮" };
    } catch (e: any) {
      return { success: false, error: e?.message || "执行失败" };
    }
  }

  private async waitForNewMessage(
    client: any,
    peer: string,
    minDate: number,
    timeoutMs: number,
    filter?: (m: Api.Message) => boolean
  ): Promise<Api.Message | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.sleep(1000);
        const msgs = await client.getMessages(peer, { limit: 8 });
        for (const m of msgs) {
          if (m.date < minDate) continue;
          if (!filter || filter(m)) return m;
        }
      } catch (e) {
        console.error("[CheckIn] Polling error:", e);
      }
    }
    return null;
  }

  private async clickCallbackButton(client: any, peer: string, msg: Api.Message, target: SignTarget): Promise<void> {
    const btn = this.findCallbackButton(msg, target);
    if (!btn) throw new Error(`未找到回调按钮: ${target.callbackData || target.buttonText || target.id}`);
    await client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer,
        msgId: msg.id,
        data: btn.data || Buffer.from(target.callbackData || "", "utf-8"),
      })
    );
  }

  private findCallbackButton(msg: Api.Message, target: SignTarget): any | null {
    const rows = (msg as any).replyMarkup?.rows || [];
    for (const row of rows) {
      for (const b of row.buttons || []) {
        const d = this.decodeData(b.data);
        if (target.callbackData && d === target.callbackData) return b;
        if (!target.callbackData && target.buttonText && b.text === target.buttonText) return b;
      }
    }
    return null;
  }

  private parseButtonMatcher(args: string[]): Pick<SignTarget, "callbackData" | "buttonText"> {
    const raw = args.join(" ").trim();
    if (!raw) return {};
    if (raw.startsWith("data:")) return { callbackData: raw.slice(5).trim() };
    if (raw.startsWith("text:")) return { buttonText: raw.slice(5).trim() };
    return { callbackData: raw };
  }

  private hasMatcher(t: SignTarget): boolean {
    return !!t.callbackData || !!t.buttonText;
  }

  private helpText(): string {
    return `<b>🤖 CheckIn 自动化签到插件</b>

<b>📌 基础指令：</b>
<code>${PREFIX}checkin</code> - 手动触发所有签到
<code>${PREFIX}checkin reset</code> - 重置今日运行状态
<code>${PREFIX}checkin help</code> - 显示此帮助

<b>🎯 目标管理：</b>
<code>${PREFIX}checkin add [ID] [名称] [目标] [data:回调|text:按钮]</code> — 添加后<b>回复提示消息</b>发签到命令
<code>${PREFIX}checkin del [ID]</code>
<code>${PREFIX}checkin list</code>
<code>${PREFIX}checkin toggle [ID]</code>
<code>${PREFIX}checkin test [ID]</code>

<b>⚙️ 配置管理：</b>
<code>${PREFIX}checkin set time [HH:MM]</code> - 设置开始时间
<code>${PREFIX}checkin set range [HH:MM]</code> - 设置执行时间结束点（留空则改为固定时间）
<code>${PREFIX}checkin set delay [分钟]</code> - 设置额外随机延迟（0-60 分钟）
<code>${PREFIX}checkin set bot [Token] [ChatID]</code> - 设置 Bot 通知
<code>${PREFIX}checkin set log [ChatID]</code> - 设置日志聊天
<code>${PREFIX}checkin settings</code> - 查看当前配置

<b>💡 使用示例：</b>
<code>${PREFIX}checkin add storm Storm签到 @storm_bot data:checkin</code>
→ 然后回复提示消息：<code>/sign 123456</code>（命令可含空格）
<code>${PREFIX}checkin set time 10:00</code> - 从 10:00 开始
<code>${PREFIX}checkin set range 11:30</code> - 在 10:00 到 11:30 之间随机执行
<code>${PREFIX}checkin set range</code> - 清除时间范围，改为固定时间执行

<b>🔄 时间范围说明：</b>
设置 range 后，系统会每天在 time 到 range 之间随机选择一个时刻执行，
这样可以避免每天都在同一时间签到。支持跨天，例如 22:00 到次日 02:00。`;
  }

  private async edit(msg: Api.Message, text: string): Promise<void> {
    await msg.edit({ text, parseMode: "html", linkPreview: false });
  }

  private sendViaBot(token: string, chatId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
      const req = https.request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let out = "";
          res.on("data", (c) => (out += c));
          res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`API Error: ${out}`))));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private decodeData(data: unknown): string {
    if (!data) return "";
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8");
    return String(data);
  }

  private isAfterMessage(msg: Api.Message, id: number): boolean {
    return !id || Number((msg as any).id || 0) > id;
  }



  private mask(v: string): string {
    if (!v) return "";
    return v.length <= 5 ? "***" : `${v.slice(0, 5)}...`;
  }

  private escape(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export default new CheckInPlugin();
