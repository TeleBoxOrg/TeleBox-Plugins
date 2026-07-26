import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetMessages } from "@utils/safeGetMessages";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { createCanvas, registerFont } from "canvas";
import fs from "fs";
import path from "path";
import { JSONFilePreset } from "lowdb/node";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const WIDTH = 900;
const HEIGHT = 640;
const MARGIN = 32;
const CONFIG_PATH = path.join(__dirname, "cy_schedule.json");
const CJK_FONT_FAMILY = "TeleBoxCJK";
const CJK_FONT_STACK = `"${CJK_FONT_FAMILY}", "Droid Sans Fallback", sans-serif`;
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
];
let cjkFontRegistered = false;

function ensureCjkFont(): void {
  if (cjkFontRegistered) return;
  for (const fontPath of CJK_FONT_CANDIDATES) {
    if (!fs.existsSync(fontPath)) continue;
    try {
      registerFont(fontPath, { family: CJK_FONT_FAMILY });
      cjkFontRegistered = true;
      break;
    } catch (error) {
      console.warn(`[cy] 注册中文字体失败: ${fontPath}`, error);
    }
  }
}

const STOP_WORDS = new Set([
  "这个", "那个", "就是", "不是", "可以", "没有", "一下", "一个", "什么", "怎么", "为什么",
  "然后", "现在", "还是", "但是", "因为", "所以", "如果", "已经", "应该", "可能", "感觉",
  "不要", "知道", "看看", "哈哈", "哈哈哈", "你们", "我们", "他们", "自己", "直接", "确实",
  "来源", "情况", "情况下", "耗时", "输入", "输出", "回复", "问题", "最近", "消息", "有效",
  "今天", "昨天", "明天", "时候", "东西", "里面", "这里", "那里", "这样", "那样", "进行",
  "使用", "需要", "更新", "主要", "内容", "新增", "版本", "发布", "包括", "所有", "不会",
  "the", "and", "for", "with", "this", "that", "you", "are", "not", "but", "from", "have",
  "http", "https", "com", "www", "telegram", "t.me", "true", "false", "null", "undefined",
]);

const PALETTE = ["#0f766e", "#166534", "#1d4ed8", "#0891b2", "#2563eb", "#ca8a04", "#dc2626", "#7c3aed"];

