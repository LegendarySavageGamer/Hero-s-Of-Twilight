const MAX_BODY_BYTES = 1536 * 1024;
const MAX_TEXT = 1500;
const MAX_BEFORE = 1000;
const MAX_TITLE = 100;
const CODE_RE = /^HOT-[0-9A-F]{16}$/;
const CATEGORIES = new Set(["Crash","Twilight Connected","Hyrule Online","Story Sync","Enemy Sync","Boss Sync","Player Sync","Items / Objects","Death Link","Randomizer","Cosmetics / Skins","UI","Performance","Other"]);
const REPRO = new Set(["Always","Sometimes","Once","Not Sure"]);
const recent = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 8;
const IMAGE_MAX = 10 * 1024 * 1024;
const VIDEO_MAX = 50 * 1024 * 1024;

function limited(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= PER_WINDOW) { recent.set(ip, list); return true; }
  list.push(now); recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
  return false;
}
function newCode() {
  const b = new Uint8Array(8); crypto.getRandomValues(b);
  return "HOT-" + [...b].map((x) => x.toString(16).padStart(2,"0")).join("").toUpperCase();
}
function clip(v,max){ const s=typeof v==="string"?v:""; return s.length>max?s.slice(0,max)+"…":s; }
function safe(s){ return s.replace(/@/g,"@​").replace(/`/g,"'"); }
function json(obj,status=200){ return new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}}); }
function reportText(code,b){
  return `HEROES OF TWILIGHT\nBUG REPORT\n\nReport ID: ${code}\nReported Username: ${clip(b.player,40)||"?"}\nVersion: ${clip(b.mod,20)||"?"}\nPlatform: ${clip(b.platform,20)||"?"}\nCategory: ${clip(b.category,40)||"Other"}\nTitle: ${clip(b.title,MAX_TITLE)}\nReproducibility: ${clip(b.reproduce,20)||"Not Sure"}\nWhen: ${clip(b.when,60)}\nSubmitted: ${new Date().toISOString()}\n\nDescription:\n${clip(b.text,MAX_TEXT)}\n\nBefore it happened:\n${clip(b.before,MAX_BEFORE)}\n\n--- session diagnostics ---\n${clip(b.session,5000)}\n\n--- co-op diagnostics ---\n${clip(b.log,MAX_BODY_BYTES)}`;
}
async function reserveReport(env,code,body,text){
  if (!env.REPORT_MEDIA) return;
  await env.REPORT_MEDIA.put(`reports/${code}/report.txt`, text, {httpMetadata:{contentType:"text/plain; charset=utf-8"}, customMetadata:{reportedUsername:clip(body.player,40),category:clip(body.category,40),version:clip(body.mod,20)}});
}
async function deliver(env,code,body,text){
  let delivered=false;
  const subject=`[Heroes of Twilight][${code}][${clip(body.category,40)||"Other"}] ${clip(body.title,MAX_TITLE)||"Bug report"}`;
  if (env.EMAIL && env.REPORT_DESTINATION_EMAIL && env.REPORT_FROM_EMAIL) {
    await env.EMAIL.send({to:env.REPORT_DESTINATION_EMAIL,from:env.REPORT_FROM_EMAIL,subject,text});
    delivered=true;
  }
  if (env.REPORT_WEBHOOK) {
    const form=new FormData();
    const content=`**${safe(subject)}**\nReported Username: **${safe(clip(body.player,40)||"?")}**`;
    form.append("payload_json",JSON.stringify({content,allowed_mentions:{parse:[]}}));
    form.append("files[0]",new Blob([text],{type:"text/plain"}),`${code}-report.txt`);
    const sent=await fetch(env.REPORT_WEBHOOK,{method:"POST",body:form});
    if (sent.ok) delivered=true;
  }
  return delivered;
}

export async function handleReport(request,env){
  if(request.method!=="POST") return json({error:"POST only"},405);
  const length=Number(request.headers.get("Content-Length")||0);
  if(length>MAX_BODY_BYTES) return json({error:"too large"},413);
  const ip=request.headers.get("CF-Connecting-IP")||"unknown";
  if(limited(ip)) return json({error:"too many"},429);
  let body;
  try { const text=await request.text(); if(text.length>MAX_BODY_BYTES)return json({error:"too large"},413); body=JSON.parse(text); }
  catch { return json({error:"bad request"},400); }
  const kind=body.kind==="log"?"log":"report";
  if(kind==="log"){
    const code=typeof body.code==="string"&&CODE_RE.test(body.code)?body.code:"";
    if(!code)return json({error:"bad code"},400);
    const log=`HEROES OF TWILIGHT\nPEER LOG FOR ${code}\nReported Username: ${clip(body.player,40)||"?"}\nVersion: ${clip(body.mod,20)||"?"}\n\n${clip(body.session,5000)}\n\n${clip(body.log,MAX_BODY_BYTES)}`;
    if(env.REPORT_MEDIA) await env.REPORT_MEDIA.put(`reports/${code}/peer-${crypto.randomUUID()}.txt`,log,{httpMetadata:{contentType:"text/plain; charset=utf-8"}});
    if(env.REPORT_WEBHOOK){ const form=new FormData(); form.append("payload_json",JSON.stringify({content:`↳ ${code}: peer log from **${safe(clip(body.player,40)||"?")}**`,allowed_mentions:{parse:[]}})); form.append("files[0]",new Blob([log],{type:"text/plain"}),`${code}-peer.txt`); await fetch(env.REPORT_WEBHOOK,{method:"POST",body:form}); }
    return json({code});
  }
  if(!clip(body.text,MAX_TEXT).trim()||!clip(body.title,MAX_TITLE).trim()) return json({error:"missing fields"},400);
  if(!CATEGORIES.has(body.category)) body.category="Other";
  if(!REPRO.has(body.reproduce)) body.reproduce="Not Sure";
  let code=newCode();
  if(env.REPORT_MEDIA){ for(let i=0;i<5;i++){ if(!(await env.REPORT_MEDIA.head(`reports/${code}/report.txt`)))break; code=newCode(); } }
  const text=reportText(code,body);
  try { await reserveReport(env,code,body,text); }
  catch(e){ console.error("[REPORT] storage failed",String(e)); return json({error:"storage unavailable"},503); }
  try {
    if(!(await deliver(env,code,body,text))) {
      if(env.REPORT_MEDIA) return json({code,delivery:"pending"},202);
      return json({error:"delivery not configured"},503);
    }
  } catch(e){
    console.error("[REPORT] delivery failed",String(e));
    if(env.REPORT_MEDIA) return json({code,delivery:"pending"},202);
    return json({error:"delivery failed"},502);
  }
  console.log(`[REPORT] Submitted ${code}`);
  return json({code});
}

function mediaType(bytes,kind){
  const u=new Uint8Array(bytes);
  if(kind==="screenshot"){
    if(u.length>=8&&u[0]===0x89&&u[1]===0x50&&u[2]===0x4e&&u[3]===0x47&&u[4]===0x0d&&u[5]===0x0a&&u[6]===0x1a&&u[7]===0x0a)return ["image/png","png"];
    if(u.length>=3&&u[0]===0xff&&u[1]===0xd8&&u[2]===0xff)return ["image/jpeg","jpg"];
  }
  if(kind==="video"&&u.length>=12&&u[4]===0x66&&u[5]===0x74&&u[6]===0x79&&u[7]===0x70){
    const brand=String.fromCharCode(...u.slice(8,12));
    return [brand==="qt  "?"video/quicktime":"video/mp4",brand==="qt  "?"mov":"mp4"];
  }
  return null;
}
export async function handleReportMedia(request,env){
  if(request.method!=="POST")return json({error:"POST only"},405);
  if(!env.REPORT_MEDIA)return json({error:"media storage unavailable"},503);
  const url=new URL(request.url),code=(url.searchParams.get("code")||"").toUpperCase(),kind=url.searchParams.get("kind")||"";
  if(!CODE_RE.test(code)||!(kind==="screenshot"||kind==="video"))return json({error:"bad request"},400);
  if(!(await env.REPORT_MEDIA.head(`reports/${code}/report.txt`)))return json({error:"unknown report"},404);
  const max=kind==="screenshot"?IMAGE_MAX:VIDEO_MAX;
  const length=Number(request.headers.get("Content-Length")||0); if(length>max)return json({error:"too large",max_bytes:max},413);
  const bytes=await request.arrayBuffer(); if(bytes.byteLength>max)return json({error:"too large",max_bytes:max},413);
  const detected=mediaType(bytes,kind); if(!detected)return json({error:"unsupported media"},415);
  const [contentType,ext]=detected,key=`reports/${code}/${kind}-${crypto.randomUUID()}.${ext}`;
  await env.REPORT_MEDIA.put(key,bytes,{httpMetadata:{contentType}});
  return json({ok:true,kind,size:bytes.byteLength});
}
