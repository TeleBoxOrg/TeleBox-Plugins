import { Api, TelegramClient } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import path from "path";
import fs from "fs";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { getCurrentGeneration, tryGetCurrentGenerationContext } from "@utils/runtimeManager";
import type { GenerationContext } from "@utils/generationContext";
import { getPrefixes } from "@utils/pluginManager";
import bigInt from "big-integer";
import { safeGetMessages } from "@utils/safeGetMessages";

import { safeGetMe } from "@utils/authGuards";
import { htmlEscape } from "@utils/htmlEscape";
import { logger } from "@utils/logger";

const PLUGIN_VERSION = "5.0.7";

function codeTag(value: string | number): string {
  return `<code>${htmlEscape(String(value))}</code>`;
}

function attrEscape(value: string | number): string {
  return htmlEscape(String(value)).replace(/'/g, "&#39;");
}

// ─── 枚举 ─────────────────────────────────────────────────────────────────────

enum CaptchaMode {
  MATH       = "math",        // 数学计算题（纯文字）
  TEXT       = "text",        // 文字关键词回复
  IMG_DIGIT  = "img_digit",   // 图片验证码（纯数字）
  IMG_MIXED  = "img_mixed",   // 图片验证码（字母+数字混合）
}

enum FailAction {
  BLOCK    = "block",    // 屏蔽用户
  DELETE   = "delete",   // 删除对话记录（双方撤回）
  REPORT   = "report",   // 举报垃圾信息
  MUTE     = "mute",     // 永久静音
  ARCHIVE  = "archive",  // 归档
  KICK     = "kick",     // 踢出（仅群组，私聊无效）
  BAN      = "ban",      // 封禁（仅群组）
}

enum PassAction {
  UNMUTE    = "unmute",    // 取消静音
  UNARCHIVE = "unarchive", // 取消归档
  WL        = "wl",        // 加入白名单
}

/** 验证失败操作的显示标签 */
const FAIL_ACTION_LABEL: Record<string, string> = {
  block:   "屏蔽",
  delete:  "删除对话（双方）",
  report:  "举报",
  mute:    "永久静音",
  archive: "归档",
  kick:    "踢出",
  ban:     "封禁",
};

const PASS_ACTION_LABEL: Record<string, string> = {
  unmute:    "取消静音",
  unarchive: "取消归档",
  wl:        "加入白名单",
};

/** 中文别名 → FailAction（支持中文设置） */
const FAIL_ACTION_CN_MAP: Record<string, FailAction> = {
  "屏蔽":   FailAction.BLOCK,
  "删除":   FailAction.DELETE,
  "举报":   FailAction.REPORT,
  "静音":   FailAction.MUTE,
  "归档":   FailAction.ARCHIVE,
  "踢出":   FailAction.KICK,
  "封禁":   FailAction.BAN,
};

/** 中文别名 → PassAction */
const PASS_ACTION_CN_MAP: Record<string, PassAction> = {
  "取消静音": PassAction.UNMUTE,
  "取消归档": PassAction.UNARCHIVE,
  "白名单":   PassAction.WL,
};

function resolveFailAction(s: string): FailAction | null {
  const lower = s.toLowerCase();
  if ((Object.values(FailAction) as string[]).includes(lower)) return lower as FailAction;
  return FAIL_ACTION_CN_MAP[s] ?? null;
}

function resolvePassAction(s: string): PassAction | null {
  const lower = s.toLowerCase();
  if ((Object.values(PassAction) as string[]).includes(lower)) return lower as PassAction;
  return PASS_ACTION_CN_MAP[s] ?? null;
}

// ─── 配置键 & 类型 ────────────────────────────────────────────────────────────

const K = {
  ENABLED:          "plugin_enabled",
  CAP_ENABLED:      "captcha_enabled",
  CAP_MODE:         "captcha_mode",
  CAP_TIMEOUT:      "captcha_timeout",
  CAP_TRIES:        "captcha_max_tries",
  CAP_ACTIONS:      "captcha_fail_actions",
  CAP_KEYWORD:      "captcha_text_keyword",
  CAP_PROMPT:       "captcha_prompt",
  CAP_PASS_ACTIONS: "captcha_pass_actions",
  // ── 自动过白规则 ──
  INITIATIVE:       "auto_initiative",        // 主动对话过白开关
  HISTORY_COUNT:    "auto_history_count",      // 聊天记录过白阈值（-1=禁用）
  GROUPS_IN_COMMON: "auto_groups_in_common",   // 共同群过白阈值（-1=禁用）
  WL_WORDS:         "auto_whitelist_words",    // 白名单关键词列表
  BL_WORDS:         "auto_blacklist_words",    // 黑名单关键词列表
  PREMIUM:          "auto_premium",            // Premium 用户策略: "allow"|"ban"|"only"|"none"
} as const;

const D = {
  WHITELIST: "whitelist_user_ids",
  VERIFIED:  "verified_users",
  FAILED:    "failed_users",
} as const;

interface VerifiedRecord { id: number; name: string; username?: string; time: string }
interface FailedRecord   { id: number; name: string; username?: string; time: string; reason: "timeout" | "max_tries" }

const DEFAULT_CONFIG = {
  [K.ENABLED]:         true,
  [K.CAP_ENABLED]:     false,
  [K.CAP_MODE]:        CaptchaMode.MATH,
  [K.CAP_TIMEOUT]:     30,
  [K.CAP_TRIES]:       3,
  [K.CAP_ACTIONS]:     [] as FailAction[],
  [K.CAP_KEYWORD]:     "我同意",
  [K.CAP_PROMPT]:      "",
  [K.CAP_PASS_ACTIONS]: [] as PassAction[],
  // ── 自动过白规则默认值 ──
  [K.INITIATIVE]:       true,              // 默认启用主动对话过白
  [K.HISTORY_COUNT]:    -1 as number,      // -1 = 禁用聊天记录过白
  [K.GROUPS_IN_COMMON]: -1 as number,      // -1 = 禁用共同群过白
  [K.WL_WORDS]:         [] as string[],    // 白名单关键词列表
  [K.BL_WORDS]:         [] as string[],    // 黑名单关键词列表
  [K.PREMIUM]:          "none" as string,  // Premium 策略: allow|ban|only|none
};

/** Premium 用户策略枚举 */
type PremiumStrategy = "allow" | "ban" | "only" | "none";
const PREMIUM_STRATEGIES: PremiumStrategy[] = ["allow", "ban", "only", "none"];

const PREMIUM_LABEL: Record<PremiumStrategy, string> = {
  allow: "允许（Premium 用户自动通过）",
  ban:   "封禁（拒绝 Premium 用户）",
  only:  "仅限（仅允许 Premium 用户）",
  none:  "无（不做特殊处理）",
};

const DEFAULT_DATA = {
  [D.WHITELIST]: [] as number[],
  [D.VERIFIED]:  [] as VerifiedRecord[],
  [D.FAILED]:    [] as FailedRecord[],
};

// ─── 数据库 ───────────────────────────────────────────────────────────────────

interface JsonDb { data: Record<string, any>; write(): Promise<void> }

const prefixes   = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const pmcDir     = createDirectoryInAssets("pmcaptcha");

const legacyDataDir = path.join(process.cwd(), "pmcaptcha_userdata");
const newDataDir   = createDirectoryInAssets("pmcaptcha");

if (fs.existsSync(legacyDataDir)) {
  const legacyConfig = path.join(legacyDataDir, "pmcaptcha_config.json");
  const legacyData = path.join(legacyDataDir, "pmcaptcha_data.json");
  const newConfig  = path.join(newDataDir, "pmcaptcha_config.json");
  const newData    = path.join(newDataDir, "pmcaptcha_data.json");

  if (fs.existsSync(legacyConfig) && !fs.existsSync(newConfig)) {
    fs.copyFileSync(legacyConfig, newConfig);
    logger.info( `Migrated config: ${legacyConfig} → ${newConfig}`);
  }
  if (fs.existsSync(legacyData) && !fs.existsSync(newData)) {
    fs.copyFileSync(legacyData, newData);
    logger.info( `Migrated data: ${legacyData} → ${newData}`);
  }
}

const dataDir = newDataDir;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let configDb: JsonDb | null = null;
let dataDb:   JsonDb | null = null;
let dbReady = false;

async function initDb() {
  try {
    [configDb, dataDb] = await Promise.all([
      JSONFilePreset(path.join(pmcDir,  "pmcaptcha_config.json"), DEFAULT_CONFIG) as Promise<JsonDb>,
      JSONFilePreset(path.join(dataDir, "pmcaptcha_data.json"),   DEFAULT_DATA)   as Promise<JsonDb>,
    ]);
    dbReady = true;
    logger.info( `Config DB ready | Data DB: ${path.join(dataDir, "pmcaptcha_data.json")}`);
  } catch (e) {
    logger.error( "DB init failed", e);
  }
}

async function generationDelay(ms: number): Promise<boolean> {
  const lifecycle = getActiveLifecycle();
  if (!lifecycle) return false;
  return await new Promise<boolean>((resolve) => {
    lifecycle.setTimeout(() => resolve(!lifecycle.signal.aborted), ms, { label: "pmcaptcha-delay" });
    if (lifecycle.signal.aborted) resolve(false);
  });
}

async function waitDb(ms = 5000): Promise<boolean> {
  const t = Date.now();
  while (!dbReady && Date.now() - t < ms) {
    if (!(await generationDelay(50))) return false;
  }
  return dbReady;
}

initDb();

// ─── 配置辅助 ─────────────────────────────────────────────────────────────────

function get<T>(key: string, def: T): T {
  if (!dbReady) return def;
  const db = (configDb?.data[key] !== undefined) ? configDb : dataDb;
  const v  = db?.data[key];
  return v !== undefined ? v : def;
}

function set(key: string, value: any) {
  if (!dbReady) return;
  if (key in DEFAULT_DATA) {
    if (!dataDb) return;
    dataDb.data[key] = value;
    dataDb.write().catch(e => logger.error( `data write failed: ${key}`, e));
  } else {
    if (!configDb) return;
    configDb.data[key] = value;
    configDb.write().catch(e => logger.error( `config write failed: ${key}`, e));
  }
}

const cfg = {
  pluginOn:    () => get(K.ENABLED, true),
  captchaOn:   () => get(K.CAP_ENABLED, false),
  mode:        () => {
    const v = get<string>(K.CAP_MODE, CaptchaMode.MATH);
    return (Object.values(CaptchaMode) as string[]).includes(v)
      ? v as CaptchaMode
      : CaptchaMode.MATH;
  },
  timeout:     () => get<number>(K.CAP_TIMEOUT, 30),
  maxTries:    () => get<number>(K.CAP_TRIES, 3),
  failActions: () => get<FailAction[]>(K.CAP_ACTIONS, []),
  keyword:     () => get(K.CAP_KEYWORD, "我同意"),
  prompt:      () => get(K.CAP_PROMPT, ""),
  whitelist:   () => get<number[]>(D.WHITELIST, []),
  verified:    () => get<VerifiedRecord[]>(D.VERIFIED, []),
  failed:      () => get<FailedRecord[]>(D.FAILED, []),
  passActions: () => get<PassAction[]>(K.CAP_PASS_ACTIONS, []),
  // ── 自动过白规则访问器 ──
  initiative:      () => get<boolean>(K.INITIATIVE, true),
  historyCount:    () => get<number>(K.HISTORY_COUNT, -1),
  groupsInCommon:  () => get<number>(K.GROUPS_IN_COMMON, -1),
  wlWords:         () => get<string[]>(K.WL_WORDS, []),
  blWords:         () => get<string[]>(K.BL_WORDS, []),
  premium:         (): PremiumStrategy => {
    const v = get<string>(K.PREMIUM, "none");
    return PREMIUM_STRATEGIES.includes(v as PremiumStrategy) ? v as PremiumStrategy : "none";
  },
};

// ─── 白名单 ───────────────────────────────────────────────────────────────────

const wl = {
  has:   (id: number) => cfg.whitelist().includes(id),
  add:   (id: number) => {
    const list = cfg.whitelist();
    if (!list.includes(id)) {
      list.push(id);
      set(D.WHITELIST, list);
      rec.delVerified(id);
    }
  },
  del:   (id: number) => set(D.WHITELIST, cfg.whitelist().filter(x => x !== id)),
  clear: ()           => set(D.WHITELIST, [])
};

// ─── 验证记录 ─────────────────────────────────────────────────────────────────

const rec = {
  addVerified: (id: number, name: string, username?: string) => {
    const list = cfg.verified();
    const idx  = list.findIndex(r => r.id === id);
    const entry: VerifiedRecord = { id, name, ...(username ? { username } : {}), time: new Date().toISOString() };
    idx >= 0 ? list[idx] = entry : list.push(entry);
    set(D.VERIFIED, list);
  },
  delVerified:   (id: number) => set(D.VERIFIED, cfg.verified().filter(r => r.id !== id)),
  clearVerified: ()           => set(D.VERIFIED, []),

  addFailed: (id: number, name: string, reason: FailedRecord["reason"], username?: string) => {
    const list = cfg.failed();
    const idx  = list.findIndex(r => r.id === id);
    const entry: FailedRecord = { id, name, reason, ...(username ? { username } : {}), time: new Date().toISOString() };
    idx >= 0 ? list[idx] = entry : list.push(entry);
    set(D.FAILED, list);
  },
  delFailed:   (id: number) => set(D.FAILED, cfg.failed().filter(r => r.id !== id)),
  clearFailed: ()           => set(D.FAILED, [])
};

// ─── 用户信息缓存 ─────────────────────────────────────────────────────────────

const nameCache      = new Map<number, string>();
const usernameCache  = new Map<number, string>();
const inputPeerCache = new Map<number, Api.TypeInputPeer>();
let _selfId: number | null = null;

async function getSelfId(client: TelegramClient): Promise<number> {
  if (_selfId !== null) return _selfId;
  const me = await safeGetMe(client);
  _selfId = me ? Number((me as any).id) : 0;
  return _selfId!;
}

function cacheUserFromSender(sender: any): void {
  if (!sender?.id) return;
  const id       = Number(sender.id);
  const name     = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim() || "Unknown";
  const username = sender.username as string | undefined;
  nameCache.set(id, name);
  if (username) usernameCache.set(id, username);

  // A new private sender may not be in teleproto's entity cache yet. Preserve the
  // access hash carried by the update so replies/actions can address that user.
  if (sender.accessHash !== undefined && sender.accessHash !== null) {
    inputPeerCache.set(id, new Api.InputPeerUser({
      userId: sender.id,
      accessHash: sender.accessHash,
    }));
  }
}

function cacheInputPeer(userId: number, peer: any): void {
  if (userId > 0 && peer instanceof Api.InputPeerUser) {
    inputPeerCache.set(userId, peer);
  }
}

async function resolveInputPeer(client: TelegramClient, userId: number): Promise<Api.TypeInputPeer> {
  const cached = inputPeerCache.get(userId);
  if (cached) return cached;

  const peer = await client.getInputEntity(bigInt(userId));
  cacheInputPeer(userId, peer);
  return peer;
}

function peerTarget(userId: number): Api.TypeInputPeer | number {
  return inputPeerCache.get(userId) ?? userId;
}

async function cachePeerFromMessage(message: Api.Message, userId: number): Promise<void> {
  const directPeer = (message as any).inputChat;
  if (directPeer) cacheInputPeer(userId, directPeer);
  if (inputPeerCache.has(userId)) return;

  try {
    const peer = await (message as any).getInputChat?.();
    cacheInputPeer(userId, peer);
  } catch { /* entity resolve failed, ignore */ }
}

async function fetchUserInfo(client: TelegramClient, userId: number): Promise<any | null> {
  try {
    const e = await client.getEntity(userId) as any;
    cacheUserFromSender(e);
    return e;
  } catch { /* entity not found, continue to fallback */ }

  try {
    const input = await client.getInputEntity(bigInt(userId));
    if (input instanceof Api.InputPeerUser) {
      const res = await client.invoke(new Api.users.GetUsers({
        id: [new Api.InputUser({ userId: input.userId, accessHash: input.accessHash })]
      })) as any[];
      const user = res?.[0];
      if (user && !(user instanceof Api.UserEmpty)) {
        cacheUserFromSender(user);
        return user;
      }
    }
  } catch { /* users.getUsers failed, ignore */ }

  return null;
}

async function getDisplayName(client: TelegramClient, userId: number): Promise<string> {
  if (nameCache.has(userId)) return nameCache.get(userId)!;
  const user = await fetchUserInfo(client, userId);
  if (user) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Unknown";
    return name;
  }
  return String(userId);
}