type WordItem = {
  word: string;
  count: number;
  size: number;
  color: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type CanvasContext = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

type CyScheduleConfig = {
  enabled: boolean;
  target: string;
  times: string[];
  limit: number;
};

const DEFAULT_SCHEDULE: CyScheduleConfig = {
  enabled: false,
  target: "",
  times: [],
  limit: DEFAULT_LIMIT,
};

function getArgs(text: string): string {
  const matched = prefixes.find((prefix) => text.trim().startsWith(prefix)) || mainPrefix;
  const body = text.trim().slice(matched.length).trim();
  const firstSpace = body.search(/\s/);
  return firstSpace < 0 ? "" : body.slice(firstSpace + 1).trim();
}

function parseLimitFromParts(parts: string[]): number {
  const value = Number(parts[0]);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.max(50, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(50, Math.min(MAX_LIMIT, Math.floor(num)));
}

function readScheduleConfig(): CyScheduleConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_SCHEDULE };
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      enabled: Boolean(raw.enabled),
      target: typeof raw.target === "string" ? raw.target.trim() : "",
      times: Array.isArray(raw.times) ? raw.times.map(String).filter(isValidTime).slice(0, 12) : [],
      limit: normalizeLimit(raw.limit),
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function writeScheduleConfig(config: CyScheduleConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function parseTimeArgs(parts: string[], fallbackLimit: number): { times: string[]; limit: number } | undefined {
  const times: string[] = [];
  let limit = fallbackLimit;
  for (const part of parts) {
    const values = part.split(",").map((item) => item.trim()).filter(Boolean);
    if (!values.length) continue;
    for (const value of values) {
      if (isValidTime(value)) {
        if (!times.includes(value)) times.push(value);
        continue;
      }
      if (/^\d+$/.test(value)) {
        limit = normalizeLimit(value, limit);
        continue;
      }
      return undefined;
    }
  }
  if (!times.length) return undefined;
  return { times: times.slice(0, 12), limit };
}

function stablePeerPart(value: unknown): string {
  const item: any = value as any;
  if (!item) return "";
  if (item.channelId) return `-100${String(item.channelId)}`;
  if (item.chatId) return `-${String(item.chatId)}`;
  if (item.userId) return String(item.userId);
  return String(item.value ?? item.id ?? "");
}

function targetFromCurrentChat(msg: Api.Message): string {
  const chat: any = (msg as any).chat;
  if (chat?.username) return `@${chat.username}`;
  if ((msg as any).chatId) return String((msg as any).chatId);
  return stablePeerPart((msg as any).peerId);
}

function messageText(msg: Api.Message): string {
  if ((msg as any).sticker) return "";
  return String(msg.text || msg.message || "").trim();
}

function isUsefulWord(word: string): boolean {
  if (!word) return false;
  const normalized = word.toLowerCase();
  if (STOP_WORDS.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (/^[a-z]{1,2}$/i.test(normalized)) return false;
  if (/^[o0]+$/i.test(normalized)) return false;
  if (/^[._+\-]+$/.test(normalized)) return false;
  return true;
}

function addWord(counts: Map<string, number>, word: string, weight = 1): void {
  const normalized = word.trim().toLowerCase();
  if (!isUsefulWord(normalized)) return;
  counts.set(normalized, (counts.get(normalized) || 0) + weight);
}

function pruneOverlappingWords(entries: Array<[string, number]>): Array<[string, number]> {
  return entries.filter(([word, count]) => {
    if (word.length <= 1) return false;
    return !entries.some(([other, otherCount]) => {
      if (other === word) return false;
      if (other.length <= word.length) return false;
      if (!other.includes(word)) return false;
      // 如果短词只是更长词里的碎片，并且频次没有明显更强，就丢掉。
      return otherCount >= count * 0.9;
    });
  });
}

function collectWords(text: string, counts: Map<string, number>): void {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[@#][\w_一-龥-]+/g, " ")
    .replace(/[^\p{Script=Han}a-zA-Z0-9_+\-.]+/gu, " ");

  for (const match of cleaned.matchAll(/[a-zA-Z][a-zA-Z0-9_+\-.]{1,24}/g)) {
    addWord(counts, match[0], 2);
  }
  for (const match of cleaned.matchAll(/\d{2,}[a-zA-Z%]?/g)) {
    addWord(counts, match[0], 1);
  }

  const hanParts = cleaned.match(/[\p{Script=Han}]{2,}/gu) || [];
  for (const part of hanParts) {
    if (part.length <= 4) {
      addWord(counts, part, 3);
      continue;
    }
    for (let size = 2; size <= 5; size++) {
      for (let i = 0; i <= part.length - size; i++) {
        const word = part.slice(i, i + size);
        const edgeBonus = i === 0 || i === part.length - size ? 1 : 0;
        addWord(counts, word, size <= 3 ? 1 + edgeBonus : 2 + edgeBonus);
      }
    }
  }
}

function buildWordItems(counts: Map<string, number>): WordItem[] {
  const entries = pruneOverlappingWords([...counts.entries()])
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 220);
  if (!entries.length) return [];
  const max = entries[0][1];
  const min = entries[entries.length - 1][1];
  const spread = Math.max(1, max - min);
  return entries.map(([word, count], index) => {
    const ratio = (count - min) / spread;
    const size = Math.round(12 + Math.pow(ratio, 0.7) * 68);
    return {
      word,
      count,
      size,
      color: PALETTE[index % PALETTE.length],
    };
  });
}

function overlaps(a: WordItem, placed: WordItem[]): boolean {
  const padding = 4;
  const ax1 = (a.x || 0) - padding;
  const ay1 = (a.y || 0) - (a.height || 0) - padding;
  const ax2 = (a.x || 0) + (a.width || 0) + padding;
  const ay2 = (a.y || 0) + padding;
  return placed.some((b) => {
    const bx1 = (b.x || 0) - padding;
    const by1 = (b.y || 0) - (b.height || 0) - padding;
    const bx2 = (b.x || 0) + (b.width || 0) + padding;
    const by2 = (b.y || 0) + padding;
    return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
  });
}

function layoutWords(ctx: CanvasContext, words: WordItem[]): WordItem[] {
  const placed: WordItem[] = [];
  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2 - 28;
  for (const original of words) {
    const item = { ...original };
    ctx.font = `700 ${item.size}px ${CJK_FONT_STACK}`;
    const metrics = ctx.measureText(item.word);
    item.width = metrics.width;
    item.height = item.size;
    if (item.width > WIDTH - MARGIN * 2) continue;

    for (let attempt = 0; attempt < 4; attempt++) {
      item.size = Math.max(10, original.size - attempt * 4);
      ctx.font = `700 ${item.size}px ${CJK_FONT_STACK}`;
      const nextMetrics = ctx.measureText(item.word);
      item.width = nextMetrics.width;
      item.height = item.size;
      let placedItem = false;
      for (let t = 0; t < 3600; t++) {
      const angle = t * 0.38;
      const radius = 5.2 * Math.sqrt(t);
      item.x = centerX + Math.cos(angle) * radius - item.width / 2;
      item.y = centerY + Math.sin(angle) * radius + item.height / 2;
      if (item.x < MARGIN || item.y < MARGIN + item.height || item.x + item.width > WIDTH - MARGIN || item.y > HEIGHT - 78) continue;
      if (overlaps(item, placed)) continue;
      placed.push({ ...item });
      placedItem = true;
      break;
      }
      if (placedItem) break;
    }
  }
  return placed;
}

function renderWordCloud(words: WordItem[], limit: number, validMessages: number): Buffer {
  ensureCjkFont();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const placed = layoutWords(ctx, words);
  for (const item of placed) {
    ctx.font = `700 ${item.size}px ${CJK_FONT_STACK}`;
    ctx.fillStyle = item.color;
    ctx.fillText(item.word, item.x || 0, item.y || 0);
  }

  ctx.fillStyle = "#111827";
  ctx.font = `34px ${CJK_FONT_STACK}`;
  ctx.fillText(`最近 ${limit} 条热词云 | ${validMessages} 条有效消息`, 42, HEIGHT - 34);
  return canvas.toBuffer("image/png");
}

async function fetchRecentMessages(client: any, peer: any, limit: number): Promise<Api.Message[]> {
  if (!peer || !client) return [];
  return safeGetMessages(client, peer, { limit });
}

async function buildCloudImage(client: any, target: any, limit: number): Promise<{ png: Buffer; validMessages: number }> {
  const messages = await fetchRecentMessages(client, target, limit);
  const counts = new Map<string, number>();
  let validMessages = 0;
  for (const item of messages) {
    const text = messageText(item);
    if (!text || text.startsWith(mainPrefix)) continue;
    validMessages++;
    collectWords(text, counts);
  }
  const words = buildWordItems(counts);
  if (!words.length) throw new Error("没有统计到足够的热词。");
  return { png: renderWordCloud(words, limit, validMessages), validMessages };
}

async function sendCloudToTarget(client: any, target: any, limit: number, replyTo?: number): Promise<void> {
  const { png } = await buildCloudImage(client, target, limit);
  const file = new CustomFile("cy-wordcloud.png", png.length, "", png);
  await client.sendFile(target, {
    file,
    caption: "",
    forceDocument: false,
    ...(replyTo ? { replyTo } : {}),
  } as any);
}

function formatStatus(config: CyScheduleConfig): string {
  return [
    `词云定时: ${config.enabled ? "on" : "off"}`,
    `目标: ${config.target || "未设置"}`,
    `时间: ${config.times.length ? config.times.join(", ") : "未设置"}`,
    `数量: ${config.limit}`,
  ].join("\n");
}

function buildHelpText(): string {
  return [
    "词云 cy",
    "",
    "立即生成",
    `${mainPrefix}cy`,
    `${mainPrefix}cy 500`,
    `${mainPrefix}cy send`,
    "",
    "定时发送",
    `${mainPrefix}cy target here`,
    `${mainPrefix}cy target @群用户名`,
    `${mainPrefix}cy time 09:00 500`,
    `${mainPrefix}cy time 09:00,21:30 1000`,
    `${mainPrefix}cy time 05:00 12:00 21:30 2000`,
    `${mainPrefix}cy on`,
    `${mainPrefix}cy off`,
    `${mainPrefix}cy status`,
    "",
    "帮助",
    `${mainPrefix}cy help`,
    `${mainPrefix}help cy`,
  ].join("\n");
}

class CyPlugin extends Plugin {
  description = `词云
<code>${mainPrefix}cy [消息数]</code> - 当前群立即生成
<code>${mainPrefix}cy help</code> - 查看词云帮助
<code>${mainPrefix}cy target here</code> - 设置当前群为定时目标
<code>${mainPrefix}cy time 09:00 500</code> - 设置定时发送
<code>${mainPrefix}cy on|off|status</code> - 开关/查看定时`;
  private timer?: NodeJS.Timeout;
  private lastRuns = new Set<string>();
  private runningRuns = new Set<string>();

  constructor() {
    super();
    this.timer = setInterval(() => {
      this.tickSchedule().catch((error) => console.error("[cy] 定时词云失败:", error));
    }, 30_000);
  }

  cleanup(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tickSchedule(): Promise<void> {
    const config = readScheduleConfig();
    if (!config.enabled || !config.target || !config.times.length) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const current = `${hh}:${mm}`;
    if (!config.times.includes(current)) return;
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const key = `${day}:${current}`;
    if (this.lastRuns.has(key) || this.runningRuns.has(key)) return;
    this.runningRuns.add(key);
    if (this.lastRuns.size > 200) this.lastRuns = new Set([...this.lastRuns].slice(-80));
    try {
      const client = await getGlobalClient();
      if (!client) return;
      await sendCloudToTarget(client, config.target, config.limit);
      this.lastRuns.add(key);
    } finally {
      this.runningRuns.delete(key);
    }
  }

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    cy: async (msg) => {
      const args = getArgs(String(msg.text || msg.message || ""));
      const [subCommand = "", ...restParts] = args.split(/\s+/).filter(Boolean);
      const rest = restParts.join(" ");
      const config = readScheduleConfig();

      if (["help", "?"].includes(subCommand)) {
        await msg.edit({ text: buildHelpText() });
        return;
      }
      if (["target", "chat", "group"].includes(subCommand)) {
        const target = rest.trim() === "here" || !rest.trim() ? targetFromCurrentChat(msg) : rest.trim();
        if (!target) {
          await msg.edit({ text: "无法识别当前群，请手动指定群 username 或 id。" });
          return;
        }
        config.target = target;
        writeScheduleConfig(config);
        await msg.edit({ text: `词云目标已设置: ${target}` });
        return;
      }
      if (["time", "at"].includes(subCommand)) {
        const parsed = parseTimeArgs(restParts, config.limit);
        if (!parsed) {
          await msg.edit({ text: `用法: ${mainPrefix}cy time 09:00,21:30 [数量]\n也可以: ${mainPrefix}cy time 05:00 12:00 21:30 2000` });
          return;
        }
        config.times = parsed.times;
        config.limit = parsed.limit;
        writeScheduleConfig(config);
        await msg.edit({ text: formatStatus(config) });
        return;
      }
      if (["on", "enable", "start"].includes(subCommand)) {
        if (!config.target || !config.times.length) {
          await msg.edit({ text: `请先设置目标和时间:\n${mainPrefix}cy target here\n${mainPrefix}cy time 09:00 500` });
          return;
        }
        config.enabled = true;
        writeScheduleConfig(config);
        await msg.edit({ text: formatStatus(config) });
        return;
      }
      if (["off", "disable", "stop"].includes(subCommand)) {
        config.enabled = false;
        writeScheduleConfig(config);
        await msg.edit({ text: formatStatus(config) });
        return;
      }
      if (["status", "config"].includes(subCommand)) {
        await msg.edit({ text: formatStatus(config) });
        return;
      }
      if (["send", "now"].includes(subCommand)) {
        const target = config.target || targetFromCurrentChat(msg);
        const limit = normalizeLimit(restParts[0], config.limit);
        await msg.edit({ text: `正在发送词云到 ${target}...` });
        await sendCloudToTarget(msg.client, target, limit);
        await msg.safeDelete?.({ revoke: true } as any);
        return;
      }

      const limit = parseLimitFromParts(args ? [subCommand] : []);
      await msg.edit({ text: `正在统计最近 ${limit} 条消息...` });
      try {
        await sendCloudToTarget(msg.client, msg.inputChat || msg.peerId || msg.chatId, limit, msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || msg.id);
      } catch (error) {
        await msg.edit({ text: "没有统计到足够的热词。" });
        return;
      }
      await msg.safeDelete?.({ revoke: true } as any);
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "cy",
    title: "词云定时",
    description: "词云定时任务配置",
    category: "插件配置",
    icon: "☁️",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "enabled",
            "label": "启用定时",
            "type": "boolean"
      },
      {
            "key": "target",
            "label": "目标群组/频道",
            "type": "string"
      },
      {
            "key": "times",
            "label": "执行时间列表",
            "type": "json"
      },
      {
            "key": "limit",
            "label": "词数限制",
            "type": "number",
            "min": 50,
            "max": 2000,
            "default": 500
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<CyScheduleConfig>(path.join(__dirname, "cy_schedule.json"), DEFAULT_SCHEDULE);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<CyScheduleConfig>(path.join(__dirname, "cy_schedule.json"), DEFAULT_SCHEDULE);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
}

export default new CyPlugin();
