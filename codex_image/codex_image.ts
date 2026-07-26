import axios from "axios";
import path from "path";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODEL = "gpt-5.4";
const CODEX_MAX_WAIT_MS = 10 * 60 * 1000;
const pluginName = "codex_image";
const dataDir = createDirectoryInAssets(pluginName);
const configPath = path.join(dataDir, "config.json");
let dbPromise: Promise<Low<CodexImageConfig>> | null = null;

interface CodexImageConfig {
  accessToken: string;
}

type CodexResponseResult = {
  imageBase64: string | null;
  revisedPrompt: string | null;
  status: string | null;
  responseId: string | null;
};

type StatusUpdater = (text: string) => Promise<void>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const expandableBlock = (input: string): string =>
  `<blockquote expandable>${htmlEscape(input)}</blockquote>`;

async function getDb(): Promise<Low<CodexImageConfig>> {
  if (!dbPromise) {
    dbPromise = JSONFilePreset<CodexImageConfig>(configPath, {
      accessToken: "",
    });
  }
  const db = await dbPromise;
  db.data ||= { accessToken: "" };
  return db;
}

async function getStoredToken(): Promise<string> {
  const db = await getDb();
  return (db.data?.accessToken || "").trim();
}

async function setStoredToken(token: string): Promise<void> {
  const db = await getDb();
  db.data!.accessToken = token.trim();
  await db.write();
}

