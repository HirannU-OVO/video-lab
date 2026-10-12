/* -*- coding: utf-8 -*-
 * Video Lab — 前端逻辑
 */
(function () {
  'use strict';

  // 数字输入框：禁用滚轮滚动改值（仅保留手动输入）
  document.addEventListener('wheel', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'range')) ev.preventDefault();
  }, { passive: false });

  // 图标统一来自 icons.js 全局库（硬约束：不在业务文件维护 ICONS/icon 副本）
  function icon(name, size, cls) { return window.VL_icon ? window.VL_icon(name, size, cls) : ''; }
  function hydrateIcons(root) { if (window.VL_hydrateIcons) window.VL_hydrateIcons(root); }
  // 局部替换图标：元素内可能已有插入的 svg，直接重建（私有，不污染全局图标库）
  function hydIcon(el, name) {
    if (!el) return;
    var i = el.querySelector('i[data-icon]');
    if (i) hydIcon(i, name);
    else {
      el.innerHTML = icon(name, 14);
      var svg = el.firstChild;
      if (svg && svg.setAttribute) { svg.setAttribute('class', 'preview-collapse__icon'); }
    }
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 路径 → 文件名（不含扩展名）；用于水印栏简洁展示
  function baseNameNoExt(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var name = s.replace(/^.*[\\/]/, '');
    return name.replace(/\.[^.]+$/, '');
  }
  // 水印栏行内结构：点击文件名更换水印 + 右侧两个图标按钮（打开文件 / 打开文件夹）；
  // withActions=false 时不渲染右侧按钮（主流水印设置弹窗按需求隐藏）
  function wmRowHtml(wm, withActions) {
    var p = wm ? String(wm) : '';
    var showActions = withActions !== false;
    var h = '<div class="config-watermark__row">';
    if (p) h += '<div class="config-watermark__path" title="' + escapeHtml(p) + '">' + escapeHtml(baseNameNoExt(p)) + '</div>';
    else h += '<div class="config-watermark__path config-watermark__path--empty" title="点击更换水印">未设置水印</div>';
    if (showActions) {
      h += '<button type="button" class="config-watermark__btn' + (p ? '' : ' is-vl-disabled') + '" data-wm="open" title="打开文件"' + (p ? '' : ' data-why="未设置主流水印"') + '>' + icon('image', 15) + '</button>';
      h += '<button type="button" class="config-watermark__btn' + (p ? '' : ' is-vl-disabled') + '" data-wm="folder" title="打开文件夹"' + (p ? '' : ' data-why="未设置主流水印"') + '>' + icon('folder-open', 15) + '</button>';
    }
    return h + '</div>';
  }
  // 轻量角落提示（toast）：仅告知、无需用户操作，自动消失。type：ok(✓绿)/error(⚠红)/info(ℹ)/warn(黄)
  // 用于保存/删除/迁移等操作结果与失败提示，比状态栏小字更显眼，且不开大窗
  function toast(message, type) {
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
    el.querySelector('.toast__text').textContent = String(message || '');
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast--show'); });
    setTimeout(function () {
      el.classList.remove('toast--show');
      setTimeout(function () { try { el.remove(); } catch (e) {} }, 300);
    }, 3200);
  }
  // 记录最后一次点击的可作为锚点的元素：气泡确认未显式传 anchor 时用它定位，
  // 使既有 showDialog 调用点改成气泡时几乎无需改动（气泡内部交互不更新锚点）
  var _popAnchor = null; // { el, rect }：rect 为元素当时的位置快照，供元素随后被移除（如右键菜单关闭）时仍能定位
  // 设置气泡的归属锚点：气泡应锚在「被操作对象」上（如日期分支按钮、任务卡片），而非临时菜单项
  function setPopAnchor(el) {
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    _popAnchor = { el: el, rect: { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } };
  }
  document.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.vl-pop')) return;
    setPopAnchor(t.closest('button, .btn, [role="button"], a, .menu-item, .ctx-menu button, .date-branch-btn, .list-row, .log-row'));
  }, true);
  // 右键目标元素：作为「该菜单操作」气泡的归属锚点 —— 气泡应锚在「被操作对象」（如日期分支按钮）上，
  // 而不是临时菜单项；菜单关闭后仍能凭此定位
  var _ctxOwner = null;
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('.vl-pop')) return;
    _ctxOwner = t.closest('.date-branch-btn, .log-entry__clip, .log-entry, .tree-project__name, .mask-file-item, .mask-folder-row, .mask-group-file, .mask-group-head') || t;
  }, true);
  // 锚定气泡确认：贴着触发元素弹小浮层（取代居中大窗），仅「取消 / 一个动作」两选一。
  // opts: { title, message, okLabel, cancelLabel, danger }；anchor 省略时用最后点击的元素。
  // 返回 Promise：确认 → true；取消 / 点外部 / ESC → null
  function confirmPopover(opts, anchor) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var prevMask = document.querySelector('.vl-pop-mask');
      if (prevMask) prevMask.remove();
      var prevPop = document.querySelector('.vl-pop');
      if (prevPop) prevPop.remove();
      // 定位锚点矩形：优先显式传入的有效元素 → 最后点击元素（仍在 DOM）→ 其位置快照（元素已被移除，如右键菜单关闭）
      var rect = null;
      if (anchor && anchor.getBoundingClientRect && anchor.isConnected) rect = anchor.getBoundingClientRect();
      if (!rect && _popAnchor) {
        if (_popAnchor.el && _popAnchor.el.isConnected) rect = _popAnchor.el.getBoundingClientRect();
        else if (_popAnchor.rect) rect = _popAnchor.rect;
      }
      var mask = document.createElement('div');
      mask.className = 'vl-pop-mask';
      var pop = document.createElement('div');
      pop.className = 'vl-pop';
      var html = '<div class="vl-pop__arrow"></div>';
      if (o.title) html += '<div class="vl-pop__title"></div>';
      if (o.message) html += '<div class="vl-pop__msg"></div>';
      html += '<div class="vl-pop__actions">'
        + '<button type="button" class="vl-pop__btn" data-k="cancel"></button>'
        + '<button type="button" class="vl-pop__btn ' + (o.danger ? 'vl-pop__btn--danger' : 'vl-pop__btn--primary') + '" data-k="ok"></button>'
        + '</div>';
      pop.innerHTML = html;
      if (o.title) pop.querySelector('.vl-pop__title').textContent = o.title;
      if (o.message) pop.querySelector('.vl-pop__msg').textContent = o.message;
      pop.querySelector('[data-k="cancel"]').textContent = o.cancelLabel || '取消';
      pop.querySelector('[data-k="ok"]').textContent = o.okLabel || '确定';
      document.body.appendChild(mask);
      document.body.appendChild(pop);

      // 定位：优先贴触发元素下方居中；下方空间不足转上方；水平夹紧在视口内
      var vw = window.innerWidth, vh = window.innerHeight, gap = 8;
      var pr = pop.getBoundingClientRect();
      var left, top, below = true;
      if (rect) {
        var r = rect;
        left = r.left + r.width / 2 - pr.width / 2;
        top = r.bottom + gap;
        if (top + pr.height > vh - 8) { top = r.top - pr.height - gap; below = false; }
        if (top < 8) { top = Math.min(r.bottom + gap, Math.max(8, vh - pr.height - 8)); below = true; }
        left = Math.max(8, Math.min(left, vw - pr.width - 8));
        pop.classList.add(below ? 'vl-pop--below' : 'vl-pop--above');
        var arrow = pop.querySelector('.vl-pop__arrow');
        arrow.style.left = Math.max(12, Math.min(r.left + r.width / 2 - left, pr.width - 22)) + 'px';
      } else {
        left = Math.max(8, vw / 2 - pr.width / 2);
        top = Math.max(8, vh / 2 - pr.height / 2);
        pop.classList.add('vl-pop--below');
        pop.querySelector('.vl-pop__arrow').style.display = 'none';
      }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';

      var done = function (v) {
        document.removeEventListener('keydown', onKey, true);
        if (mask.parentNode) mask.remove();
        if (pop.parentNode) pop.remove();
        resolve(v);
      };
      var onKey = function (e) { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey, true);
      mask.addEventListener('mousedown', function () { done(null); });
      pop.querySelector('[data-k="cancel"]').addEventListener('click', function () { done(null); });
      pop.querySelector('[data-k="ok"]').addEventListener('click', function () { done(true); });
    });
  }
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card' + (opts.cssClass ? ' ' + opts.cssClass : '');
      var html = '<button type="button" class="modal-close" title="关闭">✕</button><div class="modal__title">' + escapeHtml(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + escapeHtml(opts.message) + '</div>';
      html += '<div class="modal__actions">';
      (opts.buttons || []).forEach(function (b) {
        var cls = 'modal-btn' + (b.danger ? ' modal-btn--danger' : '') + (b.primary ? ' modal-btn--primary' : '') + (b.cls ? ' ' + b.cls : '') + (b.disabled ? ' modal-btn--disabled' : '');
        var ics = b.icon ? icon(b.icon, 14) : '';
        html += '<button type="button" class="' + cls + '"' + (b.disabled ? ' disabled' : '') + (b.hint ? ' title="' + escapeHtml(b.hint) + '"' : '') + '>' + ics + escapeHtml(b.label) + '</button>';
      });
      html += '</div>';
      card.innerHTML = html;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var done = function (result) { overlay.remove(); resolve(result); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
      var closeBtn = card.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { done(null); });
      var btns = card.querySelectorAll('.modal-btn');
      (opts.buttons || []).forEach(function (b, i) {
        if (b.disabled) {
          // 弹窗内灰显按钮统一由全局 is-vl-disabled 委托弹 toast（此处仅加灰显类，不再自绑）
          btns[i].classList.add('is-vl-disabled');
          btns[i].removeAttribute('disabled');
          if (b.hint) btns[i].setAttribute('data-why', b.hint);
          btns[i].addEventListener('click', function (e) { e.stopPropagation(); });
        } else {
          btns[i].addEventListener('click', function () { done(b.value); });
        }
      });
    });
  }
  // 复刻弹窗（单弹窗）：既选复刻方式，又设置本次任务的重复度上下限与是否启用。
  // 占位符显示「设置-视频复刻」里的默认值、勾选状态取默认启用；本次任务生效、不改设置。
  // 业务背景：不一致占比过低会被判重复度不过审，过高会被判为全新视频（继承不到流量），因此要控在区间内。
  function replicaModeDialog() {
    return new Promise(function (resolve) {
      var fail = function (e) {
        toast('复刻设置弹窗打开失败：' + ((e && e.message) || e), true);
        resolve(null);
      };
      try {
        // 注意：app.js 里没有全局 api，通信统一走 call(...)（api.* 仅在函数内 var api = getApi() 后可用）
        Promise.resolve(call('get_settings')).then(function (st) {
          try {
            var r = (st && st.replica) || {};
            var dMin = r.dedup_ratio != null ? String(r.dedup_ratio) : '';
            var dMax = r.dedup_ratio_max != null ? String(r.dedup_ratio_max) : '';
            var minOn = r.dedup_ratio_on !== false;
            var maxOn = r.dedup_ratio_max_on !== false;
            var overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            var card = document.createElement('div');
            card.className = 'modal-card';
            card.innerHTML = '<button type="button" class="modal-close" title="关闭">✕</button>'
              + '<div class="modal__title">复刻</div>'
              + '<div class="rp-form">'
              + '<div class="rp-form__row"><span class="rp-form__label">重复度下限</span>'
              + '<input class="modal-input rp-form__num" id="rpMin" type="number" min="0" max="1" step="0.05" placeholder="' + escapeHtml(dMin) + '">'
              + '<label class="opt-check"><input type="checkbox" id="rpMinOn"' + (minOn ? ' checked' : '') + '><span class="opt-check__box"></span><span>启用</span></label>'
              + '</div>'
              + '<div class="rp-form__row"><span class="rp-form__label">重复度上限</span>'
              + '<input class="modal-input rp-form__num" id="rpMax" type="number" min="0" max="1" step="0.05" placeholder="' + escapeHtml(dMax) + '">'
              + '<label class="opt-check"><input type="checkbox" id="rpMaxOn"' + (maxOn ? ' checked' : '') + '><span class="opt-check__box"></span><span>启用</span></label>'
              + '</div>'
              + '<div class="rp-form__hint">留空则使用设置里的默认值</div>'
              + '</div>'
              + '<div class="modal__actions">'
              + '<button type="button" class="modal-btn" data-b="cancel">取消</button>'
              + '<button type="button" class="modal-btn modal-btn--primary" data-b="full">完全复刻</button>'
              + '<button type="button" class="modal-btn modal-btn--primary" data-b="dedup">去重复刻</button>'
              + '</div>';
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            var done = function (v) { overlay.remove(); resolve(v); };
            overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
            var cb = card.querySelector('.modal-close');
            if (cb) cb.addEventListener('click', function () { done(null); });
            card.querySelector('[data-b="cancel"]').addEventListener('click', function () { done(null); });
            card.querySelector('[data-b="full"]').addEventListener('click', function () { done({ mode: '1', opts: {} }); });
            card.querySelector('[data-b="dedup"]').addEventListener('click', function () {
              var minOnNow = card.querySelector('#rpMinOn').checked;
              var maxOnNow = card.querySelector('#rpMaxOn').checked;
              var minV = (card.querySelector('#rpMin').value || '').trim() || (minOnNow ? dMin : '');
              var maxV = (card.querySelector('#rpMax').value || '').trim() || (maxOnNow ? dMax : '');
              if (minOnNow && !(parseFloat(minV) > 0)) { toast('请填写重复度下限（或取消勾选启用）', true); return; }
              if (maxOnNow && !(parseFloat(maxV) > 0)) { toast('请填写重复度上限（或取消勾选启用）', true); return; }
              if (minOnNow && maxOnNow && parseFloat(maxV) < parseFloat(minV)) { toast('重复度上限不能小于下限', true); return; }
              done({ mode: '2', opts: { dedupRatio: minV, dedupRatioMax: maxV, dedupRatioOn: minOnNow, dedupRatioMaxOn: maxOnNow } });
            });
          } catch (e) { fail(e); }
        }).catch(fail);
      } catch (e) { fail(e); }   // 同步异常（如 api 不可用）也要可见
    });
  }

  function showSaveDestDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card modal-card--dest';
      var html = '<button type="button" class="modal-close" title="关闭">✕</button><div class="modal__title">' + escapeHtml(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + escapeHtml(opts.message) + '</div>';
      html += '<div class="modal__dest-list">';
      (opts.rows || []).forEach(function (r) {
        html += '<div class="modal__dest-row"><span class="modal__dest-hint">' + escapeHtml(r.hint) + '</span>';
        html += '<button type="button" class="modal-btn modal__dest-save">' + escapeHtml(opts.btnLabel || '保存') + '</button></div>';
      });
      html += '</div>';
      card.innerHTML = html;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var done = function (result) { overlay.remove(); resolve(result); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
      var closeBtn = card.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { done(null); });
      var btns = card.querySelectorAll('.modal__dest-row .modal-btn');
      (opts.rows || []).forEach(function (r, i) { btns[i].addEventListener('click', function () { done(r.value); }); });
    });
  }
  // 主流水印设置弹窗：启用判定复选框 + 主流水印行（样式照搬水印 PNG 行）+ 保存/保存并更改/取消
  function openProjectWatermarkDialog(project) {
    call('get_project_watermark', project).then(function (r) {
      if (!r || !r.ok) { toast('读取项目设置失败：' + ((r && r.error) || '未知错误'), true); return; }
      var curWm0 = String(r.main || '').trim();
      var curWm = curWm0;
      var wmEn0 = r.enabled === true;
      var curGroup = parseInt(r.group, 10) || 0;
      var curGroupEn = r.groupEnabled === true;
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card modal-card--wm';
      card.innerHTML =
        '<button type="button" class="modal-close" title="关闭">✕</button>' +
        '<div class="modal__title">项目设置</div>' +
        '<div class="modal__wm-body">' +
        '<div class="wm-section-title">默认分组数</div>' +
        '<div class="wm-row"><span class="wm-row__label">启用默认分组数</span><div class="wm-row__ops"><label class="wm-check"><input type="checkbox" id="groupToggle"' + (curGroupEn ? ' checked' : '') + '><span class="wm-check__box"></span></label></div></div>' +
        '<div class="wm-row"><span class="wm-row__label">默认分组数</span><div class="wm-row__ops"><input type="number" class="wm-row__input" id="groupInput" min="1" max="99" placeholder="不分组" value="' + (curGroup > 0 ? curGroup : '') + '"></div></div>' +
        '<div class="wm-section-title">主流水印</div>' +
        '<div class="wm-row"><span class="wm-row__label">启用主流水印判定</span><div class="wm-row__ops"><label class="wm-check"><input type="checkbox" id="wmToggle"' + (wmEn0 ? ' checked' : '') + '><span class="wm-check__box"></span></label></div></div>' +
        '<div class="wm-row"><span class="wm-row__label">主流水印</span><div class="wm-row__ops"><div class="config-watermark__row config-watermark__row--inline" id="wmMainRow"></div></div></div>' +
        '</div>' +
        '<div class="modal__actions">' +
        '<button type="button" class="modal-btn" data-wm-act="cancel">取消</button>' +
        '<button type="button" class="modal-btn modal-btn--primary" data-wm-act="save">保存</button>' +
        '</div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var row = card.querySelector('#wmMainRow');
      function bindWmRow(root) {
        var pathEl = root.querySelector('.config-watermark__path');
        if (pathEl) pathEl.addEventListener('click', function () {
          call('pick_watermark', curWm).then(function (p) { if (p) { curWm = p; renderRow(); } });
        });
        var bOpen = root.querySelector('[data-wm="open"]');
        if (bOpen) bOpen.addEventListener('click', function () {
          if (curWm) openFileInShell(curWm);
          else toast('未设置主流水印，无法打开文件', true);
        });
        var bFold = root.querySelector('[data-wm="folder"]');
        if (bFold) bFold.addEventListener('click', function () {
          if (curWm) openInShell(curWm);
          else toast('未设置主流水印，无法打开文件夹', true);
        });
      }
      function renderRow() { row.innerHTML = wmRowHtml(curWm, false); bindWmRow(row); }
      renderRow();
      var closed = false;
      function closeDialog() { overlay.remove(); closed = true; }
      function afterSave() { closeDialog(); if (state.activeProject === project) assertWatermark(); }
      function collectGroup() {
        var en = card.querySelector('#groupToggle').checked;
        var v = parseInt(card.querySelector('#groupInput').value, 10) || 0;
        return { group: v, groupEnabled: en };
      }
      function doSave(applyToAll) {
        var g = collectGroup();
        var en = card.querySelector('#wmToggle').checked;
        call('set_project_watermark', project, curWm, en, applyToAll, g.group, g.groupEnabled).then(function (res) {
          if (res && res.ok) {
            setStatus(applyToAll ? ('已保存项目设置，并将 ' + (res.replaced || 0) + ' 个 TXT 的水印行更改为新水印') : '已保存项目设置');
            if (applyToAll) refreshData();
            afterSave();
          }
          else toast('保存失败：' + ((res && res.error) || '未知错误'), true);
        }).catch(function (err) { toast('保存失败：' + err.message, true); });
      }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDialog(); });
      card.querySelector('.modal-close').addEventListener('click', closeDialog);
      card.querySelector('[data-wm-act="cancel"]').addEventListener('click', closeDialog);
      // 启用默认分组数开关：随勾选联动输入框可编辑状态
      card.querySelector('#groupToggle').addEventListener('change', function () {
        card.querySelector('#groupInput').disabled = !this.checked;
      });
      card.querySelector('#groupInput').disabled = !curGroupEn;
      // 保存：主流水印未更改则仅保存；已更改则二次确认“仅保存 / 保存并替换”
      card.querySelector('[data-wm-act="save"]').addEventListener('click', function () {
        var en = card.querySelector('#wmToggle').checked;
        var wmChanged = (en !== wmEn0) || (curWm !== curWm0);
        if (!wmChanged) { doSave(false); return; }
        showDialog({
          title: '水印设置已更改',
          message: '主流水印设置已发生更改，请选择保存方式：\n\n· 仅保存：只保存本次设置，不改动已有文件\n· 保存并替换：同时将本项目全部 TXT（含日志）的水印行改为新水印',
          buttons: [
            { label: '仅保存', value: 'save', primary: true },
            { label: '保存并替换', value: 'all', danger: true }
          ]
        }).then(function (v) {
          if (!v) return;
          if (v === 'all') {
            confirmPopover({
              title: '确认批量替换水印',
              message: '将把本项目全部 TXT（含日志）中的水印行更换为：\n' + curWm + '\n\n原水印无法恢复',
              okLabel: '确认替换',
              danger: true
            }).then(function (ok) { if (ok) doSave(true); });
          } else doSave(false);
        });
      });
    }).catch(function (err) { toast('读取项目设置失败：' + err.message, true); });
  }
  // ownerEl：气泡的归属元素（被右键/点击操作的对象）。菜单项点击后菜单即移除，
  // 故把锚点改回归属元素，使气泡出现在「真正的对象」旁，而不是菜单项位置。
  function showMenu(x, y, items, ownerEl) {
    var old = document.getElementById('ctxMenu');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'ctxMenu'; m.className = 'ctx-menu';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      m.appendChild(b);
      if (it.disabled) {
      // 置灰项仍可点击：点击关闭菜单并以 toast 提示不可用原因（仅告知，不开大窗）
      b.className = 'ctx-menu__btn--disabled';
      if (it.title) b.title = it.title;
      b.addEventListener('click', function () { close(); toast(it.title || it.label + '不可用', true); });
      return;
    }
      b.addEventListener('click', function () { m.remove(); setPopAnchor(ownerEl || _ctxOwner); it.action(); });
    });
    document.body.appendChild(m);
    m.style.left = x + 'px'; m.style.top = y + 'px';
    function close() {
      m.remove();
      document.removeEventListener('mousedown', onDocMd, true);
      document.removeEventListener('contextmenu', onCtx, true);
    }
    function onDocMd(e) { if (!m.contains(e.target)) close(); }
    function onCtx() { close(); }
    setTimeout(function () { document.addEventListener('mousedown', onDocMd, true); }, 0);
    document.addEventListener('contextmenu', onCtx, true);
  }
  function getApi() {
    return window.txapi || (window.pywebview && window.pywebview.api) || null;
  }
  // 全局统一：灰显按钮（.is-vl-disabled）点击弹 toast 说明不可用原因（不开新窗）。
  // 捕获阶段拦截，优先于业务点击处理；水印行/模式切换等所有 is-vl-disabled 按钮统一走此
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('.is-vl-disabled')) {
      var el = t.closest('.is-vl-disabled');
      var why = el.getAttribute && (el.getAttribute('data-why') || el.title || '');
      if (why) toast(why, true);
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var api = getApi();
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('功能暂不可用'));
    return Promise.resolve().then(function () { return api[method].apply(api, args); });
  }
  // 左下角菜单关闭（全局可用，供 initMaskMode 等独立函数调用）
  function closeMenu() { var m = $('sidebarMenu'); if (m) m.style.display = 'none'; }
  var state = {
    projects: [], activeProject: null, activeTxt: null, versions: [], activeVersion: null,
    configData: null, mode: 'filelist', highlightDup: false, searchQuery: '', logSearchQuery: '',
    expandedProject: null, sortMode: 'name', sortAsc: true, sortTimeDesc: true, rightPreview: true, precheckInvalid: false, watermarkMissing: false, logContent: null,
    logFiles: [], activeLogDate: null, activeLogPath: null, selectMode: false, selectedLogPaths: {},
    logViewMode: 'simple', // 日志预览模式：simple=简化（片段仅显示最后一段文件名）/ raw=完整原始
    focusVideo: null, _searchTimer: null, _fromConfig: false, envMissing: [],
    isPortable: null, // 运行时形态：null=未知（按便携处理）/ true=便携 zip / false=setup 安装版
    previewCollapsed: true, // 右侧预览面板默认折叠（仅留拖拽条上的竖条按钮提示展开）
    previewLastWidth: 320, // 展开时恢复的预览宽度（记忆折叠前的宽度）
    _sideBeforeLog: false, // 进入日志模式前预览面板是否原本折叠（退出时恢复）
    precheckBackground: false, // 预检测是否已缩到后台（状态栏 probe-mini 显示进度）
    _probeActive: false        // 当前是否有一次预检测在进行（防止误点「缩到后台」）
  };
  // 复刻虚拟项目：仅含日志无配置，配置名对应复刻模式；REPLICA_MARK 为路由标记，透传回后端
  var REPLICA_PROJECT = '复刻';
  var REPLICA_MARK = 'REPLICA:';
  function $(id) { return document.getElementById(id); }

  // 时间排序键：取标签前 4 位 MMdd 作主键 + 后缀序号（-1/-2/* 等）作细分，0802 与 0802-1 同组但后者排前面
  function branchNum(s) {
    var m = /^(\d{2})(\d{2})/.exec(s || '');
    var main = m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 0;
    var n = /[-*](\d+)$/.exec(s || '');
    var sub = n ? parseInt(n[1], 10) : 0;
    return main * 100 + sub;
  }
  // 名称排序：按 azbar 的拼音首字母顺序（A→Z，兜底 # 最后），与 A-Z 索引条一致
  function azRank(name) {
    var L = azInitial(name);
    var i = AZ_KEYS.indexOf(L);
    return i >= 0 ? i : AZ_KEYS.length;
  }
  function sortByName(a, b) {
    var r = azRank(a.name) - azRank(b.name);
    if (r !== 0) return r;
    return String(a.name).localeCompare(String(b.name), 'zh');
  }
  function sortedProjects() {
    var list = state.projects.slice();
    // 项目名始终按名称升序（升降序仅作用于配置项），复刻虚拟项目固定放最下面
    list.sort(function (a, b) {
      if (a.name === REPLICA_PROJECT) return 1;
      if (b.name === REPLICA_PROJECT) return -1;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    return list;
  }
  function updateSortButtons() {
    function render(id, active, arrow) { var b = $(id); if (!b) return; b.innerHTML = '<span class="sort-toggle__arrow">' + arrow + '</span>' + (id === 'btnSortName' ? '名称' : '时间'); b.classList.toggle('sort-toggle--active', active); }
    render('btnSortName', state.sortMode === 'name', state.sortAsc ? '▲' : '▼');
    render('btnSortTime', state.sortMode === 'time', state.sortTimeDesc ? '▼' : '▲');
  }
  function sortedTxts(txts) {
    var list = txts.slice();
    list.sort(function (a, b) {
      // 空白配置（无素材路径）恒置顶：任意排序模式下固定排在其他配置之上
      if (a.empty && !b.empty) return -1;
      if (!a.empty && b.empty) return 1;
      if (state.sortMode === 'time') {
        var d = branchNum(b.latest) - branchNum(a.latest);
        return state.sortTimeDesc ? d : -d;
      } else {
        var r = sortByName(a, b);
        return state.sortAsc ? r : -r;
      }
    });
    return list;
  }
  // 时间排序按月份分组：取配置版本 label（如 0802、0802-1、0802*）开头的两位月份，忽略后缀
  function monthOf(label) {
    var m = /^(\d{2})/.exec(String(label || '').trim());
    return m ? parseInt(m[1], 10) : 0;
  }
  function buildSidebar(forceAz, noBadgeAnim) {
    if (maskOn()) return; // 遮罩模式：批量侧栏渲染一律拒绝，防模式污染
    var tree = $('sidebarTree');
    var html = '';
    sortedProjects().forEach(function (proj) {
      var expanded = (proj.name === state.expandedProject);
      html += '<div class="tree-project">';
      html += '<div class="tree-project__name' + (expanded ? ' tree-project__name--sticky is-filled' : '') + '" data-project="' + escapeHtml(proj.name) + '">';
      html += '<span class="tree-arrow' + (expanded ? ' tree-arrow--open' : '') + '"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
      html += icon('folder', 16, 'tree-project__icon');
      html += escapeHtml(proj.name);
      // 项目名行右侧：展开时显示「共 N 个配置」徽章（复刻虚拟项目无配置则不显示）
      // 切换配置场景（noBadgeAnim）：徽章加 --static 静止类，不重播滑入动画，与本行其他内容保持一致
      if (proj.name !== REPLICA_PROJECT && expanded) {
        html += '<span class="tree-project__badge' + (noBadgeAnim ? ' tree-project__badge--static' : '') + '">共 ' + proj.txts.length + ' 个配置</span>';
      }
      html += '</div>';
      if (expanded) {
        html += '<div class="tree-project__items">';
        var lastGroupKey = null;
        var isReplica = (proj.name === REPLICA_PROJECT);
        sortedTxts(proj.txts).forEach(function (txt) {
          var isActive = (proj.name === state.activeProject && txt.name === state.activeTxt);
          var matched = !state.searchQuery || txt.name.toLowerCase().indexOf(state.searchQuery.toLowerCase()) >= 0;
          // 当前选中（正在编辑）的配置在任何搜索词下都保留渲染并保持高亮：
          // 若被搜索过滤移除，皮肤 chat-active 状态投影会误删 → 底部配置栏滑出消失
          if (!matched && !isActive) return;
          // 名称排序按首字母分组、时间排序按月份分组；组首插入标签行（含首组）；复刻虚拟项目的固定子项不参与分组
          if (!isReplica) {
            var groupKey = (state.sortMode === 'time')
              ? monthOf(txt.latest)
              : azInitial(txt.name);
            if (lastGroupKey === null || groupKey !== lastGroupKey) {
              var label = (state.sortMode === 'time') ? groupKey + '月' : groupKey;
              html += '<div class="tree-txt-group"><span class="tree-txt-group__label">' + escapeHtml(label) + '</span><span class="tree-txt-group__line"></span></div>';
            }
            lastGroupKey = groupKey;
          }
          var dupCls = (state.highlightDup && txt.dup) ? ' tree-txt-item--dup' : '';
          html += '<div class="tree-txt-item' + (isActive ? ' tree-txt-item--active' : '') + dupCls + '" data-project="' + escapeHtml(proj.name) + '" data-name="' + escapeHtml(txt.name) + '">';
          html += icon('file-text', 16, 'tree-txt-item__icon');
          html += '<span class="tree-txt-item__name">' + escapeHtml(txt.name) + '</span>';
          // 复刻子项无配置日期，不显示 latest；徽章显示其日志数
          if (!isReplica) html += '<span class="tree-txt-item__date">' + escapeHtml(txt.latest) + '</span>';
          html += '<span class="tree-txt-item__badge">' + txt.count + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
    tree.innerHTML = html;
    buildAzIndex(forceAz);
    syncAzBar();
  }
  // ── 项目列表 A-Z 索引条（仅名称排序时显示） ──
  // 汉字拼音首字母（无 I/U/V，故 23 个 + "#" 兜底）
  var AZ_KEYS = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
  var AZ_BASE = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥仨它穵夕丫帀'.split('');
  var AZ_BAR = AZ_KEYS.concat('#');
  function azInitial(name) {
    var s = String(name || '').trim();
    if (!s) return '#';
    var ch = s.charAt(0);
    if (/[A-Za-z]/.test(ch)) return ch.toUpperCase();
    if (!/[\u4e00-\u9fa5]/.test(ch)) return '#';
    for (var i = 0; i < AZ_KEYS.length; i++) {
      if (ch.localeCompare(AZ_BASE[i], 'zh') >= 0 && (i === AZ_KEYS.length - 1 || ch.localeCompare(AZ_BASE[i + 1], 'zh') < 0)) return AZ_KEYS[i];
    }
    return '#';
  }
  // 当前排序方向的字母顺序：升序 A→Z+# ，降序反向
  function azOrderArray() {
    var arr = AZ_KEYS.concat('#');
    return state.sortAsc ? arr : arr.slice().reverse();
  }
  // 当前展开项目（手风琴同一时刻仅一个）内配置项实际存在的首字母集合
  function currentExpandedTxts() {
    var proj = null;
    (state.projects || []).forEach(function (p) { if (p.name === state.expandedProject) proj = p; });
    return proj ? sortedTxts(proj.txts) : [];
  }
  function azAvailableLetters() {
    var set = {};
    currentExpandedTxts().forEach(function (t) { set[azInitial(t.name)] = 1; });
    return set;
  }
  // 已显示的字母：仅保留当前展开项目配置中实际存在的首字母（无对应配置的字母不显示）
  function displayedAzLetters() {
    var avail = azAvailableLetters();
    return azOrderArray().filter(function (L) { return avail[L]; });
  }
  function buildAzIndex(force) {
    var bar = $('azIndexBar');
    if (!bar) return;
    var letters = displayedAzLetters();
    var existing = Array.prototype.map.call(bar.children, function (c) { return String(c.dataset.letter || ''); });
    // 字母序列未变且非强制（如点击同一项目的配置）：复用现有字母 DOM，避免重放高亮/扫描动画
    if (!force && existing.length === letters.length && existing.every(function (L, i) { return L === letters[i]; })) {
      return;
    }
    bar.innerHTML = '';
    _lastAzActive = null; // 字母 DOM 重建后幂等基准失效，需重新判定高亮
    letters.forEach(function (L) {
      var b = document.createElement('span');
      b.className = 'az-letter';
      b.textContent = L;
      b.dataset.letter = L;
      bar.appendChild(b);
    });
    // 重建后整列字母作为整体从左到右渐显，动画期间不设高亮（保持初始排布）
    bar.classList.remove('az-bar--enter');
    void bar.offsetWidth;
    bar.classList.add('az-bar--enter');
    if (!bar.dataset.azAnimBound) {
      bar.dataset.azAnimBound = '1';
      bar.addEventListener('animationend', function (ev) {
        if (ev.animationName !== 'az-bar-enter') return;
        bar.classList.remove('az-bar--enter');
        // 仅当由点击/交互引起（_azPending）才执行突出判定，无交互保持初始排布
        if (_azPending) { _azPending = false; syncAzHighlight(); }
      });
    }
    if (bar.dataset.bound) return;
    bar.dataset.bound = '1';
    bar.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      function move(ev) { azJumpByPos(ev.clientY, true); }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        syncAzHighlight();
        var tree = $('sidebarTree');
        if (tree) {
          tree.querySelectorAll('.tree-txt-item--az').forEach(function (it) {
            it.classList.remove('tree-txt-item--az');
          });
        }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      azJumpByPos(e.clientY, true);
    });
  }
  var _lastAzActive = null;
  var _azPending = false; // 点击/交互后置位，动画结束才消费，避免无交互时自动高亮
  function setAzActive(letter) {
    var bar = $('azIndexBar');
    if (!bar) return;
    if (_lastAzActive === letter) return; // 首字母未变化：不重放高亮弹出动画
    _lastAzActive = letter;
    bar.querySelectorAll('.az-letter').forEach(function (b) { b.classList.toggle('az-letter--active', b.dataset.letter === letter); });
  }
  function azJumpByPos(clientY, highlightOnDrag) {
    var bar = $('azIndexBar');
    if (!bar) return;
    var order = displayedAzLetters();
    if (!order.length) return;
    var rect = bar.getBoundingClientRect();
    var h = rect.height / order.length;
    var idx = Math.min(order.length - 1, Math.max(0, Math.floor((clientY - rect.top) / h)));
    var letter = order[idx];
    if (highlightOnDrag) setAzActive(letter);
    azJumpTo(letter);
  }
  // 索引范围为当前展开项目内的配置项；将对应首字母组的第一个配置强制滚动到列表最顶
  function azJumpTo(letter) {
    letter = String(letter).toUpperCase();
    var tree = $('sidebarTree');
    if (!tree) return;
    var txts = currentExpandedTxts();
    var target = null;
    for (var j = 0; j < txts.length; j++) {
      if (azInitial(txts[j].name) === letter) { target = txts[j].name; break; }
    }
    if (!target) { syncAzHighlight(); return; }
    var items = tree.querySelectorAll('.tree-txt-item');
    // 展开项目名置顶会遮挡列表顶端，按被粘性头部高度偏移滚动，避免与 azbar 跳转冲突
    var header = tree.querySelector('.tree-project__name--sticky');
    var headerH = header ? header.offsetHeight : 0;
    for (var k = 0; k < items.length; k++) {
      items[k].classList.remove('tree-txt-item--az');
      if (items[k].getAttribute('data-name') === target) {
        items[k].classList.add('tree-txt-item--az');
        tree.scrollTop = items[k].offsetTop - headerH;
      }
    }
    syncAzHighlight();
  }
  function currentAzLetter() {
    var tree = $('sidebarTree');
    if (!tree) return null;
    // 置顶项目名会占据视口顶部，按粘性头部高度偏移，取其下作为「第一行配置」的判定基准
    var header = tree.querySelector('.tree-project__name--sticky');
    var topLimit = tree.getBoundingClientRect().top + (header ? header.offsetHeight : 0);
    var bottomLimit = tree.getBoundingClientRect().bottom;
    // 已选中配置且属于当前展开项目：选中行仍在列表可视区内则固定高亮其首字母；
    // 若被滚轮滑出可视区，则回退为视口首行配置的首字母（滚动回可见后自动恢复）
    if (state.activeProject && state.activeTxt && state.expandedProject === state.activeProject) {
      var items = tree.querySelectorAll('.tree-txt-item');
      var activeItem = null;
      for (var q = 0; q < items.length; q++) {
        if (items[q].getAttribute('data-name') === state.activeTxt) { activeItem = items[q]; break; }
      }
      if (activeItem) {
        var r = activeItem.getBoundingClientRect();
        if (r.top < bottomLimit && r.bottom > topLimit) return azInitial(state.activeTxt);
      }
    }
    var nodes = tree.querySelectorAll('.tree-txt-item');
    if (!nodes.length) return null;
    var first = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getBoundingClientRect().bottom >= topLimit) { first = nodes[i]; break; }
    }
    if (!first) first = nodes[nodes.length - 1];
    return azInitial(first.getAttribute('data-name') || '');
  }
  function syncAzHighlight() {
    if (maskOn()) return;
    var cur = currentAzLetter();
    setAzActive(cur);
  }
  function syncAzBar() {
    var bar = $('azIndexBar');
    if (!bar) return;
    var tree = $('sidebarTree');
    var hasTxt = !!(tree && tree.querySelector('.tree-txt-item'));
    var show = state.sortMode === 'name' && hasTxt;
    bar.classList.toggle('is-show', show);
    // 不自动判定高亮：由点击/滚动/拖拽交互触发（无交互保持初始排布）
  }
  // 仅当配置分支名/日期为严格 4 位 MMdd 时返回该日期，否则返回空串
  function mmddOf(label) { var s = String(label || ''); return /^\d{4}$/.test(s.slice(0, 4)) ? s.slice(0, 4) : ''; }

  // 返回去除项目名后的展示相对路径（如 8月\0819\...\xxx.txt）
  function relToProject(p) {
    var s = String(p || '').replace(/[\\/]+/g, '\\');
    var proj = String(state.activeProject || '').replace(/[\\/]+/g, '\\');
    if (!proj) return s;
    var i = s.indexOf('\\' + proj + '\\');
    return (i === -1) ? s : s.slice(i + proj.length + 2);
  }
  function dirnamePath(p) {
    var s = String(p || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '');
    var i = s.lastIndexOf('\\');
    return i === -1 ? s : s.slice(0, i);
  }
  // 某日志文件对应的可跳配置版本：优先「同一成片文件夹内的正本/序号」，否则回退「当日外部 * 配置」
  function versionForLogFile(f) {
    var versions = state.versions || [];
    var date = f.date;
    for (var i = 0; i < versions.length; i++) {
      var v = versions[i];
      if (v.isExternal) continue;
      if (mmddOf(v.label) !== date) continue;
      if (dirnamePath(v.path) === dirnamePath(f.path)) return v;
    }
    for (var j = 0; j < versions.length; j++) {
      var v2 = versions[j];
      if (mmddOf(v2.label) === date && v2.isExternal) return v2;
    }
    return null;
  }
  // 配置模式 → 日志：按当前配置文件版本 label 定位当日对应日志分支
  //   - 无后缀正本 / 序号化 -N → 精确匹配 label 完全一致的当日日志
  //   - 外部 * → 当日成片日志：多序号并存跳 -1(最旧)；单成片跳唯一正本；仅此一份跳当日任一
  function logTargetForVersion(files) {
    var v = state.activeVersion;
    if (!v) return null;
    var d = mmddOf(v.label);
    if (!d) return null;
    var sameDay = (files || []).filter(function (f) { return f.date === d; });
    if (!sameDay.length) return null;
    var st = String(v.label || '').slice(4); // '' | -N | *
    if (st === '*') {
      var numbered = sameDay.filter(function (f) { return /-\d+$/.test(f.label || ''); });
      if (numbered.length > 1) return numbered[0]; // 多成片并存 → -1(最旧)
      var plain = sameDay.find(function (f) { return /^\d{4}$/.test(f.label || ''); });
      if (plain) return plain; // 单成片 → 唯一正本日志
      return sameDay[0];
    }
    var exact = sameDay.find(function (f) { return f.label === v.label; });
    return exact || sameDay[0];
  }
  // 日志模式当下所选日期是否「有可跳配置」：任一该日期日志能在版本中找到正本/序号 或 外部 *
  function logDateHasConfig() {
    var logs = (state.logFiles || []).filter(function (f) { return f.date === state.activeLogDate; });
    if (!logs.length) return false;
    return logs.some(function (f) { return versionForLogFile(f) != null; });
  }
  // 依据当前所在视角与所选日期，启用/禁用「配置列表/日志」切换按钮并附带悬浮提示
  function updateModeToggle() {
    var ml = $('modeLog'), mf = $('modeFilelist');
    if (!ml || !mf) return;
    ml.classList.remove('is-vl-disabled'); ml.removeAttribute('data-why'); ml.title = '';
    mf.classList.remove('is-vl-disabled'); mf.removeAttribute('data-why'); mf.title = '';
    if (state.activeProject === REPLICA_PROJECT) {
      mf.classList.add('is-vl-disabled'); mf.setAttribute('data-why', '复刻模式无配置文件'); mf.title = '复刻模式无配置文件';
      return;
    }
    if (state.mode === 'filelist') {
      if (!state.activeVersion) { ml.classList.add('is-vl-disabled'); ml.setAttribute('data-why', '该配置文件没有对应日志'); ml.title = '该配置文件没有对应日志'; return; }
      var d = mmddOf(state.activeVersion.label);
      if (!d || !state.activeVersion.hasLog) { ml.classList.add('is-vl-disabled'); ml.setAttribute('data-why', '该配置文件没有对应日志'); ml.title = '该配置文件没有对应日志'; }
    } else if (state.mode === 'log') {
      if (!state.activeLogDate) { mf.classList.add('is-vl-disabled'); mf.setAttribute('data-why', '该日志没有对应日期的配置'); mf.title = '该日志没有对应日期的配置'; return; }
      if (!logDateHasConfig()) { mf.classList.add('is-vl-disabled'); mf.setAttribute('data-why', '该日志没有对应日期的配置'); mf.title = '该日志没有对应日期的配置'; }
    }
  }
  function buildDateBranches(silent) {
    if (maskOn()) return; // 遮罩模式：批量日期分支渲染拒绝
    var c = $('dateBranches');
    if (!c) return; // 遮罩等模式重写 centerTop 后容器可能不存在：安全忽略
    if (state.activeProject === REPLICA_PROJECT) {
      // 复刻项目按日志日期分支展示（每个日期=一份复刻日志），便于按天定位成片来源
      buildLogDateBranches(c, silent);
      return;
    }
    if (state.mode === 'log') { buildLogDateBranches(c, silent); return; }
    if (!state.activeTxt || state.versions.length === 0) {
      c.innerHTML = '<div class="center-empty" style="padding:var(--spacer-16)">' + icon('arrow-left', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">从左侧选择一个 TXT</span></div>';
      updateModeToggle();
      return;
    }
    var html = '';
    state.versions.forEach(function (v) {
      var active = v.label === state.activeVersion.label;
      html += '<button class="date-branch-btn' + (active ? ' date-branch-btn--active' : '') + (silent ? ' date-branch-btn--static' : '') + '" data-label="' + escapeHtml(v.label) + '" title="' + escapeHtml(v.path) + '">' + escapeHtml(v.label);
      html += '</button>';
    });
    c.innerHTML = html;
    updateModeToggle();
  }
  // 日志模式下：顶部展示该配置的日志文件日期分支（每日期一个），按钮带 data-date 与 data-file
  function buildLogDateBranches(c, silent) {
    if (!state.activeTxt || !state.activeVersion) { c.innerHTML = ''; return; }
    c.innerHTML = '<span class="date-branch-btn">…</span>';
    var token = state.activeProject + '\u0000' + state.activeTxt;
    state._logBranchToken = token;
    call('list_log_files', state.activeVersion.path, state.activeTxt).then(function (files) {
      if (state._logBranchToken !== token) return;
      files = files || [];
      state.logFiles = files;
      if (!files.length) { state.activeLogDate = null; state.activeLogPath = null; c.innerHTML = '<span class="date-branch-btn">无日志</span>'; updateModeToggle(); return; }
      // 定位当前选中分支：从配置切入时按配置文件版本定位当日对应日志；否则按残留定位
      var fromConfig = state._fromConfig; state._fromConfig = false;
      var active = fromConfig ? logTargetForVersion(files) : null;
      if (!active && state.activeLogPath) { var hit = files.find(function (f) { return f.path === state.activeLogPath; }); if (hit) active = hit; }
      if (!active && state.activeLogDate) { var hit2 = files.find(function (f) { return f.date === state.activeLogDate; }); if (hit2) active = hit2; }
      // 任务列表「定位至日志」：pending 指定的日志文件（含版本序号 -1/-2 按实际文件精确匹配）
      if (!active && state._locateLogPath) {
        var lh = files.find(function (f) { return f.path === state._locateLogPath; });
        if (lh) active = lh;
        state._locateLogPath = null;
      }
      // 无配置可定位：默认选中最新一天的日志（后端已按日期降序，首个即最新 —— 复刻与普通项目一致）
      if (!active) active = files.length ? files[0] : null;
      if (!active) { state.activeLogDate = null; state.activeLogPath = null; c.innerHTML = '<span class="date-branch-btn">无日志</span>'; updateModeToggle(); return; }
      var had = state.activeLogPath === active.path;
      state.activeLogDate = active.date;
      state.activeLogPath = active.path;
      var html = '';
      files.forEach(function (f) {
        var isActive = f.path === active.path;
        var txt = f.label || f.date;
        html += '<button class="date-branch-btn' + (isActive ? ' date-branch-btn--active' : '') + (silent ? ' date-branch-btn--static' : '') + '" data-date="' + escapeHtml(f.date) + '" data-file="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">' + escapeHtml(txt) + '</button>';
      });
      c.innerHTML = html;
      updateModeToggle();
      if (!had && state.mode === 'log' && state.activeTxt) buildCenterBottom();
    }).catch(function () { c.innerHTML = '<span class="date-branch-btn">无日志</span>'; updateModeToggle(); });
  }
  function buildCenterBottom(silent) {
    if (maskOn()) return; // 遮罩模式：批量中心内容渲染拒绝
    var cb = $('centerBottom');
    if (!cb) return; // 容器缺失时安全忽略（遮罩/恢复切换的窗口期）
    if (!state.activeTxt || !state.activeVersion) {
      cb.innerHTML = '<div class="center-empty">' + icon('file-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">请选择一个日期分支查看内容</span></div>';
      return;
    }
    if (state.mode === 'log') { buildLogConfigBar(); buildLogList(); return; }
    var container = cb;
    var data = state.configData;
    if (!data) { container.innerHTML = '<div class="center-empty">' + icon('file-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">正在加载配置…</span></div>'; return; }
    var folders = data.folders || [];
    var excludes = data.excludes || [];
    var watermark = data.watermark || '';
    // 配置间切换（silent）时不给进场动画：与徽章 --static 同思路，避免重建页面时的滑入感
    var html = '<div class="config-editor' + (silent ? ' config-editor--static' : '') + '">';
    html += '<div class="config-editor__col config-editor__col--paths">';
    html += '<div class="config-path-subheader"><span class="config-path-subheader__sort">排序</span><span class="config-path-subheader__nopoll">取消轮询</span><span class="config-path-subheader__path">路径</span><span class="config-path-subheader__check">预检测结果'
      + '<button type="button" class="config-path-subheader__refresh" id="btnRefreshPrecache" title="刷新预缓存：更新变化的视频并清理失效缓存（含批量与遮罩素材）">' + icon('refresh-cw', 12) + '</button>'
      + '</span><span class="config-path-subheader__browse"></span><span class="config-path-subheader__open"></span><span class="config-path-subheader__remove"></span></div>';
    html += '<div class="config-editor__path-list" id="pathList">';
    folders.forEach(function (f, idx) {
      html += '<div class="config-path-row" data-index="' + idx + '" data-orig="' + escapeHtml(f.path) + '" data-orig-idx="' + idx + '">';
      html += '<span class="config-path-row__drag" draggable="true" title="按住拖动排序">' + icon('grip-vertical', 14) + '</span>';
      html += '<label class="config-path-row__checkbox" title="勾选 = 不轮询（添加 = 前缀）"><input type="checkbox" class="config-path-row__check" ' + (f.nonround ? 'checked' : '') + '><span class="config-path-row__check-mark"></span></label>';
      html += '<input type="text" class="config-path-row__input" value="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">';
      html += '<span class="config-path-row__precheck" data-index="' + idx + '"><span class="config-path-row__badge precheck--pending">检测中…</span></span>';
      html += '<button class="config-path-row__browse" title="修改路径">' + icon('pencil', 14) + '</button>';
      html += '<button class="config-path-row__open" title="打开文件夹">' + icon('folder-open', 14) + '</button>';
      html += '<button class="config-path-row__remove" title="移除路径">' + icon('x', 14) + '</button></div>';
    });
    html += '</div>';
    html += '<button class="config-path-add" id="btnAddPath" title="添加路径">' + icon('plus', 14) + '添加路径</button></div>';
    html += '<div class="config-resizer"></div>';
    html += '<div class="config-editor__bottom">';
    html += '<div class="config-editor__col config-editor__col--exclude">';
    html += '<div class="config-editor__col-header">排除字段 <span class="config-editor__col-count">' + excludes.length + '</span></div>';
    html += '<div class="config-editor__exclude-list" id="excludeList">';
    excludes.forEach(function (ex) {
      html += '<div class="config-exclude-row" data-orig="' + escapeHtml(ex) + '"><span class="config-exclude-row__path" title="' + escapeHtml(ex) + '">' + escapeHtml(ex) + '</span><button class="config-exclude-row__remove" title="移除排除字段">' + icon('x', 12) + '</button></div>';
    });
    html += '</div>';
    html += '<input type="text" class="config-exclude-input" id="inputExclude" placeholder="输入排除字符串，回车添加" spellcheck="false"></div>';
    html += '<div class="config-editor__col config-editor__col--watermark">';
    html += '<div class="config-editor__wm-section">';
    html += '<div class="config-editor__col-header">水印 PNG</div>';
    html += '<div class="config-editor__watermark-content">';
    html += wmRowHtml(watermark);
    html += '</div></div>';
    // 框体下半：配置名（标题行 + 内容栏，与其他框体一致）
    html += '<div class="config-editor__wm-section">';
    html += '<div class="config-editor__col-header">配置名</div>';
    html += '<div class="config-editor__wm-field"><input type="text" class="config-bottombar__input config-bottombar__input--name" id="inputConfigName" value="' + escapeHtml((data && data.name) || '') + '"></div></div>';
    html += '</div></div>';
    container.innerHTML = html;
    buildConfigBar(); bindEditorEvents(); bindResizers(container); bindModifiedWatchers(container); runPrecheck();
    // 仅真正加载配置时（_configOrig 为 null）建立修改基线；局部重建（如水印变更）不重置，保证各部分修改相互独立
    if (state._configOrig === null || state._configOrig === undefined) {
      state._configOrig = {
        folders: folders.map(function (f) { return String(f.path); }),
        excludes: excludes.map(function (e) { return String(e); }),
        watermark: watermark,
        name: data.name || ''
      };
      state._configOrigSnapshot = configSnapshot();
    }
    refreshConfigModified();
  }
  function buildConfigBar() {
    if (maskOn()) return; // 遮罩模式：批量底栏渲染拒绝
    var bar = $('configBar');
    if (!bar) return;
    var data = state.configData;
    var name = data ? data.name : '';
    var html = '<div class="config-bar__left">';
    html += '<label class="config-bottombar__label">成片数量</label>';
    html += '<span class="config-bottombar__field"><input type="number" class="config-bottombar__input" id="inputFilmCount" value="" min="1" max="99" placeholder="必填"><span class="config-bottombar__error" id="filmCountError" style="display:none">请输入成片数量</span></span>';
    html += '<label class="config-bottombar__label">分组数</label>';
    html += '<input type="number" class="config-bottombar__input" id="inputGroupCount" value="" min="1" max="99" placeholder="不分组"></div>';
    html += '<div class="config-bar__right">';
    html += '<span class="config-bottombar__warn" id="configWarnMark" style="display:none">有不合格路径</span>';
    html += '<span class="config-bottombar__modified" id="configModifiedHint" style="display:none">配置发生改变</span>';
    html += '<span class="config-bottombar__error config-bottombar__error--inline" id="watermarkFlagError" style="display:none">水印错误</span>';
    html += '<button class="config-btn config-btn--save" id="btnSaveConfig">' + icon('save', 14) + '覆盖当前配置</button>';
    html += '<button class="config-btn config-btn--save-today" id="btnSaveToday">' + icon('calendar-plus', 14) + '保存为当日配置</button>';
    html += '<button class="config-btn config-btn--run" id="btnRunScript">' + icon('play', 14) + '开始制作</button></div>';
    bar.innerHTML = html;
    // 注意：不可直接传 saveConfig —— 它首参是 noConfirm，直接绑定会让 MouseEvent 顶替该参数（恒真）而跳过确认气泡
    $('btnSaveConfig').addEventListener('click', function () { saveConfig(); });
    $('btnSaveToday').addEventListener('click', saveConfigToday);
    $('btnRunScript').addEventListener('click', runScript);
    $('inputFilmCount').addEventListener('input', function () { var errEl = $('filmCountError'); if (errEl) errEl.style.display = 'none'; });
    // 分组数：项目默认值以占位符展示（不污染实际值），用户直接输入即用自己的分组数
    var grpInp = $('inputGroupCount');
    if (grpInp) {
      grpInp.addEventListener('input', function () { applyDefaultGroupInput(); });
    }
    applyDefaultGroupInput();
    bindModifiedWatchers(bar);
    applyPrecheckValidity();
    refreshConfigModified();
    applyEnvDisabled();
  }
  // 项目设置了「默认分组数」时：以占位符提示默认值（输入框 value 保持为空，
  // 用户不输入分组数时自动使用该默认值；一旦输入即用自己的分组数）
  function applyDefaultGroupInput() {
    var inp = $('inputGroupCount');
    if (!inp || !state.activeProject) return;
    call('get_project_watermark', state.activeProject).then(function (r) {
      if (!r || !r.ok) return;
      var d = (r.groupEnabled && r.group > 0) ? String(r.group) : '';
      inp.placeholder = d || '不分组';
      inp.title = d ? '项目默认分组数 ' + d + '，留空则使用默认值' : '不分组';
    }).catch(function () {});
  }
  // ── 配置修改检测：未修改时两个保存按钮禁用；修改时编辑区红框 + 配置名左侧红字提示 ──
  function configSnapshot() {
    try {
      var ed = getEditorState();
      var nm = $('inputConfigName') ? $('inputConfigName').value.trim() : (state.activeTxt || '');
      return JSON.stringify({ f: ed.folders, e: ed.excludes, w: ed.watermark || '', n: nm });
    } catch (e) { return ''; }
  }
  function refreshConfigModified() {
    var modified = false;
    if (state.configData) {
      var t0 = state._configOrigSnapshot, t1 = configSnapshot();
      modified = t0 !== null && t0 !== undefined && t1 !== t0;
    }
    state.configModified = modified;
    var b1 = $('btnSaveConfig'), b2 = $('btnSaveToday');
    // ★ 保存类按钮放宽：保存配置只是写盘（原子写），
    //   与预检测、FFmpeg 环境都无关 —— 允许用户在任务运行/排队期间先"暂存配置"备用
    if (b1) { b1.disabled = !modified; setBtnHint(b1, modified ? null : '配置未发生改变'); }
    if (b2) { b2.disabled = false; setBtnHint(b2, null); }
    var hint = $('configModifiedHint');
    if (hint) {
      hint.style.display = modified ? '' : 'none';
      // 明确生效范围：任务在提交入队时已快照配置，之后的修改只影响新提交的任务
      hint.textContent = '配置发生改变（保存后仅对之后启动的任务生效）';
    }
    // ── 元素级红框提示 ──
    var orig = state._configOrig || {};
    // 路径行：文字变化 → 输入框边框红；仅被拖动的行且不在原位 → 该行整行红
    document.querySelectorAll('.config-path-row').forEach(function (row, i) {
      if (row.dataset.deleted === '1') { row.classList.remove('is-modified-row', 'config-path-row--invalid-moved'); return; } // 软删除行不参与修改检测
      var inp = row.querySelector('.config-path-row__input');
      var origText = row.getAttribute('data-orig') || '';
      if (inp) inp.classList.toggle('is-modified-input', String(inp.value || '').trim() !== origText.trim());
      var origIdx = parseInt(row.getAttribute('data-orig-idx') || '-1', 10);
      var movedFlag = row.dataset.moved === '1';
      var moved = movedFlag && origIdx >= 0 && origIdx !== i;
      if (movedFlag && origIdx === i) row.removeAttribute('data-moved');
      row.classList.toggle('is-modified-row', moved);
      // 路径不存在 + 排序改变并存：显式组合类让橙框/橙条与排序红条同屏（避免类同步问题）
      var isInv = row.classList.contains('config-path-row--invalid');
      row.classList.toggle('config-path-row--invalid-moved', isInv && !!moved);
    });
    // 排除行：软删除行 → 删除线灰字（不参与红底）；新增/修改行 → 低透红底+左条
    document.querySelectorAll('.config-exclude-row').forEach(function (row) {
      if (row.dataset.deleted === '1') { row.classList.remove('is-modified-row'); return; }
      var origText = row.getAttribute('data-orig') || '';
      var txt = row.querySelector('.config-exclude-row__path');
      var changed = txt ? String(txt.textContent || '').trim() !== origText.trim() : false;
      row.classList.toggle('is-modified-row', changed);
    });
    // 相对初始集合存在缺失（软删除或硬删除初始字段）→ 排除框体红；纯新增/删除刚加的字段 → 不红
    var curSet = new Set();
    document.querySelectorAll('.config-exclude-row').forEach(function (r) {
      if (r.dataset.deleted === '1') return;
      var tt = r.querySelector('.config-exclude-row__path');
      if (tt) curSet.add(String(tt.textContent || '').trim());
    });
    var lost = (orig.excludes || []).some(function (e) { return !curSet.has(String(e).trim()); });
    var exCol = document.querySelector('.config-editor__col--exclude');
    if (exCol) exCol.classList.toggle('is-modified', lost);
    // 水印：整个水印框架边框红
    var wf = document.querySelector('.config-editor__col--watermark');
    if (wf) {
      var wCur = state.configData ? (state.configData.watermark || '') : '';
      wf.classList.toggle('is-modified', wCur !== (orig.watermark || ''));
    }
  }
  function bindModifiedWatchers(container) {
    ['input', 'change', 'click'].forEach(function (ev) {
      if (container && !container.dataset.mwBound) {
        container.dataset.mwBound = '1';
        container.addEventListener(ev, refreshConfigModified, true);
      }
    });
  }
  function applyPrecheckValidity() {
    var invalid = state.precheckInvalid || state.watermarkMissing;
    var run = $('btnRunScript');
    if (run) {
      // ★ 提交类按钮放宽：环境缺失仍硬拦（必然失败），
      //   预检测不合格 / 水印缺失改为**提交时列清问题并二次确认** —— 允许先排队占位
      run.disabled = _envBad();
      setBtnHint(run, _envBad() ? '运行组件未就绪' : ((invalid || state.watermarkMissing) ? '存在问题项，提交时会再次确认' : null));
    }
    var warn = $('configWarnMark');
    if (warn) warn.style.display = state.precheckInvalid ? '' : 'none';
    refreshConfigModified();
  }
  // ── 日志模式：底部批量复刻成片配置栏 ──
  function toggleLogSelect(entry, force) {
    var lp = entry.getAttribute('data-log-path');
    var key = normalizePath(lp);
    var val = { path: lp, video: entry.getAttribute('data-video') || '' };
    if (force === true) state.selectedLogPaths[key] = val;
    else if (force === false) delete state.selectedLogPaths[key];
    else { if (state.selectedLogPaths[key]) delete state.selectedLogPaths[key]; else state.selectedLogPaths[key] = val; }
    var cb = entry.querySelector('.log-entry__check');
    if (cb) cb.checked = !!state.selectedLogPaths[key];
    entry.classList.toggle('log-entry--selected', !!state.selectedLogPaths[key]);
    refreshLogConfigBar();
  }
  function selectedLogCount() {
    var n = 0; for (var k in (state.selectedLogPaths || {})) { if (state.selectedLogPaths[k]) n++; }
    return n;
  }
  function buildLogConfigBar() {
    if (maskOn()) return;
    var bar = $('configBar');
    if (!bar) return;
    var sel = !!state.selectMode;
    // 左侧：全选(复选框) + 已选计数 + 选择按钮(在已选文字右侧)；复刻模式按钮放最右侧(软件最右下角)
    var html = '<div class="config-bar__left config-bar__left--log">';
    html += '<label class="log-configbar__selall"><input type="checkbox" id="chkLogAll">全选</label>';
    html += '<span class="log-configbar__count" id="logSelCount">已选 0</span>';
    html += '<label class="log-configbar__switch" title="切换选择模式，选择成片进行批量复刻"><input type="checkbox" class="log-configbar__switch-input" id="btnLogSelect"' + (sel ? ' checked' : '') + '><span class="log-configbar__switch-track"><span class="log-configbar__switch-thumb"></span></span><span class="log-configbar__switch-text">选择</span></label>';
    html += '</div>';
    html += '<div class="config-bar__replica" id="logReplicaBtns">';
    html += '<button class="config-btn config-btn--replica-full" id="btnBatchReplica1" title="对所选成片执行完全复刻">' + icon('repeat', 14) + '完全复刻</button>';
    html += '<button class="config-btn config-btn--replica-dedup" id="btnBatchReplica2" title="对所选成片执行去重复刻">' + icon('copy', 14) + '去重复刻</button>';
    html += '</div>';
    bar.innerHTML = html;
    $('btnLogSelect').addEventListener('change', toggleLogSelectMode);
    var all = $('chkLogAll');
    if (all) all.addEventListener('change', function () { setLogAll(this.checked); });
    $('btnBatchReplica1').addEventListener('click', function () { batchReplica('1'); });
    $('btnBatchReplica2').addEventListener('click', function () { batchReplica('2'); });
    refreshLogConfigBar();
    applyEnvDisabled();
  }
  // 仅刷新批量栏的状态（计数/按钮可用性/全选框）而不重建
  function refreshLogConfigBar() {
    if (maskOn()) return;
    var n = selectedLogCount();
    var cnt = $('logSelCount');
    if (cnt) cnt.textContent = '已选 ' + n;
    var btn1 = $('btnBatchReplica1'), btn2 = $('btnBatchReplica2');
    var canRun = !!state.selectMode && n > 0;
    if (btn1) { btn1.disabled = !canRun || _envBad(); setBtnHint(btn1, _envBad() ? '运行组件未就绪' : (canRun ? null : '请先勾选要复刻的成片')); }
    if (btn2) { btn2.disabled = !canRun || _envBad(); setBtnHint(btn2, _envBad() ? '运行组件未就绪' : (canRun ? null : '请先勾选要复刻的成片')); }
    var all = $('chkLogAll');
    if (all) all.checked = !!state.selectMode && n > 0;
  }
  function toggleLogSelectMode() {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selectedLogPaths = {};
    buildLogConfigBar();
    buildLogList();
  }
  function setLogAll(checked) {
    // 任何情况下都可勾选：勾选全选自动进入选择模式并全选，取消则退出选择模式并清空
    if (checked && !state.selectMode) state.selectMode = true;
    else if (!checked) { state.selectMode = false; state.selectedLogPaths = {}; }
    if (state.selectMode) {
      state.selectedLogPaths = {};
      var container = $('centerBottom');
      if (container) container.querySelectorAll('.log-entry').forEach(function (en) {
        var og = en.getAttribute('data-log-path');
        if (og) state.selectedLogPaths[normalizePath(og)] = { path: og, video: en.getAttribute('data-video') || '' };
      });
    }
    buildLogList();
    var selBtn = $('btnLogSelect');
    if (selBtn) selBtn.checked = !!state.selectMode;
    refreshLogConfigBar();
  }
  function batchReplica(mode) {
    if (_envBad()) { setStatus('运行组件未就绪'); return; }
    // 未进入选择模式时给明确提示
    if (!state.selectMode) { toast('请先打开右上角「选择」开关并勾选要复刻的成片', true); return; }
    var items = [];
    for (var k in (state.selectedLogPaths || {})) { var v = state.selectedLogPaths[k]; if (v) items.push({ path: (v.path || v), video: v.video || '' }); }
    if (!items.length) { toast('请先勾选要复刻的成片', true); return; }
    var cnt = items.length, done = 0;
    replicaModeDialog().then(function (sel) {
      if (!sel) { setStatus('已取消复刻'); return; }   // 取消时保留选择状态，便于重新设置
      var mode = sel.mode, opts = sel.opts;
      setStatus('已对 ' + cnt + ' 个成片启动批量' + (mode === '1' ? '完全' : '去重') + '复刻…');
      items.forEach(function (it) {
        // 按选中成片精确复刻（传入成片名，脚本仅处理该成片）
        call('run_replica', it.path, mode, it.video, opts).then(function (r) {
          done++;
          if (!(r && r.ok)) setStatus('启动失败：' + ((r && r.error) || '未知错误'));
          else if (done === cnt) { toast('已全部启动 ' + cnt + ' 个复刻任务', 'ok'); }
        }).catch(function () { done++; });
      });
      // ⚠ 必须确认启动后才退出选择模式：弹窗前就清空会导致再点另一个按钮无反应
      state.selectMode = false; state.selectedLogPaths = {};
      buildLogList();
    });
  }
  function bindResizers(scope) {
    scope.querySelectorAll('.config-resizer').forEach(function (rz) {
      rz.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var parent = rz.parentNode, above = rz.previousElementSibling, below = rz.nextElementSibling;
        if (!above || !below) return;
        var horizontal = getComputedStyle(parent).flexDirection === 'row';
        var sizeAbove = horizontal ? above.clientWidth : above.clientHeight;
        var sizeBelow = horizontal ? below.clientWidth : below.clientHeight;
        var startPos = horizontal ? e.clientX : e.clientY;
        var minSize = 48;
        rz.classList.add('config-resizer--active');
        function onMove(ev) {
          var pos = horizontal ? ev.clientX : ev.clientY;
          var delta = pos - startPos;
          above.style.flex = '0 0 ' + Math.max(minSize, sizeAbove + delta) + 'px';
          below.style.flex = '0 0 ' + Math.max(minSize, sizeBelow - delta) + 'px';
        }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); rz.classList.remove('config-resizer--active'); }
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    });
  }
  function getEditorState() {
    var folders = [];
    var list = $('pathList');
    if (list) list.querySelectorAll('.config-path-row').forEach(function (row) {
      if (row.dataset.deleted === '1') return; // 软删除行不计入，保存时视为硬删除
      var input = row.querySelector('.config-path-row__input');
      var chk = row.querySelector('.config-path-row__check');
      var p = input.value.trim();
      if (p) folders.push({ path: p, nonround: !!chk.checked });
    });
    var excludes = [];
    var exList = $('excludeList');
    if (exList) exList.querySelectorAll('.config-exclude-row').forEach(function (row) { if (row.dataset.deleted === '1') return; var t = row.querySelector('.config-exclude-row__path'); if (t) { var s = t.textContent.trim(); if (s) excludes.push(s); } });
    var watermark = state.configData ? (state.configData.watermark || '') : '';
    return { folders: folders, excludes: excludes, watermark: watermark };
  }
  // 预检测：输入防抖后执行；不弹前台遮罩，进度与结果写回每行的预检测徽章，用户随时可看。
  var precheckDebounceTimer = null;
  var precheckOverlayCount = 0;
  var PRECHECK_DEBOUNCE_MS = 250; // 输入防抖窗口
  function showPrecheckBusy() {
    precheckOverlayCount++;
  }
  function hidePrecheckBusy() {
    precheckOverlayCount = Math.max(0, precheckOverlayCount - 1);
    if (precheckOverlayCount === 0) hideBusy();
  }
  function runPrecheck() {
    if (precheckDebounceTimer) clearTimeout(precheckDebounceTimer);
    precheckDebounceTimer = setTimeout(runPrecheckNow, PRECHECK_DEBOUNCE_MS);
  }
  function runPrecheckNow() {
    assertWatermark(); // 选中配置进行预检测时联动水印归属判定
    var list = $('pathList');
    if (!list) return;
    var rows = list.querySelectorAll('.config-path-row');
    var paths = [];
    rows.forEach(function (row) {
      var p = row.querySelector('.config-path-row__input').value.trim();
      var chk = row.querySelector('.config-path-row__check');
      paths.push({ path: p, nonround: !!chk.checked });
    });
    var excludes = [];
    var exList = $('excludeList');
    if (exList) exList.querySelectorAll('.config-exclude-row').forEach(function (row) { if (row.dataset.deleted === '1') return; var t = row.querySelector('.config-exclude-row__path'); if (t) { var s = t.textContent.trim(); if (s) excludes.push(s); } });
    if (paths.length === 0) return;
    call('precheck', paths, excludes).then(function (results) {
      results = results || [];
      var anyWarn = false;
      rows.forEach(function (row, i) {
        if (row.dataset.deleted === '1') return; // 软删除行不参与预检测判定
        var r = results[i] || { status: 'pending', text: '未检测' };
        row.classList.toggle('config-path-row--invalid', r.status === 'warn');
        if (r.status === 'warn') anyWarn = true;
        var span = row.querySelector('.config-path-row__precheck');
        var badge = span ? span.querySelector('.config-path-row__badge') : null;
        var cls = 'precheck--pending';
        if (r.status === 'ok') cls = 'precheck--ok';
        else if (r.status === 'warn') cls = 'precheck--warn';
        else if (r.status === 'group') cls = 'precheck--group';
        if (badge) { badge.className = 'config-path-row__badge ' + cls; badge.textContent = r.text || ''; }
        else { span.className = 'config-path-row__precheck ' + cls; span.textContent = r.text || ''; }
      });
      // 成片数默认值（预检测视频总数）与「默认分组数」一致：以占位符展示、不写入 value，
      // 用户不填写时沿用该默认值，一旦填写即用自己的数量
      var def = (results.length && results[0] && results[0].total) ? String(results[0].total) : '';
      var filmInput = $('inputFilmCount');
      if (filmInput) {
        filmInput.placeholder = def || '必填';
        filmInput.title = def ? '默认成片数量 ' + def + '（预检测视频总数），留空则使用该值' : '必填';
      }
      state.precheckInvalid = anyWarn;
      applyPrecheckValidity();
    }).catch(function () {
      rows.forEach(function (row) {
        if (row.dataset.deleted === '1') return;
        var span = row.querySelector('.config-path-row__precheck');
        var badge = span ? span.querySelector('.config-path-row__badge') : null;
        if (badge) { badge.className = 'config-path-row__badge precheck--warn'; badge.textContent = '检测失败'; }
        else { span.className = 'config-path-row__precheck precheck--warn'; span.textContent = '检测失败'; }
      });
      state.precheckInvalid = true;
      applyPrecheckValidity();
    }).finally(function () {
      if (precheckOverlayCount > 0) hidePrecheckBusy();
    });
  }
  function refreshPreviewIfModified() { if (state.rightPreview) buildRightPanel(); }
  function bindEditorEvents() {
    var pathList = $('pathList');
    // 表头「预检测结果」右侧的刷新按钮：直接复用刷新预缓存流程（增量、不重置、带进度与取消）。
    // 表头会随配置切换重建，故用 dataset 标记避免重复绑定。
    var btnRefresh = $('btnRefreshPrecache');
    if (btnRefresh && btnRefresh.dataset.bound !== '1') {
      btnRefresh.dataset.bound = '1';
      btnRefresh.addEventListener('click', function () {
        if (btnRefresh.disabled) return;
        btnRefresh.disabled = true;
        btnRefresh.classList.add('is-spinning');
        var restore = function () { btnRefresh.disabled = false; btnRefresh.classList.remove('is-spinning'); };
        Promise.resolve(refreshPrecacheFlow()).then(restore, restore);
      });
    }
    var dragged = null;
    var container = $('centerBottom');
    function onContainerClick(e) {
      var t = e.target.closest('button, .config-path-row__open, .config-path-row__remove, .config-watermark__path');
      if (!t) return;
      if (t.classList.contains('config-path-row__remove')) {
        // 软删除：第一次点击标记删除（按钮变恢复），再次点击取消删除；保存配置后视为硬删除
        var pRow = t.closest('.config-path-row');
        if (pRow.dataset.deleted === '1') {
          delete pRow.dataset.deleted;
          pRow.classList.remove('is-path-deleted');
          t.innerHTML = icon('x', 14);
          t.title = '移除路径';
        } else {
          pRow.dataset.deleted = '1';
          pRow.classList.add('is-path-deleted');
          t.innerHTML = icon('repeat', 14);
          t.title = '恢复该路径';
        }
        updatePathCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
      }
      else if (t.classList.contains('config-path-row__browse')) {
        var brRow = t.closest('.config-path-row');
        var brInput = brRow.querySelector('.config-path-row__input');
        call('pick_single_folder').then(function (np) {
          if (!np) return;
          brInput.value = np; brInput.title = np;
          runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
        }).catch(function (e) { setStatus('修改路径失败：' + e.message); });
      }
      else if (t.classList.contains('config-path-row__open')) { var input = t.closest('.config-path-row').querySelector('.config-path-row__input'); openInShell(input.value.trim()); }
      else if (t.classList.contains('config-exclude-row__remove')) {
        var exRow = t.closest('.config-exclude-row');
        if (exRow.dataset.deleted === '1') {
          // 恢复被软删除的排除字段
          delete exRow.dataset.deleted;
          exRow.classList.remove('is-ex-deleted');
          t.innerHTML = icon('x', 12);
          t.title = '移除排除字段';
        } else {
          // 软删除：文字删除线灰显，x 变恢复按钮
          exRow.dataset.deleted = '1';
          exRow.classList.add('is-ex-deleted');
          t.innerHTML = icon('repeat', 12);
          t.title = '恢复该排除字段';
        }
        updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
      }
      else if (t.id === 'btnAddPath') { addPathField(); }
      else if (t.classList.contains('config-watermark__path')) { changeWatermark(); } // 点击水印文件名 = 更换水印
      else if (t.classList.contains('config-watermark__btn')) {
        var wmV = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
        if (t.dataset.wm === 'open' && wmV) openFileInShell(wmV);
        else if (t.dataset.wm === 'folder' && wmV) call('open_parent', wmV);
      }
    }
    container.removeEventListener('click', container._delegatedClick);
    container._delegatedClick = onContainerClick;
    container.addEventListener('click', container._delegatedClick);
    // 排除字段/路径行右键菜单：移除（硬删除）；（水印栏右键菜单已移除，改由行内按钮承担）
    container.removeEventListener('contextmenu', container._delegatedCtx);
    container._delegatedCtx = function (e) {
      var exRow = e.target.closest('.config-exclude-row');
      var pRow = e.target.closest('.config-path-row');
      if (!exRow && !pRow) return;
      e.preventDefault();
      if (exRow) {
        showMenu(e.clientX, e.clientY, [{
          label: '移除',
          action: function () {
            exRow.remove();
            updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
          }
        }]);
      } else {
        showMenu(e.clientX, e.clientY, [
          {
            label: '在上一行新增路径',
            action: function () { insertPathRow(pRow, 'before'); }
          },
          {
            label: '在下一行新增路径',
            action: function () { insertPathRow(pRow, 'after'); }
          },
          {
            label: '移除',
            action: function () {
              pRow.remove();
              updatePathCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
            }
          }
        ]);
      }
    };
    container.addEventListener('contextmenu', container._delegatedCtx);
    var exInput = $('inputExclude');
    if (exInput) { var exKey = function (e) { if (e.key === 'Enter') { e.preventDefault(); addExcludeField(); } }; exInput.addEventListener('keydown', exKey); }
    pathList.addEventListener('dragstart', function (e) {
      var h = e.target.closest('.config-path-row__drag');
      if (!h) return;
      var row = h.closest('.config-path-row');
      if (!row) return;
      dragged = row; row.classList.add('config-path-row--dragging'); e.dataTransfer.effectAllowed = 'move';
    });
    pathList.addEventListener('dragend', function () { if (dragged) dragged.classList.remove('config-path-row--dragging'); dragged = null; pathList.querySelectorAll('.config-path-row').forEach(function (r) { r.classList.remove('config-path-row--over'); }); });
    pathList.addEventListener('dragover', function (e) {
      var row = e.target.closest('.config-path-row');
      if (!row || row === dragged) return;
      e.preventDefault();
      pathList.querySelectorAll('.config-path-row').forEach(function (r) { r.classList.remove('config-path-row--over'); });
      row.classList.add('config-path-row--over');
    });
    pathList.addEventListener('drop', function (e) {
      var row = e.target.closest('.config-path-row');
      if (!row || !dragged || row === dragged) return;
      e.preventDefault();
      var children = Array.from(pathList.children);
      var from = children.indexOf(dragged), to = children.indexOf(row);
      if (from < to) pathList.insertBefore(dragged, row.nextSibling); else pathList.insertBefore(dragged, row);
      reindexPathRows(); runPrecheck(); refreshPreviewIfModified(); dragged.dataset.moved = '1'; refreshConfigModified();
    });
    function onContainerChange(e) {
      if (e.target.classList && (e.target.classList.contains('config-path-row__input') || e.target.classList.contains('config-path-row__check'))) { runPrecheck(); refreshPreviewIfModified(); }
    }
    container.removeEventListener('change', container._delegatedChange);
    container._delegatedChange = onContainerChange;
    container.addEventListener('change', container._delegatedChange);
  }
  function reindexPathRows() { $('pathList').querySelectorAll('.config-path-row').forEach(function (r, i) { r.dataset.index = i; }); }
  function updatePathCount() { var n = $('pathList').querySelectorAll('.config-path-row').length; var col = document.querySelector('.config-editor__col--paths .config-editor__col-count'); if (col) col.textContent = n; }
  function updateExcludeCount() { var n = $('excludeList').querySelectorAll('.config-exclude-row').length; var col = document.querySelector('.config-editor__col--exclude .config-editor__col-count'); if (col) col.textContent = n; }
  function addExcludeRow(ex) {
    var list = $('excludeList');
    var existing = [];
    list.querySelectorAll('.config-exclude-row__path').forEach(function (sp) { existing.push(sp.textContent.trim()); });
    if (existing.indexOf(ex) >= 0) return false;
    var row = document.createElement('div');
    row.className = 'config-exclude-row';
    row.innerHTML = '<span class="config-exclude-row__path" title="' + escapeHtml(ex) + '">' + escapeHtml(ex) + '</span><button class="config-exclude-row__remove" title="移除排除字段">' + icon('x', 12) + '</button>';
    list.appendChild(row);
    return true;
  }
  function addExcludeField() {
    var input = $('inputExclude');
    if (!input) return;
    var v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (addExcludeRow(v)) { input.value = ''; updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); }
  }
  function pathRowHtml(value) {
    var v = value == null ? '' : String(value);
    return '<span class="config-path-row__drag" draggable="true" title="按住拖动排序">' + icon('grip-vertical', 14) + '</span><label class="config-path-row__checkbox" title="勾选 = 不轮询（添加 = 前缀）"><input type="checkbox" class="config-path-row__check"><span class="config-path-row__check-mark"></span></label><input type="text" class="config-path-row__input" value="' + escapeHtml(v) + '" title="' + escapeHtml(v) + '"><span class="config-path-row__precheck"><span class="config-path-row__badge precheck--pending">检测中…</span></span><button class="config-path-row__browse" title="修改路径">' + icon('pencil', 14) + '</button><button class="config-path-row__open" title="打开文件夹">' + icon('folder-open', 14) + '</button><button class="config-path-row__remove" title="移除路径">' + icon('x', 14) + '</button>';
  }
  function addPathRow(path) {
    var p = String(path == null ? '' : path).trim();
    if (!p) return;
    var idx = $('pathList').querySelectorAll('.config-path-row').length;
    var row = document.createElement('div');
    row.className = 'config-path-row'; row.dataset.index = idx;
    row.innerHTML = pathRowHtml(p);
    $('pathList').appendChild(row);
    updatePathCount(); runPrecheck(); refreshPreviewIfModified();
  }
  // 在指定行之上/之下插入空白路径行（新增路径待填写），并聚焦新行输入框
  function insertPathRow(refRow, pos) {
    var row = document.createElement('div');
    row.className = 'config-path-row';
    row.innerHTML = pathRowHtml('');
    var list = $('pathList');
    if (pos === 'before') list.insertBefore(row, refRow);
    else if (refRow.nextSibling) list.insertBefore(row, refRow.nextSibling);
    else list.appendChild(row);
    reindexPathRows(); updatePathCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
    var inp = row.querySelector('.config-path-row__input');
    if (inp) { inp.focus(); inp.select(); }
  }
  function addPathField() {
    call('pick_paths').then(function (paths) {
      (paths || []).forEach(function (p) { addPathRow(p); });
    }).catch(function (e) { setStatus('添加路径失败：' + e.message); });
  }
  // 水印归属警告开关（红字 + 水印上半区浅红底一并控制，下半配置名框不受影响）
  // missing=true 时文案为「水印不存在」（文件缺失），否则为「水印错误」（归属不一致）
  function setWatermarkError(on, missing) {
    var flag = $('watermarkFlagError');
    if (flag) {
      flag.style.display = on ? '' : 'none';
      if (on) flag.textContent = missing ? '水印不存在' : '水印错误';
    }
    var sec = document.querySelector('.config-editor__col--watermark .config-editor__wm-section');
    if (sec) sec.classList.toggle('is-watermark-error', !!on);
  }
  // 水印归属判定（可传路径；不传则读当前配置），token 防竞态：仅应用最新一次判定结果
  var _wmCheckToken = 0;
  function assertWatermark(wm) {
    var w = (wm !== undefined) ? wm : (state.configData ? (state.configData.watermark || '') : '');
    if (!state.activeProject || !w) { state.watermarkMissing = false; setWatermarkError(false); applyPrecheckValidity(); return; }
    var token = ++_wmCheckToken;
    call('check_watermark_project', state.activeProject, w).then(function (res) {
      if (token !== _wmCheckToken) return;
      // 水印文件缺失：阻断启动；归属不一致：仅红字提示不阻断
      var badFlag = !!(res && res.inProject === false);
      var missingFlag = !!(res && res.fileMissing);
      state.watermarkMissing = missingFlag;
      setWatermarkError(badFlag, missingFlag);
      applyPrecheckValidity();
    }).catch(function () { if (token === _wmCheckToken) { state.watermarkMissing = false; setWatermarkError(false); applyPrecheckValidity(); } });
  }
  function changeWatermark() {
      // 选择框默认定位到上一个水印所在位置，便于就近选新水印
      var prev = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
      call('pick_watermark', prev).then(function (p) {
        if (!p) return;
        state.configData.watermark = p;
        // 更换后立刻用新水印重新判定：项目内移除警告，仍出界则保留
        assertWatermark(p);
        // 局部更新水印区内容（点击更换按钮后整体重绘行结构）
        var wc = document.querySelector('.config-editor__col--watermark .config-editor__watermark-content');
        if (wc) { wc.innerHTML = wmRowHtml(p); }
        refreshPreviewIfModified();
        refreshConfigModified();
      });
    }
  // 归属确认：当前水印命中其他项目主流时，弹窗让用户选择保存到的目标项目；未命中/取消 → 留在当前项目
  function resolveDestProject() {
    var wmV = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
    if (!wmV || !state.activeProject) return Promise.resolve(state.activeProject);
    return call('find_watermark_project', state.activeProject, wmV).then(function (r) {
      r = r || {};
      var hits = (r.hits || []).filter(function (h) { return h !== state.activeProject; });
      if (!hits.length) return state.activeProject; // 无其他项目命中：现状
      // 行式选择：每行左侧提示"保存到 XX 项目：<项目名>"，右侧统一「保存」按钮
      var rows = [{ hint: '保存到原始项目：' + state.activeProject, value: state.activeProject }];
      hits.forEach(function (h) { rows.push({ hint: '保存到新项目：' + h, value: h }); });
      var message = hits.length === 1
        ? '当前水印与项目「' + hits[0] + '」的主流水印一致。\n保存的内容将归属到哪个项目？'
        : '该水印在多个项目中均为主流水印，请选择归属项目：';
      return showSaveDestDialog({ title: '水印归属提示', message: message, rows: rows }).then(function (v) { return v == null ? null : v; });
    }).catch(function () { return state.activeProject; });
  }
  // 另存到其他项目：目标项目已有同名配置 → 覆盖其最新版本；无 → 保存为当日配置（原文件保留）
  function saveAsToProject(dest, ed) {
    var nm = ($('inputConfigName') ? $('inputConfigName').value.trim() : '') || state.activeTxt;
    return call('list_versions', dest, nm).then(function (vs) {
      if (vs && vs.length) {
        return call('save_config', vs[0].path, ed.folders, ed.excludes, ed.watermark).then(function (r) {
          return { ok: !!(r && r.ok), path: vs[0].path };
        });
      }
      return call('save_config_today', dest, nm, nm, ed.folders, ed.excludes, ed.watermark).then(function (r) {
        return { ok: !!(r && r.ok), path: r.path };
      });
    });
  }
  function saveConfig(noConfirm) {
    if (!state.configData) return Promise.resolve(false);
    var ed = getEditorState();
    var path = state.configData.path;
    return resolveDestProject().then(function (dest) {
      if (dest === null) { setStatus('已取消保存'); return false; }
      if (dest !== state.activeProject) {
        // 另存到其他项目：原文件保留
        return saveAsToProject(dest, ed).then(function (r) {
          if (r.ok) { toast('已另存到项目「' + dest + '」', 'ok'); refreshData(); return true; }
          setStatus('保存失败：' + ((r && r.error) || '未知错误')); return false;
        }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
      }
      var go = function () {
        return call('save_config', path, ed.folders, ed.excludes, ed.watermark).then(function (r) {
          if (r && r.ok) {
            toast('已保存：' + path, 'ok'); refreshData();
            document.querySelectorAll('.config-exclude-row[data-deleted="1"]').forEach(function (rr) { rr.remove(); });
            document.querySelectorAll('.config-path-row[data-deleted="1"]').forEach(function (rr) { rr.remove(); });
            state._configOrigSnapshot = configSnapshot(); refreshConfigModified();
            return true;
          }
          setStatus('保存失败：' + ((r && r.error) || '未知错误')); return false;
        }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
      };
      // noConfirm（切换/关闭前确认弹窗场景）：已确认过，跳过「确认覆盖」二次弹窗
      if (noConfirm) return go();
      return confirmPopover({ title: '确认覆盖', message: '将覆盖原文件：\n' + path, okLabel: '确认覆盖', danger: true }).then(function (ok) {
        if (!ok) { setStatus('已取消保存'); return false; }
        return go();
      });
    }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
  }
  function saveConfigToday() {
    if (!state.activeProject || !state.activeTxt) return Promise.resolve(false);
    var ed = getEditorState();
    var configName = $('inputConfigName').value.trim() || state.activeTxt;
    return resolveDestProject().then(function (dest) {
      if (dest === null) { setStatus('已取消保存'); return false; }
      return call('save_config_today', dest, state.activeTxt, configName, ed.folders, ed.excludes, ed.watermark).then(function (r) {
        if (r && r.ok) { toast('已保存为当日配置', 'ok'); jumpToVersionPath(r.path, dest); return true; }
        setStatus('保存失败：' + ((r && r.error) || '未知错误')); return false;
      }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
    }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
  }
  function normalizePath(p) { return String(p || '').replace(/[\\/]+/g, '\\').toLowerCase(); }
  function jumpToVersionPath(targetPath, proj) {
    var targetKey = normalizePath(targetPath);
    var name = String(targetPath).replace(/[\\/]+/g, '\\').split('\\').pop().replace(/\.txt$/i, '');
    var pr = proj || state.activeProject;
    if (!pr || !name) return;
    call('list_projects').then(function (projects) {
      state.projects = projects || []; state.activeTxt = name; state.activeProject = pr; buildSidebar(false, true);
      return call('list_versions', pr, name);
    }).then(function (versions) {
      state.versions = versions || [];
      var t = null;
      for (var i = 0; i < state.versions.length; i++) { if (normalizePath(state.versions[i].path) === targetKey) { t = state.versions[i]; break; } }
      state.activeVersion = t || (state.versions.length ? state.versions[0] : null);
      if (pruneEmptyTxt(pr, name, state.versions)) return;
      syncTxtCount(pr, name, state.versions);
      state.expandedProject = pr; buildDateBranches(); buildSidebar(false, true);
      if (state.activeVersion) loadConfig(state.activeVersion.path); else { state.configData = null; buildCenterBottom(); buildRightPanel(); }
    }).catch(function (e) { setStatus('刷新版本失败：' + e.message); });
  }
  // 任务列表「定位至配置/日志」：主窗口打开并定位到对应配置/日志分支（版本 -1/-2 按实际文件精确匹配）
  function handleLocateRequest(info) {
    info = info || {};
    var ml = $('modeLog'), mf = $('modeFilelist');
    if (info.target === 'log') {
      if (!info.logPath) { setStatus('该任务暂无日志可定位'); return; }
      if (!info.txtPath) {
        // 复刻：源即日志、无配置 TXT → 切到主窗口复刻项目并定位当日日志分支（而非打开资源管理器）
        if (info.replicaMode) {
          state._locateLogPath = info.logPath;
          selectTxt(REPLICA_PROJECT, info.replicaMode);
          return;
        }
        openFileInShell(info.logPath);
        return;
      }
      state._locateLogPath = info.logPath;
      state.activeLogPath = null; state.activeLogDate = null;
      state.mode = 'log';
      if (ml) ml.classList.add('mode-toggle--active');
      if (mf) mf.classList.remove('mode-toggle--active');
      jumpToVersionPath(info.txtPath, info.project || state.activeProject);
      return;
    }
    // 定位至配置：切回配置模式并选中该配置（含匹配的版本分支）
    if (!info.txtPath) { setStatus('该任务无对应配置'); return; }
    state._locateLogPath = null;
    state.activeLogPath = null; state.activeLogDate = null;
    state.mode = 'filelist';
    if (ml) ml.classList.remove('mode-toggle--active');
    if (mf) mf.classList.add('mode-toggle--active');
    jumpToVersionPath(info.txtPath, info.project || state.activeProject);
  }
  // 侧栏「新增配置」：在当前选定项目下新建空白配置（今日目录），完成后定位并打开
  function createNewConfig() {
    var pr = state.expandedProject || state.activeProject;
    if (!pr) { setStatus('请先在项目列表中选择要新增配置的项目'); return; }
    call('new_empty_config', pr).then(function (r) {
      if (!(r && r.ok)) { setStatus('新增配置失败：' + ((r && r.error) || '未知错误')); return; }
      toast('已新增空白配置', 'ok');
      jumpToVersionPath(r.path, pr);
    }).catch(function (e) { setStatus('新增配置失败：' + e.message); });
  }
  // 提交前检查：列出会导致失败/质量风险的问题项（不阻断，确认后可入队）
  function preflightIssues() {
    var out = [];
    if (state.precheckInvalid) {
      var bad = [];
      document.querySelectorAll('.config-path-row').forEach(function (row) {
        if (row.dataset.deleted === '1') return;
        if (!row.classList.contains('config-path-row--invalid')) return;
        var inp = row.querySelector('.config-path-row__input');
        var v = inp ? String(inp.value || '').trim() : '';
        if (v) bad.push(v);
      });
      out.push('存在不合格路径' + (bad.length ? '：' + bad.slice(0, 3).join('、') + (bad.length > 3 ? ' 等 ' + bad.length + ' 条' : '') : '（预检测未通过或未完成）'));
    }
    if (state.watermarkMissing) out.push('水印文件不存在（遮罩叠加会失败）');
    return out;
  }
  // 提交后队列提示：前面还有几个任务（任务入队即快照配置，改配置不影响已排队任务）
  function notifyQueuePos() {
    call('list_tasks').then(function (list) {
      var n = (list || []).filter(function (x) { return x.status === 'queued' || x.status === 'running'; }).length;
      if (n > 1) toast('已加入队列（前方还有 ' + (n - 1) + ' 个任务）', 'ok');
    }).catch(function () {});
  }
  function runScript() {
    if (_envBad()) { setStatus('运行组件未就绪'); return; }
    if (!state.activeVersion) return;
    // 成片数：显式填写优先；留空则沿用占位符所示的默认值（预检测视频总数）
    var fcInp = $('inputFilmCount');
    var count = (fcInp.value.trim() || fcInp.placeholder || '').trim();
    if (!count || !/^\d+$/.test(count) || parseInt(count, 10) < 1) { var errEl2 = $('filmCountError'); if (errEl2) errEl2.style.display = ''; fcInp.focus(); return; }
    var errEl = $('filmCountError'); if (errEl) errEl.style.display = 'none';
    if (!state.activeProject || !state.activeTxt) return;
    var ed = getEditorState();
    var configName = $('inputConfigName').value.trim() || state.activeTxt;
    // ★ 提交前软校验：问题列清 → 确认后仍可入队；执行时缺失素材会被跳过并记入失败清单，
    //   不会产出错误成片（引擎逐条校验 + 原子写 + 失败清理）
    var issues = preflightIssues();
    var goAhead = issues.length
      ? showDialog({
          title: '提交前检查',
          message: '发现以下问题，仍要提交吗？\n\n· ' + issues.join('\n· ')
            + '\n\n提交后任务排入队列；执行时缺失或无效的条目会被跳过并记入失败清单。',
          buttons: [{ label: '取消', value: null }, { label: '仍要提交', value: 'go', primary: true }],
        }).then(function (v) { return v === 'go'; })
      : Promise.resolve(true);
    goAhead.then(function (okGo) {
    if (!okGo) { setStatus('已取消提交'); return; }
    getEffectiveGroup().then(function (group) {
      resolveDestProject().then(function (dest) {
        if (dest === null) { setStatus('已取消启动'); return; }
        call('save_config_today', dest, state.activeTxt, configName, ed.folders, ed.excludes, ed.watermark).then(function (saved) {
          if (!saved || !saved.ok) { setStatus('保存失败：' + ((saved && saved.error) || '未知错误')); return; }
          toast('已保存并开始制作', 'ok');
          // 水印归属在选中配置预检测时已判定并提示，此处不再阻断启动
          call('run_batch', saved.path, count, group).then(function (r) {
            if (!(r && r.ok)) { setStatus('启动失败：' + ((r && r.error) || '未知错误')); return; }
            notifyQueuePos();
          });
          jumpToVersionPath(saved.path, dest);
        }).catch(function (e) { setStatus('启动失败：' + e.message); });
      });
    });
    });   // goAhead.then 闭合（提交前确认流程）
  }
  // 实际使用的分组数：输入框显式填写优先；留空则使用项目「默认分组数」
  function getEffectiveGroup() {
    var raw = $('inputGroupCount').value.trim();
    if (/^\d+$/.test(raw)) return Promise.resolve(raw);
    if (!state.activeProject) return Promise.resolve('');
    return call('get_project_watermark', state.activeProject).then(function (r) {
      return (r && r.ok && r.groupEnabled && r.group > 0) ? String(r.group) : '';
    }).catch(function () { return ''; });
  }
  // 展开成片时对其片段列表做一次存在性预检测，不存在的片段标记变红
  function precheckClips(entry) {
    if (entry.getAttribute('data-checked') === '1') return;
    entry.setAttribute('data-checked', '1');
    var paths = [];
    entry.querySelectorAll('.log-entry__clip').forEach(function (c) { var p = c.getAttribute('data-path'); if (p) paths.push(p); });
    if (!paths.length) return;
    call('check_exists', paths).then(function (map) {
      map = map || {};
      entry.querySelectorAll('.log-entry__clip').forEach(function (c) {
        var p = c.getAttribute('data-path');
        if (map[p] === false) {
          c.classList.add('log-entry__clip--missing');
          c.setAttribute('data-exists', '0');
          if (!c.querySelector('.log-entry__clip-missing-hint')) {
            var h = document.createElement('span');
            h.className = 'log-entry__clip-missing-hint';
            h.textContent = '文件不存在';
            c.appendChild(h);
          }
        }
        else c.setAttribute('data-exists', '1');
      });
    }).catch(function () {});
  }
  // 滚动日志成片列表时，右侧同步跳转到第一个可见成片所在行
  function bindLogListScroll(container) {
    var list = container.querySelector('.log-list');
    if (!list) return;
    list.onscroll = function () {
      if (!state.logContent) return;
      var st = list.scrollTop;
      var viewH = list.clientHeight;
      var entries = list.querySelectorAll('.log-entry');
      var found = null;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.offsetTop + e.offsetHeight >= st && e.offsetTop <= st + viewH) { found = e; break; }
      }
      if (found) highlightLogBlock(logRowFor(found.getAttribute('data-video'), found.getAttribute('data-log-path')) || 0, found.getAttribute('data-video'), found.getAttribute('data-log-path'));
    };
  }
  function buildLogList() {
    var container = $('centerBottom');
    container.innerHTML = '<div class="center-empty">' + icon('scroll-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">正在加载日志…</span></div>';
    // 按当前选中的日志分支（精确到日志文件）定位查询目录，切换分支后取对应日志成片
    var probeLog = null;
    if (state.activeProject === REPLICA_PROJECT) {
      // 复刻：聚合全部复刻日志，所属日期在下文按分支日志文件过滤
      probeLog = state.activeVersion.path;
    } else if (state.activeLogPath) probeLog = state.activeLogPath;
    else if (state.activeLogDate) {
      var pf = (state.logFiles || []).find(function (f) { return f.date === state.activeLogDate; });
      if (pf) probeLog = pf.path;
    }
    call('list_logs', state.activeProject, state.activeTxt, probeLog || state.activeVersion.path).then(function (entries) {
      entries = entries || [];
      // 按所选日志分支过滤：精确到日志文件，仅显示属于该分支的成片条目
      if (state.activeLogDate) {
        var fileSet = {};
        if (state.activeLogPath) { fileSet[normalizePath(state.activeLogPath)] = 1; }
        else { (state.logFiles || []).forEach(function (f) { if (f.date === state.activeLogDate) fileSet[normalizePath(f.path)] = 1; }); }
        entries = entries.filter(function (en) { return fileSet[normalizePath(en.log_path)]; });
      }
      var q = state.logSearchQuery.trim().toLowerCase();
      if (q) entries = entries.filter(function (en) { return (en.video || '').toLowerCase().indexOf(q) >= 0; });
      if (entries.length === 0) {
        container.innerHTML = '<div class="center-empty">' + icon('scroll-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">' + (q ? '未找到匹配 "' + escapeHtml(state.logSearchQuery) + '" 的成片' : '暂无日志数据') + '</span></div>';
        return;
      }
      var sel = !!state.selectMode;
      var curSel = state.selectedLogPaths || {};
      var html = '<div class="log-list' + (sel ? ' log-list--selecting' : '') + '">';
      entries.forEach(function (entry) {
        var clips = entry.clips || [];
        var lp = entry.log_path || '';
        var checked = sel && curSel[normalizePath(lp)];
        html += '<div class="log-entry' + (checked ? ' log-entry--selected' : '') + '" data-log-path="' + escapeHtml(lp) + '" data-video="' + escapeHtml(entry.video || '') + '">';
        html += '<div class="log-entry__header">';
        if (sel) html += '<label class="opt-check log-entry__check-wrap"><input type="checkbox" class="log-entry__check"' + (checked ? ' checked' : '') + ' title="选择该成片进行批量复刻"><span class="opt-check__box"></span></label>';
        html += '<span class="log-entry__arrow">' + icon('chevron-right', 14) + '</span>' + icon('video', 14);
        html += '<span class="log-entry__video-name" title="' + escapeHtml(entry.video) + '">' + escapeHtml(entry.video || '（未命名成片）') + '</span>';
        html += '<span class="log-entry__clip-count">' + clips.length + ' 片段</span>';
        html += '<button class="log-entry__replica" title="用该日志发起复刻">' + icon('repeat', 13) + '复刻</button>';
        html += '</div>';
        html += '<div class="log-entry__clips" style="display:none">';
        clips.forEach(function (clip) { html += '<div class="log-entry__clip" data-path="' + escapeHtml(clip) + '">' + icon('video', 12) + '<span class="log-entry__clip-path" title="' + escapeHtml(clip) + '">' + escapeHtml(clip) + '</span></div>'; });
        html += '</div></div>';
      });
      html += '</div>';
      container.innerHTML = html;
      bindLogListScroll(container);
      // 搜索跳转定位：列表可能被异步再次渲染覆盖展开，窗口期内反复维持展开（幂等），窗口结束才消费焦点
      (function retryFocus(cont, tries) {
        highlightFocus(cont);
        if (tries > 1) setTimeout(function () { retryFocus(cont, tries - 1); }, 300);
        else state.focusVideo = null;
      })(container, 8);
    }).catch(function (e) { container.innerHTML = '<div class="center-empty">' + icon('search-x', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">加载日志失败：' + escapeHtml(e.message) + '</span></div>'; });
    container.oncontextmenu = function (e) {
      var clip = e.target.closest('.log-entry__clip');
      if (clip) {
        e.preventDefault();
        var p = clip.getAttribute('data-path');
        if (!p) return;
        var missing = clip.getAttribute('data-exists') === '0';
        var items = [
          { label: '打开文件', disableIfMissing: true, title: missing ? '文件不存在' : '', action: function () { openFileInShell(p); } },
          { label: '在文件夹中显示', disableIfMissing: true, title: missing ? '文件不存在' : '', action: function () { openInShell(p); } }
        ];
        if (missing) items.forEach(function (it) { if (it.disableIfMissing) it.disabled = true; });
        showMenu(e.clientX, e.clientY, items);
        return;
      }
      var entryItem = e.target.closest('.log-entry');
      if (entryItem) {
        // 成片级右键：打开成片 / 打开文件夹；优先定位复刻输出目录（右侧复刻产物），无复刻目录退回原日志目录
        e.preventDefault();
        var videoNm = entryItem.getAttribute('data-video') || '';
        var lpItem = entryItem.getAttribute('data-log-path');
        if (!lpItem) { setStatus('无法定位该成片对应的日志文件'); return; }
        var fname = videoNm.trim();
        if (!fname) return;
        if (!/\.mp4$/i.test(fname)) fname += '.mp4';
        var dirItem = String(lpItem).replace(/[\\/]+/g, '\\').replace(/\\[^\\]*$/, '');
        var clipFile = dirItem + '\\' + fname;
        var smenu = function (missingFile, rep) {
          var openFile = (rep && rep.replicaFile) || clipFile;
          var openDir = (rep && rep.replicaDir) || dirItem;
          var items2 = [
            { label: '打开成片', disableIfMissing: true, action: function () { openFileInShell(openFile); } },
            { label: '打开文件夹', disableIfMissing: true, action: function () { openInShell(openDir); } }
          ];
          if (missingFile) items2.forEach(function (it) { if (it.disableIfMissing) it.disabled = true; it.title = '成片文件不存在'; });
          showMenu(e.clientX, e.clientY, items2);
        };
        call('find_replica_output', lpItem, videoNm).then(function (rep) {
          rep = rep || {};
          var openFile = rep.replicaFile || clipFile;
          call('check_exists', [openFile]).then(function (map) {
            map = map || {};
            smenu(map[openFile] === false, rep);
          }).catch(function () { smenu(false, rep); });
        }).catch(function () { smenu(false, null); });
      }
    };
    container.onclick = function (e) {
      var rep = e.target.closest('.log-entry__replica');
      if (rep) {
        e.stopPropagation();
        if (_envBad()) { setStatus('运行组件未就绪'); return; }
        var entry = rep.closest('.log-entry');
        var logPath = entry.getAttribute('data-log-path');
        if (!logPath) { setStatus('无法定位该成片对应的日志文件'); return; }
        var entryVideo = entry.getAttribute('data-video') || '';
        replicaModeDialog().then(function (sel) {
          if (!sel) { setStatus('已取消复刻'); return; }
          // 仅复刻该单个成片（传入成片名，脚本精确处理该成片）
          call('run_replica', logPath, sel.mode, entryVideo, sel.opts).then(function (r) { setStatus(r && r.ok ? '已启动该成片的复刻任务' : '启动失败：' + ((r && r.error) || '')); });
        });
        return;
      }
      // 选择模式下点击成片行用于勾选/取消，不做展开
      if (state.selectMode) {
        var sEl = e.target.closest('.log-entry');
        if (sEl) {
          e.stopPropagation();
          if (e.target && e.target.closest && e.target.closest('.log-entry__check-wrap')) return; // 复选事件单独处理
          toggleLogSelect(sEl);
        }
        return;
      }
      var header = e.target.closest('.log-entry__header');
      if (header) {
        var entry = header.closest('.log-entry');
        var clips = entry.querySelector('.log-entry__clips');
        var arrow = entry.querySelector('.log-entry__arrow');
        if (clips.style.display === 'none') { clips.style.display = 'block'; if (arrow) arrow.style.transform = 'rotate(90deg)'; precheckClips(entry); }
        else { clips.style.display = 'none'; if (arrow) arrow.style.transform = 'rotate(0deg)'; }
        jumpLogRightByVideo(entry.getAttribute('data-video'), entry.getAttribute('data-log-path'));
        return;
      }
    };
    container.addEventListener('change', function (e) {
      var cb = e.target.closest('.log-entry__check-wrap');
      if (!cb) return;
      var entry = cb.closest('.log-entry');
      if (entry) toggleLogSelect(entry, cb.checked);
    });
    applyEnvDisabled(); // 新渲染的成片行复刻按钮应用环境拦截
  }
  // 全局成片名搜索：渲染受限高度的下拉列表，点击跳转到目标日期分支并高亮成片
  function closeLogDropdown() {
    var d = $('logDropdown');
    if (d) {
      if (typeof d.__outside === 'function') document.removeEventListener('mousedown', d.__outside);
      if (typeof d.__esc === 'function') document.removeEventListener('keydown', d.__esc);
      d.remove();
    }
  }
  // ── 项目列表配置搜索下拉框（与日志搜索同款交互：弹出匹配项，点击直达配置） ──
  function closeProjDropdown() {
    var d = $('projDropdown');
    if (d) {
      if (typeof d.__outside === 'function') document.removeEventListener('mousedown', d.__outside);
      if (typeof d.__esc === 'function') document.removeEventListener('keydown', d.__esc);
      d.remove();
    }
  }
  function renderProjDropdown(items, q) {
    closeProjDropdown();
    var input = $('searchInput');
    if (!input) return;
    var rect = input.getBoundingClientRect();
    var d = document.createElement('div');
    d.id = 'projDropdown'; d.className = 'search-dropdown';
    if (!items || items.length === 0) {
      d.innerHTML = '<div class="search-dropdown__empty">未找到包含「' + escapeHtml(q) + '」的配置</div>';
    } else {
      var html = '';
      items.slice(0, 200).forEach(function (r) {
        html += '<div class="search-dropdown__item" data-project="' + escapeHtml(r.project) + '" data-name="' + escapeHtml(r.name) + '">';
        html += '<div class="search-dropdown__title">' + escapeHtml(r.name) + '</div>';
        html += '<div class="search-dropdown__meta">' + escapeHtml(r.project) + (r.latest ? ' / ' + escapeHtml(r.latest) : '') + '</div>';
        html += '</div>';
      });
      d.innerHTML = html;
    }
    document.body.appendChild(d);
    d.style.left = rect.left + 'px';
    d.style.top = (rect.bottom + 4) + 'px';
    d.style.width = Math.max(260, Math.min(rect.width, 420)) + 'px';
    d.querySelectorAll('.search-dropdown__item').forEach(function (it) {
      it.addEventListener('click', function () {
        var proj = it.getAttribute('data-project');
        var name = it.getAttribute('data-name');
        closeProjDropdown();
        // 清空搜索并展开/选中目标配置
        state.searchQuery = '';
        var inp = $('searchInput'); if (inp) inp.value = '';
        selectTxt(proj, name);
      });
    });
    setTimeout(function () {
      var outside = function (e) { if (!d.contains(e.target)) closeProjDropdown(); };
      var esc = function (e) { if (e.key === 'Escape') closeProjDropdown(); };
      d.__outside = outside; d.__esc = esc;
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', esc);
    }, 0);
  }
  function onProjectSearchInput() {
    if (maskOn()) return;
    var input = $('searchInput');
    var q = input ? input.value.trim() : '';
    if (!q) {
      closeProjDropdown();
      state.searchQuery = ''; buildSidebar();
      return;
    }
    state.searchQuery = q;
    buildSidebar();
    // 本地遍历项目树收集匹配配置（复刻虚拟项目除外），点击下拉项直达配置
    var items = [];
    var k = q.toLowerCase();
    sortedProjects().forEach(function (proj) {
      if (proj.name === REPLICA_PROJECT) return;
      (proj.txts || []).forEach(function (txt) {
        var hits = String(txt.name || '').toLowerCase().indexOf(k) >= 0;
        if (!hits) return;
        if (items.length >= 200) return;
        items.push({ project: proj.name, name: txt.name, latest: txt.latest || '' });
      });
    });
    renderProjDropdown(items, q);
  }
  function renderLogDropdown(items, q) {
    closeLogDropdown();
    var input = $('logSearchInput');
    if (!input) return;
    var rect = input.getBoundingClientRect();
    var d = document.createElement('div');
    d.id = 'logDropdown'; d.className = 'search-dropdown';
    if (!items || items.length === 0) {
      d.innerHTML = '<div class="search-dropdown__empty">未找到包含「' + escapeHtml(q) + '」的成片日志</div>';
    } else {
      var html = '';
      items.slice(0, 200).forEach(function (r) {
        html += '<div class="search-dropdown__item" data-txt="' + escapeHtml(r.txtPath) + '" data-project="' + escapeHtml(r.project) + '" data-video="' + escapeHtml(r.video) + '" data-log="' + escapeHtml(r.logPath || '') + '">';
        html += '<div class="search-dropdown__title">' + escapeHtml(r.video) + '</div>';
        html += '<div class="search-dropdown__meta">' + escapeHtml(r.project) + ' / ' + escapeHtml(r.txtName) + ' / ' + escapeHtml(r.label) + '</div>';
        html += '</div>';
      });
      d.innerHTML = html;
    }
    document.body.appendChild(d);
    d.style.left = rect.left + 'px';
    d.style.top = (rect.bottom + 4) + 'px';
    d.style.width = Math.max(320, Math.min(rect.width + 120, 520)) + 'px';
    d.querySelectorAll('.search-dropdown__item').forEach(function (it) {
      it.addEventListener('click', function () {
        var txt = it.getAttribute('data-txt');
        var proj = it.getAttribute('data-project');
        var video = it.getAttribute('data-video');
        var log = it.getAttribute('data-log') || '';
        closeLogDropdown();
        focusSearchResult(txt, proj, video, log);
      });
    });
    setTimeout(function () {
      var outside = function (e) { if (!d.contains(e.target)) closeLogDropdown(); };
      var esc = function (e) { if (e.key === 'Escape') closeLogDropdown(); };
      d.__outside = outside; d.__esc = esc;
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', esc);
    }, 0);
  }
  // 批量模式成片搜索绑定（可重复调用：遮罩模式 clone 输入框后由 exit 强制重绑）
  function bindBatchLogSearch(force) {
    var input = $('logSearchInput');
    if (!input) return;
    if (!force && input.dataset.boundBatch === '1') return;
    input.dataset.boundBatch = '1';
    input.addEventListener('input', function () {
      state.logSearchQuery = this.value.trim();
      if (state.mode === 'log') buildCenterBottom();
      onLogSearchInput();
    });
  }
  function onLogSearchInput() {
    var input = $('logSearchInput');
    var q = input ? input.value.trim() : '';
    if (state._searchTimer) { clearTimeout(state._searchTimer); state._searchTimer = null; }
    if (!q) { closeLogDropdown(); state.logSearchQuery = ''; if (state.mode === 'log') buildCenterBottom(); return; }
    state._searchTimer = setTimeout(function () {
      call('search_logs', q).then(function (items) {
        items = items || [];
        renderLogDropdown(items, q);
      }).catch(function () { closeLogDropdown(); });
    }, 300);
  }
  // 批量模式成片搜索：命中项点击后跳转并精确钉在目标日志文件（logPath），
  // 避免 buildLogDateBranches 回退/残留选中其他日期分支（如最新日期）导致定错位
  function focusSearchResult(txtPath, project, video, logPath) {
    state.focusVideo = video;
    state.activeProject = project;
    state.mode = 'log';
    $('modeLog').classList.add('mode-toggle--active');
    $('modeFilelist').classList.remove('mode-toggle--active');
    state.logSearchQuery = '';
    var input = $('logSearchInput');
    if (input) input.value = video;
    state._locateLogPath = logPath || null; // 与任务列表「定位至日志」同一机制：按实际文件精确匹配
    state.activeLogPath = null;
    state.activeLogDate = null;
    jumpToVersionPath(txtPath);
  }
  function highlightFocus(container) {
    var fv = state.focusVideo;
    if (fv == null || !container) return false;
    var fvBase = String(fv).replace(/\.[^.]+$/, '');
    var el = null;
    // 匹配忽略扩展名：搜索结果与日志条目可能一个带 .mp4 一个不带
    container.querySelectorAll('.log-entry').forEach(function (e) {
      if (el) return;
      var v = String(e.getAttribute('data-video') || '').replace(/\.[^.]+$/, '');
      if (v === fvBase) el = e;
    });
    // 未找到目标（异步渲染未就绪）：保留焦点，由调用方在窗口期重试
    if (!el) return false;
    // 搜索跳转定位：默认展开目标日志行（片段列表），再滚动居中与高亮
    var clips = el.querySelector('.log-entry__clips');
    if (clips && clips.style.display === 'none') {
      clips.style.display = 'block';
      var arrow = el.querySelector('.log-entry__arrow');
      if (arrow) arrow.style.transform = 'rotate(90deg)';
      el.classList.add('log-entry--open');
      precheckClips(el);
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    jumpLogRightByVideo(el.dataset.video, el.getAttribute('data-log-path'));
    return true;
  }
  function buildModifiedLines() {
    var ed = getEditorState();
    var out = [];
    ed.folders.forEach(function (f) { var p = (f && f.path) ? f.path.trim() : ''; if (!p) return; out.push(f.nonround ? '=' + p : p); });
    ed.excludes.forEach(function (e) { var s = (e || '').trim(); if (s) out.push('-' + s); });
    if (ed.watermark && ed.watermark.trim()) { out.push(''); out.push(ed.watermark.trim()); }
    return out;
  }
  // 右侧预览栏模式切换按钮组：配置模式显示「实时/原始」，日志模式显示「简化/原始」，与当前模式同步
  function syncRightToggle() {
    var isLog = state.mode === 'log';
    ['btnPreviewModified', 'btnPreviewRaw'].forEach(function (id) { var el = $(id); if (el) { el.style.display = isLog ? 'none' : ''; el.classList.toggle('preview-toggle--active', id === 'btnPreviewModified' ? !!state.rightPreview : !state.rightPreview); } });
    ['btnLogSimple', 'btnLogRaw'].forEach(function (id) { var el = $(id); if (el) { el.style.display = isLog ? '' : 'none'; el.classList.toggle('preview-toggle--active', id === 'btnLogSimple' ? state.logViewMode === 'simple' : state.logViewMode === 'raw'); } });
  }
  // 退出日志模式时恢复预览面板折叠（仅当进入日志前本就折叠）
  function restorePreviewFromLog() {
    if (!state._sideBeforeLog) return;
    state._sideBeforeLog = false;
    var rp1 = $('rightPanel');
    if (rp1) state.previewLastWidth = rp1.clientWidth || state.previewLastWidth;
    document.body.setAttribute('data-preview-collapsed', '');
    state.previewCollapsed = true;
    var rb1 = $('previewCollapseRound'); if (rb1) rb1.setAttribute('title', '展开预览面板');
  }
  // 强制折叠右侧预览面板（点击品牌名片复位时使用，回到启动态）
  function collapsePreviewPanel() {
    var rp = $('rightPanel');
    if (rp) state.previewLastWidth = rp.clientWidth || state.previewLastWidth;
    document.body.setAttribute('data-preview-collapsed', '');
    state.previewCollapsed = true;
    state._sideBeforeLog = false;
    var rb = $('previewCollapseRound'); if (rb) rb.setAttribute('title', '展开预览面板');
  }
  function buildRightPanel() {
    if (maskOn()) return; // 遮罩模式：批量右侧预览渲染拒绝
    var lineNumbers = $('rightLineNumbers');
    var code = $('rightCode');
    var subtitle = $('rightPanelSubtitle');
    if (!lineNumbers || !code || !subtitle) return; // 容器缺失时安全忽略（遮罩切换窗口期）
    syncRightToggle();
    // 进入日志模式自动展开右侧预览面板；退出日志模式恢复到进入前状态
    if (state.mode === 'log') {
      if (document.body.hasAttribute('data-preview-collapsed')) {
        state._sideBeforeLog = true;
        var rp0 = $('rightPanel');
        document.body.removeAttribute('data-preview-collapsed');
        if (rp0) { rp0.style.display = ''; rp0.style.width = Math.max(240, state.previewLastWidth || 320) + 'px'; }
        state.previewCollapsed = false;
        var rb0 = $('previewCollapseRound'); if (rb0) rb0.setAttribute('title', '折叠预览面板');
      }
    } else if (state._sideBeforeLog) {
      restorePreviewFromLog();
    }
    if (!state.activeTxt || !state.activeVersion) { lineNumbers.innerHTML = ''; code.innerHTML = ''; subtitle.textContent = '请选择一个日期分支'; return; }
    if (state.mode === 'log') { buildLogRightPanel(); return; }
    if (!state.configData) { lineNumbers.innerHTML = ''; code.innerHTML = ''; subtitle.textContent = '请选择一个日期分支'; return; }
    var lines = state.rightPreview ? buildModifiedLines() : (state.configData.lines || []);
    subtitle.textContent = (state.rightPreview ? '实时' : '原始') + ':"' + relToProject(state.activeVersion.path) + '"';
    subtitle.title = subtitle.textContent;
    var numHtml = ''; var codeHtml = '';
    lines.forEach(function (line, idx) {
      numHtml += '<span class="right-panel__line-num">' + (idx + 1) + '</span>';
      var cls = 'right-panel__code-line';
      var t = line == null ? '' : line;
      if (t === '') cls += ' code-line--empty';
      else if (/^=+$/.test(t.trim())) cls += ' code-line--separator';
      else if (t.charAt(0) === '=') cls += ' code-line--no-round';
      else if (t.charAt(0) === '-') cls += ' code-line--exclude';
      else if (t.trim().toLowerCase().endsWith('.png')) cls += ' code-line--watermark';
      else cls += ' code-line--path';
      codeHtml += '<span class="' + cls + '">' + escapeHtml(t === '' ? ' ' : t) + '</span>';
    });
    lineNumbers.innerHTML = numHtml; code.innerHTML = codeHtml;
  }
  // 日志模式：右侧显示当前配置目录下所有日志 txt 的内容，并支持定位到成片所在行
  function buildLogRightPanel() {
    if (maskOn()) return;
    var subtitle = $('rightPanelSubtitle');
    if (state.logContent) { renderLogRightPanel(); return; }
    subtitle.textContent = '正在加载日志…';
    call('get_log_content', state.activeVersion.path, state.activeTxt).then(function (d) {
      state.logContent = d; renderLogRightPanel();
    }).catch(function () {
      cleanLogRight(); subtitle.textContent = '加载日志失败 — ' + state.activeTxt + ' / ' + state.activeVersion.label;
    });
  }
  function cleanLogRight() {
    var nums = $('rightLineNumbers'); var code = $('rightCode');
    if (nums) nums.innerHTML = ''; if (code) code.innerHTML = '';
  }
  function renderLogRightPanel() {
    if (maskOn()) return;
    var nums = $('rightLineNumbers'); var code = $('rightCode'); var subtitle = $('rightPanelSubtitle');
    var d = state.logContent; var files = (d && d.files) || [];
    syncRightToggle();
    var simple = state.logViewMode === 'simple';
    if (nums) nums.style.display = simple ? 'none' : ''; // 简化模式不显示行号
    var content = $('rightPanelContent');
    if (content) content.classList.toggle('log-simple', simple); // 简化模式：成片块间分隔
    var logPath = state.activeLogPath || (files[0] && files[0].path) || state.activeVersion.path;
    subtitle.textContent = '日志:"' + relToProject(logPath) + '"';
    subtitle.title = subtitle.textContent;
    if (files.length === 0) { nums.innerHTML = ''; code.innerHTML = '<div style="padding:8px 12px;color:var(--text-tertiary)">暂无日志文件</div>'; return; }
    var numHtml = ''; var codeHtml = ''; var row = 0;
    var inBlock = false; // 简化模式：当前是否处于成片块容器内
    files.forEach(function (f) {
      f.lines.forEach(function (line, li) {
        row++;
        numHtml += '<span class="right-panel__line-num" data-row="' + row + '">' + row + '</span>';
        var t = line == null ? '' : line;
        var tt = String(t).trim();
        // 简化模式：去掉原始 txt 自带的分割线行（==== / ---- 等）
        if (state.logViewMode === 'simple' && /^[\-=_—\.\*]{2,}$/.test(tt)) return;
        var cls = 'right-panel__code-line';
        // 成片名行："使用片段列表："的上一行（该行下方紧跟"使用片段列表："）
        var isVideoHeader = li + 1 < f.lines.length && f.lines[li + 1] != null && String(f.lines[li + 1]).trim() === '使用片段列表：';
        if (state.logViewMode === 'simple' && /[\\/]/.test(tt)) t = tt.split(/[\\/]+/).pop(); // 简化模式：路径仅保留最后一段文件名（带后缀）
        if (state.logViewMode === 'simple' && isVideoHeader) {
          if (inBlock) codeHtml += '</div>'; // 闭合上一个成片块
          codeHtml += '<div class="log-block" data-start="' + row + '">';
          inBlock = true;
        }
        if (isVideoHeader) cls += ' code-line--log-video';
        else if (tt === '') cls += ' code-line--empty';
        else cls += ' code-line--path';
        codeHtml += '<span class="' + cls + '" data-row="' + row + '">' + escapeHtml(t === '' ? ' ' : t) + '</span>';
      });
    });
    if (inBlock) codeHtml += '</div>';
    nums.innerHTML = numHtml; code.innerHTML = codeHtml;
    if (state._pendingLogJump) { var p = state._pendingLogJump; state._pendingLogJump = null; jumpLogRightByVideo(p.video, p.logPath); }
  }
  function logRowFor(video, logPath) {
    if (!state.logContent) return null;
    var entries = state.logContent.entries || [];
    for (var i = 0; i < entries.length; i++) { var en = entries[i]; if (en.video === video && logPath && (en.logPath === logPath || normalizePath(en.logPath) === normalizePath(logPath))) return en.lineStart; }
    for (var j = 0; j < entries.length; j++) { if (entries[j].video === video) return entries[j].lineStart; }
    return null;
  }
  function jumpLogRightByVideo(video, logPath) {
    if (state.mode !== 'log' || !state.activeTxt || !state.activeVersion) return;
    if (!state.logContent) { state._pendingLogJump = { video: video, logPath: logPath }; return; }
    var line = logRowFor(video, logPath);
    if (line) highlightLogBlock(line, video, logPath);
  }
  // 高亮整个成片块（成片名行 → 块内末尾水印 png 行）：跳过分隔线/空行，仅高亮行号列
  function highlightLogBlock(line, video, logPath) {
    var d = state.logContent;
    if (!d) return;
    var entries = d.entries || [];
    var files = d.files || [];
    var l = Number(line);
    if (!l || l < 1) return;
    var idx = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].video === video && (entries[i].logPath === logPath || normalizePath(entries[i].logPath) === normalizePath(logPath))) { idx = i; break; }
    }
    if (idx < 0) { for (var j = 0; j < entries.length; j++) { if (entries[j].video === video) { idx = j; break; } } }
    var startRow = l - 1; // 成片名行
    var endRow = idx >= 0 && entries[idx + 1] ? Number(entries[idx + 1].lineStart) - 2 : null;
    // 行号 → 行内容（不含后端行尾截断误差）
    function rowText(r) {
      var acc = 1;
      for (var k = 0; k < files.length; k++) {
        if (r >= acc && r < acc + files[k].lines.length) return files[k].lines[r - acc] == null ? '' : String(files[k].lines[r - acc]);
        acc += files[k].lines.length;
      }
      return '';
    }
    // 最后一个成片块无 next：以所属文件末行为终点
    if (endRow == null) {
      var run = 1;
      for (var fi = 0; fi < files.length; fi++) {
        if (l >= run && l < run + files[fi].lines.length) { endRow = run + files[fi].lines.length - 1; break; }
        run += files[fi].lines.length;
      }
    }
    if (!endRow || endRow < startRow) endRow = startRow;
    // 排除分割线行（纯分隔符行）；空行保持高亮，使成片块在两个分隔线之间完整覆盖
    var skip = {};
    for (var r2 = startRow; r2 <= endRow; r2++) {
      var t2 = rowText(r2).trim();
      if (t2 !== '' && /^[\-=_—\.\*]{2,}$/.test(t2)) skip[r2] = true;
    }
    scrollLogRightTo(startRow, endRow, skip);
  }
  function scrollLogRightTo(line, endLine, skipRows) {
    var content = $('rightPanelContent');
    if (!content) return;
    var n = Number(line);
    if (!n || n < 1) return;
    var end = Number(endLine);
    if (!end || end < n) end = n;
    content.querySelectorAll('.right-panel__line-num.log-target, .right-panel__code-line.log-target, .log-block--active').forEach(function (el) { el.classList.remove('log-target', 'log-block--active'); });
    if (state.logViewMode === 'simple') {
      // 简化模式：以成片块为高亮单元（圆角金边浅蓝方块）
      content.querySelectorAll('.log-block').forEach(function (blk) {
        var s = Number(blk.getAttribute('data-start'));
        var sp = blk.querySelectorAll('.right-panel__code-line');
        var en = sp.length ? Number(sp[sp.length - 1].getAttribute('data-row')) : s;
        if (s <= end && en >= n) blk.classList.add('log-block--active');
      });
    } else {
      var skip = skipRows || {};
      for (var r = n; r <= end; r++) {
        if (skip[r]) continue;
        var num = content.querySelector('.right-panel__line-num[data-row="' + r + '"]');
        if (num) num.classList.add('log-target'); // 原始模式：仅高亮行号列
      }
    }
    // 高亮块提至首行：按 DOM 实际位置滚动到预览顶部（行高估算会因简化模式成片块的
    // 内边距/间距随前置块数量累计漂移，导致高亮块逐渐下移）
    var lineEl = content.querySelector('.right-panel__code-line[data-row="' + n + '"]');
    if (lineEl) {
      var rEl = lineEl.getBoundingClientRect();
      var rC = content.getBoundingClientRect();
      content.scrollTop = Math.max(0, rEl.top - rC.top + content.scrollTop - 8);
    } else {
      var lineHeight = 18;
      var targetTop = 8 + (n - 1) * lineHeight;
      content.scrollTop = Math.max(0, targetTop - 8);
    }
  }
  function setStatus(msg) { var el = $('statusLeft'); if (!el) return; el.classList.remove('status-bar__success'); el.textContent = msg; }

  // 「打开文件夹 / 在文件夹中显示」统一入口：失败 toast；浏览器端由本体代开（explorer 可能被前台锁压到后台，
  // 只在任务栏出现）→ 成功后提示去任务栏查看。全项目所有打开目录调用都走这里，文案与行为一致。
  // 打开「路径 / 文件夹 / 所在位置」类操作：后端按目标类型分流 ——
  // 传目录则打开该目录（进入），传文件则打开其所在文件夹并选中该文件（定位）
  function openInShell(p) {
    return call('open_folder_select', p).then(function (r) {
      if (r && r.ok === false) { toast('打开失败：' + (r.error || '路径不存在'), true); return; }
      if (location.protocol.indexOf('http') === 0) toast('资源管理器已在后台打开，可从任务栏查看', 'info');
    }).catch(function (e) { toast('打开失败：' + e.message, true); });
  }
  // 用系统默认程序打开文件（用于「打开文件 / 打开成片 / 打开片段 / 打开日志」）——
  // 与 openInShell 的定位语义区分开：⚠ 两者都调 open_folder_select 会让「打开文件」实际只是定位
  function openFileInShell(p) {
    return call('open_path', p).then(function (r) {
      if (r && r.ok === false) { toast('打开失败：' + (r.error || '文件不存在'), true); return; }
      if (location.protocol.indexOf('http') === 0) toast('已用默认程序打开（若未显示请查看任务栏）', 'info');
    }).catch(function (e) { toast('打开失败：' + e.message, true); });
  }
  function setStatusDone(msg) { var el = $('statusLeft'); if (!el) return; el.classList.add('status-bar__success'); el.textContent = msg; }

  // 载入遮罩：工作路径扫描时提示用户
  // 已取消前台遮罩：所有「扫描 / 检测」类等待改为底部状态栏提示，
  // 界面保持可交互 —— 遮罩若带 backdrop-filter 模糊，会给人"窗口冻结一会儿"的观感。
  function showBusy(text) { setStatus(text || '请稍候…'); }
  function hideBusy() { setStatus(''); }
  // 设置窗口开/关时的主窗口模糊遮罩
  function showSettingsDim() { var o = $('settingsDim'); if (o) { hideBusy(); o.style.display = 'block'; } }
  function hideSettingsDim() { var o = $('settingsDim'); if (o) o.style.display = 'none'; }
  // 带进度条的等待窗口：重置预检测全量检测期间使用；提供「缩到后台」入口
  // 预检测一律后台进行：前台遮罩（带模糊背景）会在切换窗口时造成肉眼可见卡顿，
  // 而预检测不需要用户做任何选择，故不显示遮罩，
  // 直接进入状态栏右下角的 probe-mini 进度显示（内含取消按钮）。
  function showBusyProgress() {
    state.precheckBackground = true;
    hideBusy();
    showProbeMini();
  }
  // 预检测后台化：遮罩「缩到后台」后，进度转入状态栏右侧 probe-mini（排版配色参考更新条）
  function hideProbeMini() {
    state.precheckBackground = false;
    var el = $('probeMini'); if (el) el.style.display = 'none';
    var fl = $('probeMiniFill'); if (fl) fl.style.width = '0%';
  }
  function showProbeMini() {
    var el = $('probeMini'); if (!el) return;
    var lb = $('probeMiniLabel'); if (lb) lb.textContent = '预检测 0/0';
    var fl = $('probeMiniFill'); if (fl) fl.style.width = '0%';
    el.style.display = '';
  }
  function updateProbeMini(s) {
    var el = $('probeMini'); if (!el) return;
    var total = (s && s.total) || 0, done = (s && s.done) || 0;
    var pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    if (s && s.finished) {
      // 本次进度从未在本窗口展示过（如别处窗口发起、本窗口只是收到广播）→ 不打扰状态栏
      if (el.style.display === 'none') return;
      hideProbeMini();
      setStatus(s.cancelled ? '后台预检测已取消（已保存 ' + done + ' 个探测结果）' : '后台预检测完成：共检测 ' + total + ' 个视频');
      return;
    }
    // 进度可能来自别的窗口（设置页「维护-重建 / 刷新预缓存」）—— 收到就主动显示，
    // ⚠ 否则本窗口的迷你进度条一直隐藏，用户看不到任何进度。
    if (el.style.display === 'none') showProbeMini();
    var lb = $('probeMiniLabel'); if (lb) lb.textContent = '预检测 ' + done + '/' + total;
    var fl = $('probeMiniFill'); if (fl) fl.style.width = pct + '%';
  }
  function onResetProgress(s) {
    if (!s) return;
    // 预检测一律后台：进度只写状态栏右侧的 probe-mini（前台遮罩已取消）
    updateProbeMini(s);
  }
  // 仅刷新预缓存：不删缓存、不重置，只对缺失/变化的视频增量更新（进度与取消/缩后台同「重置预检测」）
  function refreshPrecacheFlow() {
    var dismiss = null;
    var api = getApi();
    if (api && typeof api.on_reset_progress === 'function') {
      try { dismiss = api.on_reset_progress(onResetProgress); } catch (e) { dismiss = null; }
    }
    var cleanup = function () { state._probeActive = false; if (dismiss) { try { dismiss(); } catch (e) {} dismiss = null; } };
    state._probeActive = true;
    state.precheckBackground = false;
    showBusyProgress('正在刷新预缓存（增量更新，不重置）…');
    // 返回 Promise：供调用方（如表头刷新按钮）在流程收敛后恢复自身状态
    return call('refresh_precache').then(function (r) {
      if (state.precheckBackground) hideProbeMini(); else hideBusy();
      cleanup();
      // 环境不可用时后端直接拦下（无 total/updated）—— 别显示成「更新了 0 个」
      if (r && r.ok === false) { setStatus(String(r.error || '刷新预缓存失败'), false); return; }
      setStatus('预缓存已刷新：本次更新 ' + ((r && r.updated) || 0) + ' 个视频，共 ' + ((r && r.total) || 0) + ' 个视频' + ((r && r.cancelled) ? '（已中断，失效缓存稍后后台清理）' : '，失效缓存已后台清理'));
      if (state.activeTxt && state.activeVersion) runPrecheck();
    }).catch(function (e) {
      hideBusy();
      cleanup();
      hideProbeMini();
      setStatus('刷新预缓存失败：' + e.message);
    });
  }
  // 刷新配置列表：先扫描与成片正本内容一致的重复外部 * 配置（确认后删除），再刷新列表
  function refreshConfigsFlow() {
    // 刷新会重拉列表并重载当前配置：未保存修改先弹窗确认
    checkConfigModifiedBeforeLeave(function () {
    showBusy('正在扫描重复配置…');
    call('clean_duplicate_star', false).then(function (r) {
      hideBusy();
      var pending = (r && r.pending) ? r.pending : [];
      if (!pending.length) {
        setStatus('重新检测中…');
        refreshData(true, '正在重新扫描工作路径…', function () { setStatusDone('重新检测完成'); }, true);
        return;
      }
      confirmPopover({
        title: '发现重复配置',
        message: '发现 ' + pending.length + ' 个与正本内容一致的外部 * 配置（历史遗留副本），删除不影响正本与其他日期分支',
        okLabel: '删除并刷新',
        danger: true
      }).then(function (v) {
        if (!v) { setStatus('已取消清理，仅刷新列表'); refreshData(true, '正在重新扫描工作路径…', function () { setStatusDone('重新检测完成'); }, true); return; }
        showBusy('正在清理重复配置…');
        call('clean_duplicate_star', true).then(function (r2) {
          hideBusy();
          toast('已删除 ' + ((r2 && r2.deleted) ? r2.deleted.length : 0) + ' 个重复配置', 'ok');
          refreshData(true, '正在重新扫描工作路径…', function () { setStatusDone('重新检测完成'); }, true);
        }).catch(function (e) { hideBusy(); setStatus('清理失败：' + e.message); refreshData(true); });
      });
    }).catch(function (e) { hideBusy(); setStatus('扫描失败：' + e.message); refreshData(true); });
    });
  }

  // ── 皮肤切换 ──
  // 皮肤列表按下拉名拼音升序：浅色 < 深色
  var SKINS = [
    { id: 'white_blue', label: '浅色', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '深色', bg: '#111113', theme: '#FF6600' },
    { id: 'Maid_Atelier', label: '深海女仆', bg: '#0e1d49', theme: '#c5a468' }
  ];
  function applySkin(id, persist) {
    var target = SKINS.some(function (s) { return s.id === id; }) ? id : SKINS[0].id;
    document.documentElement.setAttribute('data-skin', target);
    // 缓存到 localStorage：内嵌的设置/引导页在**渲染前**同步读取并应用，
    // 避免"先按默认皮肤画一帧、再被异步结果改回来"的闪烁（内嵌页与主窗口同源，共享该缓存）
    try { localStorage.setItem('vl_skin', target); } catch (e) {}
    // 皮肤行为层热切换：先 dispose 上一皮肤装饰，再 apply 当前皮肤行为（若有）
    if (window.VL_SkinRuntime) window.VL_SkinRuntime.sync(target);
    if (persist) call('set_skin', target);
    return target;
  }
  function initSkin() {
    call('get_skin').then(function (id) { applySkin(id, false); }).catch(function () { applySkin(SKINS[0].id, false); });
    // 设置页修改主题后，主界面即时跟随
    if (window.txapi && window.txapi.on_settings_saved) {
      window.txapi.on_settings_saved(function (cfg) { if (cfg && typeof cfg === 'object') applySkin(cfg.skin, false); checkEnv(); });
    }
    // 设置窗口打开/关闭时显示/隐藏主窗口模糊遮罩
    if (window.txapi && window.txapi.on_settings_window_opened) window.txapi.on_settings_window_opened(showSettingsDim);
    if (window.txapi && window.txapi.on_settings_window_closed) window.txapi.on_settings_window_closed(hideSettingsDim);
    // 内嵌设置面板的关闭交互：点击面板外空白处 或 按 Esc ——
    // 统一走主进程 close_settings_panel，再由 settings_window_closed 广播收尾，
    // 保证主进程"设置是否打开"的状态与界面一致（托盘/快捷键都依赖它）
    // 引导面板（首次设置，工作路径缺失时）：同为内嵌 iframe
    if (window.txapi && window.txapi.on_guide_window_opened) window.txapi.on_guide_window_opened(function () { var g = $('guideDim'); if (g) g.style.display = 'block'; });
    if (window.txapi && window.txapi.on_guide_window_closed) window.txapi.on_guide_window_closed(function () { var g = $('guideDim'); if (g) g.style.display = 'none'; });
    // 内嵌 iframe（设置页 / 引导页）内请求关闭：统一走主进程 close_embed_panel，
    // 由主进程按当前打开的面板分派，并广播 closed 事件收尾
    window.addEventListener('message', function (e) {
      var t = e && e.data && e.data.type;
      if (t === 'vl-close-guide' && window.txapi && window.txapi.close_embed_panel) window.txapi.close_embed_panel();
    });
    var dimEl = $('settingsDim');
    if (dimEl) dimEl.addEventListener('mousedown', function (e) {
      if (e.target !== dimEl) return;   // 点在 iframe 面板上不关闭
      if (window.txapi && window.txapi.close_settings_panel) window.txapi.close_settings_panel();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var d = $('settingsDim');
      if (!d || d.style.display === 'none') return;
      if (window.txapi && window.txapi.close_settings_panel) window.txapi.close_settings_panel();
    });
  }

  // 扫描/重建环节 → 中文提示（后端 listProjects/索引重建按环节上报，前端一一对应显示）
  var SCAN_PHASE_TEXT = {
    clear: '清空缓存', walk: '扫描配置', log: '收集日志', list: '汇总项目',
    clip: '重建成片索引', mark: '统计水印归属', done: '检测完成'
  };
  function refreshData(force, busyText, done, skipReflow) {
    // 扫描 / 检测不再弹前台遮罩：该流程不需要用户做任何选择，
    // 而遮罩带 backdrop-filter 模糊，会让人感觉窗口"冻结一会儿"。
    // 改为只在底部状态栏显示当前环节，界面其余部分保持可交互。
    var dismissScan = null;
    if (busyText) {
      setStatus(busyText);
      var api0 = getApi();
      if (api0 && typeof api0.on_scan_progress === 'function') {
        try {
          dismissScan = api0.on_scan_progress(function (p) {
            var label = (p && SCAN_PHASE_TEXT[p.phase]) ? SCAN_PHASE_TEXT[p.phase] : '';
            if (!label) return;
            if (p.phase === 'clip' && p.total > 0) label += ' ' + p.done + '/' + p.total;
            setStatus(busyText + '（' + label + '）');
          });
        } catch (e) { dismissScan = null; }
      }
    }
    call('list_projects', force).then(function (projects) {
      state.projects = projects || []; buildSidebar(false, true);
      // 刷新后始终校验当前选中配置是否仍存在：已删/迁移则清空重建视图，仍存在则重拉版本重建日期分支
      if (state.activeProject && state.activeTxt) {
        var foundProj = state.projects.find(function (p) { return p.name === state.activeProject; });
        var foundTxt = foundProj && foundProj.txts.find(function (t) { return t.name === state.activeTxt; });
        if (!foundTxt) { state.activeProject = null; state.activeTxt = null; state.versions = []; state.activeVersion = null; state.configData = null; buildDateBranches(); buildCenterBottom(); buildRightPanel(); setStatus('就绪'); }
        else selectTxt(state.activeProject, state.activeTxt, true, true);
      }
      if (busyText) setStatus('就绪');
      if (dismissScan) { try { dismissScan(); } catch (e) {} dismissScan = null; }
      if (done) done();
    }).catch(function (e) { setStatus('数据加载失败：' + e.message); if (dismissScan) { try { dismissScan(); } catch (e) {} dismissScan = null; } });
  }
  function selectTxt(project, name, keepVersion, silent) {
    function doSelect() {
      state.activeLogDate = null;
      // 本次是否为"已选中后再次切换"（决定重建配置页时是否静止，参考徽章 --static）
      var switchingTxt = !!state.activeTxt;
      // 复刻虚拟项目：仅含日志无配置，点击直接进入日志视图
      if (project === REPLICA_PROJECT) {
        state.activeProject = project; state.activeTxt = name;
        state.versions = [{ label: '全部日志', path: REPLICA_MARK + name, is_latest: true }];
        state.activeVersion = state.versions[0];
        state.activeLogDate = null; state.activeLogPath = null; state.logFiles = [];
        state.configData = null; state.logContent = null;
        state.mode = 'log';
        var ml = $('modeLog'), mf = $('modeFilelist');
        if (ml) ml.classList.add('mode-toggle--active');
        if (mf) mf.classList.remove('mode-toggle--active');
        state.expandedProject = project;
        buildSidebar(false, true);
        // 点击配置＝用户交互：重建动画中则动画结束再判定，无动画直接判定
        var azB2 = $('azIndexBar');
        if (azB2 && azB2.classList.contains('az-bar--enter')) _azPending = true;
        else syncAzHighlight();
        buildDateBranches(); buildCenterBottom(); buildRightPanel();
        setStatus('日志模式：' + name);
        return;
      }
      var prevLabel = keepVersion && state.activeVersion ? state.activeVersion.label : null;
      // 点击左侧配置名：即使当前在日志模式也切回配置模式，并跳转该配置最新日期分支
      state.selectMode = false; state.selectedLogPaths = {};
      state.mode = 'filelist';
      var mlT = $('modeLog'), mfT = $('modeFilelist');
      if (mfT) mfT.classList.add('mode-toggle--active');
      if (mlT) mlT.classList.remove('mode-toggle--active');
      state.activeProject = project; state.activeTxt = name;
      // 跳转后自动展开目标配置所在项目（与 jumpToVersionPath 行为一致），树中可见并高亮，避免跳转后侧栏无选中项
      state.expandedProject = project;
      call('list_versions', project, name).then(function (versions) {
        state.versions = versions || []; state.activeVersion = null;
        if (state.versions.length > 0) { var target = prevLabel ? state.versions.find(function (v) { return v.label === prevLabel; }) : null; state.activeVersion = target || state.versions[0]; }
        if (pruneEmptyTxt(project, name, state.versions)) return;
        syncTxtCount(project, name, state.versions);
        buildSidebar(false, true);
        // 点击配置＝用户交互：重建动画中则动画结束再判定，无动画直接判定
        var azB3 = $('azIndexBar');
        if (azB3 && azB3.classList.contains('az-bar--enter')) _azPending = true;
        else syncAzHighlight();
        buildDateBranches(switchingTxt);
        if (state.activeVersion) loadConfig(state.activeVersion.path, switchingTxt);
        else { state.configData = null; buildCenterBottom(); buildRightPanel(); setStatus('该配置无可用版本'); }
      }).catch(function (e) { setStatus('加载版本失败：' + e.message); });
    }
    // 用户主动切换配置：配置未保存时先弹窗确认（覆盖当前配置 / 保存为当日配置 / 取消）
    if (silent) { doSelect(); return; }
    checkConfigModifiedBeforeLeave(doSelect);
  }
  // 用最新版本列表同步侧栏该配置徽章：计数 + 最新日期（日期分支实时刷新时徽章跟随）
  function syncTxtCount(project, name, versions) {
    var p = (state.projects || []).find(function (x) { return x.name === project; });
    if (!p) return;
    var t = p.txts.find(function (x) { return x.name === name; });
    if (!t) return;
    var vs = versions || [];
    t.count = vs.length;
    t.latest = vs.length ? String(vs[0].label || '') : '';
  }
  // 配置全部版本已删除/迁移：从侧栏移除该配置项，避免遗留"0 版本"空壳；若为当前选中配置则一并复位视图
  function pruneEmptyTxt(project, name, versions) {
    if ((versions || []).length > 0) return false;
    var p = (state.projects || []).find(function (x) { return x.name === project; });
    if (p) {
      var i = p.txts.findIndex(function (x) { return x.name === name; });
      if (i >= 0) p.txts.splice(i, 1);
    }
    buildSidebar(false, true);
    if (state.activeProject === project && state.activeTxt === name) {
      resetCenterToLaunch();
      setStatus('该配置已无可用版本，已从列表移除');
    }
    return true;
  }
  // ── 配置未保存离开（切换配置、切换项目、复位视图）检查：脏配置弹窗提示 ──
  // 回调在确认动作后执行；右上角 ✕ / 遮罩关闭视为取消（中止原动作、返回编辑页面）；
  // 三个按钮行为与配置栏同名按钮一致，「不保存」直接丢弃修改继续原动作。
  function checkConfigModifiedBeforeLeave(afterConfirm, onCancel) {
    // 日志模式为只读浏览：退出日志（折叠项目/品牌名片/复位视图）不弹未保存拦截，
    // 配置编辑状态仍保留在内存，切回配置模式后未保存标记照常显示、可继续保存
    if (state.mode === 'log') { afterConfirm(); return; }
    if (!state.configModified || !state.configData) { afterConfirm(); return; }
    showDialog({
      title: '配置已修改未保存',
      message: '当前配置已发生修改，丢失修改将无法恢复。',
      buttons: [
        { label: '不保存', value: 'discard', cls: 'modal-btn--cfg-discard' },
        { label: '覆盖当前配置', value: 'overwrite', cls: 'modal-btn--cfg-save' },
        { label: '保存为当日配置', value: 'today', cls: 'modal-btn--cfg-save-today' }
      ],
      // 宽弹窗保证按钮文字不换行
      cssClass: 'modal-card--wide'
    }).then(function (choice) {
      // ✕ / 遮罩关闭 = 取消：中止原动作，返回编辑页面
      if (choice == null) { if (onCancel) onCancel(); return; }
      // 不保存：丢弃修改，继续原动作
      if (choice === 'discard') { afterConfirm(); return; }
      // 复用配置栏同名按钮逻辑：覆盖当前配置（已确认，跳过覆盖确认二次弹窗）/ 保存为当日配置
      var go = choice === 'overwrite' ? function () { return saveConfig(true); } : (choice === 'today' ? saveConfigToday : null);
      if (!go) { afterConfirm(); return; }
      go().then(function (ok) {
        if (ok) afterConfirm();
        else if (onCancel) onCancel();
      });
    });
  }
  // 主进程关闭/退出前询问"配置是否有未保存修改"：无修改立即放行；有修改弹三按钮，处理后再回传
  function handleDiscardConfigRequest() {
    var respond = function (action) { var ap = getApi(); if (ap && ap.respond_discard_config) ap.respond_discard_config(action); };
    if (!state.configModified || !state.configData) { respond('ok'); return; }
    checkConfigModifiedBeforeLeave(function () { respond('ok'); }, function () { respond('cancel'); });
  }
  // ── 配置自愈统一入口：静默重取当前选中配置，保持日期分支/徽章/侧栏与磁盘一致 ──
  // 触发源：① 主进程广播 versions_changed（软件内保存/清理配置，后端已清缓存，重取即最新）
  //         ② 定时轮询（外部删除/任务迁移等改盘动作，靠 listVersions 目录指纹自动失效重扫）
  // 归一比较无变化时不重渲染，避免打断编辑与日志跟随；有变化才同步视图。
  function refreshActiveVersions() {
    if (!getApi()) return;
    if (maskState.on) return; // 遮罩叠加模式：暂停批量配置自愈轮询，避免重画侧栏/中心区覆盖遮罩界面
    if (!state.activeProject || !state.activeTxt || state.activeProject === REPLICA_PROJECT) return; // 复刻为虚拟项目，不走配置自愈
    call('list_projects', false).then(function (projects) {
      state.projects = projects || [];
      var foundProj = state.projects.find(function (p) { return p.name === state.activeProject; });
      var foundTxt = foundProj && foundProj.txts.find(function (t) { return t.name === state.activeTxt; });
      if (!foundTxt) { // 当前配置已被整体删除/迁移：即时复位视图，无需等手动刷新
        state.activeProject = null; state.activeTxt = null;
        resetCenterToLaunch();
        return;
      }
      var keepLabel = state.activeVersion ? state.activeVersion.label : null;
      call('list_versions', state.activeProject, state.activeTxt).then(function (versions) {
        var vs = versions || [];
        var cur = state.versions || [];
        var same = vs.length === cur.length && vs.every(function (v, i) {
          var c = cur[i];
          return c && v.label === c.label && v.path === c.path && !!v.hasLog === !!c.hasLog;
        });
        if (same) return;
        state.versions = vs; state.activeVersion = null;
        if (vs.length > 0) {
          var target = keepLabel ? vs.find(function (v) { return v.label === keepLabel; }) : null;
          state.activeVersion = target || vs[0];
        }
        if (pruneEmptyTxt(state.activeProject, state.activeTxt, vs)) return;
        syncTxtCount(state.activeProject, state.activeTxt, vs);
        buildSidebar(false, true);
        buildDateBranches();
        if (state.activeVersion) {
          // 当前选中版本路径变化（迁移/另存/已被删则回退最新）才重载配置；路径未变保持编辑状态不打断
          if (!state.configData || state.configData.path !== state.activeVersion.path) loadConfig(state.activeVersion.path, true);
        } else { state.configData = null; buildCenterBottom(); buildRightPanel(); setStatus('该配置无可用版本'); }
      }).catch(function () {});
    }).catch(function () {});
  }
  function selectVersion(label) {
    var v = state.versions.find(function (x) { return x.label === label; });
    if (!v) return;
    var switching = !!state.activeVersion;
    // 切换日期分支会重载配置：未保存修改先弹窗确认
    checkConfigModifiedBeforeLeave(function () {
      state.activeVersion = v; buildDateBranches(switching); loadConfig(v.path, true);
    });
  }
  function loadConfig(path, silent) {
    state.logContent = null;
    call('read_config', path).then(function (data) {
      state.configData = data;
      state._configOrig = null; // 新配置加载：重建修改基线
      buildCenterBottom(silent); buildRightPanel();
      setStatus('已选择:"' + (state.activeVersion && state.activeVersion.path || path) + '"');
    }).catch(function (e) {
      var where = (e && e.stack) ? String(e.stack).split('\n')[1] || '' : '';
      setStatus('读取配置失败：' + (e && e.message) + (where ? ' @' + where.trim() : ''));
    });
  }
  // ── 中间配置栏复位到"刚启动"样式 ──
  // 触发点：点击侧栏品牌名片、或选中配置后收回项目名；无选中时调用为无害空操作。
  // 收起当前展开的项目：与点击项目名折叠同款 —— 填充层反向收回、徽章滑出、azbar 收回、
  // 配置区整体淡出；动画结束后重建侧栏（下方项目渐显）。品牌名片复位时使用。
  function collapseExpandedProject() {
    var pname = state.expandedProject;
    if (!pname) return;
    var tree = $('sidebarTree');
    var header = tree && tree.querySelector('.tree-project__name.is-filled');
    state.expandedProject = null;
    var azBar = $('azIndexBar'); if (azBar) azBar.classList.remove('is-show');
    if (!header) return;
    header.classList.remove('is-filled');
    var bdg = header.querySelector('.tree-project__badge');
    if (bdg) {
      bdg.classList.remove('tree-project__badge--static');
      bdg.classList.add('tree-project__badge--leave');
    }
    var wrap = header.parentElement ? header.parentElement.querySelector('.tree-project__items') : null;
    if (wrap) wrap.classList.add('tree-project__items--leaving');
    window.setTimeout(function () { buildSidebar(); }, 200);
  }
  function resetCenterToLaunch() {
    state.activeProject = null; state.activeTxt = null;
    state.versions = []; state.activeVersion = null; state.configData = null;
    state.logContent = null; state.logFiles = []; state.logSearchQuery = '';
    state.activeLogDate = null; state.activeLogPath = null;
    state.selectMode = false; state.selectedLogPaths = {};
    state.mode = 'filelist';
    state._configOrig = null; state._configOrigSnapshot = null;
    state._logBranchToken = null;
    var bar = $('configBar'); if (bar) bar.innerHTML = '';
    var act = $('sidebarTree').querySelector('.tree-txt-item--active');
    if (act) act.classList.remove('tree-txt-item--active');
    // 收回项目/品牌名片视为退出日志模式：进入日志时若折叠，此处恢复折叠
    restorePreviewFromLog();
    buildDateBranches(); buildCenterBottom(); buildRightPanel();
    setStatus('就绪');
  }
  function bindStaticEvents() {
    // 预检测一律后台：只保留状态栏 probe-mini 上的取消按钮（原遮罩按钮已随遮罩移除）
    var probeCancel = $('probeMiniCancel');
    if (probeCancel) probeCancel.addEventListener('click', function () { setStatus('正在取消后台预检测…'); call('cancel_precheck'); });
    document.addEventListener('vl:reset-center', function () {
      if (maskState.on) {
        // 遮罩叠加模式：名片点击退出当前项目选择，回到「请选择项目」初始态（不退出模式）。
        // 不重建中间顶部栏：data-maid-chat-active 移除后 header/装饰的退场入场动画自然播放
        maskResetSession();
        // 不重建侧栏：只摘掉选中态，让填充层 / 缎带走 scaleX(1→0) 反向收回动画 ——
        // 重建会让旧行 DOM 直接销毁，动画根本没机会播放
        var mTree = $('sidebarTree');
        if (mTree) mTree.querySelectorAll('.mask-proj-item--active').forEach(function (el) {
          el.classList.remove('mask-proj-item--active');
        });
        buildMaskCenter(); buildMaskConfigBar();
        setStatus('已返回遮罩叠加项目列表');
        return;
      }
      collapsePreviewPanel();
      // 复位到启动态时一并收起已展开的项目（含收回动画），否则项目列表展开着不动
      checkConfigModifiedBeforeLeave(function () { collapseExpandedProject(); resetCenterToLaunch(); });
    });
    $('sidebarTree').addEventListener('scroll', syncAzHighlight);
    // 右键项目名：打开项目文件夹 / 项目设置（复刻虚拟项目无配置水印，不提供）
    $('sidebarTree').addEventListener('contextmenu', function (e) {
      var ph = e.target.closest('.tree-project__name');
      if (!ph) return;
      var pname = ph.getAttribute('data-project');
      if (!pname || pname === REPLICA_PROJECT) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '打开项目文件夹', action: function () { call('open_project_dir', pname).then(function (r) { if (!(r && r.ok)) setStatus('打开项目失败：' + ((r && r.error) || '未知错误')); }).catch(function (err) { setStatus('打开项目失败：' + err.message); }); } },
        { label: '项目设置', action: function () { openProjectWatermarkDialog(pname); } }
      ]);
    });
    $('sidebarTree').addEventListener('click', function (e) {
      var projectHeader = e.target.closest('.tree-project__name');
      if (projectHeader) {
        var pname = projectHeader.getAttribute('data-project');
        var willExpand = state.expandedProject !== pname;
        var azBar = $('azIndexBar');
        if (!willExpand) {
          // 折叠：项目名反向收回 + azbar 收回；配置区整体从上到下渐隐，重建后仅展开项目下方的项目渐显
          projectHeader.classList.remove('is-filled');
          var bdgFold = projectHeader.querySelector('.tree-project__badge');
          if (bdgFold) {
            // 摘除切换配置时加的 --static（animation:none 特异性高于 --leave 的滑出动画），
            // 让收回时的 az-badge-out 滑出动画正常播放
            bdgFold.classList.remove('tree-project__badge--static');
            bdgFold.classList.add('tree-project__badge--leave');
          }
          if (azBar) azBar.classList.remove('is-show');
          state.expandedProject = null;
          var itemWrap = $('sidebarTree').querySelector('.tree-project__items');
          if (itemWrap) itemWrap.classList.add('tree-project__items--leaving');
          // 收回项目名时若已选中配置：中间配置栏复位到刚启动样式（未保存修改先弹窗确认）
          checkConfigModifiedBeforeLeave(function () {
            if (state.activeTxt) resetCenterToLaunch();
            window.setTimeout(function () {
              buildSidebar();
              var headers = $('sidebarTree').querySelectorAll('.tree-project__name');
              var start = -1;
              for (var h = 0; h < headers.length; h++) {
                if (headers[h].getAttribute('data-project') === pname) { start = h; break; }
              }
              // 仅原展开项目下方的项目渐显（向上衔接收起位移），其余项目保持原样
              for (var g = start + 1; g < headers.length; g++) {
                headers[g].classList.add('az-project-enter');
                headers[g].style.animationDelay = String(Math.min((g - start - 1) * 40, 180)) + 'ms';
              }
            }, 200);
          });
          return;
        }
        // 展开/切换：整个流程（状态变更 + 原项目收回动画 + 重建展开）都放到确认通过之后执行。
        // ⚠ 必须先确认再动：否则状态与收回动画在确认前就跑，点「取消」会看到动画进行一半突然跳回
        //。
        var doExpand = function () {
          state.expandedProject = pname;
          var oldHeader = $('sidebarTree').querySelector('.tree-project__name.is-filled');
          var oldWrap = $('sidebarTree').querySelector('.tree-project__items');
          if (oldHeader) {
            oldHeader.classList.remove('is-filled');
            var bdgOld = oldHeader.querySelector('.tree-project__badge');
            if (bdgOld) {
              // 与折叠分支一致：先摘除 --static 再播 --leave 收回动画
              bdgOld.classList.remove('tree-project__badge--static');
              bdgOld.classList.add('tree-project__badge--leave');
            }
          }
          if (oldWrap) oldWrap.classList.add('tree-project__items--leaving');
          var applyExpand = function () {
            buildSidebar(true); // 项目展开：强制 azbar 扫描动画（即使字母集合相同）
            // 配置区整体淡入（仅在项目展开时触发，切换配置不重播）
            var itemWrap2 = $('sidebarTree').querySelector('.tree-project__items');
            if (itemWrap2) {
              itemWrap2.classList.remove('tree-project__items--enter');
              void itemWrap2.offsetWidth;
              itemWrap2.classList.add('tree-project__items--enter');
            }
            // 点击项目名仅展开列表，不触发高亮判定（高亮由点击配置名/滚动/拖拽触发）
            var newHeader = null;
            var hs = $('sidebarTree').querySelectorAll('.tree-project__name');
            for (var k = 0; k < hs.length; k++) {
              if (hs[k].getAttribute('data-project') === pname) { newHeader = hs[k]; break; }
            }
            if (newHeader) {
              // 一次性动画类驱动填充（remove 后重加即可重新播放），避免过渡触发时序导致部分项目直接变色
              newHeader.classList.add('is-filled');
              if (newHeader.classList.contains('is-filling')) newHeader.classList.remove('is-filling');
              void newHeader.offsetWidth;
              newHeader.classList.add('is-filling');
              window.setTimeout(function () { newHeader.classList.remove('is-filling'); }, 400);
            }
          };
          if (oldHeader || oldWrap) { window.setTimeout(applyExpand, 50); } else { applyExpand(); }
        };
        // 切换项目：先做未保存修改确认（确认前不动状态、不播动画）；确认后再复位中栏并执行展开
        if (state.activeTxt) {
          checkConfigModifiedBeforeLeave(function () {
            if (state.activeTxt) resetCenterToLaunch();
            doExpand();
          });
        } else {
          doExpand();
        }
        return;
      }
      var item = e.target.closest('.tree-txt-item');
      if (item) selectTxt(item.getAttribute('data-project'), item.getAttribute('data-name'), false);
    });
    $('btnSortName').addEventListener('click', function () { if (state.sortMode === 'name') state.sortAsc = !state.sortAsc; else state.sortMode = 'name'; updateSortButtons(); buildSidebar(); });
    $('btnSortTime').addEventListener('click', function () { if (state.sortMode === 'time') state.sortTimeDesc = !state.sortTimeDesc; else state.sortMode = 'time'; updateSortButtons(); buildSidebar(); });
    var btnNewCfg = $('btnNewConfig');
    if (btnNewCfg) btnNewCfg.addEventListener('click', createNewConfig);
    // 日期分支事件委托到 document（不直接绑在 #dateBranches 元素上）：
    // exitMaskMode 的 restoreBatchCenterTop 会重写 centerTop 重建该元素，直接绑定会随重建丢失导致分支“点不动”。
    document.addEventListener('click', function (e) {
      var db = $('dateBranches'); if (!db || !db.contains(e.target)) return;
      var btn = e.target.closest('.date-branch-btn'); if (!btn) return;
      if (btn.getAttribute('data-date') != null) { var switching = state.activeLogPath != null; state.activeLogDate = btn.getAttribute('data-date'); state.activeLogPath = btn.getAttribute('data-file') || null; buildDateBranches(switching); buildCenterBottom(); return; }
      selectVersion(btn.getAttribute('data-label'));
    });
    document.addEventListener('dblclick', function (e) {
      var db = $('dateBranches'); if (!db || !db.contains(e.target)) return;
      var btn = e.target.closest('.date-branch-btn'); if (!btn) return;
      var fp = btn.getAttribute('data-file'); if (fp) { openFileInShell(fp); return; }
      var label = btn.getAttribute('data-label'); var v = state.versions.find(function (x) { return x.label === label; }); if (v) openFileInShell(v.path);
    });
    document.addEventListener('contextmenu', function (e) {
      // 遮罩模式日志日期分支右键：在文件夹中显示（找不到成片置灰）/ 打开日志文件 / 迁移全部成片 / 移除该日志（仅日志或连同成片）
      var mb = $('maskDateBranches');
      if (mb && mb.contains(e.target)) {
        var mbtn = e.target.closest('.date-branch-btn');
        if (!mbtn) return;
        e.preventDefault();
        var mfp = mbtn.getAttribute('data-masklog');
        if (!mfp || !maskOn() || !maskState.project) return;
        openMaskBranchMenu(e.clientX, e.clientY, mfp);
        return;
      }
      var db = $('dateBranches'); if (!db || !db.contains(e.target)) return;
      var btn = e.target.closest('.date-branch-btn');
      if (!btn) return;
      e.preventDefault();
      var fp = btn.getAttribute('data-file');
      var target = '';
      var modeName = '日志';
      if (fp) {
        target = fp;
        modeName = '日志';
        showMenu(e.clientX, e.clientY, [
          { label: '打开文件', action: function () { openFileInShell(fp); } },
          { label: '在文件夹中显示', action: function () { openInShell(fp); } },
          { label: '移除', action: function () { confirmRemoveBranch(target, modeName, false); } }
        ]);
        return;
      }
      var label = btn.getAttribute('data-label');
      var v = state.versions.find(function (x) { return x.label === label; });
      if (!v) return;
      target = v.path;
      modeName = '配置';
      showMenu(e.clientX, e.clientY, [
        { label: '打开文件', action: function () { openFileInShell(v.path); } },
        { label: '在文件夹中显示', action: function () { openInShell(v.path); } },
        { label: '移除', action: function () { confirmRemoveBranch(target, modeName, !!v.isExternal); } }
      ]);
    });
    // 移除日期分支：三选一弹窗（样式同任务清除弹窗）——仅删当前 / 双模式 / 连同成片文件夹
    // 文案按当前分支模式动态显示（配置↔日志）；目录无另一模式 TXT 时禁用双模式按钮
    function confirmRemoveBranch(target, modeName, isExternal) {
      if (!target) return;
      call('branch_other_txt', target).then(function (info) {
        info = info || {};
        openRemoveBranchDialog(target, modeName, !!info.hasOther, !!isExternal);
      }).catch(function () {
        openRemoveBranchDialog(target, modeName, true, !!isExternal);
      });
    }
    function openRemoveBranchDialog(target, modeName, hasOther, isExternal) {
      var otherName = modeName === '日志' ? '配置' : '日志';
      var bothLabel = '移除' + modeName + '/' + otherName;
      var bothDesc = hasOther
        ? '连同该日期下的【' + otherName + '】TXT一并删除（成片保留）'
        : '不可用（该日期下没有对应的【' + otherName + '】TXT）';
      // 外部 * 配置（isExternal）：位于成片文件夹之外，无自成片文件夹，仅能移除该配置 → 直接简化确认
      if (isExternal) {
        confirmPopover({
          title: '移除该' + modeName,
          message: target,
          okLabel: '移除',
          danger: true
        }).then(function (v) { if (v) doRemoveBranch(target, 'txt'); });
        return;
      }
      showDialog({
        title: '移除该' + modeName,
        cssClass: 'modal-card--wide',
        message: target + '\n\n请选择移除方式：\n' +
          '· 仅移除该' + modeName + '：只删除当前【' + modeName + '】文件\n' +
          '· ' + bothLabel + '：' + bothDesc + '\n' +
          '· 连同成片移除：删除整个文件夹（含成片视频）',
        buttons: [
          { label: '仅移除该' + modeName, value: 'txt', primary: true },
          { label: bothLabel, value: 'both', primary: true, disabled: !hasOther, hint: hasOther ? '' : '该日期下没有对应的' + otherName + 'TXT' },
          { label: '连同成片移除', value: 'folder', danger: true }
        ]
      }).then(function (v) {
        if (!v) return;
        if (v === 'folder') {
          var targetDir = String(target).replace(/[\\/][^\\/]*$/, '');
          confirmPopover({
            title: '整体删除',
            message: '将整个文件夹（含成片视频）移入回收站：\n' + targetDir + '\n\n可从回收站还原',
            okLabel: '继续删除',
            danger: true
          }).then(function (ok) { if (ok) doRemoveBranch(target, v); });
        } else doRemoveBranch(target, v);
      });
    }
    function doRemoveBranch(target, scope) {
      call('remove_branch', target, scope).then(function (r) {
        if (!(r && r.ok)) { setStatus('移除失败：' + ((r && r.error) || '未知错误')); return; }
        setStatus('已移除' + (scope === 'folder' ? '日期文件夹' : '分支文件') + '，已移入回收站');
        refreshData();
      }).catch(function (err) { setStatus('移除失败：' + err.message); });
    }
    $('modeFilelist').addEventListener('click', function () {
      if (state.activeLogDate) {
        // 日志 → 配置：按当前选中日志重新定位到对应配置文件版本（正本/序号 或 当日外部 *）
        var f = (state.logFiles || []).find(function (x) { return x.path === state.activeLogPath; }) || (state.logFiles || []).find(function (x) { return x.date === state.activeLogDate; });
        if (f) { var ver = versionForLogFile(f); if (ver) state.activeVersion = ver; }
      }
      state.selectMode = false; state.selectedLogPaths = {}; state.mode = 'filelist'; $('modeFilelist').classList.add('mode-toggle--active'); $('modeLog').classList.remove('mode-toggle--active'); buildDateBranches(); buildCenterBottom(); buildRightPanel();
    });
    $('modeLog').addEventListener('click', function () { state.mode = 'log'; state._fromConfig = true; $('modeLog').classList.add('mode-toggle--active'); $('modeFilelist').classList.remove('mode-toggle--active'); buildDateBranches(); buildCenterBottom(); buildRightPanel(); });
    $('searchInput').addEventListener('input', onProjectSearchInput);
    bindBatchLogSearch(); // 批量模式成片搜索（遮罩模式 clone 输入框后由 exit 强制重绑）
    // ── 左下角菜单按钮：刷新配置列表 / 选择路径 / 重置预检测缓存 / 设置 ──
    var menuBtn = $('sidebarMenuBtn');
    var menu = $('sidebarMenu');
    // ── 跳转至列表顶端按钮：平滑滚动到顶部（不打断展开状态） ──
    var toTopBtn = $('sidebarToTop');
    if (toTopBtn) toTopBtn.addEventListener('click', function () {
      var tree = $('sidebarTree');
      if (!tree) return;
      tree.scrollTo({ top: 0, behavior: 'smooth' });
    });
    if (menuBtn && menu) {
      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var show = menu.style.display === 'none';
        if (show) {
          // 菜单浮到按钮右侧、自下而上展开（fixed 定位，避免被 sidebar 的 overflow:hidden 裁剪）
          var br = menuBtn.getBoundingClientRect();
          menu.style.position = 'fixed';
          menu.style.left = (br.right + 8) + 'px';
          menu.style.margin = '0';
          menu.style.display = '';
          menu.style.visibility = 'hidden'; // 先显示以测量高度，再向上定位防止被底部遮挡
          var h = menu.offsetHeight;
          menu.style.top = Math.max(4, br.bottom - h) + 'px';
          menu.style.visibility = '';
          // 自下而上移动 + 淡入过渡动画（每次打开重新播放）
          menu.classList.remove('sidebar-menu--enter');
          void menu.offsetWidth;
          menu.classList.add('sidebar-menu--enter');
        } else {
          menu.style.display = 'none';
        }
      });
      document.addEventListener('mousedown', function (e) { if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu(); });
      // 侧栏菜单项操作的气泡统一锚到菜单按钮（而非菜单项本身）
      menu.addEventListener('click', function () { setPopAnchor(menuBtn); }, true);
      // 菜单项动作
      $('menuRefreshConfigs').addEventListener('click', function () { closeMenu(); refreshConfigsFlow(); });   // 刷新配置列表（含清理重复外部 *）
      $('menuChoosePath').addEventListener('click', function () { closeMenu(); choosePath(); });
      // 「刷新预缓存」点击弹窗二选一：仅刷新（增量）/ 全部重置（原功能）
      // 「刷新预缓存」：单一动作 = 增量刷新（更新变化/缺失的视频并顺带清理失效缓存）。
      // 全量重建属低频兜底操作，已移至设置页「维护」
      var lmrp = $('menuResetPrecheck');
      if (lmrp) lmrp.addEventListener('click', function () { closeMenu(); refreshPrecacheFlow(); });
      $('menuSettings').addEventListener('click', function () { closeMenu(); call('open_settings_window').catch(function () { setStatus('打开设置窗口失败'); }); });
      var mob = $('menuOpenBrowser');
      if (mob) mob.addEventListener('click', function () {
        closeMenu();
        // 本体 Electron：经主进程打开系统默认浏览器；浏览器侧：新标签打开当前访问地址
        if (location.protocol.startsWith('http')) {
          try { window.open(location.href); setStatus('已在新标签页打开浏览器访问地址'); return; } catch (e) {}
        }
        var api2 = getApi();
        if (api2 && api2.tray_menu_click) api2.tray_menu_click('open_browser').then(function (r) {
          if (r && r.ok === false) setStatus(r.error || '打开浏览器失败');
        }).catch(function (e) { setStatus('打开浏览器失败：' + (e && e.message || e)); });
      });
    }
    $('btnOpenTasks').addEventListener('click', function () { call('open_task_window').catch(function () { setStatus('打开任务窗口失败'); }); });
    // 标题栏「视频处理」入口：独立非模态窗口（与设置窗口不同，可与主窗口并排操作）
    var wtt = $('winToolToggle');
    if (wtt) wtt.addEventListener('click', function () { call('open_tool_window').catch(function () { setStatus('打开视频处理窗口失败'); }); });
    $('btnPreviewRaw').addEventListener('click', function () { state.rightPreview = false; $('btnPreviewRaw').classList.add('preview-toggle--active'); $('btnPreviewModified').classList.remove('preview-toggle--active'); buildRightPanel(); });
    $('btnPreviewModified').addEventListener('click', function () { state.rightPreview = true; $('btnPreviewModified').classList.add('preview-toggle--active'); $('btnPreviewRaw').classList.remove('preview-toggle--active'); buildRightPanel(); });
    $('btnLogSimple').addEventListener('click', function () { state.logViewMode = 'simple'; syncRightToggle(); renderLogRightPanel(); });
    $('btnLogRaw').addEventListener('click', function () { state.logViewMode = 'raw'; syncRightToggle(); renderLogRightPanel(); });
    $('btnExternalEdit').addEventListener('click', function () { if (!state.activeVersion) return flashNeedSelect(); var p = state.activeVersion.path; if (String(p).indexOf(REPLICA_MARK) === 0) { var lf = state.logFiles || []; var cur = null; if (state.activeLogPath) cur = lf.find(function (f) { return f.path === state.activeLogPath; }); if (!cur && state.activeLogDate) cur = lf.find(function (f) { return f.date === state.activeLogDate; }); if (!cur && lf.length) cur = lf[lf.length - 1]; if (cur) p = cur.path; } call('external_edit', p); });
    var rz = $('sidebarResizeBtn');
    var sidebarEl = document.querySelector('.sidebar');
    if (rz && sidebarEl) {
      // 拖拽调宽交互只绑在按钮本体上；铆钉栏不可见、无功能（仅定位锚定）
      rz.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var startX = e.clientX, startW = sidebarEl.clientWidth;
        function onMove(ev) { var w = Math.max(285, Math.min(520, startW + (ev.clientX - startX))); sidebarEl.style.width = w + 'px'; }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    }
    var rp = $('rightPanel');
    var resizerBar = $('previewResizer');
    var roundBtn = $('previewCollapseRound');
    if (rp && resizerBar) {
      // 右侧预览面板展开/折叠：默认折叠（body 标记 data-preview-collapsed，面板整体隐藏）
      if (state.previewCollapsed) document.body.setAttribute('data-preview-collapsed', '');
      // 折叠/展开动作（右上角圆形按钮入口）；尺寸栏为中间固定布局位，随面板宽度自然左移
      function togglePreviewCollapsed() {
        var isCollapsed = document.body.hasAttribute('data-preview-collapsed');
        if (isCollapsed) {
          // 展开：恢复记忆宽度
          document.body.removeAttribute('data-preview-collapsed');
          rp.style.display = '';
          var targetW = Math.max(240, state.previewLastWidth || 320);
          rp.style.width = targetW + 'px';
          state.previewCollapsed = false;
          if (roundBtn) roundBtn.setAttribute('title', '折叠预览面板');
        } else {
          // 折叠：记录当前宽度后隐藏
          state.previewLastWidth = rp.clientWidth || state.previewLastWidth;
          document.body.setAttribute('data-preview-collapsed', '');
          state.previewCollapsed = true;
          if (roundBtn) roundBtn.setAttribute('title', '展开预览面板');
        }
      }
      // 尺寸栏承载调宽：按住左右拖动调整预览宽度（仅展开态；折叠态由右上角圆形按钮控制）
      resizerBar.addEventListener('mousedown', function (e) {
        // 折叠态不响应拖拽（面板已隐藏）
        if (document.body.hasAttribute('data-preview-collapsed')) return;
        e.preventDefault();
        // 拖拽期间禁用面板 width 过渡：style.width 逐帧即时生效，避免 0.3s 过渡滞后
        rp.style.transition = 'none';
        var startX = e.clientX, startW = rp.clientWidth;
        function onVMove(ev) {
          var w = Math.max(240, Math.min(720, startW - (ev.clientX - startX)));
          rp.style.width = w + 'px'; state.previewLastWidth = w;
        }
        function onVUp() {
          document.removeEventListener('mousemove', onVMove);
          document.removeEventListener('mouseup', onVUp);
          rp.style.transition = ''; // 恢复宽度过渡（展开/折叠动画仍生效）
        }
        document.addEventListener('mousemove', onVMove);
        document.addEventListener('mouseup', onVUp);
      });
      if (roundBtn) roundBtn.addEventListener('click', togglePreviewCollapsed);
    }
  }
  function choosePath() {
    showBusy('正在检测工作路径文件，请稍候…');
    call('choose_workdir').then(function (r) {
      hideBusy();
      if (!r) { setStatus('选择路径失败'); return; }
      if (r.canceled) { setStatus('已取消选择路径'); return; }
      if (!r.ok) { setStatus('选择路径失败：' + ((r && r.error) || '未知错误')); return; }
      hideBootGuide();
      // 第一步：先扫描配置（force 重扫新路径下的配置列表）
      setStatus('工作路径已切换：' + r.root + '，正在扫描配置…');
      refreshData(true, '正在重新扫描工作路径…', function () {
        // 第二步：**增量**刷新预缓存（不删缓存、只更新变化/缺失的视频并顺带清理失效缓存）。
        // 全量重建（清空后重新检测全部素材）属低频兜底操作，只在 设置-维护 提供「重建预检测缓存」——
        // 切换工作路径不该顺带做全量重建。
        refreshPrecacheFlow();
      }, false);
    }).catch(function (e) { hideBusy(); setStatus('选择路径失败：' + e.message); });
  }
  function flashNeedSelect() { setStatus('请先选择一个 TXT 和日期分支'); }
  // 关闭主窗口行为引导：弹窗选择 退出软件 / 最小化至系统托盘，左下角「不再提醒」复选框持久化
  var _closeAskShown = false;
  function showCloseBehaviorDialog(api0) {
    if (_closeAskShown) return;
    _closeAskShown = true;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var card = document.createElement('div');
    card.className = 'modal-card modal-card--close';
    card.innerHTML = '<button type="button" class="modal-close" title="关闭">✕</button>' +
      '<div class="modal__title">关闭主窗口</div>' +
      '<div class="modal__message">请选择关闭主窗口后的行为：</div>' +
      '<div class="modal__close-foot">' +
      '<label class="opt-check"><input type="checkbox" id="closeRemindChk"><span class="opt-check__box"></span><span>不再询问</span></label>' +
      '<div class="modal__actions">' +
      '<button type="button" class="modal-btn" id="cbCloseTray">最小化至系统托盘</button>' +
      '<button type="button" class="modal-btn modal-btn--danger" id="cbCloseExit">退出软件</button>' +
      '</div>' +
      '</div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var done = function (value) {
      var chk = document.getElementById('closeRemindChk');
      var remind = !!(chk && chk.checked);
      overlay.remove();
      _closeAskShown = false;
      if (api0 && api0.choose_close_behavior) api0.choose_close_behavior(value, remind).catch(function () {});
    };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) done('tray'); });
    card.querySelector('.modal-close').addEventListener('click', function () { done('tray'); });
    card.querySelector('#cbCloseTray').addEventListener('click', function () { done('tray'); });
    card.querySelector('#cbCloseExit').addEventListener('click', function () { done('exit'); });
  }
  function bindCloseBehavior() {
    if (getApi().on_close_behavior_request) getApi().on_close_behavior_request(function () { showCloseBehaviorDialog(getApi()); });
  }
  function updateTasksCount(tasks) {
    // 主窗口按钮数字：统计运行中 + 排队（暂停任务无序号、不计入）
    var n = 0;
    (tasks || []).forEach(function (t) {
      if (t.status === 'running' || t.status === 'queued') n++;
    });
    var el = $('tasksCount');
    if (!el) return;
    if (n > 0) { el.textContent = String(n); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }
  // 更新提示条（两步式）：发现版本 → 下载（提示条最小化到状态栏显示进度）→ 下载完成重新弹出询问是否重启
  var _bannerShown = false;
  var _bannerDismissed = false; // 本次提示条被忽略/取消；新事件到达时重置
  var _bannerState = 'available'; // available | downloaded
  var _bannerSource = 'update';   // update | envfix（envfix 时按钮行为走 FFmpeg 修复流程）
  function showUpdateBanner(info, mode) {
    _bannerDismissed = false; // 「忽略/取消」仅关闭本次提示条，下次检查到更新时仍会重新弹出
    var banner = $('updateBanner');
    if (!banner) return;
    var nextMode = mode === 'downloaded' ? 'downloaded' : 'available';
    // 已处于「下载完成」等待用户操作时，新到的「发现新版本」不覆盖提示条
    if (_bannerShown && _bannerState === 'downloaded' && nextMode === 'available') return;
    _bannerShown = true;
    _bannerState = nextMode;
    var title = $('updateBannerTitle');
    var custom = (info && info.__custom) || null;
    if (custom) _bannerSource = custom.source || 'envfix';
    var desc = $('updateBannerDesc');
    var later = $('updateLaterBtn');
    var now = $('updateNowBtn');
    if (custom) {
      if (title) title.textContent = custom.title || '';
      if (desc) desc.textContent = custom.desc || '';
      if (later) later.textContent = custom.later || '取消';
      if (now) now.textContent = custom.now || '确定';
    } else if (_bannerState === 'downloaded') {
      // 两种形态都走「安装并重启」—— 后端 apply_update 按形态分流：
      //   便携分发 → 搬迁 + 线索 + 退出 + 拉起安装程序（改用安装版，设置与数据自动保留）
      //   安装版   → electron-updater 静默升级安装并重启
      var portableDist = state.portableDist === true;
      if (title) title.textContent = '更新文件已就绪';
      if (desc) desc.textContent = portableDist ? '将改用安装版，设置与数据保持不变' : '是否立即重启并安装？';
      if (later) later.textContent = '取消';
      if (now) now.textContent = portableDist ? '安装更新并重启' : '重启并安装';
    } else {
      if (title) title.textContent = '发现新版本 v' + ((info && info.latest) || '');
      if (desc) desc.textContent = '当前版本 v' + ((info && info.current) || '') + ' · 点击立即更新获取最新功能';
      if (later) later.textContent = '忽略';
      if (now) now.textContent = '立即更新';
    }
    if (now) now.disabled = false;
    banner.style.display = 'flex'; // display:none → flex 会重新触发入场动画
  }
  function hideUpdateBanner() {
    var banner = $('updateBanner');
    if (banner) banner.style.display = 'none';
    _bannerShown = false;
  }
  // 状态栏下载进度（任务按钮左侧）：左侧「更新 vX」+ 中间细进度条 + 右侧百分比
  // info.label 可覆盖左侧文案（FFmpeg 组件下载用「下载组件」，不写死「更新中」以免误导）
  function showUpdateMini(info) {
    var el = $('updateMini');
    var fill = $('updateMiniFill');
    var lab = $('updateMiniLabel');
    var txt = $('updateMiniText');
    if (!el) return;
    var p = Math.max(0, Math.min(100, (info && info.percent) || 0));
    var latest = (info && info.latest) || '';
    if (fill) fill.style.width = p + '%';
    if (lab) lab.textContent = (info && info.label) || (latest ? ('更新 v' + latest) : '更新中…');
    if (txt) txt.textContent = p + '%';
    el.style.display = 'inline-flex';
  }
  function hideUpdateMini() {
    var el = $('updateMini');
    if (el) el.style.display = 'none';
  }
  // ── 检查更新结果弹窗：三条入口（设置页 / 主窗口 / 托盘）的结果统一走这里 ──
  // 统一口径：结论一律弹窗（此前设置页弹 iframe 内浮层、主窗口写状态栏、托盘又走提示条，
  // 同一件事三种表现，且 iframe 内的浮层会被裁切看不全）。
  var _UPDATE_RESULT = {
    none:   { sym: '✓', cls: 'ok',   title: '已是最新版本',     close: '知道了' },
    update: { sym: '↑', cls: 'new',  title: '发现新版本',       close: '稍后', go: '立即更新' },
    error:  { sym: '!', cls: 'err',  title: '检查更新失败',     close: '知道了' },
    busy:   { sym: '…', cls: 'wait', title: '已有更新操作进行中', close: '知道了' }
  };
  function showUpdateResult(info, kind) {
    var mask = $('updateResultMask');
    if (!mask) return;
    var cfg = _UPDATE_RESULT[kind] || _UPDATE_RESULT.error;
    var ic = $('updateResultIcon'), ti = $('updateResultTitle'), de = $('updateResultDesc');
    var go = $('updateResultGo'), cl = $('updateResultClose');
    var cur = (info && info.current) || '';
    if (ic) { ic.textContent = cfg.sym; ic.className = 'update-result__icon update-result__icon--' + cfg.cls; }
    if (ti) ti.textContent = cfg.title
      + ((kind === 'update' || kind === 'none') && (kind === 'update' ? (info && info.latest) : cur) ? ' v' + (kind === 'update' ? info.latest : cur) : '');
    var desc = '';
    if (kind === 'none') {
      var t0 = new Date();
      var hm = ('0' + t0.getHours()).slice(-2) + ':' + ('0' + t0.getMinutes()).slice(-2);
      desc = (info && info.message) || ('当前版本' + (cur ? ' v' + cur : '') + ' 已是最新 · ' + hm + ' 完成检查');
    } else if (kind === 'update') {
      desc = '当前版本' + (cur ? ' v' + cur : '') + ' · 是否立即下载更新？下载完成后可在主窗口继续操作。';
    } else if (kind === 'busy') {
      desc = (info && (info.message || info.error)) || '请等当前操作结束后再试';
    } else {
      desc = (info && (info.message || info.error)) || '未知错误';
    }
    if (de) de.textContent = desc;
    if (go) { if (cfg.go) { go.style.display = ''; go.textContent = cfg.go; } else { go.style.display = 'none'; } }
    if (cl) cl.textContent = cfg.close || '知道了';
    mask.style.display = 'flex';
  }
  function hideUpdateResult() {
    var m = $('updateResultMask');
    if (m) m.style.display = 'none';
  }
  function initUpdateResult() {
    var mask = $('updateResultMask');
    if (!mask) return;
    // ⚠ 必须提到 <body> 直属：内嵌设置面板（.settings-frame）是 z-index 9999 的覆盖层，
    //   且它带 transform（自成堆叠上下文）—— 弹窗若留在 #app 里，层级会被限制，
    //   在设置页里点「检查更新」就看不到弹窗（表现为"弹窗没出来 / 跳回了主窗口"）。
    //   提到 body 直属 + 更高 z-index，才能保证它盖在设置面板之上。
    try { if (mask.parentNode !== document.body) document.body.appendChild(mask); } catch (e) {}
    mask.addEventListener('click', function (e) { if (e.target === mask) hideUpdateResult(); });
    var cl = $('updateResultClose');
    if (cl) cl.addEventListener('click', hideUpdateResult);
    var go = $('updateResultGo');
    if (go) go.addEventListener('click', function () {
      hideUpdateResult();
      var gp = getApi();
      if (!gp || !gp.start_update) { setStatus('更新功能不可用'); return; }
      setStatus('正在连接更新服务器…');
      gp.start_update().then(function (r) {
        if (r && r.busy) setStatus('已有更新操作进行中，请稍候');
      }).catch(function () { setStatus('下载更新失败'); });
    });
  }
  function initUpdateBanner() {
    var banner = $('updateBanner');
    if (!banner) return;
    banner.style.display = 'none'; // 默认隐藏，由后端事件驱动显示
    var later = $('updateLaterBtn');
    if (later) later.addEventListener('click', function () {
      if (_bannerSource === 'envfix') { hideUpdateBanner(); return; } // 仅关闭浮窗，不影响更新提醒
      _bannerDismissed = true; // 忽略/取消：本次会话不再提醒，下次启动仍会检查
      hideUpdateBanner();
    });
    var now = $('updateNowBtn');
    if (now) now.addEventListener('click', function () {
      var gp = getApi();
      if (!gp) { setStatus('更新功能不可用'); return; }
      if (_bannerSource === 'envfix') {
        if (_bannerState === 'downloaded') { hideUpdateBanner(); return; }   // 完成态：知道了
        now.disabled = true;
        setStatus('正在下载 FFmpeg 组件…');
        if (!gp.env_fix_start) { now.disabled = false; return; }
        gp.env_fix_start().then(function (r) {
          now.disabled = false;
          if (r && r.ok === false) { hideUpdateBanner(); setStatus('FFmpeg 下载失败：' + ((r && r.error) || '未知错误'), true); }
        }).catch(function (e) { now.disabled = false; hideUpdateBanner(); setStatus('FFmpeg 下载失败：' + e.message, true); });
        return;
      }
      now.disabled = true;
      if (_bannerState === 'downloaded') {
        // 两种形态统一走 apply_update —— 后端按形态分流：
        //   便携分发 → 搬迁 + 线索 + 退出 + 拉起安装程序（改用安装版，设置与数据自动保留）
        //   安装版   → electron-updater 静默升级安装并重启
        // （旧版便携形态此处仅打开资源管理器、让用户自行解压覆盖，已废弃）
        setStatus('正在准备安装更新…');
        if (!gp.apply_update) { now.disabled = false; return; }
        gp.apply_update().then(function (r) {
          if (r && r.ok === false) { now.disabled = false; setStatus((r && r.error) || '启动更新失败'); }
        }).catch(function () { now.disabled = false; setStatus('启动更新失败'); });
      } else {
        // 第一步：仅下载更新包（连接服务器阶段先给提示，随后出现 0% 进度条）
        setStatus('正在连接更新服务器…');
        if (!gp.start_update) { now.disabled = false; return; }
        gp.start_update().then(function (r) {
          if (r && r.busy) { now.disabled = false; setStatus('已有更新操作进行中，请稍候'); }
        }).catch(function () { now.disabled = false; setStatus('下载更新失败'); });
      }
    });
    var upd = getApi();
    if (!upd) return;
    // 主动检查发现新版本 → 结果弹窗（后台静默检查走的是别的路径，不会到这里）
    if (upd.on_update_available) upd.on_update_available(function (info) { showUpdateResult(info, 'update'); });
    if (upd.on_update_progress) upd.on_update_progress(function (info) {
      // 下载进行中：提示条最小化到状态栏（任务按钮左侧显示文字与进度条），左下角状态栏同步更新
      hideUpdateBanner();
      showUpdateMini(info);
      var p = Math.max(0, Math.min(100, (info && info.percent) || 0));
      var latest = (info && info.latest) || '';
      setStatus('正在下载更新' + (latest ? ' v' + latest : '') + ' ' + p + '%');
    });
    if (upd.on_update_status) upd.on_update_status(function (text) {
      // 连接/重试/校验等阶段状态同步到左下角状态栏
      if (text) setStatus(text);
    });
    if (upd.on_update_downloaded) upd.on_update_downloaded(function (info) {
      hideUpdateMini();
      showUpdateBanner(info, 'downloaded');
      setStatus('更新包下载完成');
    });
    if (upd.on_update_none) upd.on_update_none(function (info) {
      hideUpdateMini();
      showUpdateResult(info, 'none');
    });
    if (upd.on_update_error) upd.on_update_error(function (info) {
      hideUpdateMini();
      showUpdateResult(info, info && info.busy ? 'busy' : 'error');
    });
    if (upd.on_update_ready) upd.on_update_ready(function () {
      hideUpdateMini();
      hideUpdateBanner();
      setStatus('更新包已就绪，正在重启应用…');
    });
    // FFmpeg 环境自愈：复用更新提示条与状态栏进度条（文案与来源不同）
    // 缺失由**启动自动下载**处理（不弹确认）；此横幅只在「下载失败」时出现 → 文案按失败说，按钮是重试
    if (upd.on_env_fix_available) upd.on_env_fix_available(function (info) {
      _bannerDismissed = false;
      showUpdateBanner({ __custom: {
        source: 'envfix',
        title: 'FFmpeg 组件未就绪',
        desc: '自动下载失败，请检查网络后重试',
        later: '稍后', now: '重新下载',
      } }, 'available');
    });
    // 运行期环境失效（用的时候才发现）：吐司比横幅更醒目，落在当前视野内
    if (upd.on_env_lost) upd.on_env_lost(function (info) {
      var who = (info && info.missing) ? info.missing : 'FFmpeg / FFprobe';
      toast(who + ' 不可用，请重新下载组件', true);
    });
    // 组件下载进度：**进度事件自闭环**（done / error 也在这里收尾）——
    // ⚠ 不能只靠 env_fix_done：那条事件只在「界面点重新下载」的 IPC 路径发出，
    //   浏览器/HTTP 触发（如运维脚本、自动巡检）或其它入口触发时收不到，
    //   进度条会永久停在 99%（HTTP 通道触发的下载就收不到收尾事件）。
    if (upd.on_env_fix_progress) upd.on_env_fix_progress(function (info) {
      if (!info) return;
      if (info.phase === 'check') { setStatus('正在检查 FFmpeg 组件…'); return; }
      if (info.phase === 'download') {
        hideUpdateBanner();
        showUpdateMini({ percent: info.percent, label: '下载组件' });
        setStatus('正在下载 FFmpeg 组件 ' + ((info && info.percent) || 0) + '%');
        return;
      }
      if (info.phase === 'done') { hideUpdateMini(); if (info.auto !== false) setStatus('FFmpeg 组件已就绪'); return; }
      if (info.phase === 'error') {
        hideUpdateMini();
        setStatus('FFmpeg 组件下载失败：' + (info.error || '未知原因'), true);
      }
    });
    if (upd.on_env_fix_done) upd.on_env_fix_done(function (info) {
      hideUpdateMini();
      if (!info || !info.ok) {
        hideUpdateBanner();
        setStatus('FFmpeg 下载失败：' + ((info && (info.error || info.message)) || '未知原因'), true);
        return;
      }
      // 启动自动下载成功：**静默**（不弹确认、不弹横幅）—— 只更新状态栏
      if (info.auto) { setStatus('FFmpeg 组件已就绪'); checkEnv(); return; }
      showUpdateBanner({ __custom: {
        source: 'envfix',
        title: 'FFmpeg 组件已就绪',
        desc: '下载完成，全部功能可用',
        later: '关闭', now: '知道了',
      } }, 'downloaded');
      setStatus('FFmpeg 组件已就绪');
      // 组件到位后重查环境：状态栏「运行组件未就绪」消失、引擎入口自动解除禁用
      checkEnv();
    });
  }

  // 轻量 Markdown 渲染（标题 / 有序无序列表 / 表格 / 引用 / 行内链接与粗体 / 代码块 / 空行）
  function renderMdMd(text) {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    function inline(s) {
      s = String(s == null ? '' : s).replace(/<img[^>]*>/gi, '');
      s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 剥离 markdown 图片语法（badge 图等）
      s = esc(s);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // [text](url)：仅文字非空才渲染链接；剥图残留的空 [](url) 直接移除不显示
      s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (m, txt, u) {
        if (!txt) return '';
        return '<a href="' + u + '">' + txt + '</a>';
      });
      // 尖括号裸链：< > 已转义为实体，需按实体匹配
      s = s.replace(/&lt;((?:https?:\/\/)[^>&\s]+)&gt;/g, '<a href="$1">$1</a>');
      return s;
    }
    var lines = String(text || '').split(/\r?\n/);
    var html = '', inList = false, inCode = false, inBlock = false;
    var flushList = function () { if (inList) { html += '</ul>'; inList = false; } };
    var flushBlock = function () { if (inBlock) { html += '</blockquote>'; inBlock = false; } };
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i];
      if (/^\s*```/.test(t)) { flushList(); flushBlock(); html += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
      if (inCode) { html += esc(t) + '\n'; continue; }
      if (/^\s*\|/.test(t)) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        i--;
        flushList(); flushBlock();
        var header = rows[0].replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/);
        var bodyStart = 1;
        if (rows[1] && /^\s*\|?\s*:?-{2,}/.test(rows[1])) bodyStart = 2;
        html += '<table><thead><tr><th>' + header.map(inline).join('</th><th>') + '</th></tr></thead><tbody>';
        for (var r = bodyStart; r < rows.length; r++) {
          var cells = rows[r].replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/);
          html += '<tr><td>' + cells.map(inline).join('</td><td>') + '</td></tr>';
        }
        html += '</tbody></table>';
        continue;
      }
      var q = /^>\s?(.*)$/.exec(t);
      if (q) { flushList(); if (!inBlock) { html += '<blockquote>'; inBlock = true; } html += '<p>' + inline(q[1] || '') + '</p>'; continue; }
      if (inBlock) { flushBlock(); }
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { flushList(); var lv = Math.min(h[1].length, 4); html += '<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'; continue; }
      var ul = /^\s*[-*]\s+(.*)$/.exec(t);
      if (ul) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(ul[1]) + '</li>'; continue; }
      flushList();
      if (/^\s*<(\/)?(div|br)[^>]*>\s*$/i.test(t)) { continue; }
      if (/^-{3,}\s*$/.test(t)) { flushList(); flushBlock(); html += '<hr>'; continue; }
      if (!t.trim()) { continue; } // 空行不输出，避免多余空隙
      var para = inline(t);
      if (para) html += '<p>' + para + '</p>';
    }
    flushList(); flushBlock();
    return html;
  }

  // 启动弹更新日志：仅版本更新后（或初次启动）首次弹出，之后不再打扰
  function showStartupChangelog() {
    call('get_changelog_popup').then(function (r) {
      if (r && r.ok && r.show && r.content) showChangelogPopup(r.content);
    }).catch(function () {});
  }

  // 更新日志弹窗：大卡片 + 可滚动正文，右上角圆X / 点击遮罩 / 底部按钮关闭
  function showChangelogPopup(content) {
    var old = document.getElementById('changelogModal');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'changelogModal';
    var card = document.createElement('div');
    card.className = 'modal-card changelog-card';
    card.innerHTML =
      '<button type="button" class="modal-close" title="关闭">✕</button>' +
      '<div class="changelog-card__body"></div>' +
      '<div class="changelog-card__actions"><button type="button" class="modal-btn modal-btn--primary">知道了</button></div>';
    var body = card.querySelector('.changelog-card__body');
    body.innerHTML = renderMdMd(content);
    var done = function () {
      overlay.remove();
      // 用户确已看到 → 记录展示版本，避免重复弹出（标记在关闭时回写，静默启动也不白消耗机会）
      try { call('ack_changelog_popup'); } catch (e) {}
    };
    card.querySelector('.modal-close').addEventListener('click', done);
    card.querySelector('.modal-btn').addEventListener('click', done);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) done(); });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // 未配置工作路径时的引导态：项目列表为空，中央「选择路径」指引
  function showBootGuide() { var el = $('bootGuide'); if (el) el.style.display = 'flex'; }
  function hideBootGuide() { var el = $('bootGuide'); if (el) el.style.display = 'none'; }
  function initBootGuide() {
    var btn = $('bootGuidePick');
    if (btn) btn.addEventListener('click', function () { choosePath(); });
    if (getApi().get_root) {
      getApi().get_root().then(function (r) { (r ? hideBootGuide() : showBootGuide()); }).catch(showBootGuide);
    }
  }

  // 全局兜底（error / unhandledrejection / console.error）统一由 log-bootstrap.js 注入（四窗口共用）；
  // 这里只把本页 toast 挂上去，让兜底的弹窗行为保持不变。就地 catch 请用 window.logError(where, err)。
  window.vlToast = toast;

  function init() {
    // 任务列表「定位」监听：异常隔离，不影响主界面初始化
    try { if (getApi() && getApi().on_locate) getApi().on_locate(handleLocateRequest); } catch (e) {}
    hydrateIcons(document);
    bindStaticEvents();
    initSkin();
    initMaskMode();
    buildAzIndex();
    updateSortButtons();
    initUpdateBanner();
    initUpdateResult();
    // 启动弹更新日志（当前每次启动弹出以确认样式，后续改为更新后首次弹出）
    showStartupChangelog();
    // 状态栏左下角常驻版本号
    if (getApi().get_app_version) {
      getApi().get_app_version().then(function (v) {
        var el = $('versionTag');
        if (el) el.textContent = v ? 'v' + v : '';
      }).catch(function () {});
    }
    // 运行时形态（便携/setup），决定「下载完成」后是打开更新文件还是重启并安装
    if (getApi().get_runtime) {
      // portableDist 决定「更新文件已就绪」时的按钮与说明（后端 apply_update 才是权威的形态分流方）
      getApi().get_runtime().then(function (r) {
        state.portableDist = !!(r && r.portable_dist);
        state.isPortable = !!(r && r.is_portable);
      }).catch(function () { state.portableDist = true; state.isPortable = true; });
    }
    if (!getApi()) { $('statusLeft').textContent = '通信组件未就绪，请重启软件'; return; }
    checkEnv(); buildDateBranches(); buildCenterBottom(); buildRightPanel(); refreshData(false, '正在检测工作路径文件，请稍候…');
    initBootGuide();
    bindCloseBehavior();
    if (getApi().on_task_update) getApi().on_task_update(updateTasksCount);
    // 配置自愈：软件内写配置（保存/清理）广播 → 即时静默刷新；外部删改/任务迁移 → 低频轮询兜底
    if (getApi().on_versions_changed) getApi().on_versions_changed(function () { refreshActiveVersions(); });
    setInterval(function () { refreshActiveVersions(); }, 4000);
    // 关闭/退出主窗口前：配置有未保存修改时弹三按钮确认（覆盖当前配置/保存为当日配置/取消）
    if (getApi().on_confirm_discard_config) getApi().on_confirm_discard_config(handleDiscardConfigRequest);
    // 有运行中任务退出时：主进程请求二次确认（与界面同款弹窗），确认后才真正退出
    if (getApi().on_confirm_quit_request) getApi().on_confirm_quit_request(function () {
      showDialog({
        title: '确认退出',
        message: '有正在运行的任务，退出将中断当前生成，并将任务标记为已中断、排队任务转为暂停。确定要退出吗？',
        buttons: [
          { label: '取消', value: false },
          { label: '仍要退出', value: true, danger: true }
        ]
      }).then(function (ok) { if (ok && getApi().confirm_quit) getApi().confirm_quit(); });
    });
    // 文档内 http 链接统一用系统默认浏览器打开（更新日志弹窗等）
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
      if (!a) return;
      e.preventDefault();
      var ap = getApi();
      if (ap && ap.open_external) ap.open_external(a.getAttribute('href')).catch(function () {});
    });
  }
  function checkEnv() {
    call('check_env').then(function (r) {
      r = r || {};
      var miss = [];
      if (!r.ffmpeg) miss.push('ffmpeg');
      if (!r.ffprobe) miss.push('ffprobe');
      // 内置引擎缺失即无法执行任务：单独提示重装，不与环境缺失混为一谈
      if (r.engine === false) miss.push('程序组件');
      state.envMissing = miss;
      var mark = $('envWarnMark');
      if (mark) {
        if (r.engine === false) {
          mark.textContent = '程序文件不完整，请重新安装或校验';
          mark.className = 'status-bar__envwarn';
          mark.style.display = '';
        } else if (miss.length) {
          // 组件缺失 = 应用正在自动下载（不要引导用户手动安装组件）
          mark.textContent = '运行组件未就绪：' + miss.join('、') + '（正在自动下载）';
          mark.title = '应用会自动下载所需组件；若长时间未就绪，点上方提示条重新下载';
          mark.className = 'status-bar__envwarn';
          mark.style.display = '';
        } else {
          mark.textContent = '';
          mark.style.display = 'none'; // 环境正常不显示相关内容
        }
      }
      applyEnvDisabled();
    }).catch(function () { state.envMissing = ['程序组件', 'ffmpeg', 'ffprobe']; applyEnvDisabled(); });
  }
  function _envBad() { return (state.envMissing || []).length > 0; }
  function setBtnHint(b, hint) {
    if (!b) return;
    if (hint) {
      if (!b.dataset.origTitle) b.dataset.origTitle = b.getAttribute('title') || '';
      b.setAttribute('title', hint);
    } else if (b.dataset.origTitle) {
      b.setAttribute('title', b.dataset.origTitle);
      delete b.dataset.origTitle;
    } else b.removeAttribute('title');
  }
  // 环境硬拦截：缺内置引擎/ffmpeg/ffprobe 时禁用所有调用引擎的入口，悬浮提示「运行组件未就绪」
  // （组件会自动下载，下载完成由 env_fix_done → checkEnv() 刷新并自动解除禁用）
  function applyEnvDisabled() {
    var bad = _envBad();
    var targets = document.querySelectorAll('#btnRunScript, #btnBatchReplica1, #btnBatchReplica2, .log-entry__replica, #btnMaskStart');
    Array.prototype.forEach.call(targets, function (b) {
      if (b.disabled === undefined) return;
      if (bad) {
        b.disabled = true;
        setBtnHint(b, '运行组件未就绪');
      } else {
        setBtnHint(b, null);
      }
    });
    // 环境完整时按各自禁用条件重算提示
    if (!bad) { if (typeof refreshLogConfigBar === 'function') refreshLogConfigBar(); applyPrecheckValidity(); refreshConfigModified(); }
  }
  // ════════════ 遮罩叠加模式（复用主窗口：左侧项目 / 右侧配置 / 底部输出+启动） ════════════
  var maskState = {
    on: false, projects: [], project: null, mode: 1, view: 'config', search: '',
    maskLogBranch: '', // 日志视图当前选中的日期分支（对应某日志文件路径，空=自动最新）
    rawDirs: [],      // 原片文件夹列表 [{ path, name, files }]
    rawSel: {},       // { path: [视频相对路径 = 子目录/文件名] } 缺省=全选
    themes: [],       // 可用遮罩主题 [{ path, name }]（项目主题 + 额外目录）
    maskSel: {},      // { mov完整路径: true } 勾选的遮罩（按组勾选）
    maskDur: {},      // { mov完整路径: 时长秒 } 遮罩时长映射（渲染时写入，供开始前校验）
    watermark: '',    // 水印文件
    outputDir: '',    // 成片输出目录（空 = 用占位符默认目录）
    defaultOutDir: '',// 项目设置的默认输出目录（占位符显示）
    suffix: ''        // 成片名序号前的后缀（独立于批量模式，可空）
  };
  // 两模式隔离统一守卫：批量渲染/交互在遮罩模式下必须拒绝执行（反之亦然），
  // 今后新增的批量/遮罩渲染函数同样在入口调用 maskOn()/!maskOn() 守卫
  function maskOn() { return maskState.on === true; }
  var MASK_MODES = { 1: '遮罩+水印', 2: '仅水印', 3: '仅遮罩' };
  function maskNeedMask() { return maskState.mode === 1 || maskState.mode === 3; }
  function maskNeedWm() { return maskState.mode === 1 || maskState.mode === 2; }
  // 遮罩组前缀：名字去掉尾部序号（如 国庆节-1.mov / 国庆节_2.mov / 国庆节 3.mov → 国庆节）
  function maskGroupPrefix(name) {
    var s = String(name || '').replace(/\.[^.]+$/, '');
    s = s.replace(/[-_ ]+\d+$/, '').replace(/\d+$/, '');
    return s;
  }
  // 遮罩主题显示去重：主题名/文件名已含项目名前缀时，界面只显示去掉前缀的短名
  // （如 项目A\项目A-主题B\项目A-主题B-1.mov → 显示 主题B / 主题B-1，hover 有完整路径）
  function maskDisplayName(s) {
    var proj = maskState.project && maskState.project.name;
    if (proj && typeof s === 'string') {
      if (s.indexOf(proj + '-') === 0) return s.slice(proj.length + 1);
      if (s.indexOf(proj + '_') === 0) return s.slice(proj.length + 1);
      if (s.indexOf(proj + ' ') === 0) return s.slice(proj.length + 1);
      if (s.indexOf(proj) === 0) { var r = s.slice(proj.length).replace(/^[-_ ]+/, ''); if (r) return r; }
    }
    return s;
  }
  // 已选原片文件数：未加载素材的文件夹按 0 计（加载完成后会重建底栏）；全选未记录时按该文件夹全部文件计
  function maskRawSelCount() {
    var c = 0;
    maskState.rawDirs.forEach(function (d) {
      var set = maskState.rawSel[d.path];
      if (set) c += set.length;
    });
    return c;
  }
  // 底部配置栏已选文本：只显示已选中的侧（0 不显示），便于与「未选中XX」提示共存
  function maskSelTotalText() {
    var parts = [];
    if (maskNeedMask()) {
      var maskC = Object.keys(maskState.maskSel).length;
      if (maskC > 0) parts.push('已选遮罩 ' + maskC);
    }
    var rawC = maskRawSelCount();
    if (rawC > 0) parts.push('已选原片 ' + rawC);
    return parts.join(' · ');
  }
  // 原片/遮罩会话持久化：勾选、分组、外部目录、模式、输出目录等写物理缓存，不手动删就一直在
  var _maskPersistTimer = null;
  function maskPersist() {
    if (!maskOn() || !maskState.project) return;
    if (_maskPersistTimer) clearTimeout(_maskPersistTimer);
    _maskPersistTimer = setTimeout(function () {
      call('save_mask_session', maskState.project.name, {
        rawDirs: (maskState.rawDirs || []).map(function (d) { return { path: d.path, name: d.name, single: !!d.single }; }),
        themes: (maskState.themes || []).map(function (t) { return { path: t.path, name: t.name, single: !!t.single }; }),
        suffix: maskState.suffix || ''
        // 模式/输出目录不持久化：重启软件后重置为初始默认（模式=遮罩+水印，输出走项目默认目录占位）
      }).catch(function () {});
    }, 300);
  }
  // 恢复持久化会话时校验目录有效性：原片文件夹不存在或为空（无视频）→ 从列表去除并落盘；
  // 外部遮罩目录不存在 → 同样去除；项目根扫描源仅校验目录存在
  function validateMaskDirs() {
    if (!maskOn() || !maskState.project) return;
    var p = maskState.project;
    var rawDirs = (maskState.rawDirs || []).slice();
    var themes = (maskState.themes || []).slice();
    if (!rawDirs.length && !themes.length) return;
    // 原片目录校验分两类：
    //  · 项目内扫描源：沿用「为空即移除」（扫描会重新给出，移除安全）；
    //  · 手动添加的外部路径 / 单文件：只校验「是否还存在」——外部路径是用户主动添加的，
    //    不能因为「暂时读不到素材」或「接口调用失败」就被移除（否则会随会话落盘永久丢失）。
    var _rootP = String(p.path).replace(/[\\/]+$/, '').toLowerCase();
    var _inProj = function (dp) {
      var x = String(dp || '').replace(/[\\/]+$/, '').toLowerCase();
      return x === _rootP || x.indexOf(_rootP + '\\') === 0 || x.indexOf(_rootP + '/') === 0;
    };
    var rawKeep = rawDirs.map(function (d) {
      if (d.single || !_inProj(d.path)) {
        return call('check_exists', [d.path]).then(function (m) {
          return (m && m[d.path] === true) ? d : null;   // 仅「确实不存在」才移除
        }).catch(function () { return d; });             // 调用失败一律保留，不误删
      }
      return call('list_mask_videos', d.path).then(function (f) {
        return (Array.isArray(f) && f.length) ? d : null;
      }).catch(function () { return d; });               // 同上：失败保留
    });
    var themeKeep = themes.map(function (t) {
      // 项目根扫描源只看目录是否还在；外部添加目录同此判定（其下有无素材由后续加载体现）
      if (t.path && String(t.path).replace(/[\\/]+$/, '').toLowerCase() === String(p.path).replace(/[\\/]+$/, '').toLowerCase()) {
        return call('check_exists', [t.path]).then(function (m) { return (m && m[t.path] === true) ? t : null; }).catch(function () { return t; });
      }
      return call('check_exists', [t.path]).then(function (m) { return (m && m[t.path] === true) ? t : null; }).catch(function () { return null; });
    });
    Promise.all(rawKeep.concat(themeKeep)).then(function (kept) {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      var nRaw = rawDirs.length;
      var rawArr = kept.slice(0, nRaw).filter(Boolean);
      var themeArr = kept.slice(nRaw).filter(Boolean);
      var changed = rawArr.length !== maskState.rawDirs.length || themeArr.length !== maskState.themes.length;
      if (!changed) { // 数组长度相同也要看内容（顺序一致时可直接判定，此处保守按路径对比）
        var sameA = rawArr.length === maskState.rawDirs.length && rawArr.every(function (d, i) { return maskState.rawDirs[i] && d.path === maskState.rawDirs[i].path; });
        var sameB = themeArr.length === maskState.themes.length && themeArr.every(function (t, i) { return maskState.themes[i] && t.path === maskState.themes[i].path; });
        changed = !(sameA && sameB);
      }
      if (!changed) return;
      maskState.rawDirs = rawArr;
      maskState.themes = themeArr.length ? themeArr : [{ path: p.path, name: p.name }];
      // 清理已失效原片目录对应的勾选
      var paths = {};
      maskState.rawDirs.forEach(function (d) { paths[d.path] = 1; });
      var sel = maskState.rawSel || {};
      var keepSel = {};
      Object.keys(sel).forEach(function (k) { if (paths[k]) keepSel[k] = sel[k]; });
      maskState.rawSel = keepSel;
      buildMaskCenter(); maskPersist();
    }).catch(function () {});
  }
  // 合并原片分组：保留手动添加的外部目录与单文件（允许外部路径），项目内分组以扫描结果为准。
  // 仅当目录失效时由 validateMaskDirs 存在性校验移除。
  function maskMergeRawDirs(scanDirs) {
    if (!maskState.project) return scanDirs || [];
    var rootP = String(maskState.project.path).replace(/[\\/]+$/, '').toLowerCase();
    var inProj = function (d) {
      var s = String(d).replace(/[\\/]+$/, '').toLowerCase();
      return s === rootP || s.indexOf(rootP + '\\') === 0;
    };
    var external = (maskState.rawDirs || []).filter(function (d) { return d.single || !inProj(d.path); });
    var out = external.concat(scanDirs || []);
    var seen = {};
    return out.filter(function (d) { var k = String(d.path).toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
  }
  // 遮罩「添加文件/添加文件夹」（原片/遮罩两栏共用）：kind='file' 选单个视频文件（原片=mp4 等，遮罩=mov）
  // kind='dir' 选文件夹（递归扫描其中视频）；均支持 .lnk 快捷方式，后端统一解析与校验，已存在的路径跳过
  function maskPickAdd(side, kind) {
    if (!maskOn() || !maskState.project) return;
    var arr = side === 'theme' ? (maskState.themes || []) : (maskState.rawDirs || []);
    var sideName = side === 'theme' ? '遮罩' : '原片';
    call(kind === 'file' ? 'pick_paths_files' : 'pick_paths_dirs').then(function (list) {
      if (!list || !list.length) return;
      var added = 0, dup = 0, errs = [];
      var chain = Promise.resolve();
      list.forEach(function (p) {
        chain = chain.then(function () {
          return call('mask_add_source', side, p).then(function (r) {
            if (!r || r.error) { errs.push(p); return; }
            if (arr.some(function (d) { return pathResolveEq(d.path, r.path); })) { dup += 1; return; }
            arr.push({ path: r.path, name: baseNameNoExt(r.path) || r.path, single: r.type === 'file' });
            added += 1;
          }).catch(function () { errs.push(p); });
        });
      });
      chain.then(function () {
        buildMaskCenter(); maskPersist();
        var msg = '已添加 ' + sideName + ' ' + added + ' 项';
        if (dup) msg += '，跳过重复 ' + dup + ' 项';
        if (errs.length) msg += '，' + errs.length + ' 项无效';
        setStatusDone(msg);
      }).catch(function () { setStatus('添加失败'); });
    }).catch(function () {});
  }
  // 左下角菜单「刷新列表」：重扫当前项目原片分组（保留仍存在的勾选）+ 重载遮罩主题
  function maskRescanCurrent() {
    if (!maskOn() || !maskState.project) { setStatus('未选择遮罩叠加项目'); return; }
    var p = maskState.project;
    setStatus('正在重新扫描原片分组…');
    call('scan_mask_raw_dirs', p.path).then(function (dirs) {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      maskState.rawDirs = maskMergeRawDirs(dirs);
      var keep = {};
      (maskState.rawDirs || []).forEach(function (d) { if (maskState.rawSel[d.path]) keep[d.path] = maskState.rawSel[d.path]; });
      maskState.rawSel = keep;
      buildMaskCenter(); buildMaskConfigBar(); refreshMaskStartHint();
      if (maskNeedMask()) loadAllMaskGroups();
      maskPersist();
      setStatusDone('列表已刷新');
    }).catch(function () { setStatus('刷新失败'); });
  }
  // 删除/操作结果告知：轻量 toast 呈现（失败为红、其余为绿），不再开窗打断
  function maskTellResult(title, msg) {
    var t = String(title || '');
    var isErr = /失败|错误|异常|无法/.test(t);
    var text = String(msg == null ? '' : msg);
    toast((t ? t + '：' : '') + text, isErr ? 'error' : 'ok');
  }
  function maskResetSession() {
    maskState.project = null; maskState.rawDirs = []; maskState.rawSel = {};
    maskState.themes = []; maskState.maskSel = {}; maskState.watermark = ''; maskState.watermarkAlpha = ''; maskState.outputDir = '';
    maskState.suffix = ''; maskState.maskLogBranch = '';
  }
  function maskFmtDur(sec) {
    var s = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(s / 60), r = s % 60;
    // 统一 0m0s 格式：秒数始终带上（1 分钟整写 1m0s），不加前导 0
    if (m <= 0) return r + 's';
    return m + 'm' + r + 's';
  }
  // 遮罩叠加：时长联动禁用——勾选任何原片/遮罩后，未勾选且与已勾选集**任一**时长差>1s 的候选置灰禁用；
  // 取消勾选即恢复。对所有复选框生效（组内文件 + 遮罩分组头 + 原片分组头）：
  //   - 组内文件 / 单文件组头：与「已勾选全部时长（原片+遮罩）集合」逐个比对，必须与**每一个**都兼容
  //     （保证任意时刻勾选集合两两时差≤1s，杜绝同侧勾多个不同时长）
  //   - 多文件分组头：组内全部文件都被禁用时组头也禁用；组内任一可用则组头可用（全选只选可用项）
  function maskSyncDurDisabled() {
    if (!maskOn()) return;
    function keysOf(sel) {
      var keys = [];
      document.querySelectorAll(sel).forEach(function (cb) {
        if (cb.checked && cb.disabled === false) {
          var d = Number(cb.getAttribute('data-dur') || 0);
          if (d > 0 && keys.indexOf(d) < 0) keys.push(d);
        }
      });
      return keys;
    }
    // 已勾选时长集合：原片 data-vid、遮罩 data-grpall/data-grpfile（data-dur 由渲染时写入）
    // 合并原片+遮罩全部已勾选时长——候选必须与该全集**每个**时长兼容，才能维持集合两两匹配
    var rawKeys = keysOf('.mask-config input[data-vid]');
    var maskKeys = keysOf('#maskAllGroups input[data-grpall], #maskAllGroups input[data-grpfile]');
    var allKeys = [];
    rawKeys.concat(maskKeys).forEach(function (k) { if (allKeys.indexOf(k) < 0) allKeys.push(k); });
    function ok(d, keys) { return keys.length === 0 || keys.every(function (k) { return Math.abs(k - d) <= 1.0 + 1e-6; }); }
    function setDis(cb, dis) {
      if (!cb) return;
      if (cb.disabled !== dis) cb.disabled = dis;
      var lb = cb.closest('label');
      if (lb) {
        lb.classList.toggle('mask-dur-disabled', !!dis);
        // 禁用时 hover 悬浮提示原因（不影响原有 title：未禁用不覆盖）
        if (dis) {
          if (lb.getAttribute('title')) lb.setAttribute('data-orig-title', lb.getAttribute('title'));
          lb.setAttribute('title', '时长与已选素材不匹配');
        } else {
          var orig = lb.getAttribute('data-orig-title');
          if (orig) lb.setAttribute('title', orig);
          else lb.removeAttribute('title');
        }
      }
    }
    // 分组头是否可用的判定：组内所有 checkbox 均被禁用时 → 组头禁用；否则组头可用
    function grpHeadUsable(selFiles, grp) {
      var els = grp ? grp.querySelectorAll(selFiles) : document.querySelectorAll(selFiles);
      for (var i = 0; i < els.length; i++) {
        if (!els[i].disabled) return true;
      }
      return els.length === 0;
    }
    // 原片组内文件：与全部已勾选时长集合兼容（遮罩 + 已勾原片一起约束）
    document.querySelectorAll('.mask-config input[data-vid]').forEach(function (cb) {
      if (cb.checked) { setDis(cb, false); return; }
      var d = Number(cb.getAttribute('data-dur') || 0);
      setDis(cb, d > 0 && !ok(d, allKeys));
    });
    // 遮罩组内文件：与全部已勾选时长集合兼容（原片 + 已勾遮罩一起约束）
    document.querySelectorAll('#maskAllGroups input[data-grpfile]').forEach(function (cb) {
      if (cb.checked) { setDis(cb, false); return; }
      var d = Number(cb.getAttribute('data-dur') || 0);
      setDis(cb, d > 0 && !ok(d, allKeys));
    });
    // 分组头元素本身置灰（名称/元信息文字与图标随禁用态变灰），并带原因提示
    function setHeadDis(head, dis) {
      if (!head) return;
      head.classList.toggle('mask-head-disabled', !!dis);
      if (dis) {
        if (head.getAttribute('title')) head.setAttribute('data-orig-title', head.getAttribute('title'));
        head.setAttribute('title', '时长与已选素材不匹配，该组不可选');
      } else {
        var o = head.getAttribute('data-orig-title');
        if (o) head.setAttribute('title', o);
        else head.removeAttribute('title');
      }
    }
    // 遮罩分组头：单文件组头按时长判定；多文件组头按组内文件全禁则禁（组头全选会跳过禁用项）
    document.querySelectorAll('#maskAllGroups input[data-grpall]').forEach(function (cb) {
      if (cb.checked) { setDis(cb, false); setHeadDis(cb.closest('.mask-group-head'), false); return; }
      var grp = cb.closest('.mask-group');
      if (grp && !grp.classList.contains('mask-group--single')) {
        var g1 = !grpHeadUsable('input[data-grpfile]', grp);
        setDis(cb, g1); setHeadDis(grp.querySelector('.mask-group-head'), g1);
        return;
      }
      var d = Number(cb.getAttribute('data-dur') || 0);
      var g2 = d > 0 && !ok(d, allKeys);
      setDis(cb, g2); setHeadDis(cb.closest('.mask-group-head'), g2);
    });
    // 原片文件夹行全选框：组内全部文件被禁用 → 全选框禁用（避免点了全选却一个都勾不上）
    document.querySelectorAll('.mask-folder-row input[data-rawall]').forEach(function (cb) {
      if (cb.checked) { setDis(cb, false); return; }
      var i = cb.getAttribute('data-rawall');
      var box = document.getElementById('maskRawFiles_' + i);
      var grp = box;
      setDis(cb, !grpHeadUsable('input[data-vid]', grp));
    });
    // 原片分组头：组内全部文件被禁用 → 组头禁用；否则可用（全选会跳过禁用项）
    document.querySelectorAll('.mask-config [data-rawgrpall]').forEach(function (cb) {
      if (cb.checked) { setDis(cb, false); setHeadDis(cb.closest('.mask-raw-group__head'), false); return; }
      var grp = cb.closest('.mask-raw-group');
      var d3 = !grpHeadUsable('input[data-vid]', grp);
      setDis(cb, d3); setHeadDis(cb.closest('.mask-raw-group__head'), d3);
    });
  }
  // 分组头勾选/半选态同步：按实时的组内 checkbox 状态刷新所有分组头
  // （checked=组内全部勾选；indeterminate=部分勾选；不勾选=无勾选）
  function maskSyncGrpHeads() {
    if (!maskOn()) return;
    // 原片分组头
    document.querySelectorAll('.mask-raw-group').forEach(function (grp) {
      var rc = grp.querySelector('input[data-rawgrpall]');
      if (!rc) return;
      var fcs = grp.querySelectorAll('input[data-vid]');
      var on = 0;
      fcs.forEach(function (fc) { if (fc.checked) on++; });
      rc.checked = fcs.length > 0 && on === fcs.length;
      rc.indeterminate = on > 0 && on < fcs.length;
    });
    // 遮罩分组头
    document.querySelectorAll('#maskAllGroups .mask-group').forEach(function (grp) {
      var rc = grp.querySelector('input[data-grpall]');
      if (!rc) return;
      var fcs = grp.querySelectorAll('input[data-grpfile]');
      var on = 0;
      fcs.forEach(function (fc) { if (fc.checked) on++; });
      rc.checked = fcs.length > 0 && on === fcs.length;
      rc.indeterminate = on > 0 && on < fcs.length;
    });
  }
  // 女仆皮肤角色舞台（主舞台）随遮罩模式迁移：遮罩模式下挂到右侧配置区作背景，退出还原到中间区
  function maskRelocateStage(host) {
    var stage = document.querySelector('[data-skin-chrome="character-stage"]');
    if (!stage) return;
    if (host) {
      if (stage.parentNode !== host) host.appendChild(stage);
    } else {
      var cp = document.querySelector('.center-panel');
      if (cp && stage.parentNode !== cp) cp.prepend(stage);
    }
  }
  // 模式切换（批量 ↔ 遮罩叠加）的中间过渡：两种模式的中栏 / 侧栏结构完全不同，切换必然整片重建，
  // 让重建发生在遮罩之下，用户看到的是一次干净的切换，而不是重建过程的中间态。
  var modeMaskShownAt = 0;
  function showModeMask(text) {
    var el = $('modeMask'); if (!el) return;
    var t = $('modeMaskText'); if (t) t.textContent = text || '正在切换…';
    el.style.display = 'flex';
    modeMaskShownAt = Date.now();
  }
  // 切换极快时遮罩一闪而过反而晃眼，故至少显示 180ms
  function hideModeMask() {
    var el = $('modeMask'); if (!el) return;
    var wait = Math.max(0, 180 - (Date.now() - modeMaskShownAt));
    setTimeout(function () { el.style.display = 'none'; }, wait);
  }
  // 遮罩必须先上屏：重建是同步的，同一帧内 show → 重建 → hide 浏览器不会绘制遮罩
  function afterModeMask(fn) {
    requestAnimationFrame(function () { requestAnimationFrame(fn); });
  }
  function enterMaskMode() {
    showModeMask('正在进入遮罩叠加模式…');
    afterModeMask(function () {
      maskState.on = true; maskResetSession(); maskState.view = 'config';
      document.body.classList.add('mask-mode');
      updateWinModeLabel(); // 标题栏模式按钮 → 遮罩叠加
      // 遮罩模式不使用右侧预览栏：记录进入前展开状态，进入即强制折叠
      maskState._sideBefore = !document.body.hasAttribute('data-preview-collapsed');
      document.body.setAttribute('data-preview-collapsed', '');
      state.previewCollapsed = true;
      var cc = $('previewCollapseRound'); if (cc) cc.style.display = 'none';
      var az = $('azIndexBar'); if (az) az.style.display = 'none';
      buildMaskSidebar();
      buildMaskCenterHeader();
      buildMaskCenter();
      buildMaskConfigBar();
      refreshMaskProjects();
      // 读取设置里的固定水印与透明度作为默认（界面不提供临时更换；读取后同步刷新底栏提示）
      call('get_settings').then(function (cfg) {
        if (cfg && cfg.mask) {
          if (cfg.mask.watermark_mov) maskState.watermark = cfg.mask.watermark_mov;
          maskState.watermarkAlpha = (cfg.mask.watermark_alpha != null && String(cfg.mask.watermark_alpha).trim() !== '') ? String(cfg.mask.watermark_alpha).trim() : '';
          if (maskState.on) {
            if (maskState.view === 'config') buildMaskCenter();
            buildMaskConfigBar(); // 刷新「未选水印」等提示
          }
        }
      }).catch(function () {});
      setStatus('遮罩叠加模式：左侧选项目，中间配置素材/查看日志，底部设模式与输出后开始制作');
      hideModeMask();
    });
  }
  // 中间区顶部：标题 + 配置/日志模式切换（遮罩模式隐藏全局成片搜索栏，退出时恢复批量）
  function buildMaskCenterHeader() {
    if (!maskOn()) return; // 仅遮罩模式渲染
    var gs = $('centerGlobalSearch');
    if (gs) gs.style.display = 'none'; // 遮罩模式不使用全局成片搜索栏
    var top = $('centerTop');
    if (top) {
      top.innerHTML = '<div class="center-top__header">' +
        '<span class="center-top__title">遮罩叠加</span>' +
        '<div class="center-top__toggles">' +
        '<button class="mode-toggle' + (maskState.view === 'config' ? ' mode-toggle--active' : '') + '" data-maskview="config" id="maskViewConfig">' + icon('list', 12) + '配置</button>' +
        '<button class="mode-toggle' + (maskState.view === 'log' ? ' mode-toggle--active' : '') + '" data-maskview="log" id="maskViewLog">' + icon('scroll-text', 12) + '日志</button>' +
        '</div></div>' +
        '<div class="center-top__dates" id="maskDateBranches"></div>' +
        '<div class="center-top__ornament-host" id="maskOrnamentHost" aria-hidden="true"></div>';
      // 日期分支栏仅在日志视图显示（配置视图不占位）
      var mb = $('maskDateBranches');
      if (mb) mb.style.display = (maskState.view === 'log') ? '' : 'none';
      // 日志分支点击切换（委托绑定一次，容器内容由 buildMaskLogView 重建）
      if (mb) mb.addEventListener('click', function (e) {
        var btn = e.target.closest('.date-branch-btn');
        if (!btn) return;
        var fp = btn.getAttribute('data-masklog');
        if (!fp || maskState.maskLogBranch === fp) return;
        maskState.maskLogBranch = fp;
        if (maskOn() && maskState.view === 'log') buildMaskLogView();
      });
      // 双击分支按钮：打开日志所在文件夹并选中日志文件（与批量日志分支一致）
      if (mb) mb.addEventListener('dblclick', function (e) {
        var btn = e.target.closest('.date-branch-btn');
        if (!btn) return;
        var fp = btn.getAttribute('data-masklog');
        if (fp) openFileInShell(fp);
      });
      top.querySelector('[data-maskview="config"]').addEventListener('click', function () { maskState.view = 'config'; buildMaskCenterHeader(); buildMaskCenter(); });
      top.querySelector('[data-maskview="log"]').addEventListener('click', function () { maskState.view = 'log'; buildMaskCenterHeader(); buildMaskCenter(); });
    }
    // 遮罩模式无「日期分支」栏（避免空栏占位），但保留皮肤装饰宿主恢复蝴蝶结装饰；
    // 装饰栏含动画：选中项目后 body[data-maid-chat-active] 驱动其自行动画退出（与批量一致）
    dispatchSkinRefresh();
  }
  // 皮肤行为层需要在新 DOM 结构上重建装饰（如日期分支蝴蝶结）时主动触发
  function dispatchSkinRefresh() {
    try { document.dispatchEvent(new CustomEvent('vl:skin-refresh')); } catch (e) {}
  }
  // 退出遮罩模式：恢复批量模式中间区头部（标题 / 列表 / 分支切换），并重建事件绑定与皮肤装饰
  function restoreBatchCenterTop() {
    var top = $('centerTop');
    if (!top) return;
    top.innerHTML = '<div class="center-top__header">' +
      '<span class="center-top__title">日期分支</span>' +
      '<div class="center-top__toggles">' +
      '<button class="mode-toggle mode-toggle--active" data-mode="filelist" id="modeFilelist">' + icon('list', 12) + '配置列表</button>' +
      '<button class="mode-toggle" data-mode="log" id="modeLog">' + icon('scroll-text', 12) + '日志</button>' +
      '</div></div>' +
      '<div class="center-top__dates" id="dateBranches"></div>';
    // 恢复右侧预览结构（遮罩模式重写过 rightPanelContent，行号/代码容器需重建）
    var rc = $('rightPanelContent');
    if (rc && !$('rightLineNumbers')) {
      rc.innerHTML = '<div class="right-panel__line-numbers" id="rightLineNumbers"></div><div class="right-panel__code" id="rightCode"></div>';
    }
    // 底栏留给批量流程填充：退出时清空遮罩残留
    var bar = $('configBar'); if (bar) bar.innerHTML = '';
    var mf2 = $('modeFilelist'), ml2 = $('modeLog');
    if (mf2) mf2.addEventListener('click', function () {
      state.mode = 'filelist'; mf2.classList.add('mode-toggle--active'); if (ml2) ml2.classList.remove('mode-toggle--active');
      buildDateBranches(); buildCenterBottom(); buildRightPanel();
    });
    if (ml2) ml2.addEventListener('click', function () {
      state.mode = 'log'; ml2.classList.add('mode-toggle--active'); if (mf2) mf2.classList.remove('mode-toggle--active');
      buildDateBranches(); buildCenterBottom(); buildRightPanel();
    });
    updateModeToggle();
    buildDateBranches();
    dispatchSkinRefresh();
  }
  // 中间区内容：按视图渲染 配置（素材）或 日志（遮罩日志）
  function buildMaskCenter() {
    if (!maskOn()) return;
    if (maskState.view === 'log') buildMaskLogView();
    else buildMaskCenterConfig();
  }
  function buildMaskCenterConfig() {
    buildMaskRight(true);
  }
  function exitMaskMode() {
    showModeMask('正在返回配置管理模式…');
    afterModeMask(function () {
      maskState.on = false; maskResetSession();
      document.body.classList.remove('mask-mode');
      updateWinModeLabel(); // 标题栏模式按钮 → 配置管理
      // 还原进入遮罩前右栏的展开状态（遮罩模式强制折叠，退出恢复）
      if (maskState._sideBefore) {
        var rp0 = $('rightPanel');
        document.body.removeAttribute('data-preview-collapsed');
        state.previewCollapsed = false;
        if (rp0) { rp0.style.display = ''; rp0.style.width = Math.max(240, state.previewLastWidth || 320) + 'px'; }
      }
      maskState._sideBefore = false;
      var cc = $('previewCollapseRound'); if (cc) cc.style.display = '';
      var gs0 = $('centerGlobalSearch'); if (gs0) gs0.style.display = ''; // 恢复批量全局成片搜索栏
      restoreBatchCenterTop();
      refreshData(true, '正在恢复视图…', function () {
        var az = $('azIndexBar'); if (az) az.style.display = '';
        var si = $('logSearchInput'); if (si) si.value = '';
        bindBatchLogSearch(true); // 搜索框曾被遮罩 clone：强制恢复批量成片搜索监听
        // 对称还原：批量模式原本未选中配置时（refreshData 不会自动重绘中心区），
        // 需显式重建批量空视图，避免残留遮罩的中间内容
        if (!state.activeTxt) {
          buildDateBranches();
          buildCenterBottom();
          buildRightPanel();
        }
        setStatus('已退出遮罩叠加模式');
        hideModeMask();
      });
    });
  }
  function refreshMaskProjects() {
    call('list_mask_projects').then(function (list) {
      maskState.projects = Array.isArray(list) ? list : [];
      buildMaskSidebar();
    }).catch(function (e) { setStatus('加载遮罩叠加项目失败：' + e.message); });
  }
  function buildMaskSidebar() {
    if (!maskOn()) return;
    var tree = $('sidebarTree');
    if (!tree) return;
    var html = '';
    if (!maskState.projects.length) {
      html += '<div class="mask-proj-empty">工作路径下暂无遮罩叠加项目<br>请在 菜单-设置-遮罩叠加 配置工作路径</div>';
    }
    maskState.projects.forEach(function (p) {
      var active = maskState.project && maskState.project.name === p.name;
      html += '<div class="mask-proj-item' + (active ? ' mask-proj-item--active' : '') + '" data-maskproj="' + escapeHtml(p.name) + '">' +
        icon('folder', 16, 'mask-proj-item__icon') +
        '<span class="mask-proj-item__name">' + escapeHtml(p.name) + '</span>' +
        '<span class="mask-proj-item__badge">' + (p.themeCount != null ? p.themeCount : (p.themes ? p.themes.length : 0)) + '种遮罩</span></div>';
    });
    tree.innerHTML = html;
    // 列表重建后选中项一出生就带 active，::before 的 transition 无从触发（没有 0→1 的变化），
    // 补一次性 az-fill 划入动画 —— 与批量项目名（.is-filling）同款处理
    var maskActiveEl = tree.querySelector('.mask-proj-item--active');
    if (maskActiveEl) {
      maskActiveEl.classList.add('is-filling');
      window.setTimeout(function () { maskActiveEl.classList.remove('is-filling'); }, 400);
    }
    tree.querySelectorAll('.mask-proj-item').forEach(function (el) {
      el.addEventListener('click', function () { selectMaskProject(el.getAttribute('data-maskproj')); });
      // 项目行右键：打开项目文件夹 / 项目设置（样式参考批量模式）
      el.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var pName = el.getAttribute('data-maskproj');
        var pItem = maskState.projects.find(function (x) { return x.name === pName; });
        showMenu(e.clientX, e.clientY, [
          { label: '打开项目文件夹', action: function () { if (pItem) openInShell(pItem.path); } },
          { label: '项目设置', action: function () { if (pName) openMaskProjectSettings(pName, pItem ? pItem.path : ''); } }
        ]);
      });
    });
  }
  // 遮罩项目设置弹窗（样式参考批量模式的 wm 弹窗）：默认输出目录，供底栏占位符与选择初始路径
  function openMaskProjectSettings(projectName, projPath) {
    call('get_mask_default_dir', projectName).then(function (curDir) {
      curDir = String(curDir || '').trim();
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card modal-card--wm';
      card.innerHTML =
        '<button type="button" class="modal-close" title="关闭">✕</button>' +
        '<div class="modal__title">项目设置</div>' +
        '<div class="modal__wm-body">' +
        '<div class="wm-section-title">默认输出文件夹</div>' +
        '<div class="wm-row"><span class="wm-row__label">输出路径</span><div class="wm-row__ops">' +
        '<input type="text" class="wm-row__input" id="maskDefaultOutInput" style="flex:1; min-width:0" placeholder="' + escapeHtml(projPath) + '" value="' + escapeHtml(curDir) + '" spellcheck="false">' +
        '<button type="button" class="modal-btn" id="maskDefaultOutPick">选择文件夹</button>' +
        '</div></div>' +
        '</div>' +
        '<div class="modal__actions">' +
        '<button type="button" class="modal-btn" data-mp2-act="cancel">取消</button>' +
        '<button type="button" class="modal-btn modal-btn--primary" data-mp2-act="save">保存</button>' +
        '</div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var inp = card.querySelector('#maskDefaultOutInput');
      function closeDlg() { overlay.remove(); }
      card.querySelector('#maskDefaultOutPick').addEventListener('click', function () {
        var cur = inp.value.trim() || curDir || projPath || '';
        call('pick_directory', '选择默认输出文件夹', cur).then(function (np) { if (np) inp.value = np; }).catch(function () {});
      });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDlg(); });
      card.querySelector('.modal-close').addEventListener('click', closeDlg);
      card.querySelector('[data-mp2-act="cancel"]').addEventListener('click', closeDlg);
      card.querySelector('[data-mp2-act="save"]').addEventListener('click', function () {
        var v = inp.value.trim();
        call('set_mask_default_dir', projectName, v).then(function (r) {
          if (!r || !r.ok) { toast('保存失败：' + ((r && r.error) || '未知错误'), true); return; }
          toast('已保存项目设置', 'ok');
          closeDlg();
          // 正在编辑该项目时刷新底栏占位符
          if (maskState.project && maskState.project.name === projectName) {
            maskState.defaultOutDir = v;
            buildMaskConfigBar();
          }
        }).catch(function (err) { toast('保存失败：' + err.message, true); });
      });
    }).catch(function (err) { toast('读取项目设置失败：' + err.message, true); });
  }
  function selectMaskProject(name) {
    var p = maskState.projects.find(function (x) { return x.name === name; });
    if (!p) return;
    // 重复点击当前已选中的项目：不触发任何重载/动画
    if (maskState.project && maskState.project.name === name) return;
    maskState.project = p;
    // 缺省值：先按无缓存状态初始化，随后按持久化会话恢复或自动扫描
    maskState.rawDirs = [];
    maskState.rawSel = {};
    maskState.themes = [{ path: p.path, name: p.name }];
    maskState.maskSel = {};
    maskState.maskLogBranch = ''; // 切换项目：日志分支回退到最新
    // 水印沿用设置页固定水印（enterMaskMode 已读入），切换项目不清空，避免误报「未选水印」
    maskState.outputDir = '';      // 空值走占位符默认目录（项目设置 - 默认输出目录）
    maskState.defaultOutDir = '';
    // 异步加载项目默认输出目录，用于底栏占位符与「选择目录」对话框初始路径
    call('get_mask_default_dir', p.name).then(function (d) {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      maskState.defaultOutDir = String(d || '').trim();
      buildMaskConfigBar();
    }).catch(function () {});
    // 切换项目：仅更新侧栏 active 高亮（不整树重建，列表已渲染），
    // 保证缎带展开/收回的 scaleX 过渡动画完整播放；不重建顶部栏，header/装饰由 data 切换驱动
    document.querySelectorAll('.mask-proj-item').forEach(function (el) {
      el.classList.toggle('mask-proj-item--active', el.getAttribute('data-maskproj') === name);
    });
    // 切换项目不立即渲染中间区：先用加载占位，等会话恢复/自动扫描完成后一次性渲染，
    // 避免「立即渲染 + 恢复后重绘」造成配置/日志视图各刷新两次
    buildMaskConfigBar();
    var cb0 = $('centerBottom');
    if (cb0) cb0.innerHTML = maskState.view === 'log'
      ? '<div class="mask-config__hint mask-config__hint--center">正在加载日志…</div>'
      : '<div class="mask-config__hint mask-config__hint--center">正在加载项目「' + escapeHtml(p.name) + '」…</div>';
    setStatus('已选择遮罩叠加项目：' + p.name);
    // 会话恢复/扫描完成后统一渲染一次（配置视图依赖恢复数据，日志视图此时初始化）
    function maskRerenderAfterRestore() {
      buildMaskCenter(); buildMaskConfigBar(); refreshMaskStartHint();
    }
    // 恢复持久化会话：有缓存（含外部添加目录、后缀；勾选与模式/输出目录不持久化）则恢复素材，
    // 模式/输出目录保持初始默认（模式=遮罩+水印，输出走项目默认目录占位）；无缓存自动扫描并落盘
    call('get_mask_session', p.name).then(function (sess) {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      if (sess && Array.isArray(sess.rawDirs)) {
        maskState.rawDirs = sess.rawDirs.map(function (d) { return { path: d.path, name: d.name, single: !!d.single }; });
        // 勾选不持久化记忆：一律从空开始（提交任务后已清空，此处忽略历史勾选）
        maskState.rawSel = {};
        maskState.maskSel = {};
        if (Array.isArray(sess.themes) && sess.themes.length) maskState.themes = sess.themes.map(function (t) { return { path: t.path, name: t.name, single: !!t.single }; });
        if (typeof sess.suffix === 'string') maskState.suffix = sess.suffix;
        maskRerenderAfterRestore();
        // 校验持久化目录有效性：不存在/为空的原片文件夹与失效外部遮罩目录从列表去除
        validateMaskDirs();
      } else {
        call('scan_mask_raw_dirs', p.path).then(function (dirs) {
          if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
          maskState.rawDirs = Array.isArray(dirs) ? dirs : [];
          maskRerenderAfterRestore();
          maskPersist();
        }).catch(function () {});
      }
    }).catch(function () {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      call('scan_mask_raw_dirs', p.path).then(function (dirs) {
        if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
        maskState.rawDirs = Array.isArray(dirs) ? dirs : [];
        maskRerenderAfterRestore();
      }).catch(function () {});
    });
    // 兜底：进入模式即选项目时默认水印/透明度可能尚未读入，补一次
    if (!maskState.watermark) {
      call('get_settings').then(function (cfg) {
        if (cfg && cfg.mask) {
          if (cfg.mask.watermark_mov) maskState.watermark = cfg.mask.watermark_mov;
          maskState.watermarkAlpha = (cfg.mask.watermark_alpha != null && String(cfg.mask.watermark_alpha).trim() !== '') ? String(cfg.mask.watermark_alpha).trim() : '';
          if (maskState.on) buildMaskConfigBar();
        }
      }).catch(function () {});
    }
  }
  function pathJoin(a, b) { return String(a).replace(/[\\/]+$/, '') + '\\' + String(b).replace(/^[\\/]+/, ''); }
  function buildMaskRight(isCenter) {
    if (!maskOn()) return;
    var panel = isCenter ? $('centerBottom') : $('rightPanelContent');
    if (!panel) return;
    if (!maskState.project) {
      if (!maskState.projects.length) {
        panel.innerHTML = '<div class="center-empty">' + icon('layers', 24, 'center-empty__icon') +
          '<span style="font-size:var(--body-sm-font-size)">暂无遮罩叠加项目<br>请在 菜单-设置-遮罩叠加 配置工作路径后重试</span></div>';
      } else {
        panel.innerHTML = '<div class="center-empty">' + icon('layers', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">请在左侧选择一个遮罩叠加项目</span></div>';
      }
      return;
    }
    var p = maskState.project;
    var html = '<div class="mask-config">';
    html += '<div class="mask-config__cols">';
    // ── 左栏：遮罩主题（标题固定，列表独立滚动） ──
    if (maskNeedMask()) {
      html += '<div class="mask-config__col mask-config__col--mask"><div class="mask-config__section-title"><span class="mask-config__title">遮罩</span>' +
        '<button type="button" class="mask-config__addbtn" id="maskAddThemeFile" title="添加单个遮罩文件（.mov）">' + icon('plus', 12) + '添加文件</button>' +
        '<button type="button" class="mask-config__addbtn" id="maskAddThemeDir" title="添加遮罩文件夹（其中 .mov 递归扫描）">' + icon('plus', 12) + '添加文件夹</button></div><div class="mask-config__list">';
      if (!maskState.themes.length) {
        html += '<div class="mask-config__hint mask-config__hint--center">项目下没有遮罩文件夹，请放入含 mov 的主题文件夹后刷新</div>';
      } else {
        html += '<div id="maskAllGroups"><div class="mask-files__loading mask-files__loading--bar">正在扫描遮罩…</div></div>';
      }
      html += '</div></div>';
    }
    // ── 右栏：原片选择（标题固定，列表独立滚动） ──
    html += '<div class="mask-config__col mask-config__col--raw"><div class="mask-config__section-title"><span class="mask-config__title">原片</span>' +
      '<button type="button" class="mask-config__addbtn" id="maskAddRawFile" title="添加单个原片文件（mp4 等视频）">' + icon('plus', 12) + '添加文件</button>' +
      '<button type="button" class="mask-config__addbtn" id="maskAddRawDir" title="添加原片文件夹（其中视频递归扫描）">' + icon('plus', 12) + '添加文件夹</button></div><div class="mask-config__list">';
    if (!maskState.rawDirs.length) {
      html += '<div class="mask-config__hint mask-config__hint--center">尚未选择原片文件夹</div>';
    } else {
      maskState.rawDirs.forEach(function (rd, i) {
        if (rd.files && rd.files.length === 0) return; // 已扫描且 0 素材：该原片文件夹不显示
        html += '<div class="mask-folder-row" data-rawfold="' + i + '" title="点击展开/收起文件列表">' +
          '<label class="mask-folder-row__check" title="全选/取消该文件夹全部素材"><input type="checkbox" data-rawall="' + i + '"><span class="mask-folder-row__box"></span></label>' +
          '<span class="mask-folder-row__name" title="' + escapeHtml(rd.path) + '">' + escapeHtml(rd.name) + '</span>' +
          '<span class="mask-folder-row__count" id="maskRawCount_' + i + '"></span>' +
          '<button type="button" class="mask-folder-row__del" data-rawdel="' + i + '" title="移除该文件夹">' + icon('x', 13) + '</button>' +
          '<span class="mask-folder-row__arrow"></span></div>';
        html += '<div class="mask-files" id="maskRawFiles_' + i + '" data-rawfiles="' + i + '"' + ((maskState.rawSel[rd.path] || []).length ? '' : ' style="display:none"') + '><div class="mask-files__loading">正在扫描…</div></div>';
      });
    }
    html += '</div></div>';
    html += '</div></div>';
    panel.innerHTML = html;
    // 绑定事件
    var po = $('maskOpenProj');
    if (po) po.addEventListener('click', function () { openInShell(p.path); });
    var ar = $('maskAddRawDir');
    if (ar) ar.addEventListener('click', function () { maskPickAdd('raw', 'dir'); });
    var arf = $('maskAddRawFile');
    if (arf) arf.addEventListener('click', function () { maskPickAdd('raw', 'file'); });
    var at = $('maskAddThemeDir');
    if (at) at.addEventListener('click', function () { maskPickAdd('theme', 'dir'); });
    var atf = $('maskAddThemeFile');
    if (atf) atf.addEventListener('click', function () { maskPickAdd('theme', 'file'); });
    // 两栏素材右键菜单：遮罩主题组/文件、原片文件 → 打开文件/在文件夹中显示/删除素材成片；原片文件夹行 → 打开文件夹
    panel.addEventListener('contextmenu', function (e) {
      var mkOpen = function (full) {
        showMenu(e.clientX, e.clientY, [
          { label: '打开文件', action: function () { openFileInShell(full); } },
          { label: '在文件夹中显示', action: function () { openInShell(full); } }
        ]);
      };
      var gf = e.target.closest('.mask-group-file');
      if (gf) { var gFull = gf.getAttribute('data-full'); if (gFull) { e.preventDefault(); mkOpen(gFull); } return; }
      var gh = e.target.closest('.mask-group-head');
      if (gh) { var hFull = gh.getAttribute('data-full'); if (hFull) { e.preventDefault(); mkOpen(hFull); } return; }
      var fi = e.target.closest('.mask-file-item');
      if (fi) {
        var fFull = fi.getAttribute('data-full');
        if (fFull) {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: '打开文件', action: function () { openFileInShell(fFull); } },
            { label: '在文件夹中显示', action: function () { openInShell(fFull); } }
          ]);
        }
        return;
      }
      var fr = e.target.closest('.mask-folder-row');
      if (fr) {
        var rd = maskState.rawDirs[parseInt(fr.getAttribute('data-rawfold'), 10)];
        if (rd && rd.path) { e.preventDefault(); showMenu(e.clientX, e.clientY, [{ label: '打开文件夹', action: function () { openInShell(rd.path); } }]); }
        return;
      }
    });
    // 遮罩主题：跨文件夹按 mov 名称前缀聚合分组，构建后直接加载展示
    if (maskNeedMask() && maskState.themes.length) loadAllMaskGroups();
    // 原片文件夹行：点击展开/收起文件列表（箭头旋转动画）；复选框/删除按钮区域不触发折叠
    panel.querySelectorAll('[data-rawfold]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('[data-rawdel]') || e.target.closest('.mask-folder-row__check')) return;
        var i = parseInt(row.getAttribute('data-rawfold'), 10);
        var box = document.getElementById('maskRawFiles_' + i);
        if (!box) return;
        var open = box.style.display === 'none';
        box.style.display = open ? '' : 'none';
        row.classList.toggle('mask-folder-row--open', open);
      });
    });
    // 原片文件夹移除
    panel.querySelectorAll('[data-rawdel]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var i = parseInt(b.getAttribute('data-rawdel'), 10);
        var rd = maskState.rawDirs[i];
        if (!rd) return;
        maskState.rawDirs.splice(i, 1);
        delete maskState.rawSel[rd.path];
        buildMaskCenter(); maskPersist();
      });
    });
    // 原片文件列表懒加载
    maskState.rawDirs.forEach(function (rd, i) {
      loadMaskRawFiles(rd, i);
    });
  }
  function pathResolveEq(a, b) {
    var x = String(a).replace(/[\\/]+$/, '').toLowerCase();
    var y = String(b).replace(/[\\/]+$/, '').toLowerCase();
    return x === y;
  }
  function loadMaskRawFiles(rd, i) {
    if (!maskOn()) return;
    var box = document.getElementById('maskRawFiles_' + i);
    if (!box) return;
    var projName = maskState.project ? maskState.project.name : '';
    var rdPath = rd.path;
    call('list_mask_videos', rdPath).then(function (files) {
      // 过期校验：异步探测期间切换了项目、或该目录已不在当前项目列表 → 丢弃本次结果，
      // 防止旧项目（如大目录慢扫描）的回调把计数/列表写到新项目同名索引的行上（数字串号）
      if (!maskOn() || !maskState.project || maskState.project.name !== projName) return;
      if (!(maskState.rawDirs || []).some(function (d) { return String(d.path) === rdPath; })) return;
      if (!box) return;
      files = Array.isArray(files) ? files : [];
      rd.files = files;
      var countEl = document.getElementById('maskRawCount_' + i);
      if (countEl) countEl.textContent = files.length + ' 个';
      if (!files.length) {
        // 0 素材：移除该原片文件夹行与占位列表，避免空文件夹留白
        var row = document.querySelector('[data-rawfold="' + i + '"]');
        if (row) row.remove();
        if (box) box.remove();
        refreshMaskStartHint();
        return;
      }
      // 同文件夹+时长一致视为一组；时长不一致拆多组，组名 = 文件夹名-序号（单组不加序号）
      // 分组按 ±1s 容差聚类（与时长校验阈值一致，避免 59.9s/60.1s 这种微小偏差被拆开）
      var rawGroups = [];
      // 分组以「文件夹优先」：同一子目录的素材归入同一组（避免不同文件夹里时长相等的文件被并成一组），
      // 组内再按「时长相近（±1s）」细分 —— 既保留细分能力，又不再跨文件夹合并
      files.forEach(function (f) {
        if (!f.rel) f.rel = f.sub ? f.sub + '/' + f.name : f.name;
        var d = f.dur || 0;
        var key = f.sub || '';   // 所属文件夹（相对子目录）；根目录下的文件同属一组
        var gi = -1;
        for (var gi2 = 0; gi2 < rawGroups.length; gi2++) {
          if (rawGroups[gi2].dir === key && Math.abs(rawGroups[gi2].dur - d) <= 1.0) { gi = gi2; break; }
        }
        if (gi < 0) { gi = rawGroups.length; rawGroups.push({ dir: key, dur: d, files: [] }); }
        rawGroups[gi].files.push(f);
      });
      var html = '';
      if (rawGroups.length > 1) {
        // 多时长分组：每个分组单独折叠，分组头带复选框（全选该组），组内片段单复选
        rawGroups.forEach(function (g, gi) {
          var gname = rd.name + '-' + (gi + 1);
          var selNames = maskState.rawSel[rd.path] || [];
          var inGroup = g.files.filter(function (f) { return selNames.indexOf(f.rel) >= 0; });
          var gany = inGroup.length > 0;
          var gall = gany && inGroup.length === g.files.length;
          var gid = i + '_' + gi;
          html += '<div class="mask-raw-group' + (gany ? ' mask-raw-group--open' : '') + '">' +
            '<div class="mask-raw-group__head" data-rawgrp="' + gid + '" title="点击展开/收起该组">' +
            '<label class="mask-raw-group__check" title="全选/取消该组素材"><input type="checkbox" data-rawgrpall="' + gid + '"' + (gall ? ' checked' : '') + '><span class="mask-raw-group__box"></span></label>' +
            '<span class="mask-raw-group__name">' + escapeHtml(gname) + '</span>' +
            '<span class="mask-raw-group__meta">' + g.files.length + ' 个 · ' + maskFmtDur(g.dur) + (g.dir ? ' · ' + escapeHtml(g.dir) : '') + '</span>' +
            '<span class="mask-raw-group__arrow"></span></div>' +
            '<div class="mask-raw-group__files"' + (gany ? '' : ' style="display:none"') + '>';
          g.files.forEach(function (f) {
            // 单文件项（用户直接添加的视频）：路径即文件本身，不能再往下拼文件名
            var full = rd.single ? rd.path : maskFullPath(rd.path, f.sub, f.name);
            var sel = selNames.indexOf(f.rel) >= 0;
            html += '<label class="mask-file-item" data-full="' + escapeHtml(full) + '"><input type="checkbox" data-vid="' + escapeHtml(f.rel) + '" data-dur="' + (f.dur || 0) + '"' + (sel ? ' checked' : '') + '>' +
              '<span class="mask-file-item__box"></span>' +
              '<span class="mask-file-item__name" title="' + escapeHtml(full) + '">' + (f.sub ? escapeHtml(f.sub) + '/' : '') + escapeHtml(f.name) + '</span>' +
              '<span class="mask-file-item__dur">' + maskFmtDur(f.dur) + '</span></label>';
          });
          html += '</div></div>';
        });
      } else {
        // 单时长分组：不显示分组头，所有文件直接平铺列出
        var g = rawGroups[0];
        g.files.forEach(function (f) {
          var full = rd.single ? rd.path : maskFullPath(rd.path, f.sub, f.name);
          var selNames = maskState.rawSel[rd.path] || [];
          var sel = selNames.indexOf(f.rel) >= 0;
          html += '<label class="mask-file-item" data-full="' + escapeHtml(full) + '"><input type="checkbox" data-vid="' + escapeHtml(f.rel) + '" data-dur="' + (f.dur || 0) + '"' + (sel ? ' checked' : '') + '>' +
            '<span class="mask-file-item__box"></span>' +
            '<span class="mask-file-item__name" title="' + escapeHtml(full) + '">' + (f.sub ? escapeHtml(f.sub) + '/' : '') + escapeHtml(f.name) + '</span>' +
            '<span class="mask-file-item__dur">' + maskFmtDur(f.dur) + '</span></label>';
        });
      }
      box.innerHTML = html;
      // 组头点击展开/收起组内列表（仅多分组时有）
      box.querySelectorAll('.mask-raw-group__head').forEach(function (head) {
        head.addEventListener('click', function (e) {
          // 点复选框本身不触发折叠
          if (e.target.closest('.mask-raw-group__check')) return;
          var grp = head.parentNode;
          var filesBox = grp.querySelector('.mask-raw-group__files');
          var open = grp.classList.toggle('mask-raw-group--open');
          if (filesBox) filesBox.style.display = open ? '' : 'none';
        });
      });
      // 分组头全选框：全选该组（跳过被时长禁用的片段），并联动片段复选框
      box.querySelectorAll('.mask-raw-group__head input[data-rawgrpall]').forEach(function (rc) {
        rc.addEventListener('change', function () {
          var gid = rc.getAttribute('data-rawgrpall');
          var g2 = rawGroups[parseInt(String(gid).split('_')[1], 10)];
          if (!g2) return;
          var set = (maskState.rawSel[rd.path] || []).slice();
          var grp = rc.closest('.mask-raw-group');
          if (rc.checked) {
            // 全选：跳过被时长禁用的片段（与文件夹行全选一致）
            g2.files.forEach(function (f) {
              var fc = grp.querySelector('input[data-vid="' + CSS.escape(f.rel) + '"]');
              if (fc && fc.disabled) return;
              if (set.indexOf(f.rel) < 0) set.push(f.rel);
            });
          } else {
            g2.files.forEach(function (f) {
              var k = set.indexOf(f.rel);
              if (k >= 0) set.splice(k, 1);
            });
          }
          maskState.rawSel[rd.path] = set;
          // 联动本组片段复选框 + 组头半选态
          grp.querySelectorAll('input[data-vid]').forEach(function (fc) {
            fc.checked = rc.checked && !fc.disabled;
          });
          rc.indeterminate = false;
          syncRawHead();
          maskSyncDurDisabled();
          refreshMaskStartHint();
          var selEl = document.getElementById('maskSelTotal');
          if (selEl) selEl.textContent = maskSelTotalText();
          maskPersist();
        });
      });
      // 原片分组头半选态：本组部分勾选时显示短横
      box.querySelectorAll('.mask-raw-group').forEach(function (grp) {
        var rc = grp.querySelector('input[data-rawgrpall]');
        if (!rc) return;
        var files = grp.querySelectorAll('input[data-vid]');
        var sel = 0;
        files.forEach(function (fc) { if (fc.checked) sel++; });
        if (sel > 0 && sel < files.length) rc.indeterminate = true;
      });
      // 组头全选框：按当前勾选状态设置 checked/半选，并绑定全选/取消全选联动
      var allCb = document.querySelector('.mask-folder-row [data-rawall="' + i + '"]');
      function syncRawHead() {
        if (!allCb) return;
        var set = maskState.rawSel[rd.path] || [];
        var all = set.length === files.length;
        var any = set.length > 0;
        allCb.checked = all;
        allCb.indeterminate = any && !all;
        return { all: all, any: any };
      }
      syncRawHead();
      if (allCb) allCb.addEventListener('change', function () {
        if (allCb.checked) {
          // 全选：跳过被时长禁用的文件，避免引入不配对的成片
          var add = [];
          box.querySelectorAll('input[data-vid]').forEach(function (fc) {
            if (!fc.disabled) { fc.checked = true; add.push(fc.getAttribute('data-vid')); }
          });
          maskState.rawSel[rd.path] = add;
        } else {
          box.querySelectorAll('input[data-vid]').forEach(function (fc) { fc.checked = false; });
          maskState.rawSel[rd.path] = [];
        }
        allCb.indeterminate = false;
        maskSyncGrpHeads();
        maskSyncDurDisabled();
        refreshMaskStartHint();
        var selEl = document.getElementById('maskSelTotal');
        if (selEl) selEl.textContent = maskSelTotalText();
        maskPersist();
      });
      box.querySelectorAll('input[data-vid]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var name = cb.getAttribute('data-vid');
          var cur = maskState.rawSel[rd.path] || [];
          var set = cur.slice();
          var k = set.indexOf(name);
          if (cb.checked && k < 0) set.push(name);
          if (!cb.checked && k >= 0) set.splice(k, 1);
          maskState.rawSel[rd.path] = set;
          syncRawHead();
          maskSyncGrpHeads();
          maskSyncDurDisabled();
          refreshMaskStartHint();
          var selEl = document.getElementById('maskSelTotal');
          if (selEl) selEl.textContent = maskSelTotalText();
          maskPersist();
        });
      });
      // 有勾选的组保持展开态
      box.querySelectorAll('.mask-raw-group').forEach(function (grp) {
        var has = (maskState.rawSel[rd.path] || []).some(function (n) { return grp.querySelector('input[data-vid="' + CSS.escape(n) + '"]'); });
        if (has) grp.classList.add('mask-raw-group--open');
      });
      // 文件加载完成：有勾选的文件夹保持展开箭头态；同时刷新底部提示、计数与时长禁用
      var rowEl = document.querySelector('[data-rawfold="' + i + '"]');
      if (rowEl && (maskState.rawSel[rd.path] || []).length > 0) rowEl.classList.add('mask-folder-row--open');
      maskSyncDurDisabled();
      refreshMaskStartHint();
      var selEl2 = document.getElementById('maskSelTotal');
      if (selEl2) selEl2.textContent = maskSelTotalText();
    }).catch(function () {
      if (box) box.innerHTML = '<div class="mask-config__hint mask-config__hint--center">扫描失败</div>';
    });
  }
  // 主题完整路径（sub 含子文件夹，用 '/' 分隔）
  function maskFullPath(themePath, sub, name) {
    var p = themePath;
    if (sub) p = String(p).replace(/[\\/]+$/, '') + '\\' + String(sub).replace(/\//g, '\\');
    return String(p).replace(/[\\/]+$/, '') + '\\' + name;
  }
  // 加载全部主题的遮罩并跨文件夹按 mov 名称前缀+时长聚合分组展示：
  // 组为折叠容器（组头全选/取消全选），组内 mov 可单独勾选
  function loadAllMaskGroups() {
    if (!maskOn()) return;
    var box = $('maskAllGroups');
    if (!box) return;
    var projName = maskState.project ? maskState.project.name : '';
    var themeSnap = (maskState.themes || []).slice();
    Promise.all(themeSnap.map(function (t) {
      return call('list_mask_masks', t.path).catch(function () { return []; });
    })).then(function (results) {
      // 过期校验：异步扫描期间切换了项目 → 丢弃旧项目主题结果（防与新项目主题错配串号）；
      // 主题列表用请求时的快照，避免回调读取已被新项目替换的 maskState.themes[i] 错位
      if (!maskOn() || !maskState.project || maskState.project.name !== projName) return;
      var files = [];
      results.forEach(function (list, i) {
        var t = themeSnap[i];
        (Array.isArray(list) ? list : []).forEach(function (f) {
          files.push({ full: t.single ? t.path : maskFullPath(t.path, f.sub, f.name), name: f.name, sub: f.sub || '', dur: f.dur || 0 });
        });
      });
      if (!files.length) { box.innerHTML = '<div class="mask-config__hint mask-config__hint--center">无遮罩文件</div>'; return; }
      // 遮罩时长映射：{ 完整路径: 时长秒 } 供开始前两两时长强校验使用（界面勾选只存路径）
      var durMap = {};
      files.forEach(function (f) { if (f.dur > 0) durMap[f.full] = f.dur; });
      maskState.maskDur = durMap;
      var groups = {};
      var order = [];
      files.forEach(function (f) {
        var prefix = maskGroupPrefix(f.name);
        // 分组仅以 mov 名称前缀为准（不计时长）：前缀相同即一组，避免同主题按时长被拆开
        if (!groups[prefix]) { groups[prefix] = { prefix: prefix, dur: f.dur || 0, files: [] }; order.push(prefix); }
        groups[prefix].files.push(f);
      });
      // 徽章同步：右栏实际主题组数（含「添加遮罩目录」等外部目录），与左侧当前项目徽章对齐
      var badge = document.querySelector('.mask-proj-item--active .mask-proj-item__badge');
      if (badge) badge.textContent = order.length + '种遮罩';
      var html = '';
      var groupsArr = [];
      var gid = 0;
      // 按 mov 名称前缀的拼音首字母聚合分组（参考配置管理模式配置列表），字母升序 + 分组头
      var letterMap = {};
      order.forEach(function (key) {
        var g = groups[key];
        // 分组头以去重后的显示名为准（如「项目A-中秋节」按「中秋节」参与字母分组）
        var L = azInitial(maskDisplayName(g.prefix));
        if (!letterMap[L]) letterMap[L] = [];
        letterMap[L].push(g);
      });
      var azOrder = AZ_KEYS.concat('#');
      Object.keys(letterMap).sort(function (a, b) { return azOrder.indexOf(a) - azOrder.indexOf(b); }).forEach(function (L) {
        html += '<div class="mask-letter-head"><span class="mask-letter-head__label">' + escapeHtml(L) + '</span><span class="mask-letter-head__line"></span></div>';
        letterMap[L].forEach(function (g) {
          var allSel = g.files.every(function (f) { return maskState.maskSel[f.full] === true; });
          var anySel = g.files.some(function (f) { return maskState.maskSel[f.full] === true; });
          var single = g.files.length <= 1;
          var gi = gid++;
          groupsArr.push(g);
          if (single) {
            // 单文件主题：渲染为与多文件主题组头同级的单个主题行（checkbox+主题名+时长），
            // 不缩进、不出现「组头+子项」两行，与其他主题并排左对齐
            var f0 = g.files[0];
            var s0 = maskState.maskSel[f0.full] === true;
            html += '<div class="mask-group mask-group--single">' +
              '<div class="mask-group-head mask-group-head--single" data-full="' + escapeHtml(f0.full) + '">' +
              '<label class="mask-group-head__check"><input type="checkbox" data-grpall="' + gi + '" data-dur="' + (f0.dur || 0) + '"' + (s0 ? ' checked' : '') + '><span class="mask-group-head__box"></span></label>' +
              '<span class="mask-group-head__name" title="' + escapeHtml(f0.full) + '">' + escapeHtml(maskDisplayName(g.prefix)) + '</span>' +
              '<span class="mask-group-head__meta">' + maskFmtDur(f0.dur) + '</span></div></div>';
          } else {
            var gHeadTip = g.files[0].full + (g.files.length > 1 ? '\n（共 ' + g.files.length + ' 个文件）' : '');
            html += '<div class="mask-group">' +
              '<div class="mask-group-head' + (anySel ? ' mask-group-head--open' : '') + '" data-full="' + escapeHtml(g.files[0].full) + '">' +
              '<label class="mask-group-head__check"><input type="checkbox" data-grpall="' + gi + '"' + (allSel ? ' checked' : '') + '><span class="mask-group-head__box"></span></label>' +
              '<span class="mask-group-head__name" title="' + escapeHtml(gHeadTip) + '">' + escapeHtml(maskDisplayName(g.prefix)) + '</span>' +
              '<span class="mask-group-head__meta">' + g.files.length + ' 个' + '</span>' +
              '<span class="mask-group-head__arrow"></span></div>' +
              '<div class="mask-group-files"' + (anySel ? '' : ' style="display:none"') + '>';
            g.files.forEach(function (f, fi) {
              var sel = maskState.maskSel[f.full] === true;
              html += '<label class="mask-group-file" data-full="' + escapeHtml(f.full) + '"><input type="checkbox" data-grpfile="' + gi + '_' + fi + '" data-dur="' + (f.dur || 0) + '"' + (sel ? ' checked' : '') + '>' +
                '<span class="mask-group-file__box"></span>' +
                '<span class="mask-group-file__name" title="' + escapeHtml(f.full) + '">' + (f.sub ? escapeHtml(maskDisplayName(f.sub)) + '/' : '') + escapeHtml(maskDisplayName(f.name)) + '</span>' +
                '<span class="mask-group-file__meta">' + maskFmtDur(f.dur) + '</span></label>';
            });
            html += '</div></div>';
          }
        });
      });
      box.innerHTML = html;
      // 组头半选态（indeterminate）：部分勾选时显示短横（常规复选框组联动的标准形态）
      box.querySelectorAll('input[data-grpall]').forEach(function (cb) {
        var g = groupsArr[parseInt(cb.getAttribute('data-grpall'), 10)];
        if (g) { var st0 = refreshHead(g); cb.indeterminate = st0.any && !st0.all; }
      });
      function refreshHead(g) {
        return { all: g.files.every(function (f) { return maskState.maskSel[f.full] === true; }), any: g.files.some(function (f) { return maskState.maskSel[f.full] === true; }) };
      }
      function updateSelCount() {
        var el = document.getElementById('maskSelTotal');
        if (el) el.textContent = maskSelTotalText();
      }
      updateSelCount();
      maskSyncDurDisabled();
      // 组头：全选 / 取消全选（联动组内复选框，避免「组头勾选、组内为空」的误会）
      box.querySelectorAll('input[data-grpall]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var g = groupsArr[parseInt(cb.getAttribute('data-grpall'), 10)];
          if (!g) return;
          var grp = cb.closest('.mask-group');
          var fcs = grp.querySelectorAll('input[data-grpfile]');
          if (cb.checked) {
            // 全选：跳过被时长禁用的文件（与原片全选行为一致）
            g.files.forEach(function (f, fi) {
              var fc = fcs[fi];
              if (fc && fc.disabled) return;
              maskState.maskSel[f.full] = true;
            });
          } else {
            g.files.forEach(function (f) {
              delete maskState.maskSel[f.full];
            });
          }
          // 同步复选框显示：仅对未禁用文件同步勾选状态
          fcs.forEach(function (fc) {
            if (!fc.disabled) fc.checked = cb.checked;
          });
          cb.indeterminate = false;
          var filesBox = grp.querySelector('.mask-group-files');
          if (filesBox && !grp.classList.contains('mask-group--single')) filesBox.style.display = cb.checked ? '' : 'none';
          maskSyncDurDisabled();
          buildMaskConfigBar();
          updateSelCount();
          maskPersist();
        });
      });
      // 组内单个 mov：同步组头全选/半选；无勾选时隐藏组内列表
      box.querySelectorAll('input[data-grpfile]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var part = String(cb.getAttribute('data-grpfile')).split('_');
          var g = groupsArr[parseInt(part[0], 10)];
          var f = g && g.files[parseInt(part[1], 10)];
          if (!g || !f) return;
          if (cb.checked) maskState.maskSel[f.full] = true;
          else delete maskState.maskSel[f.full];
          var st = refreshHead(g);
          var headCb = cb.closest('.mask-group').querySelector('input[data-grpall]');
          if (headCb) { headCb.checked = st.all; headCb.indeterminate = st.any && !st.all; }
          var filesBox = cb.closest('.mask-group').querySelector('.mask-group-files');
          if (filesBox && !cb.closest('.mask-group').classList.contains('mask-group--single')) filesBox.style.display = st.any ? '' : 'none';
          maskSyncDurDisabled();
          buildMaskConfigBar();
          updateSelCount();
          maskPersist();
        });
      });
      // 组头点击展开/折叠组内列表（单文件组恒展开，点击无折叠）；复选框区域只勾选不折叠
      box.querySelectorAll('.mask-group-head').forEach(function (hd) {
        hd.addEventListener('click', function (e) {
          if (e.target.closest('.mask-group-head__check')) return;
          if (hd.classList.contains('mask-group-head--single')) return;
          var filesBox = hd.parentNode.querySelector('.mask-group-files');
          if (!filesBox) return;
          filesBox.style.display = filesBox.style.display === 'none' ? '' : 'none';
          hd.classList.toggle('mask-group-head--open', filesBox.style.display !== 'none');
        });
      });
    }).catch(function () { box.innerHTML = '<div class="mask-config__hint mask-config__hint--center">扫描失败</div>'; });
  }
  // 日志视图：加载遮罩叠加日志并渲染到中间区（搜索过滤 / 删除 / 迁移 / 素材删除 / 二次产物）
  function buildMaskLogView() {
    if (!maskOn()) return;
    var box = $('centerBottom');
    if (!box) return;
    if (!maskState.project) {
      box.innerHTML = '<div class="center-empty">' + icon('layers', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">请在左侧选择一个遮罩叠加项目</span></div>';
      return;
    }
    var q = (maskState.search || '').toLowerCase();
    call('list_mask_logs', maskState.project.path).then(function (logs) {
      var allLogs = Array.isArray(logs) ? logs : [];
      // 分支按钮先定（含默认选中最新），随后判断渲染幂等
      buildMaskLogBranches(allLogs);
      // 渲染幂等：同一项目+分支+搜索词 且 日志文件(mtime)未变化时跳过重复渲染，
      // 避免切换项目/会话恢复/自愈轮询等入口对同一份日志反复重绘
      var sig = maskState.project.path + '\u0000' + (maskState.maskLogBranch || '') + '\u0000' + q + '\u0000' +
        allLogs.map(function (l) { return l.path + '@' + Math.round(l.mtime || 0); }).join(',');
      if (maskState._logRenderSig === sig) return;
      maskState._logRenderSig = sig;
      if (!allLogs.length) {
        box.innerHTML = '<div class="mask-config__hint mask-config__hint--center">暂无遮罩日志（任务完成后生成）</div>';
        return;
      }
      // 过滤到当前选中的日期分支；分支失效则回退最新
      var branchLogs = allLogs.filter(function (l) { return l.path === (maskState.maskLogBranch || ''); });
      if (!branchLogs.length) {
        maskState.maskLogBranch = '';
        buildMaskLogBranches(allLogs);
        branchLogs = allLogs.filter(function (l) { return l.path === (maskState.maskLogBranch || ''); });
      }
      // 渲染对齐批量日志：所选日期分支下直接列出成片条目（文件头角色已由顶部日期分支按钮承担）
      var html = '';
      var showed = 0;
      branchLogs.forEach(function (log) {
        var entries = (log.entries || []).filter(function (e) { return !q || String(e.video || '').toLowerCase().indexOf(q) >= 0; });
        entries.forEach(function (e) {
          showed++;
          var clips = e.clips || [];
          html += '<div class="log-entry" data-log-path="' + escapeHtml(log.path) + '" data-video="' + escapeHtml(e.video || '') + '" data-out="' + escapeHtml(e.outPath || '') + '">' +
            '<div class="log-entry__header">' +
            '<span class="log-entry__arrow">' + icon('chevron-right', 14) + '</span>' + icon('video', 14) +
            '<span class="log-entry__video-name" title="' + escapeHtml(e.outPath || e.video) + '">' + escapeHtml(e.video || '（未命名成片）') + '</span>' +
            '<span class="log-entry__clip-count">' + clips.length + ' 素材</span>' +
            '<button type="button" class="mask-log-entry__del" data-delone="' + escapeHtml(e.video) + '" title="删除该成片">' + icon('trash-2', 14) + '</button></div>';
          html += '<div class="log-entry__clips" style="display:none">';
          clips.forEach(function (c) {
            html += '<div class="log-entry__clip" data-clip="' + escapeHtml(c) + '" title="删除所有使用该素材的成片：' + escapeHtml(baseNameNoExt(c)) + '">' + icon('layers', 12) + '<span class="log-entry__clip-path" title="' + escapeHtml(c) + '">' + escapeHtml(baseNameNoExt(c)) + '</span></div>';
          });
          html += '</div></div>';
        });
      });
      if (!showed) {
        box.innerHTML = '<div class="mask-config__hint mask-config__hint--center">' + (q ? '未找到匹配日志' : '暂无遮罩日志（任务完成后生成）') + '</div>';
        return;
      }
      box.innerHTML = '<div class="log-list">' + html + '</div>';
      // 个人操作：迁移单成片 / 删除单成片 / 删除相关成片（按钮与右键菜单共用）
      function doMoveOne(vn) {
        call('pick_single_folder').then(function (nd) {
          if (!nd) return;
          call('move_mask_out', maskState.project.path, vn, nd).then(function (r) {
            if (!r || !r.ok) { setStatus('迁移失败：' + ((r && r.error) || '未知错误')); return; }
            toast('已迁移成片：' + baseNameNoExt(r.to || vn), 'ok');
            buildMaskLogView();
          }).catch(function (err) { setStatus('迁移失败：' + err.message); });
        }).catch(function () {});
      }
      function doDeleteOne(vn) {
        confirmPopover({ title: '删除成片', message: '将删除成片「' + vn + '」，日志中同步移除该条目', okLabel: '删除', danger: true }).then(function (v) {
          if (!v) return;
          call('delete_mask_videos', maskState.project.path, [vn]).then(function (r) {
            if (!r || !r.ok) { maskTellResult('删除失败', ((r && r.error) || '未知错误')); return; }
            maskTellResult('删除结果', '已删除 ' + ((r.deleted || []).length) + ' 个成片');
            buildMaskLogView();
          }).catch(function (err) { maskTellResult('删除失败', err.message); });
        });
      }
      // 条目标题点击：展开/收起素材列表（箭头随状态旋转）；删除按钮区域不触发
      box.querySelectorAll('.log-entry').forEach(function (row) {
        var head = row.querySelector('.log-entry__header');
        if (!head) return;
        head.addEventListener('click', function (e) {
          if (e.target.closest('[data-delone]')) return;
          var clips = row.querySelector('.log-entry__clips');
          if (!clips) return;
          var open = clips.style.display !== 'none';
          clips.style.display = open ? 'none' : '';
          row.classList.toggle('log-entry--open', !open);
        });
      });
      // 单成片删除按钮
      box.querySelectorAll('[data-delone]').forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); doDeleteOne(b.getAttribute('data-delone')); });
      });
      // 片段行左键仅展开/收起素材所属成片条目，不绑定删除
      // 右键菜单：片段行（打开片段/片段文件夹）在前，
      // 成片条目在后——片段位于条目内部，先判片段避免被成片菜单拦截
      box.oncontextmenu = function (e) {
        var cp = e.target.closest('.log-entry__clip');
        if (cp) {
          e.preventDefault();
          var clip = cp.getAttribute('data-clip');
          if (!clip) return;
          showMenu(e.clientX, e.clientY, [
            { label: '打开片段', action: function () { openFileInShell(clip); } },
            { label: '片段文件夹', action: function () { openInShell(clip); } }
          ]);
          return;
        }
        var ent = e.target.closest('.log-entry');
        if (ent) {
          e.preventDefault();
          var video = ent.getAttribute('data-video') || '';
          var out = ent.getAttribute('data-out') || '';
          var lp = ent.getAttribute('data-log-path') || '';
          // 成片定位参考批量日志：优先日志 @out 路径；缺失则日志目录 + 成片名（补 .mp4）兜底
          var fname = video.trim();
          if (fname && !/\.mp4$/i.test(fname)) fname += '.mp4';
          var logDir = String(lp).replace(/[\\/]+/g, '\\').replace(/\\[^\\]*$/, '');
          var openPath = out || ((fname && logDir) ? logDir + '\\' + fname : '');
          var outDir = out ? String(out).replace(/[\\/]+/g, '\\').replace(/\\[^\\]*$/, '') : '';
          var itemOpen = { label: '打开成片', disabled: false, title: '', action: function () { if (openPath) openFileInShell(openPath); } };
          var itemFolder = { label: '打开成片文件夹', disabled: false, title: '', action: function () {
              if (openPath) openFileInShell(openPath);
              else if (outDir || logDir) openInShell(outDir || logDir);
            } };
          var itemMove = { label: '迁移该成片', disabled: false, title: '', action: function () { if (video && openPath) doMoveOne(video); } };
          var itemRelocate = { label: '重新定位', disabled: !!openPath, title: openPath ? '成片已可定位' : '', action: function () { if (video) relocateMaskVideo(lp, video); } };
          var itemDelete = { label: '删除该成片', action: function () { if (video) doDeleteOne(video); } };
          var items3 = [itemOpen, itemFolder, itemMove, itemRelocate, itemDelete];
          var finish3 = function () { showMenu(e.clientX, e.clientY, items3); };
          if (openPath) {
            call('check_exists', [openPath]).then(function (map) {
              map = map || {};
              if (map[openPath] === false) {
                // 成片缺失：打开/文件夹/迁移置灰（无源文件），重新定位可用
                itemOpen.disabled = true; itemOpen.title = '成片文件不存在';
                itemFolder.disabled = true; itemFolder.title = '成片文件不存在';
                itemMove.disabled = true; itemMove.title = '成片文件不存在';
                itemRelocate.disabled = false; itemRelocate.title = '';
              } else {
                itemRelocate.disabled = true; itemRelocate.title = '成片已可定位';
              }
              finish3();
            }).catch(function () { itemRelocate.disabled = false; itemRelocate.title = ''; finish3(); });
          } else {
            // 无 @out 也无日志目录兜底：打开/文件夹/迁移置灰，重新定位可用
            itemOpen.disabled = true; itemOpen.title = '无法定位成片文件';
            itemFolder.disabled = true; itemFolder.title = '无法定位成片文件';
            itemMove.disabled = true; itemMove.title = '无法定位成片文件';
            itemRelocate.disabled = false; itemRelocate.title = '';
            finish3();
          }
          return;
        }
      };
    }).catch(function () { box.innerHTML = '<div class="mask-config__hint mask-config__hint--center">加载日志失败</div>'; });
  }
  // 遮罩日志顶部日期分支：每个日志文件一个按钮，标签 MMDD-遮罩短名；
  // 同 日期+短名 多次生成时按时间旧=1 新=2 递增序号，当日单次无序号
  function maskLogBranchList(allLogs) {
    var proj = maskState.project && maskState.project.name;
    var items = (allLogs || []).map(function (log) {
      var base = String(log.path || '').replace(/[\\/]+/g, '\\').split('\\').pop() || '';
      var m = /^(\d{4})-(\d+时\d+分)-(.*)-遮罩日志\.txt$/i.exec(base);
      var date = m ? m[1] : '';
      var raw = (m ? m[3] : base.replace(/\.txt$/i, '')).trim();
      var short = raw;
      if (proj && short.indexOf(proj + '-') === 0) short = short.slice(proj.length + 1);
      return { path: log.path, date: date, short: short, timeKey: (m ? String(m[2]).replace(/时/, '').replace(/分/, '') : '') };
    });
    var groups = {};
    items.forEach(function (it) {
      var key = it.date + '|' + it.short;
      if (!groups[key]) groups[key] = [];
      groups[key].push(it);
    });
    var out = [];
    if (items.length) {
      Object.keys(groups).forEach(function (key) {
        var arr = groups[key].slice().sort(function (a, b) { return (a.timeKey || '').localeCompare(b.timeKey || ''); });
        arr.forEach(function (it, i) {
          out.push({ path: it.path, date: it.date, label: it.date + '-' + it.short + (arr.length > 1 ? '-' + (i + 1) : '') });
        });
      });
      // 日期倒序（新在前），同日期按标签升序
      out.sort(function (a, b) { return b.date.localeCompare(a.date) || a.label.localeCompare(b.label); });
    } else {
      out.push({ path: '', date: '', label: '无日志' });
    }
    return out;
  }
  function buildMaskLogBranches(allLogs) {
    var c = $('maskDateBranches');
    if (!c) return;
    var branches = maskLogBranchList(allLogs);
    if (!(allLogs || []).length) {
      c.innerHTML = '<span class="date-branch-btn">无日志</span>';
      maskState.maskLogBranch = '';
      maskState._branchSetSig = '';
      return;
    }
    if (!maskState.maskLogBranch || !branches.some(function (b) { return b.path === maskState.maskLogBranch; })) {
      maskState.maskLogBranch = branches[0].path; // 默认最新分支（排序后首位）
    }
    // 加载动画控制：仅在「分支集合变化」（初次进入/切换项目/日志增删）时触发；
    // 同项目内切换日期分支或重复渲染时静止（--static），避免每次点击分支都重演进场
    var setSig = branches.map(function (b) { return b.path; }).join('|');
    var silent = maskState._branchSetSig != null && maskState._branchSetSig === setSig;
    maskState._branchSetSig = setSig;
    var html = '';
    branches.forEach(function (b) {
      var active = b.path === maskState.maskLogBranch;
      html += '<button class="date-branch-btn' + (active ? ' date-branch-btn--active' : '') + (silent ? ' date-branch-btn--static' : '') + '" data-masklog="' + escapeHtml(b.path) + '" title="' + escapeHtml(b.path) + '">' + escapeHtml(b.label) + '</button>';
    });
    c.innerHTML = html;
  }
  // 迁移某日期分支（日志文件）下全部成片到同一新文件夹（逐个迁移，同步更新日志 @out）；
  // 由日期分支按钮右键菜单触发，每次按最新日志数据执行
  function doMoveLogAll(lp) {
    if (!maskOn() || !maskState.project) return;
    call('list_mask_logs', maskState.project.path).then(function (logs) {
      var allLogs = Array.isArray(logs) ? logs : [];
      var lg = allLogs.find(function (x) { return x.path === lp; });
      var names = ((lg && lg.entries) || []).map(function (en) { return en.video; }).filter(Boolean);
      if (!names.length) { setStatus('该日志无成片可迁移'); return; }
      call('pick_single_folder').then(function (nd) {
        if (!nd) return;
        var k = 0;
        (function next() {
          if (k >= names.length) { toast('已迁移 ' + names.length + ' 个成片', 'ok'); buildMaskLogView(); return; }
          var vn2 = names[k++];
          call('move_mask_out', maskState.project.path, vn2, nd).then(function (r) {
            if (!r || !r.ok) { setStatus('迁移失败：' + ((r && r.error) || '未知错误')); return; }
            next();
          }).catch(function (err) { setStatus('迁移失败：' + err.message); });
        })();
      }).catch(function () {});
    }).catch(function () {});
  }

  // 遮罩日志日期分支右键菜单：在文件夹中显示（找不到成片置灰禁用）/ 打开日志文件 / 迁移全部成片 / 重新定位 / 移除该日志
  function openMaskBranchMenu(x, y, mfp) {
    call('list_mask_logs', maskState.project.path).then(function (logs) {
      var lg = (Array.isArray(logs) ? logs : []).find(function (l) { return l.path === mfp; });
      var entries = (lg && Array.isArray(lg.entries)) ? lg.entries : [];
      var outPaths = entries.map(function (en) { return en.outPath; }).filter(Boolean);
      // 成片存在性：任一 @out 存在即可打开/迁移；全部缺失则置灰并启用重新定位
      var shown = false;
      var show = function (anyExists) {
        if (shown) return; shown = true;
        var openOut = { label: '在文件夹中显示', disabled: !anyExists, title: anyExists ? '' : '找不到成片', action: function () {
            for (var i = 0; i < entries.length; i++) { if (entries[i].outPath) { openInShell(entries[i].outPath); return; } }
          } };
        showMenu(x, y, [
          openOut,
          { label: '打开日志文件', action: function () { openFileInShell(mfp); } },
          { label: '打开日志文件夹', action: function () { openInShell(mfp); } },
          { label: '迁移该日志全部成片', disabled: !anyExists, title: anyExists ? '' : '找不到成片，无法迁移', action: function () { doMoveLogAll(mfp); } },
          { label: '重新定位', disabled: anyExists, title: anyExists ? '成片均已定位' : '', action: function () { relocateMaskBranch(mfp); } },
          { label: '移除该日志', action: function () { removeMaskLog(mfp); } }
        ]);
      };
      if (!outPaths.length) { show(false); return; } // 无任何 @out：打开/迁移置灰，重新定位可用
      var exist = 0;
      call('check_exists', outPaths).then(function (map) {
        map = map || {};
        for (var i = 0; i < outPaths.length; i++) { if (map[outPaths[i]]) exist++; }
        show(exist > 0);
      }).catch(function () { show(false); });
    }).catch(function () {
      showMenu(x, y, [ { label: '移除该日志', action: function () { removeMaskLog(mfp); } } ]);
    });
  }

  // 移除遮罩日志：仅移除该日志（新接口 delete_mask_log，不再依赖批量工作路径）/ 连同成片移除（成片文件 + 日志条目块，日志清空自动删文件）
  function removeMaskLog(mfp) {
    showDialog({
      title: '移除遮罩日志',
      message: mfp + '\n\n请选择移除方式：\n' +
        '· 仅移除该日志：只删除当前【日志】文件\n' +
        '· 连同成片移除：删除日志文件及其中全部成片视频',
      buttons: [
        { label: '仅移除该日志', value: 'txt', primary: true },
        { label: '连同成片移除', value: 'videos', danger: true }
      ]
    }).then(function (v) {
      if (!v) return;
      if (v === 'txt') {
        call('delete_mask_log', maskState.project.path, mfp).then(function (r) {
          if (!(r && r.ok)) { setStatus('移除失败：' + ((r && r.error) || '未知错误')); return; }
          toast('已移除遮罩日志', 'ok'); buildMaskLogView();
        }).catch(function (err) { setStatus('移除失败：' + err.message); });
        return;
      }
      // 连同成片：取该日志全部成片名一并删除（成片文件 + 日志条目块），日志清空会自动删文件
      call('list_mask_logs', maskState.project.path).then(function (logs) {
        var lg = (Array.isArray(logs) ? logs : []).find(function (x) { return x.path === mfp; });
        var names = (lg && Array.isArray(lg.entries) ? lg.entries : []).map(function (e) { return e.video; }).filter(Boolean);
        if (!names.length) {
          call('delete_mask_log', maskState.project.path, mfp).then(function (r2) {
            if (!(r2 && r2.ok)) { setStatus('移除失败：' + ((r2 && r2.error) || '未知错误')); return; }
            toast('已移除遮罩日志', 'ok'); buildMaskLogView();
          }).catch(function (err) { setStatus('移除失败：' + err.message); });
          return;
        }
        call('delete_mask_videos', maskState.project.path, names).then(function (r) {
          if (!(r && r.ok)) { setStatus('删除失败：' + ((r && r.error) || '未知错误')); return; }
          toast('已删除 ' + ((r.deleted || []).length) + ' 个成片及其日志', 'ok');
          buildMaskLogView();
        }).catch(function (err) { setStatus('删除失败：' + err.message); });
      }).catch(function () { setStatus('读取遮罩日志失败'); });
    });
  }

  // 重新定位单个成片（列表行右键）：成片被外部移动后选新目录，按文件名在目录内（含子目录）重新查找并写回日志 @out
  function relocateMaskVideo(lp, videoName) {
    if (!maskOn() || !maskState.project) return;
    call('pick_single_folder').then(function (nd) {
      if (!nd) return;
      call('relocate_mask_out', maskState.project.path, videoName, nd).then(function (r) {
        if (!r || !r.ok) { setStatus('重新定位失败：' + ((r && r.error) || '未知错误')); return; }
        toast('已重新定位成片：' + baseNameNoExt(r.path || videoName) + (r.noLog ? '（日志中无该成片记录）' : ''), 'ok');
        buildMaskLogView();
      }).catch(function (err) { setStatus('重新定位失败：' + err.message); });
    }).catch(function () {});
  }

  // 重新定位某日期分支下全部缺失成片（分支右键）：一次选择新目录，缺失成片按文件名逐一在目录内查找并写回日志 @out
  function relocateMaskBranch(lp) {
    if (!maskOn() || !maskState.project) return;
    call('list_mask_logs', maskState.project.path).then(function (logs) {
      var lg = (Array.isArray(logs) ? logs : []).find(function (x) { return x.path === lp; });
      var entries = (lg && Array.isArray(lg.entries)) ? lg.entries : [];
      // 缺失判定：@out 为空，或 @out 记录的路径不存在（文件被外部移动后仍留旧路径）→ 均需重新定位
      var missing = entries.filter(function (en) { return !en.outPath; }).map(function (en) { return en.video; }).filter(Boolean);
      var probeMissing = entries.filter(function (en) { return en.outPath; });
      if (missing.length) {
        relocateMaskBranchGo(lp, missing);
        return;
      }
      if (!probeMissing.length) { setStatus('该日志无成片'); return; }
      var outs = probeMissing.map(function (en) { return en.outPath; });
      call('check_exists', outs).then(function (map) {
        map = map || {};
        var gone = probeMissing.filter(function (en) { return !map[en.outPath]; }).map(function (en) { return en.video; }).filter(Boolean);
        if (!gone.length) { setStatus('该日志全部成片均已定位'); return; }
        relocateMaskBranchGo(lp, gone);
      }).catch(function () { setStatus('读取成片状态失败'); });
    }).catch(function () { setStatus('读取遮罩日志失败'); });
  }
  // 分支重新定位执行体：选目录 → 对缺失成片逐一按文件名定位
  function relocateMaskBranchGo(lp, missingNames) {
    call('pick_single_folder').then(function (nd) {
      if (!nd) return;
      var okN = 0, failN = 0;
      var k = 0;
      (function next() {
        if (k >= missingNames.length) {
          setStatus('重新定位完成：成功 ' + okN + ' / 失败 ' + failN + (failN ? '（失败可手动选择对应文件夹）' : ''));
          buildMaskLogView();
          return;
        }
        var vn3 = missingNames[k++];
        call('relocate_mask_out', maskState.project.path, vn3, nd).then(function (r) {
          if (r && r.ok) okN++; else failN++;
          next();
        }).catch(function () { failN++; next(); });
      })();
    }).catch(function () {});
  }

  // 生效的输出目录：显式输入 > 项目默认 > 项目路径
  function maskEffectiveOutDir() {
    var v = (maskState.outputDir || '').trim();
    if (v) return v;
    if ((maskState.defaultOutDir || '').trim()) return maskState.defaultOutDir.trim();
    return maskState.project ? maskState.project.path : '';
  }
  function buildMaskConfigBar() {
    if (!maskOn()) return;
    var bar = $('configBar');
    if (!bar) return;
    // 排版：左 输出目录（路径栏拉长；空值以占位符显示默认目录）；右 后缀/模式（开始制作左侧）→ 开始制作
    var projPath = maskState.project ? maskState.project.path : '';
    var outPlaceholder = maskState.defaultOutDir || projPath || '必填，可直接输入或点击右侧选择';
    var html = '<div class="config-bar__left">' +
      '<label class="config-bottombar__label">输出文件夹</label>' +
      '<input type="text" class="config-bottombar__input mask-bar__outdir" id="maskOutDir" value="' + escapeHtml(maskState.outputDir || '') + '" placeholder="' + escapeHtml(outPlaceholder) + '" spellcheck="false">' +
      '<button type="button" class="mask-bar__pick" id="maskPickOutDir" title="选择成片输出文件夹">' + icon('folder', 14) + '</button>' +
      '</div>';
    html += '<div class="config-bar__right">' +
      '<span class="config-bottombar__warn mask-bar__hint" id="maskStartHint" style="display:none"></span>' +
      '<span class="mask-config__seltotal" id="maskSelTotal">' + maskSelTotalText() + '</span>' +
      '<label class="config-bottombar__label">后缀</label>' +
      '<input type="text" class="config-bottombar__input mask-bar__suffix" id="maskSuffixInput" value="' + escapeHtml(maskState.suffix || '') + '" placeholder="" spellcheck="false" maxlength="20">' +
      '<label class="config-bottombar__label">模式</label>' +
      '<select class="mask-bar__mode" id="maskModeSel">' +
      '<option value="1"' + (maskState.mode === 1 ? ' selected' : '') + '>遮罩+水印</option>' +
      '<option value="2"' + (maskState.mode === 2 ? ' selected' : '') + '>仅水印</option>' +
      '<option value="3"' + (maskState.mode === 3 ? ' selected' : '') + '>仅遮罩</option></select>' +
      '<button type="button" class="config-btn config-btn--run" id="btnMaskStart">' + icon('play', 14) + '开始制作</button></div>';
    bar.innerHTML = html;
    $('maskModeSel').addEventListener('change', function () {
      maskState.mode = parseInt(this.value, 10) || 1;
      buildMaskCenter(); buildMaskConfigBar(); maskPersist();
    });
    $('maskPickOutDir').addEventListener('click', function () {
      // 从占位符/默认目录路径打开选择对话框
      call('pick_directory', '选择成片输出文件夹', maskEffectiveOutDir() || projPath).then(function (np) {
        if (np) { maskState.outputDir = np; buildMaskConfigBar(); maskPersist(); }
      }).catch(function () {});
    });
    var sfInp = $('maskSuffixInput');
    if (sfInp) sfInp.addEventListener('input', function () {
      maskState.suffix = this.value.trim();
      refreshMaskStartHint();
      maskPersist();
    });
    var outInp = $('maskOutDir');
    if (outInp) outInp.addEventListener('input', function () {
      maskState.outputDir = this.value.trim();
      refreshMaskStartHint();
      maskPersist();
    });
    $('btnMaskStart').addEventListener('click', startMaskTask);
    refreshMaskStartHint();
  }
  function refreshMaskStartHint() {
    if (!maskOn()) return;
    var hint = $('maskStartHint');
    if (!hint) return;
    // 素材列表异步扫描中：配置栏不显示任何提示（避免「未选中成片」等误导），扫描完成后再校验
    var scanning = maskState.rawDirs.some(function (d) { return !Array.isArray(d.files); });
    if (maskState.project && scanning) {
      hint.style.display = 'none';
      hint.textContent = '';
      var st0 = $('btnMaskStart');
      if (st0) st0.disabled = true;
      var selEl0 = $('maskSelTotal');
      if (selEl0) {
        selEl0.textContent = maskSelTotalText();
        selEl0.style.display = selEl0.textContent ? '' : 'none';
      }
      return;
    }
    var errs = [];
    if (!maskState.project) errs.push('未选项目');
    else {
      if (!maskState.rawDirs.length) errs.push('未选中成片');
      else if (!maskState.rawDirs.some(function (d) { return (d.files || []).length > 0; })) errs.push('未选中成片');
      // 必须实际勾选原片素材（选中的文件集），不能只选目录不勾文件
      else if (maskRawSelCount() < 1) errs.push('未勾选原片');
      if (maskNeedMask() && !Object.keys(maskState.maskSel).length) errs.push('未选中遮罩');
      if (maskNeedWm() && !maskState.watermark) errs.push('未选水印');
      if (!maskEffectiveOutDir()) errs.push('无输出文件夹');
      // 最终防线：已勾选的遮罩与原片两两时差必须 ≤1s（含组头全选/半选引入的所有勾选）
      var durErrs = maskDurMismatchErrs();
      if (durErrs.length) errs.push(durErrs[0] + (durErrs.length > 1 ? ' 等 ' + durErrs.length + ' 处' : ''));
    }
    hint.style.display = errs.length ? '' : 'none';
    hint.textContent = errs.join(' · ');
    // 有未满足项时禁止「开始制作」（按钮变灰）；计数只显示已选侧（0 不显示），
    // 与「未选中XX」提示并存：选中了什么就显示什么，未选中的侧不出现「已选 0」
    var st = $('btnMaskStart');
    if (st) st.disabled = errs.length > 0;
    var selEl = $('maskSelTotal');
    if (selEl) {
      selEl.textContent = maskSelTotalText();
      selEl.style.display = selEl.textContent ? '' : 'none';
    }
  }
  // 时长两两校验：所有已勾选素材（原片+遮罩）彼此两两比对，任一对时差 >1s 即返回错误描述列表。
  // 同侧（原片之间/遮罩之间）同样拦截——最终组合必须全部互相兼容，杜绝不同时长混选。
  // 使用渲染时的时长映射（maskDur）直接取时长，不依赖 DOM 复选框，保证任何勾选路径都覆盖
  function maskDurMismatchErrs() {
    var errs = [];
    if (!maskNeedMask()) return errs;
    var rawDurs = [];
    (maskState.rawDirs || []).forEach(function (rd) {
      var sel = maskState.rawSel[rd.path] || [];
      (rd.files || []).forEach(function (f) {
        if (sel.indexOf(f.rel) >= 0) rawDurs.push({ name: f.rel, dur: f.dur || 0 });
      });
    });
    var maskDurs = [];
    Object.keys(maskState.maskSel || {}).forEach(function (full) {
      var d = (maskState.maskDur || {})[full] || 0;
      maskDurs.push({ name: full, dur: d });
    });
    // 未知时长（未识别/未解析）：前端无法保证匹配，直接拦截
    rawDurs.forEach(function (r) { if (!(r.dur > 0)) errs.push('原片 ' + r.name + ' 时长未识别，无法校验'); });
    maskDurs.forEach(function (m) { if (!(m.dur > 0)) errs.push('遮罩 ' + m.name + ' 时长未识别，无法校验'); });
    if (errs.length) return errs;
    // 全部已勾选素材合并：anyDurs[i] = { side, name, dur }，两两比对
    var any = [];
    rawDurs.forEach(function (r) { any.push({ side: '原片', name: r.name, dur: r.dur }); });
    maskDurs.forEach(function (m) { any.push({ side: '遮罩', name: m.name, dur: m.dur }); });
    for (var i = 0; i < any.length; i++) {
      for (var j = i + 1; j < any.length; j++) {
        if (Math.abs(any[i].dur - any[j].dur) > 1.0 + 1e-6) {
          errs.push('时长差>' + '1s：' + any[i].side + ' ' + any[i].name + '（' + maskFmtDur(any[i].dur) + '）与 ' + any[j].side + ' ' + any[j].name + '（' + maskFmtDur(any[j].dur) + '）');
        }
      }
    }
    return errs;
  }
  function startMaskTask() {
    if (!maskOn()) return;
    refreshMaskStartHint();
    var hint = $('maskStartHint');
    if (hint && hint.style.display !== 'none') { setStatus('请先完善遮罩叠加配置：' + hint.textContent); return; }
    // 兜底防线：直接校验勾选集合两两时差（不依赖按钮状态，即使被程序绕过也拦截）
    var durErrs = maskDurMismatchErrs();
    if (durErrs.length) { setStatus('时长校验未通过：' + durErrs[0] + (durErrs.length > 1 ? ' 等 ' + durErrs.length + ' 处' : '')); return; }
    var vids = {};
    for (var d in maskState.rawSel) {
      if (Object.prototype.hasOwnProperty.call(maskState.rawSel, d) && maskState.rawSel[d].length) vids[d] = maskState.rawSel[d];
    }
    // 勾选遮罩（跨文件夹按 mov 名称前缀分组选择）：完整路径交给脚本精筛，
    // 所在目录去重后作为遮罩目录（原实现漏传 themeSel，会导致任务参数缺失）
    var selMaskFull = Object.keys(maskState.maskSel);
    var maskDirsSet = {};
    selMaskFull.forEach(function (fp) { maskDirsSet[String(fp).replace(/[\\/][^\\/]+$/, '')] = true; });
    var payload = {
      mode: maskState.mode,
      rawDirs: maskState.rawDirs.map(function (d) { return d.path; }),
      videos: vids,
      maskDirs: Object.keys(maskDirsSet),
      masks: selMaskFull.join(';'),
      projectName: maskState.project ? maskState.project.name : '',
      watermark: maskState.watermark,
      watermarkAlpha: maskState.watermarkAlpha || '',
      outputDir: maskEffectiveOutDir(),
      suffix: maskState.suffix || '',
      logDir: pathJoin(maskState.project.path, '遮罩日志')
    };
    call('run_mask', payload).then(function (r) {
      if (!r || !r.ok) { setStatus('启动失败：' + ((r && r.error) || '未知错误')); return; }
      // 提交成功不弹窗，仅状态栏提示（任务窗口可随时打开查看）
      toast('遮罩叠加任务已提交，可打开任务窗口查看进度', 'ok');
      // 开始任务后取消所有勾选（勾选不持久化记忆，下次从空开始）
      maskState.rawSel = {};
      maskState.maskSel = {};
      maskPersist();
      buildMaskCenter(); buildMaskConfigBar();
    }).catch(function (e) { setStatus('启动失败：' + e.message); });
  }
  function updateWinModeLabel() {
    var wm = $('winModeLabel');
    if (wm) wm.textContent = maskState.on ? '遮罩叠加' : '配置管理';
  }
  function toggleMaskMode() {
    var mm = $('sidebarMenu'); if (mm) mm.style.display = 'none';
    if (maskState.on) exitMaskMode(); else enterMaskMode();
  }
  function initMaskMode() {
    // 标题栏模式切换按钮：事件由 titlebar.js 派发
    document.addEventListener('vl:toggle-mask', toggleMaskMode);
    // 遮罩模式菜单「刷新」：刷新项目列表 + 重扫当前项目原片分组/遮罩主题（保留仍存在的勾选），
    // 两刷新合一：项目列表重扫覆盖新增/删除项目，素材重扫覆盖素材增减
    var mrs = $('menuMaskRescan');
    if (mrs) mrs.addEventListener('click', function () {
      closeMenu();
      if (!maskOn()) return;
      maskRescanCurrent();
      refreshMaskProjects();
    });
    // 遮罩模式自愈：低频对比项目列表签名，外部增删主题/项目时自动刷新（对应批量配置自愈轮询）
    setInterval(function () { if (maskOn()) pollMaskSelfHeal(); }, 6000);
  }
  function pollMaskSelfHeal() {
    call('list_mask_projects').then(function (list) {
      var l = Array.isArray(list) ? list : [];
      var sig = function (arr) {
        return (arr || []).map(function (p) { return p.name + ':' + (p.themeCount != null ? p.themeCount : ((p.themes || []).length)); }).join('|');
      };
      if (sig(l) !== sig(maskState.projects)) {
        maskState.projects = l;
        buildMaskSidebar();
        // 当前选中项目：主题组数/素材变化时同步重扫右栏
        if (maskState.project && maskOn()) {
          maskState._themeSig = null; // 主题指纹作废，立即重扫并重建基准
          loadAllMaskGroups();
        }
      }
      if (maskState.project && maskOn()) maskSelfHealProject();
    }).catch(function () {});
  }
  // 当前项目文件级自愈：原片分组增减/失效目录移除 + 遮罩主题文件增减或文件名变化均自动生效
  function maskSelfHealProject() {
    var p = maskState.project;
    if (!p) return;
    call('scan_mask_raw_dirs', p.path).then(function (dirs) {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      // 合并保留手动添加的外部目录与单文件；项目内分组以扫描结果为准
      var nextRaw = maskMergeRawDirs(dirs);
      var cur = (maskState.rawDirs || []).map(function (d) { return d.path; }).sort().join('|');
      var next = nextRaw.map(function (d) { return d.path; }).sort().join('|');
      if (cur !== next) {
        // 分组变化（含项目内目录被删/变空 → 自动去除；外部添加目录与单文件保留）
        maskState.rawDirs = nextRaw;
        var keep = {};
        (maskState.rawDirs || []).forEach(function (d) { if (maskState.rawSel[d.path]) keep[d.path] = maskState.rawSel[d.path]; });
        maskState.rawSel = keep;
        buildMaskCenter(); maskPersist();
      }
    }).catch(function () {});
    // 遮罩主题文件指纹对比：增减/改名/目录失效时重载主题分组
    call('scan_mask_theme_sig', p.path).then(function (r) {
      if (!maskOn() || !maskState.project || maskState.project.name !== p.name) return;
      var s = (r && r.sig) ? r.sig : '';
      if (maskState._themeSig != null && s !== maskState._themeSig && maskNeedMask()) loadAllMaskGroups();
      maskState._themeSig = s;
    }).catch(function () {});
    // 日志视图自愈：日志文件增减/内容变化时实时刷新生效（后端按 mtime 签名缓存，
    // 前端渲染幂等，未变化不重绘；不再需要切换项目才能看到新日志）
    if (maskState.view === 'log') buildMaskLogView();
  }

  var booted = false;
  function boot() { if (booted) return; booted = true; init(); }
  window.addEventListener('pywebviewready', boot);
  document.addEventListener('DOMContentLoaded', boot);
})();
