import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";

const PREFIX = getPrefixes()[0];
const HELP = `🕵️ <b>FBI 跨群组追踪</b>

• <code>${PREFIX}fbi det（detect） [目标]</code> — 现场勘察（搜索目标最新消息）
• <code>${PREFIX}fbi sur（surveil） [目标]</code> — 监视追踪（蹲守目标下一条消息）
• <code>${PREFIX}fbi obs（observation） [目标]</code> — 定点监视（蹲守指定群组内目标下一条消息）
• <code>${PREFIX}fbi loc（locate） [目标]</code> — 窝点锁定（分析目标最活跃群组）
• <code>${PREFIX}fbi ssv</code> — 终止所有蹲守
• <code>${PREFIX}fbi cache</code> — 查看/管理消息缓存
• <code>${PREFIX}fbi help</code> — 本帮助

目标可为 @用户名、用户ID，或回复消息自动取被回复者。`;

const CACHE_MSG_LIMIT = 3000; // max messages stored per group
const CACHE_LIMIT_DEF = 300; // default max groups to cache
const CACHE_LIMIT_MIN = 10;
const CACHE_LIMIT_MAX = 1000;

const htmlEsc = (s: string) =>
  s.replace(/[&<>"']/g, (m) => {
    if (m === "&") return "&amp;";
    if (m === "<") return "&lt;";
    if (m === ">") return "&gt;";
    if (m === '"') return "&quot;";
    return "&#x27;";
  });

const peelChatId = (id: any) => String(typeof id === "bigint" ? id.toString() : id).replace(/^-100/, "");

/** getEntity 返回的 Entity 联合类型上并非所有变体都有 username/title 等字段 */
type EntityFields = {
  id?: unknown;
  username?: string;
  title?: string;
  firstName?: string;
  lastName?: string;
  className?: string;
};
const entityFields = (e: unknown): EntityFields => e as EntityFields;

/** random delay between min and max ms */
function rndDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal serializable representation of a chat message */
interface CachedMsg {
  id: number;
  senderId: number;
  date: number;
  text: string;
}

interface CachedChat {
  username?: string;
  title?: string;
  msgs: CachedMsg[];
}

interface SvEntry {
  targetId: string;
  targetName: string;
  triggerPeer: string;
  triggerMsgId: number;
  scopePeer?: string; // obs only — restrict to a single group
}

interface FbiConfig {
  surveillance: Record<string, SvEntry>;
  cacheLimit: number;
}

interface FbiCache {
  cache: Record<string, CachedChat>;
}

const CONFIG_DEF: FbiConfig = { surveillance: {}, cacheLimit: CACHE_LIMIT_DEF };

const CACHE_EXPIRE_SECS = 30 * 24 * 60 * 60; // 30 days in seconds

function stripMsg(m: Api.Message): CachedMsg {
  return { id: m.id, senderId: Number(m.senderId), date: m.date, text: m.text || "" };
}

class FbiPlugin extends Plugin {
  description = `FBI 跨群组追踪\n\n${HELP}`;

  cmdHandlers = { fbi: this.onCmd.bind(this) };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "fbi",
    title: "FBI 跨群追踪",
    description: "跨群组消息追踪配置",
    category: "插件配置",
    icon: "🕵️",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "cacheLimit",
            "label": "缓存限制 (条)",
            "type": "number",
            "min": 100,
            "max": 10000,
            "default": 1000
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<FbiConfig>(path.join(createDirectoryInAssets("fbi"), "config.json"), CONFIG_DEF);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<FbiConfig>(path.join(createDirectoryInAssets("fbi"), "config.json"), CONFIG_DEF);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
  listenMessageHandler = this.onMsg.bind(this);

  private configDb: any;
  private cacheDb: any;
  private sv = new Map<string, SvEntry>();
  private chatCache = new Map<string, CachedChat>();
  private cacheReady = false;
  private cacheDirty = false;
  private ready = false; // initDB done
  private cachePath = ""; // persist path for sync flush on cleanup
  private cachePersistTimer: ReturnType<typeof setTimeout> | null = null;
  private coldSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** remove messages older than 30 days from a chat cache, return true if any pruned */
  private pruneExpired(chat: CachedChat): boolean {
    const cutoff = Math.floor(Date.now() / 1000) - CACHE_EXPIRE_SECS;
    const before = chat.msgs.length;
    chat.msgs = chat.msgs.filter(m => m.date > cutoff);
    return chat.msgs.length !== before;
  }

