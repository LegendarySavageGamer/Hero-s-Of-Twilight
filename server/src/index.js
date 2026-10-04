

import { handleReport, handleReportMedia } from "./report.js";
import { cleanChat, cleanName } from "./filter.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const NAME_MIN = 4;
const NAME_MAX = 24;
const MAX_JOINERS_WAITING = 8;

const HOST_KEY = /^[0-9a-f]{16,64}$/;
const MAX_MESSAGE_BYTES = 1024;

const STUN_HOSTS = [
  ["stun.l.google.com", 19302],
  ["stun1.l.google.com", 19302],
  ["stun.cloudflare.com", 3478],
];

function newCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function normalizeCode(text) {
  if (!text) return "";
  const code = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < NAME_MIN || code.length > NAME_MAX) return "";
  return code;
}

function newToken() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIpv4 = (s) => typeof s === "string" && IPV4.test(s);

const isPrivateIpv4 = (s) =>
  isIpv4(s) && (/^10\./.test(s) || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s));

function isEndpoint(s) {
  if (typeof s !== "string") return false;
  const at = s.lastIndexOf(":");
  if (at < 0) return false;
  const port = Number(s.slice(at + 1));
  return isIpv4(s.slice(0, at)) && Number.isInteger(port) && port > 0 && port < 65536;
}

const isPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;

let stunCache = { at: 0, list: [] };

