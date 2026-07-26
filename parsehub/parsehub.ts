//@ts-nocheck
import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "teleproto/Helpers";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";
import * as fs from "fs";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";

import { htmlEscape } from "@utils/htmlEscape";

const BOT_USERNAME = "ParseHubot";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 10 * 60 * 1000; // large media upload can exceed 3min
const RESULT_IDLE_MS = 5000;
const PROGRESS_EXTEND_MS = 2 * 60 * 1000; // keep waiting while bot still reports progress
const FETCH_LIMIT = 50;

const PROGRESS_PREFIXES = [
  "解 析 中",
  "已有相同任务正在解析",
  "下 载 中",
  "上 传 中",
] as const;

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "parsehub";
const commandName = `${mainPrefix}${pluginName}`;

const helpText = `
依赖 @ParseHubot

1) 直接命令：<code>${commandName} 链接</code>
2) 回复消息后使用：在含链接的消息上回复 <code>${commandName}</code>

目前支持的平台:
抖音视频|图文
哔哩哔哩视频|动态
YouTube
YouTube Music
TikTok视频|图文
小红书视频|图文
Twitter视频|图文
百度贴吧视频|图文
Facebook视频
微博视频|图文
Instagram视频|图文

示例：
<code>${commandName} https://twitter.com/user/status/123</code>
<code>${commandName} https://www.instagram.com/p/xxxx/</code>
`.trim();

let hasStartedBot = false;
let firstRunPreStartLastId = 0;
let shouldIgnoreNextBotMessage = false;

type InitState = {
  initialized: boolean;
  ignoredUpToId?: number;
};

const STATE_DIR = createDirectoryInAssets(pluginName);
const STATE_PATH = path.join(STATE_DIR, "state.json");

function readState(): InitState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed?.initialized),
      ignoredUpToId: Number.isFinite(parsed?.ignoredUpToId)
        ? Number(parsed.ignoredUpToId)
        : undefined,
    };
  } catch {
    return { initialized: false };
  }
}

function writeState(state: InitState) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), "utf-8");
  } catch {}
}

let initState: InitState = readState();
let ignoredUpToId = Number(initState.ignoredUpToId || 0) || 0;

// Common progress prefix decoration characters (blocks, emoji, zero-width)
const PROGRESS_DECO_RE = /^[\s\u2580-\u259F\u25A0-\u25FF\u2000-\u200F\uFEFF\u3000]+/u;

const isProgressText = (text?: string | null): boolean => {
  if (!text) return false;
  // Strip common decorative prefix chars first (blocks, emoji, zero-width, ideographic space)
  const stripped = text.replace(PROGRESS_DECO_RE, "").trim();
  return PROGRESS_PREFIXES.some((prefix) => stripped.startsWith(prefix));
};

/** True when message carries real media. */
function hasMediaPayload(msg: Api.Message): boolean {
  const media = (msg as any).media;
  if (!media) return false;
  const cn = media.className || media._ || "";
  if (!cn || cn === "MessageMediaEmpty") return false;
  return true;
}

function isFinalBotMessage(msg: Api.Message): boolean {
  // Media always wins — bot may edit progress text in place while attaching file
  if (hasMediaPayload(msg)) return true;
  const text = msg.message?.trim() || "";
  if (isProgressText(text)) return false;
  return Boolean(text);
}

function extractLinks(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:https?:\/\/|www\.)\S+/gi) || [];
  const sanitized = matches.map((raw) => {
    const cleaned = raw.replace(
      /[)\]\}\u3002\uff1a\uff01\uff1f\u3001\uff0c>]+$/u,
      "",
    );
    return cleaned.startsWith("http") ? cleaned : `https://${cleaned}`;
  });
  return Array.from(new Set(sanitized.map((link) => link.trim()))).filter(
    Boolean,
  );
}

