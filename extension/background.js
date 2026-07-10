// Agent Tab Bridge — service worker
// 连本地桥,按会话把命令路由到各自的标签组;所有 tab 后台创建,不抢用户焦点
import { dbgAttach, dbgSend, dbgConsole, dbgDetachTab } from './debugger.js';

const BRIDGE_URL = 'ws://127.0.0.1:8737/extension';
const COLORS = ['blue', 'green', 'red', 'yellow', 'purple', 'pink', 'cyan', 'orange'];

let ws = null;
let connected = false;
let reconnectDelay = 1000;
let pingTimer = null;

/** sid -> {id, name, color, groupId, tabIds:Set<number>, active} */
const sessions = new Map();
/** tabId -> sid */
const tabOwner = new Map();

// ---------- 持久化(SW 重启恢复) ----------
function persist() {
  const data = [...sessions.values()].map((s) => ({ ...s, tabIds: [...s.tabIds] }));
  chrome.storage.session.set({ atbState: data }).catch(() => {});
}
async function restore() {
  const { atbState } = await chrome.storage.session.get('atbState');
  if (!atbState) return;
  for (const raw of atbState) {
    const s = { ...raw, tabIds: new Set() };
    for (const tid of raw.tabIds || []) {
      try { await chrome.tabs.get(tid); s.tabIds.add(tid); tabOwner.set(tid, s.id); } catch {}
    }
    sessions.set(s.id, s);
  }
}

// ---------- 桥连接 ----------
function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(BRIDGE_URL); } catch { return scheduleReconnect(); }
  ws.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'register', role: 'extension', version: chrome.runtime.getManifest().version }));
    clearInterval(pingTimer);
    // WS 活动让 SW 保活(Chrome ≥116)
    pingTimer = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch {} }, 20000);
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleBridgeMessage(m);
  };
  ws.onclose = () => { connected = false; clearInterval(pingTimer); scheduleReconnect(); };
  ws.onerror = () => {};
}
function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, 15000);
}
chrome.alarms.create('atb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'atb-keepalive' && !connected) connect(); });

restore().then(connect);

// ---------- 会话 ----------
function ensureSession(sid, info = {}) {
  let s = sessions.get(sid);
  if (s) {
    if (info.name) s.name = info.name;
    if (info.color) s.color = info.color;
    s.active = true;
    return s;
  }
  // MCP 重启延续:同名的已结束会话 → 继承它的分组和标签
  for (const [oldId, old] of sessions) {
    if (!old.active && info.name && old.name === info.name) {
      sessions.delete(oldId);
      old.id = sid;
      old.active = true;
      if (info.color) old.color = info.color;
      for (const tid of old.tabIds) tabOwner.set(tid, sid);
      sessions.set(sid, old);
      persist();
      return old;
    }
  }
  s = {
    id: sid,
    name: info.name || sid.slice(0, 8),
    color: info.color || COLORS[sessions.size % COLORS.length],
    groupId: null,
    tabIds: new Set(),
    active: true,
  };
  sessions.set(sid, s);
  persist();
  return s;
}

async function handleBridgeMessage(m) {
  if (m.type === 'command') {
    const t0 = Date.now();
    let reply;
    try {
      const session = ensureSession(m.sessionId, m.session);
      const handler = handlers[m.action];
      if (!handler) throw new Error(`unknown action: ${m.action}`);
      const data = await handler(session, m.params || {});
      reply = { type: 'result', id: m.id, ok: true, data, ms: Date.now() - t0 };
    } catch (e) {
      reply = { type: 'result', id: m.id, ok: false, error: String(e?.message || e) };
    }
    try { ws.send(JSON.stringify(reply)); } catch {}
  } else if (m.type === 'session_closed') {
    const s = sessions.get(m.sessionId);
    if (s) { s.active = false; persist(); }
  } else if (m.type === 'sessions_sync') {
    for (const info of m.sessions || []) ensureSession(info.id, info);
  }
}

// ---------- tab 归属 / 分组 ----------
function owned(s, tabId) {
  if (tabOwner.get(tabId) !== s.id) {
    throw new Error(`tab ${tabId} 不属于会话 "${s.name}" — 只能操作本会话打开的标签页(用 open_tab / list_tabs)`);
  }
}

async function pickWindow(s) {
  if (s.groupId != null) {
    try { return (await chrome.tabGroups.get(s.groupId)).windowId; } catch { s.groupId = null; }
  }
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  return w?.id;
}

async function addToGroup(s, tabId) {
  try {
    if (s.groupId != null) {
      try { await chrome.tabs.group({ tabIds: [tabId], groupId: s.groupId }); return; } catch { s.groupId = null; }
    }
    s.groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(s.groupId, { title: s.name, color: s.color });
  } catch { /* 分组是视觉标识,失败不影响命令本身 */ }
}

async function ownTab(s, tabId) {
  tabOwner.set(tabId, s.id);
  s.tabIds.add(tabId);
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch {}
  await addToGroup(s, tabId);
  persist();
}

function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      try {
        const t = await chrome.tabs.get(tabId);
        resolve({ url: t.url, title: t.title, status: t.status });
      } catch { resolve({ url: '', title: '', status: 'closed' }); }
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

// 会话 tab 里点开的新标签(target=_blank 等)自动收编进同一分组
chrome.tabs.onCreated.addListener(async (tab) => {
  const sid = tab.openerTabId != null ? tabOwner.get(tab.openerTabId) : null;
  if (!sid) return;
  const s = sessions.get(sid);
  if (s) await ownTab(s, tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sid = tabOwner.get(tabId);
  if (sid == null) return;
  tabOwner.delete(tabId);
  const s = sessions.get(sid);
  if (s) { s.tabIds.delete(tabId); persist(); }
  dbgDetachTab(tabId);
});

// ---------- content script 调用 ----------
async function callContent(tabId, msg) {
  const send = () => chrome.tabs.sendMessage(tabId, { __atb: true, ...msg });
  try {
    return unwrap(await send());
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 50));
    return unwrap(await send());
  }
}
function unwrap(res) {
  if (!res) throw new Error('页面无响应(chrome:// 等受限页面无法控制)');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// ---------- CDP 键盘映射 ----------
const CDP_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};
const KEY_ALIAS = { enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };

function cdpKey(spec) {
  const parts = String(spec).split('+');
  const main = parts.pop();
  let modifiers = 0;
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'alt') modifiers |= 1;
    else if (p === 'ctrl' || p === 'control') modifiers |= 2;
    else if (p === 'meta' || p === 'cmd') modifiers |= 4;
    else if (p === 'shift') modifiers |= 8;
  }
  const named = CDP_KEYS[KEY_ALIAS[main.toLowerCase()] || main];
  if (named) return { ...named, modifiers };
  return { key: main, text: modifiers ? undefined : main, windowsVirtualKeyCode: main.toUpperCase().charCodeAt(0), modifiers };
}

// ---------- 命令处理器(均已限定会话) ----------
const handlers = {
  async open_tab(s, { url, waitMs = 20000 }) {
    if (!url) throw new Error('url required');
    const windowId = await pickWindow(s);
    const tab = await chrome.tabs.create({ url, active: false, windowId });
    await ownTab(s, tab.id);
    const done = await waitTabComplete(tab.id, waitMs);
    return { tabId: tab.id, url: done.url, title: done.title, status: done.status };
  },

  async list_tabs(s) {
    const out = [];
    for (const tid of s.tabIds) {
      try {
        const t = await chrome.tabs.get(tid);
        out.push({ tabId: tid, url: t.url, title: t.title, status: t.status });
      } catch {}
    }
    return { session: s.name, color: s.color, tabs: out };
  },

  async close_tab(s, { tabId }) {
    owned(s, tabId);
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async navigate(s, { tabId, url, waitMs = 20000 }) {
    owned(s, tabId);
    if (url === 'back') await chrome.tabs.goBack(tabId);
    else if (url === 'forward') await chrome.tabs.goForward(tabId);
    else if (url === 'reload') await chrome.tabs.reload(tabId);
    else if (url) await chrome.tabs.update(tabId, { url });
    else throw new Error('url required(网址 | back | forward | reload)');
    const done = await waitTabComplete(tabId, waitMs);
    return { tabId, url: done.url, title: done.title, status: done.status };
  },

  async activate_tab(s, { tabId }) {
    owned(s, tabId);
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return { activated: tabId };
  },

  async snapshot(s, { tabId, maxChars = 20000 }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'snapshot', maxChars });
  },

  async click(s, { tabId, uid, dblClick = false, realEvents = false }) {
    owned(s, tabId);
    if (!realEvents) return callContent(tabId, { op: 'click', uid, dblClick });
    const { x, y } = await callContent(tabId, { op: 'rect', uid });
    await dbgAttach(tabId);
    const base = { x, y, button: 'left', pointerType: 'mouse' };
    await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    const clickOnce = async (count) => {
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', clickCount: count, ...base });
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', clickCount: count, ...base });
    };
    await clickOnce(1);
    if (dblClick) await clickOnce(2);
    return { clicked: uid, realEvents: true };
  },

  async fill(s, { tabId, uid, text, realEvents = false }) {
    owned(s, tabId);
    if (!realEvents) return callContent(tabId, { op: 'fill', uid, text });
    await callContent(tabId, { op: 'focusEl', uid, selectAll: true });
    await dbgAttach(tabId);
    await dbgSend(tabId, 'Input.insertText', { text: String(text) });
    await callContent(tabId, { op: 'fireChange', uid });
    return { filled: uid, realEvents: true };
  },

  async fill_form(s, { tabId, fields }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'fill_form', fields });
  },

  async select(s, { tabId, uid, values }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'select', uid, values });
  },

  async hover(s, { tabId, uid }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'hover', uid });
  },

  async press_key(s, { tabId, key, uid, realEvents = false }) {
    owned(s, tabId);
    if (!realEvents) return callContent(tabId, { op: 'press_key', key, uid });
    if (uid) await callContent(tabId, { op: 'focusEl', uid });
    await dbgAttach(tabId);
    const k = cdpKey(key);
    await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    return { pressed: key, realEvents: true };
  },

  async scroll(s, { tabId, uid, to, by }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'scroll', uid, to, by });
  },

  async extract(s, { tabId, selector, format, maxChars }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'extract', selector, format, maxChars });
  },

  async wait_for(s, { tabId, text, selector, gone, timeoutMs }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'wait_for', text, selector, gone, timeoutMs });
  },

  async screenshot(s, { tabId, fullPage = false, format = 'png', quality }) {
    owned(s, tabId);
    // 隐藏标签没有活的渲染表面,captureScreenshot 会挂起。唯一可靠办法:
    // 临时激活该标签(仅切换窗口内的活动标签,不改窗口焦点),截完立即恢复。
    const tab = await chrome.tabs.get(tabId);
    let prevActiveId = null;
    if (!tab.active) {
      const [act] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      prevActiveId = act?.id ?? null;
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 120)); // 等一帧渲染出来
    }
    try {
      await dbgAttach(tabId);
      const mimeType = format === 'png' ? 'image/png' : `image/${format}`;
      const params = { format };
      if (format !== 'png') params.quality = quality || 80;
      if (fullPage) {
        const metrics = await dbgSend(tabId, 'Page.getLayoutMetrics');
        const size = metrics.cssContentSize || metrics.contentSize;
        params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 12000), scale: 1 };
        params.captureBeyondViewport = true;
      }
      const { data } = await dbgSend(tabId, 'Page.captureScreenshot', params);
      return { base64: data, mimeType };
    } finally {
      // 恢复用户原来看的标签(窗口焦点自始至终没动)
      if (prevActiveId != null && prevActiveId !== tabId) {
        try { await chrome.tabs.update(prevActiveId, { active: true }); } catch {}
      }
    }
  },

  async evaluate(s, { tabId, fn }) {
    owned(s, tabId);
    await dbgAttach(tabId);
    const res = await dbgSend(tabId, 'Runtime.evaluate', {
      expression: `(${fn})()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate 执行出错');
    }
    return { value: res.result.value ?? res.result.description ?? null };
  },

  async console(s, { tabId, limit = 50 }) {
    owned(s, tabId);
    await dbgAttach(tabId);
    await new Promise((r) => setTimeout(r, 400)); // 等 Log.enable 回放缓存
    return { messages: dbgConsole(tabId).slice(-limit) };
  },

  async session_end(s, { closeTabs = true }) {
    let closed = 0;
    if (closeTabs) {
      const ids = [...s.tabIds];
      closed = ids.length;
      try { await chrome.tabs.remove(ids); } catch {}
    }
    s.groupId = null;
    persist();
    return { closedTabs: closed };
  },
};

// ---------- popup 通信 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.__atbPopup) return;
  handlePopup(msg).then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
async function handlePopup(msg) {
  if (msg.op === 'status') {
    return {
      connected,
      sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, color: s.color, active: s.active, tabs: s.tabIds.size })),
    };
  }
  if (msg.op === 'end_session') {
    const s = sessions.get(msg.id);
    if (s) {
      try { await chrome.tabs.remove([...s.tabIds]); } catch {}
      sessions.delete(msg.id);
      persist();
    }
    return { ok: true };
  }
  return { error: 'unknown op' };
}