function maskToken(token: string): string {
  if (!token) return "(未配置)";
  if (token.length <= 10) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}秒`;
  return `${minutes}分${seconds}秒`;
}

async function getBearerToken(): Promise<string> {
  return await getStoredToken();
}

function getImageMimeType(message: Api.Message): string {
  const documentMime = (message.media as any)?.document?.mimeType;
  if (typeof documentMime === "string" && documentMime.startsWith("image/")) {
    return documentMime;
  }
  if ((message.media as any)?.photo) {
    return "image/jpeg";
  }
  return "image/png";
}

async function downloadReplyImage(
  msg: Api.Message,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const replyMsg = await safeGetReplyMessage(msg);
  if (!replyMsg?.media) {
    return null;
  }

  const client = (msg as any).client;
  if (!client) {
    throw new Error("无法获取客户端实例");
  }

  const mediaData = await client.downloadMedia(replyMsg.media, { workers: 1 });
  let buffer: Buffer | null = null;

  if (Buffer.isBuffer(mediaData)) {
    buffer = mediaData;
  } else if (mediaData && typeof (mediaData as any).read === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of mediaData as any) {
      chunks.push(Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  }

  if (!buffer?.length) {
    throw new Error("未能获取参考图数据");
  }

  return {
    buffer,
    mimeType: getImageMimeType(replyMsg),
  };
}

async function callCodexImage(
  prompt: string,
  referenceImage?: { buffer: Buffer; mimeType: string },
  updateStatus?: StatusUpdater,
  deadlineAt: number = Date.now() + CODEX_MAX_WAIT_MS,
): Promise<CodexResponseResult> {
  const token = await getBearerToken();
  if (!token) {
    throw new Error(
      `缺少鉴权，请先使用 ${mainPrefix}cximg token 你的codex access token（通常在 .codex/auth.json） 保存 Token`,
    );
  }

  const content = referenceImage
    ? [
        { type: "input_text", text: prompt },
        {
          type: "input_image",
          image_url: `data:${referenceImage.mimeType};base64,${referenceImage.buffer.toString("base64")}`,
        },
      ]
    : prompt;

  const payload = {
    model: CODEX_MODEL,
    instructions: "You are a helpful assistant. Use tools when available.",
    input: [
      {
        role: "user",
        content,
      },
    ],
    store: false,
    tools: [{ type: "image_generation" }],
    reasoning: { effort: "low" },
    include: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: null,
    stream: true,
  };

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const readStreamResult = async (): Promise<CodexResponseResult> => {
    const response = await axios.post(CODEX_URL, payload, {
      responseType: "stream",
      timeout: Math.max(1000, deadlineAt - Date.now()),
      headers,
    });

    let buffer = "";
    let imageBase64: string | null = null;
    let revisedPrompt: string | null = null;
    let status: string | null = null;
    let responseId: string | null = null;

    for await (const chunk of response.data) {
      buffer += chunk.toString("utf8");

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);

        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6).trim())
          .filter(Boolean);

        for (const dataLine of dataLines) {
          if (dataLine === "[DONE]") continue;

          let payloadObj: any;
          try {
            payloadObj = JSON.parse(dataLine);
          } catch {
            continue;
          }

          const eventType = payloadObj?.type;
          if (eventType === "response.created") {
            responseId = payloadObj?.response?.id || responseId;
            status = payloadObj?.response?.status || status;
          } else if (
            eventType === "response.image_generation_call.partial_image"
          ) {
            imageBase64 = payloadObj?.partial_image_b64 || imageBase64;
            revisedPrompt = payloadObj?.revised_prompt || revisedPrompt;
            status = payloadObj?.status || status;
          } else if (eventType === "response.completed") {
            status = payloadObj?.response?.status || status;
            responseId = payloadObj?.response?.id || responseId;
          }
        }

        delimiterIndex = buffer.indexOf("\n\n");
      }
    }

    return { imageBase64, revisedPrompt, status, responseId };
  };

  const fetchResponseStatus = async (
    responseId: string,
  ): Promise<CodexResponseResult | null> => {
    try {
      const response = await axios.get(`${CODEX_URL}/${responseId}`, {
        timeout: Math.min(60000, Math.max(1000, deadlineAt - Date.now())),
        headers,
      });
      const data = response.data?.response || response.data;
      if (!data || typeof data !== "object") return null;

      let imageBase64: string | null = null;
      let revisedPrompt: string | null = null;

      const visit = (value: any): void => {
        if (!value || typeof value !== "object") return;
        if (
          typeof value.partial_image_b64 === "string" &&
          value.partial_image_b64
        ) {
          imageBase64 = value.partial_image_b64;
        }
        if (typeof value.revised_prompt === "string" && value.revised_prompt) {
          revisedPrompt = value.revised_prompt;
        }
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        for (const nested of Object.values(value)) {
          if (nested && typeof nested === "object") visit(nested);
        }
      };

      visit(data);

      return {
        imageBase64,
        revisedPrompt,
        status: typeof data.status === "string" ? data.status : null,
        responseId: typeof data.id === "string" ? data.id : responseId,
      };
    } catch {
      return null;
    }
  };

  const streamResult = await readStreamResult();
  if (
    streamResult.imageBase64 ||
    !streamResult.responseId ||
    streamResult.status !== "in_progress"
  ) {
    return streamResult;
  }

  let attempt = 0;
  while (true) {
    attempt += 1;
    if (Date.now() >= deadlineAt) {
      throw new Error("生成超时，已强制停止（超过10分钟）");
    }
    await sleep(Math.min(20000, Math.max(1000, deadlineAt - Date.now())));
    if (Date.now() >= deadlineAt) {
      throw new Error("生成超时，已强制停止（超过10分钟）");
    }
    if (updateStatus) {
      await updateStatus(
        `⏳ 正在等待 Codex 返回结果...（第 ${attempt} 次检查）`,
      );
    }
    const polledResult = await fetchResponseStatus(streamResult.responseId);
    if (!polledResult) continue;
    if (polledResult.imageBase64) return polledResult;
    if (polledResult.status && polledResult.status !== "in_progress") {
      return {
        ...streamResult,
        ...polledResult,
        imageBase64: polledResult.imageBase64 || streamResult.imageBase64,
        revisedPrompt: polledResult.revisedPrompt || streamResult.revisedPrompt,
      };
    }
  }
}

async function handleCximg(msg: Api.Message): Promise<void> {
  const rawText = (msg.message || "").trim();
  const argsText = rawText.replace(/^\S+\s*/, "").trim();
  const [subcommand, ...restArgs] = argsText.split(/\s+/).filter(Boolean);
  const loweredSubcommand = (subcommand || "").toLowerCase();

  if (loweredSubcommand === "token") {
    const tokenValue = restArgs.join(" ").trim();
    if (!tokenValue) {
      const storedToken = await getStoredToken();
      await msg.edit({
        text: `🔐 当前本地 Token：${maskToken(storedToken)}\n• 设置方式：<code>${mainPrefix}cximg token 你的codex access token（通常在 .codex/auth.json）</code>`,
        parseMode: "html",
      });
      return;
    }

    await setStoredToken(tokenValue);
    await msg.edit({ text: "✅ 已保存 Codex Access Token" });
    return;
  }

  const prompt = argsText;
  if (!prompt) {
    await msg.edit({
      text: `❌ 请输入提示词，例如：<code>${mainPrefix}cximg 一只戴墨镜的柴犬坐在跑车里</code>\n• 设置 Token：<code>${mainPrefix}cximg token 你的codex access token（通常在 .codex/auth.json）</code>`,
      parseMode: "html",
    });
    return;
  }

  let referenceImage: { buffer: Buffer; mimeType: string } | null = null;
  try {
    referenceImage = await downloadReplyImage(msg);
  } catch (error: any) {
    await msg.edit({
      text: `❌ 参考图下载失败：${htmlEscape(error.message || String(error))}`,
      parseMode: "html",
    });
    return;
  }

  const initialStatus = referenceImage
    ? "🖼️ 已检测到参考图，正在生成图片..."
    : "🎨 正在根据提示词生成图片...";
  await msg.edit({
    text: initialStatus,
  });

  const startedAt = Date.now();
  const deadlineAt = startedAt + CODEX_MAX_WAIT_MS;
  let lastStatusUpdateAt = 0;
  let currentPhaseText = initialStatus;
  let heartbeatStopped = false;
  const updateProgressStatus = async (phaseText: string): Promise<void> => {
    currentPhaseText = phaseText;
    const now = Date.now();
    if (now - lastStatusUpdateAt < 1500) return;
    lastStatusUpdateAt = now;
    const elapsed = formatDuration(now - startedAt);
    try {
      await msg.edit({
        text: `${phaseText}\n⏱️ 已耗时：${elapsed}`,
      });
    } catch {}
  };

  const heartbeat = (async () => {
    while (!heartbeatStopped) {
      await sleep(20000);
      if (heartbeatStopped) break;
      await updateProgressStatus(currentPhaseText);
    }
  })();

  let result: CodexResponseResult;
  try {
    result = await callCodexImage(
      prompt,
      referenceImage || undefined,
      updateProgressStatus,
      deadlineAt,
    );
  } catch (error: any) {
    heartbeatStopped = true;
    await heartbeat.catch(() => {});
    const elapsed = formatDuration(Date.now() - startedAt);
    if (axios.isAxiosError(error)) {
      const detail =
        typeof error.response?.data === "string"
          ? error.response.data.slice(0, 500)
          : error.message;
      await msg.edit({
        text: `❌ Codex 请求失败 (${error.response?.status || "网络错误"})：${htmlEscape(detail)}\n⏱️ 耗时：${elapsed}`,
        parseMode: "html",
      });
    } else {
      await msg.edit({
        text: `❌ 生成失败：${htmlEscape(error.message || String(error))}\n⏱️ 耗时：${elapsed}`,
        parseMode: "html",
      });
    }
    return;
  }

  heartbeatStopped = true;
  await heartbeat.catch(() => {});
  const elapsed = formatDuration(Date.now() - startedAt);

  if (!result.imageBase64) {
    await msg.edit({
      text: `❌ 未收到生成图片${result.status ? `（status: ${htmlEscape(result.status)}）` : ""}\n⏱️ 耗时：${elapsed}`,
      parseMode: "html",
    });
    return;
  }

  const imageBuffer = Buffer.from(result.imageBase64, "base64");
  const file = new CustomFile(
    `codex_image_${Date.now()}.png`,
    imageBuffer.length,
    "",
    imageBuffer,
  );
  const caption = [
    `<b>提示词:</b>\n${expandableBlock(prompt)}`,
    `<b>耗时:</b> ${htmlEscape(elapsed)}`,
    result.revisedPrompt
      ? `<b>修订提示词:</b>\n${expandableBlock(result.revisedPrompt)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const client = (msg as any).client;
  if (!client) {
    await msg.edit({ text: "❌ 无法获取客户端实例" });
    return;
  }

  const replyMsg = await safeGetReplyMessage(msg);
  await client.sendFile(msg.peerId, {
    file,
    caption,
    parseMode: "html",
    replyTo: replyMsg?.id || msg.id,
  });

  try {
    await msg.delete();
  } catch {
    await msg.edit({ text: "✅ 图片生成完成" });
  }
}

