import { getPrefixes } from "@utils/pluginManager";
import { Plugin, type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";
import { reviveEntities } from "@utils/tlRevive";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const filePath = path.join(
  createDirectoryInAssets("acron"),
  "acron_config.json",
);

function getRemarkFromMsg(msg: Api.Message | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.message || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}
// DB schema and helpers
type AcronType =
  | "send"
  | "copy"
  | "forward"
  | "del"
  | "del_re"
  | "pin"
  | "unpin"
  | "cmd"
  | "collect";

type AcronTaskBase = {
  id: string; // 自增主键（字符串格式）
  type: AcronType;
  cron: string;
  chat: string; // 用户输入的对话ID或@name
  chatId?: string; // 解析后的对话ID（字符串），使用时转 number
  createdAt: string; // 时间戳（字符串）
  lastRunAt?: string; // 时间戳（字符串）
  lastResult?: string; // 例如删除的数量
  lastError?: string;
  disabled?: boolean; // 是否被禁用
  remark?: string; // 备注
  display?: string; // 显示名称
};

type DelTask = AcronTaskBase & {
  type: "del";
  msgId: string; // 存储为字符串
};

type DelReTask = AcronTaskBase & {
  type: "del_re";
  limit: string; // 最近消息条数（字符串）
  regex: string; // 正则表达式字符串，支持 /.../flags 或纯文本
};

type SendTask = AcronTaskBase & {
  type: "send";
  message: string; // 纯文本内容
  entities?: any; // TL JSON（MessageEntity 数组的 JSON 序列化）
  replyTo?: string; // 回复的消息 ID
};

type CmdTask = AcronTaskBase & {
  type: "cmd";
  message: string; // 要执行的命令文本
  replyTo?: string; // 指定执行命令的话题ID或回复消息ID
};

type CopyTask = AcronTaskBase & {
  type: "copy";
  fromChatId: string; // 源消息所在对话ID（字符串）
  fromMsgId: string; // 源消息ID（字符串）
  replyTo?: string; // 发送时回复的消息ID（或话题顶贴ID）
};

type ForwardTask = AcronTaskBase & {
  type: "forward";
  fromChatId: string; // 源消息所在对话ID（字符串）
  fromMsgId: string; // 源消息ID（字符串）
  replyTo?: string; // 为了和 copy/send 一致保留，但转发API不支持replyTo
};

type PinTask = AcronTaskBase & {
  type: "pin";
  msgId: string; // 要置顶的消息ID（字符串）
  notify?: boolean; // 是否通知
  pmOneSide?: boolean; // 是否仅自己置顶（私聊）
};

type UnpinTask = AcronTaskBase & {
  type: "unpin";
  msgId: string; // 要取消置顶的消息ID（字符串）
};

// 新增：定时收集转发任务
// 来源：固定来源群；发送人：仅匹配该发送人；目标：chat/chatId（沿用现有任务的字段含义）
// lastSeenId：已处理过的最大消息 ID（字符串）。注意：一次运行里即使只转发了最新 2 条，
// 也会把该轮所有新消息的最大 ID 记为已处理，避免旧消息被无限排队、下一轮重复处理。
// 失败时只推进到最后一条成功转发的消息，失败消息下一轮重试。
type CollectTask = AcronTaskBase & {
  type: "collect";
  sourceChat: string; // 来源对话ID或@name
  sourceChatId?: string; // 解析后的来源对话ID（字符串），使用时转 number
  sender: string; // 发送人：用户名（如 @kaige325）或数字 ID（如 12345678）
  maxCount: number; // 每轮最多转发条数，默认 2
  lastSeenId?: string; // 已处理过的最大消息 ID（字符串）
};

type AcronTask =
  | SendTask
  | CmdTask
  | CopyTask
  | ForwardTask
  | DelTask
  | DelReTask
  | PinTask
  | UnpinTask
  | CollectTask;

type AcronDB = {
  seq: string; // 自增计数器（字符串）
  tasks: AcronTask[];
};

async function getDB() {
  const db = await JSONFilePreset<AcronDB>(filePath, { seq: "0", tasks: [] });
  return db;
}

// 转换辅助：在使用时将字符串转 number，写入时存字符串
function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: any): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

const CN_TIME_ZONE = "Asia/Shanghai";

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean,
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
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`,
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username)
    displayParts.push(
      mention ? `@${entity.username}` : `<code>@${entity.username}</code>`,
    );

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`,
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

function makeCronKey(id: string) {
  return `acron:${id}`;
}

function parseCronFromArgs(
  args: string[],
): { cron: string; rest: string[] } | null {
  // 优先按 6 段解析 (second minute hour dayOfMonth month dayOfWeek)
  const n6 = 6;
  if (args.length >= n6) {
    const maybeCron = args.slice(0, n6).join(" ");
    const validation = (cron as any).validateCronExpression
      ? (cron as any).validateCronExpression(maybeCron)
      : { valid: true };
    if (validation.valid) {
      return { cron: maybeCron, rest: args.slice(n6) };
    }
  }

  return null;
}

