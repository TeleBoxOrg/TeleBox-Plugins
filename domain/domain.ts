import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

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
  account: string; // 哪个账号的，例如 adjlevis@qq.com；同一网站不同账号靠它区分，不填就是 ""
  registered: string; // YYYY-MM-DD
  expiry: string; // YYYY-MM-DD；以前永久的旧记录是 "永久"，只显示不提醒
  early: number; // 提前多少天可续，默认 120
  notified: Array<number | string>; // 已发过的档位：只有 "expired"
};

type DomainDB = {
  receiptTo?: string; // 没设 = 不发回执；填数字 ID = 发给那个 ID；off = 不发
  officialMap?: Record<string, string>; // 后缀 → 官网，用户自己加的映射，存在配置文件里，不用改脚本
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

function addYearsISO(iso: string, years: number): string {
  const p = parseDateStrict(iso);
  if (!p) return iso;
  const y = p.y + years;
  const dt = new Date(Date.UTC(y, p.m - 1, p.d));
  if (dt.getUTCMonth() === p.m - 1) {
    return toISO(y, p.m, p.d);
  }
  // 2 月 29 日延到平年：落在当月最后一天（2 月 28 日）。
  const lastDay = new Date(Date.UTC(y, p.m, 0)).getUTCDate();
  return toISO(y, p.m, lastDay);
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

// 后缀统一成小写带点，如 indevs.in、.indevs.in、*.indevs.in 都变成 .indevs.in；不对的返回 null。
function cleanSuffix(s: string): string | null {
  const v = (s || "").trim().toLowerCase().replace(/^\*\.?/, "").replace(/^\.+/, "");
  if (!v || v.includes("..") || v.endsWith(".") || !/^[a-z0-9\-\.]+$/.test(v)) return null;
  return `.${v}`;
}

// 官网按后缀猜：先查用户自己加的映射（.domain map），再查内置的；都猜不到就留空。
// 映射存在 domain_config.json 里，以后新注册商发一条 map 就行，不用改脚本、不用重装。
function inferOfficial(domain: string, map?: Record<string, string>): string {
  const d = (domain || "").toLowerCase();
  // 用户映射优先，后缀越长越优先（.indevs.in 优先于 .in）
  if (map) {
    let bestSuffix = "";
    let bestUrl = "";
    for (const [key, url] of Object.entries(map)) {
      const suffix = cleanSuffix(key);
      if (suffix && d.endsWith(suffix) && suffix.length > bestSuffix.length) {
        bestSuffix = suffix;
        bestUrl = url;
      }
    }
    if (bestSuffix) return cleanOfficial(bestUrl);
  }
  if (
    d.endsWith(".dpdns.org") ||
    d.endsWith(".qzz.io") ||
    d.endsWith(".qd.je") ||
    d.endsWith(".us.kg") ||
    d.endsWith(".xx.kg")
  )
    return "https://dashboard.digitalplat.org";
  if (d.endsWith(".pp.ua")) return "https://nic.pp.ua";
  if (d.endsWith(".eu.cc")) return "https://www.gname.vip/tld-eu-cc.html#registered";
  // Stackryze 免费域名：.indevs.in、.ryzedns.org、.sryze.cc、.nx.kg（每账号最多 5 个）
  if (
    d.endsWith(".indevs.in") ||
    d.endsWith(".ryzedns.org") ||
    d.endsWith(".sryze.cc") ||
    d.endsWith(".nx.kg")
  )
    return "https://domain.stackryze.com/";
  return "";
}

// 账号：原样存，邮箱存完整邮箱，直接显示。
function cleanAccount(s: string): string {
  return (s || "").trim().replace(/[:：,，、;；]+$/, "").trim();
}

function extractAccount(line: string): string | null {
  const m = /[^\s]+@[^\s]+/.exec(line || "");
  return m ? cleanAccount(m[0]) : null;
}

// 已知的四个账号：库里以前只存了脱敏的（ad***@qq.com），完整邮箱靠这张表还原；
// 新加的账号直接存完整邮箱，不用这张表。
const FULL_ACCOUNT_MAP: Record<string, string> = {
  "ad***@qq.com": "adjlevis@qq.com",
  "li***@gmail.com": "liu687836@gmail.com",
  "dj***@gmail.com": "djbadboy.vip@gmail.com",
  "56***@qq.com": "56959566@qq.com",
};

// 脱敏的账号还原成完整邮箱；本来就是完整邮箱或不在表里的，原样返回。
function unmaskAccount(account: string): string {
  const v = (account || "").trim();
  return FULL_ACCOUNT_MAP[v.toLowerCase()] || v;
}

// 按账号分组：按编号顺序第一次出现的账号排前面，没写账号的排最后。
// shortId 是“账号1、账号2……”按全表第一次出现的顺序编的，ls 和回执都按全表编，
// 所以只看其中一个账号时编号也不会变。
function groupByAccount(rows: DomainRecord[], allRows: DomainRecord[] = rows): Array<{ account: string; shortId: string; rows: DomainRecord[] }> {
  const order: string[] = [];
  const map = new Map<string, DomainRecord[]>();
  for (const d of rows) {
    const key = (d.account || "").trim();
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(d);
  }
  const allAccounts = [...new Set(allRows.map((d) => (d.account || "").trim()).filter(Boolean))];
  const sorted = [...order.filter((a) => a !== ""), ...order.filter((a) => a === "")];
  return sorted.map((account) => {
    const idx = allAccounts.indexOf(account);
    return {
      account,
      shortId: account === "" ? "未分组" : idx >= 0 ? `账号${idx + 1}` : account,
      rows: map.get(account)!,
    };
  });
}

// 账号颜色：TG 不能给 👤 本身换颜色，就在 👤 前面加一个彩色圆点，一个账号一个颜色，
// 颜色按账号在全表里第一次出现的顺序取（和“账号1、账号2……”同一个顺序），
// 同一个账号在哪个组、哪一页都是同一个颜色，扫一眼颜色就知道是谁的。
const ACCOUNT_COLORS = ["🔵", "🟢", "🟠", "🔴", "🟣", "🟡", "🟤", "⚫"];
function accountColorDot(account: string, rows: DomainRecord[]): string {
  const a = (account || "").trim();
  if (!a) return "";
  const sorted = [...rows].sort((x, y) => (x.id || 0) - (y.id || 0));
  const allAccounts = [...new Set(sorted.map((d) => (d.account || "").trim()).filter(Boolean))];
  const idx = allAccounts.indexOf(a);
  if (idx < 0) return "";
  return ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length];
}

// 按官网分组：同一个官网的一组，不同账号也在同一组里；官网是每条记录自带的，自动检测，不用手动分。
function groupByOfficial(rows: DomainRecord[]): Array<{ official: string; rows: DomainRecord[] }> {
  const order: string[] = [];
  const map = new Map<string, DomainRecord[]>();
  for (const d of rows) {
    const key = cleanOfficial((d.official || "").trim());
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(d);
  }
  return order.map((official) => ({ official, rows: map.get(official)! }));
}

// 官网只显示到域名这一节：https://www.gname.vip/tld-eu-cc.html#registered 只显示 https://www.gname.vip。
// 存的还是完整地址，点开照样去完整页面。
function originOf(url: string): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec((url || "").trim());
  return m ? m[1] : (url || "").trim();
}