async function ensureBotReady(msg: Api.Message) {
  const client = msg.client;
  if (!client) return;

  try {
    await client.invoke(new Api.contacts.Unblock({ id: BOT_USERNAME }));
  } catch {}

  try {
    const inputPeer = await client.getInputEntity(BOT_USERNAME);
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: inputPeer }),
        settings: new Api.InputPeerNotifySettings({
          silent: true,
          muteUntil: 2147483647,
        }),
      }),
    );
  } catch {}

  if (hasStartedBot) {
    return;
  }

  try {
    const history = await safeGetMessages(client, BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      hasStartedBot = true;
      return;
    }
  } catch {}

  try {
    if (!initState.initialized) {
      firstRunPreStartLastId = await getLatestBotMessageId(client);
      shouldIgnoreNextBotMessage = true;
    }
    await client.invoke(
      new Api.messages.StartBot({
        bot: BOT_USERNAME,
        peer: BOT_USERNAME,
        startParam: "",
      }),
    );
    hasStartedBot = true;
  } catch {
    try {
      if (!initState.initialized) {
        firstRunPreStartLastId = await getLatestBotMessageId(client);
        shouldIgnoreNextBotMessage = true;
      }
      await client.sendMessage(BOT_USERNAME, { message: "/start" });
      hasStartedBot = true;
    } catch {}
  }

  // Best-effort: capture welcome message id to avoid mis-forwarding
  if (!initState.initialized && client) {
    const deadline = Date.now() + 10000; // up to 10s to observe welcome
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const latestId = await getLatestBotMessageId(client);
        if (latestId > firstRunPreStartLastId && latestId > ignoredUpToId) {
          ignoredUpToId = latestId;
          initState.initialized = true;
          initState.ignoredUpToId = latestId;
          writeState(initState);
          shouldIgnoreNextBotMessage = false;
          break;
        }
      } catch {}
    }
  }
}

async function getLatestBotMessageId(client: any): Promise<number> {
  if (!client) return 0;
  try {
    const history = await safeGetMessages(client, BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      return history[0].id;
    }
  } catch {}
  return 0;
}

type RelayReason = "timeout" | "fetch_failed" | "send_failed" | "no_client";

interface RelayOutcome {
  lastId: number;
  forwarded: boolean;
  reason?: RelayReason;
  error?: string;
}

const describeReason = (reason?: RelayReason): string => {
  switch (reason) {
    case "timeout":
      return "等待超时";
    case "fetch_failed":
      return "获取机器人消息失败";
    case "send_failed":
      return "向机器人发送链接失败";
    case "no_client":
      return "客户端未就绪";
    default:
      return "原因未知";
  }
};

async function forwardChunk(client: any, peer: any, ids: number[]) {
  await client.forwardMessages(peer, {
    fromPeer: BOT_USERNAME,
    messages: ids,
    dropAuthor: true,
  });
}

