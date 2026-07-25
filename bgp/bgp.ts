import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { Api } from "teleproto";
import axios from "axios";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import * as cheerio from "cheerio";

import { htmlEscape } from "@utils/htmlEscape";

const BGP_COMMON_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.112 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Referer": "https://bgp.tools/",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua":
        "\"Chromium\";v=\"122\", \"Google Chrome\";v=\"122\", \"Not=A?Brand\";v=\"99\"",
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"Windows\"",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-Fetch-Dest": "document",
    "Dnt": "1",
    "Sec-Gpc": "1",
    "Pragma": "no-cache",
};

function isValidIPv4(ip: string): boolean {
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => {
        const n = Number(p);
        return Number.isInteger(n) && n >= 0 && n <= 255;
    });
}

function networkAddress(ip: string, mask: number): string | null {
    if (!isValidIPv4(ip)) return null;

    const parts = ip.split(".").map((p) => Number(p));
    const ipNum =
        (((parts[0] << 24) |
            (parts[1] << 16) |
            (parts[2] << 8) |
            parts[3]) >>> 0);

    const maskNum = mask === 0 ? 0 : ((~0 << (32 - mask)) >>> 0);
    const netNum = ipNum & maskNum;

    const netParts = [
        (netNum >>> 24) & 255,
        (netNum >>> 16) & 255,
        (netNum >>> 8) & 255,
        netNum & 255,
    ];

    return `${netParts.join(".")}/${mask}`;
}

function normalizeIP(input: string): string | null {
    const clean = input.trim();
    if (!clean || clean.includes("/")) return null;
    const m = clean.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (!m) return null;
    const ip = m[1];
    if (!isValidIPv4(ip)) return null;
    return ip;
}

function extractIPFromText(text: string): string | null {
    const cidrLike = /(\d{1,3}(?:\.\d{1,3}){3})\/\d{1,2}/;
    const m1 = cidrLike.exec(text);
    if (m1) {
        const ip = normalizeIP(m1[1]);
        if (ip) return ip;
    }

    const ipRegex = /(\d{1,3}(?:\.\d{1,3}){3})/;
    const m2 = ipRegex.exec(text);
    if (m2) {
        const ip = normalizeIP(m2[1]);
        if (ip) return ip;
    }

    return null;
}

function isPlaceholderSvg(svgText: string): boolean {
    return svgText.includes("Not_Visible") && svgText.includes("in_DFZ");
}

type BgpFetchResult =
    | { status: "ok"; svgBuffer: Buffer; usedPrefix: string }
    | { status: "placeholder"; usedPrefix: string | null }
    | { status: "none" };

async function fetchBgpSvgWithFallback(ip: string): Promise<BgpFetchResult> {
    if (!isValidIPv4(ip)) return { status: "none" };

    const prefixesToTry: string[] = [];
    const p24 = networkAddress(ip, 24);
    if (p24) prefixesToTry.push(p24);
    const p23 = networkAddress(ip, 23);
    if (p23 && p23 !== p24) prefixesToTry.push(p23);

    let placeholderPrefix: string | null = null;

    for (const prefix of prefixesToTry) {
        const urlIP = prefix.replace("/", "_");
        const url = `https://bgp.tools/pathimg/rt-${urlIP}?4c1db184-e649-4491-8b7f-06177bcb4f25&loggedin`;

        try {
            const response = await axios.get(url, {
                headers: BGP_COMMON_HEADERS,
                responseType: "arraybuffer",
                timeout: 15000,
            });

            const svgBuffer = Buffer.from(response.data);
            const svgText = svgBuffer.toString("utf-8");

            if (isPlaceholderSvg(svgText)) {
                placeholderPrefix = prefix;
                continue;
            }

            return { status: "ok", svgBuffer, usedPrefix: prefix };
        } catch (err: any) {
            if (err.response?.status === 404) continue;
            continue;
        }
    }

    if (placeholderPrefix) {
        return { status: "placeholder", usedPrefix: placeholderPrefix };
    }

    return { status: "none" };
}

async function fetchDnsWithFallback(ip: string): Promise<{ dnsLines: string[]; usedPrefix: string }> {
    if (!isValidIPv4(ip)) {
        throw new Error("无效的IP地址");
    }

    const prefixesToTry: string[] = [];
    const p24 = networkAddress(ip, 24);
    if (p24) prefixesToTry.push(p24);
    const p23 = networkAddress(ip, 23);
    if (p23 && p23 !== p24) prefixesToTry.push(p23);

    for (const prefix of prefixesToTry) {
        const url = `https://bgp.tools/prefix/${prefix}#dns`;

        try {
            const response = await axios.get(url, {
                headers: BGP_COMMON_HEADERS,
                timeout: 15000,
            });

            const dnsResult = extractDNSData(response.data);

            if (dnsResult.dnsLines.length > 0) {
                return { dnsLines: dnsResult.dnsLines, usedPrefix: prefix };
            }
        } catch (err: any) {
            if (err.response?.status === 404) continue;
            continue;
        }
    }

    throw new Error("未找到DNS记录");
}

