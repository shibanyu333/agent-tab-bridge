#!/usr/bin/env node
// Agent Tab Bridge — 本地桥接守护进程
// 扩展连 ws://127.0.0.1:8737/extension,agent 连 /agent?token=..&name=..
// 单例:端口即锁;token 存 ~/.agent-tab-bridge/token (0600)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.ATB_PORT || 8737);
const DIR = path.join(os.homedir(), '.agent-tab-bridge');
const TOKEN_FILE = path.join(DIR, 'token');
const LOG_FILE = path.join(DIR, 'bridge.log');

fs.mkdirSync(DIR, { recursive: true });
if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const COLORS = ['blue', 'green', 'red', 'yellow', 'purple', 'pink', 'cyan', 'orange'];
let colorIdx = 0;
let seq = 0;
let extWs = null;
const sessions = new Map(); // sid -> {id, name, color, ws|null}
const pending = new Map();  // bridgeId -> {resolve, reject}

// ---------- 命令转发:agent → 扩展 ----------
function execute(session, action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!extWs || extWs.readyState !== 1) {
      return reject(new Error('extension_not_connected: Chrome 扩展未连接 — 确认 Chrome 已打开且 Agent Tab Bridge 扩展已加载(chrome://extensions)'));
    }
    const id = 'b' + (++seq);
    const extra = Number(params.timeoutMs || params.waitMs || 0);
    const slow = ['screenshot', 'snapshot', 'open_tab', 'navigate', 'upload', 'submit'];
    const timeoutMs = extra + (slow.includes(action) ? 45000 : 20000);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`命令超时(${timeoutMs}ms): ${action}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (d) => { clearTimeout(timer); resolve(d); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    extWs.send(JSON.stringify({
      type: 'command', id,
      sessionId: session.id,
      session: { name: session.name, color: session.color },
      action, params,
    }));
  });
}

function newSession(name, ws = null) {
  const id = 's' + crypto.randomBytes(4).toString('hex');
  const s = { id, name: String(name).slice(0, 20) || 'agent', color: COLORS[colorIdx++ % COLORS.length], ws };
  sessions.set(id, s);
  log(`+session ${id} "${s.name}" (${s.color})${ws ? '' : ' [rest]'}`);
  return s;
}

function endSession(s) {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  log(`-session ${s.id} "${s.name}"`);
  if (extWs?.readyState === 1) {
    extWs.send(JSON.stringify({ type: 'session_closed', sessionId: s.id }));
  }
}

// ---------- WebSocket ----------
// maxPayload 要装得下 upload 的 base64 文件字节(30MB 文件 → 约 40MB base64)
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

function onExtension(ws) {
  if (extWs && extWs !== ws) { try { extWs.close(); } catch {} }
  extWs = ws;
  log('extension connected');
  ws.send(JSON.stringify({
    type: 'sessions_sync',
    sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, color: s.color })),
  }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return ws.send('{"type":"pong"}');
    if (m.type === 'result') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(new Error(m.error)); }
    }
  });
  ws.on('close', () => {
    if (extWs === ws) extWs = null;
    for (const p of pending.values()) p.reject(new Error('扩展连接断开'));
    pending.clear();
    log('extension disconnected');
  });
}

function onAgent(ws, name) {
  const s = newSession(name, ws);
  ws.send(JSON.stringify({ type: 'registered', sessionId: s.id, name: s.name, color: s.color }));
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return ws.send('{"type":"pong"}');
    if (m.type === 'command') {
      try {
        const data = await execute(s, m.action, m.params);
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: String(e?.message || e) }));
      }
    }
  });
  ws.on('close', () => endSession(s));
}

// ---------- HTTP(healthz + REST) ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url.pathname === '/healthz') {
      return send(200, {
        ok: true, service: 'agent-tab-bridge', version: '0.1.0',
        extension: !!(extWs && extWs.readyState === 1),
        sessions: sessions.size,
      });
    }
    if (!url.pathname.startsWith('/v1/')) return send(404, { error: 'not found' });
    if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized(带上 Authorization: Bearer <~/.agent-tab-bridge/token>)' });

    let body = '';
    for await (const chunk of req) body += chunk;
    let json = {};
    if (body) { try { json = JSON.parse(body); } catch { return send(400, { error: 'invalid json' }); } }

    // POST /v1/session {name} → 建会话
    if (req.method === 'POST' && url.pathname === '/v1/session') {
      const s = newSession(json.name || 'rest-agent');
      return send(200, { sessionId: s.id, name: s.name, color: s.color });
    }
    // GET /v1/sessions
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      return send(200, { sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, color: s.color, transport: s.ws ? 'ws' : 'rest' })) });
    }
    // POST /v1/session/:sid/command {action, params}
    const mCmd = url.pathname.match(/^\/v1\/session\/([^/]+)\/command$/);
    if (req.method === 'POST' && mCmd) {
      const s = sessions.get(mCmd[1]);
      if (!s) return send(404, { error: 'session not found' });
      try {
        const data = await execute(s, json.action, json.params || {});
        return send(200, { ok: true, data });
      } catch (e) {
        return send(500, { ok: false, error: String(e?.message || e) });
      }
    }
    // DELETE /v1/session/:sid
    const mDel = url.pathname.match(/^\/v1\/session\/([^/]+)$/);
    if (req.method === 'DELETE' && mDel) {
      const s = sessions.get(mDel[1]);
      if (s) endSession(s);
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: String(e?.message || e) });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/extension') {
    // 拒绝网页 JS(Origin 一定是 http/https);扩展 SW 的 WebSocket 可能带 chrome-extension:// 或不带 Origin
    const origin = req.headers.origin || '';
    if (/^https?:\/\//.test(origin)) {
      log(`拒绝 /extension 连接,可疑 Origin: ${origin}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, onExtension);
  } else if (url.pathname === '/agent') {
    if (url.searchParams.get('token') !== TOKEN) { socket.destroy(); return; }
    const name = url.searchParams.get('name') || 'agent';
    wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, name));
  } else {
    socket.destroy();
  }
});

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      const j = await r.json();
      if (j.service === 'agent-tab-bridge') { log('已有实例在运行,本进程退出'); process.exit(0); }
    } catch {}
    log(`端口 ${PORT} 被其他程序占用`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => log(`bridge listening on 127.0.0.1:${PORT}`));