function userLink(id: number, name: string): string {
  return `<a href="tg://user?id=${attrEscape(id)}">${htmlEscape(name)} (${htmlEscape(id)})</a>`;
}

function isBotFromSender(sender: any): boolean {
  return !!(sender as any)?.bot;
}

async function isBot(client: TelegramClient, userId: number): Promise<boolean> {
  const user = await fetchUserInfo(client, userId);
  return !!user?.bot;
}

// ─── 会话操作 ─────────────────────────────────────────────────────────────────

async function archiveChat(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })]
    }));
  } catch (e) { logger.error( `archive failed ${userId}`, e); }
}

async function muteChat(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer }),
      settings: new Api.InputPeerNotifySettings({ muteUntil: 2147483647, showPreviews: false, silent: true })
    }));
  } catch (e) { logger.error( `mute failed ${userId}`, e); }
}

async function blockUser(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.contacts.Block({ id: peer }));
    logger.info( `Blocked ${userId}`);
  } catch (e) { logger.error( `block failed ${userId}`, e); }
}

async function deleteHistory(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.messages.DeleteHistory({ peer, revoke: false, maxId: 0 }));
    logger.info( `Deleted history ${userId}`);
  } catch (e) { logger.error( `delete history failed ${userId}`, e); }
}

async function reportSpam(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.account.ReportPeer({
      peer, reason: new Api.InputReportReasonSpam(), message: "spam"
    }));
    logger.info( `Reported ${userId}`);
  } catch (e) { logger.error( `report failed ${userId}`, e); }
}

async function unmuteChat(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer }),
      settings: new Api.InputPeerNotifySettings({ muteUntil: 0, showPreviews: true, silent: false })
    }));
  } catch (e) { logger.error( `unmute failed ${userId}`, e); }
}

async function unarchiveChat(client: TelegramClient, userId: number) {
  try {
    const peer = await resolveInputPeer(client, userId);
    await client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer, folderId: 0 })]
    }));
  } catch (e) { logger.error( `unarchive failed ${userId}`, e); }
}

async function runFailActions(client: TelegramClient, userId: number) {
  await archiveChat(client, userId);
  await muteChat(client, userId);

  for (const a of cfg.failActions()) {
    if (a === FailAction.BLOCK)  await blockUser(client, userId);
    if (a === FailAction.DELETE) {
      try {
        const peer = await resolveInputPeer(client, userId);
        await client.invoke(new Api.messages.DeleteHistory({ peer, revoke: true, maxId: 0 }));
        logger.info( `Deleted history (revoke both sides) ${userId}`);
      } catch (e) { logger.error( `delete failed ${userId}`, e); }
    }
    if (a === FailAction.REPORT)  await reportSpam(client, userId);
    if (a === FailAction.MUTE)    await muteChat(client, userId);
    if (a === FailAction.ARCHIVE) await archiveChat(client, userId);
  }
}

async function runPassActions(client: TelegramClient, userId: number) {
  for (const a of cfg.passActions()) {
    if (a === PassAction.UNMUTE)    await unmuteChat(client, userId);
    if (a === PassAction.UNARCHIVE) await unarchiveChat(client, userId);
    if (a === PassAction.WL)        wl.add(userId);
  }
}

// ─── 图片验证码生成 ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _canvas: any = null;

async function tryGetCanvas(): Promise<any> {
  if (_canvas !== null) return _canvas;
  try {
    _canvas = await import("canvas");
    logger.info("canvas module loaded");
    return _canvas;
  } catch {
    /* canvas not available at build time */
    throw new Error("canvas not installed at build time");
  }
}

async function generateImageCaptcha(
  digitOnly: boolean
): Promise<{ buffer: Buffer; answer: string } | null> {
  const cv = await tryGetCanvas();
  if (!cv) return null;

  const CHARSET_DIGIT = "0123456789";
  const CHARSET_MIXED = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const charset = digitOnly ? CHARSET_DIGIT : CHARSET_MIXED;
  const LENGTH  = 5;

  let answer = "";
  for (let i = 0; i < LENGTH; i++) {
    answer += charset[Math.floor(Math.random() * charset.length)];
  }

  const W = 240, H = 90;
  const canvas = cv.createCanvas(W, H);
  const ctx    = canvas.getContext("2d") as CanvasRenderingContext2D;

  const rnd  = () => Math.random();
  const rndI = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;

  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `hsla(${rndI(0,360)},30%,${rndI(85,97)}%,0.9)`;
    ctx.fillRect(rndI(0, W), rndI(0, H), rndI(20, 80), rndI(20, 60));
  }

  ctx.strokeStyle = `rgba(180,180,200,0.35)`;
  ctx.lineWidth = 0.8;
  for (let x = 0; x < W; x += rndI(18, 28)) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += rndI(18, 28)) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(0, rnd() * H);
    ctx.bezierCurveTo(W * 0.25, rnd() * H, W * 0.75, rnd() * H, W, rnd() * H);
    ctx.strokeStyle = `hsla(${rndI(0,360)},55%,45%,${0.3 + rnd() * 0.3})`;
    ctx.lineWidth   = 1 + rnd();
    ctx.stroke();
  }

  for (let i = 0; i < 180; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 0.8 + rnd() * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${rndI(0,360)},50%,35%,${0.4 + rnd() * 0.4})`;
    ctx.fill();
  }

  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsla(${rndI(0,360)},60%,60%,0.15)`;
    ctx.fillRect(rnd() * W, rnd() * H, rndI(8, 30), rndI(4, 16));
  }

  const STEP = (W - 24) / LENGTH;
  for (let i = 0; i < LENGTH; i++) {
    const ch  = answer[i];
    const x   = 14 + i * STEP + STEP * 0.35;
    const y   = H / 2 + (rnd() - 0.5) * 18;
    const rot = (rnd() - 0.5) * 0.65;
    const sz  = 32 + rndI(0, 10);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.font         = `bold ${sz}px monospace`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor   = `hsla(${rndI(0,360)},80%,50%,0.6)`;
    ctx.shadowBlur    = 4;
    ctx.strokeStyle   = `hsla(${rndI(0,360)},35%,85%,0.9)`;
    ctx.lineWidth     = 4;
    ctx.strokeText(ch, 0, 0);

    ctx.shadowBlur  = 0;
    ctx.fillStyle   = `hsl(${rndI(0,360)},70%,20%)`;
    ctx.fillText(ch, 0, 0);

    if (rnd() > 0.5) {
      ctx.strokeStyle = `hsla(${rndI(0,360)},60%,40%,0.5)`;
      ctx.lineWidth   = 1.5;
      const hw = sz * 0.35;
      ctx.beginPath();
      ctx.moveTo(-hw, (rnd() - 0.5) * sz * 0.4);
      ctx.lineTo( hw, (rnd() - 0.5) * sz * 0.4);
      ctx.stroke();
    }

    ctx.restore();
  }

  return { buffer: canvas.toBuffer("image/png"), answer };
}

// ─── 验证状态 ─────────────────────────────────────────────────────────────────

type CaptchaTimer = ReturnType<GenerationContext["setTimeout"]>;

interface CaptchaState {
  answer:   string;                             // 正确答案
  question: string;                             // 题目 / 关键词（用于刷新消息）
  isQA:     boolean;                            // TEXT 模式：是否为随机问答（false = keyword 模式）
  tries:    number;                             // 已尝试次数
  timer:    CaptchaTimer | null;
  msgIds:   number[];                           // 所有验证消息 ID
  mode:     CaptchaMode;                        // 当前验证模式
  generation: number;
}

let runtimeLifecycle: GenerationContext | null = null;
let runtimeGeneration = 0;
const states = new Map<number, CaptchaState>();

function getActiveLifecycle(): GenerationContext | null {
  if (runtimeLifecycle && !runtimeLifecycle.signal.aborted && runtimeGeneration === getCurrentGeneration()) {
    return runtimeLifecycle;
  }

  const current = tryGetCurrentGenerationContext();
  if (!current || current.signal.aborted) return null;
  runtimeLifecycle = current;
  runtimeGeneration = current.generation;
  return current;
}

function isStateCurrent(state: CaptchaState): boolean {
  const lifecycle = getActiveLifecycle();
  return !!lifecycle && state.generation === lifecycle.generation && !lifecycle.signal.aborted;
}