  constructor() {
    super();
    this.initDB().catch((e) => {
      console.error("[fbi] initDB error", e);
      this.ready = true; // continue with fresh state
    });
  }

  /* ====== bootstrap ====== */

  private async initDB() {
    const p = path.join(createDirectoryInAssets("fbi"), "db.json");
    this.configDb = await JSONFilePreset<FbiConfig>(p, CONFIG_DEF);
    // ensure cacheLimit has a default
    if (typeof this.configDb.data.cacheLimit !== "number") {
      this.configDb.data.cacheLimit = CACHE_LIMIT_DEF;
      await this.configDb.write();
    }
    for (const [k, v] of Object.entries(this.configDb.data.surveillance)) this.sv.set(k, v as SvEntry);
    // load cache from separate file — tolerate corrupt/truncated JSON
    const cp = path.join(createDirectoryInAssets("fbi"), "cache.json");
    this.cachePath = cp;
    try {
      this.cacheDb = await JSONFilePreset<FbiCache>(cp, { cache: {} });
      if (this.cacheDb.data.cache) {
        for (const [k, v] of Object.entries(this.cacheDb.data.cache))
          this.chatCache.set(k, v as CachedChat);
        console.log(`[fbi] cache loaded: ${this.chatCache.size} groups`);
      }
    } catch (e: unknown) {
      console.error("[fbi] initDB cache load failed, resetting cache.json", e);
      try {
        const fs = await import("fs");
        if (fs.existsSync(cp)) {
          fs.renameSync(cp, `${cp}.corrupt.${Date.now()}`);
        }
      } catch (_renameErr: unknown) {
        /* ignore rename failure; overwrite below */
      }
      this.chatCache.clear();
      this.cacheDb = await JSONFilePreset<FbiCache>(cp, { cache: {} });
      await this.cacheDb.write();
      console.warn("[fbi] cache reset to empty after corruption recovery");
    }

    this.cacheReady = true;

    // cold sweep every 24h — prune expired messages in silent groups
    this.coldSweepTimer = setInterval(() => {
      if (!this.cacheReady) return;
      let anyPruned = false;
      for (const chat of this.chatCache.values())
        if (this.pruneExpired(chat)) anyPruned = true;
      if (anyPruned) this.schedulePersistCache();
    }, 24 * 60 * 60 * 1000);
    this.ready = true;
  }

  private async persistDb() {
    this.configDb.data.surveillance = Object.fromEntries(this.sv);
    await this.configDb.write();
  }

  /** Cleanup timers on plugin unload to prevent leaks across reloads */
  cleanup(): void {
    // flush pending cache before clearing timers
    if (this.cacheDirty && this.cachePath) {
      try {
        this.cacheDb.data.cache = Object.fromEntries(this.chatCache);
        fs.writeFileSync(this.cachePath, JSON.stringify(this.cacheDb.data));
      } catch (e) {
        console.error("[fbi] cleanup sync flush failed", e);
      }
    }
    if (this.coldSweepTimer) {
      clearInterval(this.coldSweepTimer);
      this.coldSweepTimer = null;
    }
    if (this.cachePersistTimer) {
      clearTimeout(this.cachePersistTimer);
      this.cachePersistTimer = null;
    }
  }

  /** debounced cache persist — at most once every 10s */
  private schedulePersistCache() {
    this.cacheDirty = true;
    if (this.cachePersistTimer) return; // already queued
    this.cachePersistTimer = setTimeout(async () => {
      this.cachePersistTimer = null;
      if (!this.cacheDirty) return;
      this.cacheDirty = false;
      this.cacheDb.data.cache = Object.fromEntries(this.chatCache);
      await this.cacheDb.write();
    }, 10_000);
  }

