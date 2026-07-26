// 文件名: plugins/gif.ts
import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { getGlobalClient, getCurrentGeneration } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { JSONFilePreset } from "lowdb/node";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const execFileAsync = promisify(execFile);

interface GifConverterConfig {
  maxFileSize: number; // MB
  maxDuration: number; // 秒
  maxWidth: number;    // 像素
  maxHeight: number;   // 像素
  quality: number;     // 1-31, 数值越低质量越高
  autoAddToStickerPack: boolean; // 是否自动添加到贴纸包
  defaultStickerPackName: string; // 默认贴纸包名称
  defaultEmoji: string; // 默认表情
}

class GifConverter {
  private client: any;
  private tempDir: string;
  private config: GifConverterConfig = {
    maxFileSize: 50,    // 50MB 限制
    maxDuration: 10,    // 10秒限制
    maxWidth: 512,      // Telegram 贴纸最大宽度
    maxHeight: 512,     // Telegram 贴纸最大高度
    quality: 15,        // 中等质量
    autoAddToStickerPack: false, // 禁用自动添加到贴纸包
    defaultStickerPackName: "my_custom_stickers", // 默认贴纸包名称
    defaultEmoji: "😀"   // 默认表情（会被随机表情覆盖）
  };
  
  // 随机表情数组
  private randomEmojis = [
    "😀", "😁", "😂", "😃", "😄", "😅", "😆", "😉", "😊", "😋",
    "😎", "😍", "😘", "😗", "😙", "😚", "🙂", "🤗", "🤔", "🤨",
    "😐", "😑", "😶", "🙄", "😏", "😣", "😥", "😮", "🤐", "😯",
    "😠", "😡", "😤", "😒", "🙁", "😖", "😔", "😕", "😩", "😢",
    "😱", "😨", "😰", "😬", "😓", "😭", "😵", "😲", "🤯", "😴",
    "🥳", "🥰", "🤩", "🥴", "🥶", "🥵", "🥸", "🤭", "🤮", "🥱",
    "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🦝", "🐻", "🐼", "🐨",
    "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐒",
    "❤️", "💛", "💚", "💙", "💜", "🦡", "🖤", "🤍", "💔", "❣️",
    "🔥", "✨", "🌟", "💫", "💥", "💢", "💦", "💨", "👈", "👉"
  ];

  constructor(client: any) {
    this.client = client;
    this.tempDir = path.join(process.cwd(), "temp", "gif");
  }

  public async initialize() {
    // 创建临时目录
    await createDirectoryInAssets("gif", ["gif_converter"]);
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  public async handle(msg: Api.Message) {
    const args = msg.message.substring(4).trim().toLowerCase();
    
    // 检查是否有帮助参数
    if (args === "help" || args === "h") {
      await this.showHelp(msg);
      return;
    }

    // 检查是否有清理参数
    if (args === "clear" || args === "c") {
      await this.clearTempFiles(msg);
      return;
    }

    // 获取回复的消息
    const repliedMsg = await safeGetReplyMessage(msg);
    if (!repliedMsg) {
      await msg.edit({
        text: "❌ 请回复一个包含 GIF 或视频的消息后使用此命令。\n\n💡 请回复 GIF 或视频后再试。"
      });
      return;
    }

    // 检查消息类型
    if (!this.isValidMedia(repliedMsg)) {
      await msg.edit({
        text: "❌ 回复的消息不包含 GIF 或视频文件。\n\n支持的格式：GIF、MP4、AVI、MOV、WEBM 等视频格式。"
      });
      return;
    }

    try {
      await this.convertToSticker(msg, repliedMsg);
    } catch (error: any) {
      console.error("GIF转贴纸失败:", error);
      await msg.edit({
        text: `❌ 转换失败：${error.message}\n\n💡 请检查支持的格式和限制。`
      });
    }
  }

  private async showHelp(msg: Api.Message) {
    const prefixes = await getPrefixes();
    const prefix = prefixes[0] || ".";
    
    const helpText = `**🎭 GIF 转贴纸插件帮助**

**基本用法：**
回复包含 GIF 或视频的消息，然后发送 \`${prefix}gif\`

**支持格式：**
• GIF 动图
• MP4, AVI, MOV, WEBM 等视频格式

**限制条件：**
• 文件大小：≤ ${this.config.maxFileSize}MB
• 视频时长：≤ ${this.config.maxDuration}秒
• 分辨率：自动调整至 ${this.config.maxWidth}x${this.config.maxHeight} 以内

**其他命令：**
• \`${prefix}gif help\` - 显示此帮助
• \`${prefix}gif clear\` - 清理临时文件

**注意事项：**
• 转换后的贴纸将以 WebM 格式发送
• 过长或过大的视频会被自动裁剪和压缩
• 建议使用时长较短的 GIF 或视频以获得最佳效果`;

    await msg.edit({ text: helpText });
  }

  private async clearTempFiles(msg: Api.Message) {
    try {
      const files = fs.readdirSync(this.tempDir);
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch (e) {
          // 忽略删除失败的文件
        }
      }

      await msg.edit({
        text: `✅ 已清理 ${deletedCount} 个临时文件。`
      });
    } catch (error: any) {
      await msg.edit({
        text: `⚠️ 清理临时文件时出错：${error.message}`
      });
    }
  }

