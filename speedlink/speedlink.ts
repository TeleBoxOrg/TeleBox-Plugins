import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { execSync, execFile, ChildProcess, spawn } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import axios from "axios";
import * as crypto from "crypto";
import sharp from "sharp";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { htmlEscape } from "@utils/htmlEscape";

import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";

// --- Global variables for test control ---
let DEFAULT_TIMEOUT = 300000; // Default 5 minutes, can be customized

async function fillRoundedCorners(
  inputPath: string,
  outPath?: string,
  bgColor: string = "#212338",
  borderPx: number = 14
) {
  const meta = await sharp(inputPath).metadata();

  const output =
    outPath ??
    (() => {
      const dir = path.dirname(inputPath);
      const ext =
        meta.format === "jpeg" || meta.format === "jpg" ? ".jpg" : ".png";
      const base = path.basename(inputPath, path.extname(inputPath));
      return path.join(dir, `${base}.filled${ext}`);
    })();

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    throw new Error("Unable to read image dimensions");
  }

  const maxInset = Math.floor((Math.min(width, height) - 1) / 2);
  const inset = Math.max(0, Math.min(borderPx, maxInset));
  const cropW = width - inset * 2;
  const cropH = height - inset * 2;

  const background = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: bgColor,
    },
  });

  const innerBuf = await sharp(inputPath)
    .extract({ left: inset, top: inset, width: cropW, height: cropH })
    .toBuffer();

  const left = Math.floor((width - cropW) / 2);
  const top = Math.floor((height - cropH) / 2);

  let composed = background.composite([{ input: innerBuf, left, top }]);

  if (meta.format === "jpeg" || meta.format === "jpg") {
    composed = composed.jpeg({ quality: 95 });
  } else if (meta.format === "png" || !meta.format) {
    composed = composed.png({ compressionLevel: 9 });
  }

  await composed.toFile(output);
  return { output };
}

const execFileAsync = promisify(execFile);

/**
 * Execute a remote or local speedtest command safely using spawn/execFile
 * to prevent shell injection via user-supplied server config fields.
 */
