// zpr Plugin - 随机纸片人插件
//@ts-nocheck
import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { getGlobalClient, tryGetCurrentGenerationContext } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import { promises as fs } from "fs";
import { JSONFilePreset } from "lowdb/node";
import axios from "axios";

import { htmlEscape } from "@utils/htmlEscape";

// HTML转义（每个插件必须实现）
// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// pixiv反代服务器配置
const PROXY_HOSTS: Record<string, string> = {
    "pximg.net": "i.pximg.net",
    "pixiv.cat": "i.pixiv.cat",
    "pixiv.re": "i.pixiv.re",
    "pixiv.nl": "i.pixiv.nl"
};

const CONFIG_KEYS = {
    PROXY_HOST: "zpr_proxy_host"
};

const DEFAULT_CONFIG = {
    [CONFIG_KEYS.PROXY_HOST]: "i.pximg.net"
};

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.2651.74"
};

const getHeaders = (proxyHost: string) => {
    // 当使用 i.pximg.net 时添加 Referer
    if (proxyHost === "i.pximg.net") {
        return {
            ...baseHeaders,
            "Host": proxyHost,  
            "Referer": "https://www.pixiv.net/"
        };
    }

    return baseHeaders;
};

const dataPath = createDirectoryInAssets("zpr");

async function lifecycleDelay(ms: number, label: string): Promise<void> {
    const lifecycle = tryGetCurrentGenerationContext();
    if (lifecycle) {
        await lifecycle.delay(ms, { label });
        return;
    }
    await new Promise(resolve => setTimeout(resolve, ms));
}

function scheduleAbort(controller: AbortController, ms: number, label: string): () => void {
    const lifecycle = tryGetCurrentGenerationContext();
    if (lifecycle) {
        const handle = lifecycle.setTimeout(() => controller.abort(), ms, { label });
        return () => clearTimeout(handle);
    }

    const handle = setTimeout(() => controller.abort(), ms);
    return () => clearTimeout(handle);
}

// 配置管理器
class ZprConfigManager {
    private static db: any = null;
    private static initialized = false;
    private static configPath: string;
    private static backupPath: string;
    private static isWriting = false;

    private static async init(): Promise<void> {
        if (this.initialized) return;
        try {
            await fs.mkdir(dataPath, { recursive: true });
            this.configPath = path.join(dataPath, "zpr_config.json");
            this.backupPath = path.join(dataPath, "zpr_config.backup.json");
            
            // 尝试从备份恢复损坏的配置
            await this.validateAndRestore();
            
            this.db = await JSONFilePreset<Record<string, any>>(
                this.configPath,
                { ...DEFAULT_CONFIG }
            );
            this.initialized = true;
            console.log("[zpr] 配置初始化成功");
        } catch (error) {
            console.error("[zpr] 初始化配置失败:", error);
            await this.handleInitError();
        }
    }

    private static async validateAndRestore(): Promise<void> {
        try {
            const configExists = await fs.access(this.configPath).then(() => true).catch(() => false);
            if (!configExists) return;

            const configContent = await fs.readFile(this.configPath, 'utf8');
            JSON.parse(configContent); // 验证JSON格式
        } catch (error) {
            console.warn("[zpr] 配置文件损坏，尝试从备份恢复");
            await this.restoreFromBackup();
        }
    }

    private static async restoreFromBackup(): Promise<void> {
        try {
            const backupExists = await fs.access(this.backupPath).then(() => true).catch(() => false);
            if (backupExists) {
                await fs.copyFile(this.backupPath, this.configPath);
                console.log("[zpr] 从备份恢复配置成功");
            }
        } catch (error) {
            console.error("[zpr] 备份恢复失败:", error);
            await this.createDefaultConfig();
        }
    }

    private static async createDefaultConfig(): Promise<void> {
        await fs.writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
        console.log("[zpr] 创建默认配置");
    }

    private static async handleInitError(): Promise<void> {
        this.initialized = false;
        this.db = null;
        await this.createDefaultConfig();
    }

    static cleanup(): void {
        // 引用重置：清空静态 db 和初始化标志，便于 reload 后重新初始化。
        this.db = null;
        this.initialized = false;
        this.isWriting = false;
    }