function clearCaptchaTimer(state: CaptchaState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function removeCaptchaState(userId: number): CaptchaState | undefined {
  const state = states.get(userId);
  if (!state) return undefined;
  clearCaptchaTimer(state);
  states.delete(userId);
  return state;
}

function drainCaptchaStates(): void {
  for (const state of states.values()) {
    clearCaptchaTimer(state);
  }
  states.clear();
}

async function cleanupCaptchaMessages(client: TelegramClient, userId: number, state: CaptchaState) {
  if (!isStateCurrent(state)) return;
  for (const id of state.msgIds) {
    if (!isStateCurrent(state)) return;
    try { await client.deleteMessages(peerTarget(userId), [id], { revoke: false }); } catch { /* message already deleted, ignore */ }
  }
}

// ─── 消息重建（用于实时刷新）─────────────────────────────────────────────────

/** 重建文字类验证消息文本（含最新的 timeout/tries/failActions） */
function rebuildCaptchaText(state: CaptchaState): string {
  const timeout    = cfg.timeout();
  const maxTries   = cfg.maxTries();
  const actions    = cfg.failActions();
  const custom     = cfg.prompt();
  const actionDesc = actions.length
    ? actions.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、")
    : "仅归档并静音";
  const remaining  = maxTries > 0 ? maxTries - state.tries : 0;

  function buildFooter(): string {
    const lines: string[] = [];
    if (timeout > 0)  lines.push(`⏱ 验证时间：<b>${htmlEscape(timeout)}</b> 秒`);
    if (maxTries > 0) lines.push(`🔢 剩余次数：<b>${htmlEscape(remaining > 0 ? remaining : maxTries)}</b> 次`);
    lines.push(`⚠️ 验证失败将会：${htmlEscape(actionDesc)}`);
    return lines.length ? "\n\n" + lines.join("\n") : "";
  }

  switch (state.mode) {
    case CaptchaMode.MATH: {
      const footer = buildFooter();
      return custom
        ? htmlEscape(custom).replace("{question}", htmlEscape(state.question))
        : `🔒 <b>人机验证</b>\n\n请回复以下算式的答案：\n\n${codeTag(`${state.question} = ?`)}${footer}`;
    }
    case CaptchaMode.TEXT: {
      const footer = buildFooter();
      if (state.isQA) {
        return `🔒 <b>人机验证</b>\n\n请回答以下问题：\n\n<b>${htmlEscape(state.question)}</b>${footer}`;
      } else {
        const kw = state.question;
        return custom
          ? htmlEscape(custom).replace("{keyword}", htmlEscape(kw))
          : `🔒 <b>人机验证</b>\n\n请回复以下关键词以证明你不是机器人：\n\n${codeTag(kw)}${footer}`;
      }
    }
    default:
      return "";
  }
}

/** 重建图片验证码的 caption 文本 */
function rebuildImgCaption(state: CaptchaState): string {
  const timeout    = cfg.timeout();
  const maxTries   = cfg.maxTries();
  const actions    = cfg.failActions();
  const actionDesc = actions.length
    ? actions.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、")
    : "仅归档并静音";
  const digitOnly  = state.mode === CaptchaMode.IMG_DIGIT;
  const desc       = digitOnly ? "5 位数字验证码" : "5 位验证码（字母与数字均为大写）";

  const lines: string[] = [`🔒 人机验证\n\n请输入图片中的${desc}`];
    if (timeout > 0) lines.push(`⏱ 验证时间：${htmlEscape(timeout)} 秒`);
  if (maxTries > 0) lines.push(`🔢 剩余次数：${htmlEscape(maxTries)} 次`);
  lines.push(`⚠️ 验证失败将会：${htmlEscape(actionDesc)}`);
  return lines.join("\n");
}

/**
 * 刷新所有正在进行中的验证消息（在超时/次数/失败操作变更后调用）。
 * 图片模式更新 caption，文字模式更新消息正文。
 */
async function refreshActiveCaptchas(client: TelegramClient): Promise<void> {
  for (const [userId, state] of states.entries()) {
    const promptMsgId = state.msgIds[0];
    if (!promptMsgId) continue;
    try {
      const isImg = state.mode === CaptchaMode.IMG_DIGIT || state.mode === CaptchaMode.IMG_MIXED;
      if (isImg) {
        const newCaption = rebuildImgCaption(state);
        await client.editMessage(peerTarget(userId), { message: promptMsgId, text: newCaption });
      } else {
        const newText = rebuildCaptchaText(state);
        if (newText) {
          await client.editMessage(peerTarget(userId), { message: promptMsgId, text: newText, parseMode: "html" });
        }
      }
    } catch (e) {
      logger.warn( `refreshActiveCaptchas: failed to update msg for ${userId}`, e);
    }
  }
}

// ─── 发送验证 ─────────────────────────────────────────────────────────────────

function modeLabel(m: CaptchaMode): string {
  return {
    [CaptchaMode.MATH]:       "算术验证",
    [CaptchaMode.TEXT]:       "关键词验证",
    [CaptchaMode.IMG_DIGIT]:  "图片验证（纯数字）",
    [CaptchaMode.IMG_MIXED]:  "图片验证（字母+数字）",
  }[m] ?? m;
}

function mathQuestion(): { question: string; answer: string } {
  const rand  = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const type  = rand(0, 5);

  if (type === 0) {
    const a = rand(10, 99), b = rand(10, 99);
    return { question: `${a} + ${b}`, answer: String(a + b) };
  }
  if (type === 1) {
    const b = rand(10, 60), a = rand(b + 1, b + 60);
    return { question: `${a} - ${b}`, answer: String(a - b) };
  }
  if (type === 2) {
    const a = rand(2, 9), b = rand(11, 25);
    return { question: `${a} × ${b}`, answer: String(a * b) };
  }
  if (type === 3) {
    const divisor = rand(2, 12), quotient = rand(3, 15);
    const dividend = divisor * quotient;
    return { question: `${dividend} ÷ ${divisor}`, answer: String(quotient) };
  }
  if (type === 4) {
    const a = rand(2, 9), b = rand(2, 9), c = rand(1, 20);
    return { question: `${a} × ${b} + ${c}`, answer: String(a * b + c) };
  }
  const a = rand(2, 12);
  return { question: `${a}²`, answer: String(a * a) };
}

const TEXT_QA: { question: string; answer: string }[] = [
  { question: "天空是什么颜色？（中文）",           answer: "蓝色"   },
  { question: "一周有几天？（数字）",               answer: "7"      },
  { question: "一年有几个月？（数字）",             answer: "12"     },
  { question: "猫叫声是？（中文拟声词）",           answer: "喵"     },
  { question: "水的化学式是？",                    answer: "h2o"    },
  { question: "太阳从哪边升起？（东/西/南/北）",    answer: "东"     },
  { question: "地球上最大的洋是？（中文）",         answer: "太平洋" },
  { question: "1 + 1 等于几？（数字）",            answer: "2"      },
  { question: "中国的首都是哪个城市？（中文）",     answer: "北京"   },
  { question: "一天有多少小时？（数字）",           answer: "24"     },
  { question: "人有几根手指？（数字）",             answer: "10"     },
  { question: "苹果是什么颜色的？（中文，常见色）", answer: "红色"   },
  { question: "冰是什么状态的水？（固/液/气）",     answer: "固"     },
  { question: "地球围绕什么转？（中文）",           answer: "太阳"   },
  { question: "键盘上字母共有几个？（数字）",       answer: "26"     },
];

function textQuestion(): { question: string; answer: string } {
  return TEXT_QA[Math.floor(Math.random() * TEXT_QA.length)];
}

async function sendCaptcha(client: TelegramClient, userId: number): Promise<void> {
  const lifecycle = getActiveLifecycle();
  if (!lifecycle) return;

  const existing = removeCaptchaState(userId);
  if (existing) {
    await cleanupCaptchaMessages(client, userId, existing);
  }

  const mode    = cfg.mode();
  const timeout = cfg.timeout();
  const tries   = cfg.maxTries();
  const actions = cfg.failActions();
  const custom  = cfg.prompt();

  const actionDesc = actions.length
    ? actions.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、")
    : "仅归档并静音";

  function buildFooter(): string {
    const lines: string[] = [];
    if (timeout > 0) lines.push(`⏱ 验证时间：<b>${htmlEscape(timeout)}</b> 秒`);
    if (tries   > 0) lines.push(`🔢 剩余次数：<b>${htmlEscape(tries)}</b> 次`);
    lines.push(`⚠️ 验证失败将会：${htmlEscape(actionDesc)}`);
    return lines.length ? "\n\n" + lines.join("\n") : "";
  }

  let answer   = "";
  let question = "";
  let isQA     = false;
  const msgIds: number[] = [];

  try {
    switch (mode) {

      case CaptchaMode.MATH: {
        const { question: q, answer: ans } = mathQuestion();
        answer   = ans;
        question = q;
        const footer = buildFooter();
        const text = custom
          ? htmlEscape(custom).replace("{question}", htmlEscape(q))
          : `🔒 <b>人机验证</b>\n\n请回复以下算式的答案：\n\n${codeTag(`${q} = ?`)}${footer}`;
        const m = await client.sendMessage(peerTarget(userId), { message: text, parseMode: "html" });
        msgIds.push(m.id);
        break;
      }

      case CaptchaMode.TEXT: {
        const kw     = cfg.keyword();
        const footer = buildFooter();
        if (kw === "我同意" && !custom) {
          const qa = textQuestion();
          answer   = qa.answer;
          question = qa.question;
          isQA     = true;
          const text = `🔒 <b>人机验证</b>\n\n请回答以下问题：\n\n<b>${htmlEscape(qa.question)}</b>${footer}`;
          const m = await client.sendMessage(peerTarget(userId), { message: text, parseMode: "html" });
          msgIds.push(m.id);
        } else {
          answer   = kw;
          question = kw;
          isQA     = false;
          const text = custom
            ? htmlEscape(custom).replace("{keyword}", htmlEscape(kw))
            : `🔒 <b>人机验证</b>\n\n请回复以下关键词以证明你不是机器人：\n\n${codeTag(kw)}${footer}`;
          const m = await client.sendMessage(peerTarget(userId), { message: text, parseMode: "html" });
          msgIds.push(m.id);
        }
        break;
      }

      case CaptchaMode.IMG_DIGIT:
      case CaptchaMode.IMG_MIXED: {
        const digitOnly = mode === CaptchaMode.IMG_DIGIT;
        const img = await generateImageCaptcha(digitOnly);

        if (!img) {
          logger.warn( `canvas unavailable for user ${userId}`);
          try {
            await client.sendMessage(peerTarget(userId), { message: "❌ 验证服务暂时不可用，请稍后再试。" });
          } catch { /* send failed, ignore */ }
          return;
        }

        answer   = img.answer;
        question = img.answer; // 图片模式不展示 question，存答案即可
        const desc = digitOnly ? "5 位数字验证码" : "5 位验证码（字母与数字均为大写）";

        function buildImgCaption(): string {
          const lines: string[] = [`🔒 人机验证\n\n请输入图片中的${desc}`];
          if (timeout > 0) lines.push(`⏱ 验证时间：${htmlEscape(timeout)} 秒`);
          if (tries   > 0) lines.push(`🔢 剩余次数：${htmlEscape(tries)} 次`);
          lines.push(`⚠️ 验证失败将会：${htmlEscape(actionDesc)}`);
          return lines.join("\n");
        }

        const caption = custom ? htmlEscape(custom) : buildImgCaption();
        const photoMsg = await client.sendMessage(peerTarget(userId), {
          message: caption,
          file: new CustomFile("captcha.png", img.buffer.length, "", img.buffer)
        });
        msgIds.push(photoMsg.id);
        break;
      }
    }

    if (!answer) {
      logger.warn( `sendCaptcha: answer empty (mode=${mode}), fallback to MATH`);
      const { question: q, answer: ans } = mathQuestion();
      answer   = ans;
      question = q;
      const m = await client.sendMessage(peerTarget(userId), {
          message: `🔒 <b>人机验证</b>（降级）\n\n请回复以下算式的答案：\n\n${codeTag(`${q} = ?`)}`,
        parseMode: "html"
      });
      msgIds.push(m.id);
    }

    if (lifecycle.signal.aborted || lifecycle.generation !== getCurrentGeneration()) return;

    const state: CaptchaState = { answer, question, isQA, tries: 0, timer: null, msgIds, mode, generation: lifecycle.generation };

    if (timeout > 0) {
      state.timer = lifecycle.setTimeout(() => {
        void lifecycle.runTask(async () => {
          if (!isStateCurrent(state)) return;
          const st = states.get(userId);
          if (st !== state) return;
          removeCaptchaState(userId);
          logger.info( `Captcha timed out: ${userId}`);
          const name = await getDisplayName(client, userId).catch(() => String(userId));
          if (!isStateCurrent(state)) return;
          rec.addFailed(userId, name, "timeout", usernameCache.get(userId));
          rec.delVerified(userId);
          await cleanupCaptchaMessages(client, userId, st);
          if (!isStateCurrent(state)) return;
          try {
            await client.sendMessage(peerTarget(userId), { message: "⏰ 验证超时，对话已被限制。", parseMode: "html" });
          } catch { /* send failed, ignore */ }
          if (!isStateCurrent(state)) return;
          await runFailActions(client, userId);
        }, { label: `pmcaptcha-timeout:${userId}` }).catch((error) => {
          logger.error( `Captcha timeout task failed: ${userId}`, error);
        });
      }, timeout * 1000, { label: `pmcaptcha-timer:${userId}` });
    }

    states.set(userId, state);
    logger.info( `Captcha sent (${mode}, timeout=${timeout}s) → user ${userId}`);

  } catch (e) {
    logger.error( `Failed to send captcha to ${userId}`, e);
  }
}

// ─── 处理验证回复 ─────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

async function handleReply(client: TelegramClient, userId: number, input: string, incomingMsgId: number): Promise<void> {
  const state = states.get(userId);
  if (!state || !isStateCurrent(state)) return;

  if (!input.trim()) return;

  if (incomingMsgId) state.msgIds.push(incomingMsgId);

  if (!state.answer) {
    logger.warn( `handleReply: empty answer for user ${userId}`);
    removeCaptchaState(userId);
    await cleanupCaptchaMessages(client, userId, state);
    try { await client.sendMessage(peerTarget(userId), { message: "❌ 验证状态异常，请联系对方重置。", parseMode: "html" }); } catch { /* send failed, ignore */ }
    return;
  }

  const isImgMode  = state.mode === CaptchaMode.IMG_DIGIT || state.mode === CaptchaMode.IMG_MIXED;
  const inputNorm  = input.trim().toUpperCase();
  const answerNorm = state.answer.trim().toUpperCase();

  const correct = isImgMode
    ? levenshtein(inputNorm, answerNorm) <= 1
    : inputNorm === answerNorm;

  if (correct) {
    removeCaptchaState(userId);
    await cleanupCaptchaMessages(client, userId, state);
    const name = await getDisplayName(client, userId).catch(() => String(userId));
    if (!isStateCurrent(state)) return;
    rec.addVerified(userId, name, usernameCache.get(userId));
    rec.delFailed(userId);
    logger.info( `User ${userId} passed captcha`);
    await runPassActions(client, userId);
    if (!isStateCurrent(state)) return;
    try {
      await client.sendMessage(peerTarget(userId), { message: "✅ 验证通过！欢迎与我对话。", parseMode: "html" });
    } catch { /* send failed, ignore */ }
    return;
  }

  state.tries++;
  const max       = cfg.maxTries();
  const remaining = max > 0 ? max - state.tries : Infinity;

  if (max > 0 && state.tries >= max) {
    removeCaptchaState(userId);
    await cleanupCaptchaMessages(client, userId, state);
    const name = await getDisplayName(client, userId).catch(() => String(userId));
    if (!isStateCurrent(state)) return;
    rec.addFailed(userId, name, "max_tries", usernameCache.get(userId));
    rec.delVerified(userId);
    logger.info( `User ${userId} failed captcha (max tries)`);
    try {
      await client.sendMessage(peerTarget(userId), { message: "❌ 验证失败次数过多，对话已被限制。", parseMode: "html" });
    } catch { /* send failed, ignore */ }
    if (!isStateCurrent(state)) return;
    await runFailActions(client, userId);
  } else {
    const hint = remaining === Infinity ? "请重试。" : `请重试（剩余次数：${remaining}）`;
    try {
      const hintMsg = await client.sendMessage(peerTarget(userId), { message: `❌ 答案错误，${htmlEscape(hint)}`, parseMode: "html" });
      if (!isStateCurrent(state)) return;
      state.msgIds.push(hintMsg.id);
    } catch { /* send failed, ignore */ }
  }
}

// ─── 自动过白规则检查 ─────────────────────────────────────────────────────────

/** 结果类型：pass=自动通过, block=自动拦截, skip=继续下一规则 */
type AutoRuleResult = "pass" | "block" | "skip";

/**
 * 1. 主动对话过白 (initiative)
 *    当我方主动发起私聊时，对方自动加入白名单。
 *    此规则在 message.out 分支中已内置处理，此处仅作为占位标识。
 *    实际逻辑在 messageListener 的 message.out 分支中。
 */

/**
 * 2. 聊天记录过白 (chat_history)
 *    用户历史消息数 >= N 时自动通过
 */
async function checkChatHistory(client: TelegramClient, userId: number, currentMsgId: number): Promise<AutoRuleResult> {
  const threshold = cfg.historyCount();
  if (threshold <= 0) return "skip"; // 禁用

  try {
    // 获取与该用户的聊天记录（排除当前消息）
    const messages = await client.getMessages(peerTarget(userId), { limit: threshold + 1 });
    let count = 0;
    for (const msg of messages) {
      if (msg.id !== currentMsgId) count++;
    }
    if (count >= threshold) {
      wl.add(userId);
      logger.info( `Auto-pass user ${userId} by chat_history (${count} >= ${threshold})`);
      return "pass";
    }
  } catch (e) {
    logger.warn( `checkChatHistory failed for ${userId}`, e);
  }
  return "skip";
}

/**
 * 3. 共同群过白 (groups_in_common)
 *    用户与自己的共同群 >= N 个时自动通过
 */
async function checkGroupsInCommon(client: TelegramClient, userId: number): Promise<AutoRuleResult> {
  const threshold = cfg.groupsInCommon();
  if (threshold < 0) return "skip"; // 禁用

  try {
    const result = await client.invoke(
      new Api.users.GetFullUser({ id: peerTarget(userId) })
    ) as any;
    const commonChatsCount = result?.fullUser?.commonChatsCount ?? 0;
    if (commonChatsCount >= threshold) {
      wl.add(userId);
      logger.info( `Auto-pass user ${userId} by groups_in_common (${commonChatsCount} >= ${threshold})`);
      return "pass";
    }
  } catch (e) {
    logger.warn( `checkGroupsInCommon failed for ${userId}`, e);
  }
  return "skip";
}

/**
 * 4. 关键词过白 (word_filter)
 *    消息包含白名单关键词 → 自动通过
 *    消息包含黑名单关键词 → 自动拦截
 */
async function checkWordFilter(client: TelegramClient, userId: number, message: Api.Message): Promise<AutoRuleResult> {
  const text = message.text || (message as any).caption || "";
  if (!text) return "skip";

  // 白名单关键词检查
  const wlWords = cfg.wlWords();
  if (wlWords.length > 0) {
    for (const word of wlWords) {
      if (text.includes(word)) {
        wl.add(userId);
        logger.info( `Auto-pass user ${userId} by whitelist word: "${word}"`);
        return "pass";
      }
    }
  }

  // 黑名单关键词检查
  const blWords = cfg.blWords();
  if (blWords.length > 0) {
    for (const word of blWords) {
      if (text.includes(word)) {
        logger.info( `Auto-block user ${userId} by blacklist word: "${word}"`);
        return "block";
      }
    }
  }

  return "skip";
}

/**
 * 5. Premium 用户处理 (premium)
 *    allow: Premium 用户自动通过
 *    ban:   Premium 用户自动拦截
 *    only:  仅允许 Premium 用户（非 Premium 自动拦截）
 *    none:  不做特殊处理
 */
async function checkPremium(client: TelegramClient, userId: number, message: Api.Message): Promise<AutoRuleResult> {
  const strategy = cfg.premium();
  if (strategy === "none") return "skip";

  // 获取用户 premium 状态
  const sender = (message as any).sender ?? (message as any)._sender;
  let isPremium = false;
  if (sender) {
    isPremium = !!(sender.premium);
  } else {
    try {
      const result = await client.invoke(
        new Api.users.GetFullUser({ id: peerTarget(userId) })
      ) as any;
      isPremium = !!(result?.users?.[0]?.premium);
    } catch (e) {
      logger.warn( `checkPremium: cannot get premium status for ${userId}`, e);
      return "skip";
    }
  }

  switch (strategy) {
    case "allow":
      if (isPremium) {
        wl.add(userId);
        logger.info( `Auto-pass Premium user ${userId} (strategy=allow)`);
        return "pass";
      }
      return "skip";

    case "ban":
      if (isPremium) {
        logger.info( `Auto-block Premium user ${userId} (strategy=ban)`);
        return "block";
      }
      return "skip";

    case "only":
      if (!isPremium) {
        logger.info( `Auto-block non-Premium user ${userId} (strategy=only)`);
        return "block";
      }
      wl.add(userId);
      logger.info( `Auto-pass Premium user ${userId} (strategy=only)`);
      return "pass";

    default:
      return "skip";
  }
}

/**
 * 执行所有自动过白规则（按优先级顺序）
 * 返回 true 表示已处理（通过或拦截），messageListener 应直接返回
 * 返回 false 表示继续走验证码流程
 */
async function runAutoRules(client: TelegramClient, userId: number, message: Api.Message): Promise<boolean> {
  // 规则 1: initiative 已在 message.out 分支中处理

  // 规则 2: 聊天记录过白
  const historyResult = await checkChatHistory(client, userId, message.id);
  if (historyResult === "pass") return true;
  if (historyResult === "block") {
    await executeBlockActions(client, userId);
    return true;
  }

  // 规则 3: 共同群过白
  const groupsResult = await checkGroupsInCommon(client, userId);
  if (groupsResult === "pass") return true;
  if (groupsResult === "block") {
    await executeBlockActions(client, userId);
    return true;
  }

  // 规则 4: 关键词过白 / 黑名单拦截
  const wordResult = await checkWordFilter(client, userId, message);
  if (wordResult === "pass") return true;
  if (wordResult === "block") {
    await executeBlockActions(client, userId);
    return true;
  }

  // 规则 5: Premium 用户策略
  const premiumResult = await checkPremium(client, userId, message);
  if (premiumResult === "pass") return true;
  if (premiumResult === "block") {
    await executeBlockActions(client, userId);
    return true;
  }

  return false; // 所有规则都未触发，继续正常验证流程
}

/**
 * 执行自动拦截操作（黑名单/Premium ban 等触发时）
 * 复用 captcha 失败的操作逻辑
 */
async function executeBlockActions(client: TelegramClient, userId: number) {
  try {
    await archiveChat(client, userId);
    await muteChat(client, userId);
    const actions = cfg.failActions();
    for (const action of actions) {
      switch (action) {
        case FailAction.BLOCK:
          try { await client.invoke(new Api.contacts.Block({ id: peerTarget(userId) })); } catch { /* block failed, ignore */ }
          break;
        case FailAction.REPORT:
          try { await client.invoke(new Api.account.ReportPeer({ peer: peerTarget(userId), reason: new Api.InputReportReasonSpam(), message: "" })); } catch { /* report failed, ignore */ }
          break;
        case FailAction.DELETE:
          try { await client.invoke(new Api.messages.DeleteHistory({ peer: peerTarget(userId), maxId: 0, justClear: false, revoke: true })); } catch { /* delete failed, ignore */ }
          break;
      }
    }
    const name = await getDisplayName(client, userId).catch(() => String(userId));
    rec.addFailed(userId, name, "max_tries", usernameCache.get(userId));
    logger.info( `Auto-block actions executed for user ${userId}`);
  } catch (e) {
    logger.error( `executeBlockActions failed for ${userId}`, e);
  }
}

// ─── 消息监听 ─────────────────────────────────────────────────────────────────

async function messageListener(message: Api.Message) {
  if (!getActiveLifecycle()) return;
  if (!(await waitDb())) return;
  try {
    const client = message.client as TelegramClient;
    if (!message.isPrivate) return;
    if (!cfg.pluginOn())    return;

    // ── 新增：跳过 Telegram 官方服务号 ─────────────────
    const TELEGRAM_OFFICIAL_IDS = [777000];   // 官方账号 ID 列表（可扩展）
    const senderId = Number(message.senderId);
    if (TELEGRAM_OFFICIAL_IDS.includes(senderId)) {
      logger.info( `Skipping Telegram official service ID ${senderId}`);
      return;
    }
    // ─────────────────────────────────────────────────

    if (message.out) {
      const selfId   = await getSelfId(client);
      const peerId   = (message.peerId as any)?.userId;
      const targetId = peerId ? Number(peerId) : 0;
      if (targetId > 0 && targetId !== selfId) {
        // 同样跳过官方账号的自动标记
        if (TELEGRAM_OFFICIAL_IDS.includes(targetId)) {
          logger.info( `Not auto-verifying official service ID ${targetId}`);
          return;
        }
        if (states.has(targetId)) {
          logger.info( `Skip auto-verify ${targetId}: captcha pending`);
          return;
        }
        const alreadyVerified = cfg.verified().some(r => r.id === targetId);
        if (!alreadyVerified && !wl.has(targetId)) {
          const sender = (message as any).sender ?? (message as any)._sender;
          if (sender) cacheUserFromSender(sender);
          const name = await getDisplayName(client, targetId).catch(() => String(targetId));
          rec.addVerified(targetId, name, usernameCache.get(targetId));
          logger.info( `Auto-verified ${targetId} (we initiated chat)`);
        }
      }
      return;
    }

    const userId = Number(message.senderId);
    if (!userId || userId <= 0) return;

    const selfId = await getSelfId(client);
    if (selfId && userId === selfId) return;

    // 再次检查官方 ID（覆盖可能遗漏的场景）
    if (TELEGRAM_OFFICIAL_IDS.includes(userId)) return;

    let sender = (message as any).sender ?? (message as any)._sender;
    if (!sender) {
      try { sender = await (message as any).getSender?.(); } catch { /* getSender failed, ignore */ }
    }
    if (sender) cacheUserFromSender(sender);
    await cachePeerFromMessage(message, userId);

    const botFlag = sender ? isBotFromSender(sender) : await isBot(client, userId);
    if (botFlag) return;

    if (wl.has(userId)) return;

    if (states.has(userId)) {
      await handleReply(client, userId, message.text || "", message.id);
      return;
    }

    if (cfg.verified().some(r => r.id === userId)) return;

    // ── 运行自动过白规则 ──
    if (await runAutoRules(client, userId, message)) return;

    await archiveChat(client, userId);
    await muteChat(client, userId);
    if (cfg.captchaOn()) {
      await sendCaptcha(client, userId);
    }
  } catch (e) {
    logger.error( "Listener error", e);
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async function resolveUser(client: TelegramClient, arg: string): Promise<number | null> {
  if (/^\d+$/.test(arg)) {
    const id = parseInt(arg);
    fetchUserInfo(client, id).catch(() => {});
    return id > 0 ? id : null;
  }
  try {
    const username = arg.replace(/^@/, "");
    const res = await client.invoke(new Api.contacts.ResolveUsername({ username })) as any;
    const user = res?.users?.[0];
    if (user && !(user instanceof Api.UserEmpty)) {
      cacheUserFromSender(user);
      return Number(user.id);
    }
    return null;
  } catch { return null; }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

// ─── 帮助文本 ─────────────────────────────────────────────────────────────────

function helpText(section?: string): string {
  const p = htmlEscape(mainPrefix);

  const sections: Record<string, string> = {

    overview: `<b>🔒 PMCaptcha v${PLUGIN_VERSION} 帮助</b>

自动拦截陌生人私聊，发送验证题，通过后放行，失败后执行屏蔽/举报等操作 ⛑️

<b>📌 快速开始（按顺序执行）：</b>
1️⃣ <code>${p}pmc on</code> - 启用插件
2️⃣ <code>${p}pmc captcha on</code> - 开启验证功能
3️⃣ <code>${p}pmc captcha math</code> - 选择验证模式
4️⃣ <code>${p}pmc set fail 屏蔽</code> - 设置失败后动作

<b>🔧 基础操作：</b>
<blockquote expandable>• <code>${p}pmc on</code> / <code>off</code>
  启用或禁用插件（关闭时验证设置保留不变）
• <code>${p}pmc status</code>
  查看完整配置与运行状态
• <code>${p}pmc h basic</code> / <code>captcha</code> / <code>set</code> / <code>wl</code> / <code>record</code>
  查看分类帮助（见下方）</blockquote>

<b>🔐 验证设置：</b>
<blockquote expandable>• <code>${p}pmc captcha on</code> / <code>off</code>
  开启或关闭验证功能
• <code>${p}pmc captcha math</code>
  算术验证（默认，随机四则运算/幂运算，无需额外依赖）
• <code>${p}pmc captcha text</code>
  关键词验证（需回复指定词，或内置随机问答）
• <code>${p}pmc captcha img_digit</code>
  图片验证码（5位纯数字，自动安装 canvas）
• <code>${p}pmc captcha img_mixed</code>
  图片验证码（5位字母+数字，自动安装 canvas）</blockquote>

<b>⚙️ 参数设置：</b>
<blockquote expandable>• <code>${p}pmc set time <秒></code>
  验证超时（0 = 不限时，默认 30）
• <code>${p}pmc set tries <次></code>
  最大尝试次数（0 = 不限，默认 3）
• <code>${p}pmc set keyword <关键词></code>
  文字模式关键词（默认"我同意"）
• <code>${p}pmc set prompt <文本></code>
  自定义验证提示（留空恢复默认）
  └ math 模式：{question} → 题目占位符
  └ text 模式：{keyword} → 关键词占位符
• <code>${p}pmc set fail 屏蔽/删除/举报/静音/归档/无</code>
  失败后动作（可多选，空格分隔）
  示例：<code>${p}pmc set fail 屏蔽 举报</code>
• <code>${p}pmc set pass 取消静音/取消归档/白名单/无</code>
  通过后动作（可多选）
  ⚠️ 修改后正在进行中的验证消息实时更新</blockquote>

<b>👥 白名单管理：</b>
<blockquote expandable>• <code>${p}pmc add <ID/@user></code>
  添加白名单（支持回复消息）
• <code>${p}pmc del <ID/@user></code>
  移除白名单
• <code>${p}pmc wl</code>
  查看白名单列表
• <code>${p}pmc wl add <ID/@user></code>
  同 add（支持回复消息）
• <code>${p}pmc wl del <ID/@user></code>
  同 del
• <code>${p}pmc wl del all</code>
  清空白名单
• <code>${p}pmc wl pass <ID/@user></code>
  手动标记通过并加入白名单</blockquote>

<b>📋 验证记录：</b>
<blockquote expandable>• <code>${p}pmc record</code>
  通过/失败人数摘要
• <code>${p}pmc record verified</code>
  查看验证通过记录
• <code>${p}pmc record failed</code>
  查看验证失败记录
• <code>${p}pmc record del verified <ID>/all</code>
  删除通过记录
• <code>${p}pmc record del failed <ID>/all</code>
  删除失败记录</blockquote>

<b>🤖 自动过白规则：</b>
<blockquote expandable>优先级顺序依次检查（有规则触发即停止）：
1️⃣ 主动对话 — 我方主动发起私聊时对方自动通过
2️⃣ 聊天记录 — 用户历史消息数 ≥ N 时自动通过
3️⃣ 共同群 — 用户与自己的共同群 ≥ N 个时自动通过
4️⃣ 关键词 — 消息包含白名单词自动通过，黑名单词自动拦截
5️⃣ Premium — 根据策略自动通过/拦截 Premium 用户

• <code>${p}pmc set initiative on/off</code> — 启用/禁用主动对话过白
• <code>${p}pmc set history &lt;N&gt;</code> — 聊天记录过白（-1=禁用）
• <code>${p}pmc set groups &lt;N&gt;</code> — 共同群过白（-1=禁用）
• <code>${p}pmc set wl-words &lt;词1 词2…&gt;</code> — 白名单关键词
• <code>${p}pmc set bl-words &lt;词1 词2…&gt;</code> — 黑名单关键词
• <code>${p}pmc set premium allow/ban/only/none</code> — Premium 策略</blockquote>

<b>ℹ️ 使用说明：</b>
• 验证失败默认执行静音+归档
• 我方主动发起对话时对方自动通过验证
• 支持中/英文设置（如：屏蔽/block）
• 自动过白规则按优先级检查，任何规则触发立即处理`,

    basic: `<b>🔒 基础命令</b>

<blockquote expandable>• <code>${p}pmc on</code> / <code>off</code>
  启用或禁用插件（关闭时验证设置保留不变）
• <code>${p}pmc status</code>
  查看完整配置与运行状态

ℹ️ <code>off</code> 只停用插件本身，不会重置验证（captcha）的开关状态，
   下次 <code>on</code> 后验证功能恢复到关闭前的状态。</blockquote>`,

    captcha: `<b>🔐 验证设置</b>

<blockquote expandable><b>开关</b>
• <code>${p}pmc captcha on</code> / <code>off</code>
  开启或关闭验证功能

<b>模式</b>
• <code>${p}pmc captcha math</code>
  算术验证（默认，随机四则运算/幂运算，无需额外依赖）
• <code>${p}pmc captcha text</code>
  关键词验证（需回复指定词，或内置随机问答）
• <code>${p}pmc captcha img_digit</code>
  图片验证码（5位纯数字，自动安装 canvas）
• <code>${p}pmc captcha img_mixed</code>
  图片验证码（5位字母+数字，自动安装 canvas）</blockquote>`,

    set: `<b>⚙️ 参数设置</b>

<blockquote expandable><b>验证参数</b>
• <code>${p}pmc set time &lt;秒&gt;</code>
  验证超时（0 = 不限时，默认 30）
• <code>${p}pmc set tries &lt;次&gt;</code>
  最大尝试次数（0 = 不限，默认 3）
• <code>${p}pmc set keyword &lt;关键词&gt;</code>
  文字模式关键词（默认"我同意"）
• <code>${p}pmc set prompt &lt;文本&gt;</code>
  自定义验证提示（留空恢复默认）
  └ math 模式：<code>{question}</code> → 题目占位符
  └ text 模式：<code>{keyword}</code> → 关键词占位符

<b>失败/通过操作</b>（可复选，空格分隔）
• <code>${p}pmc set fail block</code> / <code>屏蔽</code> — 屏蔽用户
• <code>${p}pmc set fail delete</code> / <code>删除</code> — 双方撤回全部对话
• <code>${p}pmc set fail report</code> / <code>举报</code> — 举报为垃圾信息
• <code>${p}pmc set fail mute</code> / <code>静音</code> — 永久静音（默认已执行）
• <code>${p}pmc set fail archive</code> / <code>归档</code> — 归档（默认已执行）
• <code>${p}pmc set pass unmute</code> / <code>取消静音</code> — 验证通过后取消静音
• <code>${p}pmc set pass unarchive</code> / <code>取消归档</code> — 验证通过后取消归档
• <code>${p}pmc set pass wl</code> / <code>白名单</code> — 验证通过后加入白名单
  ✏️ 示例：<code>${p}pmc set fail 屏蔽 举报</code>、<code>${p}pmc set pass 取消静音</code>
  ℹ️ 修改后正在进行中的验证消息实时更新

<b>自动过白规则</b>（优先级依次检查）
• <code>${p}pmc set initiative on/off</code>
  主动对话过白（默认 on）— 我方主动发起私聊时对方自动通过
• <code>${p}pmc set history &lt;数字&gt;</code>
  聊天记录过白（-1=禁用）— 用户历史消息数 ≥ N 时自动通过
• <code>${p}pmc set groups &lt;数字&gt;</code>
  共同群过白（-1=禁用）— 用户与自己的共同群 ≥ N 个时自动通过
• <code>${p}pmc set wl-words &lt;词1 词2…&gt;</code>
  白名单关键词 — 消息包含这些词时自动通过（none清空）
• <code>${p}pmc set bl-words &lt;词1 词2…&gt;</code>
  黑名单关键词 — 消息包含这些词时自动拦截（none清空）
• <code>${p}pmc set premium allow/ban/only/none</code>
  Premium 用户策略
  └ allow: Premium 用户自动通过 / ban: Premium 用户自动拦截
  └ only: 仅允许 Premium 用户 / none: 不做特殊处理（默认）</blockquote>`,

    wl: `<b>👥 白名单管理</b>

<blockquote expandable>• <code>${p}pmc add &lt;ID/@user&gt;</code>
  添加白名单（支持回复消息）
• <code>${p}pmc del &lt;ID/@user&gt;</code>
  移除白名单
• <code>${p}pmc wl</code>
  查看白名单列表
• <code>${p}pmc wl add &lt;ID/@user&gt;</code>
  同 add（支持回复消息）
• <code>${p}pmc wl del &lt;ID/@user&gt;</code>
  同 del
• <code>${p}pmc wl del all</code>
  清空白名单
• <code>${p}pmc wl pass &lt;ID/@user&gt;</code>
  手动标记为验证通过并加入白名单</blockquote>`,

    record: `<b>📋 验证记录</b>

<blockquote expandable>• <code>${p}pmc record</code>
  通过/失败人数摘要
• <code>${p}pmc record verified</code>
  查看验证通过记录
• <code>${p}pmc record failed</code>
  查看验证失败记录
• <code>${p}pmc record del verified &lt;ID&gt;/all</code>
  删除通过记录（支持 all）
• <code>${p}pmc record del failed &lt;ID&gt;/all</code>
  删除失败记录（支持 all）</blockquote>`
  };

  if (section && sections[section]) return sections[section];
  return sections.overview;
}

// ─── 指令处理器（统一入口）────────────────────────────────────────────────────

const pmcaptcha = async (message: Api.Message) => {
  if (!getActiveLifecycle()) return;
  if (!(await waitDb())) return;
  const client  = message.client as TelegramClient;
  const args    = message.message.slice(1).split(/\s+/).slice(1);
  const command = (args[0] || "help").toLowerCase();

  // ── on / off：启用 / 禁用插件 ────────────────────────────────────────────────
  // 注意：off 只停用插件本身，不重置 captcha 状态，下次 on 后自动恢复
  if (command === "on" || command === "off") {
    const enabling = command === "on";
    set(K.ENABLED, enabling);
    // ⚠️ 不再自动关闭 captcha_enabled，保留验证配置状态
    try {
      const tmp = await client.sendMessage(message.peerId, {
        message: enabling
          ? "✅ <b>PMCaptcha 已启用</b>"
          : `🚫 <b>PMCaptcha 已禁用</b>\n验证配置已保留，下次启用后自动恢复`,
        parseMode: "html"
      });
      try { await message.delete(); } catch { /* delete failed, ignore */ }
      getActiveLifecycle()?.setTimeout(() => {
        void tmp.delete().catch(() => undefined);
      }, 3000, { label: "pmcaptcha-command-cleanup" });
    } catch (e) { logger.error( "pmc on/off error", e); }
    return;
  }

  const edit = async (text: string) => {
    try {
      await client.editMessage(message.peerId, {
        message:     message.id,
        text,
        parseMode:   "html",
        linkPreview: false
      });
    } catch (e: any) {
      if (String(e).includes("Could not find the input entity")) {
        try { await message.reply({ message: text, parseMode: "html", linkPreview: false }); } catch { /* reply failed, ignore */ }
      } else {
        throw e;
      }
    }
  };

  try {
    switch (command) {

      // ╔══════════════════════════════╗
      // ║  帮助  (.pmc h [section]) ║
      // ╚══════════════════════════════╝

      case "help": case "h": case "?": case "": {
        const section = args[1]?.toLowerCase();
        await edit(helpText(section));
        break;
      }

      // ╔══════════════════════════════╗
      // ║  状态  (.pmc status)         ║
      // ╚══════════════════════════════╝

      case "status": {
        const fa  = cfg.failActions();
        const pa  = cfg.passActions();
        const rawMode = get<string>(K.CAP_MODE, CaptchaMode.MATH);
        const modeInvalid = !(Object.values(CaptchaMode) as string[]).includes(rawMode);
        
        // 自动过白规则状态
        const autoRulesStatus = [
          cfg.initiative() ? "✅ 主动对话" : undefined,
          cfg.historyCount() > 0 ? `✅ 聊天记录(${cfg.historyCount()})` : undefined,
          cfg.groupsInCommon() > 0 ? `✅ 共同群(${cfg.groupsInCommon()})` : undefined,
          cfg.wlWords().length > 0 ? `✅ 白词(${cfg.wlWords().length})` : undefined,
          cfg.blWords().length > 0 ? `✅ 黑词(${cfg.blWords().length})` : undefined,
          cfg.premium() !== "none" ? `✅ Premium` : undefined,
        ].filter(Boolean).join(" | ");
        
        await edit(
          `📊 <b>PMCaptcha v${PLUGIN_VERSION}</b>\n\n` +
          `<b>核心设置</b>\n` +
          `• 插件：${cfg.pluginOn() ? "✅ 启用" : "🚫 禁用"}\n` +
          `• 验证：${cfg.captchaOn() ? "✅ 开启" : "❌ 关闭（默认）"}\n` +
          `• 模式：${htmlEscape(modeLabel(cfg.mode()))}${modeInvalid ? " ⚠️ 原设置无效已自动降级" : ""}\n` +
          `• 超时：${htmlEscape(cfg.timeout() > 0 ? cfg.timeout() + " 秒" : "不限")}\n` +
          `• 最大次数：${htmlEscape(cfg.maxTries() > 0 ? cfg.maxTries() + " 次" : "不限")}\n\n` +
          `<b>动作配置</b>\n` +
          `• 失败操作：${htmlEscape(fa.length ? fa.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、") : "仅归档静音")}\n` +
          `• 通过操作：${htmlEscape(pa.length ? pa.map(a => PASS_ACTION_LABEL[a] ?? a).join("、") : "无")}\n` +
          `• 文字关键词：${codeTag(cfg.keyword())}\n\n` +
          `<b>自动过白规则</b>\n` +
          `${autoRulesStatus || "（全部禁用）"}\n` +
          `• 主动对话：${cfg.initiative() ? "✅" : "❌"}\n` +
          `• 聊天记录：${cfg.historyCount() > 0 ? `✅ ≥${cfg.historyCount()}条` : "❌"}\n` +
          `• 共同群：${cfg.groupsInCommon() > 0 ? `✅ ≥${cfg.groupsInCommon()}个` : "❌"}\n` +
          `• 白名单词：${cfg.wlWords().length} 个\n` +
          `• 黑名单词：${cfg.blWords().length} 个\n` +
          `• Premium策略：${PREMIUM_LABEL[cfg.premium()]}\n\n` +
          `<b>统计信息</b>\n` +
          `• 白名单：${htmlEscape(cfg.whitelist().length)} 人\n` +
          `• 待验证：${htmlEscape(states.size)} 人\n` +
          `• 通过记录：${htmlEscape(cfg.verified().length)}\n` +
          `• 失败记录：${htmlEscape(cfg.failed().length)}\n` +
          `• 数据文件：${codeTag(path.join(dataDir, "pmcaptcha_data.json"))}`
        );
        break;
      }

      // ╔══════════════════════════════════════╗
      // ║  验证开关 & 模式  (.pmc captcha …)   ║
      // ╚══════════════════════════════════════╝

      case "captcha": {
        const sub = args[1]?.toLowerCase();

        // on / off
        if (sub === "on" || sub === "off") {
          set(K.CAP_ENABLED, sub === "on");
          await edit(sub === "on" ? "✅ 验证功能已开启" : "❌ 验证功能已关闭");
          break;
        }

        // 直接用模式名作为三级命令（math / text / img_digit / img_mixed）
        const validModes = Object.values(CaptchaMode) as string[];
        if (sub && validModes.includes(sub)) {
          set(K.CAP_MODE, sub);
          await edit(`✅ 验证模式：<b>${htmlEscape(modeLabel(sub as CaptchaMode))}</b>`);
          break;
        }

        // mode &lt;模式&gt; 别名
        if (sub === "mode") {
          const m = args[2]?.toLowerCase();
          if (!m || !validModes.includes(m as CaptchaMode)) {
            const current = cfg.mode();
            await edit(
              `当前模式：<b>${htmlEscape(modeLabel(current))}</b>（${codeTag(current)}）\n\n` +
              `可用模式：\n` +
              `<code>math</code>      — 算术验证（默认）\n` +
              `<code>text</code>      — 关键词验证\n` +
              `<code>img_digit</code> — 图片验证（纯数字）\n` +
              `<code>img_mixed</code> — 图片验证（字母+数字）\n\n` +
              `用法：<code>${mainPrefix}pmc captcha &lt;模式&gt;</code>`
            );
            break;
          }
          set(K.CAP_MODE, m);
          await edit(`✅ 验证模式：<b>${htmlEscape(modeLabel(m as CaptchaMode))}</b>`);
          break;
        }

        // 无子命令：显示当前验证状态
        await edit(
          `验证功能：${cfg.captchaOn() ? "✅ 开启" : "❌ 关闭"}\n` +
          `当前模式：<b>${htmlEscape(modeLabel(cfg.mode()))}</b>\n\n` +
          `<code>${mainPrefix}pmc captcha on/off</code>           — 开关验证\n` +
          `<code>${mainPrefix}pmc captcha math</code>             — 算术验证\n` +
          `<code>${mainPrefix}pmc captcha text</code>             — 关键词验证\n` +
          `<code>${mainPrefix}pmc captcha img_digit</code>        — 图片验证（纯数字）\n` +
          `<code>${mainPrefix}pmc captcha img_mixed</code>        — 图片验证（字母+数字）\n\n` +
          ``
        );
        break;
      }

      // ╔══════════════════════════════════╗
      // ║  参数设置  (.pmc set …)          ║
      // ╚══════════════════════════════════╝

      case "set": {
        const param = args[1]?.toLowerCase();
        const val   = args.slice(2).join(" ").trim();

        if (!param) {
          await edit(
            `❌ 用法：<code>${mainPrefix}pmc set &lt;参数&gt; &lt;值&gt;</code>\n\n` +
            `<b>验证参数</b>\n` +
            `<code>time</code>     — 验证超时秒数（0=不限，默认 30）\n` +
            `<code>tries</code>    — 最大尝试次数（0=不限，默认 3）\n` +
            `<code>keyword</code>  — 文字模式关键词\n` +
            `<code>prompt</code>   — 自定义提示语（留空恢复默认）\n` +
            `<code>fail</code>     — 失败操作（支持中文，如：屏蔽/删除/举报/静音/归档）\n` +
            `<code>pass</code>     — 通过操作（支持中文，如：取消静音/取消归档/白名单）\n\n` +
            `<b>自动过白规则</b>\n` +
            `<code>initiative</code> — 主动对话过白 (on/off)\n` +
            `<code>history</code>    — 聊天记录过白 (数字 或 -1禁用)\n` +
            `<code>groups</code>     — 共同群过白 (数字 或 -1禁用)\n` +
            `<code>wl-words</code>   — 白名单关键词 (空格分隔 或 none清空)\n` +
            `<code>bl-words</code>   — 黑名单关键词 (空格分隔 或 none清空)\n` +
            `<code>premium</code>    — Premium用户策略 (allow/ban/only/none)\n\n` +
            ``
          );
          break;
        }

        switch (param) {

          // ── time / timeout ─────────────────────────────────────────────────
          case "time":
          case "timeout": {
            const n = parseInt(val);
            if (isNaN(n) || n < 0) {
              await edit(`❌ 用法：<code>${mainPrefix}pmc set time &lt;秒&gt;</code>（0 = 不限时）`);
              break;
            }
            set(K.CAP_TIMEOUT, n);
            await edit(`✅ 验证超时：<b>${htmlEscape(n > 0 ? n + " 秒" : "不限")}</b>`);
            // 刷新正在进行中的验证消息
            await refreshActiveCaptchas(client);
            break;
          }

          // ── tries ──────────────────────────────────────────────────────────
          case "tries": {
            const n = parseInt(val);
            if (isNaN(n) || n < 0) {
              await edit(`❌ 用法：<code>${mainPrefix}pmc set tries &lt;次&gt;</code>（0 = 不限次数）`);
              break;
            }
            set(K.CAP_TRIES, n);
            await edit(`✅ 最大尝试次数：<b>${htmlEscape(n > 0 ? n + " 次" : "不限")}</b>`);
            await refreshActiveCaptchas(client);
            break;
          }

          // ── keyword ────────────────────────────────────────────────────────
          case "keyword": {
            if (!val) {
              await edit(`❌ 用法：<code>${mainPrefix}pmc set keyword &lt;关键词&gt;</code>`);
              break;
            }
            set(K.CAP_KEYWORD, val);
            await edit(`✅ 文字关键词：${codeTag(val)}`);
            break;
          }

          // ── prompt ─────────────────────────────────────────────────────────
          case "prompt": {
            set(K.CAP_PROMPT, val);
            await edit(val
              ? `✅ 自定义提示语已设置\n占位符：math 模式用 <code>{question}</code>，text 模式用 <code>{keyword}</code>`
              : "✅ 提示语已恢复默认");
            break;
          }

          // ── fail ───────────────────────────────────────────────────────────
          case "fail": {
            const subs = args.slice(2).filter(Boolean);
            if (!subs.length) {
              await edit(
                `❌ 用法：<code>${mainPrefix}pmc set fail &lt;操作…&gt;</code>（空格分隔，可复选）\n\n` +
                `英文 / 中文 均可：\n` +
                `<code>block</code>   / <code>屏蔽</code>   — 屏蔽用户\n` +
                `<code>delete</code>  / <code>删除</code>   — 双方撤回全部对话\n` +
                `<code>report</code>  / <code>举报</code>   — 举报为垃圾信息\n` +
                `<code>mute</code>    / <code>静音</code>   — 永久静音（失败时默认已执行）\n` +
                `<code>archive</code> / <code>归档</code>   — 归档（失败时默认已执行）\n` +
                `<code>none</code>    / <code>无</code>     — 清除所有额外操作\n\n` +
                `示例：<code>${mainPrefix}pmc set fail 屏蔽 举报</code>`
              );
              break;
            }
            if (subs.some(s => s.toLowerCase() === "none" || s === "无")) {
              set(K.CAP_ACTIONS, []);
              await edit("✅ 失败额外操作已清除（仅归档静音）");
              await refreshActiveCaptchas(client);
              break;
            }
            const valid: FailAction[] = [];
            const bad: string[]       = [];
            for (const s of subs) {
              const resolved = resolveFailAction(s);
              if (resolved) valid.push(resolved);
              else bad.push(s);
            }
            if (bad.length) {
              await edit(
                `❌ 无效操作：${codeTag(bad.join("、"))}\n\n` +
                `可用（英文/中文）：block/屏蔽、delete/删除、report/举报、mute/静音、archive/归档、none/无`
              );
              break;
            }
            set(K.CAP_ACTIONS, valid);
            await edit(`✅ 验证失败将执行：<b>${htmlEscape(valid.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、"))}</b>`);
            // 同步刷新正在进行的验证消息
            await refreshActiveCaptchas(client);
            break;
          }

          // ── pass ───────────────────────────────────────────────────────────
          case "pass": {
            const subs = args.slice(2).filter(Boolean);
            if (!subs.length) {
              await edit(
                `❌ 用法：<code>${mainPrefix}pmc set pass &lt;操作…&gt;</code>（可复选）\n\n` +
                `英文 / 中文 均可：\n` +
                `<code>unmute</code>    / <code>取消静音</code>   — 验证通过后取消静音\n` +
                `<code>unarchive</code> / <code>取消归档</code>   — 验证通过后取消归档\n` +
                `<code>wl</code>        / <code>白名单</code>     — 验证通过后加入白名单\n` +
                `<code>none</code>      / <code>无</code>         — 清除所有通过操作\n\n` +
                `示例：<code>${mainPrefix}pmc set pass 取消静音 取消归档</code>`
              );
              break;
            }
            if (subs.some(s => s.toLowerCase() === "none" || s === "无")) {
              set(K.CAP_PASS_ACTIONS, []);
              await edit("✅ 通过操作已清除");
              break;
            }
            const valid: PassAction[] = [];
            const bad: string[]       = [];
            for (const s of subs) {
              const resolved = resolvePassAction(s);
              if (resolved) valid.push(resolved);
              else bad.push(s);
            }
            if (bad.length) {
              await edit(
                `❌ 无效操作：${codeTag(bad.join("、"))}\n\n` +
                `可用（英文/中文）：unmute/取消静音、unarchive/取消归档、wl/白名单、none/无`
              );
              break;
            }
            set(K.CAP_PASS_ACTIONS, valid);
            await edit(`✅ 验证通过后将执行：<b>${htmlEscape(valid.map(a => PASS_ACTION_LABEL[a] ?? a).join("、"))}</b>`);
            break;
          }

          // ── 自动过白规则：主动对话 ────────────────────────────────────
          case "initiative": {
            const v = args[2]?.toLowerCase();
            if (!v || !["on", "off"].includes(v)) {
              await edit(
                `当前设置：${cfg.initiative() ? "✅ 启用" : "❌ 禁用"}\n\n` +
                `用法：<code>${mainPrefix}pmc set initiative on/off</code>\n\n` +
                `说明：启用后，当我方主动发起私聊时，对方自动加入白名单`
              );
              break;
            }
            set(K.INITIATIVE, v === "on");
            await edit(`✅ 主动对话过白：${v === "on" ? "✅ 已启用" : "❌ 已禁用"}`);
            break;
          }

          // ── 自动过白规则：聊天记录 ────────────────────────────────────
          case "history": {
            const n = parseInt(args[2] ?? "");
            if (isNaN(n) || n < -1) {
              await edit(
                `当前设置：${cfg.historyCount() > 0 ? cfg.historyCount() + " 条" : "❌ 禁用"}\n\n` +
                `用法：<code>${mainPrefix}pmc set history &lt;数字&gt;</code>\n` +
                `<code>${mainPrefix}pmc set history -1</code> — 禁用此规则\n\n` +
                `说明：用户历史消息数 ≥ 指定值时自动通过验证`
              );
              break;
            }
            set(K.HISTORY_COUNT, n);
            await edit(
              n > 0
                ? `✅ 聊天记录过白：历史消息数 ≥ <b>${n}</b> 条时自动通过`
                : `❌ 聊天记录过白：已禁用`
            );
            break;
          }

          // ── 自动过白规则：共同群 ───────────────────────────────────────
          case "groups": {
            const n = parseInt(args[2] ?? "");
            if (isNaN(n) || n < -1) {
              await edit(
                `当前设置：${cfg.groupsInCommon() > 0 ? cfg.groupsInCommon() + " 个" : "❌ 禁用"}\n\n` +
                `用法：<code>${mainPrefix}pmc set groups &lt;数字&gt;</code>\n` +
                `<code>${mainPrefix}pmc set groups -1</code> — 禁用此规则\n\n` +
                `说明：与用户共同所在的群 ≥ 指定值时自动通过验证`
              );
              break;
            }
            set(K.GROUPS_IN_COMMON, n);
            await edit(
              n > 0
                ? `✅ 共同群过白：共同群数 ≥ <b>${n}</b> 个时自动通过`
                : `❌ 共同群过白：已禁用`
            );
            break;
          }

          // ── 自动过白规则：关键词白名单 ─────────────────────────────────
          case "wl-words": case "wl_words": {
            const words = args.slice(2).filter(Boolean);
            if (!words.length) {
              const current = cfg.wlWords();
              await edit(
                `当前白名单关键词：${current.length > 0 ? current.map(w => codeTag(w)).join(" ") : "（无）"}\n\n` +
                `用法：<code>${mainPrefix}pmc set wl-words &lt;关键词1&gt; &lt;关键词2&gt; …</code>\n` +
                `<code>${mainPrefix}pmc set wl-words none</code> — 清空\n\n` +
                `说明：消息包含这些关键词时自动通过验证`
              );
              break;
            }
            if (words.some(w => w.toLowerCase() === "none")) {
              set(K.WL_WORDS, []);
              await edit("✅ 白名单关键词已清空");
              break;
            }
            set(K.WL_WORDS, words);
            await edit(`✅ 白名单关键词已设置：${words.map(w => codeTag(w)).join(" ")}`);
            break;
          }

          // ── 自动过白规则：关键词黑名单 ─────────────────────────────────
          case "bl-words": case "bl_words": {
            const words = args.slice(2).filter(Boolean);
            if (!words.length) {
              const current = cfg.blWords();
              await edit(
                `当前黑名单关键词：${current.length > 0 ? current.map(w => codeTag(w)).join(" ") : "（无）"}\n\n` +
                `用法：<code>${mainPrefix}pmc set bl-words &lt;关键词1&gt; &lt;关键词2&gt; …</code>\n` +
                `<code>${mainPrefix}pmc set bl-words none</code> — 清空\n\n` +
                `说明：消息包含这些关键词时自动拦截并执行失败操作`
              );
              break;
            }
            if (words.some(w => w.toLowerCase() === "none")) {
              set(K.BL_WORDS, []);
              await edit("✅ 黑名单关键词已清空");
              break;
            }
            set(K.BL_WORDS, words);
            await edit(`✅ 黑名单关键词已设置：${words.map(w => codeTag(w)).join(" ")}`);
            break;
          }

          // ── 自动过白规则：Premium 用户策略 ────────────────────────────
          case "premium": {
            const strategy = args[2]?.toLowerCase() as PremiumStrategy | undefined;
            if (!strategy || !PREMIUM_STRATEGIES.includes(strategy)) {
              const current = cfg.premium();
              await edit(
                `当前策略：<b>${PREMIUM_LABEL[current]}</b>\n\n` +
                `用法：<code>${mainPrefix}pmc set premium &lt;策略&gt;</code>\n\n` +
                `可用策略：\n` +
                `<code>allow</code> — Premium 用户自动通过\n` +
                `<code>ban</code>   — Premium 用户自动拦截\n` +
                `<code>only</code>  — 仅允许 Premium 用户（非 Premium 用户自动拦截）\n` +
                `<code>none</code>  — 不做特殊处理（默认）`
              );
              break;
            }
            set(K.PREMIUM, strategy);
            await edit(`✅ Premium 用户策略：<b>${PREMIUM_LABEL[strategy]}</b>`);
            break;
          }

          // ── 已废弃参数友好提示 ───────────────────────────────────────────
          case "ext-timeout": case "exttimeout":
            await edit(`❌ ext-timeout 已移除，请使用 <code>${mainPrefix}pmc set time</code>`);
            break;
          case "google-url": case "googleurl":
          case "cf-url":     case "cfurl":
          case "google-port": case "googleport":
          case "cf-port":    case "cfport":
          case "google-secret": case "googlesecret":
          case "cf-secret":  case "cfsecret":
          case "webhook-secret": case "webhooksecret":
          case "url":
            await edit("❌ Google / Cloudflare 验证功能已移除，此参数无效。");
            break;

          default:
            await edit(
              `❌ 未知三级命令：${codeTag(param)}\n\n` +
              `验证：<code>time</code>、<code>tries</code>、<code>keyword</code>、<code>prompt</code>、<code>fail</code>、<code>pass</code>\n` +
              `规则：<code>initiative</code>、<code>history</code>、<code>groups</code>、<code>wl-words</code>、<code>bl-words</code>、<code>premium</code>\n\n` +
              ``
            );
        }
        break;
      }

      // ╔══════════════════════════════════════════╗
      // ║  白名单快捷命令  (.pmc add / .pmc del)   ║
      // ╚══════════════════════════════════════════╝

      case "add": {
        // 二级命令 add：快捷白名单添加（等同 .pmc wl add）
        let tid: number | null = null;
        if (message.replyTo?.replyToMsgId) {
          try {
            const r = await safeGetMessages(client, message.peerId, { ids: [message.replyTo.replyToMsgId] });
            if (r[0]?.senderId) tid = Number(r[0].senderId);
          } catch { /* getMessages failed, ignore */ }
        }
        if (!tid && args[1]) tid = await resolveUser(client, args[1]);
        if (!tid || tid <= 0) {
          await edit(
            `❌ 用法：<code>${mainPrefix}pmc add &lt;ID/@user&gt;</code> 或回复对方消息\n\n` +
            `请提供有效的用户 ID 或用户名。`
          );
          break;
        }
        if (await isBot(client, tid)) { await edit("❌ 无法将机器人加入白名单"); break; }
        wl.add(tid);
        const name = await getDisplayName(client, tid);
        await edit(`✅ ${userLink(tid, name)} 已加入白名单`);
        break;
      }

      case "del": {
        // 二级命令 del：快捷白名单移除（等同 .pmc wl del）
        if (!args[1]) {
          await edit(`❌ 用法：<code>${mainPrefix}pmc del &lt;ID/@user&gt;</code>`);
          break;
        }
        const tid = await resolveUser(client, args[1]);
        if (!tid || tid <= 0) { await edit("❌ 无法解析目标用户"); break; }
        wl.del(tid);
        const delName = await getDisplayName(client, tid);
        await edit(`✅ ${userLink(tid, delName)} 已从白名单移除`);
        break;
      }

      // ╔══════════════════════════════╗
      // ║  白名单  (.pmc wl …)         ║
      // ╚══════════════════════════════╝

      case "wl":
      case "whitelist": {
        const sub = args[1]?.toLowerCase();

        // wl（无子命令）：列出白名单
        if (!sub) {
          const list = cfg.whitelist();
          if (!list.length) { await edit("📋 <b>白名单为空</b>"); break; }
          const rows: string[] = [];
          for (const id of list) {
            if (await isBot(client, id)) continue;
            const name     = await getDisplayName(client, id);
            rows.push(`• ${userLink(id, name)}`);
          }
          if (!rows.length) { await edit("📋 <b>白名单为空</b>"); break; }
          await edit(`📋 <b>白名单 (${rows.length})</b>\n\n${rows.join("\n")}`);
          break;
        }

        // wl add
        if (sub === "add") {
          let tid: number | null = null;
          if (message.replyTo?.replyToMsgId) {
            try {
              const r = await safeGetMessages(client, message.peerId, { ids: [message.replyTo.replyToMsgId] });
              if (r[0]?.senderId) tid = Number(r[0].senderId);
            } catch { /* getMessages failed, ignore */ }
          }
          if (!tid && args[2]) tid = await resolveUser(client, args[2]);
          if (!tid || tid <= 0) { await edit("❌ 请提供有效的用户 ID / 用户名，或回复用户消息"); break; }
          if (await isBot(client, tid)) { await edit("❌ 无法将机器人加入白名单"); break; }
          wl.add(tid);
          const name = await getDisplayName(client, tid);
          await edit(`✅ ${userLink(tid, name)} 已加入白名单`);
          break;
        }

        // wl del
        if (sub === "del") {
          if (args[2]?.toLowerCase() === "all") {
            wl.clear();
            await edit("✅ 白名单已清空");
            break;
          }
          if (!args[2]) { await edit(`❌ 用法：<code>${mainPrefix}pmc wl del &lt;ID/@user&gt;</code> 或 <code>del all</code>`); break; }
          const tid = await resolveUser(client, args[2]);
          if (!tid || tid <= 0) { await edit("❌ 无法解析目标用户"); break; }
          wl.del(tid);
          const delName = await getDisplayName(client, tid);
          await edit(`✅ ${userLink(tid, delName)} 已从白名单移除`);
          break;
        }

        // wl pass
        if (sub === "pass") {
          if (!args[2]) { await edit(`❌ 用法：<code>${mainPrefix}pmc wl pass &lt;ID/@user&gt;</code>`); break; }
          const tid = await resolveUser(client, args[2]);
          if (!tid || tid <= 0) { await edit("❌ 无法解析目标用户"); break; }
          const st = removeCaptchaState(tid);
          if (st) await cleanupCaptchaMessages(client, tid, st);
          wl.add(tid);
          const name = await getDisplayName(client, tid);
          rec.addVerified(tid, name, usernameCache.get(tid));
          rec.delFailed(tid);
          await edit(`✅ ${userLink(tid, name)} 已手动通过验证并加入白名单`);
          break;
        }

        await edit(
          `❌ 未知子命令：${codeTag(sub)}\n\n` +
          `可用：\n` +
          `<code>${mainPrefix}pmc add &lt;ID/@user&gt;</code>    — 快捷加入白名单\n` +
          `<code>${mainPrefix}pmc del &lt;ID/@user&gt;</code>    — 快捷移除白名单\n` +
          `<code>${mainPrefix}pmc wl</code>                  — 查看白名单\n` +
          `<code>${mainPrefix}pmc wl add &lt;ID/@user&gt;</code> — 加入白名单\n` +
          `<code>${mainPrefix}pmc wl del &lt;ID/@user&gt;</code> — 移除用户\n` +
          `<code>${mainPrefix}pmc wl del all</code>          — 清空白名单\n` +
          `<code>${mainPrefix}pmc wl pass &lt;ID/@user&gt;</code>— 手动标记通过\n\n` +
          ``
        );
        break;
      }

      // ╔══════════════════════════════╗
      // ║  验证记录  (.pmc record …)   ║
      // ╚══════════════════════════════╝

      case "record": {
        const sub  = args[1]?.toLowerCase();
        const sub2 = args[2]?.toLowerCase();
        const sub3 = args[3]?.toLowerCase();

        const rLbl: Record<FailedRecord["reason"], string> = {
          timeout:   "⏰ 超时",
          max_tries: "❌ 次数耗尽"
        };

        // record（无子命令）：摘要
        if (!sub) {
          const vList = cfg.verified();
          const fList = cfg.failed();
          await edit(
            `📋 <b>验证记录摘要</b>\n\n` +
            `✅ 通过：<b>${vList.length}</b> 人\n` +
            `❌ 失败：<b>${fList.length}</b> 人\n\n` +
            `<code>${mainPrefix}pmc record verified</code> — 查看通过列表\n` +
            `<code>${mainPrefix}pmc record failed</code>   — 查看失败列表`
          );
          break;
        }

        // record del <verified/failed> [&lt;ID&gt;/all]
        if (sub === "del") {
          const target = sub2;
          if (target !== "verified" && target !== "failed") {
            await edit(`❌ 用法：<code>${mainPrefix}pmc record del verified/failed [&lt;ID&gt;/all]</code>`);
            break;
          }
          const isV = target === "verified";
          if (!sub3 || sub3 === "all") {
            if (sub3 === "all") {
              isV ? rec.clearVerified() : rec.clearFailed();
              await edit(`✅ 所有${isV ? "通过" : "失败"}记录已清空`);
            } else {
              await edit(`❌ 用法：<code>${mainPrefix}pmc record del ${htmlEscape(target)} &lt;ID&gt;/all</code>`);
            }
            break;
          }
          const delId = parseInt(sub3);
          if (isNaN(delId) || delId <= 0) {
            await edit(`❌ 无效 ID：${codeTag(sub3)}`);
            break;
          }
          isV ? rec.delVerified(delId) : rec.delFailed(delId);
          await edit(`✅ 用户 <a href="tg://user?id=${attrEscape(delId)}">${htmlEscape(delId)}</a> 的${isV ? "通过" : "失败"}记录已删除`);
          break;
        }

        // record verified（白名单用户不在此显示）
        if (sub === "verified") {
          const list = cfg.verified();
          if (!list.length) { await edit("📋 <b>验证通过记录为空</b>"); break; }
          const wlSet = new Set(cfg.whitelist());
          const rows: string[] = [];
          for (const r of list) {
            if (wlSet.has(r.id)) continue;           // 白名单优先级更高，不重复显示
            if (await isBot(client, r.id)) continue;
            if (r.username) usernameCache.set(r.id, r.username);
            const name = await getDisplayName(client, r.id).catch(() => r.name);
            rows.push(`• ${userLink(r.id, name)}\n  <i>${htmlEscape(fmtTime(r.time))}</i>`);
          }
          if (!rows.length) { await edit("📋 <b>验证通过记录为空</b>"); break; }
          await edit(`✅ <b>验证通过 (${rows.length})</b>\n\n${rows.join("\n\n")}`);
          break;
        }

        // record failed（白名单/已验证通过的用户不在此显示）
        if (sub === "failed") {
          const list = cfg.failed();
          if (!list.length) { await edit("📋 <b>验证失败记录为空</b>"); break; }
          const wlSet       = new Set(cfg.whitelist());
          const verifiedSet = new Set(cfg.verified().map(v => v.id));
          const rows: string[] = [];
          for (const r of list) {
            if (wlSet.has(r.id))       continue;    // 白名单优先级最高
            if (verifiedSet.has(r.id)) continue;    // 已通过验证，优先级高于失败
            if (await isBot(client, r.id)) continue;
            if (r.username) usernameCache.set(r.id, r.username);
            const name = await getDisplayName(client, r.id).catch(() => r.name);
            rows.push(`• ${userLink(r.id, name)} — ${htmlEscape(rLbl[r.reason])}\n  <i>${htmlEscape(fmtTime(r.time))}</i>`);
          }
          if (!rows.length) { await edit("📋 <b>验证失败记录为空</b>"); break; }
          await edit(`❌ <b>验证失败 (${rows.length})</b>\n\n${rows.join("\n\n")}`);
          break;
        }

        await edit(
          `❌ 未知子命令：${codeTag(sub)}\n\n` +
          `可用：\n` +
          `<code>${mainPrefix}pmc record</code>                            — 摘要\n` +
          `<code>${mainPrefix}pmc record verified</code>                  — 通过列表\n` +
          `<code>${mainPrefix}pmc record failed</code>                    — 失败列表\n` +
          `<code>${mainPrefix}pmc record del verified &lt;ID&gt;/all</code> — 删除通过记录\n` +
          `<code>${mainPrefix}pmc record del failed &lt;ID&gt;/all</code>   — 删除失败记录\n\n` +
          ``
        );
        break;
      }

      // ╔══════════════════════════════╗
      // ║  未知命令                    ║
      // ╚══════════════════════════════╝

      default:
        await edit(
          `❌ 未知命令：${codeTag(command)}

` +
          `可用命令：<code>${mainPrefix}pmc</code> / <code>${mainPrefix}pmcaptcha</code>`
        );
    }
  } catch (e) {
    logger.error( "Command error", e);
    try { await edit(`❌ 命令执行失败: ${htmlEscape(e)}`); } catch { /* edit failed, ignore */ }
  }
};

// ─── 插件注册 ─────────────────────────────────────────────────────────────────

/** .pmc 是 .pmcaptcha 的别名，两者共享同一处理函数 */
const pmc = pmcaptcha;

class PMCaptchaPlugin extends Plugin {
  setup(context: PluginRuntimeContext): void {
    runtimeLifecycle = context.lifecycle;
    runtimeGeneration = context.generation;
    context.lifecycle.trackDisposable(() => {
      drainCaptchaStates();
      if (runtimeGeneration === context.generation) {
        runtimeLifecycle = null;
        runtimeGeneration = 0;
      }
    }, { label: "pmcaptcha-state-drain" });
  }

  cleanup(): void {
    drainCaptchaStates();
    runtimeLifecycle = null;
    runtimeGeneration = 0;
    inputPeerCache.clear();
  }

  name        = "pmcaptcha";
  description = (): string => {
    const p = mainPrefix;
    return [
      `<b>🔒 PMCaptcha v${PLUGIN_VERSION}</b> — 陌生人私聊人机验证`,
      ``,
      `<b>⚙️ 基础设置:</b>`,
      `• <code>${p}pmc on/off</code> - 启用/禁用插件`,
      `• <code>${p}pmc status</code> - 查看当前配置`,
      ``,
      `<b>🔐 验证设置:</b>`,
      `• <code>${p}pmc captcha on/off</code> - 开启/关闭验证`,
      `• <code>${p}pmc captcha math</code> - 算术验证`,
      `• <code>${p}pmc captcha text</code> - 关键词验证`,
      `• <code>${p}pmc captcha img_digit</code> - 图片验证码（纯数字）`,
      `• <code>${p}pmc captcha img_mixed</code> - 图片验证码（字母+数字）`,
      ``,
      `<b>⚙️ 参数设置:</b>`,
      `• <code>${p}pmc set time &lt;秒&gt;</code> - 验证超时（默认30秒）`,
      `• <code>${p}pmc set tries &lt;次&gt;</code> - 最大尝试次数（默认3次）`,
      `• <code>${p}pmc set keyword &lt;关键词&gt;</code> - 文字模式关键词`,
      `• <code>${p}pmc set prompt &lt;文本&gt;</code> - 自定义验证提示`,
      `• <code>${p}pmc set fail 屏蔽/删除/举报/静音/归档</code> - 失败后动作`,
      `• <code>${p}pmc set pass 取消静音/取消归档/白名单</code> - 通过后动作`,
      ``,
      `<b>👥 白名单:</b>`,
      `• <code>${p}pmc add &lt;ID/@user&gt;</code> - 添加白名单`,
      `• <code>${p}pmc del &lt;ID/@user&gt;</code> - 移除白名单`,
      `• <code>${p}pmc wl</code> - 查看白名单`,
      `• <code>${p}pmc wl pass &lt;ID&gt;</code> - 手动标记通过`,
      ``,
      `<b>📋 验证记录:</b>`,
      `• <code>${p}pmc record</code> - 查看统计`,
      `• <code>${p}pmc record verified</code> - 查看通过记录`,
      `• <code>${p}pmc record failed</code> - 查看失败记录`,
      `• <code>${p}pmc record del verified/failed &lt;ID&gt;/all</code> - 删除记录`,
      ``,
      `<b>ℹ️ 使用说明:</b>`,
      `• 验证失败默认执行静音+归档`,
      `• 修改参数后进行中的验证消息实时更新`,
      `• 我方主动发起对话时对方自动通过`,
    ].join("\n");
  };
  cmdHandlers = { pmc, pmcaptcha };
  listenMessageHandler = messageListener;
}

const plugin = new PMCaptchaPlugin();
export default plugin;