async function runSpeedtestCommand(
  command: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
  label: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      timeout: options.timeout,
      env: options.env,
      killSignal: "SIGKILL" as const,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", (err: Error) => { reject(err); });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err: any = new Error(`${label} exited with code ${code}: ${stderr || stdout}`);
        err.stderr = stderr;
        reject(err);
      }
    });
    // Force-kill on timeout (spawn timeout only signals, doesn't kill by default)
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out after ${options.timeout}ms`));
    }, options.timeout);
    child.on("close", () => { clearTimeout(timer); });
  });
}

// --- Sanitize sensitive information from error messages ---
function sanitizeErrorMessage(error: string, server?: ServerConfig): string {
  let sanitized = error;
  
  // Remove passwords
  sanitized = sanitized.replace(/sshpass -p '[^']*'/gi, "sshpass -p '***'");
  sanitized = sanitized.replace(/password[:\s]+\S+/gi, "password: ***");
  
  // Mask IP addresses (full mask)
  sanitized = sanitized.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '***.***.***.***');
  
  // Mask IPv6 addresses (more aggressive)
  sanitized = sanitized.replace(/([0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:.]+/g, '***:***:***:***');
  
  // Remove SSH key paths
  sanitized = sanitized.replace(/ssh -i [^\s]+/gi, "ssh -i ***");
  
  // Remove usernames in connection strings
  sanitized = sanitized.replace(/\b[a-zA-Z0-9_-]+@/g, "***@");
  
  // If server config is provided, also remove specific server details
  if (server) {
    sanitized = sanitized.replace(new RegExp(server.host, 'g'), '***');
    sanitized = sanitized.replace(new RegExp(server.username, 'g'), '***');
    if (server.auth_method === 'password') {
      try {
        const password = decrypt(server.credentials);
        sanitized = sanitized.replace(new RegExp(password, 'g'), '***');
      } catch (e) {
        // Ignore decryption errors
      }
    }
  }
  
  return sanitized;
}

// --- Interfaces ---
interface ServerConfig {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: "password" | "key";
  credentials: string;
}

interface SpeedtestResult {
  isp: string;
  server: { id: number; name: string; location: string };
  interface: { externalIp: string; name: string };
  ping: { latency: number; jitter: number };
  download: { bandwidth: number; bytes: number };
  upload: { bandwidth: number; bytes: number };
  timestamp: string;
  result: { url: string };
}

// --- Dependencies ---
let dependenciesInstalled = false;
let isInstalling = false;
try {
  require.resolve("better-sqlite3");
  execSync("command -v sshpass");
  dependenciesInstalled = true;
} catch (e: any) {
  dependenciesInstalled = false;
}

async function installDependencies(msg: Api.Message): Promise<void> {
  isInstalling = true;
  try {
    console.log("SpeedLink Plugin: Starting async dependency installation...");
    try {
      require.resolve("better-sqlite3");
    } catch (e: any) {
      console.log("[INSTALLING] 'better-sqlite3' not found. Installing via npm...");
      await execFileAsync("npm", ["install", "better-sqlite3"], { cwd: "/root/telebox" });
      console.log("[SUCCESS] Installed 'better-sqlite3'.");
    }
    try {
      execSync("command -v sshpass");
    } catch (e: any) {
      console.log("[INSTALLING] 'sshpass' not found. Installing via system package manager...");
      if (fs.existsSync("/usr/bin/apt-get"))
        await execFileAsync("sudo", ["apt-get", "update"], { timeout: 120000 }).then(() =>
          execFileAsync("sudo", ["apt-get", "install", "-y", "sshpass"], { timeout: 120000 })
        );
      else if (fs.existsSync("/usr/bin/yum"))
        await execFileAsync("sudo", ["yum", "install", "-y", "sshpass"], { timeout: 120000 });
      else throw new Error("Unsupported package manager.");
      console.log("[SUCCESS] Installed 'sshpass'.");
    }
    await msg.edit({
      text: "✅ <b>依赖安装完成！</b>\n\n为了使插件生效，请现在<b>重启TeleBox</b>。",
      parseMode: "html",
    });
    dependenciesInstalled = false;
  } catch (error: any) {
    console.error("[FATAL] Dependency installation failed:", error);
    await msg.edit({
      text: `❌ <b>依赖自动安装失败！</b>\n\n请检查服务器后台日志。`,
      parseMode: "html",
    });
  } finally {
    isInstalling = false;
  }
}

let Database: any = null;
if (dependenciesInstalled) Database = require("better-sqlite3");

// --- Constants ---
const PLUGIN_NAME = path.basename(__filename, path.extname(__filename));
const ASSETS_DIR = createDirectoryInAssets(PLUGIN_NAME);
const TEMP_DIR = createDirectoryInTemp("speedtest");
const DB_PATH = path.join(ASSETS_DIR, "servers.db");
const KEY_PATH = path.join(ASSETS_DIR, "secret.key");
const CONFIG_PATH = path.join(ASSETS_DIR, "config.json");
const SPEEDTEST_PATH = path.join(ASSETS_DIR, "speedtest");
const SPEEDTEST_VERSION = "1.2.0";

// --- Load/Save configuration ---
function loadConfig(): { timeout?: number } {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error("Failed to load config:", e);
  }
  return {};
}

function saveConfig(config: any): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error("Failed to save config:", e);
  }
}

// Load timeout from config
const config = loadConfig();
if (config.timeout) {
  DEFAULT_TIMEOUT = config.timeout;
}

async function downloadCli(): Promise<void> {
  if (fs.existsSync(SPEEDTEST_PATH)) return;
  console.log("Downloading Speedtest CLI...");
  const platform = process.platform;
  const arch = process.arch;
  let filename: string;

  if (platform === "linux") {
    const archMap: { [key: string]: string } = {
      x64: "x86_64",
      arm64: "aarch64",
      arm: "armhf",
    };
    const mappedArch = archMap[arch] || "x86_64";
    filename = `ookla-speedtest-${SPEEDTEST_VERSION}-linux-${mappedArch}.tgz`;
  } else {
    throw new Error(`Unsupported platform for auto-download: ${platform}`);
  }

  const url = `https://install.speedtest.net/app/cli/${filename}`;
  const response = await axios.get(url, { responseType: "arraybuffer" });
  const tempFile = path.join(ASSETS_DIR, filename);
  fs.writeFileSync(tempFile, response.data);

  await execFileAsync("tar", ["-xzf", tempFile, "-C", ASSETS_DIR]);
  await execFileAsync("chmod", ["+x", SPEEDTEST_PATH]);
  fs.unlinkSync(tempFile);

  ["speedtest.5", "speedtest.md"].forEach((file) => {
    const filePath = path.join(ASSETS_DIR, file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  console.log("Speedtest CLI downloaded and extracted successfully.");
}

function getEncryptionKey(): string {
  if (fs.existsSync(KEY_PATH)) return fs.readFileSync(KEY_PATH, "utf-8");
  const newKey = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(KEY_PATH, newKey, "utf-8");
  console.log(`SpeedLink Plugin (${PLUGIN_NAME}): New encryption key generated.`);
  return newKey;
}

const ENCRYPTION_KEY = getEncryptionKey();
const IV_LENGTH = 16;
let db: any = null;
if (Database) {
  db = new Database(DB_PATH);
  db.exec(
    `CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, auth_method TEXT NOT NULL, credentials TEXT NOT NULL)`
  );
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text: string): string {
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift()!, "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString();
  } catch (error: any) {
    throw new Error("Failed to decrypt credentials. The key file may have been changed/deleted.");
  }
}

// Fixed htmlEscape function
async function unitConvert(bytes: number, isBytes: boolean = false): Promise<string> {
  const power = 1000;
  let value = bytes;
  let unitIndex = 0;
  const units = isBytes
    ? ["B", "KB", "MB", "GB", "TB"]
    : ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  if (!isBytes) value *= 8;
  while (value >= power && unitIndex < units.length - 1) {
    value /= power;
    unitIndex++;
  }
  return `${Math.round(value * 100) / 100}${units[unitIndex]}`;
}

async function getIpApi(ip: string) {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ip}?fields=as,countryCode`);
    const data = response.data;
    const asInfo = data.as?.split(" ")[0] || "";
    const ccFlag = data.countryCode
      ? String.fromCodePoint(
          ...data.countryCode
            .toUpperCase()
            .split("")
            .map((c: string) => 127397 + c.charCodeAt(0))
        )
      : "";
    return { asInfo, ccFlag };
  } catch (error: any) {
    return { asInfo: "", ccFlag: "" };
  }
}

async function saveSpeedtestImage(url: string): Promise<string | null> {
  try {
    const imageUrl = url + ".png";
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imagePath = path.join(TEMP_DIR, "speedtest.png");
    const filledImagePath = path.join(TEMP_DIR, "speedtest_filled.png");
    fs.writeFileSync(imagePath, response.data);

    const bgColor = "#212338";
    const borderPx = 14;
    try {
      await fillRoundedCorners(imagePath, filledImagePath, bgColor, borderPx);
      return filledImagePath;
    } catch (err: any) {
      console.error("Failed to fill rounded corners:", err);
    }

    return imagePath;
  } catch (error: any) {
    console.error("Failed to save speedtest image:", error);
    return null;
  }
}

const HELP_TEXT = `
本插件可以对本机或多台远程服务器进行网络速度测试，并支持保存和管理服务器配置。

<b>⚠️ 远程服务器要求</b>
为了测试远程服务器，您必须首先在该服务器上安装 <b>Ookla Speedtest CLI</b>。
- <b>Debian/Ubuntu 系统:</b>
<pre><code>curl -sL https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.deb.sh | sudo bash
sudo apt-get install speedtest</code></pre>
- <b>CentOS/RHEL 系统:</b>
<pre><code>curl -sL https://packagecloud.io/install/repositories/ookla/speedtest-cli/script.rpm.sh | sudo bash
sudo yum install speedtest</code></pre>
---
<b>服务器管理指令:</b>

- <b>添加服务器 (密码认证):</b>
  <code>sl add &lt;别名&gt; &lt;user@host:port&gt; password &lt;密码&gt;</code>
  <i>示例:</i> <code>sl add 东京-甲骨文 root@1.2.3.4:22 password MyPassword123</code>

- <b>添加服务器 (密钥认证):</b>
  <code>sl add &lt;别名&gt; &lt;user@host:port&gt; key &lt;私钥路径&gt;</code>
  <i>注意: 私钥路径是指在<b>运行TeleBox的服务器上</b>的绝对路径。</i>
  <i>示例:</i> <code>sl add 法兰克福-谷歌 ubuntu@5.6.7.8:22 key /root/.ssh/id_rsa</code>

- <b>查看服务器列表:</b> <code>sl list</code>
- <b>删除服务器:</b> <code>sl del &lt;显示序号&gt;</code>
- <b>🆕 修改别名:</b> <code>sl rename &lt;显示序号&gt; &lt;新别名&gt;</code>
---
<b>执行测速指令:</b>

- <b>远程测速:</b> <code>sl &lt;显示序号&gt;</code>
- <b>本机测速:</b> <code>sl</code>
- <b>多服务器测速:</b> <code>sl 1 3 5</code>
- <b>全部测速:</b> <code>sl all</code>
- <b>🆕 排除测速:</b> <code>sl all no &lt;序号1&gt; &lt;序号2&gt;</code>
---
<b>配置指令:</b>

- <b>设置超时时间:</b> <code>sl timeout &lt;秒数&gt;</code>
  <i>示例:</i> <code>sl timeout 60</code> (设置60秒超时)
  <i>默认值: 300秒 (5分钟)</i>
- <b>查看当前超时:</b> <code>sl timeout</code>
---
<b>备份与恢复:</b>

- <b>备份:</b> <code>sl backup</code>
  (将数据备份到您的收藏夹)

- <b>恢复:</b> 回复备份文件, 发送 <code>sl restore confirm</code>
  (此操作将覆盖现有数据, 请谨慎使用)
`;

// --- Main handler ---
const speedtest = async (msg: Api.Message): Promise<void> => {
  if (!dependenciesInstalled) {
    if (isInstalling)
      await msg.edit({
        text: "⏳ <b>依赖已在安装中...</b>",
        parseMode: "html",
      });
    else {
      await msg.edit({
        text: "首次运行，正在自动安装依赖...",
        parseMode: "html",
      });
      installDependencies(msg);
    }
    return;
  }

  const args = msg.message.slice(2).split(" ").slice(1);
  const chatId = Number(msg.peerId?.toString());
  const allServers: ServerConfig[] = db.prepare("SELECT * FROM servers ORDER BY id").all();

  try {
    const command = args[0] || "";
    
    // --- New: Timeout configuration ---
    if (command === "timeout") {
      if (args[1]) {
        const newTimeout = parseInt(args[1]);
        if (isNaN(newTimeout) || newTimeout < 10 || newTimeout > 600) {
          await msg.edit({
            text: "❌ <b>无效的超时时间</b>\n\n请输入10到600之间的秒数。",
            parseMode: "html",
          });
          return;
        }
        DEFAULT_TIMEOUT = newTimeout * 1000;
        saveConfig({ ...loadConfig(), timeout: DEFAULT_TIMEOUT });
        await msg.edit({
          text: `✅ <b>超时时间已设置</b>\n\n新的超时时间: <code>${newTimeout}</code> 秒`,
          parseMode: "html",
        });
      } else {
        const currentTimeout = DEFAULT_TIMEOUT / 1000;
        await msg.edit({
            text: `ℹ️ <b>当前超时设置</b>\n\n超时时间: <code>${currentTimeout}</code> 秒\n\n使用 <code>sl timeout &lt;秒数&gt;</code> 来修改`,
          parseMode: "html",
        });
      }
      return;
    }
    
    // --- Server management commands ---
    if (command === "add" || command === "list" || command === "del" || command === "backup" || command === "restore" || command === "rename") {
      if (command === "add") {
        const [name, connection, authMethod, ...creds] = args.slice(1);
        const credential = creds.join(" ");
        if (!name || !connection || !authMethod || !credential || !["password", "key"].includes(authMethod)) {
          await msg.edit({
            text: `❌ <b>参数错误</b>\n\n${HELP_TEXT}`,
            parseMode: "html",
          });
          return;
        }
        const [username, hostWithPort] = connection.split("@");

        if (!hostWithPort) {
          await msg.edit({ text: `❌ <b>连接格式错误</b>`, parseMode: "html" });
          return;
        }
        const lastColonIndex = hostWithPort.lastIndexOf(":");
        if (lastColonIndex === -1) {
          await msg.edit({
            text: `❌ <b>连接格式错误: 缺少端口号</b>`,
            parseMode: "html",
          });
          return;
        }
        const host = hostWithPort.substring(0, lastColonIndex);
        const portStr = hostWithPort.substring(lastColonIndex + 1);
        const port = parseInt(portStr, 10);

        if (!username || !host || isNaN(port)) {
          await msg.edit({
            text: `❌ <b>连接格式错误或端口号无效</b>`,
            parseMode: "html",
          });
          return;
        }

        const storedCredential = authMethod === "password" ? encrypt(credential) : credential;
        try {
          db.prepare(
            "INSERT INTO servers (name, host, port, username, auth_method, credentials) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(name, host, port, username, authMethod, storedCredential);
          await msg.edit({
            text: `✅ 服务器 <b>${htmlEscape(name)}</b> 添加成功！`,
            parseMode: "html",
          });
        } catch (err: any) {
          await msg.edit({
            text: `❌ 添加失败: <code>${htmlEscape(err.message)}</code>`,
            parseMode: "html",
          });
        }
      } else if (command === "list") {
        // const servers: ServerConfig[] = db.prepare("SELECT * FROM servers ORDER BY id").all(); // Already fetched
        if (allServers.length === 0) {
          await msg.edit({
            text: "ℹ️ 未配置任何远程服务器。",
            parseMode: "html",
          });
          return;
        }
        const serverList = allServers
          .map((s: ServerConfig, i: number) => `<code>${i + 1}</code> - <b>${htmlEscape(s.name)}</b>`)
          .join("\n");
        await msg.edit({
          text: `<b>已配置的服务器列表:</b>\n${serverList}`,
          parseMode: "html",
        });
      } else if (command === "del") {
        const displayId = parseInt(args[1]);
        if (isNaN(displayId) || displayId < 1) {
          await msg.edit({
            text: "❌ 请提供有效的显示序号。",
            parseMode: "html",
          });
          return;
        }
        // const servers: ServerConfig[] = db.prepare("SELECT * FROM servers ORDER BY id").all(); // Already fetched
        const serverToDelete = allServers[displayId - 1];
        if (!serverToDelete) {
          await msg.edit({
            text: `❌ 未找到显示序号为 ${displayId} 的服务器。`,
            parseMode: "html",
          });
          return;
        }
        const info = db.prepare("DELETE FROM servers WHERE id = ?").run(serverToDelete.id);
        await msg.edit({
          text:
            info.changes > 0
              ? `✅ 服务器 <b>${htmlEscape(serverToDelete.name)}</b> (显示序号 ${displayId}) 已删除。`
              : `❌ 删除失败。`,
          parseMode: "html",
        });
      } else if (command === "rename") { // --- New: Rename command
        const displayId = parseInt(args[1]);
        const newName = args.slice(2).join(" ");
        if (isNaN(displayId) || displayId < 1 || !newName) {
          await msg.edit({
            text: "❌ <b>参数错误</b>\n\n请使用: <code>sl rename &lt;显示序号&gt; &lt;新别名&gt;</code>",
            parseMode: "html",
          });
          return;
        }
        const serverToRename = allServers[displayId - 1];
        if (!serverToRename) {
          await msg.edit({
            text: `❌ 未找到显示序号为 ${displayId} 的服务器。`,
            parseMode: "html",
          });
          return;
        }
        try {
          db.prepare("UPDATE servers SET name = ? WHERE id = ?").run(newName, serverToRename.id);
          await msg.edit({
            text: `✅ <b>重命名成功</b>\n\n原别名 <b>${htmlEscape(serverToRename.name)}</b> 已修改为 <b>${htmlEscape(newName)}</b>`,
            parseMode: "html",
          });
        } catch (err: any) {
          await msg.edit({
            text: `❌ 重命名失败: <code>${htmlEscape(err.message)}</code>`,
            parseMode: "html",
          });
        }
      } else if (command === "backup") {
        if (!fs.existsSync(DB_PATH)) {
          await msg.edit({
            text: `❌ 数据库文件不存在，无法备份。`,
            parseMode: "html",
          });
          return;
        }
        await msg.edit({ text: `⚙️ 正在准备备份文件...`, parseMode: "html" });
        const date = new Date().toISOString().split("T")[0];
        const backupFilename = `${PLUGIN_NAME}_backup_${date}.db`;
        await msg.client?.sendFile("me", {
          file: DB_PATH,
          caption: `SpeedLink 插件服务器数据备份\n日期: ${date}`,
          attributes: [new Api.DocumentAttributeFilename({ fileName: backupFilename })],
        });
        await msg.edit({
          text: `✅ 备份成功！\n\n文件已发送至您的<b>收藏夹 (Saved Messages)</b>。`,
          parseMode: "html",
        });
      } else if (command === "restore") {
        if (!msg.isReply) {
          await msg.edit({
            text: `❌ <b>恢复失败</b>\n\n请回复一个备份文件来执行此命令。`,
            parseMode: "html",
          });
          return;
        }
        if (args[1] !== "confirm") {
          await msg.edit({
            text: `⚠️ <b>请确认操作！</b>\n\n此操作将用备份文件覆盖当前的服务器列表，现有数据将丢失。\n\n请回复备份文件并使用 <code>sl restore confirm</code> 来确认。`,
            parseMode: "html",
          });
          return;
        }
        const repliedMsg = await safeGetReplyMessage(msg);
        if (!repliedMsg?.document) {
          await msg.edit({
            text: `❌ <b>恢复失败</b>\n\n您回复的消息不包含文件。`,
            parseMode: "html",
          });
          return;
        }

        await msg.edit({
          text: `⚙️ 正在从备份文件恢复数据...`,
          parseMode: "html",
        });
        const buffer = repliedMsg.media
          ? await msg.client?.downloadMedia(repliedMsg.media)
          : null;
        if (buffer) {
          if (fs.existsSync(DB_PATH)) {
            fs.renameSync(DB_PATH, DB_PATH + ".bak");
          }
          fs.writeFileSync(DB_PATH, buffer);
          await msg.edit({
            text: `✅ <b>恢复成功！</b>\n\n数据已从备份文件导入。请**重启TeleBox**以应用更改。`,
            parseMode: "html",
          });
        } else {
          await msg.edit({
            text: `❌ <b>恢复失败</b>\n\n无法下载备份文件。`,
            parseMode: "html",
          });
        }
      }
      return;
    }

    // --- Speed Test Execution Logic ---
    // const allServers: ServerConfig[] = db.prepare("SELECT * FROM servers ORDER BY id").all(); // Already fetched
    let targetServers: (ServerConfig | null)[] = [];

    const isAllTest = command === "all" && args[1] !== "no";
    const isExcludeTest = command === "all" && args[1] === "no" && args.length > 2;
    const isMultiTest = !isAllTest && !isExcludeTest && args.length > 0 && args.every((arg) => !isNaN(parseInt(arg)));

    if (isAllTest || isMultiTest || isExcludeTest) {
      if (isAllTest) {
        targetServers = allServers;
      } else if (isExcludeTest) {
        const excludeDisplayIds = args.slice(2).map(id => parseInt(id));
        targetServers = allServers.filter((s, i) => !excludeDisplayIds.includes(i + 1));
      } else { // isMultiTest
        targetServers = args
          .map((arg) => {
            const displayId = parseInt(arg);
            return allServers[displayId - 1] || null;
          })
          .filter((s): s is ServerConfig => s !== null);
      }

      if (targetServers.length === 0) {
        await msg.edit({
          text: "❌ 未找到任何有效的服务器进行测速。",
          parseMode: "html",
        });
        return;
      }

      await msg.delete();

      for (const server of targetServers) {
        if (!server) continue;

        const statusMsg = await msg.client?.sendMessage(msg.peerId, {
          message: `⚡️ [${targetServers.indexOf(server) + 1}/${
            targetServers.length
          }] 正在为 <b>${htmlEscape(server.name)}</b> 进行远程测速...`,
          parseMode: "html",
        });

        try {
          const speedtestArgs = ["--accept-license", "--accept-gdpr", "-f", "json"];
          const remoteCmd = "speedtest";
          const remoteArgs = [remoteCmd, ...speedtestArgs];
          let command: string;
          let args: string[];
          let env: NodeJS.ProcessEnv | undefined;

          if (server.auth_method === "password") {
            const password = decrypt(server.credentials);
            // Pass password via sshpass -p argument — safe from shell injection
            // because we use spawn() with shell:false and argument array
            command = "sshpass";
            args = [
              "-p", password,
              "ssh",
              "-p", String(server.port),
              "-o", "StrictHostKeyChecking=no",
              "-o", "ConnectTimeout=10",
              `${server.username}@${server.host}`,
              ...remoteArgs,
            ];
          } else {
            command = "ssh";
            args = [
              "-i", server.credentials,
              "-p", String(server.port),
              "-o", "StrictHostKeyChecking=no",
              "-o", "ConnectTimeout=10",
              `${server.username}@${server.host}`,
              ...remoteArgs,
            ];
          }

          const startTime = Date.now();
          const { stdout } = await runSpeedtestCommand(command, args, {
            timeout: DEFAULT_TIMEOUT,
            env,
          }, `speedtest-${server.name}`);
          const endTime = Date.now();
          const duration = ((endTime - startTime) / 1000).toFixed(2);
          
          const jsonStartIndex = stdout.indexOf("{");
          if (jsonStartIndex === -1) throw new Error("Speedtest did not return valid JSON.");
          const result: SpeedtestResult = JSON.parse(stdout.substring(jsonStartIndex));

          const { asInfo, ccFlag } = await getIpApi(result.interface.externalIp);
          
          // Convert timestamp to Beijing Time (UTC+8)
          const resultDate = new Date(result.timestamp);
          const beijingTime = new Date(resultDate.getTime() + 8 * 60 * 60 * 1000);
          const beijingTimeString = beijingTime.toISOString().replace('T', ' ').substring(0, 19);

          const caption = [
            `<b>${htmlEscape(server.name)}</b> ${ccFlag}`,
            `<code>Name</code>  <code>${htmlEscape(result.isp)} ${asInfo}</code>`,
            `<code>Node</code>  <code>${result.server.id} - ${htmlEscape(
              result.server.name
            )} - ${htmlEscape(result.server.location)}</code>`,
            `<code>Conn</code>  <code>Multi - IPv${
              result.interface.externalIp.includes(":") ? "6" : "4"
            } - ${htmlEscape(result.interface.name)}</code>`,
            `<code>Ping</code>  <code>⇔${result.ping.latency.toFixed(3)}ms ±${result.ping.jitter.toFixed(
              3
            )}ms</code>`,
            `<code>Rate</code>  <code>↓${await unitConvert(
              result.download.bandwidth
            )} ↑${await unitConvert(result.upload.bandwidth)}</code>`,
            `<code>Data</code>  <code>↓${await unitConvert(
              result.download.bytes,
              true
            )} ↑${await unitConvert(result.upload.bytes, true)}</code>`,
            `<code>Time</code>  <code>${beijingTimeString} (UTC+8)</code>`,
            `<code>Used</code>  <code>${duration}s</code>`,
            `<code>Link</code>  ${htmlEscape(result.result.url)}`,
          ].join("\n");

          const imagePath = await saveSpeedtestImage(result.result.url);
          if (imagePath && fs.existsSync(imagePath)) {
            await msg.client?.sendFile(msg.peerId, {
              file: imagePath,
              caption: caption,
              parseMode: "html",
            });
            fs.unlinkSync(imagePath);
          } else {
            if (statusMsg) {
              await statusMsg.edit({ text: caption, parseMode: "html" });
            }
          }
          if (statusMsg) {
            await statusMsg.delete();
          }
        } catch (error: any) {
          // Sanitize error message before displaying
          let errorMsg = String(error.stderr || error.message || error);
          errorMsg = sanitizeErrorMessage(errorMsg, server);
          
          if (statusMsg) {
            await statusMsg.edit({
              text: `❌ <b>${htmlEscape(server.name)}</b> 测速失败\n\n<code>${htmlEscape(
                errorMsg
              )}</code>`,
              parseMode: "html",
            });
          }
        }
      }
      return;
    }

    // Single test (local or single server)
    let isRemote = false;
    let serverConfig: ServerConfig | null = null;
    let initialText: string;

    if (command === "") {
      isRemote = false;
      initialText = `⚡️ 正在进行<b>本机</b>速度测试...`;
    } else if (!isNaN(parseInt(command))) {
      isRemote = true;
      const displayId = parseInt(command);
      serverConfig = allServers[displayId - 1];
      if (!serverConfig) {
        await msg.edit({
          text: `❌ 未找到显示序号为 ${displayId} 的服务器。`,
          parseMode: "html",
        });
        return;
      }
      initialText = `⚡️ 正在为服务器 <b>${htmlEscape(
        serverConfig.name
      )}</b> 进行远程测速...`;
    } else {
      await msg.edit({
        text: `<b>指令无效</b>\n\n${HELP_TEXT}`,
        parseMode: "html",
      });
      return;
    }

    let statusMsg: Api.Message | undefined;
    try {
      statusMsg = await msg.client?.sendMessage(msg.peerId, {
        message: initialText,
        parseMode: "html",
      });
      await msg.delete();
    } catch (e) {
      console.error("Failed to send/delete, falling back to editing original message:", e);
      try {
        await msg.edit({ text: initialText, parseMode: "html" });
        statusMsg = msg;
      } catch (editError) {
        console.error("Critical: Fallback edit also failed.", editError);
      }
    }

    try {
      const speedtestArgs = ["--accept-license", "--accept-gdpr", "-f", "json"];
      let command: string;
      let args: string[];
      let env: NodeJS.ProcessEnv | undefined;

      if (isRemote && serverConfig) {
        const remoteArgs = ["speedtest", ...speedtestArgs];
        if (serverConfig.auth_method === "password") {
          const password = decrypt(serverConfig.credentials);
          // Pass password via sshpass -p argument — safe from shell injection
          // because we use spawn() with shell:false and argument array
          command = "sshpass";
          args = [
            "-p", password,
            "ssh",
            "-p", String(serverConfig.port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=10",
            `${serverConfig.username}@${serverConfig.host}`,
            ...remoteArgs,
          ];
        } else {
          command = "ssh";
          args = [
            "-i", serverConfig.credentials,
            "-p", String(serverConfig.port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=10",
            `${serverConfig.username}@${serverConfig.host}`,
            ...remoteArgs,
          ];
        }
      } else {
        if (!fs.existsSync(SPEEDTEST_PATH)) {
          const downloadingMsg = "本地 Speedtest CLI 不存在，正在为您下载...";
          if (statusMsg) await statusMsg.edit({ text: downloadingMsg, parseMode: "html" });
          else await msg.edit({ text: downloadingMsg, parseMode: "html" });
          await downloadCli();
        }
        // Local speedtest — use execFile with argument array (no shell injection)
        command = SPEEDTEST_PATH;
        args = speedtestArgs;
      }

      const startTime = Date.now();
      const { stdout } = await runSpeedtestCommand(command, args, {
        timeout: DEFAULT_TIMEOUT,
        env,
      }, isRemote ? "remote-speedtest" : "local-speedtest");
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
      
      const jsonStartIndex = stdout.indexOf("{");
      if (jsonStartIndex === -1) throw new Error("Speedtest did not return valid JSON.");
      const result: SpeedtestResult = JSON.parse(stdout.substring(jsonStartIndex));

      const { asInfo, ccFlag } = await getIpApi(result.interface.externalIp);
      
      // Convert timestamp to Beijing Time (UTC+8)
      const resultDate = new Date(result.timestamp);
      const beijingTime = new Date(resultDate.getTime() + 8 * 60 * 60 * 1000);
      const beijingTimeString = beijingTime.toISOString().replace('T', ' ').substring(0, 19);

      const caption = [
        `<b>⚡️SPEEDTEST by OOKLA</b> ${ccFlag}`,
        `<code>Name</code>  <code>${htmlEscape(result.isp)} ${asInfo}</code>`,
        `<code>Node</code>  <code>${result.server.id} - ${htmlEscape(
          result.server.name
        )} - ${htmlEscape(result.server.location)}</code>`,
        `<code>Conn</code>  <code>Multi - IPv${
          result.interface.externalIp.includes(":") ? "6" : "4"
        } - ${htmlEscape(result.interface.name)}</code>`,
        `<code>Ping</code>  <code>⇔${result.ping.latency.toFixed(3)}ms ±${result.ping.jitter.toFixed(
          3
        )}ms</code>`,
        `<code>Rate</code>  <code>↓${await unitConvert(
          result.download.bandwidth
        )} ↑${await unitConvert(result.upload.bandwidth)}</code>`,
        `<code>Data</code>  <code>↓${await unitConvert(
          result.download.bytes,
          true
        )} ↑${await unitConvert(result.upload.bytes, true)}</code>`,
        `<code>Time</code>  <code>${beijingTimeString} (UTC+8)</code>`,
        `<code>Used</code>  <code>${duration}s</code>`,
        `<code>Link</code>  ${htmlEscape(result.result.url)}`,
      ].join("\n");

      const imagePath = await saveSpeedtestImage(result.result.url);
      if (imagePath && fs.existsSync(imagePath)) {
        await msg.client?.sendFile(msg.peerId, {
          file: imagePath,
          caption: caption,
          parseMode: "html",
        });
        fs.unlinkSync(imagePath);
      } else {
        await msg.client?.sendMessage(msg.peerId, {
          message: caption,
          parseMode: "html",
        });
      }
      if (statusMsg) await statusMsg.delete();
    } catch (error: any) {
      // Sanitize error message before displaying
      let errorMsg = String(error.stderr || error.message || error);
      errorMsg = sanitizeErrorMessage(errorMsg, serverConfig || undefined);
      
      const errorText = `❌ <b>速度测试失败</b>\n\n<code>${htmlEscape(errorMsg)}</code>`;
      if (statusMsg) {
        await statusMsg.edit({ text: errorText, parseMode: "html" });
      }
    }
  } catch (error: any) {
    console.error(`SpeedLink Plugin (${PLUGIN_NAME}) critical error:`, error);
    // Sanitize any critical errors as well
    const sanitizedError = sanitizeErrorMessage(String(error));
    await msg.edit({
      text: `❌ <b>插件发生严重错误</b>\n\n<code>${htmlEscape(sanitizedError)}</code>`,
      parseMode: "html",
    });
  }
};

// --- Plugin class ---
class SpeedlinkPlugin extends Plugin {

  description: string = `⚡️ 网络速度测试工具 (多服务器)\n\n${HELP_TEXT}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    speedlink: speedtest,
    sl: speedtest,
  };
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "speedlink",
    title: "SpeedLink 服务器",
    description: "SpeedLink 服务器连接配置",
    category: "插件配置",
    icon: "🔗",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "name",
            "label": "服务器名称",
            "type": "string"
      },
      {
            "key": "host",
            "label": "主机地址",
            "type": "string"
      },
      {
            "key": "port",
            "label": "端口",
            "type": "number",
            "min": 1,
            "max": 65535,
            "default": 22
      },
      {
            "key": "username",
            "label": "用户名",
            "type": "string"
      },
      {
            "key": "auth_method",
            "label": "认证方式",
            "type": "select",
            "options": [
                  {
                        "value": "password",
                        "label": "密码"
                  },
                  {
                        "value": "key",
                        "label": "密钥"
                  }
            ]
      },
      {
            "key": "credentials",
            "label": "凭据",
            "type": "password",
            "secret": true
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<ServerConfig>(path.join(ASSETS_DIR, "secret.key"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<ServerConfig>(path.join(ASSETS_DIR, "secret.key"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
}

export default new SpeedlinkPlugin();