async function relayParseResult(
  originMsg: Api.Message,
  link: string,
  baselineId: number,
): Promise<RelayOutcome> {
  const client = originMsg.client;
  if (!client) {
    return { lastId: baselineId, forwarded: false, reason: "no_client" };
  }

  try {
    await client.sendMessage(BOT_USERNAME, { message: link });
  } catch (error: any) {
    return {
      lastId: baselineId,
      forwarded: false,
      reason: "send_failed",
      error: error?.message || String(error),
    };
  }

  // Progress msgs (解析中/下载中/上传中) often keep the SAME id and are later
  // edited into the final media. Never permanently skip them via processedIds.
  const progressIds = new Set<number>();
  const finalMessages = new Map<number, Api.Message>();

  let deadline = Date.now() + MAX_WAIT_MS;
  let lastId = baselineId;
  let lastFinalActivity = 0;
  let lastProgressActivity = Date.now();
  let firstRunIgnore = shouldIgnoreNextBotMessage;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let messages: Api.Message[] = [];
    try {
      messages = await safeGetMessages(client, BOT_USERNAME, { limit: FETCH_LIMIT });
    } catch (error: any) {
      return {
        lastId,
        forwarded: false,
        reason: "fetch_failed",
        error: error?.message || String(error),
      };
    }

    messages.sort((a, b) => a.id - b.id);

    for (const botMsg of messages) {
      if (!botMsg || (botMsg as any).className === "MessageService") continue;
      if (botMsg.out) continue;
      if (botMsg.id <= baselineId) continue;

      const text = botMsg.message?.trim() || "";

      if (isProgressText(text) && !hasMediaPayload(botMsg)) {
        // Stale progress left behind after a newer final result must not block forwarding
        const maxFinalId = finalMessages.size
          ? Math.max(...Array.from(finalMessages.keys()))
          : 0;
        if (maxFinalId > botMsg.id) {
          progressIds.delete(botMsg.id);
          continue;
        }
        progressIds.add(botMsg.id);
        lastId = Math.max(lastId, botMsg.id);
        lastProgressActivity = Date.now();
        // Only extend while we do not yet have a final result
        if (finalMessages.size === 0) {
          const extended = Date.now() + PROGRESS_EXTEND_MS;
          if (extended > deadline) deadline = extended;
          const hardCap = Date.now() + 30 * 60 * 1000;
          if (deadline > hardCap) deadline = hardCap;
        }
        continue;
      }

      if (!isFinalBotMessage(botMsg)) {
        lastId = Math.max(lastId, botMsg.id);
        continue;
      }

      if (firstRunIgnore && !hasMediaPayload(botMsg)) {
        firstRunIgnore = false;
        shouldIgnoreNextBotMessage = false;
        ignoredUpToId = botMsg.id;
        initState.initialized = true;
        initState.ignoredUpToId = botMsg.id;
        writeState(initState);
        lastId = Math.max(lastId, botMsg.id);
        progressIds.delete(botMsg.id);
        continue;
      }

      const isNew = botMsg.id > lastId || progressIds.has(botMsg.id) || !finalMessages.has(botMsg.id);
      if (!isNew && finalMessages.has(botMsg.id)) {
        finalMessages.set(botMsg.id, botMsg);
        continue;
      }

      progressIds.delete(botMsg.id);
      finalMessages.set(botMsg.id, botMsg);
      lastId = Math.max(lastId, botMsg.id);
      lastFinalActivity = Date.now();
    }

    if (
      finalMessages.size > 0 &&
      progressIds.size === 0 &&
      Date.now() - lastFinalActivity >= RESULT_IDLE_MS
    ) {
      break;
    }

    if (
      finalMessages.size > 0 &&
      progressIds.size > 0 &&
      Date.now() - lastProgressActivity >= RESULT_IDLE_MS * 3 &&
      Date.now() - lastFinalActivity >= RESULT_IDLE_MS
    ) {
      break;
    }
  }

  if (finalMessages.size === 0) {
    return { lastId, forwarded: false, reason: "timeout" };
  }

  const sortedMessages = Array.from(finalMessages.values()).sort(
    (a, b) => a.id - b.id,
  );

  let forwarded = false;
  const fallbackTexts: string[] = [];

  for (let i = 0; i < sortedMessages.length; i += 100) {
    const chunk = sortedMessages.slice(i, i + 100);
    const ids = chunk.map((m) => m.id);

    try {
      await forwardChunk(client, originMsg.peerId, ids);
      forwarded = true;
    } catch {
      const snippet = chunk
        .map((m) => m.message?.trim())
        .filter(Boolean)
        .join("\n\n");
      fallbackTexts.push(
        snippet.length
          ? snippet
          : `⚠️ 未能转发 @${BOT_USERNAME} 的多媒体结果，请前往私聊机器人查看。`,
      );
    }
  }

  if (!forwarded && fallbackTexts.length) {
    try {
      await client.sendMessage(originMsg.peerId, {
        message: `📨 @${BOT_USERNAME} 返回内容：\n\n${fallbackTexts.join("\n\n")}`,
        replyTo: originMsg.id,
      });
      forwarded = true;
    } catch {}
  }

  return {
    lastId,
    forwarded,
    reason: forwarded ? undefined : "timeout",
  };
}

class ParseHubPlugin extends Plugin {

