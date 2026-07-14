// Agent Tab Bridge — service worker
// 连本地桥,按会话把命令路由到各自的标签组;所有 tab 后台创建,不抢用户焦点
//
// 【不用 chrome.debugger】只要 attach 一次调试器,Chrome 就会在页面顶部强制挂出
// 「"Agent Tab Bridge" 已开始调试此浏览器」黄条,而且没有任何 API 能关掉它。
// 所以截图走 tabs.captureVisibleTab、跑 JS 走 scripting.executeScript、
// console 走 MAIN world 注入的 console-hook.js —— 全程零提示。
// 代价:拿不到 isTrusted:true 的原生输入事件(极少数站点会查)。

const BRIDGE_URL = 'ws://127.0.0.1:8737/extension';
const COLORS = ['blue', 'green', 'red', 'yellow', 'purple', 'pink', 'cyan', 'orange'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
});

// console 钩子必须赶在页面脚本之前跑,否则早期日志就丢了。
// 只注入本会话拥有的标签 —— 用户日常浏览的页面一律不碰。
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading' || !tabOwner.has(tabId)) return;
  chrome.scripting
    .executeScript({
      target: { tabId },
      files: ['console-hook.js'],
      world: 'MAIN',
      injectImmediately: true,
    })
    .catch(() => {}); // chrome:// 等受限页面注入失败,忽略
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

// ---------- 截图(tabs.captureVisibleTab,无调试器) ----------
// captureVisibleTab 只吃 png/jpeg,且只能截「窗口里当前激活标签的可视区域」。
// 所以后台标签仍需瞬时激活一下(不动窗口焦点),整页则靠滚动分片再拼。
function capOpts(format, quality) {
  return format === 'jpeg' ? { format: 'jpeg', quality: quality || 85 } : { format: 'png' };
}

// captureVisibleTab 只能截「当前激活标签」,所以截图必须独占地"激活→截→恢复"。
// 多会话并行时若不串行化,彼此的激活/恢复会互相踩(甚至把 chrome:// 页面截进来报错)。
// 全局链式锁:同一时刻只跑一个截图操作,其余排队。
let screenshotChain = Promise.resolve();
function withScreenshotLock(fn) {
  const run = screenshotChain.then(fn, fn);
  screenshotChain = run.then(() => {}, () => {}); // 吞掉结果/异常,只留"已完成"信号给下一个
  return run;
}

async function capture(windowId, format, quality) {
  // Chrome 对 captureVisibleTab 有每秒调用配额,撞上就退避重试
  for (let i = 0; i < 8; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, capOpts(format, quality));
    } catch (e) {
      const msg = String(e?.message || e);
      if (/quota|MAX_CAPTURE/i.test(msg)) { await sleep(550); continue; }
      throw e;
    }
  }
  throw new Error('截图被 Chrome 频率限制挡住 — 稍等一两秒再试');
}

function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.match(/:(.*?);/)[1] });
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const MAX_FULLPAGE_SLICES = 12;