  private isValidMedia(msg: Api.Message): boolean {
    // 检查是否为 GIF
    if (msg.gif) return true;

    // 检查是否为视频
    if (msg.video) {
      const videoMimeTypes = [
        "video/mp4", "video/avi", "video/mov", "video/webm", 
        "video/mkv", "video/flv", "video/wmv", "video/3gp"
      ];
      return videoMimeTypes.includes(msg.video.mimeType || "");
    }

    // 检查文档类型（可能是 GIF 文档）
    if (msg.document) {
      const doc = msg.document;
      if (doc.mimeType === "image/gif") return true;
      
      // 检查文件名扩展名
      const filenameAttr = doc.attributes?.find(
        (attr: any) => attr.className === "DocumentAttributeFilename"
      );
      if (filenameAttr && (filenameAttr as any).fileName) {
        const filename = (filenameAttr as any).fileName.toLowerCase();
        return filename.endsWith(".gif") || 
               filename.endsWith(".mp4") || 
               filename.endsWith(".webm") ||
               filename.endsWith(".mov") ||
               filename.endsWith(".avi");
      }
    }

    return false;
  }

  private async convertToSticker(msg: Api.Message, sourceMsg: Api.Message) {
    const statusMsg = await msg.edit({ text: "🔄 正在分析媒体文件..." });

    // 检查文件大小
    const fileSize = this.getFileSize(sourceMsg);
    if (fileSize > this.config.maxFileSize * 1024 * 1024) {
      throw new Error(`文件过大 (${Math.round(fileSize / 1024 / 1024)}MB)，最大支持 ${this.config.maxFileSize}MB`);
    }

    // 检查视频时长（如果是视频）
    if (sourceMsg.video) {
      const duration = this.getVideoDuration(sourceMsg);
      if (duration > this.config.maxDuration) {
        throw new Error(`视频过长 (${duration}秒)，最大支持 ${this.config.maxDuration}秒`);
      }
    }

    await statusMsg?.edit({ text: "📥 正在下载文件..." });

    // 下载源文件
    const timestamp = Date.now();
    const inputFile = path.join(this.tempDir, `input_${timestamp}`);
    const outputFile = path.join(this.tempDir, `sticker_${timestamp}.webm`);

    try {
      await this.client.downloadMedia(sourceMsg.media!, { outputFile: inputFile });

      await statusMsg?.edit({ text: "🎬 正在转换为贴纸格式..." });

      // 使用 FFmpeg 转换为贴纸格式
      await this.convertWithFFmpeg(inputFile, outputFile);

      await statusMsg?.edit({ text: "📤 正在发送贴纸..." });
      await this.sendAsSticker(msg, outputFile);
      await statusMsg?.edit({ text: "✅ 贴纸转换完成！" });
      
      // 延迟删除状态消息 (generation-safe)
      const gen1 = getCurrentGeneration();
      const t1 = setTimeout(() => {
        pendingTimers.delete(t1);
        if (getCurrentGeneration() !== gen1) return;
        statusMsg?.delete().catch(() => {});
      }, 2000);
      pendingTimers.add(t1);

    } finally {
      // 清理临时文件
      this.cleanupFiles([inputFile, outputFile]);
    }
  }

  private getFileSize(msg: Api.Message): number {
    if (msg.gif) return Number(msg.gif.size) || 0;
    if (msg.video) return Number(msg.video.size) || 0;
    if (msg.document) return Number(msg.document.size) || 0;
    return 0;
  }

  private getVideoDuration(msg: Api.Message): number {
    if (!msg.video) return 0;
    
    const videoAttr = msg.video.attributes?.find(
      (attr: any) => attr.className === "DocumentAttributeVideo"
    );
    return (videoAttr as any)?.duration || 0;
  }

