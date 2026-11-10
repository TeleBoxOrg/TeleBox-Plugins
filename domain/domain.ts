import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/runtimeManager";

// 域名到期提醒（精简版）— 只记要续期的域名
// 功能只有：加 / 看 / 改 / 删 + 回执
// 回执只设一次，全体生效；没设就不发。
// 每天 12:30（北京时间）检查一次，到了可续时间发一条回执；已过期只发一次。

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const filePath = path.join(
  createDirectoryInAssets("domain"),
  "domain_config.json",
);

const VALIDITY_DAYS = 365; // 续期有效期固定 365 天
const DEFAULT_EARLY_DAYS = 120; // 默认提前 120 天可续
const CHECK_CRON = "0 30 5 * * *"; // cron 5:30 = 北京时间 12:30
const CRON_KEY = "domain:daily";
const OLD_CRON_KEYS = ["domain:daily:1", "domain:daily:2"];

type DomainRecord = {
  id: number; // 数字编号 1、2、3…，删掉一个后剩下的自动补位
  domain: string;
  official: string; // 官网地址，不填就是 ""
  registered: string; // YYYY-MM-DD
  expiry: string; // YYYY-MM-DD；以前永久的旧记录是 "永久"，只显示不提醒
  early: number; // 提前多少天可续，默认 120
  notified: Array<number | string>; // 已发过的档位：只有 "expired"
};

type DomainDB = {
  receiptTo?: string; // 没设 = 不发回执；填数字 ID = 发给那个 ID；off = 不发
  domains: DomainRecord[];
};

async function getDB() {
  const db = await JSONFilePreset<DomainDB>(filePath, {
    domains: [],
  });
  return db;
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------
function parseDateStrict(s: string): { y: number; m: number; d: number } | null {
  const v = (s || "").trim();
  let y: number;
  let mo: number;
  let d: number;
  // 年在前：YYYY-MM-DD、YYYY/M/D 或 YYYY.MM.DD，例如 2026-10-23、2027/9/30、2026.12.30
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    // 日在前：D/M/YYYY 或 D.M.YYYY，例如 19/12/2027
    const m2 = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
    if (!m2) return null;
    d = Number(m2[1]);
    mo = Number(m2[2]);
    y = Number(m2[3]);
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return { y, m: mo, d };
}

const DATE_FORMAT_HINT = "YYYY-MM-DD、YYYY/M/D、YYYY.MM.DD、D/M/YYYY 或 D.M.YYYY，例如 2026-10-23、2027/9/30、2026.12.30、19/12/2027";

function toISO(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

function addDaysISO(iso: string, days: number): string {
  const p = parseDateStrict(iso);
  if (!p) return iso;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function daysBetween(aISO: string, bISO: string): number {
  const a = parseDateStrict(aISO);
  const b = parseDateStrict(bISO);
  if (!a || !b) return 0;
  const am = Date.UTC(a.y, a.m - 1, a.d);
  const bm = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((bm - am) / 86400000);
}

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------
function cleanDomain(s: string): string | null {
  let v = (s || "").trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.split("/")[0].split("?")[0].split("#")[0].trim().replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9\-\.]+$/.test(v) || !v.includes(".") || v.includes("..")) return null;
  return v;
}

// 官网地址去掉末尾的 /（https://nic.pp.ua/ 和 https://nic.pp.ua 是一个地址，去掉后列表里只显示一遍）
function cleanOfficial(url: string): string {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/]+/.test(trimmed) ? trimmed : (url || "").trim();
}

// 编号整理成 1、2、3…，不留空号；旧记录缺官网/提前天数时补默认。
function normalizeDomains(data: DomainDB): boolean {
  let changed = false;
  const list = data.domains || [];
  list.sort((a, b) => (a.id || 0) - (b.id || 0));
  list.forEach((d, i) => {
    if (!d.id || d.id !== i + 1) {
      d.id = i + 1;
      changed = true;
    }
    if (d.official === undefined) {
      d.official = "";
      changed = true;
    }
    if (!d.early || d.early <= 0) {
      d.early = DEFAULT_EARLY_DAYS;
      changed = true;
    }
    // 旧版默认是 180 天（最早可续），新版统一 120 天：只把旧默认值改过来，
    // 用户单独设过的其他天数（比如 90、60）不动。
    if (d.early === 180) {
      d.early = DEFAULT_EARLY_DAYS;
      changed = true;
    }
    // 旧记录的官网后面多个 / 时去掉
    if (d.official) {
      const cleaned = cleanOfficial(d.official);
      if (cleaned !== d.official) {
        d.official = cleaned;
        changed = true;
      }
    }
    if (!Array.isArray(d.notified)) {
      d.notified = [];
      changed = true;
    }
  });
  return changed;
}

