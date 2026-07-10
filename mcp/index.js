#!/usr/bin/env node
// Agent Tab Bridge — MCP stdio server
// 任何支持 MCP 的 agent 工具(Claude Code / Codex CLI / Cursor…)都可以接:
//   claude mcp add tab-bridge -- node /path/to/mcp/index.js
// 每个 MCP 进程 = 一个会话 = Chrome 里一个彩色标签组;标签全部后台打开。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.ATB_PORT || 8737);
const DIR = path.join(os.homedir(), '.agent-tab-bridge');
const TOKEN_FILE = path.join(DIR, 'token');
const BRIDGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bridge/server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 桥连接 ----------
let ws = null;
let seq = 0;
let sessionInfo = null;
const pending = new Map();

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.service === 'agent-tab-bridge';
  } catch { return false; }
}

async function ensureBridge() {
  if (await healthy()) return;
  const child = spawn(process.execPath, [BRIDGE_PATH], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (await healthy()) return;
  }
  throw new Error(`bridge 启动失败 — 手动运行排查: node ${BRIDGE_PATH}`);
}

function sessionName() {
  if (process.env.AGENT_NAME) return process.env.AGENT_NAME.slice(0, 16);
  const client = server.server.getClientVersion?.()?.name || 'agent';
  return client.replace(/[^\w一-龥-]/g, '').slice(0, 16) || 'agent';
}

async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  await ensureBridge();
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const name = sessionName();
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/agent?token=${token}&name=${encodeURIComponent(name)}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 bridge 超时')), 8000);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'registered') {
        sessionInfo = m;
        clearTimeout(timer);
        resolve();
      } else if (m.type === 'result') {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(new Error(m.error)); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('bridge 连接断开'));
      pending.clear();
      if (ws === sock) ws = null;
    });
  });
  ws = sock;
}

async function cmd(action, params = {}) {
  await ensureConnected();
  const id = 'm' + (++seq);
  const extra = Number(params.timeoutMs || params.waitMs || 0);
  const timeoutMs = extra + 60000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`命令超时: ${action}`)); }, timeoutMs);
    pending.set(id, {
      resolve: (d) => { clearTimeout(timer); resolve(d); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ type: 'command', id, action, params }));
  });
}

// ---------- MCP ----------
const server = new McpServer({ name: 'agent-tab-bridge', version: '0.1.0' });

const text = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }],
});
const errText = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true });
const run = (fn) => async (args) => { try { return await fn(args); } catch (e) { return errText(e); } };

server.tool(
  'browser_open_tab',
  '在本 agent 的彩色标签组中后台打开新标签页(不抢用户焦点),返回 tabId。',
  { url: z.string().describe('要打开的网址') },
  run(async ({ url }) => text(await cmd('open_tab', { url })))
);

server.tool(
  'browser_list_tabs',
  '列出本会话拥有的标签页(只能操作这些 tab)。',
  {},
  run(async () => text(await cmd('list_tabs')))
);

server.tool(
  'browser_close_tab',
  '关闭本会话的一个标签页。',
  { tabId: z.number() },
  run(async ({ tabId }) => text(await cmd('close_tab', { tabId })))
);

server.tool(
  'browser_navigate',
  '导航标签页:传网址,或 back / forward / reload。',
  { tabId: z.number(), url: z.string().describe('网址 | back | forward | reload') },
  run(async ({ tabId, url }) => text(await cmd('navigate', { tabId, url })))
);

server.tool(
  'browser_snapshot',
  '获取页面可交互元素快照(uid 编号文本树)。操作元素前先调这个拿 uid;页面变化后需重拍。',
  { tabId: z.number(), maxChars: z.number().optional().describe('默认 20000') },
  run(async ({ tabId, maxChars }) => {
    const r = await cmd('snapshot', { tabId, maxChars });
    return text(r.text + `\n\n(共 ${r.elements} 个交互元素${r.truncated ? ',已截断' : ''})`);
  })
);

server.tool(
  'browser_screenshot',
  '截取标签页画面(后台标签也可截)。首次使用会在浏览器顶部出现"正在调试"提示条,属正常现象。',
  { tabId: z.number(), fullPage: z.boolean().optional(), format: z.enum(['png', 'jpeg', 'webp']).optional() },
  run(async ({ tabId, fullPage, format }) => {
    const r = await cmd('screenshot', { tabId, fullPage, format });
    return { content: [{ type: 'image', data: r.base64, mimeType: r.mimeType }] };
  })
);