  private async convertWithFFmpeg(inputFile: string, outputFile: string): Promise<void> {
    try {
      await execFileAsync("ffmpeg", [
        "-i", inputFile,
        "-t", this.config.maxDuration.toString(),
        "-vf", `scale=${this.config.maxWidth}:${this.config.maxHeight}:force_original_aspect_ratio=decrease`,
        "-c:v", "libvpx-vp9",
        "-crf", this.config.quality.toString(),
        "-b:v", "0",
        "-an",
        "-f", "webm",
        "-y",
        outputFile
      ]);
      
      // 检查输出文件是否存在
      if (!fs.existsSync(outputFile)) {
        throw new Error("FFmpeg 转换失败，未生成输出文件");
      }

      // 检查文件大小（Telegram 贴纸限制）
      const stats = fs.statSync(outputFile);
      if (stats.size > 256 * 1024) { // 256KB 限制
        // 如果文件过大，降低质量重新转换
        await this.convertWithLowerQuality(inputFile, outputFile);
      }

    } catch (error: any) {
      console.error("FFmpeg转换失败:", error);
      throw new Error(`视频转换失败，请检查 FFmpeg 是否已安装`);
    }
  }

  private async convertWithLowerQuality(inputFile: string, outputFile: string): Promise<void> {
    const lowerQuality = Math.min(31, this.config.quality + 10);
    await execFileAsync("ffmpeg", [
      "-i", inputFile,
      "-t", this.config.maxDuration.toString(),
      "-vf", "scale=320:320:force_original_aspect_ratio=decrease",
      "-c:v", "libvpx-vp9",
      "-crf", lowerQuality.toString(),
      "-b:v", "0",
      "-an",
      "-f", "webm",
      "-y",
      outputFile
    ]);
  }

  private async sendAsSticker(originalMsg: Api.Message, stickerFile: string): Promise<void> {
    try {
      // 读取文件统计信息
      const stats = fs.statSync(stickerFile);
      
      // 使用正确的贴纸属性发送
      await this.client.sendFile(originalMsg.chatId!, {
        file: stickerFile,
        attributes: [
          new Api.DocumentAttributeVideo({
            duration: this.config.maxDuration,
            w: this.config.maxWidth,
            h: this.config.maxHeight,
            supportsStreaming: false,
            roundMessage: false
          }),
          new Api.DocumentAttributeAnimated(),
          new Api.DocumentAttributeSticker({
            alt: this.getRandomEmoji(),
            stickerset: new Api.InputStickerSetEmpty()
          })
        ],
        mimeType: "video/webm",
        forceDocument: false,
        asSticker: true, // 关键：作为贴纸发送
        caption: undefined // 贴纸不需要标题
      });

    } catch (error: any) {
      throw new Error(`发送贴纸失败: ${error.message}`);
    }
  }

  private async autoAddToStickerPack(originalMsg: Api.Message, stickerFile: string, statusMsg: Api.Message): Promise<void> {
    try {
      // 获取 @Stickers 机器人
      const stickersBot = await this.client.getEntity("@Stickers");
      
      await statusMsg.edit({ text: "📤 正在发送文件到 @Stickers 机器人..." });
      
      // 发送 WebM 文件到 @Stickers 机器人
      await this.client.sendFile(stickersBot, {
        file: stickerFile,
        caption: "🎉 新贴纸"
      });
      
      // 等待机器人回复
      await this.sleep(2000);
      await statusMsg.edit({ text: "🤖 正在与 @Stickers 机器人交互..." });
      
      // 发送命令添加到贴纸包
      await this.handleStickerBotInteraction(stickersBot, statusMsg);
      
      // 最终发送贴纸到原始聊天
      await statusMsg.edit({ text: "✨ 正在发送最终贴纸..." });
      await this.sendAsSticker(originalMsg, stickerFile);
      
      await statusMsg.edit({ 
        text: "✅ 成功！贴纸已自动添加到贴纸包并发送。" 
      });
      
      // 延迟删除状态消息 (generation-safe)
      const gen2 = getCurrentGeneration();
      const t2 = setTimeout(() => {
        pendingTimers.delete(t2);
        if (getCurrentGeneration() !== gen2) return;
        statusMsg.delete().catch(() => {});
      }, 3000);
      pendingTimers.add(t2);
      
    } catch (error: any) {
      console.error("自动添加贴纸包失败:", error);
      await statusMsg.edit({ 
        text: `⚠️ 自动添加失败，正在直接发送贴纸...\n\n错误: ${error.message}` 
      });
      
      // 失败后直接发送贴纸
      await this.sendAsSticker(originalMsg, stickerFile);
      const gen3 = getCurrentGeneration();
      const t3 = setTimeout(() => {
        pendingTimers.delete(t3);
        if (getCurrentGeneration() !== gen3) return;
        statusMsg.delete().catch(() => {});
      }, 5000);
      pendingTimers.add(t3);
    }
  }
  