// 分组列表里的组头：组字母 + 官网域名就是组名，没填官网的放一组；点开去完整官网地址。
function officialHeader(official: string, groupLetter = ""): string {
  const name = official
    ? `<a href="${escapeHtml(official)}">${escapeHtml(originOf(official))}</a>`
    : "未填官网";
  return groupLetter ? `🌐 ${groupLetter}组 · ${name}` : `🌐 ${name}`;
}

// 字母编号：0 -> A, 25 -> Z, 26 -> AA, 27 -> AB……组和账号都用这个，组从 A 到 Z。
function letterOf(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// 字母编号：组里第一个账号直接排号，如 A1、B1、D1；第二个账号是 1-，如 A1-1、B1-1；
// 第三个账号起是账号号，如 B3-1、C3-1（B 组第三个账号就是 B3-1、B3-2）。
// 组字母按全表里先出现的官网排；账号按组里先出现的排，没账号的也算一个。
// 编号是算出来的，不存进库里：组、账号、位置一变，编号跟着变，和删了自动补位一个道理。
// 以后再加一个账号，它自动排到下一个号（组里第三个账号就是 A3-1），原来的编号不动。
function buildLetterIds(allRows: DomainRecord[]): Map<number, string> {
  const rows = [...allRows].sort((a, b) => (a.id || 0) - (b.id || 0));
  const map = new Map<number, string>();
  groupByOfficial(rows).forEach((g, gi) => {
    const groupLetter = letterOf(gi);
    const accounts = [...new Set(g.rows.map((d) => (d.account || "").trim()))];
    const counters = new Map<string, number>();
    for (const d of g.rows) {
      const acc = (d.account || "").trim();
      const accIdx = accounts.indexOf(acc);
      const n = (counters.get(acc) || 0) + 1;
      counters.set(acc, n);
      // 第二个账号是 1-，第三个起是账号号（3-、4-……）。
      const dashNum = accIdx === 1 ? 1 : accIdx + 1;
      map.set(d.id, accIdx === 0 ? `${groupLetter}${n}` : `${groupLetter}${dashNum}-${n}`);
    }
  });
  return map;
}

// 分组列表用的组：按官网分，组字母按全表排（子集里先出现的组不一定是 A 组），组按全表顺序排，组内按编号。
function listGroups(rows: DomainRecord[], allRows: DomainRecord[]): Array<{ official: string; letter: string; rows: DomainRecord[] }> {
  const sub = groupByOfficial(rows);
  const byOfficial = new Map(sub.map((g) => [g.official, g.rows]));
  // 组字母按全表里的位置取：先按全表排好再挑出本页有的组，不能先过滤再数位置，
  // 不然第 2 页的 B 组会变成 A 组（过滤后的第 0 个）。
  const result: Array<{ official: string; letter: string; rows: DomainRecord[] }> = [];
  groupByOfficial(allRows).forEach((g, gi) => {
    const pageRows = byOfficial.get(g.official);
    if (pageRows) result.push({ official: g.official, letter: letterOf(gi), rows: pageRows });
  });
  return result;
}


// 编号整理成 1、2、3…，不留空号；旧记录缺官网/提前天数时补默认。
function normalizeDomains(data: DomainDB): boolean {
  let changed = false;
  // 用户加的后缀 → 官网映射：键统一成小写带点后缀，值去掉末尾 /，无效的丢掉。
  if (!data.officialMap || typeof data.officialMap !== "object") {
    data.officialMap = {};
    changed = true;
  } else {
    const cleaned: Record<string, string> = {};
    for (const [key, url] of Object.entries(data.officialMap)) {
      const suffix = cleanSuffix(key);
      const cleanedUrl = cleanOfficial(url);
      if (suffix && /^https?:\/\//i.test(cleanedUrl)) cleaned[suffix] = cleanedUrl;
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(data.officialMap)) {
      data.officialMap = cleaned;
      changed = true;
    }
  }
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
    if (d.account === undefined) {
      d.account = "";
      changed = true;
    } else if (d.account && d.account.includes("@")) {
      // 以前只存脱敏的，完整邮箱靠表还原；新加的本来就是完整的，不用动。
      const full = unmaskAccount(d.account);
      if (full !== d.account) {
        d.account = full;
        changed = true;
      }
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

// rm / edit / renew 既能用数字 ID、字母编号，也能用域名。字母编号不分大小写，如 a1-1 和 A1-1 一样。
function findDomainIndex(data: DomainDB, target: string): number {
  const t = (target || "").trim();
  if (/^\d+$/.test(t)) {
    const id = Number(t);
    return (data.domains || []).findIndex((d) => d.id === id);
  }
  if (/^[A-Za-z]{1,3}\d+(-\d+)?$/.test(t)) {
    const want = t.toUpperCase();
    const letterIds = buildLetterIds(data.domains || []);
    for (const [id, letter] of letterIds) {
      if (letter === want) return (data.domains || []).findIndex((d) => d.id === id);
    }
    return -1;
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

function domainLine(d: DomainRecord, today: string, showAccount = true, showOfficial = true, letterId = "", allRows: DomainRecord[] | null = null): string {
  const dot = d.account && showAccount && allRows ? accountColorDot(d.account, allRows) : "";
  const dotPrefix = dot ? dot + " " : "";
  if (d.expiry === "永久") {
    return `<code>${letterId || d.id}</code> • <code>${escapeHtml(d.domain)}</code> 注册：${escapeHtml(d.registered)} 到期：永久${d.account && showAccount ? ` ${dotPrefix}👤 <code>${escapeHtml(d.account)}</code>` : ""}`;
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
  const officialLine = d.official && showOfficial
    ? `\n官网：<a href="${escapeHtml(d.official)}">${escapeHtml(originOf(d.official))}</a>`
    : "";
  const accountLine = d.account && showAccount
    ? `\n${dotPrefix}👤 <code>${escapeHtml(d.account)}</code>`
    : "";
  return (
    `<code>${letterId || d.id}</code> • <code>${escapeHtml(d.domain)}</code>${officialLine}${accountLine}\n` +
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
  const allRows = [...db.data.domains].sort((a, b) => (a.id || 0) - (b.id || 0));
  const letterIds = buildLetterIds(allRows);
  for (const g of listGroups(due, allRows)) {
    parts.push(officialHeader(g.official, g.letter));
    for (const d of g.rows) parts.push(domainLine(d, today, true, false, letterIds.get(d.id) || "", allRows));
    parts.push("");
  }
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

▎加 / 看
<pre>
添加：${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120
查看：${mainPrefix}domain ls [页码]
只看：${mainPrefix}domain ls 账号1 [页码]
</pre>
域名 / 官网 / 到期日 / 提前天数，官网和 120 不写也行。加时在最后写邮箱就是账号，显示完整邮箱。
列表按官网分组排，一页 10 个，不写页码看第 1 页。编号：组里第一个账号直接排，如 A1、B1；第二个账号是 A1-1、A1-2，第三个是 B3-1；字母不分大小写。
手动续完发 renew 就停提醒、重新计时（不写日期按旧到期日延一年），已有的账号和提前天数不会丢。
日期：2027-09-30、2027/9/30、19/12/2027 都行。

▎批量加
<pre>
批量：${mainPrefix}domain import https://dashboard.digitalplat.org 120
回复：${mainPrefix}domain import
映射：${mainPrefix}domain map .xxx.com https://xxx.com
</pre>
每行一个：域名 到期日，或域名 剩 136 天；直接粘在命令下面也行。回复那行是回复一条列表消息再发。
账号头行先写一行邮箱，后面几行都归这个账号；三个账号写三个头行，列表按官网分组，每条下面写账号，显示完整邮箱。
新后缀不用改脚本：发一条 map 就记住了，存在配置里，重启还在。

▎改
<pre>
到期：${mainPrefix}domain edit B1 expiry 2027-09-30
提前：${mainPrefix}domain edit B1 early 90
官网：${mainPrefix}domain edit B1 official https://xxx.com
多个：${mainPrefix}domain edit B1 B2 expiry 2027-09-30
注册：${mainPrefix}domain edit B1 date 2026-09-30
账号：${mainPrefix}domain edit B1 account name@example.com
续期：${mainPrefix}domain renew C1 C2 [2028-01-17]
</pre>
字段前面全是目标，多个编号/域名混着写也行。编号写字母编号就行，如 B1-1，字母不分大小写；原来的数字编号也能用。
续期不写日期就按旧到期日延一年，提醒从今天重新算。

▎删
<pre>
删除：${mainPrefix}domain rm B1 B2
全删：${mainPrefix}domain rm all
</pre>

▎回执
<pre>
设置：${mainPrefix}domain setreceipt 123456789
关闭：${mainPrefix}domain setreceipt off
</pre>
设一次就行，没设不发。`;

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
          // .domain ls [账号] [页码]：先按官网分组排（组内按字母编号），再一页 10 个；页码就是纯数字。
          const PAGE_SIZE = 10;
          let filterRaw = (args[1] || "").trim();
          let page = 1;
          const pageArg = (args[2] || "").trim();
          if (/^\d+$/.test(filterRaw)) {
            // 第一个就是纯数字：它是页码，不是账号。
            page = Number(filterRaw);
            filterRaw = "";
          } else if (/^\d+$/.test(pageArg)) {
            page = Number(pageArg);
          }
          const allRows = [...db.data.domains].sort((a, b) => (a.id || 0) - (b.id || 0));
          let rows = allRows;
          if (filterRaw) {
            const byShort = new Map(groupByAccount(allRows, allRows).map((g) => [g.shortId, g.account]));
            const wanted = filterRaw === "未分组" ? "" : (byShort.get(filterRaw) ?? filterRaw);
            // 完整邮箱和脱敏的写法都能查到：都先还原成完整邮箱再比。
            const wantedFull = unmaskAccount(wanted).toLowerCase();
            rows = rows.filter((d) => unmaskAccount((d.account || "").trim()).toLowerCase() === wantedFull);
            if (rows.length === 0) {
              await reply(`这个账号下没有域名：<code>${escapeHtml(filterRaw)}</code>\n先发 <code>${mainPrefix}domain ls</code> 看全部账号`);
              return;
            }
          }
          // 先按官网分组排：一个官网的放一起，再分页，组就不会在几页里交错出现。
          const letterIds = buildLetterIds(allRows);
          const groupedRows = listGroups(rows, allRows).flatMap((g) => g.rows);
          const totalPages = Math.max(1, Math.ceil(groupedRows.length / PAGE_SIZE));
          if (page < 1 || page > totalPages) {
            await reply(`只有 ${totalPages} 页：<code>${mainPrefix}domain ls${filterRaw ? ` ${escapeHtml(filterRaw)}` : ""}</code> 看第 1 页`);
            return;
          }
          const pageRows = groupedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
          const out: string[] = [`📋 域名列表（${today}）`, ""];
          for (const g of listGroups(pageRows, allRows)) {
            out.push(officialHeader(g.official, g.letter));
            for (const d of g.rows) out.push(domainLine(d, today, true, false, letterIds.get(d.id) || "", allRows));
            out.push("");
          }
          const nextHint = page < totalPages ? `，下一页：<code>${mainPrefix}domain ls${filterRaw ? ` ${escapeHtml(filterRaw)}` : ""} ${page + 1}</code>` : "";
          out.push(`第 ${page}/${totalPages} 页，共 ${rows.length} 个${nextHint}`);
          if (page === totalPages) {
            out.push(`回执：${escapeHtml(receiptLabel(db.data))}`);
            out.push(`每天检查：12:30（<code>${escapeHtml(CHECK_CRON)}</code>）`);
          }
          await reply(out.join("\n").trim());
          return;
        }

        // ---- 加域名：add <域名> [官网] <到期日> [提前天数]，日期就是到期日 ----
        if (sub === "add") {
          const rawDomain = args[1];
          if (!rawDomain) {
            await reply(
              `用法：<code>${mainPrefix}domain add &lt;域名&gt; [官网] &lt;到期日&gt; [提前天数] [账号]</code>\n例如：<code>${mainPrefix}domain add xxx.pp.ua https://nic.pp.ua 2027-09-30 120</code>\n账号写邮箱或“账号1”都行，邮箱完整保存和显示\n日期支持 ${escapeHtml(DATE_FORMAT_HINT)}`,
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
          // 逐个认后面的参数：官网（http 开头）、到期日（日期）、提前天数（数字）、账号（带 @ 的邮箱，或 account/账号 后面跟的那个）；exp / 到期 后面跟的也是到期日
          let official = "";
          let account = "";
          let officialGiven = false;
          let accountGiven = false;
          let earlyGiven = false;
          let expiryParsed: { y: number; m: number; d: number } | null = null;
          let early = DEFAULT_EARLY_DAYS;
          const rest = args.slice(2);
          for (let i = 0; i < rest.length; i++) {
            const tok = (rest[i] || "").trim();
            if (!tok) continue;
            if (["exp", "expiry", "到期"].includes(tok.toLowerCase())) continue;
            if (["account", "acc", "账号"].includes(tok.toLowerCase())) {
              const next = (rest[i + 1] || "").trim();
              if (next) {
                account = unmaskAccount(next);
                accountGiven = true;
                i++;
                continue;
              }
            }
            if (tok.includes("@")) {
              account = unmaskAccount(tok);
              accountGiven = true;
              continue;
            }
            if (/^https?:\/\//i.test(tok)) {
              official = cleanOfficial(tok);
              officialGiven = true;
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
                earlyGiven = true;
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
          // 官网没写就按后缀猜：先查用户映射，再查内置
          if (!official) official = inferOfficial(domain, db.data.officialMap);
          const idx = db.data.domains.findIndex((d) => d.domain === domain);
          // 已有域名再 add 是续签更新：ID 不变，没写的字段沿用旧的（账号、提前天数、官网都不会丢），
          // 只改到期日/注册日，并清掉“已过期”标记，重新开始计时；新域名按顺序拿下一个号。
          const id = idx >= 0 ? db.data.domains[idx].id : nextId(db.data);
          const old = idx >= 0 ? db.data.domains[idx] : null;
          const record: DomainRecord = {
            id,
            domain,
            official: officialGiven ? official : old?.official || inferOfficial(domain, db.data.officialMap),
            account: accountGiven ? account : old?.account || "",
            registered,
            expiry,
            early: earlyGiven ? early : old?.early || DEFAULT_EARLY_DAYS,
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
          const letterIds = buildLetterIds(db.data.domains);
          await reply(
            `${idx >= 0 ? "已更新" : "已添加"}：<code>${escapeHtml(domain)}</code>\n${domainLine(record, today, true, true, letterIds.get(record.id) || "", db.data.domains)}${receiptNote}`,
          );
          return;
        }

        // ---- 批量加：import，一次粘贴多行，不用一条一条加 ----
        // 两种用法：
        // 1) 直接粘在命令下面发，一条消息里写完：
        //    .domain import https://dashboard.digitalplat.org 120
        //    djabc.dpdns.org 2027-04-01
        //    djcf.qzz.io 2027-05-09
        // 2) 回复一条列表消息发 .domain import [官网] [提前天数]，
        //    列表每行一个域名，写到期日或“剩 N 天”都行，邮箱、编号、⚪️ 这些行会自动跳过。
        if (sub === "import" || sub === "addmany" || sub === "batch") {
          // 第一行后面的参数：官网（http 开头）、提前天数（数字）、账号（带 @ 的邮箱，或 account/账号 后面跟的那个）。
          let importOfficial = "";
          let importEarly = DEFAULT_EARLY_DAYS;
          let importAccount = "";
          const importArgs = args.slice(1);
          for (let ai = 0; ai < importArgs.length; ai++) {
            const tok = importArgs[ai];
            if (/^https?:\/\//i.test(tok)) importOfficial = cleanOfficial(tok);
            else if (["account", "acc", "账号"].includes(tok.toLowerCase())) {
              const next = importArgs[ai + 1];
              if (next) {
                importAccount = unmaskAccount(next);
                ai++;
              }
            } else if (tok.includes("@")) importAccount = unmaskAccount(tok);
            else if (/^\d+$/.test(tok)) {
              const n = Number(tok);
              if (n >= 1 && n <= 365) importEarly = n;
            }
          }
          // 来源：命令下面粘的行优先；没有就取回复的那条消息。
          const pastedLines = (lines || []).slice(1).map((l) => l.trim()).filter(Boolean);
          let sourceText = pastedLines.join("\n");
          if (!sourceText) {
            if ((msg as any).isReply) {
              try {
                const replied: any = await safeGetReplyMessage(msg);
                sourceText = String(replied?.message ?? replied?.text ?? "").trim();
              } catch {}
            }
          }
          if (!sourceText) {
            await reply(
              `用法：把列表粘在命令下面一起发，或回复一条列表消息再发 <code>${mainPrefix}domain import [官网] [提前天数] [账号]</code>\n每行一个：<code>域名 到期日</code> 或 <code>域名 剩 136 天</code>\n账号头行：先写一行邮箱，后面几行都归这个账号；三个账号写三个头行\n例如：\n<code>${mainPrefix}domain import https://dashboard.digitalplat.org 120\ndjabc.dpdns.org 2027-04-01\ndjcf.qzz.io 2027-05-09</code>`,
            );
            return;
          }
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const today = todayStr();
          const added: DomainRecord[] = [];
          const updated: DomainRecord[] = [];
          const skipped: string[] = [];
          const seenInBatch = new Set<string>();
          let currentAccount = importAccount;
          for (const rawLine of sourceText.split(/\r?\n/)) {
            const line = (rawLine || "").trim();
            if (!line) continue;
            // 账号头行：整行是邮箱（“1. adjlevis@qq.com”）、或“账号1 + 邮箱”——
            // 后面几行都归这个账号，直到下一个头行。头行里的邮箱存完整的。
            // 但“域名 + 邮箱”这种行不是头行（域名在 @ 前面、还带到期日或“剩 N 天”），别误判。
            const headerEmail = extractAccount(line);
            if (headerEmail) {
              const beforeAt = line.slice(0, line.indexOf("@"));
              // @ 前面最后一个 token 是邮箱的 local 部分（如 djbadboy.vip），不算域名；
              // 只有它前面的 token 里有域名（如 djabc.dpdns.org），这行才不是头行。
              const beforeTokens = beforeAt.trim().split(/\s+/).filter(Boolean);
              const hasDomainBeforeAt = beforeTokens.slice(0, -1).some((tok) => /[a-z0-9\-]+\.[a-z]{2,}/i.test(tok.replace(/^\d+[.、]/, "")));
              const hasDateOrLeft = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(line) || /剩\s*\d+\s*天/.test(line);
              if (!hasDomainBeforeAt && !hasDateOrLeft) {
                currentAccount = unmaskAccount(headerEmail);
                continue;
              }
            }
            // 行里找域名：xn--2br42u.dpdns.org 这种 punycode 也能认。
            const domainMatch = /[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/i.exec(line);
            const domain = domainMatch ? cleanDomain(domainMatch[0]) : null;
            if (!domain) continue; // 邮箱、编号、“1. adjlevis@qq.com”这种行直接跳过
            if (seenInBatch.has(domain)) continue;
            // 到期日：行里找 YYYY-MM-DD / YYYY/M/D / D/M/YYYY；没有就找“剩 N 天”，按今天往后推。
            let expiry = "";
            const dateMatch = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/.exec(line);
            if (dateMatch) {
              const parsed = parseDateStrict(dateMatch[1]);
              if (parsed) expiry = toISO(parsed.y, parsed.m, parsed.d);
            }
            if (!expiry) {
              const leftMatch = /剩\s*(\d+)\s*天/.exec(line);
              if (leftMatch) expiry = addDaysISO(today, Number(leftMatch[1]));
            }
            if (!expiry) {
              skipped.push(line);
              continue;
            }
            const lineOfficialMatch = /https?:\/\/[^\s]+/i.exec(line);
            const official = lineOfficialMatch
              ? cleanOfficial(lineOfficialMatch[0])
              : importOfficial || inferOfficial(domain, db.data.officialMap);
            // 这行自己带了邮箱就是这行的账号，没带就沿用上面那个账号头行。
            const lineAccount = extractAccount(line);
            const account = lineAccount ? unmaskAccount(lineAccount) : currentAccount;
            const lineEarlyMatch = /(?:^|\s)(\d{1,3})(?:\s*$)/.exec(line.replace(dateMatch?.[1] || "", ""));
            let early = importEarly;
            if (lineEarlyMatch && !/剩\s*\d+\s*天/.test(line)) {
              const n = Number(lineEarlyMatch[1]);
              if (n >= 1 && n <= 365) early = n;
            }
            seenInBatch.add(domain);
            const registered = addDaysISO(expiry, -VALIDITY_DAYS);
            const idx = db.data.domains.findIndex((d) => d.domain === domain);
            const id = idx >= 0 ? db.data.domains[idx].id : nextId(db.data);
            const record: DomainRecord = { id, domain, official, account, registered, expiry, early, notified: [] };
            if (idx >= 0) {
              db.data.domains[idx] = record;
              updated.push(record);
            } else {
              db.data.domains.push(record);
              added.push(record);
            }
          }
          if (added.length === 0 && updated.length === 0) {
            await reply(
              `一个都没加上：每行要带到期日或“剩 N 天”，例如 <code>djabc.dpdns.org 2027-04-01</code> 或 <code>djabc.dpdns.org 剩 136 天</code>${skipped.length ? `\n跳过的行：${skipped.map((s) => escapeHtml(s)).join("、")}` : ""}`,
            );
            return;
          }
          await db.write();
          const skippedNote = skipped.length
            ? `\n跳过（没给到期日）：${skipped.map((s) => `<code>${escapeHtml(s)}</code>`).join("、")}`
            : "";
          const importedRows = [...added, ...updated].sort((a, b) => (a.id || 0) - (b.id || 0));
          const allRows = [...db.data.domains].sort((a, b) => (a.id || 0) - (b.id || 0));
          const letterIds = buildLetterIds(allRows);
          const importGroups = listGroups(importedRows, allRows);
          const importLines: string[] = [];
          for (const g of importGroups) {
            importLines.push(officialHeader(g.official, g.letter));
            for (const d of g.rows) {
              const dot = accountColorDot(d.account, allRows);
              importLines.push(`<code>${letterIds.get(d.id) || d.id}</code> • <code>${escapeHtml(d.domain)}</code> 到期 ${escapeHtml(d.expiry)}${d.account ? ` ${dot ? dot + " " : ""}👤 <code>${escapeHtml(d.account)}</code>` : ""}`);
            }
          }
          await reply(
            `已批量加 ${added.length + updated.length} 个（新加 ${added.length} 个，更新 ${updated.length} 个）：\n${importLines.join("\n")}${skippedNote}`,
          );
          return;
        }

        // ---- 删域名（数字 ID、字母编号或域名都能删，可一次删多个，删完自动补位）----
        // 关键：先按删除前的原编号把所有目标都解析出来，再一次过滤掉，
        // 不能一个一个按 ID 删 —— 删掉 1 号后，原来的 2 号就变成 1 号了，
        // 再按旧号删会删错。域名去重：同一个域名写两次、或 ID 和域名指同一个，只删一次。
        if (sub === "rm" || sub === "remove" || sub === "del") {
          const targets = args.slice(1).map((a) => (a || "").trim()).filter(Boolean);
          if (targets.length === 0) {
            await reply(
              `用法：<code>${mainPrefix}domain rm &lt;编号或域名&gt; [编号或域名...]</code>\n例如：<code>${mainPrefix}domain rm B1 B2</code> 或 <code>${mainPrefix}domain rm xxx.pp.ua</code> 或 <code>${mainPrefix}domain rm all</code> 全删`,
            );
            return;
          }
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          // 全删：rm all
          if (targets.length === 1 && targets[0].toLowerCase() === "all") {
            if (db.data.domains.length === 0) {
              await reply(`列表已经是空的，没什么可删`);
              return;
            }
            const removedAll = [...db.data.domains].sort((a, b) => (a.id || 0) - (b.id || 0));
            const letterIdsAll = buildLetterIds(removedAll);
            db.data.domains = [];
            await db.write();
            await reply(
              `已删除全部 ${removedAll.length} 个：${removedAll.map((d) => `<code>${letterIdsAll.get(d.id) || d.id}</code> ${escapeHtml(d.domain)}`).join("、")}\n列表已空`,
            );
            return;
          }
          const removed: DomainRecord[] = [];
          const removedDomains = new Set<string>();
          const missing: string[] = [];
          for (const target of targets) {
            const idx = findDomainIndex(db.data, target);
            if (idx < 0) {
              missing.push(target);
              continue;
            }
            const rec = db.data.domains[idx];
            if (removedDomains.has(rec.domain)) continue;
            removedDomains.add(rec.domain);
            removed.push(rec);
          }
          if (removed.length === 0) {
            await reply(`没找到：${missing.map((t) => `<code>${escapeHtml(t)}</code>`).join("、")}，先发 <code>${mainPrefix}domain ls</code> 看编号`);
            return;
          }
          const removedLetterIds = buildLetterIds(db.data.domains);
          db.data.domains = db.data.domains.filter((d) => !removedDomains.has(d.domain));
          renumberDomains(db.data);
          await db.write();
          const restLetterIds = buildLetterIds(db.data.domains);
          const rest = db.data.domains.length
            ? db.data.domains.map((d) => `<code>${restLetterIds.get(d.id) || d.id}</code> ${escapeHtml(d.domain)}`).join("、")
            : "列表已空";
          const missingNote = missing.length
            ? `\n没找到（已跳过）：${missing.map((t) => `<code>${escapeHtml(t)}</code>`).join("、")}`
            : "";
          await reply(
            `已删除：${removed.map((d) => `<code>${removedLetterIds.get(d.id) || d.id}</code> • <code>${escapeHtml(d.domain)}</code>`).join("、")}${missingNote}\n剩下已自动补位：${rest}`,
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

        // ---- 官网映射：后缀 → 官网，存在配置文件里，以后新注册商发一条 map 就行，不用改脚本 ----
        if (sub === "map") {
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const map = db.data.officialMap || {};
          const suffixArg = args[1];
          const urlArg = args[2];
          // 只发 .domain map：列出全部映射（自己加的 + 内置的）
          if (!suffixArg) {
            const custom = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
            const lines = ["🗺️ 官网映射（后缀 → 官网）", ""];
            if (custom.length === 0) {
              lines.push("自己加的：还没有");
            } else {
              lines.push("自己加的：");
              for (const [suffix, url] of custom) lines.push(`<code>${escapeHtml(suffix)}</code> → ${escapeHtml(originOf(url))}`);
            }
            lines.push("");
            lines.push("内置的（改不了，想覆盖就用 map 加一条一样的后缀）：");
            lines.push("<code>.dpdns.org</code> / <code>.qzz.io</code> / <code>.qd.je</code> / <code>.us.kg</code> / <code>.xx.kg</code> → https://dashboard.digitalplat.org");
            lines.push("<code>.pp.ua</code> → https://nic.pp.ua");
            lines.push("<code>.eu.cc</code> → https://www.gname.vip");
            lines.push("<code>.indevs.in</code> / <code>.ryzedns.org</code> / <code>.sryze.cc</code> / <code>.nx.kg</code> → https://domain.stackryze.com");
            lines.push("");
            lines.push(`加一条：<code>${mainPrefix}domain map .xxx.com https://xxx.com</code>`);
            lines.push(`删一条：<code>${mainPrefix}domain unmap .xxx.com</code>`);
            await reply(lines.join("\n"));
            return;
          }
          const suffix = cleanSuffix(suffixArg);
          if (!suffix) {
            await reply(`❌ 后缀不对，要像这样：<code>${mainPrefix}domain map .indevs.in https://domain.stackryze.com/</code>`);
            return;
          }
          // 只写后缀：查这个后缀现在对应哪个官网
          if (!urlArg) {
            const url = inferOfficial(`x${suffix}`, map);
            await reply(url ? `<code>${escapeHtml(suffix)}</code> → ${escapeHtml(url)}` : `<code>${escapeHtml(suffix)}</code> 还没有映射，官网是空的`);
            return;
          }
          if (!/^https?:\/\//i.test(urlArg)) {
            await reply(`❌ 官网要以 https:// 开头，例如：<code>${mainPrefix}domain map .indevs.in https://domain.stackryze.com/</code>`);
            return;
          }
          const url = cleanOfficial(urlArg);
          const existed = map[suffix];
          map[suffix] = url;
          db.data.officialMap = map;
          await db.write();
          await reply(`✅ 已${existed ? "更新" : "添加"}映射：<code>${escapeHtml(suffix)}</code> → ${escapeHtml(url)}\n以后这个后缀的域名不用写官网，自动填这个；已经加过的域名不受影响，想改用 <code>${mainPrefix}domain edit &lt;编号&gt; official ${escapeHtml(url)}</code>`);
          return;
        }
        if (sub === "unmap") {
          const suffixArg = args[1];
          if (!suffixArg) {
            await reply(`用法：<code>${mainPrefix}domain unmap .xxx.com</code>\n先发 <code>${mainPrefix}domain map</code> 看自己加了哪些`);
            return;
          }
          const suffix = cleanSuffix(suffixArg);
          if (!suffix) {
            await reply(`❌ 后缀不对，要像这样：<code>${mainPrefix}domain unmap .indevs.in</code>`);
            return;
          }
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const map = db.data.officialMap || {};
          if (!(suffix in map)) {
            const builtIn = inferOfficial(`x${suffix}`);
            await reply(`自己加的映射里没有 <code>${escapeHtml(suffix)}</code>${builtIn ? `，不过内置的还在：${escapeHtml(builtIn)}` : "，也没有内置的"}`);
            return;
          }
          delete map[suffix];
          db.data.officialMap = map;
          await db.write();
          await reply(`✅ 已删除映射：<code>${escapeHtml(suffix)}</code>`);
          return;
        }

        // ---- 续期：目标 + 可选的新到期日；不写日期就按旧到期日延一年，只改到期日，其他不动，清掉已过期标记 ----
        if (sub === "renew") {
          const parts = args.slice(1).map((a) => (a || "").trim()).filter(Boolean);
          const usageText =
            `用法：<code>${mainPrefix}domain renew &lt;编号或域名&gt; [编号或域名...] [新的到期日]</code>\n` +
            `例如：<code>${mainPrefix}domain renew C1</code>（按旧到期日延一年）或 <code>${mainPrefix}domain renew C1 C2 2028-01-17</code>\n` +
            `日期支持 ${escapeHtml(DATE_FORMAT_HINT)}`;
          if (parts.length === 0) {
            await reply(usageText);
            return;
          }
          const lastArg = parts[parts.length - 1];
          const lastParsed = parseDateStrict(lastArg);
          const dateShape = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/;
          let dateISO: string | null = null;
          let targets: string[];
          if (lastParsed) {
            // 最后一个是日期：前面全是目标。
            dateISO = toISO(lastParsed.y, lastParsed.m, lastParsed.d);
            targets = parts.slice(0, -1);
            if (targets.length === 0) {
              await reply(usageText);
              return;
            }
          } else if (dateShape.test(lastArg)) {
            // 长得像日期但写错了（比如 2028-13-40），别当成域名去查。
            await reply(`❌ 日期写错了：<code>${escapeHtml(lastArg)}</code>\n${usageText}`);
            return;
          } else {
            // 没写日期：全部都是目标，按旧到期日延一年。
            targets = parts;
          }
          const db = await getDB();
          if (normalizeDomains(db.data)) await db.write();
          const done: DomainRecord[] = [];
          const missing: string[] = [];
          const seen = new Set<number>();
          for (const tg of targets) {
            const i = findDomainIndex(db.data, tg);
            if (i < 0) {
              missing.push(tg);
              continue;
            }
            const rec = db.data.domains[i];
            if (seen.has(rec.id)) continue;
            seen.add(rec.id);
            if (rec.expiry === "永久") {
              await reply(`❌ 这个域名是永久的，不用续：<code>${escapeHtml(rec.domain)}</code>`);
              return;
            }
            if (dateISO) {
              // 写了日期：新到期日必须比现在这个晚，不然就是写错了，一个都不改。
              if (daysBetween(rec.expiry, dateISO) <= 0) {
                await reply(`❌ 新到期日要比现在这个晚：<code>${escapeHtml(rec.domain)}</code> 现在到期 ${escapeHtml(rec.expiry)}，你写的是 ${escapeHtml(dateISO)}`);
                return;
              }
              rec.expiry = dateISO;
            } else {
              // 没写日期：按旧到期日延一年（注册商就是这么续的），提醒从今天重新算。
              rec.expiry = addYearsISO(rec.expiry, 1);
            }
            rec.registered = addDaysISO(rec.expiry, -VALIDITY_DAYS);
            rec.notified = [];
            done.push(rec);
          }
          if (done.length === 0) {
            await reply(`❌ 没找到这些域名：${missing.map((m) => `<code>${escapeHtml(m)}</code>`).join("、")}`);
            return;
          }
          await db.write();
          const today = todayStr();
          const header = dateISO
            ? `✅ 已续期 ${done.length} 个，到期日改成 ${escapeHtml(dateISO)}，提醒重新开始计时：`
            : `✅ 已续期 ${done.length} 个，没写日期，按旧到期日延一年，提醒从今天重新开始计时：`;
          const letterIds = buildLetterIds(db.data.domains);
          const outLines = [header];
          for (const d of done) outLines.push(domainLine(d, today, true, true, letterIds.get(d.id) || "", db.data.domains));
          if (missing.length > 0) outLines.push(`\n没找到：${missing.map((m) => `<code>${escapeHtml(m)}</code>`).join("、")}`);
          await reply(outLines.join("\n"));
          return;
        }

        // ---- 改域名（数字 ID、字母编号或域名都能改，可一次改多个，改完立刻生效）----
        // 写法：edit <目标...> <字段> <新值>，字段前面的全是目标，字段后面的全是新值。
        // 例如 edit B1 B2 expiry 2027-09-30：目标是 B1、B2，字段是 expiry，新值是日期。
        // 先把新值校验一次（日期 / 天数 / 官网），不对就一个都不改；对了再批量改。
        if (sub === "edit") {
          const rest = args.slice(1).map((a) => (a || "").trim()).filter(Boolean);
          const db = await getDB();
          if (rest.length === 0) {
            await reply(
              `用法：<code>${mainPrefix}domain edit &lt;编号或域名&gt; [编号或域名...] &lt;字段&gt; &lt;新值&gt;</code>\n字段：date / expiry / early / official / account\n例如：<code>${mainPrefix}domain edit B1 expiry 2027-09-30</code>、<code>${mainPrefix}domain edit B1 B2 early 90</code>、<code>${mainPrefix}domain edit B1 official https://nic.pp.ua</code>`,
            );
            return;
          }
          if (normalizeDomains(db.data)) await db.write();
          const FIELD_NAMES = ["date", "expiry", "exp", "early", "official", "account", "acc", "账号"];
          const fieldIdx = rest.findIndex((t) => FIELD_NAMES.includes(t.toLowerCase()));
          // 没写字段：只写了一个目标时是老用法，只看那条记录。
          if (fieldIdx < 0) {
            if (rest.length === 1) {
              const idx = findDomainIndex(db.data, rest[0]);
              if (idx < 0) {
                await reply(`没找到：<code>${escapeHtml(rest[0])}</code>，先发 <code>${mainPrefix}domain ls</code> 看编号`);
                return;
              }
              const letterIds = buildLetterIds(db.data.domains);
              await reply(domainLine(db.data.domains[idx], todayStr(), true, true, letterIds.get(db.data.domains[idx].id) || "", db.data.domains));
              return;
            }
            await reply(
              `❌ 没认出字段，要写 date（注册日）、expiry（到期日）、early（提前天数）、official（官网）或 account（账号），例如：<code>${mainPrefix}domain edit B1 B2 expiry 2027-09-30</code>`,
            );
            return;
          }
          if (fieldIdx === 0) {
            await reply(
              `用法：<code>${mainPrefix}domain edit &lt;编号或域名&gt; [编号或域名...] &lt;字段&gt; &lt;新值&gt;</code>\n例如：<code>${mainPrefix}domain edit B1 B2 expiry 2027-09-30</code>`,
            );
            return;
          }
          const targets = rest.slice(0, fieldIdx);
          let field = rest[fieldIdx].toLowerCase();
          if (field === "exp") field = "expiry";
          if (field === "acc" || field === "账号") field = "account";
          const value = rest.slice(fieldIdx + 1).join(" ").trim();
          if (!value) {
            await reply(`❌ 没给新值，例如：<code>${mainPrefix}domain edit B1 B2 early 90</code>`);
            return;
          }
          // 先校验一次新值，不对就一个都不改。
          let earlyNum = 0;
          let dateISO = "";
          if (field === "early") {
            earlyNum = Number(value);
            if (!/^\d+$/.test(value) || earlyNum < 1 || earlyNum > 365) {
              await reply(`❌ 提前天数要是 1~365 的数字，例如：<code>${mainPrefix}domain edit B1 B2 early 90</code>`);
              return;
            }
          } else if (field === "official") {
            if (!/^https?:\/\//i.test(value)) {
              await reply(`❌ 官网要以 https:// 开头，例如：<code>${mainPrefix}domain edit B1 B2 official https://nic.pp.ua</code>`);
              return;
            }
          } else if (field === "account") {
            if (!value || /\s/.test(value)) {
              await reply(`❌ 账号不能有空格，例如：<code>${mainPrefix}domain edit B1 B2 account name@example.com</code> 或 <code>${mainPrefix}domain edit B1 B2 account 账号1</code>`);
              return;
            }
          } else {
            const parsed = parseDateStrict(value);
            if (!parsed) {
              await reply(
                `❌ 日期格式不对，要 ${escapeHtml(DATE_FORMAT_HINT)}，你输的是：${escapeHtml(value)}`,
              );
              return;
            }
            dateISO = toISO(parsed.y, parsed.m, parsed.d);
          }
          const recs: DomainRecord[] = [];
          const seenDomains = new Set<string>();
          const missing: string[] = [];
          for (const target of targets) {
            const idx = findDomainIndex(db.data, target);
            if (idx < 0) {
              missing.push(target);
              continue;
            }
            const rec = db.data.domains[idx];
            if (seenDomains.has(rec.domain)) continue;
            seenDomains.add(rec.domain);
            recs.push(rec);
          }
          if (recs.length === 0) {
            await reply(`没找到：${missing.map((t) => `<code>${escapeHtml(t)}</code>`).join("、")}，先发 <code>${mainPrefix}domain ls</code> 看编号`);
            return;
          }
          for (const rec of recs) {
            if (field === "early") {
              rec.early = earlyNum;
              rec.notified = [];
            } else if (field === "official") {
              rec.official = cleanOfficial(value);
            } else if (field === "account") {
              rec.account = unmaskAccount(value);
            } else if (field === "date") {
              // 改注册日：到期日跟着重算（注册日 + 365 天）
              rec.registered = dateISO;
              if (rec.expiry !== "永久") rec.expiry = addDaysISO(dateISO, VALIDITY_DAYS);
              rec.notified = [];
            } else {
              // 改到期日：注册日自动往前推（到期日 - 365 天），永久的旧记录改回要到期
              rec.expiry = dateISO;
              rec.registered = addDaysISO(dateISO, -VALIDITY_DAYS);
              rec.notified = [];
            }
          }
          await db.write();
          const today = todayStr();
          const missingNote = missing.length
            ? `\n没找到（已跳过）：${missing.map((t) => `<code>${escapeHtml(t)}</code>`).join("、")}`
            : "";
          const letterIds = buildLetterIds(db.data.domains);
          await reply(
            `已修改 ${recs.length} 个：${missingNote}\n${recs.map((r) => domainLine(r, today, true, true, letterIds.get(r.id) || "", db.data.domains)).join("\n")}`,
          );
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