async function captureFullPage(tabId, windowId, format, quality) {
  const m = await callContent(tabId, { op: 'pageMetrics' });
  const shots = [];
  let hidFixed = false;
  try {
    for (let i = 0; i < MAX_FULLPAGE_SLICES; i++) {
      const target = i * m.viewH;
      if (i > 0 && target >= m.height - m.viewH + 1) break;
      const { scrollY } = await callContent(tabId, { op: 'scroll', to: target });
      await sleep(200); // 等重绘 + 懒加载图片
      shots.push({ y: scrollY, url: await capture(windowId, format, quality) });
      if (scrollY + m.viewH >= m.height - 1) break;
      if (!hidFixed) { await callContent(tabId, { op: 'hideFixed' }); hidFixed = true; }
    }
  } finally {
    if (hidFixed) await callContent(tabId, { op: 'restoreFixed' }).catch(() => {});
    await callContent(tabId, { op: 'scroll', to: m.scrollY }).catch(() => {});
  }

  const covered = Math.min(m.height, shots[shots.length - 1].y + m.viewH);
  const canvas = new OffscreenCanvas(Math.round(m.viewW * m.dpr), Math.round(covered * m.dpr));
  const ctx = canvas.getContext('2d');
  for (const s of shots) {
    const bmp = await createImageBitmap(dataUrlToBlob(s.url));
    ctx.drawImage(bmp, 0, Math.round(s.y * m.dpr));
    bmp.close();
  }
  const blob = await canvas.convertToBlob(
    format === 'jpeg' ? { type: 'image/jpeg', quality: (quality || 85) / 100 } : { type: 'image/png' }
  );
  return {
    base64: await blobToBase64(blob),
    mimeType: blob.type,
    truncated: covered < m.height ? `页面高 ${m.height}px,只截了前 ${covered}px(上限 ${MAX_FULLPAGE_SLICES} 屏)` : undefined,
  };
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

  async snapshot(s, { tabId, maxChars, selector }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'snapshot', maxChars, selector });
  },

  async click(s, { tabId, uid, dblClick = false }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'click', uid, dblClick });
  },

  async fill(s, { tabId, uid, text }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'fill', uid, text });
  },

  async fill_form(s, { tabId, fields }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'fill_form', fields });
  },

  async submit(s, { tabId, uid, waitMs = 20000 }) {
    owned(s, tabId);
    const r = await callContent(tabId, { op: 'submit', uid });
    const done = await waitTabComplete(tabId, waitMs);
    return { ...r, url: done.url, title: done.title };
  },

  async upload(s, { tabId, uid, selector, files }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'upload', uid, selector, files });
  },

  async select(s, { tabId, uid, values }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'select', uid, values });
  },

  async hover(s, { tabId, uid }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'hover', uid });
  },

  async press_key(s, { tabId, key, uid }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'press_key', key, uid });
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
    // captureVisibleTab 只截「窗口当前激活标签」,后台标签得瞬时激活一下。
    // 仅切换窗口内的活动标签,不动窗口焦点 —— 用户在别的窗口干活时完全无感。
    // 整个"激活→截→恢复"必须持锁,否则并行会话会互相抢激活。
    return withScreenshotLock(async () => {
      const tab = await chrome.tabs.get(tabId);
      let prevActiveId = null;
      if (!tab.active) {
        const [act] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        prevActiveId = act?.id ?? null;
        await chrome.tabs.update(tabId, { active: true });
        await sleep(150); // 等一帧渲染出来
      }
      try {
        if (fullPage) return await captureFullPage(tabId, tab.windowId, format, quality);
        const url = await capture(tab.windowId, format, quality);
        return { base64: url.split(',')[1], mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
      } finally {
        // 只在原来的标签仍存在时才恢复;别恢复到 chrome:// 之类无所谓,反正没截它
        if (prevActiveId != null && prevActiveId !== tabId) {
          try { await chrome.tabs.update(prevActiveId, { active: true }); } catch {}
        }
      }
    });
  },

  async evaluate(s, { tabId, fn }) {
    owned(s, tabId);
    // MAIN world:能访问页面全局(jQuery、React 等),eval 受页面自身 CSP 管。
    // 不用 CDP,所以拿不到 CDP 那种"绕过 CSP"的能力 —— 强 CSP 页面 eval 会被拦。
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [String(fn)],
      func: async (src) => {
        try {
          const f = (0, eval)('(' + src + ')');
          const v = typeof f === 'function' ? await f() : await f;
          if (v === undefined) return { ok: true, value: null };
          try { return { ok: true, value: JSON.parse(JSON.stringify(v)) }; }
          catch { return { ok: true, value: String(v) }; } // 含 DOM 节点/循环引用等不可序列化的值
        } catch (e) {
          return { ok: false, error: String((e && (e.stack || e.message)) || e) };
        }
      },
    });
    const out = res?.result;
    if (!out) throw new Error('页面未返回结果(chrome:// 等受限页面无法执行)');
    if (!out.ok) {
      if (/unsafe-eval|EvalError|Content Security Policy/i.test(out.error)) {
        throw new Error(
          '此页面的 CSP 禁止 eval,无法执行任意 JS(不挂调试器就绕不过)。' +
          '改用 snapshot / extract / click / fill / select 这些不依赖 eval 的工具来完成同样的事。'
        );
      }
      throw new Error(out.error);
    }
    return { value: out.value };
  },

  async console(s, { tabId, limit = 50 }) {
    owned(s, tabId);
    return callContent(tabId, { op: 'console', limit });
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