  private async handleStickerBotInteraction(stickersBot: any, statusMsg: Api.Message): Promise<void> {
    // 等待机器人的回复
    await this.sleep(3000);
    
    // 发送命令创建或添加到贴纸包
    await statusMsg.edit({ text: "📝 正在创建/更新贴纸包..." });
    
    // 发送 /addsticker 命令
    await this.client.sendMessage(stickersBot, {
      message: `/addsticker`
    });
    
    await this.sleep(2000);
    
    // 发送贴纸包名称
    await this.client.sendMessage(stickersBot, {
      message: this.config.defaultStickerPackName
    });
    
    await this.sleep(2000);
    
    // 发送表情
    await this.client.sendMessage(stickersBot, {
      message: this.config.defaultEmoji
    });
    
    await statusMsg.edit({ text: "✨ 贴纸包操作完成！" });
  }
  
  private getRandomEmoji(): string {
    const randomIndex = Math.floor(Math.random() * this.randomEmojis.length);
    return this.randomEmojis[randomIndex];
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private cleanupFiles(files: string[]): void {
    files.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (e) {
        console.warn(`清理文件失败: ${file}`, e);
      }
    });
  }
}

const gif = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    return;
  }

  const converter = new GifConverter(client);
  await converter.initialize();
  await converter.handle(msg);
};

// Track pending setTimeout handles for safe cleanup on reload
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

class GifStickerPlugin extends Plugin {

  description: string = `GIF 和视频转贴纸插件

**功能特性：**
• 将 GIF 动图转换为 Telegram 贴纸
• 将短视频转换为动态贴纸
• 自动优化文件大小和分辨率
• 支持多种视频格式

**使用方法：**
1. 回复包含 GIF 或视频的消息
2. 发送 <code>${mainPrefix}gif</code> 命令
3. 插件会自动转换并添加到贴纸包

**支持格式：**
• GIF 动图
• MP4, AVI, MOV, WEBM 等视频

**限制条件：**
• 文件大小：≤ 50MB
• 视频时长：≤ 10秒
• 自动调整至贴纸规格

**自动化功能：**
• 自动发送到 @Stickers 机器人
• 自动添加到指定贴纸包
• 自动设置默认表情
• 失败时回退到直接发送

**其他命令：**
• \`.gif clear\` - 清理临时文件

**依赖要求：**
需要系统安装 FFmpeg

**安装 FFmpeg：**
• Ubuntu/Debian: \`sudo apt install ffmpeg\`
• CentOS/RHEL: \`sudo yum install ffmpeg\`
• macOS: \`brew install ffmpeg\`
• Windows: 下载官方二进制文件`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    gif,
  };

  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "gif",
    title: "GIF 转换",
    description: "视频/GIF 转贴纸配置",
    category: "插件配置",
    icon: "🎞️",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "maxFileSize",
            "label": "最大文件大小 (MB)",
            "type": "number",
            "min": 1,
            "max": 50,
            "default": 20
      },
      {
            "key": "maxDuration",
            "label": "最大时长 (秒)",
            "type": "number",
            "min": 1,
            "max": 60,
            "default": 10
      },
      {
            "key": "maxWidth",
            "label": "最大宽度",
            "type": "number",
            "min": 100,
            "max": 1920,
            "default": 512
      },
      {
            "key": "maxHeight",
            "label": "最大高度",
            "type": "number",
            "min": 100,
            "max": 1920,
            "default": 512
      },
      {
            "key": "quality",
            "label": "质量 (1-31)",
            "type": "number",
            "min": 1,
            "max": 31,
            "default": 15
      },
      {
            "key": "autoAddToStickerPack",
            "label": "自动加入贴纸包",
            "type": "boolean"
      },
      {
            "key": "defaultStickerPackName",
            "label": "默认贴纸包名",
            "type": "string"
      },
      {
            "key": "defaultEmoji",
            "label": "默认表情",
            "type": "string",
            "default": "😀"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<GifConverterConfig>(path.join(createDirectoryInAssets("gif"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<GifConverterConfig>(path.join(createDirectoryInAssets("gif"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

  cleanup(): void {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }
}

export default new GifStickerPlugin();
