import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import path from "path";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import {
  getGlobalClient,
  tryGetCurrentGenerationContext,
} from "@utils/runtimeManager";
import { TelegramClient } from "teleproto";
import { NewMessage, NewMessageEvent } from "teleproto/events";
import { Api } from "teleproto/tl";
import { safeGetMessages } from "@utils/safeGetMessages";
import {
  safeForwardMessage,
  parseEntityId,
  withEntityAccess,
  getEntityWithHash,
} from "@utils/entityHelpers";
import { getPrefixes } from "@utils/pluginManager";
import { JSONFilePreset } from "lowdb/node";
import * as fs from "fs";

import { htmlEscape } from "@utils/htmlEscape";

async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getEntity(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity.username)
    displayParts.push(
      mention ? `@${htmlEscape(entity.username)}` : `<code>@${htmlEscape(entity.username)}</code>`
    );

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(`<code>${target}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

// HTML 转义（规范要求）
// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// Available message types
const AVAILABLE_OPTIONS = new Set([
  "handle_edited",
  "silent",
  "text",
  "all",
  "photo",
  "document",
  "video",
  "sticker",
  "animation",
  "voice",
  "audio",
]);

// ==================== 数据库配置 ====================
interface ShiftDatabaseV2 {
  version: string;
  rules: { [sourceId: string]: ShiftRule };
  stats: { [date: string]: { [sourceId: string]: any } };
  backups: { [taskId: string]: BackupTask };
  config: {
    autoCleanOldStats: boolean;
    statsRetentionDays: number;
    enableChainForwarding: boolean;
    useLowdb: boolean; // 是否使用 lowdb
  };
}

interface BackupTask {
  sourceId: number;
  targetId: number;
  startedAt: string;
  completedAt?: string;
  status: "pending" | "running" | "completed" | "failed";
  totalMessages: number;
  processedMessages: number;
  failedMessages: number;
  lastMessageId?: number;
  reverse?: boolean;
}

// Initialize database (支持双模式)
let sqliteDb: Database.Database | null = null;
let lowdb: any = null;
let useLowdb = false;

// 尝试初始化数据库
const dbPath = createDirectoryInAssets("shift");
const sqlitePath = path.join(dbPath, "shift.db");
const lowdbPath = path.join(dbPath, "shift_v2.json");

// 检查是否已有 lowdb 或需要迁移
if (fs.existsSync(lowdbPath)) {
  useLowdb = true;
} else if (fs.existsSync(sqlitePath)) {
  // SQLite 存在，准备迁移
  sqliteDb = new Database(sqlitePath);
} else {
  // 全新安装，使用 lowdb
  useLowdb = true;
}

// 初始化数据库
async function initDatabase() {
  if (useLowdb) {
    // 使用 lowdb
    const defaultData: ShiftDatabaseV2 = {
      version: "2.0.0",
      rules: {},
      stats: {},
      backups: {},
      config: {
        autoCleanOldStats: true,
        statsRetentionDays: 30,
        enableChainForwarding: true,
        useLowdb: true,
      },
    };
    lowdb = await JSONFilePreset<ShiftDatabaseV2>(lowdbPath, defaultData);
    console.log("[SHIFT] 使用 lowdb 数据库");
  } else if (sqliteDb) {
    // 初始化 SQLite 表
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS shift_rules (
        source_id INTEGER PRIMARY KEY,
        target_id INTEGER NOT NULL,
        options TEXT NOT NULL,
        target_type TEXT NOT NULL,
        paused INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        filters TEXT NOT NULL
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS shift_stats (
        stats_key TEXT PRIMARY KEY,
        stats_data TEXT NOT NULL
      )
    `);

    // 提示可以迁移
    console.log("[SHIFT] 使用 SQLite 数据库（建议迁移到 lowdb）");
  }
}

// 自动初始化
initDatabase().catch(console.error);

// SQLite 到 lowdb 迁移功能
async function migrateToLowdb(): Promise<boolean> {
  if (!sqliteDb || useLowdb) return false;

  try {
    console.log("[SHIFT] 开始迁移数据到 lowdb...");

    // 读取 SQLite 数据
    const rules = sqliteDb.prepare("SELECT * FROM shift_rules").all() as any[];
    const stats = sqliteDb.prepare("SELECT * FROM shift_stats").all() as any[];

    // 转换规则
    const newRules: { [key: string]: ShiftRule } = {};
    for (const rule of rules) {
      newRules[String(rule.source_id)] = {
        target_id: rule.target_id,
        options: JSON.parse(rule.options || "[]"),
        target_type: rule.target_type,
        paused: rule.paused === 1,
        created_at: rule.created_at,
        filters: JSON.parse(rule.filters || "[]"),
      };
    }

    // 转换统计
    const newStats: { [date: string]: { [sourceId: string]: any } } = {};
    for (const stat of stats) {
      const parts = stat.stats_key.split(".");
      if (parts.length >= 4) {
        const date = parts[3];
        const sourceId = parts[2];
        if (!newStats[date]) newStats[date] = {};
        newStats[date][sourceId] = JSON.parse(stat.stats_data);
      }
    }

    // 创建 lowdb 数据库
    const migratedData: ShiftDatabaseV2 = {
      version: "2.0.0",
      rules: newRules,
      stats: newStats,
      backups: {},
      config: {
        autoCleanOldStats: true,
        statsRetentionDays: 30,
        enableChainForwarding: true,
        useLowdb: true,
      },
    };

    lowdb = await JSONFilePreset<ShiftDatabaseV2>(lowdbPath, migratedData);
    await lowdb.write();

    // 备份旧数据库
    const backupPath = sqlitePath + `.backup.${Date.now()}`;
    fs.renameSync(sqlitePath, backupPath);

    sqliteDb.close();
    sqliteDb = null;
    useLowdb = true;

    console.log(
      `[SHIFT] 成功迁移 ${rules.length} 条规则，备份至: ${backupPath}`
    );
    return true;
  } catch (error) {
    console.error("[SHIFT] 迁移失败:", error);
    return false;
  }
}

// Rule interface
interface ShiftRule {
  target_id: number;
  options: string[];
  target_type: string;
  paused: boolean;
  created_at: string;
  filters: string[];
  source_display?: string;
  target_display?: string;
  whitelistMode?: boolean;
  whitelistPatterns?: string[];
}

// Cache for rules
const ruleCache = new Map<
  number,
  { rule: ShiftRule | null; timestamp: number }
>();
const RULE_CACHE_TTL = 5 * 60 * 1000;

// Get shift rule from database
async function getShiftRule(sourceId: number): Promise<ShiftRule | null> {
  const now = Date.now();
  const cached = ruleCache.get(sourceId);

  if (cached && now - cached.timestamp < RULE_CACHE_TTL) {
    return cached.rule;
  }

  try {
    let rule: ShiftRule | null = null;

    if (useLowdb && lowdb) {
      // 从 lowdb 读取
      const data = lowdb.data.rules[String(sourceId)];
      rule = data || null;
    } else if (sqliteDb) {
      // 从 SQLite 读取
      const stmt = sqliteDb.prepare(
        "SELECT * FROM shift_rules WHERE source_id = ?"
      );
      const row = stmt.get(sourceId) as any;

      if (!row) {
        ruleCache.set(sourceId, { rule: null, timestamp: now });
        return null;
      }

      rule = {
        target_id: row.target_id,
        options: JSON.parse(row.options || "[]"),
        target_type: row.target_type,
        paused: row.paused === 1,
        created_at: row.created_at,
        filters: JSON.parse(row.filters || "[]"),
      };
    }

    if (rule) {
      ruleCache.set(sourceId, { rule, timestamp: now });
    }
    return rule;
  } catch (error) {
    console.error(`[SHIFT] Error getting rule for ${sourceId}:`, error);
    return null;
  }
}

