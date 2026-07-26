import { Plugin, type PluginRuntimeContext , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { TelegramFormatter } from "@utils/telegramFormatter";
import { TelegraphFormatter } from "@utils/telegraphFormatter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "path";
import axios from "axios";
import http from "http";
import https from "https";
import { safeGetMessages } from "@utils/safeGetMessages";

type RepoEntry = {
  tag: string;
  repo: string;
  url: string;
  addedAt: string;
};

type ContextTurn = {
  q: string;
  a: string;
  at: string;
};

type ChatState = {
  currentTag: string;
  repos: Record<string, RepoEntry>;
  contextEnabled?: boolean;
  contextTurns?: Record<string, ContextTurn[]>;
  telegraphToken?: string;
};

type MainChatState = {
  currentTag: string;
  repos: Record<string, RepoEntry>;
};

type MainDB = {
  chats: Record<string, MainChatState>;
  telegraphToken?: string;
};

type CtxChatState = {
  contextEnabled?: boolean;
  contextTurns?: Record<string, ContextTurn[]>;
};

type CtxDB = {
  chats: Record<string, CtxChatState>;
};

const MAX_TG_LEN = 4050;
const MAX_DEEPWIKI_LEN = 48000;
const MAX_TURNS_PER_TAG = 50;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const getMessageText = (m?: Api.Message | null): string => {
  if (!m) return "";
  const text = (m as any).message ?? (m as any).text ?? "";
  return typeof text === "string" ? text : "";
};

const getRepliedMessageText = async (msg: Api.Message): Promise<string> => {
  try {
    const getter = (msg as any).getReplyMessage;
    if (typeof getter === "function") {
      const replied = await getter.call(msg);
      return getMessageText(replied).trim();
    }
  } catch {}

  try {
    const replyToMsgId =
      (msg as any)?.replyTo?.replyToMsgId ??
      (msg as any)?.replyToMsgId ??
      (msg as any)?.replyTo?.replyToMsg?.id;
    if (!replyToMsgId) return "";
    const peer = (msg.chatId || msg.peerId) as any;
    const res = await safeGetMessages(msg.client as any, peer, { ids: [replyToMsgId] });
    const replied = Array.isArray(res) ? res[0] : res;
    return getMessageText(replied).trim();
  } catch {}

  return "";
};

const getRepliedMessageId = async (msg: Api.Message): Promise<number | undefined> => {
  try {
    const typedMsg = msg as Api.Message & {
      replyTo?: { replyToMsgId?: number; replyToTopId?: number; replyToMsg?: { id?: number } };
      replyToMsgId?: number;
    };
    const id =
      typedMsg.replyTo?.replyToTopId ??
      typedMsg.replyTo?.replyToMsgId ??
      typedMsg.replyToMsgId ??
      typedMsg.replyTo?.replyToMsg?.id;

    if (typeof id === "number") return id;

    const getter = (msg as any).getReplyMessage;
    if (typeof getter === "function") {
      const replied = await getter.call(msg);
      const typedReply = replied as Api.Message & {
        replyTo?: { replyToTopId?: number };
      };
      const rid = typedReply.replyTo?.replyToTopId ?? typedReply.id;
      if (typeof rid === "number") return rid;
    }
  } catch {}

  return undefined;
};

class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

const requireUser = (cond: any, msg: string) => {
  if (!cond) throw new UserError(msg);
};

class MessageSender {
  static async sendOrEdit(msg: Api.Message, text: string, parseMode: "html" | "markdown" = "html"): Promise<Api.Message | undefined> {
    try {
      return await msg.edit({ text, parseMode, linkPreview: false } as any);
    } catch {
      return await msg.reply({ message: text, parseMode, linkPreview: false } as any);
    }
  }

  static async sendNew(
    msg: Api.Message,
    text: string,
    parseMode: "html" | "markdown" = "html",
    replyToId?: number,
    linkPreview: boolean = false
  ): Promise<Api.Message | undefined> {
    const topicRootId = getTopicRootId(msg);
    const replyTo =
      replyToId && topicRootId && replyToId !== topicRootId
        ? new Api.InputReplyToMessage({
            replyToMsgId: replyToId,
            topMsgId: topicRootId,
          })
        : replyToId ?? topicRootId;

    return await (msg.client as any).sendMessage(msg.chatId || msg.peerId, {
      message: text,
      parseMode,
      ...(replyTo ? { replyTo } : {}),
      linkPreview,
    });
  }
}

const getTopicRootId = (msg: Api.Message): number | undefined => {
  const typedMsg = msg as Api.Message & {
    replyTo?: { replyToTopId?: number; replyToMsgId?: number };
    replyToMsgId?: number;
  };
  return typedMsg.replyTo?.replyToTopId ?? typedMsg.replyTo?.replyToMsgId ?? typedMsg.replyToMsgId;
};

class DeepWikiStore {
  private dbMain: any;
  private dbCtx: any;

  private gk(chatKey: string): string {
    return chatKey || "unknown";
  }

  async init(): Promise<void> {
    const baseDir = createDirectoryInAssets("deepwiki");
    const mainFile = path.join(baseDir, "config.json");
    const ctxFile = path.join(baseDir, "context.json");

    this.dbMain = await JSONFilePreset<MainDB>(mainFile, { chats: {}, telegraphToken: "" });
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.chats ||= {};
    this.dbMain.data.telegraphToken ||= "";
    await this.dbMain.write();

    this.dbCtx = await JSONFilePreset<CtxDB>(ctxFile, { chats: {} });
    await this.dbCtx.read();
    this.dbCtx.data ||= { chats: {} };
    this.dbCtx.data.chats ||= {};
    await this.dbCtx.write();
  }

  private ensureReady() {
    if (!this.dbMain || !this.dbCtx) throw new Error("DeepWikiStore not initialized");
  }

  private normalizeMainState(state: MainChatState): MainChatState {
    state.currentTag ||= "";
    state.repos ||= {};
    return state;
  }

  private normalizeCtxState(state: CtxChatState): CtxChatState {
    state.contextEnabled = !!state.contextEnabled;
    state.contextTurns ||= {};
    return state;
  }

  private async ensureMainChat(chatKey: string): Promise<MainChatState> {
    this.ensureReady();
    const key = this.gk(chatKey);

    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.chats ||= {};
    this.dbMain.data.telegraphToken ||= "";

    if (!this.dbMain.data.chats[key]) {
      this.dbMain.data.chats[key] = this.normalizeMainState({ currentTag: "", repos: {} });
      await this.dbMain.write();
    } else {
      this.dbMain.data.chats[key] = this.normalizeMainState(this.dbMain.data.chats[key]);
    }
    return this.dbMain.data.chats[key];
  }

  private async ensureCtxChat(chatKey: string): Promise<CtxChatState> {
    this.ensureReady();
    const key = this.gk(chatKey);

    await this.dbCtx.read();
    this.dbCtx.data ||= { chats: {} };
    this.dbCtx.data.chats ||= {};

    if (!this.dbCtx.data.chats[key]) {
      this.dbCtx.data.chats[key] = this.normalizeCtxState({ contextEnabled: false, contextTurns: {} });
      await this.dbCtx.write();
    } else {
      this.dbCtx.data.chats[key] = this.normalizeCtxState(this.dbCtx.data.chats[key]);
    }
    return this.dbCtx.data.chats[key];
  }

  async getChatState(chatKey: string): Promise<ChatState> {
    this.ensureReady();
    const main = await this.ensureMainChat(chatKey);
    const ctx = await this.ensureCtxChat(chatKey);
    await this.dbMain.read();
    return {
      currentTag: main.currentTag || "",
      repos: main.repos || {},
      contextEnabled: !!ctx.contextEnabled,
      contextTurns: ctx.contextTurns || {},
      telegraphToken: this.dbMain.data?.telegraphToken || "",
    };
  }

  async setRepo(chatKey: string, entry: RepoEntry, makeCurrent: boolean = true): Promise<void> {
    this.ensureReady();
    const state = await this.ensureMainChat(chatKey);
    state.repos ||= {};
    state.repos[entry.tag] = entry;
    if (makeCurrent) state.currentTag = entry.tag;

    const key = this.gk(chatKey);
    this.dbMain.data!.chats[key] = state;
    await this.dbMain.write();
  }

  async deleteRepo(chatKey: string, tag: string): Promise<boolean> {
    this.ensureReady();
    const main = await this.ensureMainChat(chatKey);
    if (!main.repos?.[tag]) return false;

    delete main.repos[tag];
    if (main.currentTag === tag) main.currentTag = "";

    const key = this.gk(chatKey);
    this.dbMain.data!.chats[key] = main;
    await this.dbMain.write();

    const ctx = await this.ensureCtxChat(chatKey);
    if (ctx.contextTurns?.[tag]) {
      delete ctx.contextTurns[tag];
      this.dbCtx.data!.chats[key] = ctx;
      await this.dbCtx.write();
    }

    return true;
  }

  async setCurrent(chatKey: string, tag: string): Promise<void> {
    this.ensureReady();
    const state = await this.ensureMainChat(chatKey);
    requireUser(!!state.repos?.[tag], `项目不存在：<code>${escapeHtml(tag)}</code>`);
    state.currentTag = tag;

    const key = this.gk(chatKey);
    this.dbMain.data!.chats[key] = state;
    await this.dbMain.write();
  }

  async setContextEnabled(chatKey: string, enabled: boolean): Promise<void> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    ctx.contextEnabled = !!enabled;

    const key = this.gk(chatKey);
    this.dbCtx.data!.chats[key] = ctx;
    await this.dbCtx.write();
  }

  async clearContext(chatKey: string, tag?: string): Promise<void> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    ctx.contextTurns ||= {};
    if (tag) {
      delete ctx.contextTurns[tag];
    } else {
      ctx.contextTurns = {};
    }

    const key = this.gk(chatKey);
    this.dbCtx.data!.chats[key] = ctx;
    await this.dbCtx.write();
  }

  async appendTurn(chatKey: string, tag: string, q: string, a: string): Promise<void> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    ctx.contextTurns ||= {};
    const turns = ctx.contextTurns[tag] || [];
    turns.push({ q, a, at: new Date().toISOString() });
    ctx.contextTurns[tag] = turns.slice(-MAX_TURNS_PER_TAG);

    const key = this.gk(chatKey);
    this.dbCtx.data!.chats[key] = ctx;
    await this.dbCtx.write();
  }

  async getTurns(chatKey: string, tag: string): Promise<ContextTurn[]> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    return (ctx.contextTurns?.[tag] || []).slice();
  }

  async getTelegraphToken(): Promise<string> {
    this.ensureReady();
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.telegraphToken ||= "";
    return this.dbMain.data.telegraphToken || "";
  }

  async setTelegraphToken(token: string): Promise<void> {
    this.ensureReady();
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.telegraphToken = token || "";
    await this.dbMain.write();
  }
}

