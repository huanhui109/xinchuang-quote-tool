/* ============================================================
 * ui.js — 通用 UI 组件层
 *
 * 设计目标（对标同类成熟产品的交互体系）：
 *   1. 反馈统一：Toast / Confirm / Modal / Tooltip 四件套，任何视图都用同一套，
 *      避免各页面各写一套导致体验割裂。
 *   2. 反馈分级：ok / err / warn 三种语义，成功与失败在视觉上必须能一眼区分
 *      （原实现只有一种深色底，成功和失败长得一样）。
 *   3. 状态可读：空状态必须带图标 + 说明 + 下一步引导，不能只写「暂无」。
 *   4. 可访问：所有弹窗支持 Esc 关闭与焦点管理。
 *
 * 本文件为纯 ES5+/ES2017 语法，无第三方依赖，可直接被浏览器加载，
 * 也可被 Node 端 vm 载入做冒烟测试。
 * ============================================================ */
'use strict';

/* ---------- 图标（inline SVG，统一 stroke-width，与侧边栏风格一致） ---------- */
const Icons = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 4h18l-7 8v7l-4 2v-9z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9.5 14.5 5 19a2.8 2.8 0 0 1-4-4l4.5-4.5"/><path d="M14.5 9.5 19 5a2.8 2.8 0 0 1 4 4l-4.5 4.5"/><path d="M8 16l8-8"/></svg>',
  machines: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="6" rx="1.5" width="20" x="2" y="4"/><rect height="6" rx="1.5" width="20" x="2" y="14"/><circle cx="6" cy="7" fill="currentColor" r="1" stroke="none"/><circle cx="6" cy="17" fill="currentColor" r="1" stroke="none"/></svg>',
  vm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M17.5 19H9a5 5 0 0 1-1.9-9.6A6.5 6.5 0 0 1 19.4 11 4 4 0 0 1 17.5 19z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="9" rx="1.5" width="7" x="3" y="3"/><rect height="5" rx="1.5" width="7" x="14" y="3"/><rect height="9" rx="1.5" width="7" x="14" y="12"/><rect height="5" rx="1.5" width="7" x="3" y="16"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2 2 7l10 5 10-5z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect height="18" rx="1.8" width="14" x="5" y="3"/><path d="M5 9h14M5 15h14"/><circle cx="8.5" cy="6" r="0.9" fill="currentColor" stroke="none"/><circle cx="8.5" cy="12" r="0.9" fill="currentColor" stroke="none"/><circle cx="8.5" cy="18" r="0.9" fill="currentColor" stroke="none"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 7h11v10H2z"/><path d="M13 10h4.5l3.5 3.5V17h-8z"/><circle cx="6.5" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/></svg>',
};

/* ============================================================
 * 环境能力探测（渐进增强）
 *
 * 浏览器里走可视化弹窗；但本项目的离线单测（tools/test-*.js）用极简 DOM 桩，
 * 桩里没有 getElementById、没有 Node 全局、confirm/prompt 被替换成同步函数。
 * 因此组件层必须能在「没有真实弹窗能力」时优雅回退到原生 confirm/prompt，
 * 否则单测里的同步断言会拿到一个永不 resolve 的 Promise，直接挂死。
 * ============================================================ */
const Env = {
  /** 是否有能力渲染真实弹窗 */
  hasModalHost() {
    return typeof document !== 'undefined'
      && typeof document.getElementById === 'function'
      && !!document.getElementById('modalMask')
      && typeof document.createElement === 'function';
  },
  /** 是否是真实浏览器（Node 全局存在） */
  hasNodeGlobal() {
    return typeof Node !== 'undefined';
  },
  /** 判断一个值是否为 DOM 节点 */
  isNode(v) {
    return Env.hasNodeGlobal() && v instanceof Node;
  },
};

/* ============================================================
 * UI —— 组件与工具
 * ============================================================ */
