import { Plugin, type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase"; import { getPrefixes } from "@utils/pluginManager"; import { Api } from "teleproto"; import * as fs from "fs/promises"; import path from "path"; import axios from "axios"; import { createDirectoryInAssets } from "@utils/pathHelpers";  
import { JSONFilePreset } from "lowdb/node";

const pfx = getPrefixes(); const mp = pfx[0];
const DD = createDirectoryInAssets("checkapi"); const KF = path.join(DD, "keys.json");

// ── Types ──
interface SK { name: string; key: string; baseUrl?: string; provider?: string; addedAt: number; }
interface PI { provider: string; displayName: string; baseUrl: string; chatUrl: string; modelsUrl?: string; balanceUrl?: string; confidence: "high"|"medium"|"low"; headers: Record<string,string>; authHeader: string; }
interface AR { ok: boolean; data?: unknown; status?: number; error?: string; headers?: Record<string,string>; elapsedMs?: number; }
interface CTR { ok: boolean; text?: string; model?: string; usage?: {prompt:number;completion:number;total:number}; elapsedMs?: number; error?: string; headers?: Record<string,string>; }

// ── Persistence ──
async function lk(): Promise<SK[]> { try { await fs.mkdir(DD,{recursive:true}); return JSON.parse(await fs.readFile(KF,"utf8")); } catch { return []; } }
async function sk(k: SK[]): Promise<void> { await fs.mkdir(DD,{recursive:true}); await fs.writeFile(KF,JSON.stringify(k,null,2),"utf8"); }
function mk(k: string): string { return k.length<=8?"***":k.slice(0,7)+"..."+k.slice(-4); }
function isUrl(s: string): boolean { return /^(https?:\/\/|.+\.[a-z]{2,}(?:\/|$|:\d+)|.+\/v\d)/i.test(s)||s.includes("://"); }
function nu(s: string): string { let u=s.trim(); if(!/^https?:\/\//i.test(u))u="https://"+u; return u.replace(/\/+$/,""); }
/** Join OpenAI-compatible base + path; auto-insert /v1 when base is host root. */
function jp(base:string, pathSeg:string):string{
  let b=base.replace(/\/+$/,"");
  let seg=pathSeg.startsWith("/")?pathSeg:"/"+pathSeg;
  if(/\/v1$/i.test(b) && /^\/v1(\/|$)/i.test(seg)) b=b.replace(/\/v1$/i,"");
  const needsV1=/^\/(chat\/completions|models)(\/|$|\?)/.test(seg);
  const hasVer=/\/(v1beta|v\d+|openai|inference|v2)(\/|$)/i.test(b);
  if(needsV1 && !hasVer) return b+"/v1"+seg;
  return b+seg;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ge(e:unknown):string{const o=e as any; return String(o?.message||o?.stderr||e||"未知错误");}
function htmlEscape(s:string):string{return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
function fh(h?:Record<string,string>):string{if(!h||!Object.keys(h).length)return "";const l:string[]=[];for(const[k,v]of Object.entries(h)){l.push(`  ⚡ ${htmlEscape(k.replace(/-/g," "))}: ${htmlEscape(v)}`);}return l.join("\n");}

// ── Smart input parser: curl / env / json ──
function parseCurl(s: string): { key?: string; url?: string } | null {
  const u = s.match(/(?:-H\s+['"]?(?:Authorization|X-API-Key|x-api-key|api-key):?\s*(?:Bearer\s+)?)([^\s'"]+)/i);
  const url = s.match(/(?:curl\s+(?:-X\s+\w+\s+)?['"]?)?(https?:\/\/[^\s'"]+)/i);
  if (u && url) return { key: u[1], url: url[1] };
  return null;
}
function parseEnv(s: string): { key?: string } | null {
  const m = s.match(/^(?:export\s+)?(\w*API[\s_]*(?:KEY|TOKEN|SECRET)\w*)\s*=\s*['"]?([^\s'"]+)['"]?$/im);
  if (m) return { key: m[2] };
  return null;
}

// ── Smart input parser v2: any-order URL+key detection ──
function parseSmart(raw:string):{sub?:string;key?:string;url?:string;label?:string;rest:string[]}{
  const tokens=raw.split(/\s+/).filter(Boolean);
  if(!tokens.length)return{rest:[]};
  const r:{sub?:string;key?:string;url?:string;label?:string;rest:string[]}={rest:[]};
  const subs=new Set(["models","ask","speed","compare","save","list","del","check","help","delete"]);
  const used=new Set<number>();
  for(let i=0;i<tokens.length;i++){
    const t=tokens[i];const tl=t.toLowerCase();
    if(subs.has(tl)&&!r.sub){r.sub=tl;used.add(i);continue;}
    if(/^(https?:\/\/|.+\.[a-z]{2,}(?:\/|$|:\d+)|.+\/v\d)/i.test(t)||t.includes("://")){if(!r.url){r.url=t;used.add(i);}continue;}
    if(/^sk-(?:ant-|or-v1-)?|^gsk_|^tgp_|^pplx-|^r8_|^fw_|^xai-|^AIza|^co-|^hf_|^nvapi-/i.test(t)){if(!r.key){r.key=t;used.add(i);}continue;}
    if(/^[a-zA-Z0-9_.\-]{24,}$/.test(t)&&!r.key){r.key=t;used.add(i);continue;}
  }
  for(let i=0;i<tokens.length;i++){
    if(used.has(i))continue;
    const t=tokens[i];
    if(/^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/\S*)?$/.test(t)&&!r.url){r.url=t;used.add(i);break;}
  }
  for(let i=0;i<tokens.length;i++){if(!used.has(i))r.rest.push(tokens[i]);}
  return r;
}

// ── Provider detection (enhanced) ──
function dp(key: string, baseUrl?: string): PI {
  const t = key.trim();

  // ── URL hostname detection (before key-based) ──
  if (baseUrl) {
    const u = baseUrl.replace(/\/+$/,"");
    const host = (()=>{try{return new URL(u).hostname;}catch{return u;}})();
    const h: Record<string,string> = {};
    // Smart provider detection from hostname
    if (host.includes("openrouter")) {
      h["HTTP-Referer"] = "https://t.me/telebox_next";
      return {provider:"openrouter",displayName:`OpenRouter (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),balanceUrl:`${u.replace(/\/api\/v1.*$/,"")}/api/v1/auth/key`,confidence:"high",headers:h,authHeader:`Bearer ${t}`};
    }
    if (host.includes("groq")) return {provider:"groq",displayName:`Groq (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("together")) return {provider:"together",displayName:`Together AI (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("mistral")) return {provider:"mistral",displayName:`Mistral (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("cohere")) return {provider:"cohere",displayName:`Cohere (${host})`,baseUrl:u,chatUrl:u.includes("/v2")?`${u}/chat`:`${u}/v2/chat`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("perplexity")) return {provider:"perplexity",displayName:`Perplexity (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("fireworks")) return {provider:"fireworks",displayName:`Fireworks (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("replicate")) return {provider:"replicate",displayName:`Replicate (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("siliconflow")) return {provider:"siliconflow",displayName:`SiliconFlow (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:{},authHeader:`Bearer ${t}`};if (host.includes("nvidia")||host.includes("nim")) return {provider:"nvidia",displayName:`NVIDIA NIM (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:{},authHeader:`Bearer ${t}`};if (host.includes("novita")) return {provider:"novita",displayName:`Novita (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:{},authHeader:`Bearer ${t}`};if (host.includes("cerebras")) return {provider:"cerebras",displayName:`Cerebras (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};if (host.includes("azure")||host.includes("openai.azure")) return {provider:"azure",displayName:`Azure OpenAI (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions?api-version=2024-10-21`,modelsUrl:`${u}/models?api-version=2024-10-21`,confidence:"high",headers:{"api-key":t},authHeader:""};if (host.includes("vercel")) return {provider:"vercel",displayName:`Vercel AI Gateway (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("deepinfra")) return {provider:"deepinfra",displayName:`DeepInfra (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("localhost")||host.includes("127.0.0.1")||host.includes("ollama")) return {provider:"ollama",displayName:`Ollama (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/tags`,confidence:"high",headers:{},authHeader:""};
    if (host.includes("generativelanguage")||host.includes("googleapis")) return {provider:"gemini",displayName:`Gemini (${host})`,baseUrl:u,chatUrl:`${u}/v1beta/models/gemini-2.5-flash:generateContent`,modelsUrl:`${u}/v1beta/models`,confidence:"high",headers:{},authHeader:""};
    if (host.includes("anthropic")) return {provider:"anthropic",displayName:`Anthropic (${host})`,baseUrl:u,chatUrl:`${u}/v1/messages`,modelsUrl:`${u}/v1/models`,confidence:"high",headers:{"x-api-key":t,"anthropic-version":"2023-06-01","content-type":"application/json"},authHeader:""};
    if (host.includes("deepseek")) return {provider:"deepseek",displayName:`DeepSeek (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),balanceUrl:`${u.replace(/\/v\d.*$/,"")}/user/balance`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("x.ai")) return {provider:"xai",displayName:`xAI (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    // Generic OpenAI-compatible fallback
    return {provider:"custom",displayName:`自定义 (${host})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"medium",headers:h,authHeader:`Bearer ${t}`};
  }

  // ── Key prefix detection ──
  if (/^sk-ant-/i.test(t)) return {provider:"anthropic",displayName:"Anthropic",baseUrl:"https://api.anthropic.com",chatUrl:"https://api.anthropic.com/v1/messages",modelsUrl:"https://api.anthropic.com/v1/models",confidence:"high",headers:{"x-api-key":t,"anthropic-version":"2023-06-01","content-type":"application/json"},authHeader:""};
  if (/^sk-or-v1-/i.test(t)) return {provider:"openrouter",displayName:"OpenRouter",baseUrl:"https://openrouter.ai/api/v1",chatUrl:"https://openrouter.ai/api/v1/chat/completions",modelsUrl:"https://openrouter.ai/api/v1/models",balanceUrl:"https://openrouter.ai/api/v1/auth/key",confidence:"high",headers:{"HTTP-Referer":"https://t.me/telebox_next"},authHeader:`Bearer ${t}`};
  if (/^gsk_/i.test(t)) return {provider:"groq",displayName:"Groq",baseUrl:"https://api.groq.com/openai/v1",chatUrl:"https://api.groq.com/openai/v1/chat/completions",modelsUrl:"https://api.groq.com/openai/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^tgp_|^together/i.test(t)) return {provider:"together",displayName:"Together AI",baseUrl:"https://api.together.xyz/v1",chatUrl:"https://api.together.xyz/v1/chat/completions",modelsUrl:"https://api.together.xyz/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^pplx-/i.test(t)) return {provider:"perplexity",displayName:"Perplexity",baseUrl:"https://api.perplexity.ai",chatUrl:"https://api.perplexity.ai/chat/completions",modelsUrl:"https://api.perplexity.ai/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^r8_/i.test(t)) return {provider:"replicate",displayName:"Replicate",baseUrl:"https://api.replicate.com/v1",chatUrl:"https://api.replicate.com/v1/chat/completions",modelsUrl:"https://api.replicate.com/v1/models",confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
  if (/^fw_/i.test(t)) return {provider:"fireworks",displayName:"Fireworks",baseUrl:"https://api.fireworks.ai/inference/v1",chatUrl:"https://api.fireworks.ai/inference/v1/chat/completions",modelsUrl:"https://api.fireworks.ai/inference/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^sk-/i.test(t)) {
    if (t.length<40) return {provider:"deepseek",displayName:"DeepSeek",baseUrl:"https://api.deepseek.com",chatUrl:"https://api.deepseek.com/v1/chat/completions",modelsUrl:"https://api.deepseek.com/v1/models",balanceUrl:"https://api.deepseek.com/user/balance",confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    return {provider:"openai",displayName:"OpenAI",baseUrl:"https://api.openai.com",chatUrl:"https://api.openai.com/v1/chat/completions",modelsUrl:"https://api.openai.com/v1/models",balanceUrl:"https://api.openai.com/v1/dashboard/billing/subscription",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  }
  if (/^xai-/i.test(t)) return {provider:"xai",displayName:"xAI (Grok)",baseUrl:"https://api.x.ai",chatUrl:"https://api.x.ai/v1/chat/completions",modelsUrl:"https://api.x.ai/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^AIza/i.test(t)) return {provider:"gemini",displayName:"Google Gemini",baseUrl:"https://generativelanguage.googleapis.com",chatUrl:"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",modelsUrl:"https://generativelanguage.googleapis.com/v1beta/models",confidence:"high",headers:{},authHeader:""};
  if (/^co-|^cohere/i.test(t)) return {provider:"cohere",displayName:"Cohere",baseUrl:"https://api.cohere.com/v2",chatUrl:"https://api.cohere.com/v2/chat",confidence:"medium",headers:{"accept":"application/json"},authHeader:`Bearer ${t}`};
  if (/^hf_/i.test(t)) return {provider:"huggingface",displayName:"HuggingFace",baseUrl:"https://api-inference.huggingface.co",chatUrl:"https://api-inference.huggingface.co/v1/chat/completions",confidence:"low",headers:{},authHeader:`Bearer ${t}`};if (/^nvapi-/i.test(t)) return {provider:"nvidia",displayName:"NVIDIA NIM",baseUrl:"https://integrate.api.nvidia.com/v1",chatUrl:"https://integrate.api.nvidia.com/v1/chat/completions",modelsUrl:"https://integrate.api.nvidia.com/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};if (/[a-f0-9]{32}/i.test(t)&&t.length===32) return {provider:"azure",displayName:"Azure OpenAI",baseUrl:"",chatUrl:"",confidence:"medium",headers:{"api-key":t},authHeader:""};

  if (t.length>20) return {provider:"openai",displayName:"OpenAI（推测）",baseUrl:"https://api.openai.com",chatUrl:"https://api.openai.com/v1/chat/completions",modelsUrl:"https://api.openai.com/v1/models",confidence:"low",headers:{},authHeader:`Bearer ${t}`};
  return {provider:"unknown",displayName:"未知",baseUrl:"",chatUrl:"",confidence:"low",headers:{},authHeader:""};
}

// ── API probing: call endpoints to detect provider type ──
async function probeApi(baseUrl:string,key:string): Promise<PI>{
  const u=baseUrl.replace(/\/+$/,"");const t=key.trim();
  const r:PI={provider:"custom",displayName:`API (${(()=>{try{return new URL(u).hostname}catch{return u}})()})`,baseUrl:u,chatUrl:jp(u,"/chat/completions"),modelsUrl:jp(u,"/models"),confidence:"low",headers:{},authHeader:`Bearer ${t}`};
  const probes:Array<{label:string;url:string;hdrs:Record<string,string>;fn?:(d:unknown)=>Partial<PI>|null}>=[
    {label:"openai",url:jp(u,"/models"),hdrs:{Authorization:`Bearer ${t}`},fn:(d:any)=>{const arr=Array.isArray(d)?d:d?.data;if(!arr?.length)return null;const ids=arr.map((m:any)=>String(m.id||""));if(ids.some((s:string)=>s.includes("gpt")||s.includes("o1")||s.includes("o3")||s.includes("o4")))return{provider:"openai",displayName:"OpenAI",confidence:"high"};if(ids.some((s:string)=>s.includes("claude")))return{provider:"custom",displayName:"Anthropic 代理",confidence:"medium"};if(ids.some((s:string)=>s.includes("gemini")))return{provider:"custom",displayName:"Gemini 代理",confidence:"medium"};return{provider:"custom",displayName:`OpenAI兼容 (${ids.length}模型)`,confidence:"medium"};}},
    {label:"gemini",url:`${u}/v1beta/models?key=${t}`,hdrs:{},fn:(d:any)=>{if(d?.models?.length){const names=d.models.map((m:any)=>String(m.name||""));if(names.some((s:string)=>s.includes("gemini")))return{provider:"gemini",displayName:"Google Gemini",confidence:"high",chatUrl:`${u}/v1beta/models/gemini-2.5-flash:generateContent`,modelsUrl:`${u}/v1beta/models`,authHeader:""};}return null;}},
    {label:"anthropic",url:jp(u,"/models"),hdrs:{"x-api-key":t,"anthropic-version":"2023-06-01"},fn:(d:any)=>{const arr=Array.isArray(d)?d:d?.data;if(!arr?.length)return null;const ids=arr.map((m:any)=>String(m.id||""));if(ids.every((s:string)=>s.startsWith("claude-")))return{provider:"anthropic",displayName:"Anthropic",confidence:"high",chatUrl:`${u}/v1/messages`,headers:{"x-api-key":t,"anthropic-version":"2023-06-01","content-type":"application/json"},authHeader:""};return null;}},
    {label:"openrouter",url:`${u.replace(/\/api\/v1.*$/,"")}/api/v1/auth/key`,hdrs:{Authorization:`Bearer ${t}`,"HTTP-Referer":"https://t.me/telebox_next"},fn:(d:any)=>{if(d?.data?.label||d?.label||d?.data?.credits!==undefined)return{provider:"openrouter",displayName:"OpenRouter",confidence:"high",balanceUrl:`${u.replace(/\/api\/v1.*$/,"")}/api/v1/auth/key`,headers:{"HTTP-Referer":"https://t.me/telebox_next"}};return null;}},
  ];
  const results=await Promise.allSettled(probes.map(p=>ag(p.url,p.hdrs,8000,0).then(ar=>({...p,ar}))));
  for(const pr of results){
    if(pr.status!=="fulfilled")continue;
    const{label,fn,ar}=pr.value;
    if(!ar.ok)continue;
    if(fn){const extra=fn(ar.data);if(extra){Object.assign(r,extra);if(r.confidence==="high")break;}}
    else{r.confidence="medium";}
  }
  if(r.confidence==="low"){
    const gen=results.find(pr=>pr.status==="fulfilled"&&pr.value.label==="openai");
    if(gen&&gen.status==="fulfilled"&&gen.value.ar.ok){
      const d=gen.value.ar.data as any;const arr=Array.isArray(d)?d:d?.data;
      if(arr?.length)r.displayName=`OpenAI兼容 (${arr.length}模型)`;
    }
  }
  return r;
}

// ── HTTP (with retry) ──
async function ag(url:string,hdrs:Record<string,string>,tms=15000,retries=2): Promise<AR>{for(let i=0;i<=retries;i++){const s=Date.now();try{const r=await axios.get(url,{headers:hdrs,timeout:tms,validateStatus:()=>true,httpAgent:new (require("http").Agent)({keepAlive:true})});const e=Date.now()-s;const a:AR={ok:r.status>=200&&r.status<300,data:r.data,status:r.status,elapsedMs:e};const h:Record<string,string>={};for(const[k,v]of Object.entries(r.headers as Record<string,string>||{})){if(/rate.?limit|retry.?after|x-ratelimit|ratelimit|quota/i.test(k))h[k]=String(v);}if(Object.keys(h).length)a.headers=h;if(!a.ok)a.error=`HTTP ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`;return a;}catch(e:unknown){if(i===retries)return{ok:false,error:ge(e),elapsedMs:Date.now()-s};await new Promise(r=>setTimeout(r,1000*(i+1)));}}return{ok:false,error:"retry exhausted"};}
async function ap(url:string,hdrs:Record<string,string>,body:unknown,tms=30000,retries=1): Promise<AR>{for(let i=0;i<=retries;i++){const s=Date.now();try{const r=await axios.post(url,body,{headers:hdrs,timeout:tms,validateStatus:()=>true});const e=Date.now()-s;const a:AR={ok:r.status>=200&&r.status<300,data:r.data,status:r.status,elapsedMs:e};const h:Record<string,string>={};for(const[k,v]of Object.entries(r.headers as Record<string,string>||{})){if(/rate.?limit|retry.?after|x-ratelimit|ratelimit|quota/i.test(k))h[k]=String(v);}if(Object.keys(h).length)a.headers=h;if(!a.ok){const d=r.data as Record<string,unknown>|undefined;a.error=d?.error&&typeof d.error==="object"?String((d.error as Record<string,unknown>).message||JSON.stringify(d.error)):`HTTP ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`;}return a;}catch(e:unknown){if(i===retries)return{ok:false,error:ge(e),elapsedMs:Date.now()-s};await new Promise(r=>setTimeout(r,1000*(i+1)));}}return{ok:false,error:"retry exhausted"};}

// ── Fetch models from API to pick a test model ──
async function pickTestModel(provider:string,key:string,baseUrl:string): Promise<string>{
  const info=dp(key,baseUrl);
  const hdrs:Record<string,string>=info.authHeader?{Authorization:info.authHeader}:{};
  const url=provider==="gemini"?`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
    :provider==="ollama"?`${info.baseUrl}/api/tags`
    :info.modelsUrl||`${info.baseUrl}/v1/models`;
  try{
    const r=await ag(url,provider==="anthropic"?info.headers:hdrs,8000);
    if(r.ok){
      let models:Array<Record<string,unknown>>=[];
      if(provider==="gemini"){models=(r.data as Record<string,unknown>|undefined)?.models as Array<Record<string,unknown>>||[];}
      else if(provider==="ollama"){models=((r.data as Record<string,unknown>|undefined)?.models as Array<Record<string,unknown>>||[]).map((m:Record<string,unknown>)=>({id:String(m.name||"").replace(/:latest$/,"")}));}
      else{const d=r.data as Record<string,unknown>|undefined;models=(Array.isArray(r.data)?r.data:d?.data as Array<Record<string,unknown>>)||[];}
      if(models.length){
        const names=models.map((m:any)=>String(m.id||m.name||"").replace("models/","").replace(":latest","")).filter(Boolean);
        if(names.length)return names[0];
      }
    }
  }catch{/* fallback */}
  return "";
}
async function ct(provider:string,key:string,baseUrl:string,askText?:string): Promise<CTR>{const q=askText||"say ok";const info=dp(key,baseUrl);
  if(provider==="gemini"){const gemBase=info.baseUrl||"https://generativelanguage.googleapis.com";const url=gemBase.includes("v1beta")?`${gemBase}/models/gemini-2.5-flash:generateContent`:`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;const params=gemBase.includes("generativelanguage")?`?key=${key}`:"";const r=await ap(`${url}${params}`,{"content-type":"application/json"},{contents:[{parts:[{text:q}]}],generationConfig:{maxOutputTokens:50,temperature:0}},20000);if(r.ok){const d=r.data as Record<string,unknown>|undefined;const cs=d?.candidates as Array<Record<string,unknown>>|undefined;const ct=cs?.[0]?.content as Record<string,unknown>|undefined;const ps=ct?.parts as Array<Record<string,string>>|undefined;const tx=ps?.map(p=>p.text||"").join("")||"";const u=d?.usageMetadata as Record<string,number>|undefined;return{ok:true,text:tx,model:"gemini-2.5-flash",usage:u?{prompt:u.promptTokenCount||0,completion:u.candidatesTokenCount||0,total:u.totalTokenCount||0}:undefined,elapsedMs:r.elapsedMs,headers:r.headers};}return{ok:false,error:r.error,elapsedMs:r.elapsedMs};}
  if(provider==="anthropic"){const r=await ap(info.chatUrl,info.headers,{model:"claude-3.5-haiku-20241022",max_tokens:50,messages:[{role:"user",content:q}]},20000);if(r.ok){const d=r.data as Record<string,unknown>|undefined;const ct=(d?.content as Array<Record<string,unknown>>|undefined)?.[0];const tx=String(ct?.text||"");const u=d?.usage as Record<string,number>|undefined;return{ok:true,text:tx,model:String(d?.model||"claude"),usage:u?{prompt:u.input_tokens||0,completion:u.output_tokens||0,total:(u.input_tokens||0)+(u.output_tokens||0)}:undefined,elapsedMs:r.elapsedMs,headers:r.headers};}return{ok:false,error:r.error,elapsedMs:r.elapsedMs};}
  let model=await pickTestModel(provider,key,baseUrl);
  if(!model){
    const hdrs2:Record<string,string>={Authorization:info.authHeader||`Bearer ${key}`};
    const modelsUrl=info.modelsUrl||`${info.baseUrl}/v1/models`;
    const r2=await ag(modelsUrl,hdrs2,8000);
    if(r2.ok){
      const d=r2.data as Record<string,unknown>|undefined;
      const arr=(Array.isArray(r2.data)?r2.data:d?.data as Array<Record<string,unknown>>)||[];
      if(arr.length){
        const ids=arr.map((m:any)=>String(m.id||m.name||"").replace("models/","")).filter(Boolean);
        if(ids.length)model=ids[0];
      }
    }
  }
  if(!model)return{ok:false,error:"无法获取可用模型",elapsedMs:0};
  const hdrs:Record<string,string>={"content-type":"application/json"};
  if (info.authHeader) hdrs["Authorization"]=info.authHeader;
  if (provider==="cohere") delete hdrs["Authorization"];
  const r=await ap(info.chatUrl,hdrs,{model,messages:[{role:"user",content:q}],max_tokens:50,temperature:0},20000);
  if(r.ok){const d=r.data as Record<string,unknown>|undefined;const cs=d?.choices as Array<Record<string,unknown>>|undefined;const tx=String((cs?.[0]?.message as Record<string,unknown>|undefined)?.content||cs?.[0]?.text||"");const u=d?.usage as Record<string,number>|undefined;return{ok:true,text:tx.trim(),model:String(d?.model||model),usage:u?{prompt:u.prompt_tokens||0,completion:u.completion_tokens||0,total:u.total_tokens||0}:undefined,elapsedMs:r.elapsedMs,headers:r.headers};}return{ok:false,error:r.error,elapsedMs:r.elapsedMs};}

// ── Balance ──
async function cb(provider:string,key:string,baseUrl:string): Promise<string>{const info=dp(key,baseUrl);const hdrs:Record<string,string>={Authorization:`Bearer ${key}`,...(provider==="openrouter"?{"HTTP-Referer":"https://t.me/telebox_next"}:{})};const lines:string[]=[];
  if(provider==="openai"){
    // Subscription + usage + org info
    const sub=await ag(`${info.baseUrl}/v1/dashboard/billing/subscription`,hdrs,10000);
    if(sub.ok){const d=sub.data as Record<string,unknown>|undefined;const plan=(d?.plan as Record<string,unknown>|undefined)?.title||"?";const until=d?.access_until?new Date((d.access_until as number)*1000).toLocaleDateString("zh-CN"):"?";lines.push(`📋 套餐: ${plan} | 📅 至: ${until}`);lines.push(`💰 硬上限: $${d?.hard_limit_usd??"?"} | 软: $${d?.soft_limit_usd??"?"} | 系统: $${d?.system_hard_limit_usd??"?"}`);if(d?.has_payment_method!==undefined)lines.push(`💳 支付方式: ${d?.has_payment_method?"✅":"❌"}`);}else if(sub.status===401)return"❌ Key 无效";else lines.push("⚠️ 可能为 platform key，无法查看账单");
    const now=Math.floor(Date.now()/1000);
    const usg=await ag(`${info.baseUrl}/v1/dashboard/billing/usage?start_date=${now-90*86400}&end_date=${now}`,hdrs,10000);
    if(usg.ok){const d=usg.data as Record<string,unknown>|undefined;lines.push(`📊 近 90 天: $${(((d?.total_usage as number)||0)/100).toFixed(4)}`);}
    // Models endpoint → get owned_by + rate limits per model
    const mdls=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);
    if(mdls.ok){const d=mdls.data as Record<string,unknown>|undefined;const arr=(Array.isArray(mdls.data)?mdls.data:d?.data as Array<Record<string,unknown>>)||[];const ownerSet=new Set<string>();let maxTier="";for(const m of arr.slice(0,50)){if(m.owned_by)ownerSet.add(String(m.owned_by));if(m.max_tier)maxTier=String(m.max_tier);}if(ownerSet.size)lines.push(`🏢 Org: ${[...ownerSet].slice(0,3).join(", ")}${ownerSet.size>3?" ...":""}`);if(maxTier)lines.push(`📈 Tier: ${maxTier}`);}
    if(sub.headers&&Object.keys(sub.headers).length)lines.push(fh(sub.headers));
    return lines.join("\n")||"✅ Key 有效";
  }
  if(provider==="openrouter"){
    const r=await ag(`${info.baseUrl}/api/v1/auth/key`,hdrs,10000);
    if(r.ok){const d=(r.data as Record<string,unknown>|undefined);const info=(d?.data||d)as Record<string,unknown>|undefined||{};lines.push(`🏷️ ${info.label||info.name||"?"}`);lines.push(`💰 余额: $${info.credits??"?"} | 📊 已用: $${info.usage??"?"}${info.limit!==undefined?` | 📏 限额: $${info.limit}`:""}`);if(info.rate_limit){const rl=info.rate_limit as Record<string,unknown>;lines.push(`⚡ 速率: ${rl.requests||"?"} req / ${rl.interval||"?"}`);}const disabled=(info.disabled_providers as Array<unknown>|undefined);if(disabled?.length)lines.push(`🚫 禁用: ${disabled.length} providers`);}else if(r.status===401)return"❌ Key 无效";else return`⚠️ ${r.error||"查询失败"}`;
    if(r.headers&&Object.keys(r.headers).length)lines.push(fh(r.headers));
    return lines.join("\n");
  }
  if(provider==="deepseek"){const r=await ag(`${info.baseUrl.replace(/\/v\d.*$/,"")}/user/balance`,hdrs,10000);if(r.ok){const d=r.data as Record<string,unknown>|undefined;lines.push(`✅ 可用: ${d?.is_available?"是":"否"}`);const infos=d?.balance_infos as Array<Record<string,unknown>>|undefined;if(infos)for(const bi of infos)lines.push(`💰 ${bi.currency||"余额"}: ${bi.total_balance||"?"} (已用: ${bi.topped_up_balance||"?"})`);}else if(r.status===401)return"❌ Key 无效";else return`⚠️ ${r.error||"查询失败"}`;return lines.join("\n");}
  if(provider==="anthropic"){const r=await ap("https://api.anthropic.com/v1/messages",{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},{model:"claude-3.5-haiku-20241022",max_tokens:1,messages:[{role:"user",content:"hi"}]},15000);if(r.status===401||r.status===403)return"❌ Key 无效";if(r.ok||r.status===429)return`✅ Key 有效 (${r.status===429?"限流":"正常"})\n💰 请前往官网查看余额`;return`⚠️ HTTP ${r.status}: ${r.error||""}`;}
  if(provider==="gemini"){const r=await ag(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,{},10000);if(r.ok){const ms=(r.data as Record<string,unknown>|undefined)?.models as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${ms?.length??0} 个模型\n💰 请在控制台查看额度`;}if(r.status===400&&JSON.stringify(r.data||"").includes("API_KEY_INVALID"))return"❌ Key 无效";return`⚠️ HTTP ${r.status}: ${htmlEscape(r.error||"可能有效")}`;}
  if(provider==="xai"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型\n💰 请前往官网查看余额`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;}

  if(provider==="nvidia"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型\n💰 请前往官网查看余额`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;}if(provider==="novita"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;}if(provider==="cerebras"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型\n💰 请前往官网查看余额`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;} // Generic models endpoint test for unrecognized providers
  const testUrls = [`${info.baseUrl}/v1/models`, `${info.baseUrl}/models`];
  for (const u of testUrls) {
    const r = await ag(u, hdrs, 10000);
    if (r.ok) {
      const arr = Array.isArray(r.data) ? r.data : (r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;
      const count = arr?.length ?? "?";
      const rateInfo = r.headers && Object.keys(r.headers).length ? `\n${fh(r.headers)}` : "";
      return `✅ 在线 | 📋 ${count} 个模型 | 🕐 ${r.elapsedMs||"?"}ms${rateInfo}`;
    }
    if (r.status === 401) return "❌ Key 无效";
    if (r.status === 404 || r.status === 405) continue;
    // Some endpoint worked (non-404) — likely valid
    return `✅ 服务可达 (HTTP ${r.status}) | 🕐 ${r.elapsedMs||"?"}ms\n⚠️ 无法查询模型列表`;
  }
  return `❌ 均无法连接，请检查 URL 和 Key`;
}

// ── Model list (all models in one blockquote with pagination) ──
async function lmf(provider:string,key:string,baseUrl:string): Promise<string>{
  const info=dp(key,baseUrl);
  const hdrs:Record<string,string>=info.authHeader?{Authorization:info.authHeader}:{};
  const url=provider==="gemini"?`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
    :provider==="ollama"?`${info.baseUrl}/api/tags`
    :info.modelsUrl||`${info.baseUrl}/v1/models`;

  const r=await ag(url,provider==="anthropic"?info.headers:hdrs,12000);
  if(!r.ok)return`❌ 获取失败：${htmlEscape(r.error)}`;
  let models:Array<Record<string,unknown>>=[];
  if(provider==="gemini"){models=(r.data as Record<string,unknown>|undefined)?.models as Array<Record<string,unknown>>||[];}
  else if(provider==="ollama"){models=((r.data as Record<string,unknown>|undefined)?.models as Array<Record<string,unknown>>||[]).map((m:Record<string,unknown>)=>({id:String(m.name||"").replace(/:latest$/,""),owned_by:"ollama"}));}
  else{const d=r.data as Record<string,unknown>|undefined;models=(Array.isArray(r.data)?r.data:d?.data as Array<Record<string,unknown>>)||[];}
  if(!models.length)return"❌ 未找到可用模型";

  const names:string[]=[];
  for(const m of models){
    const name=String(m.id||m.name||"").replace("models/","").replace(":latest","");
    if(name)names.push(name);
  }
  if(!names.length)return"❌ 未找到可用模型";

  // Single blockquote with all models, truncated for single message
  const allModels = names.map(n=>`<code>${htmlEscape(n)}</code>`).join(" | ");
  const content = `<blockquote expandable>${allModels}</blockquote>`;
  const header = `🤖 共 ${names.length} 个`;
  
  if(content.length > 3500){
    // Split into multiple blockquotes if too long
    const chunks: string[] = [];
    let current = "";
    for(const n of names){
      const part = `<code>${htmlEscape(n)}</code> | `;
      if(current.length + part.length > 3500){
        chunks.push(`<blockquote expandable>${current.slice(0, -3)}</blockquote>`);
        current = "";
      }
      current += part;
    }
    if(current) chunks.push(`<blockquote expandable>${current.slice(0, -3)}</blockquote>`);
    return `${header}\n${chunks.join("\n")}`;
  }
  
  return `${header}\n${content}`;
}

// ── Full check ──
async function fcv2(provider:string,key:string,baseUrl:string): Promise<string[]>{
  const rs:string[]=[];const info=dp(key,baseUrl);
  rs.push(`🔍 <b>${htmlEscape(info.displayName)}</b> (${info.provider}, ${info.confidence})`);
  rs.push(`🔑 ${mk(key)}`);
  rs.push(`\n💰 <b>账户余额</b>：`);
  try{rs.push(await cb(provider,key,baseUrl));}catch(e:unknown){rs.push(`⚠️ ${htmlEscape(ge(e))}`);}
  rs.push(`\n💬 <b>对话测试</b>：`);
  try{const chat=await ct(provider,key,baseUrl);if(chat.ok){rs.push(`✅ 响应: "${htmlEscape(chat.text)}" (${chat.elapsedMs}ms) | 🤖 <code>${htmlEscape(chat.model)}</code>`);if(chat.usage)rs.push(`📊 Token: 入${chat.usage.prompt} 出${chat.usage.completion} 计${chat.usage.total}`);if(chat.headers)rs.push(fh(chat.headers));}else{rs.push(`❌ 失败: ${htmlEscape(chat.error||"无响应")}`);}}catch(e:unknown){rs.push(`⚠️ ${htmlEscape(ge(e))}`);}
  rs.push(`\n📋 <b>可用模型</b>：`);
  try{rs.push(await lmf(provider,key,baseUrl));}catch(e:unknown){rs.push(`⚠️ ${htmlEscape(ge(e))}`);}
  return rs;
}

// ── Speed benchmark ──
async function speedTest(provider:string,key:string,baseUrl:string): Promise<string[]>{
  const models:Record<string,string[]>={openai:["gpt-4.1-mini","gpt-4.1-nano","gpt-4o-mini"],groq:["llama-3.3-70b-versatile","mixtral-8x7b-32768","gemma2-9b-it"],deepseek:["deepseek-chat","deepseek-reasoner"],openrouter:["openai/gpt-4.1-mini","anthropic/claude-3.5-haiku","google/gemini-2.5-flash"],together:["meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8","Qwen/Qwen3-235B-A22B"],fireworks:["accounts/fireworks/models/llama-v3p3-70b-instruct","accounts/fireworks/models/deepseek-v3"],mistral:["mistral-small-2506","codestral-2501"],xai:["grok-3-mini","grok-2-latest"],perplexity:["sonar-reasoning","sonar-pro"],siliconflow:["Qwen/Qwen3-8B","deepseek-ai/DeepSeek-V3"],deepinfra:["meta-llama/Llama-4-Maverick-17B-128E-Instruct"],nvidia:["nvidia/llama-3.1-nemotron-ultra-253b-v1"],novita:["deepseek/deepseek-v3-0324","meta-llama/Llama-3.3-70B-Instruct"],cerebras:["llama3.1-8b","llama3.3-70b"],azure:["gpt-4o-mini"],vercel:["gpt-4o-mini"]};
  const testModels=models[provider]||["gpt-4o-mini"];
  const info=dp(key,baseUrl);
  const hdrs:Record<string,string>={"content-type":"application/json"};
  if(info.authHeader)hdrs["Authorization"]=info.authHeader;

  const rs:string[]=[`⚡ <b>${htmlEscape(info.displayName)}</b> 速度测试 (最多 50 token)：`];
  for(const m of testModels){
    try{
      const start=Date.now();
      const r=await ap(info.chatUrl,hdrs,{model:m,messages:[{role:"user",content:"ok"}],max_tokens:50,temperature:0},30000);
      const elapsed=Date.now()-start;
      if(r.ok){const d=r.data as Record<string,unknown>|undefined;const tps=r.data?(((d?.usage as Record<string,number>|undefined)?.total_tokens||0)/(elapsed/1000)).toFixed(1):"?";rs.push(`  ✅ <code>${m}</code>: ${elapsed}ms (${tps} tok/s)`);}
      else rs.push(`  ❌ <code>${m}</code>: ${htmlEscape((r.error||"失败").slice(0,60))}`);
    }catch(e:unknown){rs.push(`  ❌ <code>${m}</code>: ${htmlEscape(ge(e).slice(0,60))}`);}
  }
  return rs;
}

// ── Quick API key validation (for save) ──
async function validateKey(provider:string,key:string,baseUrl:string): Promise<string>{
  const info=dp(key,baseUrl);
  const hdrs:Record<string,string>=info.authHeader?{Authorization:info.authHeader}:{};
  const testUrls = provider==="gemini"?[`${info.baseUrl}/v1beta/models?key=${key}`]
    :provider==="anthropic"?[info.chatUrl]
    :[`${info.baseUrl}/v1/models`, `${info.baseUrl}/models`];
  for (const u of testUrls) {
    const r=await ag(u,provider==="anthropic"?info.headers:hdrs,10000);
    if(r.ok)return"✅";
    if(r.status===401)return"❌ Key 无效 — 401 Unauthorized";
    if(r.status===403)return"❌ Key 无效 — 403 Forbidden";
    if(r.status===404||r.status===405)continue;
    return `⚠️ HTTP ${r.status}`;
  }
  return `❌ 无法连接 — 请检查 URL 和 Key`;
}

// ── Plugin ──
class CheckApiPlugin extends Plugin{name="checkapi";description=
`🔍 API 检测 v6\n\n传入 URL + Key 即可自动识别、查余额、测速。\n所有子命令均支持直接传入网址和密钥，无需预先保存。\n\n用法：\n<blockquote expandable><code>${mp}checkapi &lt;URL&gt; &lt;key&gt;</code> — 一键检测全部\n<code>${mp}checkapi models &lt;URL&gt; &lt;key&gt;</code> — 查看模型列表\n<code>${mp}checkapi speed &lt;URL&gt; &lt;key&gt;</code> — 测试响应速度\n<code>${mp}checkapi ask &lt;URL&gt; &lt;key&gt; &lt;问题&gt;</code> — 发送对话\n<code>${mp}checkapi compare &lt;k1&gt; &lt;k2&gt;</code> — 对比两个 API\n<code>${mp}checkapi save/list/del/check</code> — 管理已保存的密钥</blockquote>\n支持 curl 命令 / 环境变量 / JSON 配置直接粘贴`;
    // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
        id: "checkapi",
        title: "API 检查",
        description: "API 可用性检查配置",
        category: "插件配置",
        icon: "✅",
        getSchema: (): PanelSettingField[] => [
          {
                "key": "interval",
                "label": "检查间隔 (分钟)",
                "type": "number",
                "min": 1,
                "max": 1440,
                "default": 60
          },
          {
                "key": "timeout",
                "label": "超时 (秒)",
                "type": "number",
                "min": 1,
                "max": 60,
                "default": 10
          }
    ],
        getValues: async (): Promise<Record<string, unknown>> => {
          const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("checkapi"), "config.json"), {} as any);
          return db.data as Record<string, unknown>;
        },
        setValues: async (patch: Record<string, unknown>): Promise<void> => {
          const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("checkapi"), "config.json"), {} as any);
          Object.assign(db.data, patch);
          await db.write();
        },
      };

cmdHandlers:Record<string,(msg:Api.Message)=>Promise<void>>={checkapi:async(msg)=>{
  const rawFull=msg.message.slice(mp.length).trim();
  const raw=rawFull.replace(/^checkapi\s*/i,"").trim();
  const smart=parseSmart(raw);
  let extracedKey=smart.key;let extracedUrl=smart.url;
  if(!extracedKey){const cp=parseCurl(rawFull);if(cp){extracedKey=cp.key;extracedUrl=cp.url||extracedUrl;}}
  if(!extracedKey){const ep=parseEnv(rawFull);if(ep){extracedKey=ep.key;}}
  if(!extracedKey&&(rawFull.includes('"api_key"')||rawFull.includes('"apiKey"')||rawFull.includes('"key"'))){
    try{const j=JSON.parse(rawFull.replace(/^`+|`+$/g,""));extracedKey=j.api_key||j.apiKey||j.key||j.token;extracedUrl=j.base_url||j.baseUrl||j.endpoint||extracedUrl;}catch{}}

  let parts=raw.split(/\s+/).filter(Boolean);
  if(!parts.length && extracedKey){if(extracedUrl)parts.push(extracedUrl);parts.push(extracedKey);}
  if(!smart.sub && extracedKey && extracedUrl && !(parts.length>=2 && (isUrl(parts[0])||isUrl(parts[1])))){
    parts=[extracedUrl, extracedKey];
  }

  if(parts.length===0||parts[0]==="help"){await msg.edit({text:`${this.description}`, parseMode: "html" });return;}
  const sub=parts[0]?.toLowerCase();

  // ── list / del / save / check ──
  if(sub==="list"){const keys=await lk();if(!keys.length){await msg.edit({text:`📭 还没有保存密钥\n<code>${mp}checkapi save &lt;name&gt; &lt;key&gt;</code>`, parseMode: "html" });return;}const lines=[`🔑 已保存 ${keys.length} 个:`];for(const k of keys)lines.push(`  • <b>${htmlEscape(k.name)}</b>: ${mk(k.key)} (${k.provider||"auto"})${k.baseUrl?` [${(()=>{try{return new URL(k.baseUrl).hostname}catch{return k.baseUrl}})()}]`:""}`);await msg.edit({text:`${lines.join("\n")}`, parseMode: "html" });return;}
  if(sub==="del"||sub==="delete"){const name=parts[1];if(!name){await msg.edit({text:`❌ 用法：<code>${mp}checkapi del &lt;名称&gt;</code>`, parseMode: "html" });return;}const keys=await lk();const idx=keys.findIndex(k=>k.name===name);if(idx===-1){await msg.edit({text:`❌ <b>${htmlEscape(name)}</b> 不存在`, parseMode: "html" });return;}keys.splice(idx,1);await sk(keys);await msg.edit({text:`✅ 已删 <b>${htmlEscape(name)}</b>`, parseMode: "html" });return;}
  if(sub==="save"){let name:string|undefined,key:string|undefined,baseUrl:string|undefined;const args=parts.slice(1);for(const a of args){if(isUrl(a)&&!baseUrl){baseUrl=nu(a);continue;}if(!key&&(/^sk-|gsk_|tgp_|pplx-|r8_|fw_|xai-|AIza|co-|hf_|nvapi-/i.test(a)||a.length>=24)){key=a;continue;}if(!name){name=a;continue;}if(!key){key=a;continue;}if(!baseUrl){baseUrl=nu(a);continue;}}if(!key&&extracedKey)key=extracedKey;if(!baseUrl&&extracedUrl)baseUrl=nu(extracedUrl);if(!name||!key){await msg.edit({text:`❌ 用法：<code>${mp}checkapi save &lt;名称&gt; &lt;key&gt; [url]</code>`, parseMode: "html" });return;}const keys=await lk();const info=dp(key,baseUrl);const entry:SK={name,key,baseUrl,provider:info.provider,addedAt:Date.now()};const idx=keys.findIndex(k=>k.name===name);if(idx>=0)keys[idx]=entry;else keys.push(entry);await sk(keys);await msg.edit({text:`🔍 正在验证 <b>${htmlEscape(name)}</b>...`, parseMode: "html" });const valid=await validateKey(info.provider,key,info.baseUrl);await msg.edit({text:`✅ ${idx>=0?"已更新":"已保存"} <b>${htmlEscape(name)}</b> → <code>${mp}checkapi ${name}</code>\n${valid}`, parseMode: "html" });return;}
  if(sub==="check"){const target=parts[1]||"all";if(target==="all"){const keys=await lk();if(!keys.length){await msg.edit({text:`📭 还没有保存密钥`, parseMode: "html" });return;}await msg.edit({text:`正在检测 ${keys.length} 个密钥...`, parseMode: "html" });const results:string[]=[];const promises=keys.map(async(k)=>{const info=dp(k.key,k.baseUrl);try{return[`\n━━━ <b>${htmlEscape(k.name)}</b> ━━━`,...(await fcv2(info.provider,k.key,k.baseUrl||info.baseUrl))]as string[]}catch(e:unknown){return[`\n━━━ <b>${htmlEscape(k.name)}</b> ━━━`,`⚠️ ${htmlEscape(ge(e))}`]as string[]}});const batches=await Promise.all(promises);for(const row of batches)results.push(...row);await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });return;}const keys=await lk();const found=keys.find(k=>k.name===target);if(!found){await msg.edit({text:`❌ <b>${htmlEscape(target)}</b> 不存在`, parseMode: "html" });return;}await msg.edit({text:`🔍 正在检测 <b>${htmlEscape(target)}</b>...`, parseMode: "html" });const info=dp(found.key,found.baseUrl);const results=await fcv2(info.provider,found.key,found.baseUrl||info.baseUrl);await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });return;}

  // ── models / ask / speed ──
  if(sub==="models"){const keys=await lk();let key:string|undefined;let baseUrl:string|undefined;const args=parts.slice(1);for(const a of args){if(isUrl(a)&&!baseUrl){baseUrl=nu(a);continue;}const found=keys.find(k=>k.name===a);if(found&&!key){key=found.key;baseUrl=baseUrl||found.baseUrl;continue;}if(!key)key=a;}if(!key&&extracedKey)key=extracedKey;if(!baseUrl&&extracedUrl)baseUrl=nu(extracedUrl);if(!key){await msg.edit({text:`❌ <code>${mp}checkapi models &lt;key|name&gt;</code>`, parseMode: "html" });return;}const info=baseUrl?await probeApi(baseUrl,key):dp(key);await msg.edit({text:`🔍 ${htmlEscape(info.displayName)} 模型列表...`, parseMode: "html" });const result=await lmf(info.provider,key,info.baseUrl);await msg.edit({text:`${result}`, parseMode: "html" });return;}
  if(sub==="ask"){const keys=await lk();let key:string|undefined;let baseUrl:string|undefined;const args=parts.slice(1);const qParts:string[]=[];for(const a of args){if(isUrl(a)&&!baseUrl){baseUrl=nu(a);continue;}const found=keys.find(k=>k.name===a);if(found&&!key){key=found.key;baseUrl=baseUrl||found.baseUrl;continue;}if(!key&&(/^sk-|gsk_|tgp_|pplx-|r8_|fw_|xai-|AIza|co-|hf_|nvapi-/i.test(a)||a.length>=24)){key=a;continue;}if(!key){key=a;continue;}qParts.push(a);}if(!key&&extracedKey)key=extracedKey;if(!baseUrl&&extracedUrl)baseUrl=nu(extracedUrl);const prompt=qParts.join(" ")||"say hello";if(!key){await msg.edit({text:`❌ <code>${mp}checkapi ask &lt;key|name&gt; &lt;问题&gt;</code>`, parseMode: "html" });return;}const info=baseUrl?await probeApi(baseUrl,key):dp(key,baseUrl);await msg.edit({text:`💬 ${htmlEscape(info.displayName)}: "${htmlEscape(prompt)}" ...`, parseMode: "html" });const chat=await ct(info.provider,key,info.baseUrl,prompt);if(chat.ok){const l=[`💬 <b>${htmlEscape(info.displayName)}</b>`,`🤖 <code>${htmlEscape(chat.model)}</code> | 🕐 ${chat.elapsedMs}ms`,`📝 ${htmlEscape(chat.text)}`];if(chat.usage)l.push(`📊 入${chat.usage.prompt} 出${chat.usage.completion} 计${chat.usage.total}`);if(chat.headers)l.push(fh(chat.headers));await msg.edit({text:`${l.join("\n")}`, parseMode: "html" });}else{await msg.edit({text:`❌ (${chat.elapsedMs||"?"}ms): ${htmlEscape(chat.error)}`, parseMode: "html" });}return;}
  if(sub==="speed"){const keys=await lk();let key:string|undefined;let baseUrl:string|undefined;const args=parts.slice(1);for(const a of args){if(isUrl(a)&&!baseUrl){baseUrl=nu(a);continue;}const found=keys.find(k=>k.name===a);if(found&&!key){key=found.key;baseUrl=baseUrl||found.baseUrl;continue;}if(!key)key=a;}if(!key&&extracedKey)key=extracedKey;if(!baseUrl&&extracedUrl)baseUrl=nu(extracedUrl);if(!key){await msg.edit({text:`❌ <code>${mp}checkapi speed &lt;key|name&gt;</code>`, parseMode: "html" });return;}const info=baseUrl?await probeApi(baseUrl,key):dp(key,baseUrl);await msg.edit({text:`⚡ ${htmlEscape(info.displayName)} 速度测试中...`, parseMode: "html" });const results=await speedTest(info.provider,key,info.baseUrl);await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });return;}

  // ── compare: two keys side by side ──
  if(sub==="compare"){const [a,b]=[parts[1],parts[2]];if(!a||!b){await msg.edit({text:`❌ <code>${mp}checkapi compare &lt;key1|name1&gt; &lt;key2|name2&gt;</code>`, parseMode: "html" });return;};const keys=await lk();const resolve=(input:string)=>{const f=keys.find(k=>k.name===input);return f?{key:f.key,baseUrl:f.baseUrl,label:f.name}:{key:input,baseUrl:undefined,label:mk(input)};};const r1=resolve(a),r2=resolve(b);const p1=dp(r1.key,r1.baseUrl),p2=dp(r2.key,r2.baseUrl);await msg.edit({text:`🔍 正在对比 <b>${htmlEscape(r1.label)}</b> vs <b>${htmlEscape(r2.label)}</b>...`, parseMode: "html" });const [s1,s2]=await Promise.all([fcv2(p1.provider,r1.key,p1.baseUrl),fcv2(p2.provider,r2.key,r2.baseUrl)]);const m=[`⚖️ <b>${htmlEscape(p1.displayName)}</b> (${r1.label})`,...s1,`\n━━━━━━━━━━━━━━━━`,...s2];await msg.edit({text:`${m.join("\n")}`, parseMode: "html" });return;}

  // ── Inline key: auto-detect + full check ──
  let key:string,baseUrl:string|undefined;let label:string;const keys=await lk();
  if(parts.length>=2&&isUrl(parts[0])){baseUrl=nu(parts[0]);key=parts[1];label=mk(key);}
  else if(parts.length>=2&&isUrl(parts[1])){key=parts[0];baseUrl=nu(parts[1]);const found=keys.find(k=>k.name===key);label=found?found.name:mk(key);key=found?found.key:key;}
  else{const input=parts[0];const found=keys.find(k=>k.name===input);key=found?found.key:input;baseUrl=found?.baseUrl;label=found?found.name:mk(key);}
  let info:PI;if(baseUrl){await msg.edit({text:`🔍 正在识别 API 类型...`, parseMode: "html" });info=await probeApi(baseUrl,key);}else{info=dp(key,baseUrl);}
  await msg.edit({text:`🔍 正在检测 <b>${htmlEscape(label)}</b> (${htmlEscape(info.displayName)})...`, parseMode: "html" });
  const results=await fcv2(info.provider,key,info.baseUrl);
  results.unshift(`🔍 <b>${htmlEscape(label)}</b>`);
  await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });
},};}

export default new CheckApiPlugin();