// 收集转发：发送人识别辅助
// 依次尝试 senderId?.userId、sender?.id、fromId?.userId；用户名取 sender?.username。
// 若任务里 sender 是纯数字，则按数字 ID 匹配；否则按用户名匹配（忽略大小写和开头的 @）。
function getMessageSenderId(m: any): number | undefined {
  const candidates = [
    m?.senderId?.userId,
    m?.sender?.id,
    m?.fromId?.userId,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function getMessageSenderUsername(m: any): string | undefined {
  const u = m?.sender?.username;
  return typeof u === "string" && u ? u : undefined;
}

function matchesSender(m: any, sender: string): boolean {
  const s = String(sender || "").trim();
  if (!s) return false;
  if (/^-?\d+$/.test(s)) {
    const want = Number(s);
    const got = getMessageSenderId(m);
    return got !== undefined && got === want;
  }
  const wantName = s.replace(/^@/, "").toLowerCase();
  const gotName = getMessageSenderUsername(m);
  return !!gotName && gotName.toLowerCase() === wantName;
}

function buildCopy(task: AcronTask): string {
  if (task.type === "send") {
    const remark = task.remark ? ` ${task.remark}` : "";
    return `${mainPrefix}acron send ${task.cron} ${task.chat}${
      task.replyTo ? `|${task.replyTo}` : ""
    }${remark}`;
  } else if (task.type === "cmd") {
    const t = task as CmdTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron cmd ${t.cron} ${t.chat}${
      t.replyTo ? `|${t.replyTo}` : ""
    }${remark}\n${t.message}`;
  } else if (task.type === "copy") {
    const remark = task.remark ? ` ${task.remark}` : "";
    const t = task as CopyTask;
    return `${mainPrefix}acron copy ${t.cron} ${t.chat}${
      t.replyTo ? `|${t.replyTo}` : ""
    }${remark}`;
  } else if (task.type === "forward") {
    const remark = task.remark ? ` ${task.remark}` : "";
    const t = task as ForwardTask;
    return `${mainPrefix}acron forward ${t.cron} ${t.chat}${
      t.replyTo ? `|${t.replyTo}` : ""
    }${remark}`;
  } else if (task.type === "collect") {
    const remark = task.remark ? ` ${task.remark}` : "";
    const t = task as CollectTask;
    return `${mainPrefix}acron collect ${t.cron} ${t.chat} ${t.sourceChat} ${t.sender}${remark}`;
  } else if (task.type === "del") {
    const remark = task.remark ? ` ${task.remark}` : "";
    return `${mainPrefix}acron del ${task.cron} ${task.chat} ${task.msgId}${remark}`;
  } else if (task.type === "del_re") {
    // 尽量保留原始正则字符串
    const t = task as DelReTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron del_re ${t.cron} ${t.chat} ${t.limit} ${t.regex}${remark}`;
  } else if (task.type === "pin") {
    const t = task as PinTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    const notify = t.notify ? "1" : "0";
    const pmOneSide = t.pmOneSide ? "1" : "0";
    return `${mainPrefix}acron pin ${t.cron} ${t.chat} ${t.msgId} ${notify} ${pmOneSide}${remark}`;
  } else if (task.type === "unpin") {
    const t = task as UnpinTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron unpin ${t.cron} ${t.chat} ${t.msgId}${remark}`;
  }
  // fallback（理论不可达）
  return `${mainPrefix}acron`;
}
function buildCopyCommand(task: AcronTask): string {
  const cmd = buildCopy(task);
  return cmd?.includes("\n") ? `<pre>${cmd}</pre>` : `<code>${cmd}</code>`;
}

function tryParseRegex(input: string): RegExp {
  const trimmed = input.trim();
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const lastSlash = trimmed.lastIndexOf("/");
    const pattern = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    return new RegExp(pattern, flags);
  }
  return new RegExp(trimmed);
}

async function scheduleTask(task: AcronTask) {
  const key = makeCronKey(task.id);
  if (task.disabled) return;
  if (cronManager.has(key)) return;

  cronManager.set(key, task.cron, async () => {
    const db = await getDB();
    const idx = db.data.tasks.findIndex((t) => t.id === task.id);
    const now = Date.now();
    try {
      const client = await getGlobalClient();
      // NOTE: https://docs.telethon.dev/en/stable/concepts/entities.html
      await client.getDialogs();
      const chatIdNum = toInt((task as any).chatId);
      const entityLike = (chatIdNum as any) ?? task.chat;

      if (task.type === "send") {
        const t = task as SendTask;
        const entities = reviveEntities(t.entities);
        const replyTo = t.replyTo ? toInt(t.replyTo) : undefined;
        await client.sendMessage(entityLike, {
          message: t.message,
          formattingEntities: entities,
          ...(replyTo ? { replyTo } : {}),
        });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已发送 1 条消息`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "cmd") {
        const t = task as CmdTask;
        const cmd = await getCommandFromMessage(t.message);
        const replyTo = t.replyTo ? toInt(t.replyTo) : undefined;
        const sudoMsg = await client.sendMessage(entityLike, {
          message: t.message,
          ...(replyTo ? { replyTo } : {}),
        });
        if (cmd && sudoMsg)
          await dealCommandPluginWithMessage({ cmd, msg: sudoMsg as any });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已执行命令`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "copy") {
        const t = task as CopyTask;
        const fromChatIdNum = toInt(t.fromChatId);
        const fromMsgIdNum = toInt(t.fromMsgId);
        try {
          // 获取源消息（尽量使用完整实体以避免 hash 失效）
          const fromEntityLike = (fromChatIdNum as any) ?? t.fromChatId;
          const messages = await safeGetMessages(client, fromEntityLike as any, {
            ids: fromMsgIdNum,
          });
          const realtimeMsg = messages?.[0] as any;
          if (!realtimeMsg) throw new Error("未能获取源消息");

          // 复制发送（保留文本/实体/媒体）
          const replyTo = t.replyTo ? toInt(t.replyTo) : undefined;
          await client.sendMessage(entityLike, {
            message: realtimeMsg, // 直接传入消息对象以便自动处理媒体/实体
            ...(replyTo ? { replyTo } : {}),
            formattingEntities: realtimeMsg.entities,
          });

          if (idx >= 0) {
            db.data.tasks[idx].lastRunAt = String(now);
            db.data.tasks[idx].lastResult = `已复制发送 1 条消息`;
            db.data.tasks[idx].lastError = undefined;
            await db.write();
          }
        } catch (e: any) {
          throw e;
        }
      } else if (task.type === "forward") {
        const t = task as ForwardTask;
        const fromChatIdNum = toInt(t.fromChatId);
        const fromMsgIdNum = toInt(t.fromMsgId);
        const fromEntityLike = (fromChatIdNum as any) ?? t.fromChatId;

        // await client.forwardMessages(entityLike, {
        //   messages: fromMsgIdNum!,
        //   fromPeer: fromEntityLike as any,
        // });
        await client.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: fromEntityLike,
            id: [fromMsgIdNum!],
            toPeer: entityLike,
            // 如果在论坛话题中，指定话题的顶层消息 ID
            ...(t.replyTo ? { topMsgId: toInt(t.replyTo) } : {}),
          }),
        );
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已转发 1 条消息`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "collect") {
        // 定时收集转发：到点时拉取来源群最近消息，按发送人过滤，只转发未处理过的新消息。
        // 本分支不使用实时监听、不新增登录，复用 TeleBox 已登录客户端。
        const t = task as CollectTask;
        const sourceChatIdNum = toInt(t.sourceChatId);
        const sourceEntityLike = (sourceChatIdNum as any) ?? t.sourceChat;
        const maxCount = t.maxCount && t.maxCount > 0 ? t.maxCount : 2;
        const lastSeen = t.lastSeenId ? toInt(t.lastSeenId) : undefined;

        const messages = await safeGetMessages(client, sourceEntityLike as any, {
          limit: 100,
        });
        // 过滤发送人，按消息 ID 升序（时间顺序）排列
        const filtered = ((messages || []) as any[])
          .filter((m) => matchesSender(m, t.sender))
          .filter((m) => typeof m?.id === "number")
          .sort((a, b) => a.id - b.id);
        // 未处理过的新消息：lastSeenId 未设置时首轮取最近历史，见 help 说明
        const fresh = lastSeen === undefined
          ? filtered
          : filtered.filter((m) => m.id > lastSeen);
        if (fresh.length === 0) {
          if (idx >= 0) {
            db.data.tasks[idx].lastRunAt = String(now);
            db.data.tasks[idx].lastResult = `暂无新消息，已跳过`;
            db.data.tasks[idx].lastError = undefined;
            await db.write();
          }
        } else {
          // 最多转发最新 maxCount 条（按时间顺序转发）
          const toForward = fresh.slice(-maxCount);
          let lastOkId: number | undefined = undefined;
          let forwarded = 0;
          let failed: any = undefined;
          for (const m of toForward) {
            try {
              await client.invoke(
                new Api.messages.ForwardMessages({
                  fromPeer: sourceEntityLike,
                  id: [m.id],
                  toPeer: entityLike,
                }),
              );
              lastOkId = m.id;
              forwarded += 1;
            } catch (e: any) {
              failed = e;
              break;
            }
          }
          if (idx >= 0) {
            const stored = db.data.tasks[idx] as CollectTask;
            db.data.tasks[idx].lastRunAt = String(now);
            if (failed) {
              // 失败时只推进到最后一条成功转发的消息，失败消息下一轮重试，不紧循环重试
              if (lastOkId !== undefined) stored.lastSeenId = String(lastOkId);
              db.data.tasks[idx].lastResult =
                forwarded > 0 ? `已转发 ${forwarded} 条，后续失败` : `转发失败`;
              db.data.tasks[idx].lastError = String(failed?.message || failed);
            } else {
              // 成功时把本轮所有新消息的最大 ID 记为已处理：
              // 即使只转发了最新 2 条，更旧的新消息也不会被无限排队，下一轮只看更新的消息。
              stored.lastSeenId = String(fresh[fresh.length - 1].id);
              db.data.tasks[idx].lastResult = `已转发 ${forwarded} 条消息`;
              db.data.tasks[idx].lastError = undefined;
            }
            await db.write();
          }
          if (failed) throw failed;
        }
      } else if (task.type === "del") {
        const t = task as DelTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum !== undefined) {
          await client.deleteMessages(entityLike, [msgIdNum], { revoke: true });
        }
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已尝试删除消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "del_re") {
        const t = task as DelReTask;
        const limitNum = toInt(t.limit) ?? 100;
        const messages = await safeGetMessages(client, entityLike, {
          limit: limitNum,
        });
        const re = tryParseRegex(t.regex);
        const ids: number[] = [];
        for (const m of messages || []) {
          const mm = m as any;
          const text: string | undefined = mm.message ?? mm.text;
          if (typeof text === "string" && re.test(text)) {
            if (typeof mm.id === "number") ids.push(mm.id);
          }
        }
        if (ids.length > 0) {
          await client.deleteMessages(entityLike, ids, { revoke: true });
        }
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `匹配并删除 ${ids.length} 条`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "pin") {
        const t = task as PinTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum === undefined) throw new Error("无效的消息ID");
        await client.pinMessage(entityLike, msgIdNum, {
          notify: !!t.notify,
          pmOneSide: !!t.pmOneSide,
        });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已置顶消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "unpin") {
        const t = task as UnpinTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum === undefined) throw new Error("无效的消息ID");
        await client.unpinMessage(entityLike, msgIdNum);
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已取消置顶消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      }
    } catch (e: any) {
      console.error(`[acron] 任务 ${task.id} 执行失败:`, e);
      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        db.data.tasks[idx].lastError = String(e?.message || e);
        await db.write();
      }
    }
  });
}

