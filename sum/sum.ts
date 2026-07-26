import { getPrefixes } from "@utils/pluginManager";
import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import axios from "axios";
import { safeGetMessages } from "@utils/safeGetMessages";

import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const filePath = path.join(
  createDirectoryInAssets("sum"),
  "summary_config.json",
);

function codeTag(value: any): string {
  return `<code>${htmlEscape(value)}</code>`;
}

function attrEscape(value: any): string {
  return htmlEscape(value).replace(/'/g, "&#39;");
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

type ProviderProtocol = "auto" | "chat" | "responses" | "gemini" | "anthropic";

type CustomProvider = {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  // 旧配置中的 openai 会在读取时自动迁移为 auto。
  type?: ProviderProtocol | "openai";
};

type AIConfig = {
  providers: Record<string, CustomProvider>;
  default_provider?: string;
  default_prompt?: string;
  default_spoiler?: boolean;
  default_timeout?: number;
  reply_mode?: boolean;
  max_output_length?: number;
  link_preview?: boolean;
};

const DEFAULT_PROMPT =
  '你是 Telegram 群聊摘要助手。根据以下聊天记录，只输出 Telegram HTML 格式的中文总结。\n\n允许使用 <b>、<code>、<a href="...">、<blockquote expandable>；禁止使用 Markdown、#、**、```、[文字](链接)、裸 URL、<https://...>。聊天记录中每条消息末尾都有“来源”链接。每条摘要、资源、结论、互动、零散信息或时间线条目都必须附带最对应的 Telegram 原消息链接，格式为 <a href="Telegram消息链接">来源</a>；不要编造链接。\n\n只记录聊天中明确出现的事实、反馈、决定和计划。只有存在明确完成反馈、验证结果或维护者确认时，才可使用“已确认”“已解决”“已完成”等表达；个人测试、成员讨论或推测使用“有人反馈”“初步判断”“可能”“尚待复测”“未见最终确认”等表述。不要把“计划支持”“准备测试”“正在修改”写成已经实现或可用。合并重复消息，忽略纯寒暄、表情、广告、机器人状态和无结论闲聊。\n\n总长度控制在 900-1600 个中文字符；重要讨论较多时可接近上限。信息应完整、可回溯，但不要逐条复述聊天记录。\n\n固定输出：\n<b>📌 本次摘要</b>\n用 2-3 句话概括本次聊天背景、关键结果和当前状态；末尾附 1-2 个 <a href="Telegram消息链接">来源</a>。\n\n随后按实际内容选择下列栏目，不相关的栏目完全不要输出：\n<b>💬 主要话题</b>：日常交流、综合讨论、一般观点或群内共识。\n<b>🧩 技术与项目</b>：技术方案、配置、开发、排障、版本更新、命令和实现细节。\n<b>📰 资源分享</b>：重要外部链接、文件、工具、新闻或可复用资源。\n<b>👥 重要互动</b>：明确的求助、答复、邀请、提醒、分工、争议或值得关注的人际互动。\n<b>🗂 零散信息</b>：无法归入其他栏目但值得保留的版本、环境、数据、状态、背景或简短结论。\n<b>🕒 时间线梳理</b>：仅在同一轮聊天出现多个明确时间点，且时间顺序有助于理解事件进展时输出。\n\n不要输出“待处理事项”“行动项”“下一步”这类面向管理者的栏目；群成员未必负责跟进。若聊天中存在未解决问题、风险或后续计划，将其放入最相关的上述栏目，并使用“仍待确认”“尚待复测”“计划继续”等中性表述。\n\n每个栏目使用以下格式：\n<b>栏目标题</b>\n<blockquote expandable>• 要点：说明结论、必要背景、明确分歧、风险或计划 <a href="Telegram消息链接">来源</a>\n• 要点：说明结论、必要背景、明确分歧、风险或计划 <a href="Telegram消息链接">来源</a></blockquote>\n\n规则：\n1. 每个栏目 1-3 条；每条建议 35-90 个中文字符。内容多时优先压缩重复过程，保留结论、关键依据、数据、风险和计划。\n2. 技术内容较多时，可在 <b>🧩 技术与项目</b> 内使用 <b>1. 小标题</b> 分组；最多 3 个小标题，每个小标题只保留 1-2 条。\n3. 时间线每条使用“<code>HH:MM</code>：事件概述 <a href="Telegram消息链接">来源</a>”；最多 4 条，只保留转折、决定、故障、修复或重要更新。\n4. 命令、模型名、插件名、配置名、版本号、错误码使用 <code>...</code>。\n5. 外部链接仅在确实影响后续操作时保留，格式为 <a href="完整URL">名称</a>，并在同一条末尾保留 Telegram <a href="Telegram消息链接">来源</a>。\n6. 不输出空栏目、“无”“暂无”“未发现”或处理过程。每个栏目之间空一行，只输出最终总结。';

function promptStatus(prompt: string | undefined): string {
  if (!prompt || prompt === DEFAULT_PROMPT) return "内置详细版（来源跳转）";
  return "自定义提示词";
}

const OFFICIAL_PROVIDER_PRESETS: Record<
  "openai" | "gemini" | "anthropic",
  Omit<CustomProvider, "api_key">
> = {
  openai: {
    name: "OpenAI",
    base_url: "https://api.openai.com",
    model: "gpt-5.6-terra",
    type: "auto",
  },
  gemini: {
    name: "Gemini",
    base_url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    type: "auto",
  },
  anthropic: {
    name: "Anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    type: "auto",
  },
};

type SummaryTask = {
  id: string;
  cron: string;
  chatId: string;
  chatDisplay?: string;
  interval: string;
  messageCount: number;
  timeRange?: number; // 时间范围（小时），如果设置则按时间范围总结
  pushTarget?: string;
  aiProvider?: string; // 提供商名称
  aiPrompt?: string;
  useSpoiler?: boolean; // 是否使用折叠
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  disabled?: boolean;
  remark?: string;
};

type SummaryDB = {
  seq: string;
  tasks: SummaryTask[];
  aiConfig: AIConfig;
  defaultPushTarget?: string;
};

async function getDB() {
  const db = await JSONFilePreset<SummaryDB>(filePath, {
    seq: "0",
    tasks: [],
    aiConfig: {
      providers: {
        openai: {
          name: "OpenAI",
          base_url: "https://api.openai.com",
          api_key: "",
          model: "gpt-4o",
          type: "openai",
        },
        gemini: {
          name: "Gemini",
          base_url: "https://generativelanguage.googleapis.com",
          api_key: "",
          model: "gemini-2.0-flash",
          type: "gemini",
        },
      },
      default_provider: "openai",
      default_prompt: DEFAULT_PROMPT,
      default_spoiler: false,
    },
  });

  // 兼容旧数据
  if (!db.data.aiConfig) {
    db.data.aiConfig = {
      providers: {},
      default_provider: "openai",
      default_prompt: DEFAULT_PROMPT,
    };
  }

  if (!db.data.aiConfig.providers) {
    db.data.aiConfig.providers = {};
  }
  if (!db.data.aiConfig.default_prompt) {
    db.data.aiConfig.default_prompt = DEFAULT_PROMPT;
  }
  if (db.data.aiConfig.link_preview === undefined) {
    db.data.aiConfig.link_preview = false;
  }
  for (const provider of Object.values(db.data.aiConfig.providers)) {
    if (!provider.type || provider.type === "openai") provider.type = "auto";
  }

  return db;
}

function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function makeCronKey(id: string) {
  return `sum:${id}`;
}

function parseInterval(interval: string): string | null {
  console.log(`[sum] parseInterval 输入: "${interval}"`);

  // 1. 检查字段数量
  const fields = interval.trim().split(/\s+/);
  console.log(
    `[sum] 字段数量: ${fields.length}, 字段: ${JSON.stringify(fields)}`,
  );

  // 2. 如果是 6 字段，直接返回（参考 sendat，不验证，让 cronManager 处理）
  if (fields.length === 6) {
    console.log(`[sum] 返回 6 字段 cron: "${interval}"`);
    return interval;
  }

  // 3. 如果是 5 字段，补 0（秒）
  if (fields.length === 5) {
    const result = `0 ${interval}`;
    console.log(`[sum] 5 字段转 6 字段: "${result}"`);
    return result;
  }

  // 4. 尝试解析简化格式
  const match = interval.match(/^(\d+)(h|m)$/i);
  if (!match) {
    console.log(`[sum] 无法解析简化格式，返回 null`);
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (value <= 0) return null;

  if (unit === "h") {
    const result = `0 0 */${value} * * *`;
    console.log(`[sum] 简化格式(小时): "${result}"`);
    return result;
  } else if (unit === "m") {
    const result = `0 */${value} * * * *`;
    console.log(`[sum] 简化格式(分钟): "${result}"`);
    return result;
  }

  console.log(`[sum] 未知情况，返回 null`);
  return null;
}

function parseChatIdentifier(input: string): string {
  // 1. 如果是纯数字或负数ID，直接返回
  if (/^-?\d+$/.test(input)) {
    return input;
  }

  // 2. 处理私有邀请链接 https://t.me/+xxxxx 或 https://t.me/joinchat/xxxxx
  // 这种格式需要特殊处理，保留完整链接
  const inviteLinkMatch = input.match(
    /(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/,
  );
  if (inviteLinkMatch) {
    return input; // 返回完整链接，让 formatEntity 特殊处理
  }

  // 3. 处理 t.me 公开群组/频道链接
  // https://t.me/groupname 或 t.me/groupname
  const publicLinkMatch = input.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/);
  if (publicLinkMatch) {
    return publicLinkMatch[1]; // 返回用户名
  }

  // 4. 处理私有群组链接 https://t.me/c/1234567890/xxx
  const privateLinkMatch = input.match(/(?:https?:\/\/)?t\.me\/c\/(\d+)/);
  if (privateLinkMatch) {
    return `-100${privateLinkMatch[1]}`; // 转换为完整ID
  }

  // 5. 处理 @username 格式
  if (input.startsWith("@")) {
    return input.substring(1); // 移除 @ 符号
  }

  // 6. 其他情况直接返回原值，让 formatEntity 处理
  return input;
}

async function formatEntity(target: any) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  let id: any;
  let entity: any;

  try {
    // 检查是否是邀请链接
    const inviteLinkMatch =
      typeof target === "string"
        ? target.match(
            /(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/,
          )
        : null;

    if (inviteLinkMatch) {
      // 处理邀请链接
      const hash = inviteLinkMatch[1];

      try {
        // 先检查邀请链接信息
        const inviteInfo = await client.invoke(
          new Api.messages.CheckChatInvite({ hash }),
        );

        if (inviteInfo instanceof Api.ChatInviteAlready) {
          // 已经在群组中，直接使用返回的 chat 对象
          entity = inviteInfo.chat;
          id = entity?.id;
        } else if (inviteInfo instanceof Api.ChatInvite) {
          // 还未加入群组，需要先加入
          const importResult = await client.invoke(
            new Api.messages.ImportChatInvite({ hash }),
          );

          // 从导入结果中获取 chat 对象
          // importResult 类型为 unknown，使用类型守卫安全访问
          if (
            importResult &&
            typeof importResult === "object" &&
            "chats" in importResult
          ) {
            const chats = (importResult as Record<string, unknown>).chats;
            if (Array.isArray(chats) && chats.length > 0) {
              entity = chats[0] as typeof entity;
              id = entity?.id;
            }
          }
        }
      } catch (inviteError: any) {
        console.error("处理邀请链接失败:", inviteError);
        throw new Error(
          `无法处理邀请链接: ${inviteError.message || "未知错误"}`,
        );
      }
    } else {
      // 普通的 username 或 ID，直接获取 entity
      entity = await client.getEntity(target);
      id = entity?.id;
    }
  } catch (e: any) {
    console.error(e);
    throw new Error(`无法获取群组信息: ${e.message || "未知错误"}`);
  }

  const displayParts: string[] = [];
  if (entity?.title) displayParts.push(htmlEscape(entity.title));
  if (entity?.username) displayParts.push(htmlEscape(`@${entity.username}`));
  if (id) displayParts.push(codeTag(id));

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

// AI 调用函数
function normalizedBaseUrl(baseUrl: string): string {
  // 允许用户填写根地址、末尾 / 或常见的 /v1；具体端点由插件统一追加。
  return baseUrl.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "");
}

function detectProtocol(
  provider: CustomProvider,
): Exclude<ProviderProtocol, "auto"> {
  if (provider.type && provider.type !== "auto" && provider.type !== "openai") {
    return provider.type;
  }

  const model = provider.model.toLowerCase();
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("claude")) return "anthropic";
  if (/^(gpt-5|o[1-9])/.test(model)) return "responses";
  return "chat";
}

function apiErrorDetail(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return JSON.stringify(error.response?.data ?? error.message);
  }
  return String((error as any)?.message ?? error);
}

async function callChatCompletions(
  apiKey: string,
  baseUrl: string,
  model: string,
  input: string,
  timeout: number,
): Promise<string> {
  const response = await axios.post(
    `${normalizedBaseUrl(baseUrl)}/v1/chat/completions`,
    { model, messages: [{ role: "user", content: input }], max_tokens: 2000 },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout,
    },
  );
  const content = response.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim())
    throw new Error("Chat Completions 返回内容为空");
  return content.trim();
}

