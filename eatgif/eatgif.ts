import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import sharp from "sharp";
import axios from "axios";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import path from "path";
import fs from "fs";
import { Api, utils } from "teleproto";
import type { EntityLike } from "teleproto/define";
import bigInteger from "big-integer";
import { encode, UnencodedFrame } from "modern-gif";
import { execFile } from "child_process";
import { promisify } from "util";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

import { htmlEscape } from "@utils/htmlEscape";
import { JSONFilePreset } from "lowdb/node";

const execFileAsync = promisify(execFile);

// 由于gif可能很多帧，最好缓存在本地，而不是每次都远程拿不同的帧数
const ASSET_PATH = createDirectoryInAssets("eatgif");
// 用来保存缓存的gif资源以及webm资源
const TEMP_PATH = createDirectoryInTemp("eatgif");

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  rotate?: number;
  brightness?: number;
}

interface GifResConfig {
  url: string;
  delay?: number;
  me?: RoleConfig;
  you?: RoleConfig;
}

// 表情包详细配置
interface EatGifConfig {
  width: number;
  height: number;
  res: GifResConfig[];
}

// 各种表情包配置列表
interface EatGifListConfig {
  [key: string]: { url: string; desc: string };
}

// 测试时可以更换主体url
const baseRepoURL =
  "https://github.com/TeleBoxOrg/TeleBox-Plugins/raw/refs/heads/main/eatgif/";
const baseConfigURL = baseRepoURL + "config.json";

let config: EatGifListConfig;

// 还是每次生命周期仅加载一次资源，或者 clear 来重载
async function loadGifListConfig(url: string): Promise<void> {
  const res = await axios.get(url);
  config = res.data;
}
loadGifListConfig(baseConfigURL);

// 命令前缀与帮助
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "eatgif";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `🧩 <b>头像动图表情</b>

<b>用法：</b>
<code>${commandName} [list|ls|clear|名称]</code>
• <b>空/ list</b>：查看表情列表
• <b>生成</b>：回复目标并输入名称`;

async function ensureConfig(): Promise<void> {
  if (!config) await loadGifListConfig(baseConfigURL);
}

async function loadGifDetailConfig(url: string): Promise<EatGifConfig> {
  const res = await axios.get(baseRepoURL + url);
  return res.data;
}

/**
 * 头像始终是小文件，直接通过其所属 DC 请求单个 upload.GetFile chunk。
 * 避免 teleproto downloadProfilePhoto 进入 MediaScheduler 的 5 × 15 秒重试链。
 */
export async function downloadAvatarDirect(
  client: NonNullable<Api.Message["client"]>,
  entityLike: EntityLike,
): Promise<Buffer | undefined> {
  const entity = entityLike instanceof Api.User ||
    entityLike instanceof Api.Chat ||
    entityLike instanceof Api.Channel
    ? entityLike
    : await client.getEntity(entityLike);
  if (!("photo" in entity)) return undefined;
  const photo = entity.photo;
  if (
    !photo ||
    photo instanceof Api.UserProfilePhotoEmpty ||
    photo instanceof Api.ChatPhotoEmpty
  ) {
    return undefined;
  }

  const result = await client.invoke(
    new Api.upload.GetFile({
      location: new Api.InputPeerPhotoFileLocation({
        peer: utils.getInputPeer(entity),
        photoId: photo.photoId,
        big: false,
      }),
      offset: bigInteger.zero,
      limit: 512 * 1024,
      precise: true,
    }),
    photo.dcId,
  );

  if (!(result instanceof Api.upload.File)) return undefined;
  return Buffer.isBuffer(result.bytes) && result.bytes.length > 0
    ? result.bytes
    : undefined;
}

// 由于很多帧，每个帧又有不同的mask等配置，最好就是缓存
async function assetBufferFor(filePath: string): Promise<Buffer> {
  const localPath = path.join(ASSET_PATH, filePath);
  const url = baseRepoURL + filePath;
  if (fs.existsSync(localPath)) {
    const buffer: Buffer = fs.readFileSync(localPath);
    return buffer;
  }
  const res = await axios.get(url, { responseType: "arraybuffer" });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, res.data);
  return res.data;
}

class EatGifPlugin extends Plugin {

