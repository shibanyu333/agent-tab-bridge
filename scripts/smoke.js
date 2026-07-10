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

  // 截图(后台标签,走 debugger 路径 —— 最关键的验证)
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

async function main() {
  const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  if (!health.extension) { console.error('❌ 扩展未连接,先在 chrome://extensions 加载 extension/ 目录'); process.exit(1); }
  ok('bridge + 扩展在线');

  const A = agent('smoke-A');
  const B = agent('smoke-B');
  const [ra, rb] = await Promise.all([A.ready, B.ready]);
  ok('两个会话注册', `A=${ra.color} B=${rb.color}`);

  // 并行驱动两个会话
  const [tabA, tabB] = await Promise.all([
    driveA(A).catch((e) => { fail('agent A', e); return null; }),
    driveB(B).catch((e) => { fail('agent B', e); return null; }),
  ]);

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
    await Promise.all([A.cmd('session_end', { closeTabs: true }), B.cmd('session_end', { closeTabs: true })]);
    ok('清理完成(--keep 可保留标签观察分组)');
  } else {
    console.log('ℹ️ 标签保留在 Chrome 中,注意看两个彩色分组');
  }
  A.ws.close(); B.ws.close();
  console.log(process.exitCode ? '\n有失败项' : '\n全部通过 🎉');
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
