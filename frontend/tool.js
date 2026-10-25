// -*- coding: utf-8 -*-
// 视频处理工具窗口（第 4 个模块的前端）
//
(function () {

  // 全局兜底统一由 log-bootstrap.js 注入（四窗口共用）；本页只挂 toast。
  // 就地 catch 请用 window.logError(where, err)（toast + 落盘一次完成）。
  window.vlToast = toast;

  'use strict';

  var api = window.txapi;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, size) { return window.VL_icon ? window.VL_icon(name, size) : ''; }
  function iconEl(name, size) { return '<i data-icon="' + name + '" data-size="' + (size || 14) + '"></i>'; }

  var state = {
    info: null,
    sel: {},        // stepId → 是否勾选（仅后处理；画布合成有独立的入口与参数）
    values: {},     // stepId → { key: value }
    link: { resize: true },  // 转分辨率：比例锁链是否锁定（纯前端交互，不提交）
    root: '',
    files: [],      // 显式选中的视频文件（优先于目录）
    recursive: true,
    taskId: '',
    unsub: null,
  };

  // ── 状态栏 ──
  // 提示统一走 VL.ui 门面：日志由门面记一次（唯一日志点），这里只负责渲染。
  function setStatus(text, kind) { try { return VL.ui.status(text, { kind: kind }); } catch (e) {} }
  function _statusRender(text, opts) {
    var el = $('status');
    var kind = opts && opts.kind;
    el.textContent = text || '';
    el.className = 'tl-status' + (kind ? ' tl-status--' + kind : '');
  }
  try { VL.ui.registerStatus(_statusRender); } catch (e) { /* 同上 */ }

  // 轻提示（与主窗口/任务窗口同一套样式与行为）：错误与失败类提示不再走状态栏小字
  // 提示统一走 VL.ui 门面：日志由门面记一次（唯一日志点），这里只负责渲染。
  function toast(message, type) { try { return VL.ui.toast(message, type); } catch (e) { return null; } }
  try { VL.ui.registerToast(_toastRender); } catch (e) { /* 门面未就绪也要让页面继续跑 */ }
  function _toastRender(message, type) {
    var host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    var t = type === true ? 'error' : (String(type || 'info'));
    var ic = t === 'ok' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : t === 'error' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>';
    el.className = 'toast toast--' + t;
    el.innerHTML = '<span class="toast__icon">' + ic + '</span><span class="toast__text"></span>';
    el.querySelector('.toast__text').textContent = message || '';
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast--show'); });
    setTimeout(function () {
      el.classList.remove('toast--show');
      setTimeout(function () { el.remove(); }, 200);
    }, t === 'error' ? 4200 : 2600);
  }

  // ── 大窗确认（与主窗口 showDialog 同一套样式类；高风险动作才用它，不用气泡）──
  function showDialog(opts) { try { return VL.ui.dialog(opts); } catch (e) { return null; } }
  try { VL.ui.registerDialog(_dialogRender); } catch (e) { /* 门面未就绪也要让页面继续跑 */ }
  function _dialogRender(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card' + (opts.cssClass ? ' ' + opts.cssClass : '');
      var html = '<button type="button" class="modal-close" title="关闭">✕</button>'
        + '<div class="modal__title">' + esc(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + opts.message + '</div>';
      // 文本输入（可选）：**不要用 window.prompt** —— Electron 渲染进程不支持它，
      // 会直接抛 "prompt() is not supported."。
      if (opts.input) {
        html += '<div class="modal__field"><input type="text" class="modal__input"'
          + ' placeholder="' + esc(opts.input.placeholder || '') + '"'
          + ' value="' + esc(opts.input.value || '') + '"></div>';
      }
      html += '<div class="modal__actions">';
      (opts.buttons || []).forEach(function (b) {
        var cls = 'modal-btn' + (b.danger ? ' modal-btn--danger' : '') + (b.primary ? ' modal-btn--primary' : '');
        html += '<button type="button" class="' + cls + '">' + (b.icon ? icon(b.icon, 14) : '') + esc(b.label) + '</button>';
      });
      html += '</div>';
      card.innerHTML = html;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var inputEl = card.querySelector('.modal__input');
      var done = function (v) { overlay.remove(); resolve(v); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
      var closeBtn = card.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { done(null); });
      var btns = card.querySelectorAll('.modal-btn');
      (opts.buttons || []).forEach(function (b, i) {
        btns[i].addEventListener('click', function () {
          // 有输入框时：主按钮返回**输入内容**，其余（取消/关闭）返回 null
          if (!inputEl) { done(b.value); return; }
          done(b.primary ? inputEl.value : null);
        });
      });
      if (inputEl) {
        inputEl.focus();
        inputEl.select();
        inputEl.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            var pb = card.querySelector('.modal-btn--primary');
            if (pb) pb.click();
          } else if (ev.key === 'Escape') { ev.preventDefault(); done(null); }
        });
      }
    });
  }

  // ── 表单渲染 ──
  // ── 转分辨率专用交互：常用比例 + 宽高联动 + 锁链 ──
  // resize 是表单自动渲染的**唯一特例**：比例/锁链是纯前端交互，引擎只收最终 width/height。
  const RESIZE_RATIOS = VL.RATIO_RATIOS;
  const RATIO_PRESETS = VL.RATIO_PRESETS;
  // 画布的锁链状态提到模块级：cvSyncSizeUI() 在 IIFE 之外，也要读它判断是否点亮锁链
  const cvLinkState = VL.createSizeLink(true);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);   // 编码要求宽高为偶数

  // 锁链状态机与画布共用同一份（common.js），避免两边各自维护给出不同答案
  const resizeLink = VL.createSizeLink(true);
  function resizeLinked() {
    return resizeLink.isLinked(state.values.resize.ratio);
  }
  /** 锁定状态下按比例联动（改宽算高 / 改高算宽），结果取偶 */
  function resizePairByWidth(w) {
    const a = RESIZE_RATIOS[state.values.resize.ratio] || [9, 16];
    return even((w * a[1]) / a[0]);
  }
  function resizePairByHeight(h) {
    const a = RESIZE_RATIOS[state.values.resize.ratio] || [9, 16];
    return even((h * a[0]) / a[1]);
  }
  /**
   * 字段当前是否显示：schema 可声明 showWhen: { key, in } ——
   * 依赖的其它参数不满足条件时**直接不渲染**（而不是置灰）。
   * 例：码率控制的 CQ 只在「恒定质量」模式下出现。
   */
  function fieldVisible(stepId, sc) {
    var w = sc.showWhen;
    if (!w) return true;
    var v = state.values[stepId] ? state.values[stepId][w.key] : undefined;
    return w.in.indexOf(v) >= 0;
  }

  /** 重新渲染某步骤的参数区（模式切换导致显隐变化时调用；值以 state 为准不丢失） */
  function rerenderStepParams(stepId) {
    var node = $('stepGroups').querySelector('[data-step-id="' + stepId + '"]');
    if (!node) return;
    var body = node.querySelector('.tl-params');
    var step = null;
    (state.info.steps || []).forEach(function (x) { if (x.id === stepId) step = x; });
    if (!body || !step) return;
    var html = (stepId === 'resize') ? resizeFieldsHtml()
      : (step.schema || []).filter(function (sc) { return fieldVisible(stepId, sc); })
        .map(function (sc) { return paramField(stepId, sc); }).join('');
    body.innerHTML = html || '<span class="tl-field__hint">无需参数（勾选即可生效）</span>';
    if (window.VL_hydrateIcons) window.VL_hydrateIcons(body);
    refreshResizeLink();
  }

  /**
   * 解绑状态下，按当前宽高**反推**比例下拉的显示。
   * 匹配判定**严格相等**（交叉相乘的整数比较，无任何容差）：
   * 1080×1920 = 9:16，但 1081×1920 就是「自定义」。
   */
  // 比例判定（命中常用比例返回其名字，否则返回 1.43:1 这类实际比值）
  const ratioLabelOf = VL.ratioLabelOf;

  /**
   * 把「自定义」那一项的文字换成实际比值（保留 value 不变，逻辑照旧）。
   * real 为空或等于「自定义」时恢复为原始文案。
   */
  function setCustomRatioLabel(sel, real) {
    if (!sel || !sel.options) return;
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      if (o.value !== '自定义') continue;
      o.textContent = (real && real !== '自定义') ? real : '自定义';
      return;
    }
  }

  function syncResizeRatioDisplay() {
    if (resizeLinked()) return;                     // 锁定时下拉由用户选择，不反推
    var w = parseInt(state.values.resize.width, 10);
    var h = parseInt(state.values.resize.height, 10);
    if (!(w > 0) || !(h > 0)) return;
    var match = ratioLabelOf(w, h);
    var sel = $('stepGroups').querySelector('select[data-step="resize"][data-key="ratio"]');
    if (state.values.resize.ratio !== match) state.values.resize.ratio = match;
    if (sel) {
      // 常用比例是固定选项；非常用比例没有对应 option ⇒ 落到「自定义」并把它标成实际比值
      // ⚠ 判断的是「下拉里有没有这一项」（presets），不是「识别表里有没有」（ratios）：
    //   21:9 能被识别出来，但下拉没有这个 option —— 那就该显示在「自定义」项上，
    var known = VL.isPresetRatio(match);
      sel.value = known ? match : '自定义';
      setCustomRatioLabel(sel, known ? '' : match);
    }
  }

  /** 刷新锁链按钮的视觉状态（锁定 = 主题色竖链；解绑 = 灰链） */
  function refreshResizeLink() {
    var btn = $('stepGroups').querySelector('[data-link="resize"]');
    if (!btn) return;
    var linked = resizeLinked();
    btn.classList.toggle('tl-link--on', linked);
    btn.title = linked ? '比例已锁定：修改宽/高会自动联动，点击解绑' : '已解绑：宽高各自独立，点击按当前比例锁定';
    var svg = btn.querySelector('svg');
    if (svg) svg.style.transform = linked ? 'rotate(-45deg)' : 'none';
  }

  /** 转分辨率专用：[画面比例 ▾] [锁链] [宽] [高] 一行排开 */
  function resizeFieldsHtml() {
    var v = state.values.resize;
    var opts = ['9:16', '16:9', '4:3', '3:4', '1:1', '自定义'].map(function (o) {
      return '<option value="' + o + '"' + (o === v.ratio ? ' selected' : '') + '>' + o + '</option>';
    }).join('');
    return '<label class="tl-field"><span class="tl-field__label">画面比例</span>'
      + '<select class="tl-sel" data-step="resize" data-key="ratio">' + opts + '</select>'
      + '<span class="tl-field__hint" title="选常用比例后，改宽/高会按比例自动联动；点锁链解绑可自由设定">'
      + '改宽/高按比例联动</span></label>'
      + '<label class="tl-field"><span class="tl-field__label">宽</span>'
      + '<input class="tl-num" type="number" data-step="resize" data-key="width" value="' + esc(v.width) + '" min="16" step="2"></label>'
      + '<button type="button" class="tl-link" data-link="resize" title="比例锁">'
      + icon('link', 13) + '</button>'
      + '<label class="tl-field"><span class="tl-field__label">高</span>'
      + '<input class="tl-num" type="number" data-step="resize" data-key="height" value="' + esc(v.height) + '" min="16" step="2"></label>';
  }

  // 单个字段：标签 + 输入 + 说明**并排一行**（纵向空间优先给内容，不堆成上下两行）
  function paramField(stepId, sc) {
    var v = state.values[stepId][sc.key];
    var label = '<span class="tl-field__label">' + esc(sc.label || sc.key) + '</span>';
    var hint = sc.hint ? '<span class="tl-field__hint" title="' + esc(sc.hint) + '">' + esc(sc.hint) + '</span>' : '';
    var input = '';
    var type = String(sc.type || 'text');
    if (type === 'number') {
      input = '<input class="tl-num" type="number" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(v) + '"'
        + (sc.min != null ? ' min="' + sc.min + '"' : '') + (sc.max != null ? ' max="' + sc.max + '"' : '')
        + (sc.step != null ? ' step="' + sc.step + '"' : '') + '>';
    } else if (type === 'select') {
      var opts = (sc.options || []).map(function (o) {
        return '<option value="' + esc(o) + '"' + (String(o) === String(v) ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');
      input = '<select class="tl-sel" data-step="' + stepId + '" data-key="' + sc.key + '">' + opts + '</select>';
    } else if (type === 'bool') {
      input = '<label class="opt-check opt-check--nolabel"><input type="checkbox" data-step="' + stepId + '" data-key="' + sc.key + '" data-bool="1"' + (v ? ' checked' : '') + '><span class="opt-check__box"></span></label>';
    } else if (type === 'color') {
      // 颜色值在引擎侧归一化为 0xRRGGBB，界面用原生取色器 + 文本双通道：
      // 取色器方便挑色，文本框允许直接粘贴色值（两处指向同一个 data-key）
      var cv = String(v == null ? '' : v);
      var hex = /^0x([0-9a-fA-F]{6})$/.exec(cv) ? '#' + cv.slice(2) : (cv || '#000000');
      input = '<span class="tl-field__row">'
        + '<input class="tl-color" type="color" data-color-for="' + sc.key + '" value="' + esc(hex) + '">'
        + '<input class="tl-path" type="text" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(cv) + '">'
        + '</span>';
    } else if (type === 'file') {
      input = '<span class="tl-field__row">'
        + '<input class="tl-path" type="text" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(v) + '" placeholder="选择文件…">'
        + '<button type="button" class="tl-mini" data-pick="' + stepId + ':' + sc.key + '">' + iconEl('image', 14) + '选择</button>'
        + '</span>';
    } else {
      input = '<input class="tl-path" type="text" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(v) + '">';
    }
    return '<label class="tl-field">' + label + input + hint + '</label>';
  }

  // 步骤默认**不勾选且折叠**；勾选后自动展开（「勾选了再展开」）
  function stepNode(step) {
    var on = !!state.sel[step.id];
    var div = document.createElement('div');
    div.className = 'tl-step' + (on ? ' tl-step--on tl-step--open' : '');
    div.setAttribute('data-step-id', step.id);
    var params = (step.id === 'resize') ? resizeFieldsHtml()
      : (step.schema || []).filter(function (sc) { return fieldVisible(step.id, sc); })
        .map(function (sc) { return paramField(step.id, sc); }).join('');
    div.innerHTML = '<div class="tl-step__head">'
      + '<label class="opt-check opt-check--nolabel"><input type="checkbox" data-check="' + step.id + '"' + (on ? ' checked' : '') + '><span class="opt-check__box"></span></label>'
      + '<span class="tl-step__arrow" data-fold="' + step.id + '" title="展开/收起参数">' + iconEl('chevron-right', 13) + '</span>'
      + '<span class="tl-step__title">' + esc(step.title || step.id) + '</span>'
      + (step.danger === 'lossy' ? '<span class="tl-step__flag">会丢内容</span>' : '')
      + '</div>'
      + '<div class="tl-params">' + (params || '<span class="tl-field__hint">无需参数（勾选即可生效）</span>') + '</div>';
    return div;
  }

  function renderSteps() {
    var host = $('stepGroups');
    host.innerHTML = '';
    (state.info.groups || []).forEach(function (g) {
      var box = document.createElement('div');
      box.className = 'tl-group tl-group--open';
      box.innerHTML = '<div class="tl-group__head">'
        + '<span class="tl-group__arrow">' + iconEl('chevron-right', 14) + '</span>'
        + '<span>' + esc(g.group) + '</span>'
        + '<span class="tl-group__count">' + g.steps.length + ' 项</span>'
        + '</div>';
      var body = document.createElement('div');
      body.className = 'tl-group__body';
      g.steps.forEach(function (s) { body.appendChild(stepNode(s)); });
      box.appendChild(body);
      box.querySelector('.tl-group__head').addEventListener('click', function () {
        box.classList.toggle('tl-group--open');
      });
      host.appendChild(box);
    });
    if (window.VL_hydrateIcons) window.VL_hydrateIcons(host);
    refreshResizeLink();
  }

  // ── 参数收集与回填 ──
  // 勾选状态的**唯一入口**：点标题行与点复选框都走这里。
  // ★ 不能靠「派发不指定 bubbles 的 change 事件」—— 那种事件不冒泡，
  function setStepOn(sid, on) {
    state.sel[sid] = !!on;
    var node = $('stepGroups').querySelector('[data-step-id="' + sid + '"]');
    if (node) {
      node.classList.toggle('tl-step--on', !!on);
      // 勾选即展开、取消即收起 —— 参数区只在需要时出现
      node.classList.toggle('tl-step--open', !!on);
    }
    var cb = node && node.querySelector('input[data-check]');
    if (cb) cb.checked = !!on;
  }

  /** 手动展开/收起（不改勾选状态） */
  function toggleStepOpen(sid) {
    var node = $('stepGroups').querySelector('[data-step-id="' + sid + '"]');
    if (node) node.classList.toggle('tl-step--open');
  }

  function bindFormEvents() {
    var host = $('stepGroups');
    host.addEventListener('click', function (e) {
      // 折叠箭头：只展开/收起，不改勾选
      var arrow = e.target.closest('[data-fold]');
      if (arrow) { toggleStepOpen(arrow.getAttribute('data-fold')); return; }
      // 转分辨率锁链：切换"按比例联动 / 自由宽高"
      var lk = e.target.closest('[data-link="resize"]');
      if (lk) {
        resizeLink.toggle();
        if (resizeLink.isUserLocked() && state.values.resize.ratio !== '自定义') {
          // 重新锁定：以当前宽为基准按比例校正高
          var w = parseInt(state.values.resize.width, 10);
          if (w > 0) { state.values.resize.height = resizePairByWidth(w); syncResizeInputs(); }
        } else {
          syncResizeRatioDisplay();
        }
        refreshResizeLink();
        return;
      }
      var head = e.target.closest('.tl-step__head');
      if (head) {
        // 点标题行（复选框以外的区域）= 切换勾选；点复选框（.opt-check 区域内）由 label 原生联动
        // 触发 input 的 change，再经 change 委托走 setStepOn —— 若这里也手动切换会双重触发相互抵消
        var cb = head.querySelector('input[data-check]');
        if (cb && !e.target.closest('.opt-check')) setStepOn(cb.getAttribute('data-check'), !cb.checked);
        return;
      }
      var pick = e.target.closest('button[data-pick]');
      if (pick) {
        var parts = pick.getAttribute('data-pick').split(':');
        var input = host.querySelector('input[data-step="' + parts[0] + '"][data-key="' + parts[1] + '"]');
        if (!api || !api.pick_image) return;
        api.pick_image(input ? input.value : '').then(function (p) {
          if (p && input) { input.value = p; }
        }).catch(function () {});
      }
    });
    host.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var sid = t.getAttribute('data-check');
      if (sid) {
        setStepOn(sid, !!t.checked);
        // 步骤勾选/取消进日志：记录本次勾选的步骤
        try {
          if (window.VL && VL.vlLogAction) {
            var on = [];
            (state.info.steps || []).forEach(function (x) { if (state.sel[x.id]) on.push(x.id); });
            VL.vlLogAction('ui.tool.step', (t.checked ? '启用步骤 ' : '停用步骤 ') + sid,
              { ctx: { step: sid, on: String(t.checked ? 1 : 0), enabled: on.join(',') } });
          }
        } catch (e2) {}
        return;
      }
      var step = t.getAttribute('data-step');
      var key = t.getAttribute('data-key');
      if (!step || !key) return;
      var isBool = !!t.getAttribute('data-bool');
      state.values[step][key] = isBool ? !!t.checked : t.value;
      // 步骤参数变更进日志（与勾选同一入口）：记录每个参数的当前取值
      try {
        if (window.VL && VL.vlLogAction) {
          var v = isBool ? String(!!t.checked) : String(t.value);
          VL.vlLogAction('ui.tool.param', step + '.' + key + ' = ' + v.slice(0, 60), {
            level: 'info', ctx: { step: step, key: key, value: v.slice(0, 60) },
          });
        }
      } catch (e2) {}
      // 该字段是显隐条件的依赖键 → 重渲染参数区（模式切换后只显示生效中的参数）
      var changed = null;
      (state.info.steps || []).forEach(function (x) { if (x.id === step) changed = x; });
      var dep = changed && (changed.schema || []).some(function (sc) {
        return sc.showWhen && sc.showWhen.key === key;
      });
      if (dep) rerenderStepParams(step);
      // 比例下拉变化：选「自定义」即解绑；选常用比例即锁定并按当前宽校正高
      if (step === 'resize' && key === 'ratio') {
        // ⚠ 这里**不改** state.link.resize：锁链是用户的选择，选比例只是"换画幅"。
        //   若在此把它设回 true，用户"先解绑、再挑个常用画幅、然后自由微调"的用法
        //   会被重新锁上，改宽就自动改高 —— 与他的意图相反。
        var pr = RATIO_PRESETS[state.values.resize.ratio];
        if (pr) {
          state.values.resize.width = pr[0];
          state.values.resize.height = pr[1];
          syncResizeInputs();
        }
        refreshResizeLink();
      }
    });

  /** 把 state 里的宽高回写到输入框（联动计算后调用） */
  function syncResizeInputs() {
    var host = $('stepGroups');
    var wi = host.querySelector('input[data-step="resize"][data-key="width"]');
    var hi = host.querySelector('input[data-step="resize"][data-key="height"]');
    if (wi) wi.value = state.values.resize.width;
    if (hi) hi.value = state.values.resize.height;
  }
    host.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var step = t.getAttribute('data-step');
      var key = t.getAttribute('data-key');
      if (!step || !key || t.getAttribute('data-bool')) return;
      state.values[step][key] = t.value;
      // 锁链开启：改宽联动高 / 改高联动宽
      if (step === 'resize' && (key === 'width' || key === 'height')) {
        var v = parseInt(t.value, 10);
        if (v > 0) {
          if (resizeLinked()) {
            // 锁链开启：改宽联动高 / 改高联动宽
            var otherKey = key === 'width' ? 'height' : 'width';
            state.values.resize[otherKey] = key === 'width' ? resizePairByWidth(v) : resizePairByHeight(v);
            var other = $('stepGroups').querySelector('input[data-step="resize"][data-key="' + otherKey + '"]');
            if (other) other.value = state.values.resize[otherKey];
          } else {
            // 锁链解绑：宽高独立，但比例显示要跟上实际宽高
            syncResizeRatioDisplay();
          }
        }
      }
    });
  }

  // ── Web 目录选择器 ──
  // 浏览器端没有本机文件对话框；系统对话框依赖本体窗口的前台状态（焦点在浏览器时
  // list_dir 只读目录名/文件名，桌面端与浏览器端体验一致。
  function renderInputHint() {
    var hint = $('inputHint');
    if (state.files.length) {
      hint.className = 'tl-hint';
      hint.textContent = '已选 ' + state.files.length + ' 个视频文件';
    } else if (state.root) {
      hint.className = 'tl-hint';
      hint.textContent = '将' + (state.recursive ? '递归' : '仅在本层') + '扫描该文件夹下的视频'
        + '（跳过输出与备份文件夹）';
    } else {
      hint.className = 'tl-hint';
      hint.textContent = '请选择文件夹，或直接选择若干视频文件';
    }
    // 输入变化 → 刷新预览样本清单并自动预览一帧（folder 扫描是异步的，扫描完成后才渲，天然避免竞态）
    cvLoadSamples(true);
  }

  /**
   * 输出设置数据层：**一套 UI、两套数据**。
   * 后处理与画布合成的输出项完全相同，界面没必要各写一份；但两者的**取值必须互不影响** ——
   * 于是共用 DOM，按当前标签页绑定到各自的数据：切换前先把 DOM 存回旧模块，再载入新模块。
   */
  var outStore = {
    post: { mode: 'overwrite', dir: '', nameMode: 'keep', suffix: '_处理', onConflict: 'index', backup: false, backupDir: '' },
    canvas: { mode: 'directory', dir: '', nameMode: 'keep', suffix: '_横版', onConflict: 'index', backup: true, backupDir: '' },
  };
  var outBound = 'post';   // 当前绑定的模块：'post'（后处理）| 'canvas'（画布合成）

  /** DOM → 当前绑定模块的数据（任何输出控件的改动都调用它） */
  function outCollect() {
    var d = outStore[outBound];
    if (!d) return outStore.post;
    d.mode = $('outMode').value;
    d.dir = String($('outDir').value || '').trim();
    d.nameMode = $('outNameMode').value;
    d.suffix = String($('outSuffix').value || '');
    d.onConflict = $('outConflict').value;
    d.backup = !!$('outBackup').checked;
    d.backupDir = String($('outBackupDir').value || '').trim();
    return d;
  }

  /** 当前绑定模块的数据 → DOM */
  function outApply() {
    var d = outStore[outBound] || outStore.post;
    $('outMode').value = d.mode;
    $('outDir').value = d.dir;
    $('outNameMode').value = d.nameMode;
    $('outSuffix').value = d.suffix;
    $('outConflict').value = d.onConflict;
    $('outBackup').checked = !!d.backup;
    $('outBackupDir').value = d.backupDir;
    syncOutputRows();
  }

  /** 切换绑定（切标签页时调用）：先存旧模块，再载入新模块 */
  function outBind(moduleName) {
    var m = moduleName === 'canvas' ? 'canvas' : 'post';
    if (m === outBound) { outApply(); return; }
    outCollect();
    outBound = m;
    outApply();
  }

  /** 底部「开始」按钮：同一个按钮承担两个模块的提交，文案随当前标签页切换 */
  function syncRunButton() {
    var b = $('btnRun');
    if (!b) return;
    b.innerHTML = icon('play', 16) + (outBound === 'canvas' ? '开始合成' : '开始处理');
  }

  function syncOutputRows() {
    var dirMode = $('outMode').value === 'directory';
    var head = $('outHead');
    if (head) head.textContent = outBound === 'canvas' ? '输出设置（画布合成）' : '输出设置（后处理）';
    $('outDirRow').classList.toggle('tl-out__row--hide', !dirMode);
    $('outNameRow').classList.toggle('tl-out__row--hide', !dirMode);
    // 文件名选「原名」时不需要后缀框（后缀只对「原名 + 后缀」有意义）
    var sfx = $('outSuffix');
    if (sfx) sfx.hidden = $('outNameMode').value !== 'suffix';
    // 输出编码行只属于画布合成：参数存在 cv.params，后处理用的是「转码 / 码率」步骤参数。
    // ⚠ 用 tl-out__row--hide 类而不是 hidden 属性 —— 本行是 display:flex，
    //   hidden 属性会被 flex 布局覆盖（[hidden] 的 UA 样式优先级低于类选择器）。
    var encRow = $('cvEncRow');
    if (encRow) encRow.classList.toggle('tl-out__row--hide', outBound !== 'canvas');
    $('outModeHint').textContent = dirMode
      ? '空文件夹 → 直接输出；已有文件 → 自动新建子文件夹'
      : '处理结果直接替换原文件（有备份可还原）';
    // 开启备份时不额外说明：默认落点属于"看过一次就够"的信息，常驻界面只会挤占空间。
    // 只在**关闭**备份时提示 —— 那是有后果的信息（覆盖后不可恢复），值得留在视线里。
    $('outHint').textContent = $('outBackup').checked ? '' : '已关闭备份：覆盖后原文件不可恢复';
  }

  function bindOutputEvents() {
    // 任一输出控件改动：先刷新行的显隐，再把值落回「当前标签页」那一份（两模块互不影响）
    var onOut = function () { syncOutputRows(); outCollect(); };
    $('outMode').addEventListener('change', onOut);
    $('outBackup').addEventListener('change', onOut);
    $('outNameMode').addEventListener('change', onOut);   // 原名 ⇄ 原名+后缀：后缀框随之显隐
    ['outDir', 'outSuffix', 'outConflict', 'outBackupDir'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener(id === 'outConflict' ? 'change' : 'input', outCollect);
    });
    $('btnPickDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('当前环境不支持文件夹选择', 'error'); return; }
      api.pick_directory('选择要处理的文件夹', state.root || undefined).then(function (p) {
        if (p) { state.root = p; state.files = []; $('inRoot').value = p; renderInputHint(); }
      });
    });
    $('btnPickFiles').addEventListener('click', function () {
      if (!api || !api.pick_paths_files) return;
      api.pick_paths_files().then(function (list) {
        if (list && list.length) { state.files = list.slice(); state.root = ''; $('inRoot').value = list.join('；'); renderInputHint(); }
      }).catch(function () {});
    });
    $('btnClearInput').addEventListener('click', function () {
      state.root = ''; state.files = []; $('inRoot').value = ''; renderInputHint();
    });
    // 手填目录路径：**浏览器端**没有本机文件对话框可用（只能由本体代弹），
    // 因此路径栏必须可直接输入 —— 粘贴/手输后立即生效，并给出存在性反馈
    var _rootTimer = null;
    $('inRoot').addEventListener('input', function () {
      var v = String($('inRoot').value || '').trim().replace(/^"|"$/g, '');
      state.files = [];
      state.root = v;
      renderInputHint();
      clearTimeout(_rootTimer);
      if (!v) { notify('请选择文件夹，或直接粘贴路径', 'info'); return; }
      _rootTimer = setTimeout(function () {
        if (!api || !api.check_exists) return;
        api.check_exists([v]).then(function (m) {
          if (String($('inRoot').value || '').trim() !== v) return;   // 已改成别的路径
          if (m && m[v]) setStatus('文件夹有效：' + v);
          else toast('文件夹不存在：' + v, 'error');
        }).catch(function () {});
      }, 400);
    });
    $('inRecursive').addEventListener('change', function () { state.recursive = !!$('inRecursive').checked; renderInputHint(); });
    $('btnPickOutDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('当前环境不支持文件夹选择', 'error'); return; }
      api.pick_directory('选择输出文件夹', $('outDir').value || state.root || undefined).then(function (p) {
        if (p) $('outDir').value = p;
      });
    });
    $('btnPickBackupDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('当前环境不支持文件夹选择', 'error'); return; }
      api.pick_directory('选择备份文件夹', $('outBackupDir').value || state.defaultBackupDir || undefined).then(function (p) {
        if (p) $('outBackupDir').value = p;
      });
    });
    var obb = $('btnOpenBackupDir');
    if (obb) obb.addEventListener('click', function () {
      if (!api || !api.open_folder_select) { toast('当前环境不支持打开文件夹', 'error'); return; }
      api.open_folder_select($('outBackupDir').value.trim() || state.defaultBackupDir).then(function (r) {
        if (r && r.ok === false) { toast('打开备份文件夹失败：' + (r.error || '未知错误'), 'error'); return; }
        // 浏览器端由本体代开：explorer 可能被 Windows 前台锁压到后台，只在任务栏出现 —— 明确告知去哪看
        if (!VL.host.isElectron) toast('资源管理器已在后台打开，可从任务栏查看', 'info');
      }).catch(function (e) { toast('打开备份文件夹失败：' + e.message, 'error'); });
    });
    $('logHead').addEventListener('click', function () { $('logBox').classList.toggle('tl-log--open'); });
    // 底部「开始」按钮两页共用：按当前标签页分派到各自的提交（后处理 / 画布合成）
    $('btnRun').addEventListener('click', function () {
      if (outBound === 'canvas') cvRun(); else onSubmit();
    });
  }

  function collectSpec() {
    var stepIds = Object.keys(state.sel).filter(function (k) { return state.sel[k]; });
    if (!stepIds.length) return { error: '请至少勾选一个处理步骤' };
    if (!state.root && !state.files.length) return { error: '请选择要处理的文件夹或视频文件' };
    if (outStore.post.mode === 'directory' && !outStore.post.dir) return { error: '请选择输出文件夹' };
    // 数字型参数在表单里是字符串，提交前统一还原成数字（引擎侧按数字判断阈值）
    var coerce = function (v) {
      if (v == null || v === '' || typeof v === 'number' || typeof v === 'boolean') return v;
      var s = String(v).trim();
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
    };
    // 只提交勾选步骤的参数（未勾选的不参与，避免引擎拿到无关参数）
    var params = {};
    stepIds.forEach(function (id) {
      var src = state.values[id] || {};
      var schemaOf = null;
      (state.info.steps || []).forEach(function (x) { if (x.id === id) schemaOf = x.schema || []; });
      var visible = {};
      schemaOf.forEach(function (sc) { if (fieldVisible(id, sc)) visible[sc.key] = 1; });
      var dst = {};
      Object.keys(src).forEach(function (k) { if (visible[k]) dst[k] = coerce(src[k]); });
      params[id] = dst;
    });
    return {
      spec: {
        root: state.files.length ? '' : state.root,
        files: state.files,
        recursive: state.recursive,
        stepIds: stepIds,
        params: params,
        output: {
          mode: outStore.post.mode,
          dir: outStore.post.dir,
          nameMode: outStore.post.nameMode,
          suffix: outStore.post.suffix,
          onConflict: outStore.post.onConflict,
          backup: !!outStore.post.backup,
          backupDir: outStore.post.backupDir,
        },
      },
    };
  }

  function stepTitles(ids) {
    var map = {};
    (state.info.steps || []).forEach(function (s) { map[s.id] = s.title || s.id; });
    return ids.map(function (id) { return map[id] || id; });
  }

  function onSubmit() {
    var c = collectSpec();
    if (c.error) { toast(c.error, 'error'); return; }
    var spec = c.spec;
    var overwrite = spec.output.mode === 'overwrite';
    var titles = stepTitles(spec.stepIds);
    var scope = spec.files.length ? (spec.files.length + ' 个文件') : spec.root;
    if (overwrite) {
      // 高风险：可能覆盖原文件 → 大窗警告（不用气泡），要素：数量 / 备份状态 / 步骤清单
      var backupOn = spec.output.backup;
      var msg = '<b>将处理：</b>' + esc(scope) + '<br>'
        + '<b>本次启用：</b>' + esc(titles.join(' + ')) + '<br>'
        + '<b>处理前备份：</b>' + (backupOn ? '已开启' : '<span style="color:var(--vl-alias-status-error-default);font-weight:600">未开启 —— 覆盖后原文件不可恢复</span>')
        + (spec.files.length ? '' : '<br><b>扫描范围：</b>' + (spec.recursive ? '含子文件夹' : '仅本层'));
      showDialog({
        title: '将覆盖原视频',
        cssClass: 'modal-card--wide',
        message: msg,
        buttons: [{ label: '取消', value: false }, { label: '确认开始', value: true, primary: true, danger: true, icon: 'play' }],
      }).then(function (ok) { if (ok) doRun(spec); });
      return;
    }
    doRun(spec);
  }

  function doRun(spec) {
    setStatus('正在创建任务…');
    api.run_tool(spec).then(function (r) {
      setRunEnabled(true);
      if (!r || !r.ok) { toast((r && r.error) || '创建任务失败', 'error'); return; }
      state.taskId = r.taskId;
      showLogBox('任务已加入队列 · ' + r.taskId);
      setStatus('已加入执行队列（在任务列表中查看进度与结果）', 'ok');
      watchTask(r.taskId);
    }).catch(function (e) {
      setRunEnabled(true);
      toast('创建任务失败：' + ((e && e.message) || e), 'error');
    });
  }

  // ── 任务进度（复用任务窗口同一份广播）──
  function showLogBox(title) {
    $('logBox').hidden = false;
    $('logBox').classList.add('tl-log--open');
    $('logTitle').textContent = title;
  }

  function watchTask(taskId) {
    if (!api || !api.on_task_update) return;
    if (state.unsub) { try { state.unsub(); } catch (e) {} }
    state.unsub = api.on_task_update(function (tasks) {
      if (!Array.isArray(tasks)) return;
      var t = null;
      for (var i = 0; i < tasks.length; i++) if (tasks[i].id === taskId) { t = tasks[i]; break; }
      if (!t) return;
      var lines = t.log || [];
      $('logBody').textContent = lines.slice(-300).join('\n');
      $('logCount').textContent = lines.length ? (lines.length + ' 行') : '';
      var body = $('logBody');
      body.scrollTop = body.scrollHeight;
      var total = (t.progress && t.progress.total) || 0;
      var cur = (t.progress && t.progress.current) || 0;
      var pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
      $('progBar').style.width = pct + '%';
      // 与任务窗口共用同一份状态文案（VL.STATUS_TEXT）—— 内联对象会让两个窗口
      // 对同一个 running 一个显示「处理中」一个「运行中」，所以统一走共享定义。
      var label = ((window.VL && window.VL.STATUS_TEXT) || {})[t.status] || t.status;
      var detail = total > 0 ? ('　' + cur + ' / ' + total) : '';
      var live = t.progress && t.progress.liveLine;
      if (t.status === 'running' && live && live.time) detail += '　' + live.time;
      setStatus('任务' + label + detail, t.status === 'error' ? 'err' : (t.status === 'done' ? 'ok' : ''));
      if (t.status === 'done' || t.status === 'error' || t.status === 'stopped' || t.status === 'interrupted') {
        if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
      }
    });
  }

  // ════════════ 画布合成（竖转横）：单帧预览 + 参数双向同步 ════════════
  // 舞台三层结构：背景层底图（精确渲染的纯背景）＋ 内容层（拖动期用内容原帧做本地几何变换，
  // 零延迟可跟手）＋ 覆盖层（手柄与吸附参考线）；非拖动状态显示精确合成图。
  var cv = {
    ready: false,
    params: {
      bgMode: 'dir', bgDir: '', bgPath: '', bgColor: '#000000', watermark: '',
      targetW: 1920, targetH: 1080,
      scale: 0.74,
      bgFit: 'cover',       // 背景适合方式（与 Windows 桌面背景同名：填充 / 适应 / 拉伸）
      posMode: 'center', dx: 0, dy: 160,
      radius: 0, borderW: 0, borderColor: '#ffffff', bgBlur: 0,
    },
    at: 0,
    duration: 0,
    live: false,                   // 是否开启「实时预览」（默认关：占位示意即时反馈，微调不等渲染）
    lastAR: 0,                     // 上次用于预览的宽高比：比例一变就作废旧帧（否则旧图会被按新画布拉伸）
    inflight: false, pending: false,   // 渲染中标记 / 渲染期间又改过参数的"待渲"标记（合并请求，避免排队）
    samples: [], sampleIndex: 0,   // 预览样本清单（文件夹输入 = 待处理视频；文件输入 = 所选文件）
    bgIndex: 0, bgTotal: 0, bgName: '', bgSizes: [],   // 背景候选：序号 / 总数 / 名称 / 各自尺寸（展示用）
    box: { x: 0, y: 0, w: 0, h: 0 },   // 内容盒（画布像素；精确渲染后以服务端元数据为准）
    meta: null,
    drag: null,
    seq: 0,
    timer: 0,
    busyRetry: 0,
    syncing: false,                    // 程序性写入控件时置真，避免与用户输入形成回环
    snap: 10,                          // 吸附阈值（显示像素）
  };

  function cvCss(el, obj) { if (el) { for (var k in obj) el.style[k] = obj[k]; } }
  function cvNum(el, fallback) {
    var v = Number(el && el.value);
    return isFinite(v) ? v : fallback;
  }
  function cvCanvasW() { return Math.max(16, Number(cv.params.targetW) || 1920); }
  function cvCanvasH() { return Math.max(16, Number(cv.params.targetH) || 1080); }

  /**
   * 预览舞台比例跟随输出尺寸 —— **本地即时**（不等渲染，占位模式下也立刻正确）。
   * 同时写入 `--cv-ar`（宽/高数值）：CSS 用它反推宽度上限，与 max-height 配合把竖向输出的预览限制在可视区内
   * （否则 9:16 会让预览框高度≈宽度的 1.78 倍，页面被撑得很长）。
   */
  var CV_STAGE_MAX_VH = 0.58;   // 预览高度上限（视口比例）：超过则按比例收窄宽度（contain），保证竖向输出不成"长条"

  /** 比例/分辨率变化后旧帧不再可信：清掉它，回到占位显示（否则旧图会被按新画布**拉伸**，观感很怪） */
  function cvClearFrame() {
    var bg = $('cvBg'), comp = $('cvComp');
    if (bg) bg.removeAttribute('src');
    if (comp) comp.removeAttribute('src');
    cvSetBadge('画布比例已改 · 待渲染（或开启实时预览）', '');
  }

  function cvSyncStageAspect() {
    var stage = $('cvCanvas');
    if (!stage) return;
    var W = cvCanvasW(), H = cvCanvasH();
    var ar = W / Math.max(1, H);                 // 输出宽高比（由「成片画布尺寸」决定）
    // 比例变了 → 旧帧作废（同比例的纯分辨率变化不清：形状一致，缩放后仍正确）
    if (cv.lastAR && Math.abs(cv.lastAR - ar) > 0.0001) cvClearFrame();
    cv.lastAR = ar;
    var raw = stage.parentElement ? stage.parentElement.clientWidth : 0;
    if (!raw) {
      // 面板隐藏 / 布局未就绪（clientWidth=0）：**不要**给显式尺寸 ——
      // 否则会按最小宽 160 算出一个 160×90 的小方块（初始进入画布页时的"小方块"就是这么来的）。
      // 交给 CSS 兜底（width:100% + aspect-ratio），等真正可见时再显式算。
      stage.style.width = ''; stage.style.height = '';
      stage.style.aspectRatio = String(W) + ' / ' + String(H);
      return;
    }
    var availW = Math.max(160, raw);             // 舞台已无内边距 → 可用宽即舞台内容宽
    var capH = Math.max(180, Math.round(window.innerHeight * CV_STAGE_MAX_VH));
    var w = availW, h = w / ar;
    if (h > capH) { h = capH; w = h * ar; }      // 高度触顶 → 等比缩窄（绝不压扁）
    stage.style.aspectRatio = 'auto';            // 尺寸下面显式给，避免 aspect-ratio 与显式高度互相打架
    stage.style.width = Math.round(w) + 'px';
    stage.style.height = Math.round(h) + 'px';
    if (cv.box && cv.box.w) cvPaintBox();        // 画布尺寸变了：内容盒是百分比定位，需要重绘
  }

  /** 画布像素 → 显示像素的比例（手柄拖动与吸附阈值换算用） */
  function cvViewScale() {
    var el = $('cvCanvas');
    if (!el) return 1;
    var r = el.getBoundingClientRect();
    return r.width > 0 ? r.width / cvCanvasW() : 1;
  }

  function cvSetBadge(text, kind) {
    var el = $('cvBadge');
    if (!el) return;
    el.textContent = text;
    el.className = 'cv-badge' + (kind ? ' cv-badge--' + kind : '');
  }

  function cvShowWarnings(list) {
    var el = $('cvWarn');
    if (!el) return;
    var arr = (list || []).filter(Boolean);
    el.textContent = arr.length ? ('· ' + arr.join('\n· ')) : '';
    el.style.whiteSpace = 'pre-line';
  }

  /** 预览源 = 当前样本（由 cvLoadSamples 维护；可用「样本 上一个/下一个」切换） */
  function cvContentPath() {
    if (!cv.samples || !cv.samples.length) return '';
    var i = Math.max(0, Math.min(cv.sampleIndex || 0, cv.samples.length - 1));
    return cv.samples[i] || '';
  }

  /** 样本信息条：显示「第 n/共 N 个 · 文件名」；有样本才显示该行 */
  function cvSetSampleInfo() {
    // 内容清单变了 → 状态栏的「将生成多少条」随之刷新。
    // ⚠ 放在本函数最前（而非各调用点）：它是**所有**内容变更路径的汇合处
    //   （选文件 / 扫描文件夹 / 清空 / 切样本），逐处补容易漏。
    try { cvCountHint(); } catch (e) {}
    var el = $('cvSampleInfo');
    var bar = $('cvSampleRow');
    var n = (cv.samples || []).length;
    if (bar) bar.style.display = n ? '' : 'none';
    if (!el) return;
    if (!n) { el.textContent = '—'; el.title = ''; return; }
    var p = cvContentPath();
    el.textContent = (cv.sampleIndex + 1) + '/' + n + ' · ' + String(p || '').split(/[\\/]/).pop();
    // 名称超长时界面省略 → 悬浮显示完整路径（并说明样本与批量的关系）
    el.title = p + '\n预览只用这一个样本；正式处理会对上方清单里的全部视频逐个合成（参数共用，背景每个视频独立随机）';
  }

  /** 刷新样本清单：文件清单优先，否则按文件夹向后端要一份（与正式处理同一套扫描规则） */
  function cvLoadSamples(andPreview) {
    if (state.files && state.files.length) {
      cv.samples = state.files.slice();
      try { cvCountHint(); } catch (e) {}
      cv.sampleIndex = 0;
      cvSetSampleInfo();
      if (andPreview) { cv.duration = 0; cvRequestPreview({ immediate: true, force: true }); }
      return;
    }
    var root = String(state.root || '').trim();
    if (!root || !api || !api.canvas_list_sources) {
      cv.samples = []; cv.sampleIndex = 0; cvSetSampleInfo(); try { cvCountHint(); } catch (e) {} return;
    }
    api.canvas_list_sources(root, state.recursive !== false).then(function (r) {
      cv.samples = (r && r.ok && r.list) ? r.list.map(function (x) { return x.path; }) : [];
      cv.sampleIndex = 0;
      cvSetSampleInfo();
      if (andPreview && cv.samples.length) { cv.duration = 0; cvRequestPreview({ immediate: true, force: true }); }
    }).catch(function () { cv.samples = []; cv.sampleIndex = 0; cvSetSampleInfo(); });
  }

  /** 切换样本（序号环绕）：样本换了时长就未知，时间点与内容盒都要跟着重算 */
  function cvSampleStep(step) {
    var n = (cv.samples || []).length;
    if (!n) { toast('请先在上方选择文件夹或视频文件', 'info'); return; }
    cv.sampleIndex = ((cv.sampleIndex + step) % n + n) % n;
    cv.duration = 0;
    cv.at = 0;
    cvSetSampleInfo();
    cvRequestPreview({ immediate: true, force: true });
  }

  /** 内容盒按参数推算（与滤镜表达式同一套公式：一律等比缩放；服务端 meta.contentBox 为权威值） */
  function cvContentSize() {
    var srcW = (cv.meta && cv.meta.contentSrcW) || 0;
    var srcH = (cv.meta && cv.meta.contentSrcH) || 0;
    if (!srcW || !srcH) return { w: 0, h: 0 };
    var bw = cv.params.borderW > 0 ? Math.round(cv.params.borderW) : 0;
    return {
      w: Math.round(srcW * cv.params.scale) + bw * 2,
      h: Math.round(srcH * cv.params.scale) + bw * 2,
    };
  }

  /** 位置基准（偏移为 0 时的左上角坐标） */
  function cvBaseOffset(w, h) {
    var W = cvCanvasW(), H = cvCanvasH();
    switch (cv.params.posMode) {
      case 'tl': return { x: 0, y: 0 };
      case 'tr': return { x: W - w, y: 0 };
      case 'bl': return { x: 0, y: H - h };
      case 'br': return { x: W - w, y: H - h };
      case 'custom': return { x: 0, y: 0 };
      default: return { x: (W - w) / 2, y: (H - h) / 2 };
    }
  }

  function cvComputeBox() {
    var size = cvContentSize();
    if (!size.w || !size.h) return null;
    var base = cvBaseOffset(size.w, size.h);
    return { x: base.x + (Number(cv.params.dx) || 0), y: base.y + (Number(cv.params.dy) || 0), w: size.w, h: size.h };
  }

  /** 把内容盒写到 DOM（拖动期每帧调用，保证零延迟跟手） */
  function cvPaintBox() {
    var W = cvCanvasW(), H = cvCanvasH();
    var b = cv.box;
    var p = {
      left: (b.x / W * 100) + '%', top: (b.y / H * 100) + '%',
      width: (b.w / W * 100) + '%', height: (b.h / H * 100) + '%',
    };
    var vs = cvViewScale();
    var extra = { borderRadius: Math.max(0, cv.params.radius * vs) + 'px' };
    if (cv.params.borderW > 0) {
      extra.border = Math.max(1, cv.params.borderW * vs) + 'px solid ' + cv.params.borderColor;
    } else extra.border = '1px solid var(--vl-alias-brand-500)';
    // 占位示意块：与内容盒共用几何（拖动/改参数即时跟手），虚线表示"这是示意、不是渲染结果"
    cvCss($('cvHoldBox'), Object.assign({}, p, { borderRadius: extra.borderRadius, border: '1px dashed var(--vl-alias-brand-500)' }));
    var box = $('cvBox');
    cvCss(box, Object.assign({}, p, extra));
  }

  /**
   * 占位示意：未开启「实时预览」时启用 —— 真实帧做底 + 内容块虚线，几何用**本地公式**即时重算，
   * 因此拖动/改参数零延迟（不必等渲染）。开启实时预览后本层隐藏，一切以渲染结果为准。
   * ⚠ 本地几何只是近似（边框外扩、偶数对齐等细节以服务端 meta.contentBox 为准），开启预览时会被精确校正。
   */
  function cvPaintHold() {
    var stage = $('cvCanvas');
    if (!stage) return;
    stage.classList.toggle('cv-canvas--hold', !cv.live);
    if (cv.live) return;
    var nb = cvComputeBox();
    if (nb && nb.w > 0 && nb.h > 0) cv.box = nb;
    cvPaintBox();
    var tag = $('cvHoldTag');
    if (tag) {
      tag.textContent = (cv.box.w ? Math.round(cv.box.w) + '×' + Math.round(cv.box.h) + ' · ' : '') + '占位示意（未开启实时预览）';
    }
    cvSetBadge('占位示意 · 未开启实时预览', '');
  }

  /** 把内容盒反解回参数（拖动结束时用；custom 模式直接写绝对坐标） */
  function cvBoxToParams(b) {
    if (cv.params.posMode === 'custom') { cv.params.dx = Math.round(b.x); cv.params.dy = Math.round(b.y); return; }
    var base = cvBaseOffset(b.w, b.h);
    cv.params.dx = Math.round(b.x - base.x);
    cv.params.dy = Math.round(b.y - base.y);
  }

  function cvWriteBackInputs(keys) {
    cv.syncing = true;
    try {
      var map = {
        scale: 'cvScaleNum', dx: 'cvDx', dy: 'cvDy',
        targetW: 'cvTW', targetH: 'cvTH', radius: 'cvRadius', borderW: 'cvBorderW', bgBlur: 'cvBgBlur',
        encCq: 'cvEncCq',
      };
      (keys || Object.keys(map)).forEach(function (k) {
        var el = $(map[k]);
        if (!el) return;
        el.value = String(cv.params[k]);
        if (k === 'scale') { var s = $('cvScale'); if (s) s.value = String(cv.params[k]); }
        if (k === 'radius') { var rv = $('cvRadiusVal'); if (rv) rv.textContent = String(cv.params.radius); }
        if (k === 'borderW') { var bv = $('cvBorderWVal'); if (bv) bv.textContent = String(cv.params.borderW); }
        if (k === 'bgBlur') { var gv = $('cvBgBlurVal'); if (gv) gv.textContent = String(cv.params.bgBlur); }
        if (k === 'encCq') { var ev = $('cvEncCqVal'); if (ev) ev.textContent = String(cv.params.encCq); }
      });
    } finally { cv.syncing = false; }
  }

  function cvSyncBgRows() {
    var m = cv.params.bgMode;
    $('cvBgDirRow').hidden = m !== 'dir';
    $('cvBgPathRow').hidden = !(m === 'image' || m === 'video');
    // 「每个背景各出一条」只在**目录**方式下成立：image/video 是单一指定背景、
    // color 没有背景文件。其余方式隐藏该开关，避免"勾了却看不出任何变化"。
    var row = $('cvEachBgRow');
    if (row) row.hidden = m !== 'dir';
    var eb = $('cvEachBg');
    if (eb && !eb._vlBound) {
      eb._vlBound = true;
      eb.addEventListener('change', function () {
        // 勾选时若还没有候选清单，顺手扫一次 —— 否则清单为空会让提交被拦下
        // （报错提示是对的，但能让用户少一次往返就少一次）。
        if (eb.checked && !(cv.bgList || []).length) { try { cvScanBackgrounds(false); } catch (e) {} }
        try { cvCountHint(); } catch (e) {}
      });
    }
    try { cvCountHint(); } catch (e) {}
  }

  function cvRequestPreview(opts) {
    cvSyncStageAspect();   // 输出尺寸可能刚改过：先让预览框比例跟上（本地即时，不等渲染）
    if (cv.timer) { clearTimeout(cv.timer); cv.timer = 0; }
    // 未开启「实时预览」时：连续型改动（拖内容盒 / 滑杆 / 数值）只刷新**本地占位示意**，不调渲染进程 ——
    // 这正是占位模式的意义：快速微调不必每次等一帧。明确动作（换样本 / 换背景 / 换帧 / 切开关 / 载预设）
    // 传 force，仍需一张真实帧来更新画面与元数据（时长、素材尺寸、背景候选等）。
    if (!cv.live && !(opts && opts.force)) { cvPaintHold(); return; }
    var delay = (opts && opts.immediate) ? 0 : 200;
    cv.timer = setTimeout(function () {
      cv.timer = 0;
      // 渲染进行中：只记「待渲」标记，等这次回来立刻用**最新参数**补渲一次 —— 不重复排队。
      if (cv.inflight) { cv.pending = true; return; }
      cvDoPreview();
    }, delay);
  }

  /** 渲染收尾：清"渲染中"标记；期间若有新参数（pending），立刻补渲一次（用最新参数，不排队） */
  function cvFinishPreview() {
    cv.inflight = false;
    if (cv.pending) { cv.pending = false; cvRequestPreview({ immediate: true, force: true }); }
  }

  /** 预览失败提示：状态栏小字容易被忽略，补一次吐司；相同原因 4 秒内不重复弹（拖动时可能连发） */
  function cvToastError(msg) {
    var now = Date.now();
    if (cv._errMsg === msg && (now - (cv._errAt || 0)) < 4000) return;
    cv._errMsg = msg; cv._errAt = now;
    try { toast('画布预览失败：' + msg, 'error'); } catch (e) {}
  }

  function cvDoPreview() {
    if (!api || !api.canvas_preview_frame) { cvSetBadge('暂不可用', 'err'); return; }
    var contentPath = cvContentPath();
    if (!contentPath) {
      cvSetBadge('未选择视频', 'err');
      cvShowWarnings(['请先在上方选择要处理的文件夹、或直接选择若干视频文件 —— 预览取清单里的一个样本（用下方「样本 上一个/下一个」切换），正式处理会对全部视频逐个合成']);
      return;
    }
    var mySeq = ++cv.seq;
    cv.inflight = true;
    cvSetBadge(cv.timer ? '渲染中…' : '渲染中…', '');
    var payload = {
      contentPath: contentPath,
      at: cv.at,
      bgIndex: cv.bgIndex,
      params: Object.assign({}, cv.params),
      watermarkPath: cv.params.watermark,
      previewScale: 0.5,
    };
    api.canvas_preview_frame(payload).then(function (r) {
      if (mySeq !== cv.seq) return;                    // 丢弃过期响应（拖动中会产生多份请求）
      if (!r || !r.ok) {
        if (r && String(r.error) === 'BUSY') {         // 主进程并发已满：稍后用最新参数重试
          if (cv.busyRetry < 6) { cv.busyRetry++; cvRequestPreview({ immediate: false }); }
          else { cvSetBadge('渲染繁忙', 'err'); }
          return;
        }
        cv.busyRetry = 0;
        // 时间点越界（滑块范围未及时收紧、视频短于当前值）→ 夹回时长内自动重渲，而不是停在失败态
        if (r && Number(r.duration) > 0 && cv.at > Number(r.duration) - 0.05) {
          cv.duration = Number(r.duration);
          cv.at = Math.max(0, cv.duration - 0.05);
          cvSyncAtControls();
          cvRequestPreview({ immediate: true, force: true });
          return;
        }
        cvSetBadge('预览失败', 'err');
        cvShowWarnings([(r && r.error) || '预览失败']);
        cvToastError((r && r.error) || '预览失败');
        return;
      }
      cv.busyRetry = 0;
      cvApplyResult(r);
    }).catch(function (e) {
      if (mySeq !== cv.seq) return;
      cvSetBadge('预览失败', 'err');
      cvShowWarnings([String((e && e.message) || e)]);
      cvToastError(String((e && e.message) || e));
    }).then(function () { cvFinishPreview(); });   // 成功 / 失败 / 被丢弃（过期响应）都要清标记并处理"待渲"
  }

  /** 把当前时间点写回两个控件，并按已知时长约束范围 —— 越界值一律夹回，避免「拖到超出时长 → 渲染取不到帧」 */
  function cvSyncAtControls() {
    var dur = cv.duration > 0 ? cv.duration : 0;
    if (dur > 0.1) cv.at = Math.max(0, Math.min(cv.at, dur - 0.05));
    var range = $('cvAtRange');
    if (range) {
      range.max = String(dur > 0.1 ? (dur - 0.05) : Math.max(0.1, cv.at));
      range.value = String(cv.at);
    }
    var atEl = $('cvAt');
    if (atEl) {
      atEl.max = String(dur > 0.1 ? (dur - 0.05) : Math.max(0.1, cv.at));
      atEl.value = cv.at.toFixed(1);
    }
  }

  function cvApplyResult(r) {
    var meta = r.meta || {};
    cv.meta = meta;
    if (meta.duration > 0) cv.duration = meta.duration;
    cvSyncAtControls();
    if (meta.contentBox) {
      cv.box = {
        x: Number(meta.contentBox.x) || 0, y: Number(meta.contentBox.y) || 0,
        w: Math.max(2, Number(meta.contentBox.w) || 0), h: Math.max(2, Number(meta.contentBox.h) || 0),
      };
    }
    var stage = $('cvCanvas');
    if (stage) {
      stage.classList.remove('cv-canvas--drag');
      stage.classList.add('cv-canvas--ready');   // 就绪后内容框可拖动（只在拖动中显示的话点不到）
    }
    // ⚠ 先定画布形状再写帧：比例变化时 cvSyncStageAspect 会作废旧帧，
    //   若放在写帧之后会把**刚拿到的新帧**一起清掉（顺序反了就白渲染一帧）
    cvSyncStageAspect();
    if (r.bgOnly) $('cvBg').src = r.bgOnly;
    if (r.composed) $('cvComp').src = r.composed;
    cv.bgTotal = Number(meta.bgTotal) || 0;
    cv.bgIndex = Number(meta.bgIndex) || 0;
    cv.bgName = meta.bgPath ? String(meta.bgPath).split(/[\\/]/).pop() : '';
    cvUpdateBgInfo();
    cvPaintBox();
    cvWriteBackInputs(['scale', 'dx', 'dy', 'w', 'h']);
    cvShowWarnings(meta.warnings || []);
    cvSetBadge((r.fromCache ? '已更新（缓存）' : '已更新 · ' + (r.ms || 0) + 'ms'), 'ok');
    cvPaintHold();   // 占位层跟随（未开启实时预览时继续以占位示意显示几何）
  }

  /** 背景信息（行首已有「背景」标签，这里只说内容；超长省略，完整值放 title） */
  function cvUpdateBgInfo() {
    var el = $('cvBgInfo');
    if (!el) return;
    if (cv.params.bgMode === 'color') { el.textContent = '纯色 ' + cv.params.bgColor; el.title = ''; return; }
    if (cv.params.bgMode === 'dir') {
      var sz = (cv.bgSizes && cv.bgSizes[cv.bgIndex]) || '';
      var txt = cv.bgTotal
        ? ((cv.bgIndex + 1) + '/' + cv.bgTotal + (sz ? ' · ' + sz : '') + (cv.bgName ? ' · ' + cv.bgName : ''))
        : '未扫描';
      el.textContent = txt;
      el.title = txt;
      return;
    }
    el.textContent = cv.bgName || '未选择';
    el.title = cv.params.bgPath || '';
  }

  // ── 拖动 / 缩放 / 拉伸（pointer 事件 + 本地几何变换）──
  function cvPointerPos(e) {
    var el = $('cvCanvas');
    var r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * 吸附（**四宫格**：只对齐**中线与四条边**，不用三分线）。
   * 内容盒的左/中/右三处，各自吸附画布的左边、中线、右边；上/中/下同理。
   * ⚠ 取**距离最近**的一条线吸合：早先按"先命中先返回"处理，候选一多会互相竞争
   */
  function cvSnap(b, alt) {
    if (alt) { cvDrawGuides(0, 0, false); return b; }
    var W = cvCanvasW(), H = cvCanvasH();
    var vs = cvViewScale();
    var tol = cv.snap / Math.max(0.05, vs);
    var pick = function (cands, lines) {
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        for (var j = 0; j < lines.length; j++) {
          var d = lines[j] - cands[i];
          if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, line: lines[j] };
        }
      }
      return best;
    };
    var bx = pick([b.x, b.x + b.w / 2, b.x + b.w], [0, W / 2, W]);
    if (bx) b.x += bx.d;
    var by = pick([b.y, b.y + b.h / 2, b.y + b.h], [0, H / 2, H]);
    if (by) b.y += by.d;
    cvDrawGuides(bx ? bx.line : 0, by ? by.line : 0, true);
    return b;
  }

  /**
   * 尺寸吸附（手柄缩放专用）：只保留两档 —— **满屏（贴满画布四边）** 与 **1/2（正好一半）**。
   * 档位刻意精简：调试中档位过多会让吸附互相争抢、反而难停在目标值；这两档覆盖了"正好占满屏幕 / 正好占一半"的实际需求。
   * 等比缩放只有一个自由度：候选（按画布宽，以及把画布高按当前箱比例折算到宽）统一在**箱宽**上比较取最近命中；
   */
  function cvSnapSizeW(w, ratio) {
    var W = cvCanvasW(), H = cvCanvasH();
    var vs = cvViewScale();
    var tol = cv.snap / Math.max(0.05, vs);
    var cands = [];
    [[1, '满屏'], [1 / 2, '1/2']].forEach(function (it) {
      cands.push({ w: W * it[0], tag: '宽 ' + it[1] });
      cands.push({ w: H * it[0] * ratio, tag: '高 ' + it[1] });
    });
    var best = null;
    cands.forEach(function (c) {
      var d = c.w - w;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, tag: c.tag };
    });
    return best ? { w: w + best.d, tag: best.tag } : null;
  }

  function cvDrawGuides(vx, hy, on) {
    var gv = $('cvGuideV'), gh = $('cvGuideH');
    if (!gv || !gh) return;
    if (!on) { gv.style.display = 'none'; gh.style.display = 'none'; return; }
    if (vx) { gv.style.display = 'block'; gv.style.left = (vx / cvCanvasW() * 100) + '%'; } else gv.style.display = 'none';
    if (hy) { gh.style.display = 'block'; gh.style.top = (hy / cvCanvasH() * 100) + '%'; } else gh.style.display = 'none';
  }

  function cvDragStart(e, mode, handle) {
    var contentPath = cvContentPath();
    if (!contentPath) { cvShowWarnings(['请先在顶部选择用于预览的视频']); return; }
    if (!cv.box.w || !cv.box.h) { cvShowWarnings(['预览尚未就绪，请稍候再拖动']); return; }
    e.preventDefault();
    var p = cvPointerPos(e);
    cv.drag = {
      mode: mode, hd: handle || '',
      startX: p.x, startY: p.y,
      startBox: { x: cv.box.x, y: cv.box.y, w: cv.box.w, h: cv.box.h },
      startParams: { scale: cv.params.scale, dx: cv.params.dx, dy: cv.params.dy },
    };
    try { e.target.setPointerCapture(e.pointerId); } catch (e2) {}
    $('cvCanvas').classList.add('cv-canvas--drag');
    cvSetBadge('拖动中（近似）', 'drag');
  }

  function cvDragMove(e) {
    if (!cv.drag) return;
    var p = cvPointerPos(e);
    var vs = cvViewScale();
    var dx = (p.x - cv.drag.startX) / Math.max(0.01, vs);
    var dy = (p.y - cv.drag.startY) / Math.max(0.01, vs);
    var s = cv.drag.startBox;
    var box = { x: s.x, y: s.y, w: s.w, h: s.h };
    var ratio = s.w / Math.max(1, s.h);

    if (cv.drag.mode === 'move') {
      box.x = s.x + dx; box.y = s.y + dy;
    } else {
      var hd = cv.drag.hd;
      var corner = (hd === 'tl' || hd === 'tr' || hd === 'bl' || hd === 'br');
      if (corner) {
        // 等比缩放：以对角为固定点
        var newW = s.w;
        if (hd === 'br' || hd === 'tr') newW = s.w + dx; else newW = s.w - dx;
        newW = Math.max(16, newW);
        // 尺寸吸附（Alt 临时关闭，与位置吸附一致）：只两档 —— 满屏（内容贴满四边）/ 1/2（正好一半）
        var snapTag = '';
        if (!e.altKey) {
          var sz = cvSnapSizeW(newW, ratio);
          if (sz) { newW = sz.w; snapTag = sz.tag; }
        }
        var newH = Math.round(newW / Math.max(0.01, ratio));
        var newScale = newW / Math.max(1, s.w) * cv.drag.startParams.scale;
        box.w = newW; box.h = newH;
        cv.params.scale = Math.round(newScale * 1000) / 1000;
        if (hd === 'tl') { box.x = s.x + (s.w - newW); box.y = s.y + (s.h - newH); }
        else if (hd === 'tr') { box.x = s.x; box.y = s.y + (s.h - newH); }
        else if (hd === 'bl') { box.x = s.x + (s.w - newW); box.y = s.y; }
        else { box.x = s.x; box.y = s.y; }
        // 吸附命中时给出可读反馈（位置吸附的参考线管不到"尺寸"）
        cvSetBadge(snapTag ? ('已吸附：' + snapTag) : '拖动中（近似）', snapTag ? 'ok' : 'drag');
      }
    }
    if (cv.params.posMode !== 'custom') cvSnap(box, e.altKey);
    cv.box = box;
    cvPaintBox();
    cvBoxToParams(box);
    cvWriteBackInputs(['scale', 'dx', 'dy']);
  }

  function cvDragEnd() {
    if (!cv.drag) return;
    cv.drag = null;
    cvDrawGuides(0, 0, false);
    // 松手后：开启「实时预览」才渲染，且走**防抖** —— 连续拖动只在停下后渲一帧，
    // 未开启实时预览则纯本地结束：拖动全程零渲染。
    cvRequestPreview({ immediate: false });
  }

  // 缩放不再挂滚轮：参数页常常贴着预览，滚动查看参数时会误改缩放。
  // 缩放入口保留在参数区的「等比缩放」滑块 / 数值框（改动同样即时预览）。

  function cvBindDrag() {
    var box = $('cvBox');
    box.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.className && String(e.target.className).indexOf('cv-hd') >= 0) return;
      cvDragStart(e, 'move', '');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#cvBox .cv-hd'), function (h) {
      h.addEventListener('pointerdown', function (e) { cvDragStart(e, 'handle', h.getAttribute('data-hd') || ''); });
    });
    document.addEventListener('pointermove', function (e) { if (cv.drag) cvDragMove(e); });
    document.addEventListener('pointerup', function () { if (cv.drag) cvDragEnd(); });
    document.addEventListener('pointercancel', function () { if (cv.drag) cvDragEnd(); });
  }

  // ── 控件绑定（统一「输入 → 参数 → 防抖预览」，程序性写入不回环）──
  function cvBindControls() {
    function onInput(id, apply, opts) {
      var el = $(id);
      if (!el) return;
      var ev = (el.type === 'range' || el.type === 'number' || el.type === 'color') ? 'input' : 'change';
      el.addEventListener(ev, function () {
        if (cv.syncing) return;
        if (apply(el) === false) return;
        cvRequestPreview(opts);
      });
    }
    // 成片画布尺寸（输出分辨率）：与「转分辨率」同一套交互（常用比例 + 宽高联动 + 锁链解绑）。
    // 这套交互原是为「内容非等比拉伸」做的 —— 内容拉伸已移除（改为等比缩放），
    // 交互整体迁移到输出尺寸上：比例与宽高同行、不单独占行。
    (function () {
      var ratioEl = $('cvRatio'), wEl = $('cvTW'), hEl = $('cvTH'), linkEl = $('cvLink');
      if (!ratioEl || !wEl || !hEl) return;
      var pairOf = function (r) { return RESIZE_RATIOS[r] || null; };
      // 锁链状态是**用户的选择**，与"当前选了哪个比例"是两件事：
      // 解绑后先挑一个常用画幅当起点、再自由微调宽高，是很自然的用法 ——
      // 若把"选了常用比例"当成"要锁定"，这个用法会被一直锁住，改宽就自动改高。
      var linkState = cvLinkState;
      var linked = function () { return linkState.isLinked(ratioEl.value); };
      var paintLink = function () { if (linkEl) linkEl.classList.toggle('tl-link--on', linked()); };
      var sync = function () {
        cv.params.targetW = even(Math.max(16, cvNum(wEl, 1920)));
        cv.params.targetH = even(Math.max(16, cvNum(hEl, 1080)));
      };
      // 按当前宽高反推比例：命中常用比例返回其名字，否则返回实际比值（如 1.43:1）
      var guessRatio = function () {
        return ratioLabelOf(cv.params.targetW, cv.params.targetH) || '自定义';
      };
      ratioEl.addEventListener('change', function () {
        paintLink();
        var pr = RATIO_PRESETS[ratioEl.value];
        if (pr) {
          // 切常用比例 ⇒ 直接套标准档位（宽高一起换），不按当前宽推算
          wEl.value = String(pr[0]);
          hEl.value = String(pr[1]);
        } else {
          setCustomRatioLabel(ratioEl, '');   // 手动选「自定义」⇒ 该项文字恢复原样
        }
        sync();
        cvRequestPreview({ immediate: false });
      });
      if (linkEl) linkEl.addEventListener('click', function () {
        if (linked()) {
          // 解绑：只解除联动，**不动当前选中的比例** —— 用户可能就想在这个画幅上自由微调
          linkState.setUserLocked(false);
          toast('已解绑：画布宽高可自由填写', 'info');
        } else {
          var g = guessRatio();                       // 常用比例名 / 实际比值 / 自定义
          var known = VL.isPresetRatio(g);
          if (known) {
            linkState.setUserLocked(true);
            ratioEl.value = g;
            setCustomRatioLabel(ratioEl, '');
            var pr = RATIO_PRESETS[g];
            if (pr) { wEl.value = String(pr[0]); hEl.value = String(pr[1]); }
            toast('已锁定比例：改宽/高会按比例联动', 'info');
          } else if (g === '自定义') {
            // 宽高不可用（清空/非法）⇒ 回到默认画幅
            linkState.setUserLocked(true);
            ratioEl.value = '16:9';
            setCustomRatioLabel(ratioEl, '');
            var pr2 = RATIO_PRESETS['16:9'];
            wEl.value = String(pr2[0]); hEl.value = String(pr2[1]);
            toast('已锁定为 16:9：改宽/高会按比例联动', 'info');
          } else {
            toast('当前是自定义比例（' + g + '），无法按比例联动；请先选一个常用比例', 'info');
          }
        }
        paintLink();
        sync();
        cvRequestPreview({ immediate: false });
      });
      wEl.addEventListener('input', function () {
        var w = Math.max(16, cvNum(wEl, 1920));
        var a = linked() ? pairOf(ratioEl.value) : null;
        if (a) hEl.value = String(even(Math.round(w * a[1] / a[0])));
        sync();
        if (!a) cvSyncSizeUI();   // 解绑状态下，下拉跟着显示当前实际比例
        cvRequestPreview({ immediate: false });
      });
      hEl.addEventListener('input', function () {
        var h = Math.max(16, cvNum(hEl, 1080));
        var a = linked() ? pairOf(ratioEl.value) : null;
        if (a) wEl.value = String(even(Math.round(h * a[0] / a[1])));
        sync();
        if (!a) cvSyncSizeUI();   // 同上
        cvRequestPreview({ immediate: false });
      });
      paintLink();
    })();
    onInput('cvBgMode', function (el) { cv.params.bgMode = String(el.value); cvSyncBgRows(); return true; }, { immediate: true, force: true });
    onInput('cvBgColor', function (el) { cv.params.bgColor = String(el.value); return true; });
    onInput('cvBgFit', function (el) { cv.params.bgFit = String(el.value); return true; }, { immediate: true, force: true });
    onInput('cvBgDir', function (el) { cv.params.bgDir = String(el.value).trim(); cv.bgIndex = 0; return true; });
    onInput('cvBgPath', function (el) { cv.params.bgPath = String(el.value).trim(); return true; });
    onInput('cvBgBlur', function (el) { cv.params.bgBlur = Math.max(0, cvNum(el, 0)); cvWriteBackInputs(['bgBlur']); return true; });

    // 输出编码（与后处理「转码 / 码率」同一套取值，两处看到的选项一致）
    onInput('cvEncCodec', function (el) { cv.params.encCodec = String(el.value); return true; });
    onInput('cvEncCq', function (el) {
      cv.params.encCq = Math.min(51, Math.max(0, cvNum(el, 26)));
      cvWriteBackInputs(['encCq']);
      return true;
    });
    onInput('cvContainer', function (el) { cv.params.container = String(el.value); return true; });
    onInput('cvScale', function (el) { cv.params.scale = Math.min(3, Math.max(0.05, cvNum(el, 0.74))); cvWriteBackInputs(['scale']); return true; });
    onInput('cvScaleNum', function (el) { cv.params.scale = Math.min(3, Math.max(0.05, cvNum(el, 0.74))); cvWriteBackInputs(['scale']); return true; });
    onInput('cvPos', function (el) {
      var prev = cv.params.posMode;
      cv.params.posMode = String(el.value);
      // 切换位置基准时把偏移归零：dx/dy 是**相对基准**的偏移，默认 dy=160 是给居中场景的；
      // 选四角时若沿用旧偏移，内容会被推离角落，看上去"不在对应位置、边上留一大块空白"。
      if (prev !== cv.params.posMode) {
        cv.params.dx = 0; cv.params.dy = 0;
        cvWriteBackInputs(['dx', 'dy']);
      }
      return true;
    }, { immediate: true });
    onInput('cvDx', function (el) { cv.params.dx = Math.round(cvNum(el, 0)); return true; });
    onInput('cvDy', function (el) { cv.params.dy = Math.round(cvNum(el, 160)); return true; });
    onInput('cvRadius', function (el) { cv.params.radius = Math.max(0, cvNum(el, 0)); cvWriteBackInputs(['radius']); return true; });
    onInput('cvBorderW', function (el) { cv.params.borderW = Math.max(0, cvNum(el, 0)); cvWriteBackInputs(['borderW']); return true; });
    onInput('cvBorderColor', function (el) { cv.params.borderColor = String(el.value); return true; });
    onInput('cvWm', function (el) { cv.params.watermark = String(el.value).trim(); return true; });

    // 操作条 · 时间点：拖动即按新点重渲（防抖），松手立即渲染
    // ⚠ 一律夹到视频时长内 —— 滑块 max 在拿到时长前只是占位值，越界会让 ffmpeg 取不到帧（画面没有内容）
    $('cvAtRange').addEventListener('input', function () {
      if (cv.syncing) return;
      var v = Math.max(0, Number($('cvAtRange').value) || 0);
      if (cv.duration > 0.1) v = Math.min(v, cv.duration - 0.05);
      cv.at = v;
      $('cvAt').value = cv.at.toFixed(1);
      cvRequestPreview({ immediate: false });
    });
    $('cvAtRange').addEventListener('change', function () {
      cvSyncAtControls();
      cvRequestPreview({ immediate: false });   // 换帧属"调整"：未开实时预览不渲染；开启时防抖合并
    });
    $('cvAt').addEventListener('change', function () {
      cv.at = Math.max(0, cvNum($('cvAt'), 0));
      cvSyncAtControls();
      cvRequestPreview({ immediate: false });
    });
    $('cvAtRandom').addEventListener('click', function () {
      var max = cv.duration > 0.2 ? cv.duration - 0.1 : 0;
      cv.at = Math.round(Math.random() * Math.max(0, max) * 10) / 10;
      cvSyncAtControls();
      cvRequestPreview({ immediate: false });
    });
    // 「实时预览」开关：勾选 = 每次改动都渲染真实帧（准确但有延迟）；默认不勾选 = 占位示意快速微调
    $('cvLive').addEventListener('change', function () {
      cv.live = !!this.checked;
      if (cv.live) cvRequestPreview({ immediate: true, force: true });   // 开启：立刻取一帧真实结果
      else cvPaintHold();                                               // 关闭：切回占位示意
    });
    $('cvSamplePrev').addEventListener('click', function () { cvSampleStep(-1); });
    $('cvSampleNext').addEventListener('click', function () { cvSampleStep(1); });
    $('cvBgPrev').addEventListener('click', function () { cvBgStep(-1); });
    $('cvBgNext').addEventListener('click', function () { cvBgStep(1); });
    $('cvScanBg').addEventListener('click', function () { cvScanBackgrounds(); });
    $('cvBgDir').addEventListener('change', function () { if (cv.params.bgMode === 'dir') cvScanBackgrounds(true); });
    $('cvBgPath').addEventListener('change', function () { cvRequestPreview({ immediate: false }); });

    // 选择类按钮复用主进程的既有对话框通道
    $('cvPickBgDir').addEventListener('click', function () {
      api.pick_directory('选择背景目录', cv.params.bgDir).then(function (d) {
        if (!d) return;
        cv.params.bgDir = String(d);
        $('cvBgDir').value = String(d);
        cvScanBackgrounds(true);
      }).catch(function (e) { toast('选择文件夹失败：' + ((e && e.message) || e), 'error'); });
    });
    $('cvPickBgPath').addEventListener('click', function () {
      api.pick_image(cv.params.bgPath).then(function (f) {
        if (!f) return;
        cv.params.bgPath = String(f);
        $('cvBgPath').value = String(f);
        cvRequestPreview({ immediate: true, force: true });
      }).catch(function (e) { toast('选择文件失败：' + ((e && e.message) || e), 'error'); });
    });
    $('cvPickWm').addEventListener('click', function () {
      api.pick_image(cv.params.watermark).then(function (f) {
        if (!f) return;
        cv.params.watermark = String(f);
        $('cvWm').value = String(f);
        cvRequestPreview({ immediate: true, force: true });
      }).catch(function (e) { toast('选择水印失败：' + ((e && e.message) || e), 'error'); });
    });

    // 预设
    // 画布合成页不写自己的输出设置与按钮：与后处理共用下方那一份（见 outStore / outBind / syncRunButton）
    // 参数预设：**选中即加载**（不必再点一次「加载」按钮）
    $('cvPreset').addEventListener('change', function () { if (String(this.value || '')) cvApplyPreset(); });
    $('cvPresetSave').addEventListener('click', cvSavePreset);
    $('cvPresetOverwrite').addEventListener('click', cvOverwritePreset);
    $('cvPresetDelete').addEventListener('click', cvDeletePreset);
    cvBindDrag();
  }

  function cvScanBackgrounds(auto) {
    if (!api || !api.canvas_list_backgrounds) return;
    var dir = cv.params.bgDir;
    if (!dir) { if (!auto) toast('请先选择背景目录', 'info'); return; }
    setStatus('正在扫描背景候选…');
    api.canvas_list_backgrounds(dir).then(function (r) {
      if (!r || !r.ok) { notify('背景扫描失败：' + ((r && r.error) || '未知原因')); return; }
      cv.bgTotal = r.matched || 0;
      cv.bgIndex = 0;
      cv.bgName = r.matched ? String(r.list[0].name || '') : '';
      // 候选清单留存：提交处理时随参数带给引擎，保证「预览看到哪一批，处理就用哪一批」
      cv.bgList = (r.list || []).map(function (x) { return x.path; });
      try { cvCountHint(); } catch (e) {}
      cv.bgSizes = (r.list || []).map(function (x) { return (x.width || 0) + '×' + (x.height || 0); });
      // 背景**不再限制尺寸**（适合方式：填充 / 适应 / 拉伸 能处理任意尺寸）；尺寸只用于展示与"放大"提醒
      // ⚠ 不在这里单独 setStatus：状态栏由 cvCountHint 统一输出（它会把扫描结果一并带上）。
      //   若在此处另写 setStatus，会覆盖状态栏的数量提示（「将生成多少条」就永远看不到了）。
      cv.bgScan = '（扫描 ' + r.scanned + ' 个文件）';
      cvCountHint();
      cvUpdateBgInfo();
      cvRequestPreview({ immediate: true, force: true });
    }).catch(function (e) { notify('背景扫描失败：' + ((e && e.message) || e)); });
  }

  function cvBgStep(step) {
    if (cv.params.bgMode !== 'dir') { toast('只有「目录随机」模式支持切换背景', 'info'); return; }
    if (!cv.bgTotal) { cvScanBackgrounds(true); return; }
    cv.bgIndex = ((cv.bgIndex + step) % cv.bgTotal + cv.bgTotal) % cv.bgTotal;
    cvRequestPreview({ immediate: true, force: true });
  }

  /** 画布合成：输出设置行的显隐（规则与后处理一致，但用的是**自己那套控件**） */
  // 画布合成**不再单独写一套输出设置**：与后处理共用下方同一份控件（DOM 一份、数据两份），
  // 切标签页时由 outBind() 载入本页那一份 —— 行显隐复用 syncOutputRows()，无需在此重复实现。

  /** 画布合成的提交参数：输入与**本页那份输出配置**（outStore.canvas），与后处理互不读取对方配置 */
  function cvCollectSpec() {
    if (!state.root && !state.files.length) return { error: '请先在页面上方选择要合成的文件夹或视频文件' };
    // ⚠ 先把输出设置区的当前 DOM 值同步回 outStore，再读数据。
    //   原因：输出控件（outDir / outSuffix / outBackupDir 等）**没有 input 监听**，
    //   值只在 outCollect() 被调用时才存回 outStore，而 outCollect 只在「切换标签页」
    try { outCollect(); } catch (e) {}
    var o = outStore.canvas;
    if (o.mode === 'directory' && !o.dir) return { error: '请选择输出文件夹（或把输出方式改为「覆盖原视频」）' };
    var p = Object.assign({}, cv.params);
    // 候选背景清单随参数带上 → 与预览用**同一批候选**（否则两边各自枚举，范围可能不一致）
    // 「每个背景各出一批」：勾选后带上候选清单（后端据此展开成 N 个任务）；
    // 不勾选时不带，避免把几百条路径塞进 TOOL_SPEC。
    var eachBg = $('cvEachBg');
    if (p.bgMode === 'dir' && eachBg && eachBg.checked) {
      // ⚠ 候选清单为空时**必须报错，不能静默降级**：清单只在成功扫描过背景目录后才有值，
      //   若未扫描（或扫描未完成）就提交，老逻辑会当成普通单任务跑出一条成片 ——
      //   用户明明勾选了「每个背景各出一批」，却只拿到 1 条，且界面没有任何提示。
      if (!(cv.bgList || []).length) {
        return { error: '已勾选「每个背景各出一批」，但背景候选还没扫描 —— 请点背景目录旁的「扫描」后再开始合成' };
      }
      p.bgList = cv.bgList.slice();
    }
    return {
      spec: {
        mode: 'canvas',
        root: state.files.length ? '' : state.root,
        files: state.files.slice(),
        recursive: state.recursive !== false,
        params: { canvas: p },
        output: {
          mode: o.mode,
          dir: o.dir,
          nameMode: o.nameMode === 'suffix' ? 'suffix' : 'keep',
          suffix: o.suffix,
          onConflict: o.onConflict,
          backup: !!o.backup,
          // ⚠ 必须一并传：画布侧漏了这一项，导致用户在页面选的备份目录丢失，
          //   引擎只能回退（备份根口径见 canvas-run.js）
          backupDir: o.backupDir || '',
        },
      },
    };
  }

  /** 提交画布合成任务（覆盖原视频属高风险 → 先弹大窗警告，与后处理同一口径） */
  function cvRun() {
    var c = cvCollectSpec();
    if (c.error) { toast(c.error, 'error'); return; }
    var spec = c.spec;
    var scope = spec.files.length ? (spec.files.length + ' 个文件') : spec.root;
    var submit = function () {
      setStatus('正在创建画布合成任务…');
      setRunEnabled(false, '正在创建任务…');   // 与后处理同一口径：提交期间禁用按钮防连点
      api.run_tool(spec).then(function (r) {
        setRunEnabled(true, '');
        if (!r || !r.ok) { toast((r && r.error) || '创建任务失败', 'error'); return; }
        // 「每个背景各出一条」时后端把一次提交展开成多个任务：逐条告知，并跟随第一条的进度
        var ids = (r.taskIds && r.taskIds.length) ? r.taskIds : [r.taskId];
        if (ids.length > 1) {
          showLogBox('已加入队列 ' + ids.length + ' 个任务（每个背景各一条）：'
            + ids.slice(0, 3).join('、') + (ids.length > 3 ? ' …' : ''));
          setStatus('已加入执行队列 ' + ids.length + ' 个任务（在任务列表中查看进度与结果）', 'ok');
        } else {
          showLogBox('画布合成任务已加入队列 · ' + ids[0]);
          setStatus('已加入执行队列（在任务列表中查看进度与结果）', 'ok');
        }
        watchTask(ids[0]);
      }).catch(function (e) { setRunEnabled(true, ''); toast('创建任务失败：' + ((e && e.message) || e), 'error'); });
    };
    if (spec.output.mode === 'overwrite') {
      showDialog({
        title: '将覆盖原视频',
        cssClass: 'modal-card--wide',
        message: '<b>将合成：</b>' + esc(scope) + '<br><b>输出方式：</b>覆盖原视频<br><b>处理前备份：</b>'
          + (spec.output.backup ? '已开启' : '<span style="color:var(--vl-alias-status-error-default);font-weight:600">未开启 —— 覆盖后原文件不可恢复</span>'),
        buttons: [{ label: '取消', value: false }, { label: '确认开始', value: true, primary: true, danger: true, icon: 'play' }],
      }).then(function (ok) { if (ok) submit(); });
      return;
    }
    submit();
  }

  // ── 参数预设（存设置库 app scope，本机全局一份，**只服务「画布合成」**）──
  // ⚠ 原注释写的是"双版本共用同一份"，容易让人以为后处理也用同一批预设 ——
  //   实际存进去的是 cv.params（画布参数），后处理面板连预设控件都没有。
  function cvLoadPresets(selectName) {
    if (!api || !api.canvas_preset_list) return;
    api.canvas_preset_list().then(function (r) {
      var sel = $('cvPreset');
      if (!sel) return;
      var list = (r && r.ok && r.list) || [];
      sel.innerHTML = '<option value="">（未选择）</option>' + list.map(function (x) {
        return '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>';
      }).join('');
      if (selectName) sel.value = selectName;
    }).catch(function () {});
  }

  /**
   * 气泡确认框（含可选输入行）。
   *
   * 为什么需要它：保存预设、重命名这类操作**不是破坏性的**，用整屏遮罩的大窗（showDialog）
   */
  function confirmPopover(opts, anchor) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var prevMask = document.querySelector('.vl-pop-mask');
      if (prevMask) prevMask.remove();
      var prevPop = document.querySelector('.vl-pop');
      if (prevPop) prevPop.remove();

      var mask = document.createElement('div');
      mask.className = 'vl-pop-mask';
      var pop = document.createElement('div');
      pop.className = 'vl-pop';
      var html = '<div class="vl-pop__arrow"></div>';
      if (o.title) html += '<div class="vl-pop__title"></div>';
      if (o.message) html += '<div class="vl-pop__msg"></div>';
      if (o.input) html += '<div class="modal__field"><input type="text" class="modal__input"></div>';
      html += '<div class="vl-pop__actions">'
        + '<button type="button" class="vl-pop__btn" data-k="cancel"></button>'
        + '<button type="button" class="vl-pop__btn ' + (o.danger ? 'vl-pop__btn--danger' : 'vl-pop__btn--primary') + '" data-k="ok"></button>'
        + '</div>';
      pop.innerHTML = html;
      if (o.title) pop.querySelector('.vl-pop__title').textContent = o.title;
      if (o.message) pop.querySelector('.vl-pop__msg').textContent = o.message;
      pop.querySelector('[data-k="cancel"]').textContent = o.cancelLabel || '取消';
      pop.querySelector('[data-k="ok"]').textContent = o.okLabel || '确定';
      var inputEl = pop.querySelector('.modal__input');
      if (inputEl && o.input) {
        inputEl.value = String(o.input.value == null ? '' : o.input.value);
        if (o.input.placeholder) inputEl.placeholder = o.input.placeholder;
        if (o.input.maxlength) inputEl.maxLength = o.input.maxlength;
      }
      document.body.appendChild(mask);
      document.body.appendChild(pop);

      // 定位：优先贴锚点下方居中；下方空间不足转上方；水平夹紧在视口内
      var vw = window.innerWidth, vh = window.innerHeight, gap = 8;
      var pr = pop.getBoundingClientRect();
      var rect = (anchor && anchor.getBoundingClientRect && anchor.isConnected)
        ? anchor.getBoundingClientRect() : null;
      if (rect) {
        var left = rect.left + rect.width / 2 - pr.width / 2;
        var top = rect.bottom + gap;
        var below = true;
        if (top + pr.height > vh - 8) { top = rect.top - pr.height - gap; below = false; }
        if (top < 8) { top = Math.min(rect.bottom + gap, Math.max(8, vh - pr.height - 8)); below = true; }
        left = Math.max(8, Math.min(left, vw - pr.width - 8));
        pop.classList.add(below ? 'vl-pop--below' : 'vl-pop--above');
        pop.querySelector('.vl-pop__arrow').style.left =
          Math.max(12, Math.min(rect.left + rect.width / 2 - left, pr.width - 22)) + 'px';
        pop.style.left = left + 'px';
        pop.style.top = Math.max(8, top) + 'px';
      } else {
        pop.style.left = Math.max(8, vw / 2 - pr.width / 2) + 'px';
        pop.style.top = Math.max(8, vh / 2 - pr.height / 2) + 'px';
      }

      function done(v) {
        mask.remove();
        pop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { done(null); return; }
        // 有输入框时回车即确认（起名后按回车是最顺手的路径）
        if (e.key === 'Enter' && inputEl) { e.preventDefault(); done(inputEl.value); }
      }
      mask.addEventListener('click', function () { done(null); });
      document.addEventListener('keydown', onKey);
      pop.querySelector('[data-k="cancel"]').addEventListener('click', function () { done(null); });
      pop.querySelector('[data-k="ok"]').addEventListener('click', function () {
        done(inputEl ? inputEl.value : true);
      });
      if (inputEl) { inputEl.focus(); inputEl.select(); }
    });
  }

  function cvSavePreset() {
    var sel = $('cvPreset');
    var cur = sel ? String(sel.value || '') : '';
    // 气泡（不是大窗）：保存预设不是破坏性操作，没必要整屏遮罩打断操作流。
    // 也不写副标题 —— 「保存在本机、以后所有画布合成都能选到」属于看过一次就够的信息，
    // 每存一次都摆一遍只会挤占气泡空间。
    confirmPopover({
      title: '保存参数预设',
      okLabel: '保存',
      input: { value: cur, placeholder: '预设名称' },
    }, $('cvPresetSave')).then(function (v) {
      if (v == null || v === false) return;
      var name = String(v).trim();
      if (!name) { toast('预设名称不能为空', 'error'); return; }
      if (!api || !api.canvas_preset_save) return;
      api.canvas_preset_save(name, cv.params).then(function (r) {
        if (!r || !r.ok) { toast('保存预设失败：' + ((r && r.error) || '未知原因'), 'error'); return; }
        toast('已保存预设：' + name, 'ok');
        cvLoadPresets(name);
      }).catch(function (e) { toast('保存预设失败：' + ((e && e.message) || e), 'error'); });
    });
  }

  function cvApplyPreset() {
    var sel = $('cvPreset');
    var name = sel ? String(sel.value || '') : '';
    if (!name) { toast('请先选择一个预设', 'info'); return; }
    api.canvas_preset_list().then(function (r) {
      var item = ((r && r.list) || []).filter(function (x) { return x.name === name; })[0];
      if (!item) { toast('预设不存在', 'error'); return; }
      cv.params = Object.assign({}, cv.params, item.params || {});
      cvApplyParamsToInputs();
      cvRequestPreview({ immediate: true, force: true });
      toast('已加载预设：' + name, 'ok');
    }).catch(function (e) { toast('加载预设失败：' + ((e && e.message) || e), 'error'); });
  }

  /**
   * 用当前参数**覆盖**下拉里选中的预设。
   * 与「新建预设」分开是因为两者语义完全不同：新建要起名、不动任何既有预设；
   * 覆盖会丢掉那个预设的旧参数 —— 所以这里是**破坏性操作**，必须二次确认。
   */
  function cvOverwritePreset() {
    var sel = $('cvPreset');
    var name = sel ? String(sel.value || '') : '';
    if (!name) { toast('请先在上方选择一个要覆盖的预设', 'info'); return; }
    // 气泡二次确认（不用大窗）：就地确认、不打断视线；danger 让主按钮标红以示破坏性
    confirmPopover({
      title: '覆盖预设',
      message: '用当前画布参数覆盖预设「' + name + '」？该预设原有的参数会被替换，无法撤销。',
      okLabel: '覆盖',
      danger: true,
    }, $('cvPresetOverwrite')).then(function (ok) {
      if (ok !== true) return;
      if (!api || !api.canvas_preset_save) return;
      api.canvas_preset_save(name, cv.params).then(function (r) {
        if (!r || !r.ok) { toast('覆盖预设失败：' + ((r && r.error) || '未知原因'), 'error'); return; }
        toast('已覆盖预设：' + name, 'ok');
        cvLoadPresets(name);
      }).catch(function (e) { toast('覆盖预设失败：' + ((e && e.message) || e), 'error'); });
    });
  }

  function cvDeletePreset() {
    var sel = $('cvPreset');
    var name = sel ? String(sel.value || '') : '';
    if (!name) { toast('请先选择要删除的预设', 'info'); return; }
    api.canvas_preset_delete(name).then(function (r) {
      if (!r || !r.ok) { toast('删除预设失败：' + ((r && r.error) || '未知原因'), 'error'); return; }
      toast('已删除预设：' + name, 'ok');
      cvLoadPresets();
    }).catch(function (e) { toast('删除预设失败：' + ((e && e.message) || e), 'error'); });
  }

  /** 成片画布尺寸：比例下拉与锁链状态按当前宽高反推（预设加载后也保持一致） */
  function cvSyncSizeUI() {
    var ratioEl = $('cvRatio'), linkEl = $('cvLink');
    if (!ratioEl) return;
    var rr = ratioLabelOf(cv.params.targetW, cv.params.targetH) || '自定义';
    var known = VL.isPresetRatio(rr);
    // 常用比例有对应选项；非常用比例落到「自定义」，并把该项文字标成实际比值
    ratioEl.value = known ? rr : '自定义';
    setCustomRatioLabel(ratioEl, known ? '' : rr);
    // ⚠ 必须走状态机：只看 known 的话，用户在解绑后手输宽高、恰好凑成常用比例时，
    //   锁链会被点亮（视觉上"锁上了"），而实际并未联动 —— 用户还得再点一下才能改。
    if (linkEl) linkEl.classList.toggle('tl-link--on', cvLinkState.isLinked(known ? rr : '自定义'));
  }

  /** 把参数写回全部控件（用于预设加载与初始化） */
  /** 编码格式名的旧取值规范化：已存预设里可能是历史字符串，直接写进 select 会因匹配不到 option 而变成空值，故先映射到当前取值。 */
  /**
   * 需要用户**立刻注意到**的提示（操作被拦下 / 操作失败）。
   *
   * 为什么不能只用 setStatus：它在面板下方，用户操作时视线在按钮与表单上，
   */
  function notify(msg, kind) {
    var m = String(msg == null ? '' : msg);
    try { toast(m, kind === true ? 'error' : (kind || 'error')); } catch (e) {}
    try { setStatus(m); } catch (e2) {}
  }

  function cvNormCodec(v) {
    var s = String(v == null ? '' : v);
    if (s.indexOf('H.265') >= 0 || s.toUpperCase().indexOf('HEVC') >= 0) return 'H.265 / HEVC';
    if (s.toUpperCase().indexOf('AV1') >= 0) return 'AV1';
    return 'H.264';
  }

  function cvApplyParamsToInputs() {
    cv.syncing = true;
    try {
      var p = cv.params;
      var set = function (id, v) { var el = $(id); if (el) el.value = String(v); };
      set('cvTW', p.targetW); set('cvTH', p.targetH);
      cvSyncSizeUI();                       // 画布尺寸：比例下拉与锁链状态按宽高反推
      set('cvBgMode', p.bgMode); set('cvBgColor', p.bgColor);
      set('cvBgFit', p.bgFit);              // 背景适合方式（填充 / 适应 / 拉伸）
      set('cvBgDir', p.bgDir); set('cvBgPath', p.bgPath);
      set('cvBgBlur', p.bgBlur); set('cvBgBlurVal', p.bgBlur);
      set('cvScale', p.scale); set('cvScaleNum', p.scale);
      set('cvPos', p.posMode); set('cvDx', p.dx); set('cvDy', p.dy);
      set('cvRadius', p.radius); set('cvRadiusVal', p.radius);
      set('cvBorderW', p.borderW); set('cvBorderWVal', p.borderW);
      set('cvBorderColor', p.borderColor);
      set('cvWm', p.watermark);
      // 输出编码三项（与后处理同义的选项）：预设里也存着它们，应用预设时必须一并回到界面。
      // ⚠ 此处漏掉的表现很隐蔽：加载预设看着正常，编码格式 / CQ / 格式却仍停在上一次的取值上。
      set('cvEncCodec', cvNormCodec(p.encCodec));
      set('cvEncCq', p.encCq); set('cvEncCqVal', p.encCq);
      set('cvContainer', String(p.container || 'mp4') === 'mov' ? 'mov' : 'mp4');
    } finally { cv.syncing = false; }
    cvSyncBgRows();
  }

  function cvOnShow() {
    if (!cv.ready) return;
    // 面板刚从 hidden 变可见：立刻按当前输出尺寸算一次预览尺寸，并等一帧再用真实可用宽补算一次
    // （隐藏时 clientWidth=0、算不出可用宽，不补算就会一直停在 CSS 兜底尺寸）
    cvSyncStageAspect();
    requestAnimationFrame(cvSyncStageAspect);
    // 切页时补齐样本清单（用户可能先选了文件夹再切到本页）
    if (!cv.meta) cvLoadSamples(true);      // 还没预览过 → 补齐清单并渲一帧（扫描完成后才渲）
    else cvLoadSamples(false);              // 已有预览 → 只刷新清单，不打扰
  }

  function cvInit() {
    if (cv.ready) return;
    cv.ready = true;
    cvBindControls();
    cvApplyParamsToInputs();
    cvLoadPresets();
    cvUpdateBgInfo();
    cvSyncStageAspect();   // 预览框比例先按当前输出尺寸就位（本地即时）
    cvPaintHold();   // 初始为占位示意（未开启实时预览）：有真实帧就做底，没有则只显示占位与提示
    // 输入变化后的自动预览统一由 renderInputHint → cvLoadSamples(true) 负责（不再单独挂按钮监听，
    // 否则会在样本清单异步扫描完成前触发渲染，白报一次「未选择视频」）
    window.addEventListener('resize', function () { cvSyncStageAspect(); if (cv.box.w) cvPaintBox(); });
  }

  // ── Tab 切换（后处理 / 画布合成）──
  function bindTabs() {
    var tabs = document.querySelectorAll('.tl-tab');
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(tabs, function (b) { b.classList.toggle('tl-tab--active', b === btn); });
        var isCanvas = name === 'canvas';
        $('panePost').hidden = isCanvas;
        $('paneCanvas').hidden = !isCanvas;
        // 输出设置与「开始」按钮**两页共用**：切换时先把 DOM 上那份存回旧模块，再载入新模块那一份
        outBind(isCanvas ? 'canvas' : 'post');
        syncRunButton();
        if (isCanvas) cvOnShow();
      });
    });
  }

  // ── 皮肤跟随（与任务窗口同一套：读当前皮肤 + 设置页切换时即时生效）──
  function initSkin() {
    if (!api || !api.get_skin) return;
    api.get_skin().then(function (skin) {
      document.documentElement.setAttribute('data-skin', skin || 'white_blue');
    }).catch(function () {});
    if (api.on_settings_saved) {
      api.on_settings_saved(function (cfg) {
        if (cfg && cfg.skin) document.documentElement.setAttribute('data-skin', cfg.skin);
      });
    }
  }

  // ── 启动 ──
  function boot() {
    initSkin();
    if (window.VL_hydrateIcons) window.VL_hydrateIcons(document);
    $('inRecursive').checked = state.recursive;
    renderInputHint();
    outApply();          // 输出设置：初始载入后处理那一份（画布合成那份在切页时载入）
    syncRunButton();
    bindTabs();
    cvInit();
    bindFormEvents();
    bindOutputEvents();
    if (!api || !api.list_tools) { setRunEnabled(false, '功能暂不可用（请重启软件）'); toast('功能暂不可用（请重启软件）', 'error'); return; }
    api.list_tools().then(function (info) {
      if (!info || !info.ok) {
        setRunEnabled(false, '读取处理能力失败');
        toast((info && info.error) || '读取处理能力失败', 'error');
        return;
      }
      state.info = info;
      state.defaultBackupDir = (info.output && info.output.defaultBackupDir) || '';
      if (state.defaultBackupDir) $('outBackupDir').placeholder = state.defaultBackupDir;   // 占位符显示实际地址
      (info.steps || []).forEach(function (s) {
        state.sel[s.id] = false;
        state.values[s.id] = {};
        (s.schema || []).forEach(function (sc) {
          state.values[s.id][sc.key] = (sc.default === undefined ? (sc.type === 'bool' ? false : '') : sc.default);
        });
      });
      renderSteps();
      $('inRecursive').checked = state.recursive;
      renderInputHint();
      syncOutputRows();
      var n = (info.steps || []).length;
      if (!info.engine) {
        var w = $('envWarn');
        w.hidden = false;
        w.textContent = '程序文件不完整（缺少运行组件），无法执行处理，请重新安装或校验。';
        setRunEnabled(false, '程序文件不完整，无法执行处理');
        toast('程序文件不完整，请重新安装或校验', 'error');
      } else {
        // ★ 就绪即启用主操作按钮 —— 参数不完整时交给点击后的校验去提示，
        //   否则按钮一直灰着，用户不知道为什么不能点
        setRunEnabled(true, '');
        // 画布面板用数量提示（会出多少条），后处理面板保留操作说明
        if (!cvCountHint()) setStatus('就绪 —— 选好文件夹、勾选要做的处理后点「开始处理」');
      }
    }).catch(function (e) {
      setRunEnabled(false, '读取处理能力失败');
      toast('读取处理能力失败：' + ((e && e.message) || e), 'error');
    });
  }

  /**
   * 状态栏的**数量提示**：把「这次会生成多少个成片」直接算出来摆在这儿。
   *
   * 为什么不用「就绪 —— 选好文件夹、勾选要做的处理后点开始处理」这类操作说明：
   */
  function cvCountHint() {
    if (outBound !== 'canvas') return false;      // 后处理面板沿用原提示
    var contentN = (cv.samples || []).length || (state.files || []).length || 0;
    var bgN = (cv.bgList || []).length || Number(cv.bgTotal) || 0;
    var bgScan = String(cv.bgScan || '');
    var each = $('cvEachBg');
    var on = !!(each && each.checked) && bgN > 1;
    var txt;
    if (on && contentN) {
      txt = '将生成 ' + bgN + ' 个背景 × ' + contentN + ' 个内容 = ' + (bgN * contentN) + ' 个成片';
    } else if (contentN) {
      txt = '将生成 ' + contentN + ' 个成片' + (bgN > 1 ? '（背景从 ' + bgN + ' 个候选中随机取）' : '');
    } else if (bgN > 1) {
      txt = '背景候选 ' + bgN + ' 个' + bgScan + ' —— 请先选择要处理的内容';
    } else {
      txt = '就绪 —— 选好内容与背景后点「开始合成」';
    }
    setStatus(txt);
    return true;
  }

  /** 主操作按钮可用态：灰显时必须给出原因（title），避免「一直灰着不知为何」 */
  function setRunEnabled(on, why) {
    var b = $('btnRun');
    b.disabled = !on;
    if (why) b.title = why; else b.removeAttribute('title');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
