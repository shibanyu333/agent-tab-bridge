// 按需 CDP:截图、真实输入事件、console 捕获
// lazy attach,attach 后保持到 tab 关闭(避免"正在调试"提示条反复闪烁)

const attached = new Map(); // tabId -> { console: [] }
const VERSION = '1.3';

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const st = attached.get(source.tabId);
  if (!st) return;
  if (method === 'Runtime.consoleAPICalled') {
    st.console.push({
      level: params.type,
      text: (params.args || []).map(fmtRemote).join(' ').slice(0, 500),
      ts: params.timestamp,
    });
  } else if (method === 'Log.entryAdded') {
    const e = params.entry;
    st.console.push({ level: e.level, text: String(e.text).slice(0, 500), source: e.source, ts: e.timestamp });
  } else {
    return;
  }
  if (st.console.length > 500) st.console.splice(0, st.console.length - 500);
});

function fmtRemote(a) {
  if (a.type === 'string') return a.value;
  if (a.value !== undefined) { try { return JSON.stringify(a.value); } catch { return String(a.value); } }
  return a.description || a.type;
}

export async function dbgAttach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, VERSION);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Another debugger')) {
      throw new Error('该标签页已被其他调试器占用(DevTools 或 chrome-devtools MCP)— 关掉它或换个标签页');
    }
    throw e;
  }
  attached.set(tabId, { console: [] });
  await Promise.allSettled([
    chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
    chrome.debugger.sendCommand({ tabId }, 'Log.enable'),
    chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
  ]);
}

export function dbgSend(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

export function dbgConsole(tabId) {
  return attached.get(tabId)?.console || [];
}

export async function dbgDetachTab(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch {}
}