class CodexImagePlugin extends Plugin {

  description: string =
    `通过codex调用gpt-image-2\n\n` +
    `• <code>${mainPrefix}cximg 提示词</code> 纯文本生成图片\n` +
    `• 回复图片并发送 <code>${mainPrefix}cximg 提示词</code> 进行参考图生成\n` +
    `• <code>${mainPrefix}cximg token 你的codex access token（通常在 .codex/auth.json）</code> 手动保存 Token`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    cximg: handleCximg,
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
      id: "codex_image",
      title: "Codex 图片生成",
      description: "OpenAI Codex (gpt-image-2) 图片生成配置",
      category: "插件配置",
      icon: "🎨",
      getSchema: (): PanelSettingField[] => [
        {
          key: "accessToken",
          label: "Codex Access Token",
          type: "password",
          default: "",
          description: "从 ~/.codex/auth.json 获取 access_token，或在 ChatGPT 网页端开发者工具中查找",
        },
        {
          key: "model",
          label: "模型",
          type: "select",
          options: [
            { value: "gpt-5.4", label: "gpt-5.4 (默认)" },
            { value: "gpt-image-1", label: "gpt-image-1" },
          ],
          default: "gpt-5.4",
          description: "使用的图片生成模型",
        },
        {
          key: "maxWaitMs",
          label: "最大等待时间 (分钟)",
          type: "number",
          min: 1,
          max: 30,
          default: 10,
          description: "等待生成完成的最长时间",
        },
      ],
      getValues: async () => {
        const token = await getStoredToken();
        return {
          accessToken: token,
          model: CODEX_MODEL,
          maxWaitMs: Math.round(CODEX_MAX_WAIT_MS / 60000),
        };
      },
      setValues: async (patch: Record<string, unknown>) => {
        if (typeof patch.accessToken === "string") {
          await setStoredToken(patch.accessToken);
        }
      },
    };
}

export default new CodexImagePlugin();