  description: string = `\n${pluginName}\n\n${helpText}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    parsehub: async (msg: Api.Message) => {
      const rawText = msg.message || "";
      const cleaned = rawText.replace(
        new RegExp(`^${commandName}\\s*`, "i"),
        "",
      );
      let links = extractLinks(cleaned);

      // 若命令未包含链接且为回复消息，从被回复消息中提取链接
      if (!links.length && msg.replyTo?.replyToMsgId) {
        try {
          const replied = await safeGetReplyMessage(msg);
          const replyText = replied?.message || "";
          const replyLinks = extractLinks(replyText);
          if (replyLinks.length) {
            links = replyLinks;
          }
        } catch {}
      }

      // 若命令和被回复消息都包含链接，合并去重，命令里的在前
      if (msg.replyTo?.replyToMsgId) {
        try {
          const replied = await safeGetReplyMessage(msg);
          const replyText = replied?.message || "";
          const replyLinks = extractLinks(replyText);
          if (replyLinks.length) {
            const set = new Set<string>(links);
            for (const l of replyLinks) set.add(l);
            links = Array.from(set);
          }
        } catch {}
      }

      if (!links.length) {
        await msg.edit({ text: helpText, parseMode: "html" });
        return;
      }

      if (links.length > 1) {
        links = [links[0]];
      }

      await msg.edit({
        text: `✅ 已提交链接至 @${BOT_USERNAME}，正在解析中，请等待。`,
        parseMode: "html",
      });

      await ensureBotReady(msg);
      const client = msg.client;
      if (!client) {
        await msg.edit({
          text: `❌ 无法获取 Telegram 客户端实例，请稍后重试。`,
        });
        return;
      }

      let baselineId = await getLatestBotMessageId(client);
      // If we have recorded a welcome message id to ignore, advance baseline
      if (ignoredUpToId > baselineId) {
        baselineId = ignoredUpToId;
      }
      // If first-run flag is set but latest already moved beyond pre-start,
      // treat initialization as complete to avoid skipping valid results.
      if (
        shouldIgnoreNextBotMessage &&
        firstRunPreStartLastId > 0 &&
        baselineId > firstRunPreStartLastId
      ) {
        shouldIgnoreNextBotMessage = false;
        initState.initialized = true;
        initState.ignoredUpToId = baselineId;
        writeState(initState);
      }

      for (const link of links) {
        const outcome = await relayParseResult(msg, link, baselineId);
        baselineId = outcome.lastId;

        if (!outcome.forwarded) {
          const reasonText = htmlEscape(describeReason(outcome.reason));
          const detail =
            outcome.error && outcome.error !== "undefined"
              ? `\n\n错误信息：${htmlEscape(outcome.error)}`
              : "";
          await client.sendMessage(msg.peerId, {
            message: `⚠️ 未能获取 <b>${htmlEscape(link)}</b> 的最终结果（${reasonText}）。请稍后重试或直接私聊 @${BOT_USERNAME}。${detail}`,
            parseMode: "html",
            replyTo: msg.id,
          });
        }

        await sleep(600);
      }

      try {
        await msg.delete();
      } catch {}
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "parsehub",
    title: "ParseHub 解析",
    description: "链接解析插件状态：初始化状态、忽略消息 ID",
    category: "插件配置",
    icon: "🔗",
    getSchema: (): PanelSettingField[] => [
      {
        key: "initialized",
        label: "已初始化",
        type: "boolean",
        default: false,
        description: "是否已完成首次启动初始化",
      },
      {
        key: "ignoredUpToId",
        label: "忽略消息 ID",
        type: "number",
        min: 0,
        default: 0,
        description: "启动时忽略的最大消息 ID (避免处理历史消息)",
      },
      {
        key: "resetState",
        label: "重置状态",
        type: "boolean",
        default: false,
        description: "开启后保存将清空状态文件 (需手动关闭)",
      },
    ],
    getValues: async () => {
      const state = readState();
      return {
        initialized: state.initialized,
        ignoredUpToId: state.ignoredUpToId || 0,
        resetState: false,
      };
    },
    setValues: async (patch: Record<string, unknown>) => {
      if (patch.resetState === true) {
        try {
          fs.unlinkSync(STATE_PATH);
          logger.info("[parsehub] State file reset via panel");
        } catch { }
        return;
      }

      const state: InitState = {
        initialized: Boolean(patch.initialized ?? initState.initialized),
        ignoredUpToId: (Number(patch.ignoredUpToId ?? initState.ignoredUpToId) || 0) || 0,
      };
      writeState(state);
      initState = state;
      ignoredUpToId = state.ignoredUpToId || 0;
    },
  };
}

export default new ParseHubPlugin();