    static async reinit(): Promise<void> {
        // 强制重新初始化，用于 reload 后的 setup
        this.initialized = false;
        this.db = null;
        await this.init();
    }

    private static async createBackup(): Promise<void> {
        try {
            const configExists = await fs.access(this.configPath).then(() => true).catch(() => false);
            if (configExists) {
                await fs.copyFile(this.configPath, this.backupPath);
                console.log("[zpr] 配置备份创建成功");
            }
        } catch (error) {
            console.warn("[zpr] 创建备份失败:", error);
        }
    }

    private static async writeConfigWithRetry(): Promise<boolean> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await this.db.write();
                console.log("[zpr] 配置保存成功");
                return true;
            } catch (writeError: any) {
                console.error(`[zpr] 第${attempt}次写入失败:`, writeError);
                if (attempt === 5) {
                    // 最后一次失败，尝试恢复备份
                    await this.restoreFromBackup();
                    throw writeError;
                }
                await lifecycleDelay(attempt * 200, "zpr:config-write-retry");
            }
        }
        return false;
    }

    private static async ensureInitialized(): Promise<void> {
        // 插件重新加载时强制重新初始化以从磁盘加载最新配置
        if (!this.initialized || !this.db) {
            await this.init();
        }
    }

    static async getProxyHost(): Promise<string> {
        await this.ensureInitialized();
        if (!this.db) return DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
        return this.db.data[CONFIG_KEYS.PROXY_HOST] || DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
    }

    static async setProxyHost(host: string): Promise<boolean> {
        await this.ensureInitialized();
        if (!this.db) {
            console.error("[zpr] 数据库未初始化");
            return false;
        }

        // 防止并发写入
        if (this.isWriting) {
            console.log("[zpr] 配置正在写入中，请稍后");
            return false;
        }

        this.isWriting = true;
        try {
            // 验证输入参数
            if (!host || typeof host !== 'string') {
                console.error("[zpr] 无效的代理地址");
                return false;
            }

            // 创建备份
            await this.createBackup();

            // 更新配置数据
            this.db.data[CONFIG_KEYS.PROXY_HOST] = host;

            // 写入配置，增强重试机制
            return await this.writeConfigWithRetry();
        } catch (error) {
            console.error("[zpr] 设置代理失败:", error);
            return false;
        } finally {
            this.isWriting = false;
        }
    }
}

// 帮助文本定义
const help_text = `🎨 <b>随机纸片人插件</b>

<b>命令格式：</b>
<code>${mainPrefix}zpr [参数]</code>

<b>可选参数：</b>
• <code>${mainPrefix}zpr</code> - 随机获取1张纸片人图片
• <code>${mainPrefix}zpr [数量]</code> - 获取指定数量图片（1-10）
• <code>${mainPrefix}zpr [标签]</code> - 按标签筛选图片
• <code>${mainPrefix}zpr [标签] [数量]</code> - 按标签获取指定数量
• <code>${mainPrefix}zpr r18</code> - 获取R18内容
• <code>${mainPrefix}zpr r18 [数量]</code> - 获取指定数量R18图片
• <code>${mainPrefix}zpr proxy</code> - 查看当前反代设置
• <code>${mainPrefix}zpr proxy [地址]</code> - 设置反代地址

<b>使用示例：</b>
<code>${mainPrefix}zpr</code> - 随机1张
<code>${mainPrefix}zpr 3</code> - 随机3张
<code>${mainPrefix}zpr 萝莉</code> - 萝莉标签
<code>${mainPrefix}zpr 萝莉 2</code> - 萝莉标签2张

<b>反代地址管理：</b>
<code>${mainPrefix}zpr proxy</code> - 查看当前反代
<code>${mainPrefix}zpr proxy i.pximg.net</code> - 设置为pximg.net
<code>${mainPrefix}zpr proxy i.pixiv.cat</code> - 设置为pixiv.cat
<code>${mainPrefix}zpr proxy i.pixiv.re</code> - 设置为pixiv.re
<code>${mainPrefix}zpr proxy i.pixiv.nl</code> - 设置为pixiv.nl

<b>说明：</b>
• 图片来源：Lolicon API
• 数量限制：1-10张
• 默认反代：i.pximg.net（官方图片服务器，优先推荐）`;

