#!/usr/bin/env node
// 端到端冒烟测试:两个"agent"并行各开各的标签组,验证隔离、快照、截图
// 前提:bridge 在跑、扩展已加载。用法: node scripts/smoke.js [--keep]
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ATB_PORT || 8737);
const TOKEN = fs.readFileSync(path.join(os.homedir(), '.agent-tab-bridge', 'token'), 'utf8').trim();
const KEEP = process.argv.includes('--keep');
const OUT_DIR = process.env.SMOKE_OUT || os.tmpdir();

function agent(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent?token=${TOKEN}&name=${encodeURIComponent(name)}`);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'registered') res(m);
      if (m.type === 'result') {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(new Error(m.error)); }
      }
    });
    ws.on('error', rej);
  });
  const cmd = (action, params = {}) =>
    new Promise((resolve, reject) => {
      const id = 'q' + (++seq);
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout: ' + action)); }, 90000);
      ws.send(JSON.stringify({ type: 'command', id, action, params }));
    });
  return { ws, ready, cmd, name };
}

const ok = (label, extra = '') => console.log(`✅ ${label}${extra ? ' — ' + extra : ''}`);
const fail = (label, e) => { console.error(`❌ ${label}: ${e.message}`); process.exitCode = 1; };

async function driveA(a) {
  // agent A:example.com 全链路。tabId 先建好,后续步骤即使个别失败也不影响隔离验证
  const tab = await a.cmd('open_tab', { url: 'https://example.com' });
  ok(`[A] open_tab`, `tab ${tab.tabId} "${tab.title}"`);
  const snap = await a.cmd('snapshot', { tabId: tab.tabId });
  if (!snap.text.includes('Example Domain')) throw new Error('快照里没有预期文本');
  ok(`[A] snapshot`, `${snap.elements} 个交互元素`);

  // 截图(后台标签,走 captureVisibleTab —— 不挂调试器)
  const shot = await a.cmd('screenshot', { tabId: tab.tabId });
  const f = path.join(OUT_DIR, 'smoke-A.png');
  fs.writeFileSync(f, Buffer.from(shot.base64, 'base64'));
  ok(`[A] screenshot(后台标签)`, `${Math.round(shot.base64.length / 1024)}KB → ${f}`);

  const ev = await a.cmd('evaluate', { tabId: tab.tabId, fn: '() => document.title' });
  ok(`[A] evaluate`, JSON.stringify(ev.value));

  // 点击链接 → 前进/后退历史
  const link = snap.text.match(/\[(e\d+)\] a /)?.[1];
  if (link) {
    await a.cmd('click', { tabId: tab.tabId, uid: link });
    const nav = await a.cmd('wait_for', { tabId: tab.tabId, text: 'IANA', timeoutMs: 15000 }).then(() => true).catch(() => false);
    ok(`[A] click 链接`, link + (nav ? '(已跳转 iana)' : '(未跳转)'));
    if (nav) {
      try { await a.cmd('navigate', { tabId: tab.tabId, url: 'back' }); ok(`[A] navigate back`); }
      catch (e) { console.log(`⚠️ [A] navigate back: ${e.message}`); }
    }
  }
  return tab.tabId;
}

async function driveB(b) {
  // agent B:Selenium 官方测试表单(专为自动化设计,稳定),测 fill + select
  const tab = await b.cmd('open_tab', { url: 'https://www.selenium.dev/selenium/web/web-form.html' });
  ok(`[B] open_tab`, `tab ${tab.tabId} "${tab.title}"`);
  const snap = await b.cmd('snapshot', { tabId: tab.tabId });
  const input = snap.text.match(/\[(e\d+)\] input\(text\)/)?.[1];
  if (input) {
    const r = await b.cmd('fill', { tabId: tab.tabId, uid: input, text: '并行测试-B' });
    if (r.value !== '并行测试-B') throw new Error('fill 回读值不符: ' + JSON.stringify(r));
    ok(`[B] fill 文本框`, `${input} = "${r.value}"`);
  } else { throw new Error('没找到文本输入框'); }
  const sel = snap.text.match(/\[(e\d+)\] select/)?.[1];
  if (sel) {
    const r = await b.cmd('select', { tabId: tab.tabId, uid: sel, values: ['Two'] });
    ok(`[B] select 下拉`, JSON.stringify(r));
  }
  const extract = await b.cmd('extract', { tabId: tab.tabId, maxChars: 500 });
  ok(`[B] extract`, `${extract.totalChars} chars`);
  return tab.tabId;
}

// agent C:v0.2 新增能力 —— 上传 / 原生提交 / console / 整页截图 / 快照抓隐藏字段
async function driveC(c) {
  const tab = await c.cmd('open_tab', { url: 'https://www.selenium.dev/selenium/web/web-form.html' });
  const tabId = tab.tabId;

  // 1) 快照必须能看见 file input(该页面的 file input 是可见的,但断言它出现在树里)
  const snap = await c.cmd('snapshot', { tabId });
  const fileUid = snap.text.match(/\[(e\d+)\] input\(file\)/)?.[1];
  if (!fileUid) throw new Error('快照里没有 input(file) —— 上传功能无从下手');
  ok('[C] 快照含 file input', fileUid);

  // 2) 上传本地文件:不能弹系统对话框,直接投喂字节
  const tmp = path.join(OUT_DIR, 'atb-upload-test.txt');
  const payload = 'agent-tab-bridge upload test ' + Date.now();
  fs.writeFileSync(tmp, payload);
  const up = await c.cmd('upload', {
    tabId,
    uid: fileUid,
    files: [{ name: 'atb-upload-test.txt', type: 'text/plain', b64: Buffer.from(payload).toString('base64') }],
  });
  ok('[C] upload', JSON.stringify(up));

  // 3) 回读 input.files 证明浏览器真的收下了文件(而不只是我们以为收下了)
  const check = await c.cmd('evaluate', {
    tabId,
    fn: `() => { const i = document.querySelector('input[type=file]');
                return i.files.length ? { n: i.files.length, name: i.files[0].name, size: i.files[0].size } : null; }`,
  });
  if (!check.value || check.value.name !== 'atb-upload-test.txt') {
    throw new Error('input.files 回读失败: ' + JSON.stringify(check.value));
  }
  if (check.value.size !== Buffer.byteLength(payload)) {
    throw new Error(`文件字节数不符: 期望 ${Buffer.byteLength(payload)} 实得 ${check.value.size}`);
  }
  ok('[C] 文件确实进了 input.files', `${check.value.name} ${check.value.size}B`);

  // 4) evaluate 主世界能访问页面全局(这里读 navigator.userAgent 验证真在页面里跑)
  const ev = await c.cmd('evaluate', { tabId, fn: '() => location.pathname' });
  if (!String(ev.value).includes('web-form')) throw new Error('evaluate 主世界返回异常: ' + JSON.stringify(ev.value));
  ok('[C] evaluate(main world)', JSON.stringify(ev.value));

  // 5) console 捕获(不挂调试器)
  await c.cmd('evaluate', { tabId, fn: '() => { console.warn("atb-smoke-marker"); return 1; }' });
  const logs = await c.cmd('console', { tabId, limit: 30 });
  const hit = (logs.messages || []).some((m) => String(m.text).includes('atb-smoke-marker'));
  if (!hit) throw new Error('console 没抓到标记: ' + JSON.stringify(logs).slice(0, 200));
  ok('[C] console 捕获', `${logs.messages.length} 条,含标记`);

  // 6) 原生提交:带上全部字段(含 hidden),提交后 URL 应变成 submitted-form.html
  const snap2 = await c.cmd('snapshot', { tabId });
  const submitUid = snap2.text.match(/\[(e\d+)\] button "Submit"/)?.[1] || snap2.text.match(/\[(e\d+)\] button/)?.[1];
  if (!submitUid) throw new Error('没找到提交按钮');
  const sub = await c.cmd('submit', { tabId, uid: submitUid });
  if (!String(sub.url).includes('submitted-form')) throw new Error('提交后没跳转: ' + JSON.stringify(sub));
  ok('[C] submit_form 原生提交', `${sub.method} → ${sub.url.split('/').pop()}`);

  fs.unlinkSync(tmp);
  return tabId;
}

// 整页截图单独串行跑(不和别的会话抢标签激活),验证滚动分片拼接不报错、拼出的图高于视口
async function driveFullPage(c) {
  const tab = await c.cmd('open_tab', { url: 'https://en.wikipedia.org/wiki/Web_browser' });
  const tabId = tab.tabId;
  const view = await c.cmd('evaluate', { tabId, fn: '() => window.innerHeight' });
  const full = await c.cmd('screenshot', { tabId, fullPage: true });
  const png = Buffer.from(full.base64, 'base64');
  if (png.length < 1000) throw new Error('整页截图字节数异常小');
  const pxH = png.readUInt32BE(20); // PNG IHDR 高度(设备像素)
  ok('[FP] 整页截图', `${pxH}px 高 · 视口 ${view.value}px · ${Math.round(png.length / 1024)}KB${full.truncated ? ' · ' + full.truncated : ''}`);
  await c.cmd('close_tab', { tabId });
}

// 快照必须能看到 hidden 字段(nonce/CSRF)—— 之前看不到,导致误判"站点在拦自动化"
async function checkHiddenFields(c, tabId) {
  await c.cmd('evaluate', {
    tabId,
    fn: `() => { const f = document.createElement('form'); f.id = 'atb-hidden-probe';
                f.innerHTML = '<input type="hidden" name="_wpnonce" value="abc123">';
                document.body.appendChild(f); return 1; }`,
  });
  const snap = await c.cmd('snapshot', { tabId, selector: '#atb-hidden-probe' });
  if (!snap.text.includes('_wpnonce')) throw new Error('快照仍然看不到 hidden 字段: ' + snap.text);
  ok('[C] 快照抓到 hidden 字段', '_wpnonce [hidden]');
  ok('[C] snapshot selector 限定范围', `只 ${snap.elements} 个元素`);
}

async function main() {
  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  if (!health.extension) { console.error('❌ 扩展未连接,先在 chrome://extensions 加载 extension/ 目录'); process.exit(1); }
  ok('bridge + 扩展在线');

  const A = agent('smoke-A');
  const B = agent('smoke-B');
  const C = agent('smoke-C');
  const [ra, rb, rc] = await Promise.all([A.ready, B.ready, C.ready]);
  ok('三个会话注册', `A=${ra.color} B=${rb.color} C=${rc.color}`);

  // 并行驱动三个会话
  const [tabA, tabB, tabC] = await Promise.all([
    driveA(A).catch((e) => { fail('agent A', e); return null; }),
    driveB(B).catch((e) => { fail('agent B', e); return null; }),
    driveC(C).catch((e) => { fail('agent C(v0.2 新能力)', e); return null; }),
  ]);
  if (tabC) await checkHiddenFields(C, tabC).catch((e) => fail('hidden 字段快照', e));
  // 整页截图串行验证(避开并行截图抢激活)
  await driveFullPage(C).catch((e) => fail('整页截图', e));

  // 隔离验证:B 不能操作 A 的 tab
  if (tabA) {
    try {
      await B.cmd('snapshot', { tabId: tabA });
      fail('隔离验证', new Error('B 居然能操作 A 的 tab!'));
    } catch (e) {
      if (e.message.includes('不属于会话')) ok('隔离验证', 'B 操作 A 的 tab 被正确拒绝');
      else fail('隔离验证(意外错误)', e);
    }
    const listA = await A.cmd('list_tabs');
    if (listA.tabs.every((t) => t.tabId !== tabB)) ok('list_tabs 只见本会话', `A 看到 ${listA.tabs.length} 个`);
    else fail('list_tabs 隔离', new Error('A 看到了 B 的 tab'));
  }

  if (!KEEP) {
    await Promise.all([
      A.cmd('session_end', { closeTabs: true }),
      B.cmd('session_end', { closeTabs: true }),
      C.cmd('session_end', { closeTabs: true }),
    ]);
    ok('清理完成(--keep 可保留标签观察分组)');
  } else {
    console.log('ℹ️ 标签保留在 Chrome 中,注意看三个彩色分组');
  }
  A.ws.close(); B.ws.close(); C.ws.close();
  console.log(process.exitCode ? '\n有失败项' : '\n全部通过 🎉');
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