server.tool(
  'browser_click',
  '点击 snapshot 里的元素。默认合成事件(零打扰);复杂前端不响应时传 realEvents:true 用真实鼠标事件。',
  { tabId: z.number(), uid: z.string(), dblClick: z.boolean().optional(), realEvents: z.boolean().optional() },
  run(async (a) => text(await cmd('click', a)))
);

server.tool(
  'browser_fill',
  '向输入框/文本域/下拉框/富文本填入内容(兼容 React/Vue 受控组件);checkbox 传 "true"/"false"。',
  { tabId: z.number(), uid: z.string(), text: z.string(), realEvents: z.boolean().optional() },
  run(async (a) => text(await cmd('fill', a)))
);

server.tool(
  'browser_fill_form',
  '批量填表:一次填多个字段,返回每个字段的结果。',
  { tabId: z.number(), fields: z.array(z.object({ uid: z.string(), value: z.string() })) },
  run(async (a) => text(await cmd('fill_form', a)))
);

server.tool(
  'browser_select',
  '选择 <select> 下拉框的选项(按 value 或显示文本匹配,支持多选)。',
  { tabId: z.number(), uid: z.string(), values: z.array(z.string()) },
  run(async (a) => text(await cmd('select', a)))
);

server.tool(
  'browser_hover',
  '悬停到元素上(触发下拉菜单等 hover 效果)。',
  { tabId: z.number(), uid: z.string() },
  run(async (a) => text(await cmd('hover', a)))
);

server.tool(
  'browser_press_key',
  '按键,如 Enter、Escape、Tab、ArrowDown、Ctrl+a。要触发表单提交等浏览器默认行为需 realEvents:true。',
  { tabId: z.number(), key: z.string(), uid: z.string().optional().describe('先聚焦到该元素'), realEvents: z.boolean().optional() },
  run(async (a) => text(await cmd('press_key', a)))
);

server.tool(
  'browser_scroll',
  '滚动页面:uid=滚到元素;to=top/bottom/像素值;by=相对滚动(默认一屏)。',
  { tabId: z.number(), uid: z.string().optional(), to: z.union([z.enum(['top', 'bottom']), z.number()]).optional(), by: z.number().optional() },
  run(async (a) => text(await cmd('scroll', a)))
);

server.tool(
  'browser_evaluate',
  '在页面执行 JS 函数并返回 JSON 结果,如 () => document.title 或 async () => {...}。',
  { tabId: z.number(), fn: z.string().describe('函数声明,如 () => document.title') },
  run(async (a) => text(await cmd('evaluate', a)))
);

server.tool(
  'browser_wait_for',
  '等待页面出现(或消失)某段文本 / 某个 CSS 选择器。',
  { tabId: z.number(), text: z.string().optional(), selector: z.string().optional(), gone: z.boolean().optional(), timeoutMs: z.number().optional() },
  run(async (a) => text(await cmd('wait_for', a)))
);

server.tool(
  'browser_console',
  '读取标签页 console 消息(需要挂调试器,会出现提示条)。',
  { tabId: z.number(), limit: z.number().optional() },
  run(async (a) => text(await cmd('console', a)))
);

server.tool(
  'browser_extract',
  '提取页面文本或 HTML(可用 CSS 选择器限定范围),适合读长内容。',
  { tabId: z.number(), selector: z.string().optional(), format: z.enum(['text', 'html']).optional(), maxChars: z.number().optional() },
  run(async (a) => text(await cmd('extract', a)))
);

server.tool(
  'browser_activate_tab',
  '把标签页带到前台给用户看(会抢焦点,仅在用户要求看时使用)。',
  { tabId: z.number() },
  run(async (a) => text(await cmd('activate_tab', a)))
);

server.tool(
  'browser_session_end',
  '清理本会话:关闭本 agent 打开的所有标签页及其分组。',
  { closeTabs: z.boolean().optional().describe('默认 true') },
  run(async (a) => text(await cmd('session_end', a)))
);

const transport = new StdioServerTransport();
await server.connect(transport);