async function callResponses(
  apiKey: string,
  baseUrl: string,
  model: string,
  input: string,
  timeout: number,
): Promise<string> {
  const response = await axios.post(
    `${normalizedBaseUrl(baseUrl)}/v1/responses`,
    {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
      max_output_tokens: 2000,
      store: false,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout,
    },
  );
  const outputText = response.data?.output_text;
  if (typeof outputText === "string" && outputText.trim())
    return outputText.trim();
  const content = response.data?.output
    ?.flatMap((item: any) => item?.content ?? [])
    ?.filter(
      (item: any) =>
        item?.type === "output_text" && typeof item?.text === "string",
    )
    ?.map((item: any) => item.text)
    ?.join("\n")
    ?.trim();
  if (!content) throw new Error("Responses API 返回内容为空");
  return content;
}

async function callGemini(
  apiKey: string,
  baseUrl: string,
  model: string,
  input: string,
  timeout: number,
): Promise<string> {
  const response = await axios.post(
    `${normalizedBaseUrl(baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { contents: [{ role: "user", parts: [{ text: input }] }] },
    { headers: { "Content-Type": "application/json" }, timeout },
  );
  const content = response.data?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part?.text ?? "")
    .join("")
    .trim();
  if (!content) throw new Error("Gemini 返回内容为空");
  return content;
}

async function callAnthropic(
  apiKey: string,
  baseUrl: string,
  model: string,
  input: string,
  timeout: number,
): Promise<string> {
  const response = await axios.post(
    `${normalizedBaseUrl(baseUrl)}/v1/messages`,
    { model, max_tokens: 2000, messages: [{ role: "user", content: input }] },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout,
    },
  );
  const content = response.data?.content
    ?.filter((item: any) => item?.type === "text")
    ?.map((item: any) => item.text)
    ?.join("\n")
    ?.trim();
  if (!content) throw new Error("Anthropic 返回内容为空");
  return content;
}

async function callWithProtocol(
  protocol: Exclude<ProviderProtocol, "auto">,
  provider: CustomProvider,
  input: string,
  timeout: number,
): Promise<string> {
  switch (protocol) {
    case "responses":
      return callResponses(
        provider.api_key,
        provider.base_url,
        provider.model,
        input,
        timeout,
      );
    case "gemini":
      return callGemini(
        provider.api_key,
        provider.base_url,
        provider.model,
        input,
        timeout,
      );
    case "anthropic":
      return callAnthropic(
        provider.api_key,
        provider.base_url,
        provider.model,
        input,
        timeout,
      );
    default:
      return callChatCompletions(
        provider.api_key,
        provider.base_url,
        provider.model,
        input,
        timeout,
      );
  }
}

function canTryFallback(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status === 404) return true;
  if (error.response?.status !== 400) return false;

  const detail = JSON.stringify(error.response.data).toLowerCase();
  return (
    detail.includes("unsupported_upstream") ||
    detail.includes("endpoint") ||
    detail.includes("not supported")
  );
}

async function callAI(
  provider: CustomProvider,
  messages: string,
  prompt: string,
  timeout: number,
): Promise<string> {
  const input = `${prompt}\n\n${messages}`;
  const protocol = detectProtocol(provider);

  try {
    return await callWithProtocol(protocol, provider, input, timeout);
  } catch (error) {
    // 仅在网关明确不支持当前端点时，尝试 OpenAI 兼容接口。
    if (
      provider.type === "auto" &&
      protocol !== "chat" &&
      canTryFallback(error)
    ) {
      return callWithProtocol("chat", provider, input, timeout);
    }
    throw error;
  }
}

// 构建群组链接
function buildChatLink(chatId: string, username?: string): string {
  if (username) {
    return `https://t.me/${username}`;
  }
  // 私有群：chatId 格式为 -100xxxxx，需要去掉 -100 前缀
  const numericId = chatId.replace(/^-100/, "");
  return `https://t.me/c/${numericId}`;
}

