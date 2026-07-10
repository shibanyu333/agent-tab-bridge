const GROUP_COLORS = {
  blue: '#1a73e8', green: '#188038', red: '#d93025', yellow: '#f9ab00',
  purple: '#9334e6', pink: '#e52592', cyan: '#12b5cb', orange: '#fa903e', grey: '#5f6368',
};

async function refresh() {
  const st = await chrome.runtime.sendMessage({ __atbPopup: true, op: 'status' }).catch(() => null);
  const dot = document.getElementById('connDot');
  const txt = document.getElementById('connText');
  const list = document.getElementById('list');
  if (!st) { txt.textContent = '后台未响应'; return; }
  dot.className = 'dot ' + (st.connected ? 'ok' : 'bad');
  txt.textContent = st.connected ? '已连接本地桥' : '桥未运行(等 agent 启动或手动 node bridge/server.js)';
  if (!st.sessions.length) {
    list.innerHTML = '<div class="empty">没有活跃的 agent 会话</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of st.sessions) {
    const row = document.createElement('div');
    row.className = 'sess';
    const dot = document.createElement('span');
    dot.className = 'cdot';
    dot.style.background = GROUP_COLORS[s.color] || '#888';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${s.tabs} 页${s.active ? '' : ' · 已结束'}`;
    const btn = document.createElement('button');
    btn.textContent = '清理';
    btn.title = '关闭该会话的所有标签页';
    btn.onclick = async () => {
      await chrome.runtime.sendMessage({ __atbPopup: true, op: 'end_session', id: s.id });
      refresh();
    };
    row.append(dot, name, meta, btn);
    list.append(row);
  }
}
refresh();
setInterval(refresh, 1500);