  /** scan public groups one-by-one with random delay, fill chatCache */
  private async buildCache() {
    try {
      const cl = await getGlobalClient();
      if (!cl) return;

      const limit = this.configDb.data.cacheLimit;
      // paginated getDialogs — respect cacheLimit > 100
      const all: any[] = [];
      let offsetId = 0;
      let offsetDate = 0;
      let offsetPeer: any = new Api.InputPeerEmpty();
      while (all.length < limit) {
        const page = (await cl.getDialogs({ offsetId, offsetDate, offsetPeer, limit: 100 })) as any[];
        if (!page.length) break;
        for (const d of page) {
          if (d.isGroup || d.isChat) all.push(d);
          if (all.length >= limit) break;
        }
        if (page.length < 100) break; // last page
        const last = page[page.length - 1];
        offsetId = last.dialog?.topMessage?.id ?? 0;
        offsetDate = last.dialog?.topMessage?.date ?? 0;
        offsetPeer = last.dialog?.peer ?? new Api.InputPeerEmpty();
      }
      const dialogs = all.slice(0, limit);

      let count = 0;
      for (const d of dialogs) {
        const msgs: CachedMsg[] = [];
        for await (const m of cl.iterMessages(d.id, { limit: CACHE_MSG_LIMIT })) {
          msgs.push(stripMsg(m));
        }
        // get entity for username/title
        let username: string | undefined;
        let title: string | undefined;
        try {
          const entity = entityFields(await cl.getEntity(d.id));
          username = entity.username;
          title = entity.title;
        } catch { /* best-effort */ }
        // ponytail: skip private groups (no username)
        if (username) {
          this.chatCache.set(String(d.id), { username, title, msgs });
          count++;
        }
        await rndDelay(1000, 10000);
      }

      // persist to disk
      this.cacheDb.data.cache = Object.fromEntries(this.chatCache);
      await this.cacheDb.write();
      console.log(`[fbi] cache ready: ${count} groups (limit ${limit})`);
    } finally {
      this.cacheReady = true;
    }
  }

  /* ====== router ====== */

  private async onCmd(msg: Api.Message): Promise<void> {
    const parts = msg.text?.trim().split(/\s+/) || [];
    const sub = parts[1]?.toLowerCase();
    const args = parts.slice(2);

    if (!this.ready) {
      await msg.edit({ text: "⏳ FBI 正在初始化，请稍后再试。", parseMode: "html" });
      return;
    }

    try {
      switch (sub) {
        case "det":   return this.doDet(msg, args);
        case "sur":   return this.doSur(msg, args);
        case "loc":   return this.doLoc(msg, args);
        case "obs":   return this.doObs(msg, args);
        case "ssv":   return this.doSsv(msg);
        case "cache": return this.doCache(msg, args);
        default:      { await msg.edit({ text: HELP, parseMode: "html" }); return; }
      }
    } catch (e: any) {
      await msg.edit({ text: `❌ ${htmlEsc(e.message || "未知错误")}`, parseMode: "html" });
    }
  }

  /* ====== target resolver ====== */

  private async resolveTarget(msg: Api.Message, args: string[]): Promise<{ id: string; name: string } | null> {
    const cl = await getGlobalClient();
    if (!cl) return null;
    let targetId: string | undefined;
    let name = "";

    if (args.length) {
      const raw = args[0];
      try {
        const e = entityFields(await cl.getEntity(raw));
        targetId = String(e.id);
        const plain = htmlEsc([e.firstName, e.lastName].filter(Boolean).join(' ') || e.title || targetId);
        name = e.username ? `<a href="https://t.me/${e.username}">${plain}</a>` : plain;
      } catch {
        name = raw;
        targetId = raw.replace(/^@/, "");
      }
    } else if (msg.isReply) {
      const r = await safeGetReplyMessage(msg);
      if (r?.senderId) {
        targetId = String(r.senderId);
        try {
          const u = entityFields(await cl.getEntity(r.senderId));
          const plain = htmlEsc([u.firstName, u.lastName].filter(Boolean).join(' ') || targetId);
          name = u.username ? `<a href="https://t.me/${u.username}">${plain}</a>` : plain;
        } catch {
          name = targetId;
        }
      }
    }
    return targetId ? { id: targetId, name } : null;
  }

  /* ====== cs (zero-request, reads cache) ====== */