async function bootstrapTasks() {
  try {
    const db = await getDB();
    for (const t of db.data.tasks) {
      // 跳过无效表达式
      if (!cron.validateCronExpression(t.cron).valid) continue;
      if (t.disabled) continue;
      await scheduleTask(t);
    }
  } catch (e) {
    console.error("[acron] bootstrap 失败:", e);
  }
}

// 启动时注册历史任务（异步，不阻塞加载）
bootstrapTasks();

const help_text = `▎定时复制

每天2点复制发送到指定对话(可指定话题或回复消息)

• 使用 <code>${mainPrefix}acron copy 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${mainPrefix}acron copy 0 0 2 * * * 对话ID/@name|发送时的话题ID或回复消息的ID [备注]</code> 回复一条消息

▎定时转发

每天2点转发到指定对话(可指定话题)

• 使用 <code>${mainPrefix}acron forward 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${mainPrefix}acron forward 0 0 2 * * * 对话ID/@name|发送时的话题ID [备注]</code> 回复一条消息

▎定时收集转发

到点时从来源群拉取最近 100 条消息，只挑指定发送人的新消息，按时间顺序最多转发 2 条到目标群。无新消息则跳过，不重复转发旧消息。首轮没有已处理记录时，转发最近历史里的最新 2 条。本功能复用 TeleBox 已登录的客户端，不需要新的登录、API ID、Bot Token 或密码。

• 使用 <code>${mainPrefix}acron collect 0 0 1 * * * -1002443712513 -1003219886860 @kaige325 kaige收集08点</code>
• 使用 <code>${mainPrefix}acron collect 0 30 5 * * * -1002443712513 -1003219886860 @kaige325 kaige收集12点半</code>

上面两条分别对应显示时间 08:00 和 12:30（按本插件已有任务的规律：显示 09:00 对应 cron 0 0 2，显示 06:00 对应 cron 0 0 23，显示 13:00 对应 cron 0 0 6，所以显示 08:00 写 cron 0 0 1，显示 12:30 写 cron 0 30 5）。添加后请以 <code>${mainPrefix}acron ls all</code> 显示的下次时间为准，不要只看 cron 数字。

规则：每轮最多 2 条；只有 1 条新消息就发 1 条；没有新消息就跳过；发送人可用用户名（如 @kaige325）或数字 ID，用户名改名后请改用数字 ID 并重建任务。

▎定时发送

稍微麻烦了一点, 但是可以保证消息的完整格式. 储存此消息到数据库, 每天2点在指定对话发送(可指定话题或回复消息). 不支持带多媒体或 replyMarkup 的消息, 可考虑使用本插件的定时复制/转发功能

• 使用 <code>${mainPrefix}acron send 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${mainPrefix}acron send 0 0 2 * * * 对话ID/@name|发送时话题的ID或回复消息的ID [备注]</code> 回复一条消息

▎定时删除

每天2点删除指定ID或@name的对话中的指定ID的消息

• <code>${mainPrefix}acron del 0 0 2 * * * 对话ID/@name 消息ID [备注]</code>

▎定时正则删除

每天2点删除指定ID或@name的对话中的最近的 100 条消息中 内容符合正则表达式的消息

• <code>${mainPrefix}acron del_re 0 0 2 * * * 对话ID/@name 100 /^test/i [备注]</code>

▎定时置顶/取消置顶

每天2点在指定ID或@name的对话中置顶指定ID的消息, 是否发通知(true/1, false/0), 是否仅对自己置顶(true/1, false/0)

• <code>${mainPrefix}acron pin 0 0 2 * * * 对话ID/@name 消息ID 是否发通知 是否仅对自己置顶 [备注]</code>

每天2点在指定ID或@name的对话中取消置顶指定ID的消息

• <code>${mainPrefix}acron unpin 0 0 2 * * * 对话ID/@name 消息ID [备注]</code>

▎定时执行命令

每天2点在指定ID或@name的对话中执行命令 <code>${mainPrefix}a foo bar</code>(可指定话题或回复消息)
注意要换行写

<pre>${mainPrefix}acron cmd 0 0 2 * * * 对话ID/@name [备注]
${mainPrefix}a foo bar</pre>

<pre>${mainPrefix}acron cmd 0 0 2 * * * 对话ID/@name|发送时话题的ID或回复消息的ID [备注]
${mainPrefix}a foo bar</pre>

典型的使用场景:

每天2点自动备份(调用 <code>${mainPrefix}bf</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时备份
${mainPrefix}bf</pre>

每天2点自动更新 <code>eat</code> 的表情包配置(调用 <code>${mainPrefix}eat set</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时更新表情包
${mainPrefix}eat set</pre>

• <code>${mainPrefix}acron list</code>, <code>${mainPrefix}acron ls</code> - 列出当前会话中的所有定时任务
• <code>${mainPrefix}acron ls all</code>, <code>${mainPrefix}acron la</code> - 列出所有的定时任务
• <code>${mainPrefix}acron ls del</code> - 列出当前会话中的类型为 del 的定时任务
• <code>${mainPrefix}acron ls all del</code>, <code>${mainPrefix}acron la del</code> - 列出所有的类型为 del 的定时任务
• <code>${mainPrefix}acron rm 定时任务ID</code> - 删除指定的定时任务
• <code>${mainPrefix}acron disable/off 定时任务ID</code> - 禁用指定的定时任务
• <code>${mainPrefix}acron enable/on 定时任务ID</code> - 启用指定的定时任务
`;