async function stunServers() {
  if (stunCache.list.length > 0 && Date.now() - stunCache.at < 3600_000) return stunCache.list;
  const list = [];
  await Promise.all(
    STUN_HOSTS.map(async ([name, port]) => {
      try {
        const r = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${name}&type=A`,
          { headers: { accept: "application/dns-json" } },
        );
        const body = await r.json();
        const a = (body.Answer || []).find((x) => x.type === 1 && isIpv4(x.data));
        const ep = a ? `${a.data}:${port}` : "";
        if (ep && !list.includes(ep)) list.push(ep);
      } catch {

      }
    }),
  );
  if (list.length > 0) stunCache = { at: Date.now(), list };
  return list;
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {

  }
}

function fail(ws, why, detail) {
  send(ws, { op: "error", why, detail });
  try {
    ws.close(4000, why);
  } catch {

  }
}

function candidates(info, sameNet = false, otherLan = "") {
  const out = [];
  const add = (ep) => {
    if (!out.includes(ep)) out.push(ep);
  };
  const lan = sameNet && isPrivateIpv4(info.lan) && isPort(info.port);
  if (lan) add(`${info.lan}:${info.port}`);
  if (isEndpoint(info.ep)) add(info.ep);
  if (isIpv4(info.ip) && isPort(info.port)) add(`${info.ip}:${info.port}`);
  if (sameNet && isPort(info.port) && (!lan || info.lan === otherLan)) add(`127.0.0.1:${info.port}`);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/report") return handleReport(request, env);
    if (url.pathname === "/report-media") return handleReportMedia(request, env);
    if (url.pathname === "/global") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Heroes of Twilight — Hyrule Online server is online.\n", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const global = env.GLOBAL.get(env.GLOBAL.idFromName("global-twilight"));
      return global.fetch(request);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Heroes of Twilight room server.\n");
    }

    if (url.pathname === "/host") {

      const named = url.searchParams.get("strict") === "1";
      const hostKey = HOST_KEY.test(url.searchParams.get("key") || "") ? url.searchParams.get("key") : "";
      const reclaim = normalizeCode(url.searchParams.get("code"));
      if (named) {
        if (!reclaim) return new Response("That is not a room name", { status: 400 });
        const room = env.ROOMS.get(env.ROOMS.idFromName(reclaim));
        return room.fetch(
          new Request(`https://room/host?code=${reclaim}&strict=1&key=${hostKey}`, request),
        );
      }

      for (let attempt = 0; attempt < 8; ++attempt) {
        const code = attempt === 0 && reclaim ? reclaim : newCode();
        const room = env.ROOMS.get(env.ROOMS.idFromName(code));
        const response = await room.fetch(
          new Request(`https://room/host?code=${code}&key=${hostKey}`, request),
        );
        if (response.status !== 409) return response;
      }
      return new Response("Could not find a free room code", { status: 503 });
    }

    const join = url.pathname.match(/^\/join\/([A-Za-z0-9-]+)$/);
    if (join) {
      const code = normalizeCode(join[1]);
      if (!code) return new Response("That is not a room code", { status: 400 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch(new Request(`https://room/join?code=${code}`, request));
    }

    return new Response("Not found", { status: 404 });
  },
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  host(except = null) {
    for (const ws of this.ctx.getWebSockets("host")) {
      if (ws === except) continue;
      const info = ws.deserializeAttachment() || {};
      if (info.role === "host") return ws;
    }
    return null;
  }

  getOtherHost(except) {
    return this.host(except);
  }

  takeOver(key) {
    if (!HOST_KEY.test(key || "")) return false;
    const old = this.host();
    if (!old) return false;
    const info = old.deserializeAttachment() || {};
    if (info.key !== key) return false;
    try {

      old.serializeAttachment({ ...info, role: "replaced" });
      old.close(4001, "replaced by the same player");
    } catch {

    }
    return true;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.pathname === "/host" ? "host" : "join";
    const code = url.searchParams.get("code");
    const ip = request.headers.get("CF-Connecting-IP") || "";

    const strict = url.searchParams.get("strict") === "1";
    const key = url.searchParams.get("key") || "";
    if (role === "host") this.takeOver(key);
    if (role === "host" && this.host() && !strict) {
      return new Response("Room taken", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);

    server.serializeAttachment({ role, ip, hello: null, key: HOST_KEY.test(key) ? key : "" });

    if (role === "host" && strict && this.getOtherHost(server)) {

      server.serializeAttachment({ role: "rejected", ip, hello: null });
      fail(server, "taken");
    } else if (role === "join") {
      if (!this.host()) {
        fail(server, "no_room");
      } else if (this.ctx.getWebSockets("join").length > MAX_JOINERS_WAITING) {
        fail(server, "busy");
      } else {
        send(server, { op: "welcome", ip, stun: await stunServers() });
      }
    } else {
      send(server, { op: "welcome", code, ip, stun: await stunServers() });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES) {
      return fail(ws, "bad_message");
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return fail(ws, "bad_message");
    }
    const me = ws.deserializeAttachment();

    if (me.role === "host") {
      if (msg.op === "hello") {
        me.hello = {
          v: Number(msg.v) || 0,
          ep: isEndpoint(msg.ep) ? msg.ep : "",
          port: isPort(msg.port) ? msg.port : 0,
          upnp: isEndpoint(msg.upnp) ? msg.upnp : "",
          lan: isPrivateIpv4(msg.lan) ? msg.lan : "",
        };
        ws.serializeAttachment(me);

        for (const j of this.ctx.getWebSockets("join")) {
          const info = j.deserializeAttachment();
          if (info.hello && !info.paired) this.pair(ws, me, j, info);
        }
      } else if (msg.op === "update" && me.hello) {
        me.hello.upnp = isEndpoint(msg.upnp) ? msg.upnp : "";
        ws.serializeAttachment(me);
      }
      return;
    }

    if (msg.op !== "hello" || me.hello) return fail(ws, "bad_message");
    me.hello = {
      v: Number(msg.v) || 0,
      ep: isEndpoint(msg.ep) ? msg.ep : "",
      port: isPort(msg.port) ? msg.port : 0,
      lan: isPrivateIpv4(msg.lan) ? msg.lan : "",
    };
    ws.serializeAttachment(me);
    const host = this.host();
    if (!host) return fail(ws, "no_room");
    const hostInfo = host.deserializeAttachment();
    if (hostInfo.hello) this.pair(host, hostInfo, ws, me);
  }

  pair(hostWs, hostInfo, joinWs, joinInfo) {
    if (hostInfo.hello.v !== joinInfo.hello.v) {

      send(hostWs, { op: "joiner_version", v: String(joinInfo.hello.v) });
      return fail(joinWs, "version", String(hostInfo.hello.v));
    }
    const token = newToken();

    const outside = (ep) => (isEndpoint(ep) ? ep.slice(0, ep.lastIndexOf(":")) : "");
    const sameNet =
      (hostInfo.ip !== "" && hostInfo.ip === joinInfo.ip) ||
      (outside(hostInfo.hello.ep) !== "" &&
        outside(hostInfo.hello.ep) === outside(joinInfo.hello.ep));
    send(hostWs, {
      op: "peer",
      token,
      eps: candidates({ ...joinInfo.hello, ip: joinInfo.ip }, sameNet, hostInfo.hello.lan),
      sameNet,
    });
    send(joinWs, {
      op: "peer",
      token,
      eps: candidates({ ...hostInfo.hello, ip: hostInfo.ip }, sameNet, joinInfo.hello.lan),
      upnp: hostInfo.hello.upnp,
      sameNet,
    });
    joinInfo.paired = true;
    joinWs.serializeAttachment(joinInfo);
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {

    }
    const me = ws.deserializeAttachment();

    if (me && me.role === "host") {
      for (const j of this.ctx.getWebSockets("join")) fail(j, "no_room");
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}


const GLOBAL_CHAT_MAX = 100;
const GLOBAL_CHAT_GAP_MS = 2000;
const GLOBAL_AREA = /^[A-Za-z0-9_]{0,8}$/;

function globalPrintable(text, max) {
  return String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

async function globalTagOf(key) {
  if (typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key)) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Global {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
  }

  sockets() { return this.ctx.getWebSockets("global"); }

  activeSockets() {
    return this.sockets().filter((ws) => (ws.deserializeAttachment() || {}).active === true);
  }

  nextPlayerId() {
    const used = new Set(this.activeSockets().map((ws) => (ws.deserializeAttachment() || {}).id));
    for (let id = 1; id <= 0x7fffffff; ++id) if (!used.has(id)) return id;
    return Date.now() & 0x7fffffff;
  }

  byId(id) {
    return this.activeSockets().find((ws) => (ws.deserializeAttachment() || {}).id === id) || null;
  }

  counts(area) {
    let total = 0, here = 0;
    for (const ws of this.activeSockets()) {
      const info = ws.deserializeAttachment() || {};
      if (!info.hello) continue;
      ++total;
      if (area && info.area === area) ++here;
    }
    return { total, here };
  }

  sendCount(ws) {
    const info = ws.deserializeAttachment() || {};
    try { ws.send(JSON.stringify({ op: "count", ...this.counts(info.area || "") })); } catch {}
  }

  broadcastCounts() { for (const ws of this.activeSockets()) this.sendCount(ws); }

  blocked(a, b) {
    return (a.blocks || []).includes(b.id) || (b.blocks || []).includes(a.id);
  }

  refreshPeers() {
    const all = this.activeSockets();
    for (const ws of all) {
      const me = ws.deserializeAttachment() || {};
      if (!me.hello) continue;
      for (const other of all) {
        if (other === ws) continue;
        const them = other.deserializeAttachment() || {};
        if (!them.hello || !me.area || them.area !== me.area || this.blocked(me, them)) continue;
        try { ws.send(JSON.stringify({ op: "peer", id: them.id, tag: them.tag || "", name: them.name || "Player" })); } catch {}
      }
    }
  }

  broadcastGone(id) {
    for (const ws of this.activeSockets()) {
      try { ws.send(JSON.stringify({ op: "gone", id })); } catch {}
    }
  }

  markInactive(ws) {
    const info = ws.deserializeAttachment() || {};
    if (info.active === false) return info;
    const updated = { ...info, active: false };
    try { ws.serializeAttachment(updated); } catch {}
    return updated;
  }

  removePlayer(ws) {
    const info = this.markInactive(ws);
    if (Number.isInteger(info.id)) this.broadcastGone(info.id);
    this.broadcastCounts();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["global"]);
    const id = this.nextPlayerId();
    server.serializeAttachment({ id, active: true, hello: false, name: "Player", tag: "", area: "", blocks: [], lastChat: 0 });
    server.send(`ID ${id}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const me = ws.deserializeAttachment() || {};
    if (me.active !== true) return;

    if (typeof message !== "string") {
      const size = message?.byteLength ?? 0;
      if (size <= 0 || size > 65536) { this.removePlayer(ws); try { ws.close(1009, "binary message too large"); } catch {} return; }
      for (const other of this.activeSockets()) {
        if (other === ws) continue;
        const them = other.deserializeAttachment() || {};
        if (!me.hello || !them.hello || !me.area || me.area !== them.area || this.blocked(me, them)) continue;
        try { other.send(message instanceof ArrayBuffer ? message.slice(0) : message); } catch {}
      }
      return;
    }

    if (message.length > 2048) { this.removePlayer(ws); try { ws.close(1009, "message too large"); } catch {} return; }
    const text = message.trim();
    if (text === "PING") { try { ws.send("PONG"); } catch {} return; }
    if (text === "COUNT") { this.sendCount(ws); return; }
    if (text === "BYE") { this.removePlayer(ws); try { ws.close(1000, "bye"); } catch {} return; }

    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.op === "hello" && !me.hello) {
      me.hello = true;
      me.name = cleanName(globalPrintable(msg.name, 16)) || "Player";
      me.tag = await globalTagOf(msg.key);
      ws.serializeAttachment(me);
      try { ws.send("READY VISUAL2"); } catch {}
      this.broadcastCounts();
      this.refreshPeers();
      return;
    }

    if (msg.op === "area" && me.hello) {
      const area = typeof msg.stage === "string" && GLOBAL_AREA.test(msg.stage) ? msg.stage : "";
      if (area !== me.area) {
        me.area = area;
        ws.serializeAttachment(me);
        this.broadcastGone(me.id);
        this.refreshPeers();
      }
      this.broadcastCounts();
      return;
    }

    if (msg.op === "chat" && me.hello) {
      const now = Date.now();
      if (now - (me.lastChat || 0) < GLOBAL_CHAT_GAP_MS) { try { ws.send(JSON.stringify({ op: "chat_slow" })); } catch {} return; }
      const line = cleanChat(globalPrintable(msg.text, GLOBAL_CHAT_MAX));
      if (!line) return;
      me.lastChat = now; ws.serializeAttachment(me);
      for (const other of this.activeSockets()) {
        const them = other.deserializeAttachment() || {};
        if (!them.hello || this.blocked(me, them)) continue;
        try { other.send(JSON.stringify({ op: "chat", id: me.id, tag: me.tag || "", name: me.name, text: line })); } catch {}
      }
      return;
    }

    if ((msg.op === "block" || msg.op === "unblock") && me.hello) {
      const id = Number(msg.id);
      if (!Number.isInteger(id) || id <= 0) return;
      me.blocks = (me.blocks || []).filter((x) => x !== id);
      if (msg.op === "block") me.blocks.push(id);
      ws.serializeAttachment(me);
      const other = this.byId(id);
      if (msg.op === "block") {
        try { ws.send(JSON.stringify({ op: "gone", id })); } catch {}
        if (other) { try { other.send(JSON.stringify({ op: "gone", id: me.id })); } catch {} }
      }
      this.refreshPeers();
      return;
    }
  }

  async webSocketClose(ws) { this.removePlayer(ws); }
  async webSocketError(ws) { this.removePlayer(ws); }
}