  private async doDet(msg: Api.Message, args: string[]) {
    if (!this.cacheReady) {
      await msg.edit({ text: "⏳ 缓存正在初始化，请稍后再试。", parseMode: "html" });
      return;
    }
    const target = await this.resolveTarget(msg, args);
    if (!target) {
      await msg.edit({ text: "❌ 无法识别目标，请回复消息或提供用户名/ID", parseMode: "html" });
      return;
    }

    await msg.edit({ text: `🔍 正在搜索嫌疑人 ${target.name} 的蛛丝马迹...`, parseMode: "html" });

    let found: { msg: CachedMsg; peer: string } | null = null;

    for (const [peer, chat] of this.chatCache) {
      for (const m of chat.msgs) {
        if (String(m.senderId) === target.id) {
          if (!found || m.date > found.msg.date) found = { msg: m, peer };
          break; // newest msg in this group, move on
        }
      }
    }

    await msg.delete().catch(() => {});

    if (!found) {
      await this.sendReply(msg, `🤦‍♀ 暂时没发现 ${target.name} 有作案嫌疑。`);
      return;
    }

    // build link from cache, no API call needed
    const chat = this.chatCache.get(found.peer)!;
    const text = htmlEsc((found.msg.text || "").slice(0, 50) || "[媒体消息]");
    const link = chat.username
      ? `<a href="https://t.me/${chat.username}/${found.msg.id}">${text}</a>`
      : `<a href="https://t.me/c/${peelChatId(found.peer)}/${found.msg.id}">${text}</a>`;
    await this.sendReply(msg, `👀 发现嫌疑人 ${target.name} 的作案现场：\n\n${link}\n\n<i>要想人不知除非己莫为。</i>`);
  }

  /* ====== sv ====== */

  private async doSur(msg: Api.Message, args: string[]) {
    const cl = await getGlobalClient();
    if (!cl) return;
    const target = await this.resolveTarget(msg, args);
    if (!target) {
      await msg.edit({ text: "❌ 无法识别目标", parseMode: "html" });
      return;
    }

    await msg.edit({ text: `👁️ 正在对嫌疑人 ${target.name} 进行蹲守...`, parseMode: "html" });

    this.sv.set(target.id, {
      targetId: target.id,
      targetName: target.name,
      triggerPeer: String(msg.chatId),
      triggerMsgId: msg.id,
    });
    await this.persistDb();
  }

  /* ====== listen — update cache + check surveillance ====== */

  private async onMsg(msg: Api.Message) {
    // 1) update cache — only public groups, auto-vivify on first sighting
    if (msg.chatId) {
      const peer = String(msg.chatId);
      let chat = this.chatCache.get(peer);
      if (!chat) {
        // first sighting → check if public, cache only public groups
        const cl = await getGlobalClient();
        if (cl) {
          try {
            const entity = entityFields(await cl.getEntity(msg.chatId));
            if (entity.username && (entity.className === 'Channel' || entity.className === 'Chat')) {
              chat = { username: entity.username, title: entity.title, msgs: [] };
              this.chatCache.set(peer, chat);
            }
          } catch { /* getEntity failed → skip */ }
        }
      }
      if (chat) {
        chat.msgs.unshift(stripMsg(msg));
        this.pruneExpired(chat);
        if (chat.msgs.length > CACHE_MSG_LIMIT) chat.msgs.length = CACHE_MSG_LIMIT;
        this.schedulePersistCache();
      }
    }

    // 2) sv surveillance
    if (this.sv.size === 0) return;
    const sid = msg.senderId ? String(msg.senderId) : "";
    if (!sid || !this.sv.has(sid)) return;
    const entry = this.sv.get(sid)!;

    // prevent self-trigger
    if (String(msg.chatId) === entry.triggerPeer && msg.id === entry.triggerMsgId) return;

    // mon scope — only trigger if message is in the target group
    if (entry.scopePeer && String(msg.chatId) !== entry.scopePeer) return;

    // check group is public (has username) before consuming the sv entry
    const cl = await getGlobalClient();
    if (!cl) return;
    const chatEntity = entityFields(await cl.getEntity(msg.peerId));
    if (!chatEntity.username) return; // private group — skip silently, keep sv alive

    this.sv.delete(sid);
    this.persistDb().catch((e) => console.error("[fbi] persistDb error", e));

    // ponytail: link from live msg entity (need peerId for unknown groups)
    const preview = htmlEsc((msg.text || "").slice(0, 50) || "[媒体消息]");
    const link = chatEntity.username
      ? `<a href="https://t.me/${chatEntity.username}/${msg.id}">${preview}</a>`
      : `<a href="https://t.me/c/${peelChatId(chatEntity.id)}/${msg.id}">${preview}</a>`;
    const result = `🚨 发现嫌疑人 ${entry.targetName} 最新动向\n\n${link}\n\n<i>天网恢恢疏而不漏。</i>`;

    // ponytail: client handles channel/normal, one call suffices
    try { await cl.deleteMessages(entry.triggerPeer, [entry.triggerMsgId], { revoke: false }); } catch {}

    await cl.sendMessage(entry.triggerPeer, { message: result, parseMode: "html", linkPreview: false });
    await cl.sendMessage("me", { message: result, parseMode: "html", linkPreview: false });
  }