class AcronPlugin extends Plugin {

  description: string = `定时发送/转发/复制/置顶/取消置顶/删除消息/执行命令\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    acron: async (msg: Api.Message) => {
      const lines = msg.message?.trim()?.split(/\r?\n/g) || [];

      const parts = lines?.[0]?.split(/\s+/) || [];

      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        if (!sub) {
          await msg.edit({
            text: help_text,
            parseMode: "html",
          });
          return;
        }

        if (sub === "list" || sub === "ls" || sub === "la") {
          let p1 = (args[1] || "").toLowerCase();
          let p2 = (args[2] || "").toLowerCase();
          if (sub === "la") {
            p2 = p1;
            p1 = "all";
          }

          const scopeAll = p1 === "all";
          const maybeType = (scopeAll ? p2 : p1) as AcronType | "";
          const typeFilter: AcronType | undefined = [
            "send",
            "cmd",
            "copy",
            "forward",
            "del",
            "del_re",
            "pin",
            "unpin",
            "collect",
          ].includes(maybeType as any)
            ? (maybeType as AcronType)
            : undefined;

          const typeLabel = (tp?: AcronType) =>
            tp === "send"
              ? "发送"
              : tp === "cmd"
                ? "命令"
                : tp === "copy"
                  ? "复制"
                  : tp === "forward"
                    ? "转发"
                    : tp === "del"
                      ? "删除"
                      : tp === "del_re"
                        ? "正则删除"
                        : tp === "pin"
                          ? "置顶"
                          : tp === "unpin"
                            ? "取消置顶"
                            : tp === "collect"
                              ? "收集转发"
                              : String(tp || "");

          const db = await getDB();
          const chatId = Number(msg.chatId);
          const tasks = db.data.tasks
            .filter(
              (t) =>
                (scopeAll ? true : Number((t as any).chatId) === chatId) &&
                (!typeFilter || t.type === typeFilter),
            )
            // 先展示已启用的，再展示已禁用的
            .sort((a, b) => {
              const ad = a.disabled ? 1 : 0;
              const bd = b.disabled ? 1 : 0;
              return ad - bd;
            });

          if (tasks.length === 0) {
            const noneText = scopeAll
              ? typeFilter
                ? `暂无类型为 ${typeLabel(typeFilter)} 的定时任务`
                : "暂无定时任务"
              : typeFilter
                ? `当前会话暂无类型为 ${typeLabel(typeFilter)} 的定时任务`
                : "当前会话暂无定时任务";
            await msg.edit({ text: noneText });
            return;
          }

          const lines: string[] = [];
          const header = scopeAll
            ? typeFilter
              ? `📋 所有 ${typeLabel(typeFilter)} 定时任务`
              : "📋 所有定时任务"
            : typeFilter
              ? `📋 当前会话 ${typeLabel(typeFilter)} 定时任务`
              : "📋 当前会话定时任务";
          lines.push(header);
          lines.push("");

          // 分块显示：先启用，再禁用；如果对应块为空则不显示表头
          const enabledTasks = tasks.filter((t) => !t.disabled);
          const disabledTasks = tasks.filter((t) => t.disabled);

          if (enabledTasks.length > 0) {
            lines.push("🔛 已启用:");
            lines.push("");
            for (const t of enabledTasks) {
              const nextDt = cron.sendAt(t.cron);
              const entityInfo = await formatEntity(
                (t as any).chatId ?? t.chat,
              );
              const title = `<code>${t.id}</code> • <code>${typeLabel(
                t.type,
              )}</code>${t.remark ? ` • ${t.remark}` : ""}`;
              lines.push(title);
              lines.push(
                `对话: ${
                  (entityInfo?.entity ? entityInfo?.display : t.display) ||
                  `<code>${t.chat}</code>`
                }`,
              );
              if (t.type === "collect") {
                const ct = t as CollectTask;
                const sourceInfo = await formatEntity(
                  ct.sourceChatId ?? ct.sourceChat,
                );
                lines.push(
                  `来源: ${sourceInfo?.display || `<code>${ct.sourceChat}</code>`}`,
                );
                lines.push(`发送人: <code>${ct.sender}</code>`);
                if (ct.lastSeenId) {
                  lines.push(`已处理ID: <code>${ct.lastSeenId}</code>`);
                }
              }
              const msgId = (t as any)?.msgId;
              const fromChatId = (t as any)?.fromChatId;
              const fromMsgId = (t as any)?.fromMsgId;
              if (msgId) {
                lines.push(
                  `消息: <a href="https://t.me/c/${String(
                    (t as any).chatId ?? t.chat,
                  ).replace("-100", "")}/${msgId}">${msgId}</a>`,
                );
              }
              if (fromChatId && fromMsgId) {
                lines.push(
                  `消息: <a href="https://t.me/c/${String(
                    fromChatId ?? "",
                  ).replace("-100", "")}/${fromMsgId}">${fromMsgId}</a>`,
                );
              }
              if (
                (t.type === "send" && (t as SendTask).replyTo) ||
                (t.type === "cmd" && (t as CmdTask).replyTo) ||
                (t.type === "copy" && (t as CopyTask).replyTo) ||
                (t.type === "forward" && (t as ForwardTask).replyTo)
              ) {
                const replyId = (t as any).replyTo as string | undefined;
                if (replyId)
                  lines.push(
                    `回复: <a href="https://t.me/c/${String(
                      (t as any).chatId ?? t.chat,
                    ).replace("-100", "")}/${replyId}">${replyId}</a>`,
                  );
              }
              if (nextDt) {
                const dt: Date =
                  typeof (nextDt as any)?.toJSDate === "function"
                    ? (nextDt as any).toJSDate()
                    : nextDt instanceof Date
                      ? nextDt
                      : new Date(Number(nextDt));
                lines.push(`下次: ${formatDate(dt)}`);
              }
              if (t.lastRunAt) {
                lines.push(
                  `上次: ${formatDate(new Date(Number(t.lastRunAt)))}`,
                );
              }
              if (t.lastResult) lines.push(`结果: ${t.lastResult}`);
              if (t.lastError) lines.push(`错误: ${t.lastError}`);
              lines.push(`复制: ${buildCopyCommand(t)}`);
              lines.push("");
            }
          }

          if (disabledTasks.length > 0) {
            lines.push("⏹ 已禁用:");
            lines.push("");
            for (const t of disabledTasks) {
              const entityInfo = await formatEntity(
                (t as any).chatId ?? t.chat,
              );
              const title = `<code>${t.id}</code> • <code>${typeLabel(
                t.type,
              )}</code>${t.remark ? ` • ${t.remark}` : ""}`;
              lines.push(title);
              lines.push(
                `对话: ${entityInfo?.display || `<code>${t.chat}</code>`}`,
              );
              if (t.type === "collect") {
                const ct = t as CollectTask;
                const sourceInfo = await formatEntity(
                  ct.sourceChatId ?? ct.sourceChat,
                );
                lines.push(
                  `来源: ${sourceInfo?.display || `<code>${ct.sourceChat}</code>`}`,
                );
                lines.push(`发送人: <code>${ct.sender}</code>`);
                if (ct.lastSeenId) {
                  lines.push(`已处理ID: <code>${ct.lastSeenId}</code>`);
                }
              }
              // 禁用状态不显示下次执行
              if (t.lastRunAt) {
                lines.push(
                  `上次: ${formatDate(new Date(Number(t.lastRunAt)))}`,
                );
              }
              if (t.lastResult) lines.push(`结果: ${t.lastResult}`);
              if (t.lastError) lines.push(`错误: ${t.lastError}`);
              lines.push(`复制: ${buildCopyCommand(t)}`);
              lines.push("");
            }
          }

          // 分片发送，避免超长
          const full = lines.join("\n");
          const MAX = 3500; // 预留富文本开销
          const chunks: string[] = [];
          for (let i = 0; i < full.length; i += MAX) {
            chunks.push(full.slice(i, i + MAX));
          }
          if (chunks.length > 0) {
            await msg.edit({ text: chunks[0], parseMode: "html" });
            for (let i = 1; i < chunks.length; i++) {
              await msg.client?.sendMessage(msg.peerId, {
                message: chunks[i],
                parseMode: "html",
              });
            }
          }
          return;
        }

        if (sub === "rm") {
          const id = args[1];
          if (!id) {
            await msg.edit({
              text: `请提供定时任务ID: <code>${mainPrefix}acron rm ID</code>`,
              parseMode: "html",
            });
            return;
          }
          const db = await getDB();
          const idx = db.data.tasks.findIndex((t) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: <code>${id}</code>`,
              parseMode: "html",
            });
            return;
          }
          const key = makeCronKey(id);
          cronManager.del(key);
          db.data.tasks.splice(idx, 1);
          await db.write();
          await msg.edit({
            text: `✅ 已删除任务 <code>${id}</code>`,
            parseMode: "html",
          });
          return;
        }

        if (
          sub === "disable" ||
          sub === "enable" ||
          sub === "off" ||
          sub === "on"
        ) {
          const id = args[1];
          if (!id) {
            await msg.edit({
              text:
                sub === "disable"
                  ? `请提供定时任务ID: <code>${mainPrefix}acron disable ID</code>`
                  : `请提供定时任务ID: <code>${mainPrefix}acron enable ID</code>`,
              parseMode: "html",
            });
            return;
          }
          const db = await getDB();
          const idx = db.data.tasks.findIndex((t) => t.id === id);
          if (idx < 0) {
            await msg.edit({
              text: `未找到任务: <code>${id}</code>`,
              parseMode: "html",
            });
            return;
          }
          const t = db.data.tasks[idx];
          if (sub === "disable" || sub === "off") {
            if (t.disabled) {
              await msg.edit({
                text: `任务 <code>${id}</code> 已处于禁用状态`,
                parseMode: "html",
              });
              return;
            }
            const key = makeCronKey(id);
            cronManager.del(key);
            t.disabled = true;
            await db.write();
            await msg.edit({
              text: `⏸️ 已禁用任务 <code>${id}</code>`,
              parseMode: "html",
            });
          } else {
            if (!cron.validateCronExpression(t.cron).valid) {
              await msg.edit({
                text: `任务 <code>${id}</code> 的 Cron 表达式无效，无法启用`,
                parseMode: "html",
              });
              return;
            }
            t.disabled = false;
            await db.write();
            await scheduleTask(t as AcronTask);
            const nextAt = cron.sendAt(t.cron);
            await msg.edit({
              text: `▶️ 已启用任务 <code>${id}</code>\n下次执行: ${formatDate(
                nextAt.toJSDate(),
              )}`,
              parseMode: "html",
            });
          }
          return;
        }

        if (
          sub === "send" ||
          sub === "cmd" ||
          sub === "copy" ||
          sub === "forward" ||
          sub === "del" ||
          sub === "del_re" ||
          sub === "pin" ||
          sub === "unpin" ||
          sub === "collect"
        ) {
          const argRest = args.slice(1); // 跳过子命令
          const parsed = parseCronFromArgs(argRest);
          if (!parsed) {
            await msg.edit({ text: "无效的 Cron 表达式" });
            return;
          }
          const { cron: cronExpr, rest } = parsed;
          const validation = (cron as any).validateCronExpression
            ? (cron as any).validateCronExpression(cronExpr)
            : { valid: true };
          if (!validation.valid) {
            await msg.edit({
              text: `Cron 校验失败: ${validation.error || "无效表达式"}`,
            });
            return;
          }

          const [chatArg, ...restChatArg] =
            rest[0]
              ?.split(/\s*[|｜]\s*/g)
              .map((i) => i.trim())
              .filter((i) => i.length > 0) || [];

          if (!chatArg) {
            await msg.edit({ text: "请提供对话ID或@name" });
            return;
          }
          // 解析并展示（失败也只用于展示）
          const { id: resolvedChatId, display } = await formatEntity(chatArg);
          const chatIdNum = Number(resolvedChatId);
          const hasChatId = Number.isFinite(chatIdNum)
            ? String(chatIdNum)
            : undefined;

          const db = await getDB();
          // 自增 seq（字符串存储）
          const currentSeq = toInt(db.data.seq) ?? 0;
          const nextSeq = currentSeq + 1;
          db.data.seq = String(nextSeq);
          const id = String(nextSeq);

          if (sub === "send") {
            // 必须回复一条消息
            if (!msg.isReply) {
              await msg.edit({ text: "请回复一条要定时发送的消息" });
              return;
            }
            const replied = await safeGetReplyMessage(msg);
            const mm: any = replied || {};
            // 不支持多媒体或按钮
            if (mm.media || mm.replyMarkup) {
              await msg.edit({
                text: "不支持带多媒体或 replyMarkup 的消息 可考虑使用本插件的定时复制/转发功能",
              });
              return;
            }
            const text: string = (mm.message ?? mm.text ?? "").toString();
            if (!text || !text.trim()) {
              await msg.edit({ text: "请回复一条包含文本的消息" });
              return;
            }
            const entities: any = mm.entities
              ? JSON.parse(JSON.stringify(mm.entities))
              : undefined;
            // const remark = rest.slice(1).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 8);
            const replyTo = restChatArg[0];

            const task: SendTask = {
              id,
              type: "send",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              message: text,
              entities,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              replyTo: replyTo || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加定时发送任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ]
              .filter(Boolean)
              .join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else if (sub === "cmd") {
            // 备注与回复ID
            // const remark = rest.slice(1).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 8);
            const replyTo = restChatArg[0];
            const message = lines?.[1]?.trim(); // 第二行
            if (!message) {
              await msg.edit({ text: "无法识别要执行的命令" });
              return;
            }

            const task: CmdTask = {
              id,
              type: "cmd",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              message,
              replyTo: replyTo || undefined,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加定时命令任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ]
              .filter(Boolean)
              .join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else if (sub === "copy" || sub === "forward") {
            // 必须回复一条消息（作为源）
            if (!msg.isReply) {
              await msg.edit({ text: "请回复一条要复制/转发的源消息" });
              return;
            }
            const replied = await safeGetReplyMessage(msg);
            const mm: any = replied || {};
            const fromMsgId = toInt(mm.id);
            const fromChatId = toInt(mm.chatId);
            if (!fromMsgId || !fromChatId) {
              await msg.edit({ text: "无法识别源消息ID或会话ID" });
              return;
            }

            // 备注与回复ID
            // const remark = rest.slice(1).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 8);
            const replyTo = restChatArg[0];

            if (sub === "copy") {
              const task: CopyTask = {
                id,
                type: "copy",
                cron: cronExpr,
                chat: chatArg,
                chatId: hasChatId as any,
                fromChatId: String(Math.trunc(fromChatId)),
                fromMsgId: String(Math.trunc(fromMsgId)),
                replyTo: replyTo || undefined,
                createdAt: String(Date.now()),
                remark: remark || undefined,
                display: display || undefined,
              };
              db.data.tasks.push(task);
              await db.write();
              await scheduleTask(task);

              const nextAt = (cron as any).sendAt(cronExpr);
              const tip = [
                "✅ 已添加定时复制任务",
                `ID: <code>${id}</code>`,
                `对话: ${display}`,
                ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
                ...(task.remark ? [`备注: ${task.remark}`] : []),
                nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
                `复制: ${buildCopyCommand(task)}`,
              ]
                .filter(Boolean)
                .join("\n");
              await msg.edit({ text: tip, parseMode: "html" });
              return;
            } else {
              const task: ForwardTask = {
                id,
                type: "forward",
                cron: cronExpr,
                chat: chatArg,
                chatId: hasChatId as any,
                fromChatId: String(Math.trunc(fromChatId)),
                fromMsgId: String(Math.trunc(fromMsgId)),
                replyTo: replyTo || undefined,
                createdAt: String(Date.now()),
                remark: remark || undefined,
                display: display || undefined,
              };
              db.data.tasks.push(task);
              await db.write();
              await scheduleTask(task);

              const nextAt = (cron as any).sendAt(cronExpr);
              const tip = [
                "✅ 已添加定时转发任务",
                `ID: <code>${id}</code>`,
                `对话: ${display}`,
                ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
                ...(task.remark ? [`备注: ${task.remark}`] : []),
                nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
                `复制: ${buildCopyCommand(task)}`,
              ]
                .filter(Boolean)
                .join("\n");
              await msg.edit({ text: tip, parseMode: "html" });
              return;
            }
          } else if (sub === "collect") {
            // 定时收集转发：不需要回复源消息，参数就是目标、来源、发送人
            // rest 顺序：[目标对话, 来源对话, 发送人, ...备注在整行里]
            const sourceChatArg = rest[1];
            const senderArg = rest[2];
            if (!sourceChatArg) {
              await msg.edit({ text: "请提供来源对话ID或@name" });
              return;
            }
            if (!senderArg) {
              await msg.edit({ text: "请提供发送人用户名或数字ID，例如 @kaige325" });
              return;
            }
            // 备注：命令词 + collect + 6 段 cron + 目标 + 来源 + 发送人 = 11 个词，n=10
            const remark = getRemarkFromMsg(lines[0], 10);
            const { id: resolvedSourceChatId, display: sourceDisplay } =
              await formatEntity(sourceChatArg);
            const sourceChatIdNum = Number(resolvedSourceChatId);
            const hasSourceChatId = Number.isFinite(sourceChatIdNum)
              ? String(sourceChatIdNum)
              : undefined;

            const task: CollectTask = {
              id,
              type: "collect",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              sourceChat: sourceChatArg,
              sourceChatId: hasSourceChatId as any,
              sender: senderArg,
              maxCount: 2,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加定时收集转发任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `来源: ${sourceDisplay}`,
              `发送人: <code>${senderArg}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ]
              .filter(Boolean)
              .join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else if (sub === "del") {
            const msgIdStr = rest[1];

            if (!msgIdStr) {
              await msg.edit({ text: "请提供消息 ID" });
              return;
            }
            // const remark = rest.slice(2).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 9);

            const task: DelTask = {
              id,
              type: "del",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              msgId: msgIdStr,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加删除消息的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else if (sub === "pin") {
            // rest: [chat, msgId, notify, pmOneSide, ...remark]
            const msgIdStr = rest[1];

            if (!msgIdStr) {
              await msg.edit({ text: "请提供消息 ID" });
              return;
            }
            const notifyRaw = (rest[2] || "").toLowerCase();
            const pmOneSideRaw = (rest[3] || "").toLowerCase();
            if (!notifyRaw || !pmOneSideRaw) {
              await msg.edit({
                text: "请提供是否发通知与是否仅对自己置顶参数，如: 1 0 或 true false",
              });
              return;
            }
            const parseBool = (v: string) =>
              v === "1" || v === "true" || v === "yes" || v === "y";
            const notify = parseBool(notifyRaw);
            const pmOneSide = parseBool(pmOneSideRaw);
            // const remark = rest.slice(4).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 11);

            const task: PinTask = {
              id,
              type: "pin",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              msgId: msgIdStr,
              notify,
              pmOneSide,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加置顶消息的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `消息ID: <code>${task.msgId}</code>`,
              `通知: <code>${task.notify ? "1" : "0"}</code>`,
              `仅自己置顶: <code>${task.pmOneSide ? "1" : "0"}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else if (sub === "unpin") {
            // rest: [chat, msgId, ...remark]
            const msgIdStr = rest[1];

            if (!msgIdStr) {
              await msg.edit({ text: "请提供消息 ID" });
              return;
            }
            // const remark = rest.slice(2).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 9);

            const task: UnpinTask = {
              id,
              type: "unpin",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              msgId: msgIdStr,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加取消置顶的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `消息ID: <code>${task.msgId}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          } else {
            // del_re
            const limitStr = rest[1];
            const limit = Number(limitStr || 100);
            if (!Number.isFinite(limit) || limit <= 0) {
              await msg.edit({ text: "请提供有效的条数限制(正整数)" });
              return;
            }
            if (!rest[2]) {
              await msg.edit({ text: "请提供消息正则表达式" });
              return;
            }
            // 新增备注支持：从第三段起第一个参数为正则，其余合并为备注
            const regexRaw = String(rest[2]).trim();
            // const remark = rest.slice(3).join(" ").trim();
            const remark = getRemarkFromMsg(lines[0], 10);
            if (!regexRaw) {
              await msg.edit({ text: "请提供消息正则表达式" });
              return;
            }
            // 校验正则
            try {
              void tryParseRegex(regexRaw);
            } catch (e: any) {
              await msg.edit({ text: `无效的正则表达式: ${e?.message || e}` });
              return;
            }

            const task: DelReTask = {
              id,
              type: "del_re",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId as any,
              limit: String(Math.trunc(limit)),
              regex: regexRaw,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };
            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = (cron as any).sendAt(cronExpr);
            const tip = [
              "✅ 已添加正则删除的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `最近条数: <code>${limit}</code>`,
              `匹配: <code>${regexRaw}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: tip, parseMode: "html" });
            return;
          }
        }

        await msg.edit({ text: `未知子命令: ${sub}` });
      } catch (error: any) {
        await msg.edit({ text: `处理出错: ${error?.message || error}` });
      }
    },
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "acron",
    title: "acron",
    description: "ACRON 定时任务配置",
    category: "插件配置",
    icon: "⏰",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "timezone",
            "label": "时区",
            "type": "select",
            "options": [
                  { "value": "Asia/Shanghai", "label": "中国标准时间 (UTC+8)" },
                  { "value": "Asia/Tokyo", "label": "日本标准时间 (UTC+9)" },
                  { "value": "Asia/Singapore", "label": "新加坡时间 (UTC+8)" },
                  { "value": "America/New_York", "label": "东部时间 (UTC-5)" },
                  { "value": "America/Los_Angeles", "label": "太平洋时间 (UTC-8)" },
                  { "value": "Europe/London", "label": "伦敦时间 (UTC+0)" },
                  { "value": "Europe/Berlin", "label": "柏林时间 (UTC+1)" },
                  { "value": "Australia/Sydney", "label": "悉尼时间 (UTC+10)" },
                  { "value": "Pacific/Auckland", "label": "奥克兰时间 (UTC+12)" },
                  { "value": "UTC", "label": "协调世界时 (UTC+0)" }
            ],
            "default": "Asia/Shanghai"
      },
      {
            "key": "maxRetries",
            "label": "最大重试次数",
            "type": "number",
            "min": 0,
            "max": 10,
            "default": 3,
            "description": "失败重试次数，0 表示不重试"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("acron"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("acron"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
}

export default new AcronPlugin();