class DeepWikiMcp {
  private client: any | null = null;
  private connecting: Promise<void> | null = null;
  private repoKey: string | null = null;
  private questionKey: string | null = null;
  private closed = false;

  private extractText(result: any): string {
    const parts = result?.content;
    if (!Array.isArray(parts)) {
      if (typeof result === "string") return result;
      if (typeof result?.text === "string") return result.text;
      return String(result ?? "");
    }
    const texts = parts
      .map((p: any) => {
        if (p?.type === "text" && typeof p?.text === "string") return p.text;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .filter(Boolean);
    return texts.join("\n").trim();
  }

  private stripWikiExploreTail(text: string): string {
    if (!text) return text;
    const marker = "Wiki pages you might want to explore:";
    const idx = text.indexOf(marker);
    if (idx === -1) return text;
    return text.slice(0, idx).trimEnd();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error("DeepWiki MCP client is closed");
    if (this.client) return;
    if (this.connecting) return await this.connecting;

    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL("https://mcp.deepwiki.com/mcp"));
      const client = new Client({ name: "telebox-deepwiki", version: "1.0.0" });
      try {
        await client.connect(transport as any);
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      if (this.closed) {
        await client.close();
        return;
      }
      this.client = client;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async ask(repo: string, question: string): Promise<string> {
    if (this.closed) throw new Error("DeepWiki MCP client is closed");
    const repoKey = repo.trim();
    const questionKey = question.trim();
    if (!repoKey) throw new Error("缺少仓库信息");
    if (!questionKey) throw new Error("问题不能为空");

    if (!this.client || this.repoKey !== repoKey || this.questionKey !== questionKey) {
      this.client = null;
      this.repoKey = null;
      this.questionKey = null;
      await this.ensureConnected();
      this.repoKey = repoKey;
      this.questionKey = questionKey;
    }

    const result = await this.client.callTool({
      name: "ask_question",
      arguments: {
        repoName: repoKey,
        question: questionKey,
      },
    });

    const text = this.stripWikiExploreTail(this.extractText(result));
    if (!text) throw new Error("DeepWiki 返回为空");
    return text;
  }

  async close(): Promise<void> {
    this.closed = true;
    const activeClient = this.client;
    this.client = null;
    this.repoKey = null;
    this.questionKey = null;

    if (this.connecting) {
      await this.connecting.catch(() => undefined);
    }

    const connectedClient = activeClient ?? this.client;
    this.client = null;
    if (connectedClient && connectedClient !== activeClient) {
      await connectedClient.close();
    }
    if (activeClient) {
      await activeClient.close();
    }
  }
}

const normalizeTag = (v: string): string => v.trim();

const parseRepoFromUrl = (raw: string): { repo: string; canonicalUrl: string } | null => {
  try {
    const input = raw.trim();
    if (!input) return null;
    const url = new URL(input);

    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[0];
      const repoName = parts[1].replace(/\.git$/i, "");
      return {
        repo: `${owner}/${repoName}`,
        canonicalUrl: `https://github.com/${owner}/${repoName}`,
      };
    }

    if (url.hostname === "deepwiki.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 3 && parts[0] === "browse" && parts[1] === "github.com") {
        const owner = parts[2];
        const repoName = parts[3]?.replace(/\.git$/i, "");
        if (!owner || !repoName) return null;
        return {
          repo: `${owner}/${repoName}`,
          canonicalUrl: `https://deepwiki.com/browse/github.com/${owner}/${repoName}`,
        };
      }
      if (parts.length >= 2) {
        const owner = parts[0];
        const repoName = parts[1].replace(/\.git$/i, "");
        return {
          repo: `${owner}/${repoName}`,
          canonicalUrl: `https://deepwiki.com/${owner}/${repoName}`,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
};

const splitMarkdownSections = (text: string): string[] => {
  const sections = text.split(/\n(?=#+\s)/).map((s) => s.trim()).filter(Boolean);
  return sections.length ? sections : [text.trim()];
};

const truncateBySections = (text: string, maxLen: number): { text: string; dropped: number } => {
  if (text.length <= maxLen) return { text, dropped: 0 };
  const sections = splitMarkdownSections(text);
  if (sections.length === 1) {
    const slice = text.slice(0, maxLen - 1).trimEnd() + "…";
    return { text: slice, dropped: 0 };
  }

  const kept: string[] = [];
  let total = 0;
  let dropped = 0;
  for (const sec of sections) {
    const cost = (kept.length ? 2 : 0) + sec.length;
    if (total + cost > maxLen) {
      dropped += 1;
      continue;
    }
    kept.push(sec);
    total += cost;
  }
  const out = kept.join("\n\n").trim();
  return { text: out || text.slice(0, maxLen - 1).trimEnd() + "…", dropped };
};

const buildQuestionWithContext = (turns: ContextTurn[], userQuestion: string): { finalQuestion: string; dropped: number } => {
  if (!turns.length) return { finalQuestion: userQuestion, dropped: 0 };

  let dropped = 0;
  const lines: string[] = ["你正在延续一个多轮问答。以下是最近对话上下文，请只把它们当作参考："];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const q = truncateBySections(t.q, 4000).text;
    const a = truncateBySections(t.a, 12000).text;
    lines.push(`Q${i + 1}:\n${q}`);
    lines.push(`A${i + 1}:\n${a}`);
  }

  lines.push(`当前问题:\n${userQuestion}`);
  let finalQuestion = lines.join("\n\n");
  if (finalQuestion.length <= MAX_DEEPWIKI_LEN) {
    return { finalQuestion, dropped };
  }

  const copy = turns.slice();
  while (copy.length > 0) {
    copy.shift();
    dropped += 1;
    const trimmedLines: string[] = ["你正在延续一个多轮问答。以下是最近对话上下文，请只把它们当作参考："];
    for (let i = 0; i < copy.length; i++) {
      const t = copy[i];
      const q = truncateBySections(t.q, 4000).text;
      const a = truncateBySections(t.a, 12000).text;
      trimmedLines.push(`Q${i + 1}:\n${q}`);
      trimmedLines.push(`A${i + 1}:\n${a}`);
    }
    trimmedLines.push(`当前问题:\n${userQuestion}`);
    finalQuestion = trimmedLines.join("\n\n");
    if (finalQuestion.length <= MAX_DEEPWIKI_LEN) {
      return { finalQuestion, dropped };
    }
  }

  const truncatedQuestion = truncateBySections(userQuestion, MAX_DEEPWIKI_LEN - 20).text;
  return { finalQuestion: `当前问题:\n${truncatedQuestion}`, dropped: turns.length };
};

const buildQAHtml = (headerLines: string[], question: string, answerMarkdown: string, collapseSafe: boolean): string => {
  const header = headerLines.filter(Boolean).join("\n");
  const safeQ = escapeHtml(question);
  const htmlA = TelegramFormatter.markdownToHtml(answerMarkdown, { collapseSafe });

  const qBlock = collapseSafe ? `Q:\n<blockquote expandable>${safeQ}</blockquote>\n` : `Q:\n${safeQ}\n`;
  const aBlock = collapseSafe ? `A:\n<blockquote expandable>${htmlA}</blockquote>` : `A:\n${htmlA}`;

  return header ? `${header}\n${qBlock}${aBlock}` : `${qBlock}${aBlock}`;
};

const toIdString = (v: any): string => {
  try {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "object") {
      if (v.channelId !== undefined) return String(v.channelId);
      if (v.chatId !== undefined) return String(v.chatId);
      if (v.userId !== undefined) return String(v.userId);
      if (v.id !== undefined) return String(v.id);
    }
    return String(v);
  } catch {
    return "";
  }
};

class DeepWikiPlugin extends Plugin {
  name = "deepwiki";

  private store = new DeepWikiStore();
  private mcp = new DeepWikiMcp();
  private inited = false;
  private lifecycleDispose: (() => void | Promise<void>) | null = null;
  private resourcesClosed = false;
  private httpAgent = new http.Agent({ keepAlive: true });
  private httpsAgent = new https.Agent({ keepAlive: true });

  private httpClient = axios.create({
    httpAgent: this.httpAgent,
    httpsAgent: this.httpsAgent,
  });

  setup(context: PluginRuntimeContext): void {
    this.lifecycleDispose = context.lifecycle.trackDisposable(() => this.closeResources(), {
      label: "plugin:deepwiki:resources",
    });
  }

  async cleanup(): Promise<void> {
    const dispose = this.lifecycleDispose;
    this.lifecycleDispose = null;
    if (dispose) {
      await dispose();
      return;
    }
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    await this.mcp.close();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private async initOnce(): Promise<void> {
    if (this.resourcesClosed) {
      this.mcp = new DeepWikiMcp();
      this.httpAgent = new http.Agent({ keepAlive: true });
      this.httpsAgent = new https.Agent({ keepAlive: true });
      this.httpClient = axios.create({
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
      });
      this.resourcesClosed = false;
    }
    if (this.inited) return;
    await this.store.init();
    this.inited = true;
  }

  private getMainPrefix(): string {
    const prefixes = getPrefixes();
    return prefixes[0] || "";
  }

  private getChatKey(msg: Api.Message): string {
    const chatId = (msg as any).chatId;
    const peerId = (msg as any).peerId;
    const baseKey = toIdString(chatId) || toIdString(peerId) || "unknown";
    const topicRootId = getTopicRootId(msg);
    return topicRootId ? `${baseKey}:topic:${topicRootId}` : baseKey;
  }

  private helpText(): string {
    const p = this.getMainPrefix();
    return (
      `<b>📚 DeepWiki 插件</b>\n\n` +
      `DeepWiki通过与Github上的项目建立索引可以解决目前普遍的Ai信息滞后问题来精准回答您的提问\n\n` +
      `<b>🗂️ 项目管理</b>\n` +
      `• <code>${p}deepwiki add &lt;tag&gt; &lt;url&gt;</code>（添加新的项目）\n` +
      `• <code>${p}deepwiki lst</code>（已添加的项目）\n` +
      `• <code>${p}deepwiki use &lt;tag&gt;</code>（切换默认项目）\n` +
      `• <code>${p}deepwiki del &lt;tag&gt;</code>（删除指定项目）\n\n` +
      `<b>📜 上下文管理</b>\n` +
      `• <code>${p}deepwiki ctx</code>（上下文状态）\n` +
      `• <code>${p}deepwiki ctx on/off</code>（开启或关闭上下文）\n` +
      `• <code>${p}deepwiki ctx del</code>（清空当前项目上下文）\n` +
      `• <code>${p}deepwiki ctx del &lt;tag&gt;</code>（清空指定项目上下文）\n` +
      `• <code>${p}deepwiki ctx del all</code>（清空全部项目上下文）\n\n` +
      `<b>📌 使用说明</b>\n` +
      `• <code>${p}deepwiki 你的问题</code>（发起默认项目提问）\n` +
      `• <code>${p}deepwiki &lt;tag&gt; 你的问题</code>（发起指定项目提问）\n\n` +
      `说明：项目需要能在 deepwiki.com 上正常访问（已索引）。`
    );
  }

  private formatError(err: any): string {
    if (err instanceof UserError) return `🚫 ${err.message}`;
    const msg = typeof err?.message === "string" ? err.message : String(err);
    return `❌ <b>错误:</b> ${escapeHtml(msg)}`;
  }

  private async ensureTelegraphToken(token?: string): Promise<string> {
    const existing = token || (await this.store.getTelegraphToken());
    if (existing) return existing;

    const response = await this.httpClient.request({
      url: "https://api.telegra.ph/createAccount",
      method: "POST",
      data: { short_name: "TeleBoxDeepWiki", author_name: "TeleBox" },
    });

    const tgToken = response.data?.result?.access_token;
    if (!tgToken) throw new Error("Telegraph账户创建失败");
    await this.store.setTelegraphToken(tgToken);
    return tgToken;
  }

  private async createTelegraphPage(markdown: string, titleSource?: string): Promise<{ url: string; title: string }> {
    const tgToken = await this.ensureTelegraphToken();
    const rawTitle = (titleSource || "").replace(/\s+/g, " ").trim();
    const shortTitle = rawTitle.length > 24 ? `${rawTitle.slice(0, 24)}…` : rawTitle;
    const title = shortTitle || `DeepWiki - ${new Date().toLocaleString()}`;
    const nodes = TelegraphFormatter.toNodes(markdown);

    const response = await this.httpClient.request({
      url: "https://api.telegra.ph/createPage",
      method: "POST",
      data: {
        access_token: tgToken,
        title,
        content: nodes,
        return_content: false,
      },
    });

    const url = response.data?.result?.url;
    if (!url) throw new Error(response.data?.error || "Telegraph页面创建失败");
    return { url, title };
  }

  private async sendAnswerOrTelegraph(
    msg: Api.Message,
    replyToId: number | undefined,
    headerLines: string[],
    question: string,
    answerMarkdown: string,
    collapseSafe: boolean
  ): Promise<void> {
    const signature = `<i>🍀Powered by DeepWiki</i>`;
    const html = buildQAHtml(headerLines, question, answerMarkdown, collapseSafe);
    const finalHtml = html.length + `\n${signature}`.length <= MAX_TG_LEN ? `${html}\n${signature}` : `${html}`;

    if (finalHtml.length <= MAX_TG_LEN) {
      await MessageSender.sendNew(msg, finalHtml, "html", replyToId, false);
      return;
    }

    const headerText = headerLines
      .filter(Boolean)
      .map((l) => l.replace(/<[^>]+>/g, ""))
      .join("\n");
    const telegraphMarkdown = (headerText ? `${headerText}\n` : "") + `**Q:**\n${question}\n**A:**\n${answerMarkdown}\n`;
    const telegraphResult = await this.createTelegraphPage(telegraphMarkdown, question);

    const qBlock = collapseSafe ? `Q:\n<blockquote expandable>${escapeHtml(question)}</blockquote>\n` : `Q:\n${escapeHtml(question)}\n`;

    const linkHtml = `📰内容比较长，Telegraph观感更好喔:\n🔗 <a href="${telegraphResult.url}">点我阅读内容</a>`;
    const aBlock = collapseSafe ? `A:\n<blockquote expandable>${linkHtml}</blockquote>` : `A:\n${linkHtml}`;

    const header = headerLines.filter(Boolean).join("\n");
    const body = header ? `${header}\n${qBlock}${aBlock}` : `${qBlock}${aBlock}`;
    const withSig = body.length + `\n${signature}`.length <= MAX_TG_LEN ? `${body}\n${signature}` : body;

    await MessageSender.sendNew(msg, withSig, "html", replyToId, false);
  }

  description = async (): Promise<string> => this.helpText();

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    deepwiki: async (msg: Api.Message, trigger?: Api.Message) => {
      await this.initOnce();
      const chatKey = this.getChatKey(msg);
      const raw = getMessageText(msg).trim();
      const args = raw.split(/\s+/).slice(1);
      const original = trigger || msg;

      const repliedText = await getRepliedMessageText(msg);
      const repliedMsgId = await getRepliedMessageId(msg);

      try {
        if (args.length === 0 && !repliedText) {
          await MessageSender.sendOrEdit(original, "🚫 至少需要一个问题", "html");
          return;
        }
        const state = await this.store.getChatState(chatKey);
        const sub = (args[0] || "").toLowerCase();
        if (sub === "help" || sub === "?") {
          await MessageSender.sendOrEdit(original, this.helpText(), "html");
          return;
        }
        if (sub === "lst") {
          const entries = Object.values(state.repos || {});
          if (entries.length === 0) {
            await MessageSender.sendOrEdit(
              original,
              `暂无项目。\n用 <code>${this.getMainPrefix()}deepwiki add &lt;tag&gt; &lt;url&gt;</code> 添加。`,
              "html"
            );
            return;
          }
          const cur = state.currentTag;
          const lines = entries
            .sort((a, b) => a.tag.localeCompare(b.tag))
            .map((e) => {
              const marker = e.tag === cur ? "✅" : "•";
              return `${marker} <code>${escapeHtml(e.tag)}</code> → <code>${escapeHtml(e.repo)}</code>`;
            })
            .join("\n");
          await MessageSender.sendOrEdit(original, `<b>📌 已添加项目</b>\n\n${lines}`, "html");
          return;
        }
        if (sub === "use") {
          requireUser(args.length >= 2, `用法：<code>${this.getMainPrefix()}deepwiki use &lt;tag&gt;</code>`);
          const tag = normalizeTag(args[1]);
          requireUser(!!state.repos?.[tag], `项目不存在：<code>${escapeHtml(tag)}</code>`);
          await this.store.setCurrent(chatKey, tag);
          const entry = (await this.store.getChatState(chatKey)).repos[tag];
          await MessageSender.sendOrEdit(
            original,
            `✅ 已切换默认项目：<code>${escapeHtml(entry.tag)}</code>\n• <code>${escapeHtml(entry.url)}</code>`,
            "html"
          );
          return;
        }
        if (sub === "del") {
          requireUser(args.length >= 2, `用法：<code>${this.getMainPrefix()}deepwiki del &lt;tag&gt;</code>`);
          const tag = normalizeTag(args[1]);
          const ok = await this.store.deleteRepo(chatKey, tag);
          requireUser(ok, `项目不存在：<code>${escapeHtml(tag)}</code>`);
          await MessageSender.sendOrEdit(original, `✅ 已删除项目：<code>${escapeHtml(tag)}</code>`, "html");
          return;
        }
        if (sub === "add") {
          requireUser(args.length >= 3, `用法：<code>${this.getMainPrefix()}deepwiki add &lt;tag&gt; &lt;url&gt;</code>`);
          const tagArg = normalizeTag(args[1]);
          requireUser(/^[A-Za-z0-9_.-]+$/.test(tagArg), "&lt;tag&gt; 只能包含字母/数字/下划线/点/短横线");
          const parsed = parseRepoFromUrl(args[2]);
          requireUser(!!parsed, "链接格式不正确，仅支持 deepwiki.com 或 github.com");
          const entry: RepoEntry = {
            tag: tagArg,
            repo: parsed!.repo,
            url: parsed!.canonicalUrl,
            addedAt: new Date().toISOString(),
          };
          await this.store.setRepo(chatKey, entry, true);
          await MessageSender.sendOrEdit(
            original,
            `✅ 已添加并切换默认项目：<code>${escapeHtml(entry.tag)}</code>\n• <code>${escapeHtml(entry.url)}</code>`,
            "html"
          );
          return;
        }
        if (sub === "ctx") {
          const action = (args[1] || "").toLowerCase();

          if (action === "on") {
            await this.store.setContextEnabled(chatKey, true);
            await MessageSender.sendOrEdit(original, `✅ 上下文已开启`, "html");
            return;
          }

          if (action === "off") {
            await this.store.setContextEnabled(chatKey, false);
            await MessageSender.sendOrEdit(original, `✅ 上下文已关闭`, "html");
            return;
          }

          if (action === "del") {
            const rawArg = (args[2] || "").trim().toLowerCase();
            if (rawArg === "all") {
              await this.store.clearContext(chatKey);
              await MessageSender.sendOrEdit(original, `✅ 已清空全部项目上下文`, "html");
              return;
            }

            const tagArg = args[2] ? normalizeTag(args[2]) : "";
            const tagToClear = tagArg || state.currentTag;
            requireUser(!!tagToClear, "未指定 &lt;tag&gt;，且当前也没有默认项目。用法：<code>deepwiki ctx del &lt;tag&gt;</code>");
            if (tagArg) {
              requireUser(!!state.repos?.[tagArg], `项目不存在：<code>${escapeHtml(tagArg)}</code>`);
            }
            await this.store.clearContext(chatKey, tagToClear);
            await MessageSender.sendOrEdit(original, `✅ 已清空项目上下文：<code>${escapeHtml(tagToClear)}</code>`, "html");
            return;
          }

          requireUser(!action, `未知子命令：<code>${escapeHtml(action)}</code>`);

          const enabled = !!state.contextEnabled;
          const curTag = state.currentTag || "";
          const entries = Object.values(state.repos || {}).sort((a, b) => a.tag.localeCompare(b.tag));
          const lines: string[] = [];
          lines.push(`<b>📜 上下文状态</b>\n`);
          lines.push(`• 上下文已${enabled ? "开启" : "关闭"}`);
          for (const e of entries) {
            const turns = state.contextTurns?.[e.tag] || [];
            const marker = e.tag === curTag ? "✅" : "•";
            lines.push(`${marker} <code>${escapeHtml(e.tag)}</code>（缓存轮数：<b>${turns.length}</b>）`);
          }
          await MessageSender.sendOrEdit(original, lines.join("\n"), "html");
          return;
        }

        const maybeTag = normalizeTag(args[0] || "");
        const hasTag = !!state.repos?.[maybeTag];

        let tagToUse = "";
        let question = "";

        const treatFirstAsTag = hasTag && (args.length >= 2 || !!repliedText);

        if (treatFirstAsTag) {
          tagToUse = maybeTag;
          question = args.slice(1).join(" ").trim();
        } else {
          tagToUse = state.currentTag;
          question = args.join(" ").trim();
        }

        const combinedQuestion = repliedText ? `${repliedText}${question ? `\n\n${question}` : ""}`.trim() : question.trim();

        requireUser(!!combinedQuestion, "请输入问题内容");
        requireUser(!!tagToUse, "尚未设置默认项目，请先添加项目");
        const entry = state.repos?.[tagToUse];
        requireUser(!!entry, "项目不存在，请检查 &lt;tag&gt;");

        await MessageSender.sendOrEdit(original, "💬 <b>DeepWiki 正在处理</b>", "html");

        const ctxEnabled = !!state.contextEnabled;
        let finalQuestion = combinedQuestion;
        let droppedTurns = 0;
        if (ctxEnabled) {
          const turns = await this.store.getTurns(chatKey, tagToUse);
          const built = buildQuestionWithContext(turns, combinedQuestion);
          finalQuestion = built.finalQuestion;
          droppedTurns = built.dropped;
        }

        const answer = await this.mcp.ask(entry.repo, finalQuestion);
        if (ctxEnabled) {
          await this.store.appendTurn(chatKey, tagToUse, combinedQuestion, answer);
        }

        const ctxLine =
          ctxEnabled && droppedTurns > 0
            ? `<b>上下文:</b> 开（本次因长度限制丢弃最早 <b>${droppedTurns}</b> 轮）`
            : ctxEnabled
              ? `<b>上下文:</b> 开`
              : `<b>上下文:</b> 关`;

        const headerLines = [`<b>项目:</b> <code>${escapeHtml(entry.repo)}</code>`, ctxLine];

        const replyToId = repliedMsgId ?? (original as any).id;
        await this.sendAnswerOrTelegraph(msg, replyToId, headerLines, combinedQuestion, answer, true);

        try {
          await original.delete();
        } catch {}
      } catch (err: any) {
        await MessageSender.sendOrEdit(original, this.formatError(err), "html");
      }
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "deepwiki",
    title: "DeepWiki",
    description: "DeepWiki 配置",
    category: "插件配置",
    icon: "📚",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "apiKey",
            "label": "API 密钥",
            "type": "password",
            "secret": true
      },
      {
            "key": "baseUrl",
            "label": "API 地址",
            "type": "string"
      },
      {
            "key": "defaultModel",
            "label": "默认模型",
            "type": "string"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("deepwiki"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("deepwiki"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

  async onUnload(): Promise<void> {
    await this.cleanup();
  }
}

export default new DeepWikiPlugin();