// 构建消息链接
function buildMessageLink(
  chatId: string,
  messageId: number,
  username?: string,
): string {
  if (username) {
    return `https://t.me/${username}/${messageId}`;
  }
  // 私有群：chatId 格式为 -100xxxxx，需要去掉 -100 前缀
  const numericId = chatId.replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${messageId}`;
}

// 消息数据结构
type MessageData = {
  text: string; // 格式化后的消息文本
  content: string; // 原始消息内容
  telegramLink: string; // Telegram 消息链接
  urls: string[]; // 消息中的所有 URL（包括 entities 中的）
  fileName?: string; // 附件文件名（如果有）
};

// 从消息 entities 中提取 URL
function extractUrlsFromEntities(message: any): string[] {
  const urls: string[] = [];

  // 从 entities 中提取
  if (message.entities && Array.isArray(message.entities)) {
    for (const entity of message.entities) {
      // TextUrl 类型：[文本](URL) 格式的链接
      if (entity.className === "MessageEntityTextUrl" && entity.url) {
        urls.push(entity.url);
      }
      // Url 类型：消息中的纯文本 URL
      if (entity.className === "MessageEntityUrl" && message.message) {
        const url = message.message.substring(
          entity.offset,
          entity.offset + entity.length,
        );
        urls.push(url);
      }
    }
  }

  return urls;
}

// 提取文本中的 URL
function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s\]）】>]+/g;
  return text.match(urlRegex) || [];
}

// 检查是否为贴纸/表情包
function isStickerOrEmoji(message: any): boolean {
  if (!message.media?.document) return false;

  const doc = message.media.document;

  // 检查 MIME 类型
  const stickerMimeTypes = [
    "application/x-tgsticker", // TGS 动画贴纸
    "video/webm", // 视频贴纸
  ];
  if (doc.mimeType && stickerMimeTypes.includes(doc.mimeType)) {
    return true;
  }

  // 检查 attributes 中是否有贴纸/表情包标识
  if (doc.attributes && Array.isArray(doc.attributes)) {
    for (const attr of doc.attributes) {
      if (
        attr.className === "DocumentAttributeSticker" ||
        attr.className === "DocumentAttributeCustomEmoji"
      ) {
        return true;
      }
    }
  }

  return false;
}

// 从消息中提取文件名
function extractFileName(message: any): string | null {
  if (!message.media) return null;

  // 忽略贴纸/表情包
  if (isStickerOrEmoji(message)) {
    return null;
  }

  // MessageMediaDocument（文件、图片等）
  if (message.media.document) {
    const doc = message.media.document;
    // 从 attributes 中查找文件名
    if (doc.attributes && Array.isArray(doc.attributes)) {
      for (const attr of doc.attributes) {
        if (attr.className === "DocumentAttributeFilename" && attr.fileName) {
          return attr.fileName;
        }
      }
    }
    // 如果没有文件名，返回 MIME 类型
    if (doc.mimeType) {
      return `[${doc.mimeType}]`;
    }
  }

  // MessageMediaPhoto（图片）
  if (message.media.className === "MessageMediaPhoto") {
    return "[图片]";
  }

  // MessageMediaWebPage（网页预览）
  if (message.media.className === "MessageMediaWebPage") {
    return null; // 网页预览不作为文件处理
  }

  return null;
}

// 获取群消息（按数量）
async function getGroupMessages(
  chatId: string,
  count: number,
): Promise<MessageData[]> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const messages = await safeGetMessages(client, chatId, { limit: count });

  // 获取群组 username（如果有）
  let chatUsername: string | undefined;
  try {
    const entity = await client.getEntity(chatId);
    chatUsername = (entity as any).username;
  } catch (e) {
    // 忽略错误，使用私有链接格式
  }

  const messageData: MessageData[] = [];
  for (const msg of messages) {
    const message = msg as any;
    // 跳过完全没有内容的消息
    if (!message.message && !message.media) continue;

    const sender =
      message.sender?.firstName || message.sender?.username || "未知用户";
    const time = formatDate(new Date(message.date * 1000));
    const link = buildMessageLink(chatId, message.id, chatUsername);
    const urls = extractUrlsFromEntities(message);

    // 构建消息文本，包含文件信息
    let textContent = message.message || "";
    const fileName = extractFileName(message);
    if (fileName) {
      textContent = textContent
        ? `${textContent} [文件: ${fileName}]`
        : `[文件: ${fileName}]`;
    }

    if (textContent) {
      messageData.push({
        text: `[${time}] ${sender}: ${textContent}`,
        content: message.message || "",
        telegramLink: link,
        urls,
        fileName: fileName || undefined,
      });
    }
  }

  return messageData.reverse();
}

// 获取群消息（按时间范围）
async function getGroupMessagesByTime(
  chatId: string,
  hours: number,
): Promise<MessageData[]> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const now = Math.floor(Date.now() / 1000);
  const startTime = now - hours * 3600;

  const messages = await safeGetMessages(client, chatId, { limit: 100 });

  // 获取群组 username（如果有）
  let chatUsername: string | undefined;
  try {
    const entity = await client.getEntity(chatId);
    chatUsername = (entity as any).username;
  } catch (e) {
    // 忽略错误，使用私有链接格式
  }

  const messageData: MessageData[] = [];
  for (const msg of messages) {
    const message = msg as any;
    if (message.date < startTime) continue;
    if (!message.message && !message.media) continue;

    const sender =
      message.sender?.firstName || message.sender?.username || "未知用户";
    const time = formatDate(new Date(message.date * 1000));
    const link = buildMessageLink(chatId, message.id, chatUsername);
    const urls = extractUrlsFromEntities(message);

    // 构建消息文本，包含文件信息
    let textContent = message.message || "";
    const fileName = extractFileName(message);
    if (fileName) {
      textContent = textContent
        ? `${textContent} [文件: ${fileName}]`
        : `[文件: ${fileName}]`;
    }

    if (textContent) {
      messageData.push({
        text: `[${time}] ${sender}: ${textContent}`,
        content: message.message || "",
        telegramLink: link,
        urls,
        fileName: fileName || undefined,
      });
    }
  }

  return messageData.reverse();
}

// 格式化消息数据为文本
function formatMessagesForAI(messageData: MessageData[]): string {
  // 消息正文，每条消息附带 Telegram 链接
  const messageTexts = messageData.map(
    (m) => `${m.text} [来源](${m.telegramLink})`,
  );

  // 提取所有外部 URL 及其对应的 Telegram 消息链接
  // 优先使用 entities 中提取的 URL，其次使用文本中的 URL
  const urlMappings: { url: string; telegramLink: string }[] = [];
  for (const m of messageData) {
    // 合并两种来源的 URL
    const allUrls = [...m.urls, ...extractUrlsFromText(m.content)];
    for (const url of allUrls) {
      // 去重：检查是否已存在相同 URL
      if (!urlMappings.some((u) => u.url === url)) {
        urlMappings.push({ url, telegramLink: m.telegramLink });
      }
    }
  }

  // 提取所有附件文件
  const fileMappings: { fileName: string; telegramLink: string }[] = [];
  for (const m of messageData) {
    if (m.fileName) {
      fileMappings.push({ fileName: m.fileName, telegramLink: m.telegramLink });
    }
  }

  let result = messageTexts.join("\n");

  if (urlMappings.length > 0) {
    result += "\n\n--- 消息中包含的外部链接（资源URL - 来源消息链接）---\n";
    for (const mapping of urlMappings) {
      result += `${mapping.url} - [查看原消息](${mapping.telegramLink})\n`;
    }
  }

  if (fileMappings.length > 0) {
    result += "\n\n--- 消息中包含的附件（文件名 - 来源消息链接）---\n";
    for (const mapping of fileMappings) {
      result += `${mapping.fileName} - [查看原消息](${mapping.telegramLink})\n`;
    }
  }

  return result;
}

// 包裹折叠标签
function wrapWithSpoiler(content: string, useSpoiler: boolean): string {
  if (!useSpoiler) {
    return content;
  }

  // 检查内容是否已经包含折叠标签
  if (content.includes("<blockquote expandable>")) {
    return content;
  }

  // 用折叠标签包裹整个内容
  return `<blockquote expandable>${content}</blockquote>`;
}

// AI 总结消息
async function summarizeMessages(
  task: SummaryTask,
  messageData: MessageData[],
): Promise<{ success: boolean; result?: string; error?: string }> {
  const db = await getDB();
  const aiConfig = db.data.aiConfig;
  const providerName = task.aiProvider || aiConfig.default_provider || "openai";
  const prompt = task.aiPrompt || aiConfig.default_prompt || DEFAULT_PROMPT;
  const timeout = aiConfig.default_timeout || 60000;

  // 格式化消息为文本（包含 URL 及来源链接）
  const messages = formatMessagesForAI(messageData);

  // 避免将完整群聊内容写入日志。
  console.log(
    `[sum] 准备总结 ${messageData.length} 条消息，输入长度 ${messages.length} 字符`,
  );

  const provider = aiConfig.providers[providerName];
  if (!provider) {
    return { success: false, error: `未找到提供商: ${providerName}` };
  }

  if (!provider.api_key) {
    return {
      success: false,
      error: `提供商 ${providerName} 的 API Key 未配置`,
    };
  }

  try {
    const aiResponse = await callAI(provider, messages, prompt, timeout);
    return { success: true, result: aiResponse };
  } catch (aiErr: any) {
    return { success: false, error: `AI 调用失败: ${apiErrorDetail(aiErr)}` };
  }
}

// 执行总结任务
async function executeSummary(
  task: SummaryTask,
): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getGlobalClient();
    if (!client) throw new Error("Telegram 客户端未初始化");

    const db = await getDB();

    // 获取消息
    let messageData: MessageData[];

    if (task.timeRange) {
      messageData = await getGroupMessagesByTime(task.chatId, task.timeRange);
    } else {
      messageData = await getGroupMessages(task.chatId, task.messageCount);
    }

    if (!messageData || messageData.length === 0) {
      return { success: false, message: "未找到可总结的消息" };
    }

    // AI 总结
    const summaryResult = await summarizeMessages(task, messageData);
    if (!summaryResult.success) {
      return { success: false, message: summaryResult.error! };
    }

    // 发送总结
    const pushTarget = task.pushTarget || db.data.defaultPushTarget || "me";
    let summaryContent = summaryResult.result!;

    // 过滤掉思考标签内容（如 <thinking>...</thinking>、<think>...</think>）
    summaryContent = summaryContent.replace(
      /<thinking>[\s\S]*?<\/thinking>/gi,
      "",
    );
    summaryContent = summaryContent.replace(/<think>[\s\S]*?<\/think>/gi, "");
    summaryContent = summaryContent.trim();

    // 应用最大输出长度限制（过滤思考内容后再计算）
    // 应用最大输出长度限制（0表示不限制）
    const maxOutputLength = db.data.aiConfig.max_output_length ?? 0;
    if (maxOutputLength > 0 && summaryContent.length > maxOutputLength) {
      summaryContent =
        summaryContent.substring(0, maxOutputLength) +
        "\n\n⚠️ 内容已截断（超过最大长度限制）";
    }

    const chatName = task.chatDisplay
      ? task.chatDisplay.replace(/\s*<code>.*?<\/code>/gi, "")
      : htmlEscape(task.chatId);
    const header = `📊 <b>群组总结</b>\n${chatName} · ${formatDate(new Date())}\n\n`;

    // 应用折叠标签（如果启用）
    const wrappedContent = wrapWithSpoiler(
      summaryContent,
      task.useSpoiler || false,
    );
    const summaryText = `${header}${wrappedContent}`;

    await client.sendMessage(pushTarget, {
      message: summaryText,
      parseMode: "html",
      linkPreview: db.data.aiConfig.link_preview === true,
    });

    return { success: true, message: `总结完成，已推送到 ${pushTarget}` };
  } catch (e: any) {
    return { success: false, message: `总结失败: ${e?.message || e}` };
  }
}

// 调度任务
async function scheduleTask(task: SummaryTask) {
  const key = makeCronKey(task.id);
  if (task.disabled || cronManager.has(key)) return;

  console.log(`[sum] 注册任务 ${task.id}: ${task.cron}`);

  cronManager.set(key, task.cron, async () => {
    console.log(`[sum] 开始执行任务 ${task.id}`);

    const db = await getDB();
    const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === task.id);
    const now = Date.now();

    try {
      const result = await executeSummary(task);

      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        if (result.success) {
          db.data.tasks[idx].lastResult = result.message;
          db.data.tasks[idx].lastError = undefined;
        } else {
          db.data.tasks[idx].lastError = result.message;
        }
        await db.write();
      }
      console.log(
        `[sum] 任务 ${task.id} 执行完成: ${result.success ? "成功" : "失败"}`,
      );
    } catch (e: any) {
      console.error(`[sum] 任务 ${task.id} 执行失败:`, e);
      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        db.data.tasks[idx].lastError = String(e?.message || e);
        await db.write();
      }
    }
  });
}

// 启动任务
async function bootstrapTasks() {
  try {
    const db = await getDB();
    console.log(`[sum] 启动加载，共 ${db.data.tasks.length} 个任务`);

    for (const t of db.data.tasks) {
      if (!cron.validateCronExpression(t.cron).valid) {
        console.error(`[sum] 任务 ${t.id} Cron 表达式无效: ${t.cron}`);
        continue;
      }
      if (t.disabled) {
        console.log(`[sum] 任务 ${t.id} 已禁用，跳过`);
        continue;
      }
      await scheduleTask(t);
    }
    console.log(`[sum] 任务加载完成`);
  } catch (e) {
    console.error("[sum] bootstrap 失败:", e);
  }
}

// 立即执行
(async () => {
  await bootstrapTasks();
  console.log("[sum] 插件初始化完成");
})();

const help_text = `▎群消息总结

<b>⚡ 立即总结</b>
<code>${mainPrefix}sum</code>
总结当前群最近 100 条消息。

<code>${mainPrefix}sum 200</code>
总结当前群最近 200 条消息。

<code>${mainPrefix}sum 100 --provider myai</code>
使用指定 AI 配置总结。

<b>🕒 定时总结</b>
<code>${mainPrefix}sum add &lt;群组&gt; &lt;间隔&gt; [消息数]</code>
间隔示例：<code>2h</code>（每 2 小时）、<code>30m</code>（每 30 分钟）。

<b>🔎 查看当前配置</b>
<code>${mainPrefix}sum config list</code>
显示所有 AI 配置、默认配置、模型、接口识别结果和链接预览状态。

<b>🤖 添加 AI 配置</b>
<code>${mainPrefix}sum config add &lt;名称&gt; &lt;BaseURL&gt; &lt;API_KEY&gt; &lt;模型&gt;</code>
示例：
<code>${mainPrefix}sum config add myai https://api.example.com sk-xxx gpt-5.6-terra</code>
模型接口会自动识别：GPT-5/o 系列走 Responses，Gemini 走 Gemini API，Claude 走 Anthropic Messages，其他模型走 Chat Completions。

<b>✏️ 修改 AI 配置</b>
下面三条命令分别修改模型、地址和 Key：
<code>${mainPrefix}sum config set myai model gpt-5.6-terra</code>
<code>${mainPrefix}sum config set myai url https://api.example.com</code>
<code>${mainPrefix}sum config set myai key sk-xxx</code>

<b>🗑 删除 AI 配置</b>
<code>${mainPrefix}sum config del myai</code>
删除配置。若删除的是默认配置，插件会自动清空默认项；使用该配置的定时任务将改为使用全局默认配置。

<b>⚙️ 全局设置</b>
<code>${mainPrefix}sum config set default myai</code>
设为默认 AI 配置。

<code>${mainPrefix}sum config set preview off</code>
关闭链接预览（默认关闭）；改为 <code>on</code> 可开启。

<code>${mainPrefix}sum config set prompt &lt;提示词&gt;</code>
设置默认总结提示词；<code>${mainPrefix}sum config set prompt reset</code> 恢复内置详细版。

<code>${mainPrefix}sum config set prompt show</code>
查看当前实际生效的提示词。

<b>📋 任务管理</b>
<code>${mainPrefix}sum list</code> - 查看任务
<code>${mainPrefix}sum run &lt;ID&gt;</code> - 立即执行任务
<code>${mainPrefix}sum del &lt;ID&gt;</code> - 删除任务
<code>${mainPrefix}sum disable &lt;ID&gt;</code> - 暂停任务
<code>${mainPrefix}sum enable &lt;ID&gt;</code> - 恢复任务
`;

class SummaryPlugin extends Plugin {
  description: string = `群消息总结插件\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sum: async (msg: Api.Message) => {
      const parts = msg.message?.trim()?.split(/\s+/) || [];
      const [, sub, ...args] = parts;

      try {
        // 查看推荐提示词
        if (sub === "prompts") {
          await msg.edit({
            text: `<b>📝 当前内置提示词</b>\n\n${codeTag(DEFAULT_PROMPT)}\n\n<code>${mainPrefix}sum config set prompt reset</code> - 恢复此提示词`,
            parseMode: "html",
          });
          return;
        }

        // 调试：查看发送给 AI 的原始文本
        if (sub === "debug") {
          const count = toInt(args[0]) || 50;
          const chatId = String(msg.chatId);

          await msg.edit({ text: "⏳ 正在获取消息..." });

          const messageData = await getGroupMessages(chatId, count);
          if (!messageData || messageData.length === 0) {
            await msg.edit({ text: "❌ 未找到消息" });
            return;
          }

          const formattedText = formatMessagesForAI(messageData);

          // 截取最后 2000 字符（主要看链接部分）
          const preview =
            formattedText.length > 2000
              ? "...(前面省略)...\n\n" + formattedText.slice(-2000)
              : formattedText;

          await msg.edit({
            text: `📋 发送给 AI 的文本预览（最后2000字符）：\n\n${codeTag(preview)}`,
            parseMode: "html",
          });
          return;
        }

        // 快捷总结当前群 - 支持格式: .sum [数量] [--provider 名称]
        if (!sub || /^\d+$/.test(sub) || sub === "--provider") {
          let count = 100;
          let aiProvider: string | undefined;

          // 解析参数
          let i = 1; // 从 sub 开始解析
          while (i < parts.length) {
            const arg = parts[i];
            if (arg === "--provider" || arg === "-p") {
              aiProvider = parts[i + 1];
              i += 2;
            } else if (/^\d+$/.test(arg)) {
              count = toInt(arg) || 100;
              i += 1;
            } else {
              i += 1;
            }
          }

          const chatId = String(msg.chatId);

          const db = await getDB();
          const useReplyMode = db.data.aiConfig.reply_mode !== false; // 默认开启回复模式
          const maxOutputLength = db.data.aiConfig.max_output_length ?? 0; // 默认不限制

          await msg.edit({ text: "⏳ 正在获取消息并总结..." });

          const messageData = await getGroupMessages(chatId, count);
          if (!messageData || messageData.length === 0) {
            await msg.edit({ text: "❌ 未找到可总结的消息" });
            return;
          }

          // 获取当前群组信息
          const client = await getGlobalClient();
          let chatDisplay = chatId;
          if (client) {
            try {
              const chat = await client.getEntity(chatId);
              const displayParts: string[] = [];
              if ((chat as any).title)
                displayParts.push(htmlEscape((chat as any).title));
              if ((chat as any).username)
                displayParts.push(htmlEscape(`@${(chat as any).username}`));
              displayParts.push(codeTag(chatId));
              chatDisplay = displayParts.join(" ");
            } catch (e) {
              console.error("获取群组信息失败:", e);
            }
          }

          const task: SummaryTask = {
            id: "temp",
            cron: "",
            chatId,
            chatDisplay,
            interval: "",
            messageCount: count,
            aiProvider: aiProvider || db.data.aiConfig.default_provider,
            aiPrompt: undefined,
            createdAt: String(Date.now()),
          };

          const summaryResult = await summarizeMessages(task, messageData);
          if (!summaryResult.success) {
            await msg.edit({
              text: `❌ ${htmlEscape(summaryResult.error)}`,
              parseMode: "html",
            });
            return;
          }

          let summaryContent = summaryResult.result!;

          // 过滤掉思考标签内容（如 <thinking>...</thinking>、<think>...</think>）
          summaryContent = summaryContent.replace(
            /<thinking>[\s\S]*?<\/thinking>/gi,
            "",
          );
          summaryContent = summaryContent.replace(
            /<think>[\s\S]*?<\/think>/gi,
            "",
          );
          summaryContent = summaryContent.trim();

          // 应用最大输出长度限制（过滤思考内容后再计算）
          if (maxOutputLength > 0 && summaryContent.length > maxOutputLength) {
            summaryContent =
              summaryContent.substring(0, maxOutputLength) +
              "\n\n⚠️ 内容已截断（超过最大长度限制）";
          }

          const displayName = chatDisplay.replace(/\s*<code>.*?<\/code>/gi, "");
          const header = `📊 <b>群组总结</b>\n${displayName} · ${formatDate(new Date())}\n\n`;

          // 应用折叠标签（如果启用）
          const wrappedContent = wrapWithSpoiler(
            summaryContent,
            db.data.aiConfig.default_spoiler || false,
          );
          const summaryText = `${header}${wrappedContent}`;

          const needHtmlParse = true;
          const linkPreview = db.data.aiConfig.link_preview === true;

          // 根据模式选择编辑原消息或回复新消息
          if (useReplyMode) {
            // 回复模式：删除原消息，发送新消息（防止运行时间长消息被顶走）
            if (client) {
              await client.sendMessage(chatId, {
                message: summaryText,
                parseMode: needHtmlParse ? "html" : undefined,
                linkPreview,
                replyTo: msg.replyToMsgId || undefined,
              });
              await msg.delete({ revoke: true });
            }
          } else {
            // 编辑模式：直接编辑原消息
            await msg.edit({
              text: summaryText,
              parseMode: needHtmlParse ? "html" : undefined,
              linkPreview,
            });
          }
          return;
        }

        if (sub === "add") {
          const chatIdInput = args[0];

          // 处理引号包裹的 cron 表达式（参考 qdsg）
          let intervalInput = "";
          let paramIndex = 1;

          if (args[paramIndex] && args[paramIndex].startsWith('"')) {
            const cronParts: string[] = [];
            while (paramIndex < args.length) {
              const part = args[paramIndex];
              cronParts.push(part);
              if (part.endsWith('"')) {
                paramIndex++;
                break;
              }
              paramIndex++;
            }
            intervalInput = cronParts.join(" ").replace(/^"|"$/g, "");
          } else {
            intervalInput = args[paramIndex] || "";
            paramIndex++;
          }

          if (!chatIdInput || !intervalInput) {
            await msg.edit({
              text: `❌ 格式错误\n\n用法: <code>${mainPrefix}sum add &lt;群组标识&gt; &lt;间隔&gt; [消息数] [选项]</code>\n\n群组标识支持:\n• 数字ID: -1001234567890\n• 链接: t.me/groupname\n• 用户名: @groupname\n\n示例: <code>${mainPrefix}sum add -1001234567890 2h</code>`,
              parseMode: "html",
            });
            return;
          }

          const cronExpr = parseInterval(intervalInput);
          if (!cronExpr) {
            await msg.edit({
              text: `❌ 无效的间隔格式\n\n支持格式:\n• 简化: 2h (2小时), 30m (30分钟)\n• Cron(6字段): 0 0 9,15,21 * * * (每天9:00,15:00,21:00)\n• Cron(5字段): 30 */2 * * * (自动补秒字段)`,
              parseMode: "html",
            });
            return;
          }

          const parsedChatId = parseChatIdentifier(chatIdInput);
          const entity = await formatEntity(parsedChatId);
          const chatId = entity?.id ? String(entity.id) : parsedChatId;

          const db = await getDB();
          const currentSeq = toInt(db.data.seq) || 0;
          db.data.seq = String(currentSeq + 1);
          const id = db.data.seq;

          // 解析参数（从 paramIndex 开始，因为前面已经处理了 chatId 和 interval）
          let messageCount = 100;
          let timeRange: number | undefined;
          let aiProvider: string | undefined =
            db.data.aiConfig.default_provider;
          let useSpoiler = db.data.aiConfig.default_spoiler || false;
          let remark = "";

          let i = paramIndex;
          while (i < args.length) {
            const arg = args[i];

            if (arg === "--time") {
              timeRange = toInt(args[i + 1]);
              i += 2;
            } else if (arg === "--provider") {
              aiProvider = args[i + 1];
              i += 2;
            } else if (arg === "--spoiler") {
              useSpoiler = true;
              i += 1;
            } else if (arg === "--no-spoiler") {
              useSpoiler = false;
              i += 1;
            } else if (!isNaN(Number(arg))) {
              messageCount = toInt(arg) || 100;
              i += 1;
            } else {
              remark += (remark ? " " : "") + arg;
              i += 1;
            }
          }

          const task: SummaryTask = {
            id,
            cron: cronExpr,
            chatId,
            chatDisplay: entity?.display,
            interval: intervalInput,
            messageCount,
            timeRange,
            pushTarget: db.data.defaultPushTarget,
            aiProvider,
            aiPrompt: undefined,
            useSpoiler,
            createdAt: String(Date.now()),
            remark: remark || undefined,
          };

          db.data.tasks.push(task);
          await db.write();
          await scheduleTask(task);

          const nextAt = cron.sendAt(cronExpr);
          const nextDate = (nextAt as any).toJSDate
            ? (nextAt as any).toJSDate()
            : nextAt;

          const tip = [
            "✅ 已添加总结任务",
            `ID: ${codeTag(id)}`,
            `群组: ${entity?.display ? htmlEscape(entity.display) : codeTag(chatId)}`,
            `间隔: ${codeTag(intervalInput)}`,
            timeRange
              ? `时间范围: 过去${timeRange}小时`
              : `消息数: ${messageCount}`,
            aiProvider ? `AI配置: ${codeTag(aiProvider)}` : null,
            useSpoiler ? `折叠: 是` : null,
            `推送: ${codeTag(task.pushTarget || "me")}`,
            remark ? `备注: ${htmlEscape(remark)}` : null,
            `下次执行: ${formatDate(nextDate)}`,
          ]
            .filter(Boolean)
            .join("\n");

          await msg.edit({ text: tip, parseMode: "html" });
          return;
        }

        if (sub === "list" || sub === "ls") {
          const db = await getDB();
          if (db.data.tasks.length === 0) {
            await msg.edit({ text: "暂无总结任务" });
            return;
          }

          const lines: string[] = ["📋 所有总结任务", ""];

          // 按任务ID排序（数字升序）
          const sortedTasks = [...db.data.tasks].sort((a, b) => {
            const idA = parseInt(a.id) || 0;
            const idB = parseInt(b.id) || 0;
            return idA - idB;
          });

          for (const t of sortedTasks) {
            const nextDt = cron.sendAt(t.cron);
            const nextDate = (nextDt as any).toJSDate
              ? (nextDt as any).toJSDate()
              : nextDt;

            lines.push(
              `${codeTag(t.id)} • ${htmlEscape(t.remark || t.chatDisplay || t.chatId)}`,
            );
            lines.push(`群组: ${htmlEscape(t.chatDisplay || t.chatId)}`);
            lines.push(`间隔: ${codeTag(t.interval)}`);
            if (t.timeRange) {
              lines.push(`时间范围: 过去${t.timeRange}小时`);
            } else {
              lines.push(`消息数: ${t.messageCount}`);
            }
            if (t.aiProvider) {
              lines.push(`AI配置: ${codeTag(t.aiProvider)}`);
            } else {
              lines.push(
                `AI配置: 默认 (${htmlEscape(db.data.aiConfig.default_provider || "openai")})`,
              );
            }
            if (t.aiPrompt) {
              const shortPrompt =
                t.aiPrompt.length > 30
                  ? t.aiPrompt.substring(0, 30) + "..."
                  : t.aiPrompt;
              lines.push(`提示词: ${htmlEscape(shortPrompt)}`);
            } else {
              lines.push(`提示词: 默认`);
            }
            if (t.useSpoiler) lines.push(`折叠: 是`);
            lines.push(`推送: ${codeTag(t.pushTarget || "me")}`);
            if (t.disabled) {
              lines.push(`状态: ⏹ 已禁用`);
            } else {
              lines.push(`下次: ${formatDate(nextDate)}`);
            }
            if (t.lastRunAt)
              lines.push(`上次: ${formatDate(new Date(Number(t.lastRunAt)))}`);
            if (t.lastResult) lines.push(`结果: ${htmlEscape(t.lastResult)}`);
            if (t.lastError) lines.push(`错误: ${htmlEscape(t.lastError)}`);
            lines.push("");
          }

          await msg.edit({ text: lines.join("\n"), parseMode: "html" });
          return;
        }

        if (sub === "del" || sub === "rm") {
          const id = args[0];
          if (!id) {
            await msg.edit({ text: "请提供任务ID" });
            return;
          }

          const db = await getDB();
          const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: ${codeTag(id)}`,
              parseMode: "html",
            });
            return;
          }

          cronManager.del(makeCronKey(id));
          db.data.tasks.splice(idx, 1);
          await db.write();

          await msg.edit({
            text: `✅ 已删除任务 ${codeTag(id)}`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "run" || sub === "now") {
          const id = args[0];
          if (!id) {
            await msg.edit({ text: "请提供任务ID" });
            return;
          }

          const db = await getDB();
          const task = db.data.tasks.find((t: SummaryTask) => t.id === id);
          if (!task) {
            await msg.edit({
              text: `未找到任务: ${codeTag(id)}`,
              parseMode: "html",
            });
            return;
          }

          // 获取群组链接
          let chatLink = "";
          try {
            const client = await getGlobalClient();
            if (client) {
              const entity = await client.getEntity(task.chatId);
              const username = (entity as any).username;
              chatLink = buildChatLink(task.chatId, username);
            }
          } catch {
            /* 忽略 */
          }

          const chatDisplay = task.chatDisplay || task.chatId;
          const linkText = chatLink
            ? ` <a href="${attrEscape(chatLink)}">${htmlEscape(chatDisplay)}</a>`
            : ` ${htmlEscape(chatDisplay)}`;
          await msg.edit({
            text: `⏳ 正在执行总结...${linkText}`,
            parseMode: "html",
          });

          const result = await executeSummary(task);
          if (result.success) {
            await msg.edit({
              text: `✅ ${htmlEscape(result.message)}`,
              parseMode: "html",
            });
          } else {
            await msg.edit({
              text: `❌ ${htmlEscape(result.message)}`,
              parseMode: "html",
            });
          }
          return;
        }

        if (sub === "edit") {
          const id = args[0];
          const prop = args[1]?.toLowerCase();
          const value = args.slice(2).join(" ");

          if (!id || !prop) {
            await msg.edit({
              text: `❌ 格式错误\n\n用法: <code>${mainPrefix}sum edit &lt;任务ID&gt; &lt;属性&gt; &lt;值&gt;</code>\n\n支持的属性:\n• spoiler - 折叠显示 (on/off)\n• provider - AI配置名称\n• prompt - AI提示词 (留空使用全局配置)`,
              parseMode: "html",
            });
            return;
          }

          const db = await getDB();
          const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: ${codeTag(id)}`,
              parseMode: "html",
            });
            return;
          }

          const task = db.data.tasks[idx];

          if (prop === "spoiler") {
            if (!value) {
              await msg.edit({
                text: "❌ 请提供值: on 或 off",
                parseMode: "html",
              });
              return;
            }
            if (value === "on" || value === "true" || value === "1") {
              task.useSpoiler = true;
              await db.write();
              await msg.edit({
                text: `✅ 已启用任务 ${codeTag(id)} 的折叠显示`,
                parseMode: "html",
              });
            } else if (value === "off" || value === "false" || value === "0") {
              task.useSpoiler = false;
              await db.write();
              await msg.edit({
                text: `✅ 已禁用任务 ${codeTag(id)} 的折叠显示`,
                parseMode: "html",
              });
            } else {
              await msg.edit({
                text: "❌ 无效的值，请使用 on 或 off",
                parseMode: "html",
              });
            }
          } else if (prop === "provider") {
            if (!value) {
              // 清空 provider，使用全局默认
              task.aiProvider = undefined;
              await db.write();
              await msg.edit({
                text: `✅ 已清空任务 ${codeTag(id)} 的 AI 配置，将使用全局默认配置`,
                parseMode: "html",
              });
            } else {
              // 检查 provider 是否存在
              if (!db.data.aiConfig.providers[value]) {
                await msg.edit({
                  text: `❌ 未找到 AI 配置: ${codeTag(value)}`,
                  parseMode: "html",
                });
                return;
              }
              task.aiProvider = value;
              await db.write();
              await msg.edit({
                text: `✅ 已设置任务 ${codeTag(id)} 的 AI 配置为: ${codeTag(value)}`,
                parseMode: "html",
              });
            }
          } else if (prop === "prompt") {
            if (!value) {
              // 清空 prompt，使用全局默认
              task.aiPrompt = undefined;
              await db.write();
              await msg.edit({
                text: `✅ 已清空任务 ${codeTag(id)} 的提示词，将使用全局默认提示词`,
                parseMode: "html",
              });
            } else {
              task.aiPrompt = value;
              await db.write();
              await msg.edit({
                text: `✅ 已设置任务 ${codeTag(id)} 的提示词`,
                parseMode: "html",
              });
            }
          } else {
            await msg.edit({
              text: `❌ 未知属性: ${codeTag(prop)}\n支持: spoiler/provider/prompt`,
              parseMode: "html",
            });
          }
          return;
        }

        if (sub === "disable" || sub === "enable") {
          const id = args[0];
          if (!id) {
            await msg.edit({ text: "请提供任务ID" });
            return;
          }

          const db = await getDB();
          const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: ${codeTag(id)}`,
              parseMode: "html",
            });
            return;
          }

          const t = db.data.tasks[idx];
          if (sub === "disable") {
            cronManager.del(makeCronKey(id));
            t.disabled = true;
            await db.write();
            await msg.edit({
              text: `⏸️ 已禁用任务 ${codeTag(id)}`,
              parseMode: "html",
            });
          } else {
            t.disabled = false;
            await db.write();
            await scheduleTask(t);
            await msg.edit({
              text: `▶️ 已启用任务 ${codeTag(id)}`,
              parseMode: "html",
            });
          }
          return;
        }

        if (sub === "reorder" || sub === "sort") {
          const db = await getDB();
          if (db.data.tasks.length === 0) {
            await msg.edit({ text: "暂无任务需要重排序" });
            return;
          }

          // 停止所有任务
          for (const t of db.data.tasks) {
            cronManager.del(makeCronKey(t.id));
          }

          // 重新编号
          const oldIds: string[] = [];
          db.data.tasks.forEach((t: SummaryTask, i: number) => {
            oldIds.push(t.id);
            t.id = String(i + 1);
          });
          db.data.seq = String(db.data.tasks.length);

          // 重新调度
          for (const t of db.data.tasks) {
            if (!t.disabled && cron.validateCronExpression(t.cron).valid) {
              await scheduleTask(t);
            }
          }

          await db.write();

          const mapping = oldIds
            .map((old, i) => `${htmlEscape(old)} → ${i + 1}`)
            .join(", ");
          await msg.edit({
            text: `✅ 已重新排序 ${db.data.tasks.length} 个任务\n\n${mapping}`,
            parseMode: "html",
          });
          return;
        }

        if (sub === "config") {
          const action = args[0];

          if (action === "list" || action === "ls") {
            const db = await getDB();
            const providers = db.data.aiConfig.providers;
            const cfg = db.data.aiConfig;

            if (Object.keys(providers).length === 0) {
              await msg.edit({ text: "暂无配置" });
              return;
            }

            const lines = ["🤖 AI 配置列表", ""];

            for (const [key, p] of Object.entries(providers)) {
              const provider = p as CustomProvider;
              lines.push(
                `<b>${htmlEscape(provider.name)}</b> (${codeTag(key)})`,
              );
              lines.push(
                `接口: 自动识别 (${codeTag(detectProtocol(provider))})`,
              );
              lines.push(`Base URL: ${codeTag(provider.base_url)}`);
              lines.push(`Model: ${codeTag(provider.model)}`);
              lines.push(`API Key: ${provider.api_key ? "已设置" : "未设置"}`);
              lines.push("");
            }

            lines.push("⚙️ 全局设置");
            lines.push("");
            lines.push(
              `默认配置: ${codeTag(cfg.default_provider || "未设置")}`,
            );
            lines.push(
              `默认推送: ${codeTag(db.data.defaultPushTarget || "me")}`,
            );
            lines.push(`默认提示词: ${promptStatus(cfg.default_prompt)}`);
            lines.push(`链接预览: ${cfg.link_preview ? "开启" : "关闭"}`);

            await msg.edit({ text: lines.join("\n"), parseMode: "html" });
            return;
          }

          if (action === "add") {
            const name = args[1];
            if (!name) {
              await msg.edit({
                text: `用法: <code>${mainPrefix}sum config add &lt;名称&gt; &lt;BaseURL&gt; &lt;API_KEY&gt; &lt;模型&gt;</code>`,
                parseMode: "html",
              });
              return;
            }

            const db = await getDB();
            const key = name.toLowerCase().replace(/\s+/g, "_");
            const officialPreset =
              OFFICIAL_PROVIDER_PRESETS[
                key as keyof typeof OFFICIAL_PROVIDER_PRESETS
              ];
            if (officialPreset && args[2] && !args[2].startsWith("http")) {
              db.data.aiConfig.providers[key] = {
                ...officialPreset,
                api_key: args[2],
              };
              await db.write();
              await msg.edit({
                text: `✅ 已配置 <b>${htmlEscape(officialPreset.name)}</b>，模型: ${codeTag(officialPreset.model)}`,
                parseMode: "html",
              });
              return;
            }

            const baseUrl = args[2];
            const apiKey = args[3];
            const model = args[4];
            if (!baseUrl || !model || !apiKey) {
              await msg.edit({
                text: `❌ 用法: <code>${mainPrefix}sum config add &lt;名称&gt; &lt;BaseURL&gt; &lt;API_KEY&gt; &lt;模型&gt;</code>
示例: <code>${mainPrefix}sum config add myai https://api.example.com sk-xxx gpt-5.6-terra</code>`,
                parseMode: "html",
              });
              return;
            }
            if (!/^https?:\/\//i.test(baseUrl)) {
              await msg.edit({
                text: "❌ Base URL 必须以 http:// 或 https:// 开头",
              });
              return;
            }

            db.data.aiConfig.providers[key] = {
              name,
              base_url: normalizedBaseUrl(baseUrl),
              api_key: apiKey,
              model,
              type: "auto",
            };
            await db.write();
            await msg.edit({
              text: `✅ 已添加 ${codeTag(key)}，将按模型自动选择接口`,
              parseMode: "html",
            });
            return;
          }

          if (action === "set") {
            const name = args[1];
            const prop = args[2];
            const value = args.slice(3).join(" ");

            if (!name || !prop) {
              await msg.edit({
                text: "用法: sum config set &lt;名称&gt; key|model|url &lt;值&gt;\n全局选项: default/prompt/preview",
              });
              return;
            }

            const db = await getDB();

            // 全局设置
            if (name === "push") {
              if (!prop) {
                await msg.edit({ text: "请提供推送目标" });
                return;
              }
              db.data.defaultPushTarget = prop;
              await db.write();
              await msg.edit({
                text: `✅ 已设置默认推送目标: ${codeTag(prop)}`,
                parseMode: "html",
              });
              return;
            }

            if (name === "default") {
              if (!prop) {
                await msg.edit({ text: "请提供配置名称" });
                return;
              }
              if (!db.data.aiConfig.providers[prop]) {
                await msg.edit({ text: `❌ 未找到配置: ${htmlEscape(prop)}` });
                return;
              }
              db.data.aiConfig.default_provider = prop;
              await db.write();
              await msg.edit({
                text: `✅ 已设置默认配置: ${codeTag(prop)}`,
                parseMode: "html",
              });
              return;
            }

            if (name === "preview") {
              const enabled = prop?.toLowerCase();
              if (enabled !== "on" && enabled !== "off") {
                await msg.edit({ text: "用法: sum config set preview on|off" });
                return;
              }
              db.data.aiConfig.link_preview = enabled === "on";
              await db.write();
              await msg.edit({
                text: `✅ 链接预览已${enabled === "on" ? "开启" : "关闭"}`,
              });
              return;
            }

            if (name === "prompt") {
              if (!prop) {
                await msg.edit({
                  text: "请提供提示词，或使用 show 查看、reset 重置",
                });
                return;
              }

              if (prop === "show") {
                await msg.edit({
                  text: `<b>📝 当前生效提示词</b>
状态: ${promptStatus(db.data.aiConfig.default_prompt)}

${codeTag(db.data.aiConfig.default_prompt || DEFAULT_PROMPT)}`,
                  parseMode: "html",
                });
                return;
              }

              // 重置提示词
              if (prop === "reset") {
                db.data.aiConfig.default_prompt = DEFAULT_PROMPT;
                await db.write();
                await msg.edit({ text: `✅ 已重置提示词为默认值` });
                return;
              }

              const promptValue = [prop, value].filter(Boolean).join(" ");
              db.data.aiConfig.default_prompt = promptValue;
              await db.write();
              await msg.edit({ text: `✅ 已设置提示词` });
              return;
            }

            if (name === "spoiler") {
              if (!prop) {
                await msg.edit({ text: "请提供值: on 或 off" });
                return;
              }

              if (prop === "on" || prop === "true" || prop === "1") {
                db.data.aiConfig.default_spoiler = true;
                await db.write();
                await msg.edit({ text: `✅ 已启用全局折叠` });
                return;
              } else if (prop === "off" || prop === "false" || prop === "0") {
                db.data.aiConfig.default_spoiler = false;
                await db.write();
                await msg.edit({ text: `✅ 已关闭全局折叠` });
                return;
              } else {
                await msg.edit({ text: "❌ 无效的值，请使用 on 或 off" });
                return;
              }
            }

            if (name === "timeout") {
              if (!prop) {
                await msg.edit({
                  text: "请提供超时时间（秒），例如: 60、120、180",
                });
                return;
              }

              const seconds = toInt(prop);
              if (!seconds || seconds < 10) {
                await msg.edit({ text: "❌ 超时时间必须至少为10秒" });
                return;
              }

              db.data.aiConfig.default_timeout = seconds * 1000;
              await db.write();
              await msg.edit({ text: `✅ 已设置超时时间为 ${seconds} 秒` });
              return;
            }

            if (name === "reply") {
              if (!prop) {
                await msg.edit({ text: "请提供值: on 或 off" });
                return;
              }

              if (prop === "on" || prop === "true" || prop === "1") {
                db.data.aiConfig.reply_mode = true;
                await db.write();
                await msg.edit({
                  text: `✅ 已开启回复模式（发送新消息，防止被顶走）`,
                });
                return;
              } else if (prop === "off" || prop === "false" || prop === "0") {
                db.data.aiConfig.reply_mode = false;
                await db.write();
                await msg.edit({ text: `✅ 已关闭回复模式（编辑原消息）` });
                return;
              } else {
                await msg.edit({ text: "❌ 无效的值，请使用 on 或 off" });
                return;
              }
            }

            if (name === "maxoutput") {
              if (!prop) {
                await msg.edit({
                  text: "请提供最大输出字符数（0表示不限制），例如: 4000、8000",
                });
                return;
              }

              const length = toInt(prop);
              if (length === undefined || length < 0) {
                await msg.edit({ text: "❌ 请输入有效的数字（0表示不限制）" });
                return;
              }

              db.data.aiConfig.max_output_length = length;
              await db.write();
              if (length === 0) {
                await msg.edit({ text: `✅ 已取消输出长度限制` });
              } else {
                await msg.edit({
                  text: `✅ 已设置最大输出长度为 ${length} 字符`,
                });
              }
              return;
            }

            // 配置项设置
            const provider = db.data.aiConfig.providers[name];

            if (!provider) {
              await msg.edit({ text: `❌ 未找到配置: ${htmlEscape(name)}` });
              return;
            }

            if (!value) {
              await msg.edit({ text: "请提供值" });
              return;
            }

            if (prop === "key") {
              provider.api_key = value;
            } else if (prop === "model") {
              provider.model = value;
            } else if (prop === "url") {
              if (!/^https?:\/\//i.test(value)) {
                await msg.edit({
                  text: "❌ Base URL 必须以 http:// 或 https:// 开头",
                });
                return;
              }
              provider.base_url = normalizedBaseUrl(value);
            } else {
              await msg.edit({ text: "❌ 无效的属性，支持: key/model/url" });
              return;
            }

            await db.write();
            await msg.edit({
              text: `✅ 已更新配置 ${codeTag(name)} 的 ${codeTag(prop)}`,
              parseMode: "html",
            });
            return;
          }

          if (action === "del" || action === "rm") {
            const name = args[1];

            if (!name) {
              await msg.edit({ text: "请提供配置名称" });
              return;
            }

            const db = await getDB();

            if (!db.data.aiConfig.providers[name]) {
              await msg.edit({ text: `❌ 未找到配置: ${htmlEscape(name)}` });
              return;
            }

            const clearedDefault = db.data.aiConfig.default_provider === name;
            delete db.data.aiConfig.providers[name];

            if (clearedDefault) {
              db.data.aiConfig.default_provider = undefined;
            }
            for (const task of db.data.tasks) {
              if (task.aiProvider === name) task.aiProvider = undefined;
            }

            await db.write();
            await msg.edit({
              text: `✅ 已删除配置 ${codeTag(name)}${clearedDefault ? "，默认配置已清空" : ""}`,
              parseMode: "html",
            });
            return;
          }

          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        await msg.edit({ text: help_text, parseMode: "html" });
      } catch (e: any) {
        await msg.edit({ text: `❌ 错误: ${e?.message || e}` });
      }
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "sum",
    title: "AI 摘要",
    description: "AI 长文本摘要配置",
    category: "插件配置",
    icon: "📝",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "default_provider",
            "label": "默认提供商",
            "type": "string",
            "placeholder": "如: openai"
      },
      {
            "key": "default_prompt",
            "label": "默认提示词",
            "type": "textarea",
            "placeholder": "总结以下内容"
      },
      {
            "key": "default_timeout",
            "label": "默认超时 (秒)",
            "type": "number",
            "min": 10,
            "max": 300,
            "default": 60
      },
      {
            "key": "default_spoiler",
            "label": "默认使用 Spoiler",
            "type": "boolean",
            "default": true
      },
      {
            "key": "reply_mode",
            "label": "回复模式",
            "type": "boolean"
      },
      {
            "key": "max_output_length",
            "label": "最大输出长度",
            "type": "number",
            "min": 100,
            "max": 50000
      },
      {
            "key": "link_preview",
            "label": "链接预览",
            "type": "boolean"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await getDB();
      return db.data.aiConfig as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await getDB();
      Object.assign(db.data.aiConfig, patch);
      await db.write();
    },
  };
}

export default new SummaryPlugin();