function renumberDomains(data: DomainDB): void {
  const list = data.domains || [];
  list.sort((a, b) => (a.id || 0) - (b.id || 0));
  list.forEach((d, i) => {
    d.id = i + 1;
  });
}

function nextId(data: DomainDB): number {
  const ids = (data.domains || []).map((d) => d.id || 0);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

// rm / edit 既能用数字 ID，也能用域名。
function findDomainIndex(data: DomainDB, target: string): number {
  const t = (target || "").trim();
  if (/^\d+$/.test(t)) {
    const id = Number(t);
    return (data.domains || []).findIndex((d) => d.id === id);
  }
  const domain = cleanDomain(t);
  if (!domain) return -1;
  return (data.domains || []).findIndex((d) => d.domain === domain);
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function domainLine(d: DomainRecord, today: string): string {
  if (d.expiry === "永久") {
    return `<code>${d.id}</code> • <code>${escapeHtml(d.domain)}</code> 注册：${escapeHtml(d.registered)} 到期：永久`;
  }
  const daysLeft = daysBetween(today, d.expiry);
  const early = d.early && d.early > 0 ? d.early : DEFAULT_EARLY_DAYS;
  const earlyDate = addDaysISO(d.expiry, -early);
  // 到了可续时间才说“已在”，还没到就说“提前”；已过期就说已过期。
  const renewNote =
    daysLeft < 0
      ? "（已过期）"
      : daysLeft <= early
        ? `（已在${early}天内可续）`
        : `（提前${early}天可续）`;
  const status =
    daysLeft < 0
      ? `🔴 已过期 ${Math.abs(daysLeft)} 天`
      : daysLeft === 0
        ? "🔴 今天到期"
        : daysLeft <= early
          ? `🟡 ${early}天内到期，可以续了`
          : "🟢 正常";
  const officialLine = d.official
    ? `\n官网：<a href="${escapeHtml(d.official)}">${escapeHtml(d.official)}</a>`
    : "";
  return (
    `<code>${d.id}</code> • <code>${escapeHtml(d.domain)}</code>${officialLine}\n` +
    `注册：${escapeHtml(d.registered)}  到期：${escapeHtml(d.expiry)}\n` +
    `可续日：${escapeHtml(earlyDate)}${renewNote}\n` +
    `剩余：<b>${daysLeft} 天</b>  ${status}`
  );
}

function receiptLabel(data: DomainDB): string {
  const raw = String(data.receiptTo || "").trim();
  if (!raw) return "未设置（不发回执）";
  if (raw === "off") return "已关闭";
  return raw;
}

// ---------------------------------------------------------------------------
// 每天 12:30 检查一次
// ---------------------------------------------------------------------------
async function runDailyCheck(): Promise<void> {
  const today = todayStr();
  const db = await getDB();
  if (normalizeDomains(db.data)) await db.write();
  // 没设回执就不发。
  const raw = String(db.data.receiptTo || "").trim();
  if (!raw || raw === "off") return;
  const to = Number(raw);
  if (!Number.isFinite(to)) return;
  const due: DomainRecord[] = [];
  for (const d of db.data.domains) {
    if (d.expiry === "永久") continue; // 以前永久的旧记录不提醒
    const daysLeft = daysBetween(today, d.expiry);
    const early = d.early && d.early > 0 ? d.early : DEFAULT_EARLY_DAYS;
    const notified = new Set(d.notified || []);
    if (daysLeft >= 0 && daysLeft <= early) {
      due.push(d); // 到了可续时间（到期前 early 天内）：每天 12:30 发一条
    } else if (daysLeft < 0 && !notified.has("expired")) {
      due.push(d); // 已过期：只发一次
    }
  }
  if (due.length === 0) return;
  const parts = [`<b>🔔 域名到期提醒（${escapeHtml(today)} 12:30）</b>`, ""];
  for (const d of due) parts.push(domainLine(d, today));
  parts.push("");
  parts.push(`续签后更新：<code>${escapeHtml(mainPrefix)}domain add &lt;域名&gt; &lt;新的到期日&gt;</code>`);
  const text = parts.join("\n");
  try {
    const client = await getGlobalClient();
    if (!client) return;
    await client.sendMessage(Math.trunc(to) as any, { message: text, parseMode: "html" });
    // 只有真的发出去才标记“已过期”；窗口内的本来就不标记，明天 12:30 还要再发。
    for (const d of due) {
      if (daysBetween(today, d.expiry) < 0) {
        const notified = new Set(d.notified || []);
        notified.add("expired");
        d.notified = [...notified];
      }
    }
    await db.write();
  } catch (e: any) {
    console.error("[domain] 回执发送失败:", e);
  }
}

async function bootstrapDailyCheck(): Promise<void> {
  try {
    // 先清掉旧版的定时（08:00 + 14:30、12:00），再注册每天 12:30 这一条。
    for (const key of OLD_CRON_KEYS) {
      try {
        cronManager.del(key);
      } catch {}
    }
    try {
      cronManager.del(CRON_KEY);
    } catch {}
    const validation = (cron as any).validateCronExpression
      ? (cron as any).validateCronExpression(CHECK_CRON)
      : { valid: true };
    if (!validation.valid) return;
    cronManager.set(CRON_KEY, CHECK_CRON, async () => {
      try {
        await runDailyCheck();
      } catch (e: any) {
        console.error("[domain] 定时检查失败:", e);
      }
    });
  } catch (e: any) {
    console.error("[domain] bootstrap 失败:", e);
  }
}

// 启动时注册每天 12:30 检查（异步，不阻塞加载）
bootstrapDailyCheck();

// ---------------------------------------------------------------------------
// 帮助（示例一条就够）
// ---------------------------------------------------------------------------
const help_text = `域名到期提醒：到了可续时间，每天 12:30 发一条回执。

▎加域名
• <code>${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120</code>
域名 / 官网 / 到期日 / 提前天数，官网和 120 不写也行。
日期：2027-09-30、2027/9/30、19/12/2027 都行。

▎看 / 改 / 删
• <code>${mainPrefix}domain ls</code>
• <code>${mainPrefix}domain edit 2 expiry 2027-09-30</code> 改到期日
• <code>${mainPrefix}domain edit 2 early 90</code> 改提前天数
• <code>${mainPrefix}domain edit 2 official https://xxx.com</code> 改官网
• <code>${mainPrefix}domain rm 2</code>

▎回执（设一次就行，没设不发）
• <code>${mainPrefix}domain setreceipt 123456789</code>
• <code>${mainPrefix}domain setreceipt off</code> 关掉`;

class DomainPlugin extends Plugin {
  description: string = `域名到期提醒：只记续期的，到了可续时间每天 12:30 发一条回执\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    domain: async (msg: Api.Message) => {
      const lines = msg.message?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      const reply = async (text: string) => {
        await msg.edit({ text, parseMode: "html" });
      };

      try {
        if (!sub) {
          await reply(help_text);
          return;
        }

        // ---- 列表 ----
        if (sub === "list" || sub === "ls") {
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const today = todayStr();
          if (db.data.domains.length === 0) {
            await reply(
              `还没有域名。先加一个：\n<code>${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120</code>`,
            );
            return;
          }
          const rows = [...db.data.domains].sort((a, b) => (a.id || 0) - (b.id || 0));
          const out: string[] = [`📋 域名列表（${today}）`, ""];
          for (const d of rows) out.push(domainLine(d, today));
          out.push("");
          out.push(`回执：${escapeHtml(receiptLabel(db.data))}`);
          out.push(`每天检查：12:30（<code>${escapeHtml(CHECK_CRON)}</code>）`);
          await reply(out.join("\n").trim());
          return;
        }

        // ---- 加域名：add <域名> [官网] <到期日> [提前天数]，日期就是到期日 ----
        if (sub === "add") {
          const rawDomain = args[1];
          if (!rawDomain) {
            await reply(
              `用法：<code>${mainPrefix}domain add &lt;域名&gt; [官网] &lt;到期日&gt; [提前天数]</code>\n例如：<code>${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120</code>\n日期支持 ${escapeHtml(DATE_FORMAT_HINT)}`,
            );
            return;
          }
          const domain = cleanDomain(rawDomain);
          if (!domain) {
            await reply(`❌ 域名格式不对：${escapeHtml(rawDomain)}，例如 xxx.pp.ua`);
            return;
          }
          // 精简版只记要续期的域名，不用写 permanent
          if (
            args.slice(2).some((a) =>
              ["permanent", "perm", "forever", "never", "永久"].includes(a.trim().toLowerCase()),
            )
          ) {
            await reply(`❌ 精简版只记要续期的域名，不用写 permanent，直接输到期日就行。`);
            return;
          }
          // 逐个认后面的参数：官网（http 开头）、到期日（日期）、提前天数（数字）；exp / 到期 后面跟的也是到期日
          let official = "";
          let expiryParsed: { y: number; m: number; d: number } | null = null;
          let early = DEFAULT_EARLY_DAYS;
          const rest = args.slice(2);
          for (let i = 0; i < rest.length; i++) {
            const tok = (rest[i] || "").trim();
            if (!tok) continue;
            if (["exp", "expiry", "到期"].includes(tok.toLowerCase())) continue;
            if (/^https?:\/\//i.test(tok)) {
              official = cleanOfficial(tok);
              continue;
            }
            const asDate = parseDateStrict(tok);
            if (asDate) {
              expiryParsed = asDate;
              continue;
            }
            if (/^\d+$/.test(tok)) {
              const n = Number(tok);
              if (n >= 1 && n <= 365) {
                early = n;
                continue;
              }
            }
            await reply(`❌ 看不懂这个参数：${escapeHtml(tok)}\n用法：<code>${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120</code>`);
            return;
          }
          if (!expiryParsed) {
            await reply(
              `❌ 没给到期日，要 ${escapeHtml(DATE_FORMAT_HINT)}\n例如：<code>${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120</code>`,
            );
            return;
          }
          // 日期就是到期日，注册日自动往前推 365 天
          const expiry = toISO(expiryParsed.y, expiryParsed.m, expiryParsed.d);
          const registered = addDaysISO(expiry, -VALIDITY_DAYS);
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const idx = db.data.domains.findIndex((d) => d.domain === domain);
          // 已有域名再 add 是续签更新：ID 不变；新域名按顺序拿下一个号
          const id = idx >= 0 ? db.data.domains[idx].id : nextId(db.data);
          const record: DomainRecord = {
            id,
            domain,
            official,
            registered,
            expiry,
            early,
            notified: [],
          };
          if (idx >= 0) {
            db.data.domains[idx] = record;
          } else {
            db.data.domains.push(record);
          }
          await db.write();
          const today = todayStr();
          const receiptNote =
            String(db.data.receiptTo || "").trim() === "off"
              ? `\n回执已关闭（off），想发就发 <code>${mainPrefix}domain setreceipt 123456789</code>`
              : String(db.data.receiptTo || "").trim()
                ? `\n回执已沿用：<code>${escapeHtml(String(db.data.receiptTo))}</code>（设一次就行，不用再设）`
                : `\n回执还没设：现在不发回执，想发就发 <code>${mainPrefix}domain setreceipt 123456789</code>`;
          await reply(
            `${idx >= 0 ? "已更新" : "已添加"}：<code>${escapeHtml(domain)}</code>\n${domainLine(record, today)}${receiptNote}`,
          );
          return;
        }

        // ---- 删域名（ID 或域名都能删，删完自动补位）----
        if (sub === "rm" || sub === "remove" || sub === "del") {
          const target = args[1];
          if (!target) {
            await reply(
              `用法：<code>${mainPrefix}domain rm &lt;编号或域名&gt;</code>\n例如：<code>${mainPrefix}domain rm 2</code> 或 <code>${mainPrefix}domain rm xxx.pp.ua</code>`,
            );
            return;
          }
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const idx = findDomainIndex(db.data, target);
          if (idx < 0) {
            await reply(`没找到：<code>${escapeHtml(target)}</code>，先发 <code>${mainPrefix}domain ls</code> 看编号`);
            return;
          }
          const removed = db.data.domains[idx];
          db.data.domains.splice(idx, 1);
          renumberDomains(db.data);
          await db.write();
          const rest = db.data.domains.length
            ? db.data.domains.map((d) => `<code>${d.id}</code> ${escapeHtml(d.domain)}`).join("、")
            : "列表已空";
          await reply(
            `已删除：<code>${removed.id}</code> • <code>${escapeHtml(removed.domain)}</code>\n剩下已自动补位：${rest}`,
          );
          return;
        }

        // ---- 回执（只设一次，全体生效；没设就不发）----
        if (sub === "setreceipt" || sub === "receipt") {
          const target = args[1];
          const db = await getDB();
          if (!target) {
            await reply(
              `当前回执接收人：${escapeHtml(receiptLabel(db.data))}\n用法：<code>${mainPrefix}domain setreceipt 123456789</code> / <code>${mainPrefix}domain setreceipt off</code>`,
            );
            return;
          }
          if (target === "off") {
            db.data.receiptTo = "off";
            await db.write();
            await reply(`✅ 已关闭域名到期回执`);
            return;
          }
          if (!/^-?\d+$/.test(target)) {
            await reply(`接收人 ID 必须是数字，例如 123456789，或 off`);
            return;
          }
          db.data.receiptTo = String(Number(target));
          await db.write();
          await reply(
            `✅ 已设置域名到期回执接收人：<code>${escapeHtml(db.data.receiptTo)}</code>\n只设这一次就行：以后新加域名自动沿用这个 ID；到了可续时间每天 12:30 发一条回执到这个 ID`,
          );
          return;
        }

        // ---- 改域名（ID 或域名都能改，改完立刻生效）----
        if (sub === "edit") {
          const target = args[1];
          const field = (args[2] || "").toLowerCase();
          const value = args.slice(3).join(" ").trim();
          const db = await getDB();
          if (!target) {
            await reply(
              `用法：<code>${mainPrefix}domain edit &lt;编号或域名&gt; &lt;字段&gt; &lt;新值&gt;</code>\n字段：date / expiry / early / official\n例如：<code>${mainPrefix}domain edit 2 expiry 2027-09-30</code>、<code>${mainPrefix}domain edit 2 early 90</code>、<code>${mainPrefix}domain edit 2 official https://nic.pp.ua</code>`,
            );
            return;
          }
          if (normalizeDomains(db.data)) await db.write();
          const idx = findDomainIndex(db.data, target);
          if (idx < 0) {
            await reply(`没找到：<code>${escapeHtml(target)}</code>，先发 <code>${mainPrefix}domain ls</code> 看编号`);
            return;
          }
          const rec = db.data.domains[idx];
          if (!field) {
            await reply(domainLine(rec, todayStr()));
            return;
          }
          if (field === "early") {
            const n = Number(value);
            if (!/^\d+$/.test(value) || n < 1 || n > 365) {
              await reply(`❌ 提前天数要是 1~365 的数字，例如：<code>${mainPrefix}domain edit 2 early 90</code>`);
              return;
            }
            rec.early = n;
            rec.notified = [];
            await db.write();
            await reply(`已修改：\n${domainLine(rec, todayStr())}`);
            return;
          }
          if (field === "official") {
            if (!/^https?:\/\//i.test(value)) {
              await reply(`❌ 官网要以 https:// 开头，例如：<code>${mainPrefix}domain edit 2 official https://nic.pp.ua</code>`);
              return;
            }
            rec.official = cleanOfficial(value);
            await db.write();
            await reply(`已修改：\n${domainLine(rec, todayStr())}`);
            return;
          }
          if (field !== "date" && field !== "expiry") {
            await reply(`❌ 只能改 date（注册日）、expiry（到期日）、early（提前天数）或 official（官网），例如：<code>${mainPrefix}domain edit 2 expiry 2027-09-30</code>`);
            return;
          }
          const parsed = parseDateStrict(value);
          if (!parsed) {
            await reply(
              `❌ 日期格式不对，要 ${escapeHtml(DATE_FORMAT_HINT)}，你输的是：${escapeHtml(value)}`,
            );
            return;
          }
          const iso = toISO(parsed.y, parsed.m, parsed.d);
          if (field === "date") {
            // 改注册日：到期日跟着重算（注册日 + 365 天）
            rec.registered = iso;
            if (rec.expiry !== "永久") rec.expiry = addDaysISO(iso, VALIDITY_DAYS);
          } else {
            // 改到期日：注册日自动往前推（到期日 - 365 天），永久的旧记录改回要到期
            rec.expiry = iso;
            rec.registered = addDaysISO(iso, -VALIDITY_DAYS);
          }
          rec.notified = [];
          await db.write();
          await reply(`已修改：\n${domainLine(rec, todayStr())}`);
          return;
        }

        await reply(help_text);
        return;
      } catch (e: any) {
        console.error("[domain] 执行失败:", e);
        try {
          await msg.edit({ text: `❌ 执行失败：${escapeHtml(e?.message || String(e))}`, parseMode: "html" });
        } catch {}
      }
    },
  };
}

export default new DomainPlugin();