  /* ====== ds (zero-request, reads cache) ====== */

  private async doLoc(msg: Api.Message, args: string[]) {
    if (!this.cacheReady) {
      await msg.edit({ text: "⏳ 缓存正在初始化，请稍后再试。", parseMode: "html" });
      return;
    }
    const target = await this.resolveTarget(msg, args);
    if (!target) {
      await msg.edit({ text: "❌ 无法识别目标", parseMode: "html" });
      return;
    }

    await msg.edit({ text: `🧭 正在摸排嫌疑人 ${target.name} 的窝点...`, parseMode: "html" });

    let bestPeer: string | null = null;
    let bestCount = 0;
    let bestMsg: CachedMsg | null = null;

    for (const [peer, chat] of this.chatCache) {
      let cnt = 0;
      let latest: CachedMsg | null = null;
      for (const m of chat.msgs) {
        if (String(m.senderId) === target.id) {
          cnt++;
          if (!latest) latest = m; // first hit = newest (msgs newest-first)
        }
      }
      if (cnt > bestCount) {
        bestCount = cnt;
        bestPeer = peer;
        bestMsg = latest;
      }
    }

    await msg.delete().catch(() => {});

    if (!bestPeer || bestCount === 0) {
      await this.sendReply(msg, `🤦‍♀ 摸排结果不尽人意，嫌疑人 ${target.name} 藏的很深。`);
      return;
    }

    // link text = group name, href points to target's latest msg in that group
    let link = `https://t.me/c/${peelChatId(bestPeer)}`;
    if (bestMsg) {
      const chat = this.chatCache.get(bestPeer)!;
      const mid = bestMsg.id;
      const href = chat.username ? `https://t.me/${chat.username}/${mid}` : `https://t.me/c/${peelChatId(bestPeer)}/${mid}`;
      link = `<a href="${href}">${htmlEsc(chat.title || chat.username || bestPeer)}</a>`;
    }
    await this.sendReply(msg, `🏚 发现嫌疑人 ${target.name} 的窝点：\n\n${link}\n\n<i>跑得了和尚跑不了庙。</i>`);
  }

  /* ====== obs (group-scoped surveillance) ====== */

