// Agent Tab Bridge — content script(isolated world,按需注入)
// uid 快照 + click/fill/extract/wait_for 等 DOM 操作;不动页面样式,零打扰
(() => {
  if (window.__atbInstalled) return;
  window.__atbInstalled = true;

  let uidSeq = 0;
  const els = new Map(); // uid -> WeakRef<Element>
  const ops = {};

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__atb) return;
    Promise.resolve()
      .then(() => (ops[msg.op] ? ops[msg.op](msg) : Promise.reject(new Error('unknown op: ' + msg.op))))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  });

  function getEl(uid) {
    const el = els.get(uid)?.deref();
    if (!el || !el.isConnected) throw new Error(`元素 ${uid} 已失效(页面已变化),请重新调用 snapshot`);
    return el;
  }

  // ---------- snapshot ----------
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'svg', 'path', 'br', 'hr']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);

  function isVisible(el) {
    try {
      if (el.checkVisibility && !el.checkVisibility()) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return tag !== 'a' || el.hasAttribute('href');
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || el.isContentEditable) return true;
    const ti = el.getAttribute('tabindex');
    if (ti != null && Number(ti) >= 0) return true;
    return false;
  }

  function accName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.innerText || '').join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels[0]) return (el.labels[0].innerText || '').trim().slice(0, 80);
    if (el.placeholder) return el.placeholder;
    const txt = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (txt) return txt.slice(0, 80);
    return el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
  }

  function descr(el) {
    const tag = el.tagName.toLowerCase();
    const uid = 'e' + (++uidSeq);
    els.set(uid, new WeakRef(el));
    let kind = tag;
    if (tag === 'input') kind = `input(${el.type || 'text'})`;
    const role = el.getAttribute('role');
    if (role) kind += ` role=${role}`;
    let line = `[${uid}] ${kind} "${accName(el).replace(/"/g, "'")}"`;
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) line += ` href=${href.slice(0, 120)}`;
    }
    if (tag === 'input' || tag === 'textarea') {
      const type = (el.type || '').toLowerCase();
      if (type === 'file') {
        line += ` name=${el.name || '?'}${el.multiple ? ' [可多选]' : ''}`;
        if (!isVisible(el)) line += ' [视觉隐藏,但可用 upload_file 直接投喂]';
      } else {
        const v = type === 'password' ? '•••' : String(el.value ?? '').slice(0, 100);
        line += ` value="${v}"`;
        if (type === 'checkbox' || type === 'radio') line += el.checked ? ' ✓checked' : '';
        if (type === 'hidden') line += ` name=${el.name || '?'} [hidden]`;
      }
    }
    if (tag === 'select') {
      line += ` selected="${el.selectedOptions?.[0]?.label || ''}" options=${el.options.length}`;
    }
    if (el.disabled) line += ' [disabled]';
    return line;
  }

  // 表单字段即使不可见也要收进快照:
  //  - input[type=hidden] 装着 nonce/CSRF token,agent 看不到就会误判"站点在拦自动化"
  //  - input[type=file] 几乎总是被 CSS 藏起来(配一个好看的 label),藏了照样能投喂文件
  function isFormField(el) {
    if (el.tagName.toLowerCase() !== 'input') return false;
    const t = (el.type || '').toLowerCase();
    return t === 'hidden' || t === 'file';
  }

  ops.snapshot = ({ maxChars = 30000, selector }) => {
    uidSeq = 0;
    els.clear();
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) throw new Error(`选择器无匹配: ${selector}`);
    const lines = [`url: ${location.href}`, `title: ${document.title}`];
    if (selector) lines.push(`scope: ${selector}`);
    lines.push('');
    let budget = maxChars;
    let truncated = false;

    const push = (depth, text) => {
      if (budget <= 0) { truncated = true; return; }
      const l = '  '.repeat(Math.min(depth, 8)) + text;
      lines.push(l);
      budget -= l.length + 1;
    };

    const walk = (node, depth) => {
      if (budget <= 0) { truncated = true; return; }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (budget <= 0) { truncated = true; return; }
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.replace(/\s+/g, ' ').trim();
          if (t && t.length > 1) push(depth, `text "${t.slice(0, 200)}"`);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child;
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (el.getAttribute('aria-hidden') === 'true' && !isFormField(el)) continue;
        if (!isVisible(el)) {
          if (isFormField(el)) push(depth, descr(el));
          continue;
        }

        if (tag === 'iframe' || tag === 'frame') {
          let idoc = null;
          try { idoc = el.contentDocument; } catch {}
          if (idoc && idoc.body) {
            push(depth, `-- iframe src=${(el.src || '').slice(0, 100)} --`);
            walk(idoc.body, depth + 1);
          } else {
            push(depth, `iframe(跨域不可读) src=${(el.src || '').slice(0, 100)}`);
          }
          continue;
        }
        if (/^h[1-6]$/.test(tag)) {
          push(depth, `${tag} "${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120)}"`);
          continue;
        }
        if (tag === 'img') {
          const alt = el.getAttribute('alt');
          if (alt) push(depth, `img "${alt.slice(0, 80)}"`);
          continue;
        }
        if (isInteractive(el)) {
          push(depth, descr(el));
          continue; // 交互元素文本已并入名称,不再下钻
        }
        walk(el, depth); // 匿名容器不增加缩进,保持树浅
        if (el.shadowRoot) walk(el.shadowRoot, depth);
      }
    };

    walk(root, 0);
    if (truncated) {
      lines.push(
        `\n⚠️ 快照在 ${maxChars} 字符处被截断,后面的元素全部没抓到 —— 你要找的表单/按钮很可能就在被砍掉的部分里,` +
        `不要据此判断"页面没有该元素"或"站点在拦截自动化"。` +
        `\n   改法:传 selector 只抓目标区域(如 selector:"#col-left"、"form#addtag"、"#wpbody-content"),或调大 maxChars。`
      );
    }
    return { text: lines.join('\n'), elements: uidSeq, truncated };
  };

  // ---------- 交互 ----------
  function fireP(el, type) {
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, detail: 1,
    };
    el.dispatchEvent(
      type.startsWith('pointer')
        ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(type, init)
    );
  }

  ops.click = ({ uid, dblClick }) => {
    const el = getEl(uid);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown'].forEach((t) => fireP(el, t));
    el.focus?.();
    ['pointerup', 'mouseup'].forEach((t) => fireP(el, t));
    el.click();
    if (dblClick) fireP(el, 'dblclick');
    return { clicked: uid, tag: el.tagName.toLowerCase() };
  };

  ops.hover = ({ uid }) => {
    const el = getEl(uid);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    ['pointerover', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'].forEach((t) => fireP(el, t));
    return { hovered: uid };
  };

  function fillEl(el, text) {
    const tag = el.tagName.toLowerCase();
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus?.();
    if (tag === 'input' || tag === 'textarea') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        const want = text === true || text === 'true' || text === 'checked' || text === '1';
        if (el.checked !== want) el.click();
        return { filled: true, checked: el.checked };
      }
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, String(text)); // 原生 setter:兼容 React/Vue 受控组件
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, value: String(el.value).slice(0, 100) };
    }
    if (tag === 'select') return selectEl(el, [String(text)]);
    if (el.isContentEditable) {
      el.focus();
      const doc = el.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (!doc.execCommand('insertText', false, String(text))) {
        el.textContent = String(text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      }
      return { filled: true };
    }
    throw new Error(`${tag} 元素不可填写`);
  }
  ops.fill = ({ uid, text }) => fillEl(getEl(uid), text);
  ops.fill_form = ({ fields = [] }) =>
    fields.map((f) => {
      try { return { uid: f.uid, ...fillEl(getEl(f.uid), f.value) }; }
      catch (e) { return { uid: f.uid, error: String(e.message || e) }; }
    });

  function selectEl(el, values) {
    const wanted = (values || []).map(String);
    let matched = 0;
    for (const opt of el.options) {
      const hit = wanted.includes(opt.value) || wanted.includes(opt.label.trim()) || wanted.includes(opt.text.trim());
      if (el.multiple) { opt.selected = hit; if (hit) matched++; }
      else if (hit) { el.value = opt.value; matched = 1; break; }
    }
    if (!matched) {
      const opts = [...el.options].slice(0, 20).map((o) => o.label || o.value).join(' | ');
      throw new Error(`没有匹配的选项: ${wanted.join(', ')}(可选: ${opts})`);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: el.multiple ? matched : el.selectedOptions[0]?.label };
  }
  ops.select = ({ uid, values }) => selectEl(getEl(uid), values);

  const KEY_ALIAS = { enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: ' ', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };
  ops.press_key = ({ key, uid }) => {
    const target = uid ? getEl(uid) : document.activeElement || document.body;
    const parts = String(key).split('+');
    const main = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    const k = KEY_ALIAS[main.toLowerCase()] || main;
    const init = {
      key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
      bubbles: true, cancelable: true, composed: true,
      ctrlKey: mods.has('ctrl') || mods.has('control'),
      metaKey: mods.has('meta') || mods.has('cmd'),
      altKey: mods.has('alt'), shiftKey: mods.has('shift'),
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (k.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return { pressed: key, note: k === 'Enter' ? '合成 Enter 不触发浏览器默认提交;要提交表单请用 browser_submit_form' : undefined };
  };

  ops.scroll = ({ uid, to, by }) => {
    if (uid) {
      getEl(uid).scrollIntoView({ block: 'center', behavior: 'instant' });
      return { scrolledTo: uid };
    }
    if (to === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    else if (typeof to === 'number') window.scrollTo({ top: to, behavior: 'instant' });
    else window.scrollBy({ top: by ?? window.innerHeight * 0.8, behavior: 'instant' });
    return {
      scrollY: Math.round(window.scrollY),
      maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)),
    };
  };

  ops.extract = ({ selector, format = 'text', maxChars = 30000 }) => {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) throw new Error(`选择器无匹配: ${selector}`);
    let out = format === 'html' ? root.outerHTML : root.innerText || '';
    if (format === 'text') out = out.replace(/\n{3,}/g, '\n\n');
    return { content: out.slice(0, maxChars), truncated: out.length > maxChars, totalChars: out.length };
  };

  ops.wait_for = ({ text, selector, gone = false, timeoutMs = 15000 }) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      let iv, mo;
      const cleanup = () => { clearInterval(iv); mo?.disconnect(); };
      const check = () => {
        let hit;
        if (selector) hit = !!document.querySelector(selector);
        else if (text) hit = (document.body?.innerText || '').includes(text);
        else { cleanup(); return reject(new Error('需要 text 或 selector 参数')); }
        if (gone ? !hit : hit) { cleanup(); resolve({ found: true, elapsedMs: Date.now() - t0 }); }
        else if (Date.now() - t0 > timeoutMs) { cleanup(); reject(new Error(`等待超时(${timeoutMs}ms): ${selector || text}`)); }
      };
      iv = setInterval(check, 300);
      mo = new MutationObserver(check);
      if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      check();
    });

  // ---------- 表单提交 ----------
  // el.click() 对多数提交按钮就够了,但按钮被 JS 拦截/不在视口/是 <a> 伪按钮时会静默失效。
  // requestSubmit 走浏览器原生提交:自动带上所有字段(含 hidden 的 nonce),并触发 HTML 校验和 submit 事件。
  ops.submit = ({ uid }) => {
    const el = getEl(uid);
    const tag = el.tagName.toLowerCase();
    const form = tag === 'form' ? el : el.closest('form');
    if (!form) throw new Error('该元素不在任何 <form> 内 — 确认 uid 指向表单里的字段或提交按钮');
    const isSubmitter =
      (tag === 'button' && (el.type || 'submit') === 'submit') ||
      (tag === 'input' && ['submit', 'image'].includes((el.type || '').toLowerCase()));
    form.requestSubmit(isSubmitter ? el : undefined);
    return {
      submitted: true,
      action: form.action || location.href,
      method: (form.method || 'get').toUpperCase(),
      fields: form.elements.length,
    };
  };

  // ---------- 文件上传 ----------
  // 不碰系统文件对话框:直接把字节做成 File 塞进 input.files。
  // 字节由本地桥读盘后经 WS 送来(页面/扩展都读不了本地磁盘)。
  function toFile(f) {
    const bin = atob(f.b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], f.name, { type: f.type || 'application/octet-stream', lastModified: Date.now() });
  }

  function findFileInput(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.type || '').toLowerCase() === 'file') return el;
    if (tag === 'label') {
      const forId = el.getAttribute('for');
      const t = forId ? document.getElementById(forId) : el.querySelector('input[type=file]');
      if (t && (t.type || '').toLowerCase() === 'file') return t;
    }
    return el.querySelector?.('input[type=file]') || null;
  }

  ops.upload = ({ uid, selector, files }) => {
    const el = uid ? getEl(uid) : document.querySelector(selector);
    if (!el) throw new Error(`找不到上传目标: ${selector || uid}`);

    const dt = new DataTransfer();
    for (const f of files) dt.items.add(toFile(f));
    const names = [...dt.files].map((f) => f.name);

    const input = findFileInput(el);
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { uploaded: names, via: 'file input', name: input.name || null };
    }

    // 没有 file input → 当拖拽上传区处理(Dropzone / WP 媒体库拖放区等)
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, init));
    return { uploaded: names, via: 'drop 事件', note: '目标不是 file input,已按拖拽区处理;若无反应说明该区域用了别的上传机制' };
  };

  // ---------- console(由 MAIN world 的 console-hook.js 收集) ----------
  ops.console = ({ limit = 50 }) =>
    new Promise((resolve) => {
      const onMsg = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__atbConsoleRes !== true) return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve({ messages: ev.data.entries });
      };
      window.addEventListener('message', onMsg);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ messages: [], note: 'console 钩子未安装 — 这个标签在钩子注入前就打开了,刷新页面后即可捕获' });
      }, 1500);
      window.postMessage({ __atbConsoleReq: true, limit }, '*');
    });

  // ---------- 整页截图辅助 ----------
  let hiddenFixed = [];

  ops.pageMetrics = () => {
    const d = document.documentElement;
    document.documentElement.style.scrollBehavior = 'auto'; // 平滑滚动会让分片截糊
    return {
      width: Math.max(d.scrollWidth, document.body?.scrollWidth || 0),
      height: Math.max(d.scrollHeight, document.body?.scrollHeight || 0),
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollY: Math.round(window.scrollY),
    };
  };

  // 固定/粘性元素(导航条、悬浮客服)会在每一片里重复出现。第一片拍完就藏起来。
  ops.hideFixed = () => {
    hiddenFixed = [];
    for (const el of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      hiddenFixed.push([el, el.style.visibility]);
      el.style.visibility = 'hidden';
    }
    return { hidden: hiddenFixed.length };
  };

  ops.restoreFixed = () => {
    for (const [el, prev] of hiddenFixed) el.style.visibility = prev;
    hiddenFixed = [];
    return { restored: true };
  };
})();