  description: string = `生成头像融合动图\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    eatgif: async (msg, trigger) => {
      await this.handleEatGif(msg, trigger);
    },
    // eatgif2
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "eatgif",
    title: "吃 GIF",
    description: "吃 GIF 动图配置",
    category: "插件配置",
    icon: "🎬",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "x",
            "label": "X 坐标偏移",
            "type": "number",
            "min": -100,
            "max": 100,
            "default": 0
      },
      {
            "key": "y",
            "label": "Y 坐标偏移",
            "type": "number",
            "min": -100,
            "max": 100,
            "default": 0
      },
      {
            "key": "mask",
            "label": "遮罩形状",
            "type": "string",
            "default": "circle"
      },
      {
            "key": "rotate",
            "label": "旋转角度",
            "type": "number",
            "min": -360,
            "max": 360,
            "default": 0
      },
      {
            "key": "brightness",
            "label": "亮度",
            "type": "number",
            "min": 0,
            "max": 200,
            "default": 100
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<RoleConfig>(path.join(createDirectoryInAssets("eatgif"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<RoleConfig>(path.join(createDirectoryInAssets("eatgif"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

  private async handleEatGif(msg: Api.Message, trigger?: Api.Message) {
    const firstLine = (msg.message || msg.text || "").split(/\r?\n/g)[0] || "";
    const parts = firstLine.trim().split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      await ensureConfig();

      if (!sub || sub === "list" || sub === "ls") {
        await msg.edit({ text: this.listAllStickers(), parseMode: "html" });
        return;
      }

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      if (sub === "clear") {
        await this.clearRes(msg);
        return;
      }

      if (!Object.keys(config).includes(sub)) {
        const text = `❌ 未找到 <code>${htmlEscape(
          sub
        )}</code>\n\n${this.listAllStickers()}`;
        await msg.edit({ text, parseMode: "html" });
        return;
      }

      if (!msg.isReply && !trigger?.isReply) {
        await msg.edit({
          text: `💡 请先回复一个用户的消息再执行\n\n使用：<code>${commandName} list</code> 查看表情列表`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: `⏳ 正在生成 <b>${htmlEscape(config[sub].desc)}</b>...`,
        parseMode: "html",
      });
      await this.generateGif(sub, { msg, trigger });
    } catch (e: any) {
      await msg.edit({
        text: `❌ 失败：${htmlEscape(e?.message || String(e))}`,
        parseMode: "html",
      });
    }
  }

  private listAllStickers(): string {
    const keys = Object.keys(config || {});
    const items = keys.map(
      (k) => `• <code>${htmlEscape(k)}</code> - ${htmlEscape(config[k].desc)}`
    );
    const header = `🧩 <b>可用表情列表</b>\n使用：<code>${commandName} &lt;名称&gt;</code>（需回复Ta）\n\n`;
    return header + items.join("\n");
  }

  private async clearRes(msg: Api.Message): Promise<void> {
    fs.rmSync(ASSET_PATH, { recursive: true, force: true });
    await loadGifListConfig(baseConfigURL);
    await msg.edit({ text: "🧹 已清理缓存并刷新配置", parseMode: "html" });
  }

  private async generateGif(
    gifName: string,
    params: { msg: Api.Message; trigger?: Api.Message }
  ) {
    const { msg, trigger } = params;
    const gifConfig = await loadGifDetailConfig(config[gifName].url);

    // 由于要生成很多张图片，最好就是保存 self.avatar 以及 you.avatar 不断调用
    const meAvatarBuffer = await this.getSelfAvatarBuffer(msg, trigger);
    if (!meAvatarBuffer) {
      await msg.edit({ text: "无法获取自己的头像" });
      await msg.deleteWithDelay(2000);
      return;
    }
    const youAvatarBuffer = await this.getYouAvatarBuffer(msg, trigger);
    if (!youAvatarBuffer) {
      await msg.edit({ text: "无法获取对方的头像" });
      await msg.deleteWithDelay(2000);
      return;
    }
    let tasks = [];
    for (let i = 0; i < gifConfig.res.length; i++) {
      const entry = gifConfig.res[i];
      tasks.push(
        this.compositeWithEntryConfig(entry, {
          youAvatarBuffer,
          meAvatarBuffer,
        })
      );
    }
    const result = await Promise.all(tasks);

    if (result.length === 0 || result.every((r) => !r)) {
      await msg.edit({ text: "合成动图失败" });
      return;
    }

    let frames: UnencodedFrame[] = [];
    for (let i = 0; i < gifConfig.res.length; i++) {
      const buffer = result[i];
      if (!buffer) continue;
      const data = Buffer.from(buffer);
      const delay = gifConfig.res[i].delay;
      frames.push({
        data,
        delay: delay ? delay : 100,
      });
    }

    const output = await encode({
      width: gifConfig.width,
      height: gifConfig.height,
      frames,
    });

    const gifPath = path.join(TEMP_PATH, "output.gif");
    const webmPath = path.join(TEMP_PATH, "output.webm");

    fs.writeFileSync(gifPath, Buffer.from(output));

    try {
      await msg.edit({ text: "⏳ 正在转换为 webm 格式..." });
      await execFileAsync('ffmpeg', ['-y', '-i', gifPath, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '41', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', webmPath]);
      await msg.client?.sendFile(msg.peerId, {
        file: webmPath,
        attributes: [
          new Api.DocumentAttributeSticker({
            alt: "✨",
            stickerset: new Api.InputStickerSetEmpty(),
          }),
        ],
        replyTo: await safeGetReplyMessage(msg),
      });
    } catch (e) {
      console.log("exec ffmpeg error", e);
      await msg.edit({ text: `生成 webm 失败 ${e}` });
      await msg.client?.sendFile(msg.peerId, {
        file: gifPath,
        replyTo: await safeGetReplyMessage(msg),
      });
    }

    await msg.delete();

    fs.rmSync(gifPath, { force: true, recursive: true });
    fs.rmSync(webmPath, { force: true, recursive: true });
  }

  // 合成每一帧
  private async compositeWithEntryConfig(
    entry: GifResConfig,
    parmas: {
      youAvatarBuffer: Buffer;
      meAvatarBuffer: Buffer;
    }
  ): Promise<Buffer | undefined> {
    const { youAvatarBuffer, meAvatarBuffer } = parmas;

    const mainCanvas = await assetBufferFor(entry.url);

    let composite: sharp.OverlayOptions[] = [];
    if (entry.you) {
      const iconMasked = await this.iconMaskedFor(entry.you, youAvatarBuffer);
      composite.push(iconMasked);
    }

    // 如果有两人互动
    if (entry.me) {
      const iconMasked = await this.iconMaskedFor(entry.me, meAvatarBuffer);
      composite.push(iconMasked);
    }

    const outBuffer = await sharp(mainCanvas)
      .composite(composite)
      .raw()
      .toBuffer();

    return outBuffer;
  }

  // 拿到每一帧头像位置及裁剪形状
  private async iconMaskedFor(
    role: RoleConfig,
    avatar: Buffer
  ): Promise<sharp.OverlayOptions> {
    const maskBuffer = await assetBufferFor(role.mask);
    const { width: maskWidth, height: maskHeight } = await sharp(
      maskBuffer
    ).metadata();

    let iconRotate = await sharp(avatar)
      .resize(maskWidth, maskHeight)
      .toBuffer();

    if (role.rotate) {
      iconRotate = await sharp(iconRotate).rotate(role.rotate).toBuffer();
    }
    if (role.brightness) {
      iconRotate = await sharp(iconRotate)
        .modulate({ brightness: role.brightness })
        .toBuffer();
    }

    let iconSharp = sharp(iconRotate);

    const { width: iconWidth, height: iconHeight } = await iconSharp.metadata();

    const left = Math.max(0, Math.floor((iconWidth - maskWidth) / 2));
    const top = Math.max(0, Math.floor((iconHeight - maskHeight) / 2));

    let cropped = iconSharp.extract({
      left,
      top,
      width: maskWidth,
      height: maskHeight,
    });

    let iconMasked = await cropped
      .composite([
        {
          input: maskBuffer,
          blend: "dest-in", // 保留 mask 区域
        },
      ])
      .png()
      .toBuffer();

    return {
      input: iconMasked,
      top: role.y,
      left: role.x,
    };
  }
  // 获取头像等数据
  private async getSelfAvatarBuffer(
    msg: Api.Message,
    trigger?: Api.Message
  ): Promise<Buffer | undefined> {
    const meId = trigger?.fromId || msg.fromId;
    if (!meId) {
      return;
    }
    const client = msg.client;
    if (!client) return;
    const meEntity = trigger?.sender ?? msg.sender ?? meId;
    return downloadAvatarDirect(client, meEntity);
  }

  private async getYouAvatarBuffer(
    msg: Api.Message,
    trigger?: Api.Message
  ): Promise<Buffer | undefined> {
    let replyTo = await safeGetReplyMessage(msg);
    if (!replyTo) {
      replyTo = await safeGetReplyMessage(trigger);
    }
    if (!replyTo?.senderId) return;
    const client = msg.client;
    if (!client) return;
    return downloadAvatarDirect(client, replyTo.sender ?? replyTo.senderId);
  }

}

export default new EatGifPlugin();
