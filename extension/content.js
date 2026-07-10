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
      const v = el.type === 'password' ? '•••' : String(el.value ?? '').slice(0, 100);
      line += ` value="${v}"`;
      if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' ✓checked' : '';
    }
    if (tag === 'select') {
      line += ` selected="${el.selectedOptions?.[0]?.label || ''}" options=${el.options.length}`;
    }
    if (el.disabled) line += ' [disabled]';
    return line;
  }

  ops.snapshot = ({ maxChars = 20000 }) => {
    uidSeq = 0;
    els.clear();
    const lines = [`url: ${location.href}`, `title: ${document.title}`, ''];
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
        if (el.getAttribute('aria-hidden') === 'true') continue;
        if (!isVisible(el)) continue;

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

    if (document.body) walk(document.body, 0);
    if (truncated) lines.push(`\n…(超过 ${maxChars} 字符已截断 — 用 extract 读完整内容,或调大 maxChars)`);
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
    return { pressed: key, note: k === 'Enter' ? '合成 Enter 不触发浏览器默认提交;需要提交表单时用 realEvents:true' : undefined };
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

  // ---------- CDP 辅助 ----------
  ops.rect = ({ uid }) => {
    const el = getEl(uid);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  ops.focusEl = ({ uid, selectAll }) => {
    const el = getEl(uid);
    el.focus();
    if (selectAll && el.select) el.select();
    return { focused: true };
  };
  ops.fireChange = ({ uid }) => {
    const el = getEl(uid);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {};
  };
})();