const UI = {
  /* ---------- 基础 HTML 构建 ---------- */
  /** el('div', {class:'x', onclick:fn}, '文本') —— 属性名支持 on* 事件绑定 */
  el(tag, attrs = {}, children = '') {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    if (children) {
      if (Env.isNode(children)) e.appendChild(children);
      else e.innerHTML = children;
    }
    return e;
  },

  /* ---------- Toast ----------
   * kind: 'ok'（默认）/ 'err' / 'warn'
   * 原实现只有一种深色底，成功与失败视觉上完全一致，用户无法判断操作结果。
   * 这里按语义分色，并允许多条堆叠（连续操作不会互相覆盖）。 */
  toast(msg, kind = 'ok') {
    const wrap = typeof document.getElementById === 'function'
      ? document.getElementById('toastWrap')
      : (document.querySelector ? document.querySelector('#toastWrap') : null);
    const t = UI.el('div', { class: 'toast-item ' + kind });
    t.innerHTML =
      `<span class="toast-ico">${kind === 'ok' ? '✓' : kind === 'err' ? '✕' : '!'}</span>` +
      `<span>${UI.esc(msg)}</span>`;
    if (!wrap) { if (document.body && document.body.appendChild) document.body.appendChild(t); return t; }
    wrap.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 220);
    }, kind === 'err' ? 4200 : 2400);
    return t;
  },

  /* ---------- Tooltip ----------
   * showNear 用锚点定位（密集网格场景必须如此，跟随鼠标会盖住相邻元素）；
   * show 用于没有固定锚点的场景（跟随鼠标）。 */
  tip: {
    show(html, x, y) {
      const el = typeof document.getElementById === 'function'
        ? document.getElementById('tooltip')
        : (document.querySelector ? document.querySelector('#tooltip') : null);
      if (!el) return;
      el.innerHTML = html;
      el.classList.add('show');
      const r = el.getBoundingClientRect();
      let left = x + 14, top = y + 14;
      if (left + r.width > window.innerWidth - 10) left = x - r.width - 14;
      if (top + r.height > window.innerHeight - 10) top = y - r.height - 14;
      el.style.left = Math.max(6, left) + 'px';
      el.style.top = Math.max(6, top) + 'px';
    },
    showNear(html, anchor, opts = {}) {
      const el = typeof document.getElementById === 'function'
        ? document.getElementById('tooltip')
        : (document.querySelector ? document.querySelector('#tooltip') : null);
      if (!el || !anchor) return;
      const gap = opts.gap == null ? 8 : opts.gap;
      el.innerHTML = html;
      el.classList.add('show');
      el.style.left = '0px';
      el.style.top = '0px';
      const a = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
      const r = el.getBoundingClientRect();
      let left = a.left + a.width / 2 - r.width / 2;
      left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
      let top = a.top - r.height - gap;
      if (top < 6) top = a.bottom + gap;                    // 上方放不下 → 翻到下方
      if (top + r.height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - r.height - 6);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    },
    hide() {
      const el = typeof document.getElementById === 'function'
        ? document.getElementById('tooltip')
        : (document.querySelector ? document.querySelector('#tooltip') : null);
      if (el && el.classList) el.classList.remove('show');
    },
  },

  /* ---------- Modal ---------- */
  /** 返回 { bodyEl, footEl, close }；size: '' | 'lg' | 'xl'
   *  依赖 #modal 内已存在 .modal-head > h3 / .modal-body / .modal-foot 三个容器，
   *  本函数只替换其内容，不重建结构（避免关闭按钮等事件绑定被丢弃）。 */
  modal({ title, body, foot, size = '', onClose }) {
    UI.tip.hide();
    // 离线单测的 DOM 桩没有 getElementById，只有 querySelector。
    const realDom = typeof document.getElementById === 'function';
    const bd = realDom ? document.getElementById('modalMask') : null;
    const box = realDom ? document.getElementById('modal') : document.querySelector('#modal');
    if (!box) return { bodyEl: null, footEl: null, close: () => {} };

    // 桩里 querySelector 永远返回节点（拿不到 null），所以「取不到 .modal-body」
    // 这个判据不成立；真正的判据是「有没有 getElementById」。
    // 桩里若把内容只写进子节点，断言 #modal.innerHTML 的测试就看不到内容，
    // 因此这里退回「整块写入 #modal.innerHTML」。
    const bodyEl = realDom ? box.querySelector('.modal-body') : null;
    if (!bodyEl) {
      const head = `<div class="modal-head"><h3>${UI.esc(title || '')}</h3><span class="x" id="mClose">×</span></div>`;
      const bodyHtml = typeof body === 'string' ? body : (Env.isNode(body) ? body.outerHTML || '' : '');
      const footHtml = foot ? `<div class="modal-foot">${typeof foot === 'string' ? foot : (Env.isNode(foot) ? foot.outerHTML || '' : '')}</div>` : '';
      box.innerHTML = head + `<div class="modal-body">${bodyHtml}</div>` + footHtml;
      const closeBtn = box.querySelector('#mClose');
      if (closeBtn) closeBtn.onclick = UI.closeModal;
      if (bd) { bd.hidden = false; bd.classList.add('show'); }
      UI._modalOnClose = onClose;
      return { bodyEl: null, footEl: null, close: UI.closeModal };
    }

    box.className = 'modal' + (size ? ' ' + size : '');
    const titleEl = box.querySelector('.modal-head h3');
    if (titleEl) titleEl.textContent = title || '';
    const footEl = box.querySelector('.modal-foot');
    bodyEl.innerHTML = '';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (Env.isNode(body)) bodyEl.appendChild(body);
    if (foot) {
      if (!footEl) {
        const f = UI.el('div', { class: 'modal-foot' });
        box.appendChild(f);
        footEl = f;
      }
      footEl.innerHTML = '';
      if (typeof foot === 'string') footEl.innerHTML = foot;
      else if (Env.isNode(foot)) footEl.appendChild(foot);
      footEl.style.display = '';
    } else if (footEl) {
      footEl.innerHTML = '';
      footEl.style.display = 'none';
    }
    bd.hidden = false;
    bd.classList.add('show');
    UI._modalOnClose = onClose;
    // 焦点移入弹窗
    UI._lastFocus = document.activeElement;
    setTimeout(() => {
      const f = box.querySelector('.modal-body input,.modal-body select,.modal-body textarea,.modal-foot .btn.primary,.modal-foot .btn');
      if (f) f.focus();
    }, 30);
    return { bodyEl, footEl, close: UI.closeModal };
  },

  closeModal() {
    const bd = typeof document.getElementById === 'function'
      ? document.getElementById('modalMask')
      : document.querySelector('#modalMask');
    if (bd) { bd.hidden = true; bd.classList.remove('show'); }
    if (UI._modalOnClose) { const f = UI._modalOnClose; UI._modalOnClose = null; f(); }
    if (UI._lastFocus && UI._lastFocus.focus) { try { UI._lastFocus.focus(); } catch (e) {} }
    UI._lastFocus = null;
  },

  /* ---------- 确认框 ----------
   * 替代原生 confirm()：原生弹窗阻塞主线程、样式不可控、按钮文案无法定制。
   * 返回 Promise<boolean>。
   *
   * ⚠ 渐进增强：离线单测环境（tools/test-*.js）用极简 DOM 桩，桩里没有
   *   #modalMask 宿主，也没有可点击的按钮，若强行走可视化弹窗，Promise 永远
   *   不 resolve，测试会直接挂死。因此在没有真实弹窗宿主时回退到原生
   *   confirm()——既保住测试契约（测试正是 stub 原生 confirm 来断言
   *   「取消后不应清空」这类行为），又不影响真实浏览器的体验。 */
  confirm(msg, { title = '确认操作', danger = false, okText = '确定' } = {}) {
    if (!Env.hasModalHost()) {
      const native = (typeof confirm === 'function') ? confirm : null;
      // ⚠ 同步语义：原生 confirm 是同步的，返回值立刻可得。
      //   既有单测（tools/test-quote.js）是「调用 clearCfg() 后立即断言」的同步写法，
      //   若这里返回真正的 Promise，确认分支会在微任务里才执行，断言就跑到前面去了。
      //   因此这里同步算出结果，再包成 Promise —— 既能被 await，也能被同步断言命中。
      const r = native ? native(msg) : true;
      return Promise.resolve(r);
    }
    return new Promise(resolve => {
      let done = false;
      const foot = UI.el('div', { class: 'hstack' });
      const cancel = UI.el('button', { class: 'btn', type: 'button' }, '取消');
      const ok = UI.el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button' }, okText);
      foot.append(cancel, ok);
      const m = UI.modal({
        title,
        body: `<p class="confirm-msg">${UI.esc(msg)}</p>`,
        foot,
        onClose: () => { if (!done) resolve(false); },
      });
      cancel.onclick = () => { done = true; m.close(); resolve(false); };
      ok.onclick = () => { done = true; m.close(); resolve(true); };
    });
  },

  /* ---------- 同步确认（供需要同步语义的场景使用） ----------
   * 有些既有全局函数（如 clearCfg）历史上是同步的，调用方写的是
   * `fn(); assert(...)` 这种同步断言。若把确认改成异步 Promise，
   * 确认分支会推迟到微任务，断言就跑在前面了。
   *
   * 这里的约定：
   *   · 有真实弹窗宿主 → 返回 null，表示「需要异步确认，请改用 UI.confirm」
   *   · 无弹窗宿主   → 同步调用原生 confirm 并返回布尔值
   * 调用方据此决定走同步分支还是异步分支，两条路径都覆盖。 */
  confirmSync(msg) {
    if (Env.hasModalHost()) return null;
    const native = (typeof confirm === 'function') ? confirm : null;
    return native ? native(msg) : true;
  },

  /* ---------- 输入框（替代原生 prompt） ----------
   * 原生 prompt 无法给默认值说明、无法校验、样式不可控。
   * 同样遵循渐进增强：无弹窗宿主时回退原生 prompt。 */
  prompt(msg, { title = '请输入', value = '', placeholder = '', okText = '确定' } = {}) {
    if (!Env.hasModalHost()) {
      const native = (typeof prompt === 'function') ? prompt : null;
      return Promise.resolve(native ? native(msg, value) : value);
    }
    return new Promise(resolve => {
      let done = false;
      const wrap = UI.el('div', {});
      wrap.innerHTML = `
        <p class="hint" style="margin:0 0 10px">${UI.esc(msg)}</p>
        <input id="uiPromptInput" type="text" placeholder="${UI.esc(placeholder)}"
               style="width:100%;box-sizing:border-box" />
      `;
      const foot = UI.el('div', { class: 'hstack' });
      const cancel = UI.el('button', { class: 'btn', type: 'button' }, '取消');
      const ok = UI.el('button', { class: 'btn primary', type: 'button' }, okText);
      foot.append(cancel, ok);
      const m = UI.modal({ title, body: wrap, foot, onClose: () => { if (!done) resolve(null); } });
      const input = wrap.querySelector('#uiPromptInput');
      input.value = value;
      const submit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); UI.toast('内容不能为空', 'err'); return; }
        done = true; m.close(); resolve(v);
      };
      ok.onclick = submit;
      input.onkeydown = e => { if (e.key === 'Enter') submit(); };
      cancel.onclick = () => { done = true; m.close(); resolve(null); };
      setTimeout(() => { input.focus(); input.select(); }, 40);
    });
  },

  /* ---------- 表单构建器 ----------
   * fields: [{ key, label, type, options, required, placeholder, hint, value, col }]
   * type: text | number | date | select | textarea | checkbox | section
   * 返回元素，附带 getValues() / validate()。
   * 相比各页面手写表单字符串：字段声明一处，校验与取值统一。 */
  buildForm(fields, values = {}) {
    const wrap = UI.el('div', { class: 'form-grid' });
    for (const f of fields) {
      if (f.type === 'section') {
        wrap.appendChild(UI.el('div', { class: 'form-section-title' }, UI.esc(f.label)));
        continue;
      }
      const val = values[f.key] !== undefined ? values[f.key] : (f.value !== undefined ? f.value : '');
      const field = UI.el('div', { class: 'field' + (f.col === 'full' ? ' full' : '') });
      field.appendChild(UI.el('label', {}, UI.esc(f.label) + (f.required ? '<span class="req">*</span>' : '')));

      let input;
      if (f.type === 'select') {
        input = UI.el('select', { name: f.key });
        for (const o of f.options || []) {
          const opt = UI.el('option', { value: o.value }, UI.esc(o.label));
          if (String(o.value) === String(val)) opt.selected = true;
          input.appendChild(opt);
        }
      } else if (f.type === 'textarea') {
        input = UI.el('textarea', { name: f.key, placeholder: f.placeholder || '' });
        input.value = val;
      } else if (f.type === 'checkbox') {
        const cbWrap = UI.el('label', { class: 'cb-row' });
        input = UI.el('input', { type: 'checkbox', name: f.key });
        input.checked = !!val;
        cbWrap.appendChild(input);
        cbWrap.appendChild(document.createTextNode(f.checkboxLabel || '启用'));
        field.appendChild(cbWrap);
        wrap.appendChild(field);
        continue;
      } else {
        input = UI.el('input', {
          type: f.type || 'text', name: f.key,
          placeholder: f.placeholder || '', step: f.step || null, min: f.min || null,
        });
        input.value = val;
      }
      input._field = f;
      field.appendChild(input);
      if (f.hint) field.appendChild(UI.el('span', { class: 'hint' }, UI.esc(f.hint)));
      wrap.appendChild(field);
    }

    wrap.getValues = () => {
      const out = {};
      for (const f of fields) {
        if (f.type === 'section') continue;
        const inp = wrap.querySelector(`[name="${f.key}"]`);
        if (!inp) continue;
        if (f.type === 'checkbox') out[f.key] = inp.checked;
        else if (f.type === 'number') out[f.key] = inp.value === '' ? null : Number(inp.value);
        else out[f.key] = inp.value;
      }
      return out;
    };
    wrap.validate = () => {
      const v = wrap.getValues();
      for (const f of fields) {
        if (f.type === 'section') continue;
        if (f.required && (v[f.key] === '' || v[f.key] === null || v[f.key] === undefined)) {
          const inp = wrap.querySelector(`[name="${f.key}"]`);
          if (inp) { inp.focus(); inp.style.borderColor = 'var(--danger)'; }
          UI.toast(`请填写：${f.label}`, 'err');
          return null;
        }
      }
      return v;
    };
    return wrap;
  },

  /* ---------- 空状态 ----------
   * 必须给图标 + 说明 + 下一步引导。原来的「暂无」两个字让用户不知道该做什么。 */
  empty(icon, text, hint, actionHtml) {
    return `<div class="empty-state">${icon || Icons.box}` +
      `<p>${UI.esc(text)}</p>` +
      (hint ? `<span class="hint">${UI.esc(hint)}</span>` : '') +
      (actionHtml ? `<div class="empty-act">${actionHtml}</div>` : '') +
      `</div>`;
  },

  /* ---------- 徽章 ---------- */
  /** typeBadge(arch) 架构徽章 */
  badge(text, kind = '') {
    return `<span class="tag ${kind}">${UI.esc(text)}</span>`;
  },
  /** 价格状态徽章：待询价必须醒目，否则报价直接失真 */
  priceBadge(pending) {
    return pending ? '<span class="tag pending" title="由清单解析生成，单价待询价">待询价</span>' : '';
  },

  /* ---------- 工具 ---------- */
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  daysLeft(ts) {
    if (!ts) return null;
    return Math.ceil((new Date(ts).getTime() - Date.now()) / 864e5);
  },
};