interface SetuData {
    pid: number;
    title: string;
    width: number;
    height: number;
    urls: {
        regular: string;
        original: string;
    };
}

interface ApiResponse {
    data: SetuData[];
}

interface MediaGroup {
    media: string;
    type: string;
    caption?: string;
    hasSpoiler?: boolean;
}

// 辅助函数：编辑HTML消息
const editHtmlMessage = async (msg: Api.Message, text: string) => {
    try {
        await msg.edit({ text, parseMode: "html" });
    } catch (error) {
        console.warn("[zpr] 消息编辑失败:", error);
    }
};

// 辅助函数：处理404错误
const handle404Error = (proxyHost: string, failedProxies: string[]) => {
    failedProxies.push(proxyHost);
    return true; // 表示遇到404错误
};

// 辅助函数：检查是否为超时错误
const isTimeoutError = (error: any): boolean => {
    return error.code === 'ECONNABORTED' || 
           error.message?.includes('timeout') ||
           error.message?.includes('canceled') ||
           error.message?.includes('cancelled') ||
           error.name === 'AbortError' ||
           error.code === 'ETIMEDOUT';
};

interface DownloadResult {
    mediaGroup: MediaGroup | null;
    usedProxy?: string;  // 成功时使用的代理
    failureReason?: 'network' | '404' | 'other';  // 失败原因
    hadNetworkFailures?: boolean;  // 是否在成功前遇到过网络错误
    failedProxies?: string[];  // 失败的代理列表
}

// 单张图片下载函数，包含完整的代理重试逻辑
async function downloadSingleImage(
    item: SetuData, 
    index: number, 
    r18: number, 
    currentProxy: string,
    allProxies: string[]
): Promise<DownloadResult> {
    const { pid, title, width, height, urls } = item;
    const imgName = `${pid}_${index}.jpg`;
    const filePath = path.join(dataPath, imgName);
    
    // 将当前配置的代理放在第一位，其他代理作为备选
    const proxyList = [currentProxy, ...allProxies.filter(proxy => proxy !== currentProxy)];
    
    let lastError: string = "";
    let has404Error = false;
    let hadNetworkFailures = false;  // 跟踪是否遇到过网络错误
    let failedProxies: string[] = [];  // 记录失败的代理
    
    for (const proxyHost of proxyList) {
        try {
            const imgController = new AbortController();
            const clearImgTimeout = scheduleAbort(imgController, 30000, "zpr:image-timeout");
            
            try {
                const imgResponse = await axios.get(urls.regular, {
                    headers: getHeaders(proxyHost),
                    timeout: 30000,
                    responseType: 'arraybuffer',
                    signal: imgController.signal
                });
                
                if (imgResponse.status === 200) {
                    await fs.writeFile(filePath, imgResponse.data as any);
                    
                    return {
                        mediaGroup: {
                            type: 'photo',
                            media: filePath,
                            caption: `<b>🎨 ${htmlEscape(title)}</b>

🆔 <b>作品ID:</b> <a href="https://www.pixiv.net/artworks/${pid}">${pid}</a>
🔗 <b>原图:</b> <a href="${htmlEscape(urls.original)}">高清查看</a>
📐 <b>尺寸:</b> <code>${width}×${height}</code>

<i>📡 来源: Pixiv</i>`,
                            hasSpoiler: r18 === 1
                        },
                        usedProxy: proxyHost,
                        hadNetworkFailures: hadNetworkFailures,  // 报告是否之前有网络错误
                        failedProxies: failedProxies  // 报告失败的代理
                    };
                } else if (imgResponse.status === 404) {
                    has404Error = handle404Error(proxyHost, failedProxies);
                    continue; // 尝试下一个代理
                } else {
                    lastError = `HTTP ${imgResponse.status}`;
                    failedProxies.push(proxyHost);
                    continue; // 尝试下一个代理
                }
            } finally {
                clearImgTimeout();
            }
            
        } catch (error: any) {
            if (error.response && error.response.status === 404) {
                has404Error = handle404Error(proxyHost, failedProxies);
                continue; // 尝试下一个代理
            }
            
            // 检查是否为超时错误
            if (isTimeoutError(error)) {
                lastError = `连接超时: ${error.message}`;
                hadNetworkFailures = true;  // 标记遇到了网络错误
                failedProxies.push(proxyHost);
            } else {
                lastError = error.message;
                hadNetworkFailures = true;  // 其他网络错误也标记
                failedProxies.push(proxyHost);
            }
            // 所有网络错误（包括超时）都尝试下一个代理
            continue;
        }
    }
    
    // 所有代理都尝试失败了
    if (has404Error) {
        return { mediaGroup: null, failureReason: '404', failedProxies: failedProxies };
    } else {
        // 超时、连接失败等都归类为网络问题
        return { mediaGroup: null, failureReason: 'network', failedProxies: failedProxies };
    }
}