function extractTopLevelDomain(domain: string): string {
    const parts = domain.split(".");
    if (parts.length >= 2) return parts.slice(-2).join(".");
    return domain;
}

function extractDNSData(html: string): {
    dnsLines: string[];
    totalRecords: number;
    filteredRecords: number;
} {
    const dnsLines: string[] = [];
    const ipDomainMap = new Map<string, string[]>();
    const domainRecords: Array<{ ip: string; domain: string; topLevelDomain: string }> = [];

    try {
        const $ = cheerio.load(html);
        const allText = $.text();

        const ipDomainPattern =
            /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

        let match: RegExpExecArray | null;
        while ((match = ipDomainPattern.exec(allText)) !== null) {
            const ip = match[1];
            const domain = match[2];
            const top = extractTopLevelDomain(domain);

            domainRecords.push({ ip, domain, topLevelDomain: top });
            if (!ipDomainMap.has(ip)) ipDomainMap.set(ip, []);
            ipDomainMap.get(ip)!.push(domain);
        }

        const domainCount = new Map<string, number>();
        domainRecords.forEach((r) => {
            domainCount.set(r.topLevelDomain, (domainCount.get(r.topLevelDomain) || 0) + 1);
        });

        const filtered = new Set<string>();
        domainCount.forEach((count, dom) => {
            if (count > 2) filtered.add(dom);
        });

        ipDomainMap.forEach((domains, ip) => {
            domains.forEach((domain) => {
                const top = extractTopLevelDomain(domain);
                if (!filtered.has(top)) dnsLines.push(`${ip}\t${domain}`);
            });
        });

        return {
            dnsLines,
            totalRecords: domainRecords.length,
            filteredRecords: domainRecords.length - dnsLines.length,
        };
    } catch {
        return { dnsLines: [], totalRecords: 0, filteredRecords: 0 };
    }
}

async function resolveTargetIP(
    args: string[],
    msg: Api.Message,
    trigger?: Api.Message,
): Promise<string | null> {
    const rawInput = args.join(" ").trim();

    if (rawInput) {
        const ipFromArgs = extractIPFromText(rawInput);
        if (ipFromArgs) return ipFromArgs;
    }

    if (trigger?.message) {
        const ipFromTrigger = extractIPFromText(trigger.message);
        if (ipFromTrigger) return ipFromTrigger;
    }

    if (msg.replyTo) {
        const r = await msg.getReplyMessage();
        if (r?.message) {
            const ipFromReply = extractIPFromText(r.message);
            if (ipFromReply) return ipFromReply;
        }
    }

    return null;
}

class BGPPlugin extends Plugin {
    name = "bgp";

    description =
        "\n🌐 BGP路由图查询工具\n" +
        "\n• <code>.bgp &lt;IP&gt;</code> - 查询指定IP的BGP路由图\n" +
        "• <code>.bgp</code> - 回复包含IP的消息自动查询BGP路由图\n" +
        "• <code>.bgp dns &lt;IP&gt;</code> - 查询指定IP的DNS解析记录\n" +
        "• <code>.bgp dns</code> - 回复包含IP的消息查询DNS解析记录";

    cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
        bgp: async (msg, trigger) => {

            const client = await getGlobalClient();
            if (!client) {
                await msg.edit({ text: "❌ 客户端未初始化" });
                return;
            }

            if (!client.connected) {
                try {
                    await msg.edit({ text: "🔄 正在连接 Telegram..." });
                    await client.connect();
                    if (!client.connected) throw new Error("连接失败");
                } catch (err: any) {
                    await msg.edit({
                        text:
                            `❌ <b>连接失败</b>\n\n${htmlEscape(err.message)}\n\n请检查:\n• 网络连接\n• API 凭据\n• 代理设置`,
                        parseMode: "html",
                    });
                    return;
                }
            }

            let msgDeleted = false;

            try {
                let targetIP: string | null = null;
                const rawArgs = msg.message.split(" ").slice(1);

                if (rawArgs[0] === "dns") {
                    const dnsArgs = rawArgs.slice(1);
                    targetIP = await resolveTargetIP(dnsArgs, msg, trigger);

                    if (!targetIP) {
                        await msg.edit({
                            text:
                                `❌ 请提供有效的IP地址\n\n支持的格式:\n` +
                                `• .bgp dns 1.1.1.1\n` +
                                `• .bgp dns 1.1.1.0/24\n` +
                                `• 回复包含IP的消息使用 .bgp dns`,
                            parseMode: "html",
                        });
                        return;
                    }

                    await msg.edit({ text: `🔍 正在查询DNS解析记录...`, parseMode: "html" });

                    try {
                        const result = await fetchDnsWithFallback(targetIP);

                        let output = "A\tDNS\n";
                        output += result.dnsLines.join("\n");

                        const formattedOutput =
                            `<blockquote expandable>${output}</blockquote>\n\n` +
                            `🌐 <b>DNS解析记录</b>\n\n` +
                            `<code>${htmlEscape(targetIP)}</code>\n` +
                            `<i>使用前缀: ${htmlEscape(result.usedPrefix)}</i>\n\n` +
                            `⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`;

                        await msg.edit({ text: formattedOutput, parseMode: "html" });

                    } catch (err: any) {
                        const message = err?.message || "";

                        if (message.includes("未找到DNS记录")) {
                            const prefixForLink =
                                networkAddress(targetIP, 24) || `${targetIP}/24`;

                            await msg.edit({
                                text:
                                    `❌ <b>未找到DNS解析记录</b>\n\n` +
                                    `请确认该前缀是否在公网上有宣告或有可见的 DNS 记录\n\n` +
                                    `🔗 直达链接: https://bgp.tools/prefix/${htmlEscape(prefixForLink)}#dns`,
                                parseMode: "html",
                            });
                        } else {
                            await msg.edit({
                                text:
                                    `❌ <b>DNS查询失败</b>\n\n${htmlEscape(message || "未知错误")}`,
                                parseMode: "html",
                            });
                        }
                    }

                    return;
                }

                targetIP = await resolveTargetIP(rawArgs, msg, trigger);

                if (!targetIP) {
                    await msg.edit({
                        text:
                            `❌ 请提供有效的IP地址\n\n支持的格式:\n` +
                            `• .bgp 1.1.1.1\n` +
                            `• .bgp 1.1.1.0/24\n` +
                            `• 回复包含IP的消息使用 .bgp`,
                        parseMode: "html",
                    });
                    return;
                }

                await msg.edit({ text: `🔍 正在生成BGP路由图...`, parseMode: "html" });

                const tempDir = createDirectoryInTemp("bgp_images");
                if (!tempDir) throw new Error("无法创建临时目录");

                const fileIP = targetIP;
                const svgFileName = `bgp-${fileIP}.svg`;
                const pngFileName = `bgp-${fileIP}.png`;
                const svgPath = path.join(tempDir, svgFileName);
                const pngPath = path.join(tempDir, pngFileName);

                try {
                    const result = await fetchBgpSvgWithFallback(targetIP);

                    if (result.status === "ok") {
                        fs.writeFileSync(svgPath, result.svgBuffer);

                        await sharp(svgPath, { density: 300 })
                            .resize({
                                width: 2400,
                                height: 1800,
                                fit: "inside",
                                withoutEnlargement: false,
                            })
                            .png({
                                quality: 95,
                                compressionLevel: 6,
                                adaptiveFiltering: true,
                                palette: true,
                            })
                            .sharpen({ sigma: 1.2, flat: 1.0, jagged: 2.0 })
                            .toFile(pngPath);

                        try {
                            await msg.delete();
                            msgDeleted = true;
                        } catch {}

                        await client.sendFile(msg.chatId!, {
                            file: pngPath,
                            caption:
                                `🌐 <b>BGP路由图</b>\n\n` +
                                `<code>${htmlEscape(targetIP)}</code>\n` +
                                `<i>使用前缀: ${htmlEscape(result.usedPrefix)}</i>\n\n` +
                                `⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
                            parseMode: "html",
                        });

                    } else if (result.status === "placeholder") {
                        const prefixForLink =
                            result.usedPrefix ||
                            networkAddress(targetIP, 24) ||
                            `${targetIP}/24`;

                        await msg.edit({
                            text:
                                `❌ <b>没有可用的BGP路由图</b>\n\n` +
                                `当前前缀 <code>${htmlEscape(prefixForLink)}</code> 在 DFZ 中不可见或没有路径数据\n\n` +
                                `🔗 直达链接: https://bgp.tools/prefix/${htmlEscape(prefixForLink)}`,
                            parseMode: "html",
                        });

                    } else {
                        const prefixForLink =
                            networkAddress(targetIP, 24) || `${targetIP}/24`;

                        await msg.edit({
                            text:
                                `❌ <b>未找到可用的BGP路由图</b>\n\n` +
                                `请确认该前缀是否在公网上有宣告\n\n` +
                                `🔗 直达链接: https://bgp.tools/prefix/${htmlEscape(prefixForLink)}`,
                            parseMode: "html",
                        });
                    }

                } finally {
                    try {
                        if (fs.existsSync(svgPath)) fs.unlinkSync(svgPath);
                        if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
                    } catch {}
                }

            } catch (err: any) {
                const errText = `❌ <b>BGP查询失败</b>\n\n${htmlEscape(err.message || "未知错误")}`;
                try {
                    if (msgDeleted) {
                        await client.sendMessage(msg.chatId!, { message: errText, parseMode: "html" });
                    } else {
                        await msg.edit({ text: errText, parseMode: "html" });
                    }
                } catch {}
            }
        },
    };

    cleanup(): void {}
}

export default new BGPPlugin();