  private async doObs(msg: Api.Message, args: string[]) {
    const cl = await getGlobalClient();
    if (!cl) return;

    // parse group link from first arg
    let scopePeer: string | undefined;
    const tme = args[0]?.match(/^(?:https?:\/\/)?t\.me\/(\w+)/i);
    let targetArgs = args;
    if (tme) {
      const gn = tme[1].toLowerCase();
      targetArgs = args.slice(1);
      for (const [p, c] of this.chatCache)
        if (c.username?.toLowerCase() === gn) { scopePeer = p; break; }
      if (!scopePeer) {
        try {
          const e = entityFields(await cl.getEntity(gn));
          if (e.username?.toLowerCase() === gn) scopePeer = String(e.id);
        } catch {}
        if (!scopePeer) {
          await msg.edit({ text: `❌ 无法解析群组 @${gn}`, parseMode: "html" });
          return;
        }
      }
    } else {
      scopePeer = msg.chatId?.toString();
    }

    if (!scopePeer) {
      await msg.edit({ text: "❌ 无法确定目标群组", parseMode: "html" });
      return;
    }

    const target = await this.resolveTarget(msg, targetArgs);
    if (!target) {
      await msg.edit({ text: "❌ 无法识别目标", parseMode: "html" });
      return;
    }

    // check group is public
    const chatEntity = entityFields(await cl.getEntity(scopePeer));
    if (!chatEntity.username) {
      await msg.edit({ text: "❌ 仅支持公开群组的定点监视", parseMode: "html" });
      return;
    }

    await msg.edit({ text: `🎯 正在对嫌疑人 ${target.name} 进行定点监视...`, parseMode: "html" });

    this.sv.set(target.id, {
      targetId: target.id,
      targetName: target.name,
      triggerPeer: String(msg.chatId),
      triggerMsgId: msg.id,
      scopePeer,
    });
    await this.persistDb();
  }

  /* ====== ssv ====== */

  private async doSsv(msg: Api.Message) {
    if (this.sv.size === 0) {
      await msg.edit({ text: "❌ 当前没有活跃的蹲守任务。", parseMode: "html" });
      return;
    }

    const cl = await getGlobalClient();

    for (const entry of this.sv.values()) {
      if (cl) {
        try {
          await cl.invoke(
            new Api.messages.EditMessage({
              peer: entry.triggerPeer,
              id: entry.triggerMsgId,
              message: `🤦‍♀ 蹲守过程中没有发现嫌疑人 ${entry.targetName} 的行踪。`,
            } as any),
          );
        } catch { /* trigger may be deleted — fine */ }
      }
    }

    this.sv.clear();
    await this.persistDb();
    await msg.edit({ text: "✅ 已终止所有蹲守任务。", parseMode: "html" });
  }

  /* ====== cache management ====== */

  private async doCache(msg: Api.Message, args: string[]) {
    const sub = args[0]?.toLowerCase();

    if (sub === "limit") {
      const n = parseInt(args[1], 10);
      if (isNaN(n) || n < CACHE_LIMIT_MIN || n > CACHE_LIMIT_MAX) {
        await msg.edit({
          text: `❌ 缓存上限必须为 ${CACHE_LIMIT_MIN}~${CACHE_LIMIT_MAX} 之间的整数。当前：${this.configDb.data.cacheLimit}`,
          parseMode: "html",
        });
        return;
      }
      this.configDb.data.cacheLimit = n;
      await this.configDb.write();
      await msg.edit({
        text: `✅ 缓存上限已设为 ${n} 个群组。使用 <code>${PREFIX}fbi cache rebuild</code> 重新构建。`,
        parseMode: "html",
      });
      return;
    }

    if (sub === "rebuild") {
      await msg.edit({ text: "🔄 正在重建缓存，可能需要几分钟...", parseMode: "html" });
      this.cacheReady = false;
      this.chatCache.clear();
      await this.buildCache();
      await msg.edit({
        text: `✅ 缓存重建完成，共缓存 ${this.chatCache.size} 个群组。`,
        parseMode: "html",
      });
      return;
    }

    // status
    const limit = this.configDb.data.cacheLimit;
    await msg.edit({
      text: `📦 <b>FBI 缓存状态</b>

• 已缓存群组：<code>${this.chatCache.size}</code>
• 缓存上限：<code>${limit}</code>
• 每群最大消息：<code>${CACHE_MSG_LIMIT}</code>
• 状态：${this.cacheReady ? "✅ 就绪" : "⏳ 初始化中"}

<b>子命令</b>
• <code>${PREFIX}fbi cache limit [数量]</code> — 设置缓存上限（${CACHE_LIMIT_MIN}~${CACHE_LIMIT_MAX}）
• <code>${PREFIX}fbi cache rebuild</code> — 重建缓存`,
      parseMode: "html",
    });
  }

  /* ====== helper ====== */

  private async sendReply(original: Api.Message, text: string) {
    const cl = await getGlobalClient();
    if (!cl) return;
    await cl.sendMessage(original.peerId, { message: text, parseMode: "html", linkPreview: false });
  }
}

export default new FbiPlugin();