async function getResult(message: Api.Message, r18 = 0, tag = "", num = 1): Promise<[MediaGroup[] | null, string]> {
    const client = await getGlobalClient();
    if (!client) {
        return [null, "❌ 客户端未初始化"];
    }
    
    const des = "出错了，没有纸片人看了。";
    
    // 获取所有可用的代理主机
    const allProxies = Object.values(PROXY_HOSTS);
    const currentProxy = await ZprConfigManager.getProxyHost();
    
    try {
        await editHtmlMessage(message, `🔄 正在连接API...`);
        
        // 直接调用API，使用当前配置的代理参数
        const controller = new AbortController();
        const clearApiTimeout = scheduleAbort(controller, 10000, "zpr:api-timeout");
        
        let response;
        try {
            response = await axios.get(
                `https://api.lolicon.app/setu/v2?num=${num}&r18=${r18}&tag=${tag}&size=regular&size=original&proxy=${currentProxy}&excludeAI=true`,
                {
                    headers: baseHeaders,
                    timeout: 10000,
                    signal: controller.signal
                }
            );
        } finally {
            clearApiTimeout();
        }
        
        if (response.status !== 200) {
            return [null, `API请求失败: HTTP ${response.status}`];
        }
        
        await editHtmlMessage(message, "🔍 已进入二次元 . . .");
        
        const result: SetuData[] = (response.data as ApiResponse).data;
        if (!result.length) {
            return [null, "未找到符合条件的图片"];
        }
        
        await editHtmlMessage(message, "📥 努力获取中 。。。");
        
        // 并发下载所有图片，每张图片都有自己的代理重试机制
        const downloadPromises = result.slice(0, num).map((item, index) => 
            downloadSingleImage(item, index, r18, currentProxy, allProxies)
        );
        
        const downloadResults = await Promise.all(downloadPromises);
        
        // 统计下载结果
        const successfulDownloads = downloadResults
            .filter(result => result.mediaGroup !== null)
            .map(result => result.mediaGroup!);
            
        const failedCount = downloadResults.length - successfulDownloads.length;
        const networkFailures = downloadResults.filter(result => result.failureReason === 'network').length;
        const error404Count = downloadResults.filter(result => result.failureReason === '404').length;
        
        // 计算有网络错误经历的图片数量（包括最终成功的）
        const imagesWithNetworkIssues = downloadResults.filter(result => 
            result.failureReason === 'network' || result.hadNetworkFailures
        ).length;
        
        if (successfulDownloads.length === 0) {
            if (networkFailures > 0) {
                return [null, "所有图片下载失败（网络连接问题，已尝试所有代理）"];
            } else {
                return [null, "所有图片下载失败（图片不存在）"];
            }
        }
        
        // 智能代理配置更新逻辑（仅基于图片下载成功率）
        let shouldUpdateProxy = false;
        let reasonForUpdate = "";
        let bestProxy = "";
        
        if (imagesWithNetworkIssues > 0) {
            // 只要有图片遇到网络问题（即使最终成功），就检查是否有更好的代理
            const nonDefaultSuccesses = downloadResults.filter(result => 
                result.mediaGroup !== null && result.usedProxy !== currentProxy
            );
            
            if (nonDefaultSuccesses.length > 0) {
                // 找到最常用的非默认代理
                const proxyUsage: Record<string, number> = {};
                nonDefaultSuccesses.forEach(result => {
                    const proxy = result.usedProxy!;
                    proxyUsage[proxy] = (proxyUsage[proxy] || 0) + 1;
                });
                
                bestProxy = Object.entries(proxyUsage)
                    .sort(([,a], [,b]) => b - a)[0][0];
                    
                shouldUpdateProxy = true;
                reasonForUpdate = "图片下载成功率";
            }
        }
        
        if (shouldUpdateProxy) {
            try {
                await editHtmlMessage(message, `📡 更新默认代理为: ${bestProxy}`);
                await ZprConfigManager.setProxyHost(bestProxy);
                console.log(`[zpr] 已切换到更稳定的代理: ${bestProxy}`);
            } catch (err) {
                console.warn(`[zpr] 更新默认代理失败:`, err);
            }
        }
        
        console.log(`[zpr] 成功下载 ${successfulDownloads.length}/${result.length} 张图片`);
        return [successfulDownloads, des];
        
    } catch (error: any) {
        console.error("[zpr] API请求失败:", error);
        return [null, `API请求失败: ${error.message || "未知错误"}`];
    }
}