// Save shift rule
function saveShiftRule(sourceId: number, rule: ShiftRule): boolean {
  try {
    if (useLowdb && lowdb) {
      // 保存到 lowdb
      lowdb.data.rules[String(sourceId)] = rule;
      lowdb.write();
      ruleCache.set(sourceId, { rule, timestamp: Date.now() });
      return true;
    } else if (sqliteDb) {
      // 保存到 SQLite
      const stmt = sqliteDb.prepare(`
      INSERT OR REPLACE INTO shift_rules 
      (source_id, target_id, options, target_type, paused, created_at, filters)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

      stmt.run(
        sourceId,
        rule.target_id,
        JSON.stringify(rule.options),
        rule.target_type,
        rule.paused ? 1 : 0,
        rule.created_at,
        JSON.stringify(rule.filters)
      );

      ruleCache.set(sourceId, { rule, timestamp: Date.now() });
      return true;
    }
    return false;
  } catch (error) {
    console.error(`[SHIFT] Error saving rule:`, error);
    return false;
  }
}

// Delete shift rule
function deleteShiftRule(sourceId: number): boolean {
  try {
    if (useLowdb && lowdb) {
      // 从 lowdb 删除
      delete lowdb.data.rules[String(sourceId)];
      lowdb.write();
      ruleCache.delete(sourceId);
      return true;
    } else if (sqliteDb) {
      // 从 SQLite 删除
      const stmt = sqliteDb.prepare(
        "DELETE FROM shift_rules WHERE source_id = ?"
      );
      stmt.run(sourceId);
      ruleCache.delete(sourceId);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`[SHIFT] Error deleting rule:`, error);
    return false;
  }
}

// Get all rules
function getAllShiftRules(): Array<{ sourceId: number; rule: ShiftRule }> {
  try {
    if (useLowdb && lowdb) {
      // 从 lowdb 读取
      return Object.entries(lowdb.data.rules).map(([sourceId, rule]) => ({
        sourceId: Number(sourceId),
        rule: rule as ShiftRule,
      }));
    } else if (sqliteDb) {
      // 从 SQLite 读取
      const stmt = sqliteDb.prepare("SELECT * FROM shift_rules");
      const rows = stmt.all() as any[];

      return rows.map((row) => ({
        sourceId: row.source_id,
        rule: {
          target_id: row.target_id,
          options: JSON.parse(row.options || "[]"),
          target_type: row.target_type,
          paused: row.paused === 1,
          created_at: row.created_at,
          filters: JSON.parse(row.filters || "[]"),
        },
      }));
    }
    return [];
  } catch (error) {
    console.error("[SHIFT] Error getting all rules:", error);
    return [];
  }
}

// Utility functions
function getDisplayName(entity: any): string {
  if (!entity) return "未知实体";
  if (entity.username) return `@${htmlEscape(entity.username)}`;
  if (entity.firstName) return entity.firstName;
  if (entity.title) return entity.title;
  return `ID: ${entity.id}`;
}

function extractIdString(id: any): string {
  if (id === undefined || id === null) return "";
  if (typeof id === "object") {
    if ("value" in id && id.value !== undefined && id.value !== null) {
      return String(id.value);
    }
    if (typeof id.toString === "function") {
      return id.toString();
    }
  }
  if (typeof id === "bigint") {
    return id.toString();
  }
  return String(id);
}

function ensureChannelId(id: any): number {
  const idStr = extractIdString(id).trim();
  if (!idStr) return Number.NaN;
  if (idStr.startsWith("-100")) return Number(idStr);
  const normalized = idStr.startsWith("-") ? idStr.slice(1) : idStr;
  return Number(`-100${normalized}`);
}

function normalizeChatId(entityOrId: any): number {
  if (typeof entityOrId === "object" && entityOrId.id) {
    if (entityOrId.className === "Channel") {
      return ensureChannelId(entityOrId.id);
    }
    const chatId = Number(extractIdString(entityOrId.id));
    if (entityOrId.className === "Chat" && chatId > 0) {
      return -chatId;
    }
    return chatId;
  } else {
    const rawId = extractIdString(entityOrId);
    if (rawId.startsWith("-100")) return Number(rawId);
    const chatId = Number(rawId);
    if (chatId > 1000000000) {
      return ensureChannelId(rawId);
    }
    return chatId;
  }
}

function getTargetTypeEmoji(entity: any): string {
  if (!entity) return "❓";
  if (entity.className === "User") return entity.bot ? "🤖" : "👤";
  if (entity.className === "Channel") return entity.broadcast ? "📢" : "👥";
  if (entity.className === "Chat") return "👥";
  return "❓";
}

function parseIndices(
  indicesStr: string,
  total: number
): { indices: number[]; invalid: string[] } {
  const indices: number[] = [];
  const invalid: string[] = [];

  for (const i of indicesStr.split(",")) {
    try {
      const idx = parseInt(i.trim()) - 1;
      if (idx >= 0 && idx < total) {
        indices.push(idx);
      } else {
        invalid.push(i.trim());
      }
    } catch (error) {
      invalid.push(i.trim());
    }
  }

  return { indices, invalid };
}

function getMediaType(message: any): string {
  if (message.photo) return "photo";
  if (message.document) return "document";
  if (message.video) return "video";
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  return "text";
}

type TimerHandle = ReturnType<typeof setTimeout>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Operation aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Operation aborted", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ====== Group forwarding helpers ======
const groupBuffers = new Map<
  string,
  {
    messages: any[];
    timer: TimerHandle | null;
    sourceId: number;
    targetId: number;
    options?: { silent?: boolean; replyTo?: number };
    shouldForward?: boolean;
    disposeTimer?: () => void | Promise<void>;
  }
>();

function cleanupGroupBuffers(): void {
  for (const entry of groupBuffers.values()) {
    if (entry.disposeTimer) {
      void entry.disposeTimer();
    } else if (entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  groupBuffers.clear();
}

function getGroupKey(message: any): string | null {
  const gid = (message as any).groupedId;
  const sid = getChatIdFromMessage(message);
  if (!gid || !sid) return null;
  const gidStr =
    typeof gid?.toString === "function" ? gid.toString() : String(gid);
  return `${sid}:${gidStr}`;
}

async function forwardGroupMessages(
  client: TelegramClient,
  fromChatId: number,
  toChatId: number,
  messageIds: number[],
  options?: { silent?: boolean; replyTo?: number }
): Promise<void> {
  try {
    const fromEntity = await getEntityWithHash(client, fromChatId);
    const toEntity = await getEntityWithHash(client, toChatId);
    await client.invoke(
      new Api.messages.ForwardMessages({
        fromPeer: fromEntity,
        id: messageIds,
        toPeer: toEntity,
        silent: options?.silent,
        ...(options?.replyTo ? { topMsgId: options.replyTo } : {}),
      })
    );
    console.log(
      `[SHIFT] 组转发成功: ${fromChatId} -> ${toChatId}, msgs=${messageIds.join(
        ","
      )}`
    );
  } catch (error) {
    console.error(
      `[SHIFT] 组转发失败: ${fromChatId} -> ${toChatId}, msgs=${messageIds.join(
        ","
      )}`,
      error
    );
  }
}

function enqueueGroupMessage(
  message: any,
  sourceId: number,
  targetId: number,
  options?: { silent?: boolean; replyTo?: number },
  shouldForward?: boolean
): void {
  const key = getGroupKey(message);
  if (!key) return;
  const existed = groupBuffers.get(key) || {
    messages: [],
    timer: null,
    sourceId,
    targetId,
    options,
    shouldForward: false,
  };
  if (!existed.messages.find((m) => Number(m.id) === Number(message.id))) {
    existed.messages.push(message);
    existed.messages.sort((a, b) => Number(a.id) - Number(b.id));
  }
  if (shouldForward) existed.shouldForward = true;
  if (existed.disposeTimer) {
    void existed.disposeTimer();
    existed.disposeTimer = undefined;
  } else if (existed.timer) {
    clearTimeout(existed.timer);
  }

  const context = tryGetCurrentGenerationContext();
  const callback = async () => {
    groupBuffers.delete(key);
    try {
      throwIfAborted(context?.signal);
      const client = await getGlobalClient();
      throwIfAborted(context?.signal);
      if (existed.shouldForward) {
        const ids = existed.messages.map((m) => Number(m.id));
        await forwardGroupMessages(
          client,
          existed.sourceId,
          existed.targetId,
          ids,
          existed.options
        );
        const first = existed.messages[0];
        if (first)
          updateStats(existed.sourceId, existed.targetId, getMediaType(first));
      } else {
        console.log("[SHIFT] 组未触发类型过滤，跳过转发");
      }
    } catch (e) {
      if (!isAbortError(e)) {
        console.error("[SHIFT] 组转发执行失败", e);
      }
    }
  };

  if (context) {
    existed.timer = context.setTimeout(() => {
      if (existed.disposeTimer) {
        void existed.disposeTimer();
        existed.disposeTimer = undefined;
      }
      const task = context.runTask(callback, { label: "shift-group-forward" });
      task.catch((error) => {
        if (!isAbortError(error)) {
          console.error("[SHIFT] 组转发执行失败", error);
        }
      });
    }, 1200, { label: "shift-group-buffer" });
    existed.disposeTimer = () => clearTimeout(existed.timer!);
  } else {
    existed.timer = setTimeout(() => {
      void callback();
    }, 1200);
  }
  groupBuffers.set(key, existed);
}

async function resolveTarget(
  client: TelegramClient,
  targetInput: string,
  currentChatId: number
): Promise<any> {
  if (
    targetInput.toLowerCase() === "me" ||
    targetInput.toLowerCase() === "here"
  ) {
    return await client.getEntity(currentChatId);
  }

  try {
    const numericId = parseInt(targetInput);
    if (!isNaN(numericId)) {
      return await client.getEntity(numericId);
    }
  } catch (error) {
    // Fall through to username
  }

  return await client.getEntity(targetInput);
}

async function isCircularForward(
  sourceId: number,
  targetId: number
): Promise<{ isCircular: boolean; message: string }> {
  if (sourceId === targetId) {
    return { isCircular: true, message: "不能设置自己到自己的转发规则" };
  }

  const visited = new Set([sourceId]);
  let currentId = targetId;

  for (let i = 0; i < 20; i++) {
    if (visited.has(currentId)) {
      return { isCircular: true, message: `检测到间接循环：${currentId}` };
    }

    const rule = await getShiftRule(currentId);
    if (!rule) break;

    const nextId = rule.target_id;
    if (nextId === -1) break;

    visited.add(currentId);
    currentId = nextId;
  }

  return { isCircular: false, message: "" };
}

// Help text
const HELP_TEXT = `🚀 <b>转发规则管理插件</b>

<b>📝 基础命令</b>
• <code>${mainPrefix}shift set &lt;源&gt; &lt;目标&gt; [选项]</code> - 设置转发规则
• <code>${mainPrefix}shift list</code> - 查看所有规则  
• <code>${mainPrefix}shift del &lt;序号&gt;</code> - 删除规则
• <code>${mainPrefix}shift pause &lt;序号&gt;</code> - 暂停规则
• <code>${mainPrefix}shift resume &lt;序号&gt;</code> - 恢复规则
• <code>${mainPrefix}shift stats</code> - 查看转发统计

<b>🔍 过滤命令（黑名单模式）</b>
• <code>${mainPrefix}shift filter &lt;序号&gt; add &lt;关键词&gt;</code> - 添加过滤词
• <code>${mainPrefix}shift filter &lt;序号&gt; del &lt;关键词&gt;</code> - 删除过滤词  
• <code>${mainPrefix}shift filter &lt;序号&gt; list</code> - 查看过滤词

<b>✅ 白名单命令（白名单模式）</b>
• <code>${mainPrefix}shift whitelist &lt;序号&gt; enable</code> - 启用白名单模式
• <code>${mainPrefix}shift whitelist &lt;序号&gt; disable</code> - 禁用白名单模式
• <code>${mainPrefix}shift whitelist &lt;序号&gt; add &lt;正则&gt;</code> - 添加白名单正则
• <code>${mainPrefix}shift whitelist &lt;序号&gt; del &lt;正则&gt;</code> - 删除白名单正则
• <code>${mainPrefix}shift whitelist &lt;序号&gt; list</code> - 查看白名单正则

<b>💾 数据管理</b>
• <code>${mainPrefix}shift migrate</code> - 迁移到lowdb数据库
• <code>${mainPrefix}shift export</code> - 导出规则配置(Base64编码)
• <code>${mainPrefix}shift import</code> - 导入规则配置(覆盖模式)
• <code>${mainPrefix}shift clean</code> - 清理损坏的规则数据

<b>🔄 备份功能</b>
• <code>${mainPrefix}shift backup &lt;源&gt; &lt;目标&gt;</code> - 创建备份任务（默认倒序：新→旧）
• <code>${mainPrefix}shift backup &lt;源&gt; &lt;目标&gt; --asc</code> - 正序备份（旧→新，保持原始顺序）
• <code>${mainPrefix}shift backup status &lt;任务ID&gt;</code> - 查看备份进度
• <code>${mainPrefix}shift backup resume &lt;任务ID&gt;</code> - 恢复中断的备份

<b>🎯 支持的消息类型</b>

📝 <b>消息类型选项：</b>
<code>text</code>, <code>photo</code>, <code>document</code>, <code>video</code>, <code>sticker</code>, <code>animation</code>, <code>voice</code>, <code>audio</code>, <code>all</code>

⚙️ <b>其他选项：</b>
<code>silent</code> - 静音转发
<code>handle_edited</code> - 监听编辑的消息

📋 <b>状态说明：</b>
• 当没有规则时，系统显示"🚫 暂无转发规则"
• 使用 <code>${mainPrefix}shift set</code> 命令创建首个规则

💡 <b>示例：</b>
• <code>${mainPrefix}shift set @channel1 @channel2 silent handle_edited photo</code>
• <code>${mainPrefix}shift set @channel1 @channel2|TopicID</code>
• <code>${mainPrefix}shift del 1</code>
• <code>${mainPrefix}shift filter 1 add 广告</code>
• <code>${mainPrefix}shift backup @oldchat @newchat</code>
• <code>${mainPrefix}shift backup @oldchat @newchat --asc</code>`;
// 规范：提供 help_text 常量并在 description 中引用
const help_text = HELP_TEXT;

// ==================== 自适应限流器 ====================
class AdaptiveRateLimiter {
  private baseDelay = 500;
  private currentDelay = 500;
  private minDelay = 100;
  private maxDelay = 5000;

  async throttle(signal?: AbortSignal): Promise<void> {
    await abortableSleep(this.currentDelay, signal);
  }

  onSuccess(): void {
    // 成功时逐步减少延迟
    this.currentDelay = Math.max(this.minDelay, this.currentDelay * 0.95);
  }

  onFloodWait(seconds: number): void {
    // 遇到限流时增加延迟
    this.currentDelay = Math.min(this.maxDelay, seconds * 1000 * 1.2);
  }

  reset(): void {
    this.currentDelay = this.baseDelay;
  }
}

type BackupCallbacks = {
  batchSize?: number;
  delayMs?: number;
  reverse?: boolean; // true = 正序（旧→新），false/undefined = 倒序（新→旧，默认）
  onProgress?: (current: number, total: number) => void | Promise<void>;
  onComplete?: (stats: {
    totalMessages: number;
    processedMessages: number;
    failedMessages: number;
  }) => void | Promise<void>;
};

interface OwnedBackupTask {
  task: BackupTask;
}

// ==================== Backup 管理器 ====================
class BackupManager {
  private static tasks = new Map<string, OwnedBackupTask>();
  private static completedTaskIds: string[] = [];
  private static rateLimiter = new AdaptiveRateLimiter();
  private static readonly maxRetainedCompletedTasks = 25;

  static async startBackup(
    sourceId: number,
    targetId: number,
    options: BackupCallbacks = {}
  ): Promise<string> {
    const context = tryGetCurrentGenerationContext();
    const taskId = `backup_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`;
    const task: BackupTask = {
      sourceId,
      targetId,
      startedAt: new Date().toISOString(),
      status: "running",
      totalMessages: 0,
      processedMessages: 0,
      failedMessages: 0,
      reverse: options.reverse || false,
    };

    this.tasks.set(taskId, { task });

    const execute = async (signal?: AbortSignal) => {
      try {
        await this.executeBackup(taskId, options, signal);
      } catch (error) {
        if (!isAbortError(error)) {
          console.error(`[SHIFT] 备份任务 ${taskId} 失败:`, error);
          task.status = "failed";
        }
      } finally {
        this.pruneTask(taskId);
      }
    };

    if (context) {
      const backupPromise = context.runTask(
        (signal) => execute(signal),
        { label: `shift-backup:${taskId}` }
      );
      backupPromise.catch(() => undefined);
    } else {
      await execute();
    }

    return taskId;
  }

  private static async executeBackup(
    taskId: string,
    options: BackupCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const ownedTask = this.tasks.get(taskId);
    const task = ownedTask?.task;
    if (!task) return;

    const client = await getGlobalClient();
    const batchSize = options.batchSize || 50;

    try {
      throwIfAborted(signal);
      // 获取消息总数
      const messages = await safeGetMessages(client, task.sourceId, { limit: 1 });
      const totalCount = (messages as any).total || 0;
      task.totalMessages = totalCount;

      if (task.reverse) {
        // ===== 正序模式：两阶段 =====
        // Phase 1: 收集所有消息 ID（API 返回顺序：新→旧）
        const allIds: number[] = [];
        let collectOffset = 0;
        let collecting = true;

        while (collecting) {
          throwIfAborted(signal);
          const batch = await safeGetMessages(client, task.sourceId, {
            limit: batchSize,
            offsetId: collectOffset,
          });

          if (batch.length === 0) {
            collecting = false;
            break;
          }

          for (const msg of batch) {
            allIds.push(msg.id);
          }
          collectOffset = batch[batch.length - 1].id;

          // 收集阶段进度（每 200 条报告一次）
          if (options.onProgress && allIds.length % 200 === 0) {
            await options.onProgress(0, totalCount);
          }
        }

        // 反转：旧→新（正序）
        allIds.reverse();
        task.totalMessages = allIds.length;

        // Phase 2: 按正序逐条转发
        const startIndex = task.lastMessageId
          ? allIds.indexOf(task.lastMessageId) + 1
          : 0;

        for (let i = startIndex; i < allIds.length; i++) {
          if (task.status !== "running") break;

          try {
            throwIfAborted(signal);
            await this.rateLimiter.throttle(signal);
            throwIfAborted(signal);

            await client.forwardMessages(task.targetId, {
              messages: [allIds[i]],
              fromPeer: task.sourceId,
            });

            task.processedMessages++;
            task.lastMessageId = allIds[i];

            if (options.onProgress && task.processedMessages % 10 === 0) {
              await options.onProgress(task.processedMessages, task.totalMessages);
            }

            this.rateLimiter.onSuccess();
          } catch (error: unknown) {
            if (isAbortError(error)) {
              task.status = "failed";
              return;
            }
            task.failedMessages++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes("FLOOD_WAIT")) {
              const waitTime = parseInt(errorMessage.match(/\d+/)?.[0] || "60");
              this.rateLimiter.onFloodWait(waitTime);
              await abortableSleep(waitTime * 1000, signal);
            }
          }
        }
      } else {
        // ===== 倒序模式（默认）：流式处理 =====
        let hasMore = true;
        let offsetId = task.lastMessageId || 0;

        while (hasMore && task.status === "running") {
          throwIfAborted(signal);
          const batch = await safeGetMessages(client, task.sourceId, {
            limit: batchSize,
            offsetId,
          });

          if (batch.length === 0) {
            hasMore = false;
            break;
          }

          for (const message of batch) {
            if (task.status !== "running") {
              break;
            }

            try {
              throwIfAborted(signal);
              // 限流控制
              await this.rateLimiter.throttle(signal);
              throwIfAborted(signal);

              // 转发消息
              await client.forwardMessages(task.targetId, {
                messages: [message.id],
                fromPeer: task.sourceId,
              });

              task.processedMessages++;
              task.lastMessageId = message.id;
              offsetId = message.id;

              // 进度回调
              if (options.onProgress && task.processedMessages % 10 === 0) {
                await options.onProgress(task.processedMessages, task.totalMessages);
              }

              // 成功后调整限流
              this.rateLimiter.onSuccess();
            } catch (error: unknown) {
              if (isAbortError(error)) {
                task.status = "failed";
                return;
              }

              task.failedMessages++;

              const errorMessage = error instanceof Error ? error.message : String(error);
              // 处理限流错误
              if (errorMessage.includes("FLOOD_WAIT")) {
                const waitTime = parseInt(
                  errorMessage.match(/\d+/)?.[0] || "60"
                );
                this.rateLimiter.onFloodWait(waitTime);
                await abortableSleep(waitTime * 1000, signal);
              }
            }
          }

          if (task.status !== "running") {
            break;
          }
        }
      }

      if (task.status !== "running") {
        return;
      }

      // 完成备份
      task.status = "completed";
      task.completedAt = new Date().toISOString();

      // 保存任务状态到 lowdb
      if (useLowdb && lowdb) {
        lowdb.data.backups[taskId] = task;
        await lowdb.write();
      }

      // 完成回调
      if (options.onComplete) {
        await options.onComplete({
          totalMessages: task.totalMessages,
          processedMessages: task.processedMessages,
          failedMessages: task.failedMessages,
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        task.status = "failed";
        return;
      }
      task.status = "failed";
      throw error;
    }
  }

  static async resumeBackup(taskId: string): Promise<void> {
    // 从 lowdb 恢复任务
    if (useLowdb && lowdb) {
      const savedTask = lowdb.data.backups[taskId];
      if (savedTask && savedTask.status !== "completed") {
        const context = tryGetCurrentGenerationContext();
        this.tasks.set(taskId, { task: savedTask });
        savedTask.status = "running";
        const execute = async (signal?: AbortSignal) => {
          try {
            await this.executeBackup(taskId, {}, signal);
          } finally {
            this.pruneTask(taskId);
          }
        };
        if (context) {
          const resumePromise = context.runTask(
            (signal) => execute(signal),
            { label: `shift-backup-resume:${taskId}` }
          );
          resumePromise.catch(() => undefined);
        } else {
          await execute();
        }
      }
    }
  }

  static getBackupStatus(taskId: string): BackupTask | null {
    return this.tasks.get(taskId)?.task || null;
  }

  private static pruneTask(taskId: string): void {
    const ownedTask = this.tasks.get(taskId);
    if (!ownedTask) return;

    if (ownedTask.task.status === "completed" || ownedTask.task.status === "failed") {
      this.completedTaskIds.push(taskId);
    }

    while (this.completedTaskIds.length > this.maxRetainedCompletedTasks) {
      const removeTaskId = this.completedTaskIds.shift();
      if (removeTaskId) {
        const removable = this.tasks.get(removeTaskId);
        if (
          removable?.task.status === "completed" ||
          removable?.task.status === "failed"
        ) {
          this.tasks.delete(removeTaskId);
        }
      }
    }
  }

  static cleanup(): void {
    for (const ownedTask of this.tasks.values()) {
      if (ownedTask.task.status === "running" || ownedTask.task.status === "pending") {
        ownedTask.task.status = "failed";
      }
    }
    this.tasks.clear();
    this.completedTaskIds = [];
    this.rateLimiter.reset();
  }
}

// ==================== 导入导出功能 ====================
async function exportRules(): Promise<string> {
  if (useLowdb && lowdb) {
    return JSON.stringify(lowdb.data.rules, null, 2);
  } else {
    const rules = getAllShiftRules();
    const exportData: { [key: string]: ShiftRule } = {};
    for (const { sourceId, rule } of rules) {
      exportData[String(sourceId)] = rule;
    }
    return JSON.stringify(exportData, null, 2);
  }
}

async function importRules(jsonData: string, merge = false): Promise<void> {
  // 兼容历史错误导出：若解析结果为字符串，则再次解析
  let parsed: any = JSON.parse(jsonData);
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {}
  }
  const newRules = parsed as { [key: string]: ShiftRule };

  if (useLowdb && lowdb) {
    if (merge) {
      Object.assign(lowdb.data.rules, newRules);
    } else {
      lowdb.data.rules = newRules;
    }
    await lowdb.write();
    ruleCache.clear();
  } else {
    // SQLite 模式下逐条导入
    for (const [sourceId, rule] of Object.entries(
      newRules as { [key: string]: ShiftRule }
    )) {
      if (!merge) {
        // 如果不是合并模式，先删除现有规则
        deleteShiftRule(Number(sourceId));
      }
      saveShiftRule(Number(sourceId), rule);
    }
  }
}
// Message listener handler for the plugin system
async function shiftMessageListener(
  message: any,
  options?: { isEdited?: boolean }
): Promise<void> {
  await handleIncomingMessage(message, options?.isEdited);
}
class ShiftPlugin extends Plugin {
  cleanup(): void {
    cleanupGroupBuffers();
    BackupManager.cleanup();
    ruleCache.clear();
    if (sqliteDb) {
      sqliteDb.close();
      sqliteDb = null;
    }
    if (lowdb?.write) {
      void lowdb.write().catch(() => {});
    }
    lowdb = null;
  }

  description: string = `智能转发助手 - 自动转发消息到指定目标\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    shift: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({
          text: "❌ <b>客户端未初始化</b>",
          parseMode: "html",
        });
        return;
      }

      // 标准参数解析模式
      const lines = msg.message?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      // 无参数时显示帮助
      if (!sub) {
        await msg.edit({
          text: HELP_TEXT,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      // 处理 help 命令
      if (sub === "help" || sub === "h") {
        await msg.edit({
          text: HELP_TEXT,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      try {
        // Migrate command - 迁移到 lowdb
        if (sub === "migrate") {
          if (await migrateToLowdb()) {
            await msg.edit({
              text: `✅ <b>成功迁移到 lowdb 数据库</b>\n\n性能提升，功能增强！`,
              parseMode: "html",
            });
          } else {
            await msg.edit({
              text: `❌ <b>迁移失败或无需迁移</b>`,
              parseMode: "html",
            });
          }
          return;
        }

        // Export command - 导出规则
        if (sub === "export") {
          const rules = await exportRules();
          const rulesJson = rules; // exportRules 已返回 JSON 字符串，避免二次 stringify
          const base64Data = Buffer.from(rulesJson, "utf-8").toString("base64");
          await msg.edit({
            text: `📤 <b>导出的规则配置：</b>\n\n<code>${htmlEscape(base64Data)}</code>\n\n💡 复制上述 Base64 编码数据用于导入`,
            parseMode: "html",
          });
          return;
        }

        // Clean command - 清理损坏规则
        if (sub === "clean") {
          let cleanedCount = 0;
          if (useLowdb && lowdb) {
            const validRules: { [key: string]: ShiftRule } = {};
            for (const [sourceId, rule] of Object.entries(lowdb.data.rules)) {
              try {
                if (
                  rule &&
                  typeof rule === "object" &&
                  (rule as any).target_id
                ) {
                  validRules[sourceId] = rule as ShiftRule;
                } else {
                  cleanedCount++;
                }
              } catch {
                cleanedCount++;
              }
            }
            lowdb.data.rules = validRules;
            await lowdb.write();
          }

          await msg.edit({
            text: `✅ <b>清理完成</b>\n\n已清理 ${cleanedCount} 个损坏规则`,
            parseMode: "html",
          });
          return;
        }

        // Import command - 导入规则
        if (sub === "import") {
          const inputData = lines.slice(1).join("\n").trim();
          if (!inputData) {
            await msg.edit({
              text: `❌ <b>请在第二行提供数据</b>\n\n<b>用法：</b>\n<code>${mainPrefix}shift import\n[Base64编码数据]</code>`,
              parseMode: "html",
            });
            return;
          }

          try {
            let jsonData: string;

            // 尝试Base64解码
            try {
              jsonData = Buffer.from(inputData, "base64").toString("utf-8");
              // 验证是否为有效JSON
              JSON.parse(jsonData);
            } catch {
              // 如果Base64解码失败，尝试直接作为JSON处理
              jsonData = inputData;
            }

            await importRules(jsonData, false);
            await msg.edit({
              text: `✅ <b>成功导入规则配置</b>`,
              parseMode: "html",
            });
          } catch (error: any) {
            await msg.edit({
              text: `❌ <b>导入失败</b>\n\n请检查配置数据格式是否正确`,
              parseMode: "html",
            });
          }
          return;
        }

        // Set command - create forwarding rule
        if (sub === "set" || sub === "s") {
          const params = args.slice(1);
          if (params.length < 1) {
            await msg.edit({
              text: `❌ <b>参数不足</b>\n\n<b>用法：</b>\n<code>${mainPrefix}shift set [源] [目标] [选项...]</code>\n<code>${mainPrefix}shift set [目标] [选项...]</code> - 使用当前对话作为源`,
              parseMode: "html",
            });
            return;
          }

          let sourceInput: string;
          let targetInput: string;
          let options: Set<string>;

          if (params.length === 1) {
            sourceInput = "here";
            targetInput = params[0];
            options = new Set();
          } else {
            sourceInput = params[0];
            targetInput = params[1];
            options = new Set(
              params.slice(2).filter((opt) => AVAILABLE_OPTIONS.has(opt))
            );
          }
          const [realTargetInput, ...rest] =
            targetInput
              ?.split(/\s*[|｜]\s*/g)
              .map((i) => i.trim())
              .filter((i) => i.length > 0) || [];
          targetInput = realTargetInput;
          const replyTo = rest?.[0];
          if (replyTo) {
            options.add(`replyTo:${replyTo}`);
          }

          // Resolve source
          let source: any;
          try {
            if (
              sourceInput.toLowerCase() === "here" ||
              sourceInput.toLowerCase() === "me"
            ) {
              const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
              source = await client.getEntity(chatId);
            } else {
              const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
              source = await resolveTarget(client, sourceInput, chatId);
            }
          } catch (error: any) {
            await msg.edit({
              text: `❌ <b>源对话无效</b>\n\n请检查频道/群组ID或用户名格式`,
              parseMode: "html",
            });
            return;
          }

          // Resolve target
          let target: any;
          try {
            const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
            target = await resolveTarget(client, targetInput, chatId);
          } catch (error: any) {
            await msg.edit({
              text: `❌ <b>目标对话无效</b>\n\n请检查频道/群组ID或用户名格式`,
              parseMode: "html",
            });
            return;
          }

          const sourceId = normalizeChatId(source);
          const targetId = normalizeChatId(target);

          // Check for circular forwarding
          const { isCircular, message: circularMsg } = await isCircularForward(
            sourceId,
            targetId
          );
          if (isCircular) {
            await msg.edit({
              text: `❌ <b>循环转发检测</b>\n\n${htmlEscape(circularMsg)}`,
              parseMode: "html",
            });
            return;
          }

          let sourceDisplay: string | undefined;
          let targetDisplay: string | undefined;

          if (useLowdb) {
            try {
              const [formattedSource, formattedTarget] = await Promise.all([
                formatEntity(source),
                formatEntity(target),
              ]);
              sourceDisplay = formattedSource.display;
              targetDisplay = formattedTarget.display;
            } catch (error) {
              console.warn("[SHIFT] 无法格式化实体显示名称:", error);
            }
          }

          const rule: ShiftRule = {
            target_id: targetId,
            options: Array.from(options),
            target_type: source.className === "User" ? "user" : "chat",
            paused: false,
            created_at: new Date().toISOString(),
            filters: [],
          };

          if (useLowdb) {
            rule.source_display =
              sourceDisplay || htmlEscape(getDisplayName(source));
            rule.target_display =
              targetDisplay || htmlEscape(getDisplayName(target));
          }

          if (saveShiftRule(sourceId, rule)) {
            await msg.edit({
              text: `成功设置转发: ${
                sourceDisplay || htmlEscape(getDisplayName(source))
              } -> ${targetDisplay || htmlEscape(getDisplayName(target))}`,
              parseMode: "html",
            });
          } else {
            await msg.edit({
              text: "❌ <b>保存转发规则失败</b>",
              parseMode: "html",
            });
          }
          return;
        }

        // List command
        if (sub === "list" || sub === "ls") {
          const allRules = getAllShiftRules();
          if (allRules.length === 0) {
            await msg.edit({
              text: `🚫 <b>暂无转发规则</b>\n\n💡 使用 <code>${mainPrefix}shift set</code> 命令创建新的转发规则`,
              parseMode: "html",
            });
            return;
          }

          let output = `✨ 智能转发规则管理\n━━━━━━━━━━━━━━━━━━━━━━\n`;

          for (let i = 0; i < allRules.length; i++) {
            const { sourceId, rule } = allRules[i];
            const status = rule.paused ? "⏸️ 已暂停" : "▶️ 运行中";
            let handle_edited;
            try {
              if (!msg.client) continue;
              let replyTo = undefined;
              const options = [];
              if (rule.options && rule.options.length > 0) {
                for (const option of rule.options) {
                  if (option.startsWith("replyTo:")) {
                    const replyToStr = option.replace("replyTo:", "").trim();
                    const replyToNum = parseInt(replyToStr);
                    if (!isNaN(replyToNum)) {
                      replyTo = replyToNum;
                    }
                  } else if (option === "handle_edited") {
                    handle_edited = true;
                  } else {
                    options.push(option);
                  }
                }
              }

              let sourceDisplayHtml: string;
              let targetDisplayHtml: string;

              if (useLowdb && rule.source_display && rule.target_display) {
                sourceDisplayHtml = rule.source_display;
                targetDisplayHtml = rule.target_display;
              } else {
                const sourceEntity = await msg.client.getEntity(
                  Number(sourceId)
                );
                const targetEntity = await msg.client.getEntity(
                  Number(rule.target_id)
                );
                sourceDisplayHtml = htmlEscape(getDisplayName(sourceEntity));
                targetDisplayHtml = htmlEscape(getDisplayName(targetEntity));
              }

              output += `${i + 1}. ${status}\n`;
              output += `   📤 源: ${sourceDisplayHtml}\n`;
              output += `   📥 目标: ${targetDisplayHtml}\n`;
              if (replyTo) {
                output += `   📬 回复: ${replyTo}\n`;
              }
              if (handle_edited) {
                output += `   ✏️ 监听编辑的消息\n`;
              }
              output += `   🎯 类型: ${options.join(", ") || "all"}\n`;
              if (rule.whitelistMode) {
                output += `   ✅ 白名单: ${rule.whitelistPatterns?.length || 0} 个正则\n`;
              } else {
                output += `   🛡️ 过滤: ${rule.filters.length} 个关键词\n`;
              }
              output += "\n";
            } catch (error) {
              output += `${i + 1}. ⚠️ 规则损坏 (${sourceId})\n\n`;
            }
          }

          await msg.edit({ text: output, parseMode: "html" });
          return;
        }

        // Delete command
        if (sub === "del" || sub === "delete" || sub === "d") {
          if (args.length < 2) {
            await msg.edit({ text: "请提供序号" });
            return;
          }

          const allRules = getAllShiftRules();
          const { indices } = parseIndices(args[1], allRules.length);

          let deletedCount = 0;
          for (const index of indices.sort((a, b) => b - a)) {
            const { sourceId } = allRules[index];
            if (deleteShiftRule(sourceId)) {
              deletedCount++;
            }
          }

          await msg.edit({
            text: `✅ <b>成功删除 ${deletedCount} 条规则</b>`,
            parseMode: "html",
          });
          return;
        }

        // Pause/Resume commands
        if (sub === "pause" || sub === "resume") {
          if (args.length < 2) {
            await msg.edit({
              text: `❌ <b>参数不足</b>\n\n<b>用法：</b> <code>${mainPrefix}shift ${sub} [序号]</code>`,
              parseMode: "html",
            });
            return;
          }

          const allRules = getAllShiftRules();
          const { indices } = parseIndices(args[1], allRules.length);
          const pause = sub === "pause";

          let count = 0;
          for (const index of indices) {
            const { sourceId, rule } = allRules[index];
            rule.paused = pause;
            if (saveShiftRule(sourceId, rule)) {
              count++;
            }
          }

          const actionLabel = htmlEscape(sub);
          await msg.edit({
            text: `✅ <b>成功${actionLabel} ${count} 条规则</b>`,
            parseMode: "html",
          });
          return;
        }

        // Stats command
        if (sub === "stats") {
          try {
            let rows: any[] = [];

            if (useLowdb && lowdb) {
              // 从 lowdb 读取统计
              const stats = lowdb.data.stats;
              for (const [date, sources] of Object.entries(stats)) {
                for (const [sourceId, data] of Object.entries(sources as any)) {
                  rows.push({
                    stats_key: `shift.stats.${sourceId}.${date}`,
                    stats_data: JSON.stringify(data),
                  });
                }
              }
            } else if (sqliteDb) {
              // 从 SQLite 读取
              const stmt = sqliteDb.prepare("SELECT * FROM shift_stats");
              rows = stmt.all() as any[];
            }

            if (rows.length === 0) {
              await msg.edit({
                text: "📊 <b>暂无转发统计数据</b>",
                parseMode: "html",
              });
              return;
            }

            const channelStats: {
              [key: number]: {
                total: number;
                dates: { [key: string]: number };
              };
            } = {};

            for (const row of rows) {
              try {
                const parts = row.stats_key.split(".");
                const sourceId = parseInt(parts[2]);
                const date = parts[3];

                if (!channelStats[sourceId]) {
                  channelStats[sourceId] = { total: 0, dates: {} };
                }

                const dailyStats = JSON.parse(row.stats_data);
                const dailyTotal = dailyStats.total || 0;
                channelStats[sourceId].total += dailyTotal;
                channelStats[sourceId].dates[date] = dailyTotal;
              } catch (error) {
                continue;
              }
            }

            let output = "📊 转发统计报告\n\n";
            for (const [sourceId, stats] of Object.entries(channelStats)) {
              try {
                if (!msg.client) continue;
                const sourceEntity = await msg.client.getEntity(
                  parseInt(sourceId)
                );
                output += `📤 源: ${htmlEscape(
                  getDisplayName(sourceEntity)
                )}\n`;
                output += `📈 总转发: ${stats.total} 条\n`;

                const recentDates = Object.keys(stats.dates)
                  .sort()
                  .reverse()
                  .slice(0, 7);
                if (recentDates.length > 0) {
                  output += "📅 最近7天:\n";
                  for (const date of recentDates) {
                    output += `  - ${date}: ${stats.dates[date]} 条\n`;
                  }
                }
                output += "\n";
              } catch (error) {
                output += `📤 源: ID ${htmlEscape(
                  String(sourceId)
                )}\n📈 总转发: ${stats.total} 条\n\n`;
              }
            }

            await msg.edit({ text: output, parseMode: "html" });
          } catch (error: any) {
            await msg.edit({
              text: `❌ <b>获取统计数据失败</b>\n\n请稍后重试或联系管理员`,
              parseMode: "html",
            });
          }
          return;
        }

        // Filter command
        if (sub === "filter" || sub === "f") {
          if (args.length < 3) {
            await msg.edit({
              text: `❌ <b>参数不足</b>\n\n<b>用法：</b>\n<code>${mainPrefix}shift filter [序号] add/del/list [关键词...]</code>`,
              parseMode: "html",
            });
            return;
          }

          const indicesStr = args[1];
          const action = args[2];
          const keywords = args.slice(3);

          const allRules = getAllShiftRules();
          const { indices } = parseIndices(indicesStr, allRules.length);

          if (indices.length === 0) {
            await msg.edit({
              text: `❌ <b>无效的序号: ${htmlEscape(indicesStr)}</b>`,
              parseMode: "html",
            });
            return;
          }

          let updatedCount = 0;
          for (const index of indices) {
            const { sourceId, rule } = allRules[index];
            const filters = new Set(rule.filters);

            if (action === "add") {
              keywords.forEach((keyword) => filters.add(keyword));
              rule.filters = Array.from(filters);
              if (saveShiftRule(sourceId, rule)) {
                updatedCount++;
              }
            } else if (action === "del") {
              keywords.forEach((keyword) => filters.delete(keyword));
              rule.filters = Array.from(filters);
              if (saveShiftRule(sourceId, rule)) {
                updatedCount++;
              }
            } else if (action === "list") {
              const filterList =
                rule.filters.length > 0 ? rule.filters : ["无过滤词"];
              await msg.edit({
                text: `规则 ${index + 1} 的过滤词：\n${filterList
                  .map((f) => `• ${htmlEscape(String(f))}`)
                  .join("\n")}`,
                parseMode: "html",
              });
              return;
            } else {
              await msg.edit({
                text: `无效的操作: ${htmlEscape(
                  String(action)
                )}，支持: add, del, list`,
                parseMode: "html",
              });
              return;
            }
          }

          if (action === "add" || action === "del") {
            await msg.edit({
              text: `✅ <b>已为 ${updatedCount} 条规则更新过滤词</b>`,
              parseMode: "html",
            });
          }
          return;
        }

        if (sub === "whitelist" || sub === "wl") {
          if (args.length < 3) {
            await msg.edit({
              text: `❌ <b>参数不足</b>\n\n<b>用法：</b>\n<code>${mainPrefix}shift whitelist [序号] enable/disable/add/del/list [正则...]</code>`,
              parseMode: "html",
            });
            return;
          }

          const indicesStr = args[1];
          const action = args[2];
          const patterns = args.slice(3);

          const allRules = getAllShiftRules();
          const { indices } = parseIndices(indicesStr, allRules.length);

          if (indices.length === 0) {
            await msg.edit({
              text: `❌ <b>无效的序号: ${htmlEscape(indicesStr)}</b>`,
              parseMode: "html",
            });
            return;
          }

          let updatedCount = 0;
          for (const index of indices) {
            const { sourceId, rule } = allRules[index];

            if (action === "enable") {
              rule.whitelistMode = true;
              if (!rule.whitelistPatterns) {
                rule.whitelistPatterns = [];
              }
              if (saveShiftRule(sourceId, rule)) {
                updatedCount++;
              }
            } else if (action === "disable") {
              rule.whitelistMode = false;
              if (saveShiftRule(sourceId, rule)) {
                updatedCount++;
              }
            } else if (action === "add") {
              if (!rule.whitelistPatterns) {
                rule.whitelistPatterns = [];
              }
              const whitelistSet = new Set(rule.whitelistPatterns);
              patterns.forEach((pattern) => whitelistSet.add(pattern));
              rule.whitelistPatterns = Array.from(whitelistSet);
              if (saveShiftRule(sourceId, rule)) {
                updatedCount++;
              }
            } else if (action === "del") {
              if (rule.whitelistPatterns) {
                const whitelistSet = new Set(rule.whitelistPatterns);
                patterns.forEach((pattern) => whitelistSet.delete(pattern));
                rule.whitelistPatterns = Array.from(whitelistSet);
                if (saveShiftRule(sourceId, rule)) {
                  updatedCount++;
                }
              }
            } else if (action === "list") {
              const mode = rule.whitelistMode ? "✅ 已启用" : "❌ 已禁用";
              const patternList =
                rule.whitelistPatterns && rule.whitelistPatterns.length > 0
                  ? rule.whitelistPatterns
                  : ["无白名单正则"];
              await msg.edit({
                text: `规则 ${index + 1} 的白名单配置：\n\n模式: ${mode}\n\n正则列表：\n${patternList
                  .map((p) => `• <code>${htmlEscape(String(p))}</code>`)
                  .join("\n")}`,
                parseMode: "html",
              });
              return;
            } else {
              await msg.edit({
                text: `无效的操作: ${htmlEscape(
                  String(action)
                )}，支持: enable, disable, add, del, list`,
                parseMode: "html",
              });
              return;
            }
          }

          if (action === "enable") {
            await msg.edit({
              text: `✅ <b>已为 ${updatedCount} 条规则启用白名单模式</b>`,
              parseMode: "html",
            });
          } else if (action === "disable") {
            await msg.edit({
              text: `✅ <b>已为 ${updatedCount} 条规则禁用白名单模式</b>`,
              parseMode: "html",
            });
          } else if (action === "add" || action === "del") {
            await msg.edit({
              text: `✅ <b>已为 ${updatedCount} 条规则更新白名单正则</b>`,
              parseMode: "html",
            });
          }
          return;
        }

        // Backup command - 增强版备份功能
        if (sub === "backup") {
          const action = args[1];

          // 查看备份状态
          if (action === "status") {
            const taskId = args[2];
            if (!taskId) {
              await msg.edit({
                text: `❌ <b>请提供任务ID</b>`,
                parseMode: "html",
              });
              return;
            }

            const task = BackupManager.getBackupStatus(taskId);
            if (!task) {
              await msg.edit({
                text: `❌ <b>未找到任务: ${htmlEscape(taskId)}</b>`,
                parseMode: "html",
              });
              return;
            }

            const progress =
              task.totalMessages > 0
                ? Math.round(
                    (task.processedMessages / task.totalMessages) * 100
                  )
                : 0;

            await msg.edit({
              text:
                `📊 <b>备份任务状态</b>\n\n` +
                `任务ID: <code>${taskId}</code>\n` +
                `状态: ${task.status}\n` +
                `进度: ${progress}% (${task.processedMessages}/${task.totalMessages})\n` +
                `失败: ${task.failedMessages} 条\n` +
                `开始时间: ${task.startedAt}`,
              parseMode: "html",
            });
            return;
          }

          // 恢复备份任务
          if (action === "resume") {
            const taskId = args[2];
            if (!taskId) {
              await msg.edit({
                text: `❌ <b>请提供任务ID</b>`,
                parseMode: "html",
              });
              return;
            }

            await BackupManager.resumeBackup(taskId);
            await msg.edit({
              text: `✅ <b>已恢复备份任务: ${htmlEscape(taskId)}</b>`,
              parseMode: "html",
            });
            return;
          }

          // 开始新备份
          // 解析 --asc 参数（正序：旧→新）
          const hasAsc = args.some((a: string) => a === "--asc");
          const filteredArgs = args.filter((a: string) => a !== "--asc");

          if (filteredArgs.length < 3) {
            await msg.edit({
              text: `❌ <b>参数不足</b>\n\n<b>用法：</b> <code>${mainPrefix}shift backup [源] [目标] [--asc]</code>\n\n<b>--asc</b>：正序备份（旧→新），默认为倒序（新→旧）`,
              parseMode: "html",
            });
            return;
          }

          const sourceInput = filteredArgs[1];
          const targetInput = filteredArgs[2];

          let source: any;
          let target: any;

          try {
            if (!msg.client) {
              await msg.edit({ text: "客户端未初始化" });
              return;
            }
            const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
            source = await resolveTarget(msg.client, sourceInput, chatId);
            target = await resolveTarget(msg.client, targetInput, chatId);
          } catch (error: any) {
            await msg.edit({
              text: `❌ <b>解析对话失败</b>\n\n请检查频道/群组ID格式是否正确`,
              parseMode: "html",
            });
            return;
          }

          // 使用新的 BackupManager
          const orderLabel = hasAsc ? "正序（旧→新）" : "倒序（新→旧）";
          const progressMsg = await msg.edit({
            text: `🔄 <b>开始备份</b>（${orderLabel}）\n\n从 ${htmlEscape(
              getDisplayName(source)
            )} 到 ${htmlEscape(getDisplayName(target))} 的历史消息...`,
            parseMode: "html",
          });

          const sourceId = normalizeChatId(source);
          const targetId = normalizeChatId(target);

          // 启动备份任务
          const taskId = await BackupManager.startBackup(sourceId, targetId, {
            batchSize: 50,
            delayMs: 500,
            reverse: hasAsc,
            onProgress: async (current, total) => {
              if (current % 50 === 0 && progressMsg) {
                await progressMsg.edit({
                  text:
                    `🔄 <b>备份进行中...</b>\n\n` +
                    `进度: ${Math.round(
                      (current / total) * 100
                    )}% (${current}/${total})`,
                  parseMode: "html",
                });
              }
            },
            onComplete: async (stats) => {
              if (progressMsg) {
                await progressMsg.edit({
                  text:
                    `✅ <b>备份完成！</b>\n\n` +
                    `共处理 ${stats.processedMessages} 条消息，失败 ${stats.failedMessages} 条\n` +
                    `任务ID: <code>${taskId}</code>`,
                  parseMode: "html",
                });
              }
            },
          });

          if (progressMsg) {
            await progressMsg.edit({
              text: `✅ <b>备份任务已启动</b>\n\n任务ID: <code>${taskId}</code>\n使用 <code>${mainPrefix}shift backup status ${taskId}</code> 查看进度`,
              parseMode: "html",
            });
          }
          return;
        }
      } catch (error: any) {
        console.error("[SHIFT] 命令执行失败:", error);
        await msg.edit({
          text: `❌ <b>命令执行失败</b>\n\n请检查命令格式或稍后重试`,
          parseMode: "html",
        });
      }
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "shift",
    title: "排班",
    description: "排班管理配置",
    category: "插件配置",
    icon: "📋",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "timezone",
            "label": "时区",
            "type": "string",
            "default": "Asia/Shanghai"
      },
      {
            "key": "reminderTime",
            "label": "提醒时间",
            "type": "string",
            "default": "09:00"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("shift"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("shift"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
  listenMessageHandlerIgnoreEdited: boolean = false;
  listenMessageHandler?:
    | ((msg: Api.Message, options?: { isEdited?: boolean }) => Promise<void>)
    | undefined = shiftMessageListener;
}

// Update stats function
function updateStats(
  sourceId: number,
  targetId: number,
  messageType: string
): void {
  try {
    const today = new Date().toISOString().split("T")[0];
    const statsKey = `shift.stats.${sourceId}.${today}`;

    if (useLowdb && lowdb) {
      // 更新 lowdb 统计
      if (!lowdb.data.stats[today]) {
        lowdb.data.stats[today] = {};
      }
      if (!lowdb.data.stats[today][String(sourceId)]) {
        lowdb.data.stats[today][String(sourceId)] = { total: 0 };
      }

      const stats = lowdb.data.stats[today][String(sourceId)];
      stats.total = (stats.total || 0) + 1;
      stats[messageType] = (stats[messageType] || 0) + 1;

      // 批量写入优化
      if (stats.total % 10 === 0) {
        lowdb.write();
      }
    } else if (sqliteDb) {
      // 更新 SQLite 统计
      const stmt = sqliteDb.prepare(
        "SELECT stats_data FROM shift_stats WHERE stats_key = ?"
      );
      const row = stmt.get(statsKey) as any;

      let stats: any = { total: 0 };
      if (row) {
        stats = JSON.parse(row.stats_data);
      }

      stats.total = (stats.total || 0) + 1;
      stats[messageType] = (stats[messageType] || 0) + 1;

      const saveStmt = sqliteDb.prepare(`
        INSERT OR REPLACE INTO shift_stats (stats_key, stats_data)
        VALUES (?, ?)
      `);

      saveStmt.run(statsKey, JSON.stringify(stats));
    }
  } catch (error) {
    console.error(`[SHIFT] Error updating stats:`, error);
  }
}

// Check if message is filtered
async function isMessageFiltered(
  message: any,
  sourceId: number
): Promise<boolean> {
  const rule = await getShiftRule(sourceId);
  if (!rule) return false;

  if (rule.whitelistMode) {
    if (!rule.whitelistPatterns || rule.whitelistPatterns.length === 0) {
      return true;
    }
    if (!message.text) return true;
    const text = message.text;
    return !rule.whitelistPatterns.some((pattern) => {
      try {
        const regex = new RegExp(pattern, "i");
        return regex.test(text);
      } catch (e) {
        console.error(`[SHIFT] 无效的正则表达式: ${pattern}`, e);
        return false;
      }
    });
  }

  const keywords = rule.filters;
  if (!keywords || keywords.length === 0 || !message.text) return false;

  const text = message.text.toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

// Get chat ID from message
function getChatIdFromMessage(message: any, isEdited?: boolean): number | null {
  if (
    isEdited &&
    message.peerId?.channelId &&
    message.fwdFrom?.channelPost &&
    message.fwdFrom?.fromId?.channelId
  ) {
    message.id = message.fwdFrom?.channelPost;
    const channelId =
      message.fwdFrom.fromId.channelId.value ||
      message.fwdFrom.fromId.channelId;
    return ensureChannelId(channelId);
  }
  if (message.chatId) {
    return Number(message.chatId);
  }
  if (message.peerId) {
    if (message.peerId.channelId) {
      return ensureChannelId(message.peerId.channelId);
    } else if (message.peerId.chatId) {
      return -Number(message.peerId.chatId);
    } else if (message.peerId.userId) {
      return Number(message.peerId.userId);
    }
  }

  return null;
}

// Forward message using universal access hash handler
async function shiftForwardMessage(
  client: TelegramClient,
  fromChatId: number,
  toChatId: number,
  messageId: number,
  depth: number = 0,
  options?: any
): Promise<void> {
  if (depth > 5) {
    console.log(`[SHIFT] 转发深度超限: ${depth}`);
    return;
  }

  try {
    // 使用通用的安全转发函数
    await safeForwardMessage(client, fromChatId, toChatId, messageId, {
      maxRetries: 3,
      silent: options?.silent,
      replyTo: options?.replyTo,
    });

    console.log(
      `[SHIFT] 转发成功: ${fromChatId} -> ${toChatId}, msg=${messageId}, depth=${depth}`
    );

    // Check for chained forwarding
    const nextRule = await getShiftRule(toChatId);
    if (nextRule && !nextRule.paused && nextRule.target_id) {
      // Wait for message to arrive
      await abortableSleep(200, tryGetCurrentGenerationContext()?.signal);

      // Recursive forwarding with depth tracking
      await shiftForwardMessage(
        client,
        toChatId,
        nextRule.target_id,
        messageId,
        depth + 1,
        options
      );
    }
  } catch (error) {
    console.error(
      `[SHIFT] 转发失败: ${fromChatId} -> ${toChatId}, msg=${messageId}`,
      error
    );
    throw error;
  }
}

// Message handler for automatic forwarding
async function handleIncomingMessage(
  message: any,
  isEdited?: boolean
): Promise<void> {
  try {
    if (!message || !message.chat) {
      return;
    }

    const sourceId = getChatIdFromMessage(message, isEdited);
    if (!sourceId) {
      return;
    }

    const rule = await getShiftRule(sourceId);
    if (!rule || rule.paused) {
      return;
    }

    const targetId = rule.target_id;
    if (!targetId) {
      return;
    }

    // Check content protection
    if (message.chat.noforwards) {
      console.log(
        `[SHIFT] 源聊天 ${
          rule.source_display || sourceId
        } 开启了内容保护，删除转发规则`
      );
      deleteShiftRule(sourceId);
      return;
    }

    // Check message filtering
    if (await isMessageFiltered(message, sourceId)) {
      console.log(`[SHIFT] 消息被过滤: ${rule.source_display || sourceId}`);
      return;
    }

    // Check message type
    const options = rule.options;

    if (isEdited && !(options && options.includes("handle_edited"))) {
      console.log(`[SHIFT] 编辑消息被忽略: ${rule.source_display || sourceId}`);
      return;
    }

    const messageTypes = [];
    if (Array.isArray(options) && options.length > 0) {
      for (const option of options) {
        if (
          !option.startsWith("replyTo:") &&
          !["all", "silent", "handle_edited"].includes(option)
        ) {
          messageTypes.push(option);
        }
      }
    }
    const messageType = getMediaType(message);
    if (messageTypes.length > 0 && !messageTypes.includes(messageType)) {
      console.log(
        `[SHIFT] 消息类型不匹配: ${messageType} not in ${options}, ${
          rule.source_display || sourceId
        }`
      );
      return;
    }

    // Grouped album handling: buffer and forward whole group
    const hasGroup = !!(message as any).groupedId;
    let replyTo = undefined as number | undefined;
    if (options && options.length > 0) {
      for (const option of options) {
        if (option.startsWith("replyTo:")) {
          const replyToStr = option.replace("replyTo:", "").trim();
          const replyToNum = parseInt(replyToStr);
          if (!isNaN(replyToNum)) {
            replyTo = replyToNum;
          }
          break;
        }
      }
    }
    if (hasGroup) {
      const shouldForward =
        messageTypes.length === 0 || messageTypes.includes(messageType);
      enqueueGroupMessage(
        message,
        sourceId,
        targetId,
        { silent: options?.includes("silent"), replyTo },
        shouldForward
      );
      return;
    }

    // Execute forwarding
    console.log(
      `[SHIFT] 开始转发: ${rule.source_display || sourceId} -> ${
        rule.target_display || targetId
      }, msg=${message.id}`
    );
    const client = await getGlobalClient();
    await shiftForwardMessage(
      client,
      sourceId,
      targetId,
      message.id,
      undefined,
      {
        silent: options?.includes("silent"),
        replyTo,
      }
    );

    // Update stats
    updateStats(sourceId, targetId, messageType);
  } catch (error) {
    console.error(`[SHIFT] 处理消息时出错: ${error}`);
  }
}

export default new ShiftPlugin();