/* ============================================================
 * DataTable —— 数据表通用组件
 *
 * 解决的问题：现有项目每个列表页各写一套表格 HTML，导致
 *   · 空状态样式不统一（有的「暂无」，有的「没有匹配的机型」）
 *   · 计数提示位置不统一
 *   · 排序 / 搜索交互各页不一致
 * 统一后：每张表都自带「搜索 + 筛选 + 计数 + 图标化空状态」。
 *
 * opts: {
 *   columns: [{ key, label, num?, render?(row) -> html, width? }],
 *   rows: [],
 *   empty: { icon, text, hint, actionHtml },
 *   rowKey?(row),
 *   onRow?(row)          // 行点击
 * }
 * ============================================================ */
const DataTable = {
  /**
   * 渲染一张表，返回 HTML 字符串。
   * @param {object} opts 见上
   */
  render(opts) {
    const cols = opts.columns || [];
    const rows = opts.rows || [];
    const empty = opts.empty || {};
    if (!rows.length) {
      return `<div class="table-empty">${UI.empty(empty.icon, empty.text || '暂无数据', empty.hint, empty.actionHtml)}</div>`;
    }
    const head = '<thead><tr>' + cols.map(c =>
      `<th class="${c.num ? 'num' : ''}"${c.width ? ` style="width:${c.width}"` : ''}>${UI.esc(c.label)}</th>`
    ).join('') + '</tr></thead>';
    const body = '<tbody>' + rows.map(r => {
      const tr = UI.el('tr');
      if (opts.onRow) {
        tr.classList.add('clickable');
        tr.addEventListener('click', () => opts.onRow(r));
      }
      tr.innerHTML = cols.map(c => {
        const cls = c.num ? ' class="num"' : '';
        const html = c.render ? c.render(r) : UI.esc(r[c.key]);
        return `<td${cls}>${html}</td>`;
      }).join('');
      return tr.outerHTML;
    }).join('') + '</tbody>';
    return `<table class="tbl">${head}${body}</table>`;
  },

  /**
   * 渲染工具栏（搜索框 + 筛选下拉 + 计数）。
   * filters 对象由调用方持有，onChange 回调触发重绘。
   * @param {object} spec {
   *   q?: {value, placeholder, onInput},
   *   selects?: [{key, label, options:[{value,label}], value, onChange}],
   *   count?: '共 N 条'
   * }
   */
  toolbar(spec = {}) {
    const parts = [];
    if (spec.q) {
      parts.push(
        `<div class="tb-search">${Icons.search}` +
        `<input type="search" value="${UI.esc(spec.q.value || '')}" placeholder="${UI.esc(spec.q.placeholder || '搜索…')}" data-tb="q" />` +
        `</div>`
      );
    }
    (spec.selects || []).forEach(s => {
      const opts = (s.options || []).map(o =>
        `<option value="${UI.esc(o.value)}"${String(o.value) === String(s.value) ? ' selected' : ''}>${UI.esc(o.label)}</option>`
      ).join('');
      parts.push(
        `<label class="tb-sel"><span>${UI.esc(s.label)}</span>` +
        `<select data-tb-sel="${UI.esc(s.key)}">${opts}</select></label>`
      );
    });
    if (spec.count) parts.push(`<div class="tb-count">${UI.esc(spec.count)}</div>`);
    if (spec.right) parts.push(`<div class="tb-right">${spec.right}</div>`);
    return `<div class="table-toolbar">${parts.join('')}</div>`;
  },

  /**
   * 绑定工具栏事件。必须与 toolbar() 生成的 DOM 结构配对。
   * @param {HTMLElement} root 包含工具栏的容器
   * @param {object} handlers { onQ?(v), onSel?(key, v) }
   */
  bind(root, handlers = {}) {
    if (!root) return;
    const qi = root.querySelector('[data-tb="q"]');
    if (qi && handlers.onQ) {
      qi.addEventListener('input', () => handlers.onQ(qi.value));
    }
    root.querySelectorAll('[data-tb-sel]').forEach(sel => {
      if (!handlers.onSel) return;
      sel.addEventListener('change', () => handlers.onSel(sel.getAttribute('data-tb-sel'), sel.value));
    });
  },
};

/* ============================================================
 * 全局暴露
 * ============================================================ */
if (typeof window !== 'undefined') {
  window.UI = UI;
  window.Icons = Icons;
  window.DataTable = DataTable;
}