class ZprPlugin extends Plugin {
  cleanup(): void {
    // 引用重置：清空 ZprConfigManager 的静态引用，便于 reload 后重新初始化。
    ZprConfigManager.cleanup();
  }

  async setup(): Promise<void> {
    // 重新初始化配置管理器，确保 reload 后可用
    await ZprConfigManager.reinit();
  }

    description = `随机纸片人插件\n\n${help_text}`;
    
    cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
        zpr: async (msg: Api.Message): Promise<void> => {
            try {
                const client = await getGlobalClient();
                if (!client) {
                    await editHtmlMessage(msg, "❌ 客户端未初始化");
                    return;
                }

                // 标准参数解析
                const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
                const parts = lines?.[0]?.split(/\s+/) || [];
                const [, ...args] = parts;
                const sub = (args[0] || "").toLowerCase();

                // 处理帮助命令
                if (sub === "help" || sub === "h" || 
                    (args.length > 1 && (args[args.length - 1].toLowerCase() === "help" || args[args.length - 1].toLowerCase() === "h"))) {
                    await editHtmlMessage(msg, help_text);
                    return;
                }

                // 处理 proxy 子命令
                if (sub === "proxy") {
                    if (args.length === 1) {
                        // 查看当前反代设置
                        const currentProxy = await ZprConfigManager.getProxyHost();
                        await editHtmlMessage(msg, `🔗 <b>当前反代设置</b>

<b>当前地址:</b> <code>${htmlEscape(currentProxy)}</code>

<b>可用地址:</b>
${Object.entries(PROXY_HOSTS).map(([key, value]) => 
`• <code>${htmlEscape(value)}</code> - ${htmlEscape(key)}`).join('\n')}

<b>使用方法:</b>
<code>${mainPrefix}zpr proxy [地址]</code> - 设置反代地址`);
                        return;
                    }
                    
                    // 设置反代地址
                    const newProxy = args[1];
                    const validHosts = Object.values(PROXY_HOSTS);
                    
                    if (!validHosts.includes(newProxy)) {
                        await editHtmlMessage(msg, `❌ <b>无效的反代地址</b>

<b>可用地址:</b>
${Object.entries(PROXY_HOSTS).map(([key, value]) => 
`• <code>${value}</code> - ${key}`).join('\n')}`);
                        return;
                    }
                    
                    const success = await ZprConfigManager.setProxyHost(newProxy);
                    if (success) {
                        await editHtmlMessage(msg, `✅ <b>反代地址已更新</b>

<b>新地址:</b> <code>${htmlEscape(newProxy)}</code>

设置已保存，下次获取图片时将使用新的反代地址。`);
                    } else {
                        await editHtmlMessage(msg, "❌ <b>设置失败</b>\n\n无法保存配置，请稍后重试。");
                    }
                    return;
                }
            
                // 解析参数
                let num = 1;
                let r18 = 0;
                let tag = "";
                
                if (args.length > 0) {
                    if (!isNaN(Number(args[0]))) {
                        num = Math.min(Math.max(1, Number(args[0])), 10);
                    } else if (args[0] === "r18") {
                        r18 = 1;
                        if (args.length > 1 && !isNaN(Number(args[1]))) {
                            num = Math.min(Math.max(1, Number(args[1])), 10);
                        }
                    } else if (args[0] !== "proxy") {
                        tag = args[0];
                        if (args.length > 1) {
                            if (!isNaN(Number(args[1]))) {
                                num = Math.min(Math.max(1, Number(args[1])), 10);
                            } else if (args[1] === "r18") {
                                r18 = 1;
                                if (args.length > 2 && !isNaN(Number(args[2]))) {
                                    num = Math.min(Math.max(1, Number(args[2])), 10);
                                }
                            }
                        }
                    }
                }

                await editHtmlMessage(msg, "🔄 正在前往二次元。。。");

                const [photoList, des] = await getResult(msg, r18, tag, num);
                
                if (!photoList) {
                    await editHtmlMessage(msg, `❌ <b>获取失败:</b> ${htmlEscape(des)}`);
                    return;
                }
                
                try {
                    await editHtmlMessage(msg, "📤 传送中。。。");
                } catch {}
                
                try {
                    // 逐个发送图片文件
                    for (const item of photoList) {
                        try {
                            const stat = await fs.stat(item.media);
                            const toUpload = new CustomFile(
                                path.basename(item.media),
                                stat.size,
                                item.media
                            );

                            const uploaded = await client.uploadFile({
                                file: toUpload,
                                workers: 1
                            });

                            await client.sendFile(msg.peerId, {
                                file: new Api.InputMediaUploadedPhoto({
                                    file: uploaded,
                                    spoiler: item.hasSpoiler
                                }),
                                caption: item.caption,
                                parseMode: 'html',
                                replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId
                            });

                        } catch (error: any) {
                            const errorMsg = error.message?.includes("CHAT_SEND_MEDIA_FORBIDDEN")
                                ? "此群组不允许发送媒体。"
                                : htmlEscape(`发送失败: ${error.message || "未知错误"}`);
                            
                            await editHtmlMessage(msg, `❌ <b>发送失败:</b> ${errorMsg}`);
                            throw error; // 继续抛出错误以中断循环
                        } finally {
                            // 无论发送是否成功，都尝试清理临时文件
                            try {
                                await fs.unlink(item.media);
                                console.log(`[zpr] 成功清理临时文件: ${item.media}`);
                            } catch (err: unknown) {
                                console.warn(`[zpr] 清理图片文件失败: ${item.media}`, err);
                            }
                        }
                    }

                    try {
                        await msg.delete({ revoke: true });
                    } catch {}
                } catch (error: any) {
                    console.error("[zpr] 插件执行失败:", error);
                    await editHtmlMessage(msg, `❌ <b>插件执行失败:</b> ${htmlEscape(error.message || "未知错误")}`);
                }
            } catch (error: any) {
                console.error("[zpr] 插件执行失败:", error);
                await editHtmlMessage(msg, `❌ <b>插件执行失败:</b> ${htmlEscape(error.message || "未知错误")}`);
            }
        }
    };

  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
        id: "zpr",
        title: "随机纸片人",
        description: "Lolicon API 图片获取：配置反代服务器",
        category: "插件配置",
        icon: "🎨",
        getSchema: (): PanelSettingField[] => [
            {
                key: "zpr_proxy_host",
                label: "反代服务器",
                type: "select",
                options: [
                    { value: "i.pximg.net", label: "官方 (i.pximg.net)" },
                    { value: "i.pixiv.cat", label: "pixiv.cat" },
                    { value: "i.pixiv.re", label: "pixiv.re" },
                    { value: "i.pixiv.nl", label: "pixiv.nl" },
                ],
                default: "i.pximg.net",
                description: "图片下载代理，默认官方 i.pximg.net",
            },
        ],
        getValues: async () => {
            const currentProxy = await ZprConfigManager.getProxyHost();
            return { zpr_proxy_host: currentProxy };
        },
        setValues: async (patch: Record<string, unknown>) => {
            if (typeof patch.zpr_proxy_host === "string") {
                await ZprConfigManager.setProxyHost(patch.zpr_proxy_host);
            }
        },
    };
}

export default new ZprPlugin();
