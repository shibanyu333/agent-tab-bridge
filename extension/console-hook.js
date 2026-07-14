// Agent Tab Bridge — console 钩子(MAIN world,document_start 注入)
// 取代 CDP Runtime.enable:包一层 console.* + 全局错误,存环形缓冲。
// 只注入本会话拥有的标签,不碰用户日常浏览的页面。
// 隔离世界读不到本世界的变量,所以用 postMessage 应答 content.js 的取数请求。
(() => {
  if (window.__atbConsoleHooked) return;
  window.__atbConsoleHooked = true;

  const MAX = 500;
  const buf = [];

  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  };

  const record = (level, args) => {
    buf.push({ level, text: args.map(fmt).join(' ').slice(0, 500), ts: Date.now() });
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { record(level, args); orig(...args); };
  }

  window.addEventListener('error', (e) => {
    record('error', [`${e.message} @ ${e.filename || '?'}:${e.lineno || 0}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    record('error', ['Unhandled rejection: ' + fmt(e.reason)]);
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__atbConsoleReq !== true) return;
    window.postMessage({ __atbConsoleRes: true, entries: buf.slice(-(ev.data.limit || 50)) }, '*');
  });
})();
