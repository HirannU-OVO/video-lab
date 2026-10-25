/* -*- coding: utf-8 -*-
 * Video Lab — 任务列表窗口逻辑
 */
(function () {

  // 全局兜底统一由 logbootstrap.js 注入（四窗口共用）；本页只挂 toast。
  // 就地 catch 请用 window.logError(where, err)（toast + 落盘一次完成）。
  window.vlToast = toast;

  'use strict';
  // 数字输入框：禁用滚轮滚动改值（仅保留手动输入）
  document.addEventListener('wheel', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'range')) ev.preventDefault();
  }, { passive: false });
  var $ = VL.$;   // 取元素：实现见 common.js
  function getApi() { return VL.api.getApi(); }
  var call = VL.api.call;   // 调用原生能力：实现见 common.js

  // 任务状态文案统一取 VL.STATUS_TEXT，勿在本文件另写一份
  var STATUS_TEXT = (window.VL && window.VL.STATUS_TEXT) || { queued: '排队中', paused: '已暂停', running: '运行中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断' };
  var LOCK_TEXT = { unknown: '', waiting: '等待前面的任务完成', locked: '开始处理', released: '' };
  var TYPE_TEXT = { batch: '批量拼接', replica: '视频复刻', mask: '遮罩叠加', tool: '视频处理' };

  // 任务卡片右键菜单（置顶 / 暂停继续 / 打开成片文件夹），样式复用 styles.css 的 .ctx-menu
  // 子菜单策略：hover 展开；离开菜单区延迟 260ms 才关闭，期间移入子菜单即取消关闭（标准 hover 菜单行为）
  var _subEl = null, _subTimer = null, _menuX = 0, _menuY = 0;
  function subTimerClear() { if (_subTimer) { clearTimeout(_subTimer); _subTimer = null; } }
  function currentRootMenu() { return document.getElementById('ctxMenu'); }
  function currentSubEl() { return document.getElementById('_vlSub'); }
  function teardownMenu() {
    subTimerClear();
    if (_subEl) { try { _subEl.remove(); } catch (e) {} _subEl = null; }
    var rootEl = currentRootMenu();
    if (rootEl) rootEl.remove();
    document.removeEventListener('mousedown', _onDocMd, true);
    document.removeEventListener('contextmenu', _onCtx, true);
    document.removeEventListener('mousemove', _onMove, true);
  }
  function scheduleMenuClose(ms) {
    subTimerClear();
    _subTimer = setTimeout(function () {
      var rootEl = currentRootMenu(), subEl = currentSubEl();
      var t = document.elementFromPoint(_menuX, _menuY);
      // 鼠标仍停留在根菜单或子菜单上 → 不关闭（允许根项→子菜单的移动留白）
      if (t && rootEl && (rootEl.contains(t) || (subEl && subEl.contains(t)))) { _subTimer = null; return; }
      teardownMenu();
    }, ms);
  }
  function _onDocMd(e) {
    var rootEl = currentRootMenu(), subEl = currentSubEl();
    if (!rootEl) return;
    if (!rootEl.contains(e.target) && !(subEl && subEl.contains(e.target))) teardownMenu();
  }
  function _onCtx() { teardownMenu(); }
  function _onMove(e) {
    _menuX = e.clientX; _menuY = e.clientY;
    var rootEl = currentRootMenu(), subEl = currentSubEl();
    if (rootEl && (rootEl.contains(e.target) || (subEl && subEl.contains(e.target)))) subTimerClear();
  }
  function showMenu(x, y, items, ownerEl) {
    var old = currentRootMenu();
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
        b.addEventListener('click', function () { teardownMenu(); toast(it.title || it.label + '不可用', true); });
        return;
      }
      if (it.submenu && it.submenu.length) {
        // hover 展示子菜单（右侧展开，如 定位至配置 / 定位至日志）；切到其它子菜单项自动替换
        b.classList.add('ctx-menu__item--has-sub');
        b.addEventListener('mouseenter', function () { openSub(it.submenu, b, m); });
        b.addEventListener('click', function (ev) { ev.stopPropagation(); });
        return;
      }
      b.addEventListener('click', function () { teardownMenu(); setPopAnchor(ownerEl || _ctxOwner); it.action(); });
    });
    document.body.appendChild(m);
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - 200)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - items.length * 30 - 14)) + 'px';
    // 离开根菜单：延迟关闭，留出移入子菜单的时间
    m.addEventListener('mouseleave', function () { scheduleMenuClose(260); });
    setTimeout(function () { document.addEventListener('mousedown', _onDocMd, true); }, 0);
    document.addEventListener('contextmenu', _onCtx, true);
    document.addEventListener('mousemove', _onMove, true);
  }
  // 渲染并展开子菜单（右侧定位）；hover 留在子菜单内保持打开
  function openSub(sub, anchor, rootMenu) {
    subTimerClear();
    if (_subEl) { try { _subEl.remove(); } catch (e) {} _subEl = null; }
    var r = anchor.getBoundingClientRect();
    var el = document.createElement('div');
    el.id = '_vlSub'; el.className = 'ctx-menu__sub';
    sub.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      b.addEventListener('click', function () { teardownMenu(); setPopAnchor(_ctxOwner); it.action(); });
      el.appendChild(b);
    });
    el.style.top = Math.max(4, Math.min(r.top, window.innerHeight - sub.length * 30 - 8)) + 'px';
    el.style.left = (r.right + 6) + 'px';
    document.body.appendChild(el);
    _subEl = el;
    el.addEventListener('mouseenter', subTimerClear);
    el.addEventListener('mouseleave', function () { scheduleMenuClose(260); });
  }

  // 图标统一来自 icons.js 全局库（硬约束：不在业务文件维护 ICONS/icon 副本）
  var icon = window.VL_icon || function () { return ''; };
  var hydrateIcons = window.VL_hydrateIcons || function () {};
  var escapeHtml = VL.esc;   // HTML 转义：实现见 common.js
  // 主窗口同款模态弹窗（按钮样式复用 styles.css 的 .modal-btn / .modal-card）
  function showDialog(opts) { try { return VL.ui.dialog(opts); } catch (e) { return null; } }
  try { VL.ui.registerDialog(_dialogRender); } catch (e) { /* 门面未就绪也要让页面继续跑 */ }
  function _dialogRender(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card' + (opts.cardClass ? ' ' + opts.cardClass : '');
      var html = '<button type="button" class="modal-close" title="关闭">✕</button><div class="modal__title">' + escapeHtml(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + escapeHtml(opts.message) + '</div>';
      html += '<div class="modal__actions">';
      (opts.buttons || []).forEach(function (b) {
        var cls = 'modal-btn' + (b.danger ? ' modal-btn--danger' : '') + (b.primary ? ' modal-btn--primary' : '');
        html += '<button type="button" class="' + cls + '">' + escapeHtml(b.label) + '</button>';
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
      (opts.buttons || []).forEach(function (b, i) { btns[i].addEventListener('click', function () { done(b.value); }); });
    });
  }
  function confirmDialog(message) {
    return showDialog({
      title: '确认操作', message: message,
      buttons: [
        { label: '取消', value: false },
        { label: '确定', value: true, primary: true }
      ]
    });
  }
  function alertDialog(message) {
    return showDialog({ title: '提示', message: message, buttons: [{ label: '知道了', value: true, primary: true }] });
  }
  // 轻量角落提示（toast）：仅告知、无需用户操作，自动消失。type：ok(✓绿)/error(⚠红)/info(ℹ)/warn(黄)
  // 用于操作结果与失败提示，比状态栏小字更显眼，且不开大窗
  // 提示统一走 VL.ui 门面：日志由门面记一次（唯一日志点），这里只负责渲染。
  function toast(message, type) { try { return VL.ui.toast(message, type); } catch (e) { return null; } }
  try { VL.ui.registerToast(_toastRender); } catch (e) { /* 门面未就绪也要让页面继续跑 */ }
  function _toastRender(message, type) { return VL.ui.toastRender(message, type); }
  // 记录最后一次点击的可作为锚点的元素：气泡确认未显式传 anchor 时用它定位（气泡内部交互不更新）
  var _popAnchor = null; // { el, rect }：rect 为元素当时的位置快照，供元素随后被移除时仍能定位
  // 设置气泡的归属锚点：气泡应锚在「被操作对象」（如任务卡片）上，而非临时菜单项
  function setPopAnchor(el) {
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    _popAnchor = { el: el, rect: { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } };
  }
  document.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.vl-pop')) return;
    setPopAnchor(t.closest('button, .btn, [role="button"], a, .menu-item'));
  }, true);
  // 右键目标元素：作为该菜单操作气泡的归属锚点（如任务卡片 / 日期分组头）
  var _ctxOwner = null;
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('.vl-pop')) return;
    _ctxOwner = t.closest('.task-card, .task-day-group') || t;
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
      // 定位锚点矩形：优先显式传入的有效元素 → 最后点击元素（仍在 DOM）→ 其位置快照（元素已被移除）
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

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  var rendered = {}; // taskId -> { el, header, logEl, body, logCount, expanded }

  // 任务日志展示过滤：仅影响展示，后端日志数据保持完整。
  // 1) 内部机制/冗余行（执行权状态、索引加载与自动修正、TXT已同步、预检测计数、
  //    生成/分组数确认、创建输出目录标题）用户无需关注，直接隐去；
  function filterTaskLogLines(lines) {
    var out = [];
    var block = null;
    function flush() { if (block) { out.push.apply(out, block); block = null; } }
    var ignore = [
      /^(▶ 开始处理本任务|■ 本任务处理结束|🔒 已获取互斥锁|🔓 互斥锁已释放|📇 已加载索引|🔎 索引自动修正|✅ TXT文件已同步更新|预检测视频文件|设置生成数量|设置分组数|等待前面的任务完成|等待获取互斥锁|创建输出目录|✅ 输出目录)/,
      /^已通过 BATCH_(COUNT|GROUP) 指定/,
      /^✅ 已通过 REPLICA_TXT 指定TXT文件/,
      /：\s*\d+\s*个视频/
    ];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ignore.some(function (re) { return re.test(ln); })) continue;
      if (/^🔀 模式2：尾部新增替换/.test(ln)) { flush(); block = []; block.push(ln); continue; }
      if (block && /^\s*第\s*\d+\s*段:/.test(ln)) { block.push(ln); continue; }
      if (block && /替换后总时长.*重试替换（/.test(ln)) {
        block = null; // 前一轮替换详情将被重试覆盖，丢弃
        out.push(ln);
        continue;
      }
      flush();
      out.push(ln);
    }
    flush();
    return out;
  }
  var state = { tab: 'running', _errCount: 0, _viewedErr: 0 };
  // 已完成列表按日期分组的展开状态：dayKey -> true(展开)/false(折叠)；未记录时首组展开、其余折叠
  var doneGroupsExpanded = {};

  // 控制台日志滚动辅助：logAtBottom 判断是否停在最新一行（底部），
  // scrollLogBottom 直接滚到底。
  // 跟随语义：following=true 表示「该跟随最新」——初始为 true；每次滚动实时
  function logAtBottom(el) { return el.scrollHeight - (el.scrollTop + el.clientHeight) <= 2; }
  function scrollLogBottom(el) { el.scrollTop = el.scrollHeight; }
  // 时间格式跟随实际用时：几十秒只显秒；1m1s / 10m10s / 1h0m10s（分秒含 0 亦保留）
  function humanDuration(sec) {
    var s = Math.max(0, Math.round(sec));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    if (h > 0) return h + 'h' + m + 'm' + x + 's';
    if (m > 0) return m + 'm' + x + 's';
    return x + 's';
  }
  // ffmpeg 状态行 elapsed：HH:MM:SS.mmm 或纯秒数 float，统一解析成秒
  function parseElapsedSec(v) {
    var s = String(v).trim(), p = s.split(':');
    if (p.length === 3) {
      var sec = parseFloat(p[2]);
      return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (isNaN(sec) ? 0 : sec);
    }
    var f = parseFloat(s);
    return isNaN(f) ? NaN : f;
  }
  // ffmpeg 实时进度行直译：顺序按原文，fps/重复帧不显示，质量字段保留 q 标签，
  // 体积换算 MB（KiB/1024，1 位小数）；丢帧字段缺失时补 0 不留空；elapsed（秒）格式化为时分秒
  function mbText(v) {
    var m = String(v).match(/^([\d.]+)\s*kib$/i);
    return m ? (parseFloat(m[1]) / 1024).toFixed(1) + 'MB' : v;
  }
  function liveLineText(o) {
    if (!o) return '';
    var order = [['frame', '总帧数'], ['q', 'q'], ['size', '大小'], ['time', '时间'], ['bitrate', '码率'], ['drop', '丢帧'], ['elapsed', '已用时'], ['speed', '速度']];
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var k = order[i][0], label = order[i][1], v = o[k];
      if (k === 'drop') { if (!(parseFloat(v) > 0)) continue; } // 丢帧为 0（或缺省）不显示
      if (v === undefined || v === null || v === '') continue;
      if (k === 'size') v = mbText(v);
      if (k === 'elapsed') { var sec = parseElapsedSec(v); v = isNaN(sec) ? v : humanDuration(sec); }
      out.push(label + '=' + v);
    }
    return out.join(' ');
  }

  function bindLogFollow(rec) {
    rec.following = true;
    rec.logEl.addEventListener('scroll', function () {
      // 程序性滚动（重绘/跟随滚底触发）不改变跟随意图，仅响应用户滚动
      if (rec._progScroll) { rec._progScroll = false; return; }
      rec.following = logAtBottom(rec.logEl);
    });
  }

  function buildCard(t) {
    var card = document.createElement('div');
    card.className = 'task-card task-card--' + (t.lockState === 'waiting' ? 'waiting' : t.status);
    card.dataset.taskId = t.id;

    var header = document.createElement('div');
    header.className = 'task-card__header';
    header.innerHTML =
      '<span class="task-card__handle" title="拖动调整任务顺序"></span>' +
      '<span class="task-card__failreason"></span>' +
      '<span class="task-card__status-dot"></span>' +
      '<span class="task-card__status-text"></span>' +
      '<span class="task-card__title"></span>' +
      '<span class="task-card__tag"></span>' +
      '<span class="task-card__time"></span>' +
      '<span class="task-card__lock"></span>' +
      '<button class="task-card__pause">' + icon('pause', 12) + '暂停</button>' +
      '<button class="task-card__stop">' + icon('stop', 12) + '停止</button>' +
      '<button class="task-card__rerun" title="使用开始任务时的配置重新制作，删除上次失败的成片与日志">' + icon('rotate-ccw', 12) + '重新开始</button>' +
      '<button class="task-card__continue" title="仅续跑失败或未完成的成片，不删除已成功产物">' + icon('play', 12) + '继续制作</button>' +
      '<button class="task-card__del" title="从列表中移除该任务">' + icon('x', 12) + '</button>';
    card.appendChild(header);
    header.querySelector('.task-card__handle').innerHTML = icon('grip-vertical', 14);

    var progress = document.createElement('div');
    progress.className = 'task-card__progress';
    progress.innerHTML =
      '<div class="task-card__progress-text"><span class="task-card__progress-label"></span><span class="task-card__progress-elapsed"></span><span class="task-card__progress-pct"></span></div>' +
      '<div class="task-card__progress-sub" style="display:none"></div>' +
      '<div class="task-card__progress-track"><div class="task-card__progress-fill"></div></div>';
    card.appendChild(progress);

    var body = document.createElement('div');
    body.className = 'task-card__body';
    body.style.display = 'none';
    var log = document.createElement('div');
    log.className = 'task-card__log';
    body.appendChild(log);
    card.appendChild(body);

    var record = { el: card, header: header, logEl: log, body: body, logCount: 0, expanded: false, progressEl: progress, progressLabel: progress.querySelector('.task-card__progress-label'), progressElapsed: progress.querySelector('.task-card__progress-elapsed'), progressPct: progress.querySelector('.task-card__progress-pct'), progressSub: progress.querySelector('.task-card__progress-sub'), progressFill: progress.querySelector('.task-card__progress-fill') };
    bindLogFollow(record);
    header.addEventListener('click', function (e) {
      if (e.target.closest('.task-card__stop')) return;
      if (e.target.closest('.task-card__rerun')) return;
      if (e.target.closest('.task-card__continue')) return;
      if (e.target.closest('.task-card__pause')) return;
      if (e.target.closest('.task-card__handle')) return;
      // 只有「真正从未运行过」的任务（排队中且从未启动过）日志无有用信息，点击不展开；
      // 软暂停的任务已跑过一部分，续跑后排队等待时也带着既有日志 —— 这些都应允许展开
      var curT = card.__task || t;
      if (curT.status === 'queued' && !curT.startedAt) return;
      record.expanded = !record.expanded;
      body.style.display = record.expanded ? '' : 'none';
      if (record.expanded) { record.following = true; record._progScroll = true; scrollLogBottom(log); requestAnimationFrame(function () { record._progScroll = true; scrollLogBottom(log); }); }
      // 折叠（日志不可见）时重置跟随：下次展开直接到最新一行
      else record.following = true;
    });
    header.querySelector('.task-card__stop').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmStop(card.__task || t, e.currentTarget);
    });
    header.querySelector('.task-card__rerun').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmRerun(card.__task || t, e.currentTarget);
    });
    header.querySelector('.task-card__continue').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmContinue(card.__task || t, e.currentTarget);
    });
    header.querySelector('.task-card__pause').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = card.__task || t;
      if (cur.status === 'paused') confirmResume(cur);
      else confirmPause(cur, e.currentTarget);
    });
    // 已结束任务单行删除：已完成/已停止任务弹出与清除按钮同款的清除方式弹窗
    header.querySelector('.task-card__del').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = card.__task || t;
      // 从未开始过的任务（排队中直接取消/启动即失败）：除列表记录外没有任何文件变化，
      // 删除一律用轻量气泡 —— 不弹「清除方式」重弹窗
      if (cur.type !== 'tool' && !cur.startedAt) {
        confirmPopover({
          title: '删除任务记录',
          message: '该任务尚未开始执行，删除仅移除列表记录，不会影响任何文件。',
          okLabel: '删除记录', danger: true
        }, e.currentTarget).then(function (ok) {
          if (!ok) return;
          call('clear_task', cur.id).then(function (r) {
            if (!r || !r.ok) toast('删除失败：' + ((r && r.error) || '未知错误'), true);
          }).catch(function (err) { toast('删除失败：' + err.message, true); });
        });
        return;
      }
      // 视频处理任务：产物即被覆盖的源视频 —— 删除只允许「仅从列表移除」，不提供任何会碰文件的选项
      if (cur.type === 'tool') {
        confirmPopover({
          title: '删除任务记录',
          message: '仅从列表移除，不会删除任何视频文件。\n\n该任务处理过的视频若需要还原，请到备份文件夹取回。',
          okLabel: '仅移除记录', danger: true
        }, e.currentTarget).then(function (ok) {
          if (!ok) return;
          call('clear_task', cur.id).then(function (r) {
            if (!r || !r.ok) toast('删除失败：' + ((r && r.error) || '未知错误'), true);
          }).catch(function (err) { toast('删除失败：' + err.message, true); });
        });
        return;
      }
      // 软暂停的任务已产出部分成片：删除会牵连文件，与已结束任务同款走「清除方式」三按钮大窗。
      // （真正从未运行过的任务在上面已按轻量气泡处理，不会走到这里）
      if (cur.status === 'paused') { openClearDialog(null, { ids: [cur.id], statuses: ['paused'] }); return; }
      if (cur.status === 'stopped' || cur.status === 'error' || cur.status === 'interrupted') {
        openClearDialog(null, { ids: [cur.id], statuses: ['stopped', 'error', 'interrupted'] });
        return;
      }
      // 已完成任务：与清除按钮同款弹窗（+成片 / 全部清除可选）
      if (cur.status === 'done') { openClearDialog(null, { ids: [cur.id], statuses: ['done'] }); return; }
      call('clear_task', cur.id).then(function (r) {
        if (!r || !r.ok) toast('删除失败：' + ((r && r.error) || '未知错误'), true);
      }).catch(function (err) { toast('删除失败：' + err.message, true); });
    });
    // 右键菜单：按任务状态提供 置顶/暂停/继续/打开文件夹
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showTaskMenu(e.clientX, e.clientY, card.__task || t);
    });
    // 左侧排序把手：运行中不允许拖拽/越过，其余任务可自由排序
    header.querySelector('.task-card__handle').addEventListener('mousedown', function (e) {
      if ((card.__task || t).status === 'running') return;
      startDrag(card, e);
    });
    return record;
  }

  // ── 拖拽调整顺序：移动 DOM，松手后把「排队+暂停」的新顺序提交后端重排执行队列 ──
  // 已停止/失败任务也可拖（纯 UI 排序），后端不认；运行中的任务不可被越过
  var dragState = null;
  function startDrag(card, e) {
    if (state.tab !== 'running') return;
    e.preventDefault();
    e.stopPropagation();
    dragState = { card: card };
    card.classList.add('task-card--dragging');
    card.style.opacity = '0.55';
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }
  function cardsInOrder() {
    var list = document.getElementById('taskList');
    if (!list) return [];
    return Array.prototype.slice.call(list.querySelectorAll('.task-card'));
  }
  function taskStatus(id) {
    var rec = rendered[id];
    return rec ? (rec.el.__task || { status: '' }).status : '';
  }
  function onDragMove(e) {
    if (!dragState) return;
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var target = under && under.closest ? under.closest('.task-card') : null;
    if (!target || target === dragState.card) return;
    // 运行中的任务持续置顶：既不能拖动它，也不能被越过
    if (taskStatus(target.dataset.taskId) === 'running') return;
    if (taskStatus(dragState.card.dataset.taskId) === 'running') return;
    var list = dragState.card.parentNode;
    var dragMid = dragState.card.offsetTop + dragState.card.offsetHeight / 2;
    var tMid = target.offsetTop + target.offsetHeight / 2;
    if (dragMid < tMid) { if (target.nextSibling !== dragState.card) list.insertBefore(dragState.card, target.nextSibling); }
    else if (dragMid > tMid) { if (list.firstChild !== dragState.card) list.insertBefore(dragState.card, target); }
  }
  function onDragEnd() {
    if (!dragState) return;
    var card = dragState.card; dragState = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    card.classList.remove('task-card--dragging');
    card.style.opacity = '';
    // 提交新的待运行顺序（DOM 顺序中仅取 排队+暂停，已停止/失败不提交，纯 UI 排序）
    var waiting = cardsInOrder().map(function (c) { return c.dataset.taskId; }).filter(function (id) {
      var s = taskStatus(id); return s === 'queued' || s === 'paused';
    });
    if (waiting.length < 2) return;
    if (waiting.indexOf(card.dataset.taskId) < 0) return;
    call('reorder_tasks', waiting).then(function (r) {
      if (r && !r.ok) toast('调整顺序失败：' + (r.error || '未知错误'), true);
    }).catch(function (err) { toast('调整顺序失败：' + err.message, true); });
  }

  function updateCard(rec, t) {
    rec.el.__task = t;
    rec.el.className = 'task-card task-card--' + (t.lockState === 'waiting' ? 'waiting' : t.status);
    var statusEl = rec.header.querySelector('.task-card__status-text');
    var titleEl = rec.header.querySelector('.task-card__title');
    titleEl.textContent = t.title || '';
    // 成片已不在磁盘（产出过的已结束任务）：标题置灰；状态文字改为警示色红色「已删除」
    if (t.hasOutput === false) {
      titleEl.classList.add('task-card__title--missing');
      titleEl.title = '成片文件已不存在';
      if (t.status === 'done') {
        statusEl.textContent = '已删除';
        statusEl.classList.add('task-card__status-text--deleted');
        statusEl.title = '成片文件已不存在';
      } else {
        statusEl.textContent = STATUS_TEXT[t.status] || t.status;
        statusEl.classList.remove('task-card__status-text--deleted');
        statusEl.title = '';
      }
    } else {
      titleEl.classList.remove('task-card__title--missing');
      titleEl.title = '';
      statusEl.textContent = STATUS_TEXT[t.status] || t.status;
      statusEl.classList.remove('task-card__status-text--deleted');
      statusEl.title = '';
    }
    var tagEl = rec.header.querySelector('.task-card__tag');
    tagEl.textContent = TYPE_TEXT[t.type] || t.type || '';
    tagEl.className = 'task-card__tag' + ((t.type === 'batch' || t.type === 'replica' || t.type === 'mask' || t.type === 'tool') ? ' task-card__tag--' + t.type : '');
    var lockText = LOCK_TEXT[t.lockState] || '';
    var lockEl = rec.header.querySelector('.task-card__lock');
    lockEl.textContent = lockText;
    lockEl.className = 'task-card__lock' + (lockText ? ' task-card__lock--' + t.lockState : '');
    // 时间：已结束任务显示「开始 / 结束」，进行中仅显示开始时间
    var tEl = rec.header.querySelector('.task-card__time');
    var started = fmtTime(t.createdAt);
    var ended = t.endedAt ? fmtTime(t.endedAt) : '';
    if (t.status === 'done' || t.status === 'stopped' || t.status === 'error') {
      tEl.textContent = started + (ended ? ' / ' + ended : '');
      tEl.title = '开始时间 / 结束时间';
    } else {
      tEl.textContent = started;
      tEl.title = '开始时间';
    }
    // 最左侧状态圆点：排队显示序号，暂停显示橙色实心圆点，其余状态维持状态色点
    var dot = rec.header.querySelector('.task-card__status-dot');
    dot.removeAttribute('title');
    if (t.status === 'queued') {
      dot.textContent = String(t.displayPos || t.pos || '');
      dot.className = 'task-card__status-dot task-card__queue';
      dot.title = '排队中，前序任务完成后自动开始';
      dot.style.display = '';
    } else if (t.status === 'paused') {
      dot.textContent = '';
      dot.innerHTML = '<span class="task-card__pause-dot"></span>';
      dot.className = 'task-card__status-dot task-card__queue task-card__queue--paused';
      dot.title = '已暂停，可点击「继续」按当前位置插队';
      dot.style.display = '';
    } else {
      dot.textContent = '';
      dot.className = 'task-card__status-dot';
      dot.title = '';
    }
    // 左侧排序把手：运行中不可拖，其余灰显规则由状态决定
    var handleEl = rec.header.querySelector('.task-card__handle');
    handleEl.classList.toggle('task-card__handle--disabled', t.status === 'running');
    if (t.status === 'running') handleEl.title = '运行中的任务不能调整顺序';
    else handleEl.title = '拖动调整任务顺序';
    // 失败原因红字：显示在任务行左侧，仅失败且有原因时出现
    var failEl = rec.header.querySelector('.task-card__failreason');
    if (t.status === 'error' && t.failReason) {
      failEl.textContent = t.failReason;
      failEl.style.display = '';
      failEl.title = t.failReason;
    } else {
      failEl.textContent = '';
      failEl.style.display = 'none';
    }
    // 操作按钮（暂停/停止）仅在「正在运行」tab 显示；已完成/已停止 tab 只读
    var showOps = state.tab === 'running';
    // 暂停/继续按钮：运行中/已结束不显示暂停按钮；排队中=暂停（移出队列），暂停中=继续（插队）
    var pauseBtn = rec.header.querySelector('.task-card__pause');
    if (!showOps) {
      pauseBtn.style.display = 'none';
    } else if (t.status === 'running') {
      // ★ 软暂停：运行中的任务也可以暂停 —— 不打断当前成片，
      //   当前成片完成后暂停并让位下一个任务；剩余部分靠「继续任务」断点续传
      //   （视频处理任务按文件粒度重跑语义不匹配，暂不支持）
      if (t.type === 'tool') {
        pauseBtn.style.display = 'none';
      } else {
      pauseBtn.style.display = '';
      pauseBtn.className = 'task-card__pause';
      pauseBtn.disabled = false;
      pauseBtn.innerHTML = icon('pause', 12) + '暂停';
      pauseBtn.title = t.type === 'tool'
        ? '视频处理任务不支持暂停，请使用「停止」后重新提交'
        : '当前成片完成后暂停（不打断正在编码的这一片），让下一个任务先执行';
      }
    } else if (t.status === 'queued') {
      pauseBtn.style.display = '';
      pauseBtn.className = 'task-card__pause';
      pauseBtn.disabled = false;
      pauseBtn.innerHTML = icon('pause', 12) + '暂停';
      pauseBtn.title = '移出执行队列（点击继续可插回原位置）';
    } else if (t.status === 'paused') {
    // 非软暂停的暂停不显示「继续」
      if (t.startedAt && !t.softPaused) {
        pauseBtn.style.display = 'none';
      } else {
        pauseBtn.style.display = '';
        pauseBtn.className = 'task-card__pause task-card__pause--resume';
        pauseBtn.disabled = false;
        pauseBtn.innerHTML = icon('play', 12) + '继续';
        pauseBtn.title = '按当前位置插回执行队列';
      }
    } else {
      pauseBtn.style.display = 'none';
    }
    // 停止按钮：运行中=强停；排队/暂停中=取消任务；已结束禁用
    var stopBtn = rec.header.querySelector('.task-card__stop');
    var canStop = t.status === 'running' || t.status === 'queued' || t.status === 'paused';
    stopBtn.style.display = showOps ? '' : 'none';
    stopBtn.disabled = !canStop;
    stopBtn.title = t.status === 'running' ? '终止运行中的任务进程' : (canStop ? '取消该任务，不再执行' : '任务已结束');
    // 单行删除按钮：已结束任务（完成/停止/失败/已中断）在已完成/已停止列表显示；
    // 软暂停任务已产出部分成片，在「正在运行」列表同样要能删除（走三按钮大窗确认）。
    // 真正从未运行过的任务（排队中且从未启动）不在此列 —— 它没有产物，用「取消」即可。
    var delBtn = rec.header.querySelector('.task-card__del');
    var isEnded = t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted';
    var isSoftPaused = t.status === 'paused' && !!t.startedAt;
    delBtn.style.display = ((isEnded && state.tab !== 'running') || (isSoftPaused && state.tab === 'running')) ? '' : 'none';
    // 重新开始按钮：仅失败/中断/停止任务（已停止 tab）显示，点击按原配置重制
    var rerunBtn = rec.header.querySelector('.task-card__rerun');
    var canRerun = t.status === 'error' || t.status === 'interrupted' || t.status === 'stopped';
    rerunBtn.style.display = (canRerun && state.tab !== 'running') ? '' : 'none';
    if (t.type === 'tool') {
      // 工具任务的产物就是被覆盖的源视频，没有第二份副本 —— 只能「重新执行」，绝不删除任何文件
      rerunBtn.innerHTML = icon('rotate-ccw', 12) + '重新执行';
      rerunBtn.title = '按相同的参数与步骤重跑一遍，不会删除任何文件';
    }
    // 继续制作按钮：复刻/批量任务失败、中断、停止且存在失败记录时显示（不删除已成功产物）
    // 批量任务的续跑按「失败成片名的序号」补做，命名前缀/输出目录/拼接日志与首次一致
    var continueBtn = rec.header.querySelector('.task-card__continue');
    // 有无失败记录不足以判定能否续跑：中断/停止（手动停止、进程被杀）不会留下「❌ 失败成片」行，
    // 成片失败记录也可能是空的（如整片在选片阶段就失败）。这种情形 backend 的 continueReplica
    // 会用第三层兜底 —— 依任务标记里已产出的成片清单 + 源 TXT 反推未完成项，
    var progDone = (t.progress && t.progress.current) || 0;
    var progTotal = (t.progress && t.progress.total) || 0;
    // 进度未知（引擎在早期步骤失败、还没报出总数 → total=0）**不能当作「没有内容」**：
    // 任务确实运行过（有 startedAt 或已推算出成片目录）就仍可能缺片 —— 一律给出续跑入口；
    // 究竟有没有缺片，由 backend 的第三层兜底（按成片目录反推待补序号）给出准确结论。
    var everRan = !!t.startedAt || !!t.outDir;
    // ⚠ progress.current 的语义是「正在做第几个」，不是「已完成几个」：
    //   停在第 1 个时它就是 1，而成片目录里一个产物都没有。
    //   一个成片都没产出时**不存在"续"这回事**（整批重做才对），此时只应给「重新开始」。
    var hasOutput = progTotal > 0 ? progDone > 1 : false;
    var hasFail = (Array.isArray(t.failedVideos) && t.failedVideos.length > 0)
      || (t.log || []).some(function (l) { return /❌ 失败成片/.test(String(l)); })
      || (progTotal > 0 ? (hasOutput && progDone < progTotal) : everRan);
    var canContinue = (t.type === 'replica' || t.type === 'batch') && canRerun && hasFail;
    continueBtn.style.display = (canContinue && state.tab !== 'running') ? '' : 'none';
    // 进度条：数字行（当前/总）+ 下方进度条，仅解析到总进度后显示；
    // 排队任务也显示预计成片数（后端创建时预填 total）；分组数>0 时追加「分 N 组」
    var prog = t.progress || {};
    var total = prog.total || 0;
    var groupCount = parseInt(prog.groupCount || '0', 10) || 0;
    var clipTarget = prog.clipTarget || 0;
    var clip = Math.max(0, prog.clip || 0);
    var groupText = groupCount > 0 ? ' · 分' + groupCount + '组' : '';
    // 计量单位按任务类型：视频处理任务处理的是"视频文件"，不是"成片"
    var unit = t.type === 'tool' ? '文件' : '成片';
    var unitEst = t.type === 'tool' ? '预计文件' : '预计成片';
    if (clipTarget > 0) {
      var pct = Math.max(0, Math.min(clip / clipTarget, 1));
      // 任务已全部完成：单片编码进度补满（编码收尾帧的 time 略小于时长是常态，不补满会停在 89%/95%）
      if (t.status === 'done') pct = 1;
      var curClip = prog.current || 0;
      rec.progressLabel.textContent = (curClip > 0 ? unit + ' ' + curClip + '/' + total : unitEst + ' ' + total) + groupText;
      rec.progressPct.textContent = Math.round(pct * 100) + '%';
      rec.progressFill.style.width = (pct * 100) + '%';
      rec.progressEl.style.display = 'flex';
    } else if (total > 0) {
      var cur = Math.max(0, Math.min(prog.current || 0, total));
      var batchTotal = parseInt(prog.batchTotal || '0', 10) || 0;
      var batchBase = parseInt(prog.batchBase || '0', 10) || 0;
      if (batchTotal > 0) {
        // 续跑任务：同一批成片分多次产出。主进度按「本批」算、本次补做放后面 ——
        // 既不能显示成「一次做完整批」（看不出补过片），也不能只显示本次（看不出全批）。
        var batchCur = Math.max(0, Math.min(batchTotal, batchBase + cur));
        rec.progressLabel.textContent = '本批 ' + batchCur + '/' + batchTotal + ' · 本次 ' + cur + '/' + total;
        rec.progressPct.textContent = Math.round(batchCur / batchTotal * 100) + '%';
        rec.progressFill.style.width = (batchCur / batchTotal * 100) + '%';
        rec.progressEl.style.display = 'flex';
        if (rec.progressSub) {
          // 只报数量
          rec.progressSub.textContent = '已有 ' + batchBase + ' 片 · 本次补 ' + total + ' 片';
          rec.progressSub.style.display = '';
        }
      } else {
        rec.progressLabel.textContent = (cur > 0 ? unit + ' ' + cur + '/' + total : unitEst + ' ' + total) + groupText;
        rec.progressPct.textContent = Math.round(cur / total * 100) + '%';
        rec.progressFill.style.width = (cur / total * 100) + '%';
        rec.progressEl.style.display = 'flex';
        if (rec.progressSub) rec.progressSub.style.display = 'none';
      }
    } else {
      rec.progressEl.style.display = 'none';
      if (rec.progressSub) rec.progressSub.style.display = 'none';
    }
    // 任务总用时：进度条文字行内、百分比左侧（动态时分秒格式）；
    // 宽度由 CSS min-width 固定，未开始时内容留空保持占位，避免 % 位数变化/用时出现造成跳变
    var es = parseInt(t.elapsedSec || '0', 10) || 0;
    if (rec.progressElapsed) rec.progressElapsed.textContent = es > 0 ? '总用时 ' + humanDuration(es) : '';
    // 日志重绘：后端下发的 log 是最近 500 行窗口（slice(-500)），行数不会一直增长，
    // 按行数增量追加会在追平窗口后永不更新（重开/切 tab 才见一次最新）。
    // 改为窗口内容整体重绘 + 滚动保持：跟随状态滚到底，查看历史时保持相对阅读位置。
    var lines = t.log || [];
    var joined = filterTaskLogLines(lines).join('\n');
    // 已结束任务：实时进度行已由"成片完成"固化进日志，不再叠加显示，避免与固化行内容重复
    var ended = t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted';
    var live = ended ? '' : liveLineText((t.progress || {}).liveLine);
    var logChanged = joined !== rec._lastLog;
    var liveChanged = live !== rec._lastLive;
    if (logChanged) {
      var rel = rec.logEl.scrollHeight - rec.logEl.scrollTop;
      rec.logEl.textContent = joined;
      rec._lastLog = joined;
    }
    // 实时进度行：textContent 覆盖会清掉它，统一在此重建/挂回日志末尾
    if (live) {
      if (!rec._liveNode) rec._liveNode = document.createElement('div');
      rec._liveNode.className = 'task-card__live';
      rec._liveNode.textContent = live;
      if (rec._liveNode.parentNode !== rec.logEl) rec.logEl.appendChild(rec._liveNode);
    } else if (rec._liveNode) {
      if (rec._liveNode.parentNode) rec._liveNode.parentNode.removeChild(rec._liveNode);
      rec._liveNode = null;
    }
    rec._lastLive = live;
    // 滚动：跟随状态滚到底（日志或进度行任一变化）；上滚看历史时保持相对阅读位
    if (logChanged || liveChanged) {
      if (rec.expanded && rec.following) { rec._progScroll = true; scrollLogBottom(rec.logEl); }
      else if (logChanged && rec.expanded) { rec._progScroll = true; rec.logEl.scrollTop = Math.max(0, rec.logEl.scrollHeight - rel); }
    }
  }

  // 任务右键菜单：置顶（仅排队）/ 暂停（排队）/ 继续（暂停）/ 打开成片文件夹
  // 已完成批量任务重分组：修复分组数错误 / 忘记分组；规则与批量脚本一致（均匀分 N 组，后缀 A/B/C…，已有分组可替换）
  function openRegroupDialog(t) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var card = document.createElement('div');
    card.className = 'modal-card modal-card--wide';
    card.innerHTML =
      '<button type="button" class="modal-close" title="关闭">✕</button>' +
      '<div class="modal__title">重分组</div>' +
      '<div class="modal__message">为任务「' + escapeHtml(t.title || '') + '」的成片重新分组（已有分组字母会被替换）。请输入分组数：</div>' +
      '<div class="modal__input-row"><input type="number" class="modal-input" id="rgInput" min="1" max="99" value="1"></div>' +
      '<div class="modal__actions"><button type="button" class="modal-btn" data-v="cancel">取消</button><button type="button" class="modal-btn modal-btn--primary" data-v="go">开始分组</button></div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var close = function () { overlay.remove(); };
    var submit = function () {
      var inp = document.getElementById('rgInput');
      var v = parseInt(inp ? inp.value : '', 10);
      if (!(v > 0)) { toast('请输入大于 0 的分组数', true); return; }
      close();
      call('regroup_task', t.id, v).then(function (r) {
        if (!r || !r.ok) { toast('重分组失败：' + ((r && r.error) || '未知错误'), true); return; }
        var msg = '重分组完成：' + (r.regrouped || 0) + ' / ' + (r.total || 0) + ' 个成片已重新分组，拼接日志已同步修改';
        if (r.errors && r.errors.length) alertDialog(msg + '\n\n部分未处理：\n' + r.errors.slice(0, 5).join('\n'));
        else toast(msg, 'ok');
      }).catch(function (e) { toast('重分组失败：' + e.message, true); });
    };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    card.querySelector('.modal-close').addEventListener('click', close);
    card.querySelector('[data-v="cancel"]').addEventListener('click', close);
    card.querySelector('[data-v="go"]').addEventListener('click', submit);
    var inp = document.getElementById('rgInput');
    if (inp) {
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      inp.focus(); inp.select();
    }
  }
  // 定位子菜单：批量任务提供「定位至配置/日志」，复刻任务仅日志（源即日志）
  function buildLocateItem(t) {
    var subs = [];
    if (t.type === 'batch') subs.push({ label: '定位至配置', action: function () { locateTask(t.id, 'config'); } });
    subs.push({ label: '定位至日志', action: function () { locateTask(t.id, 'log'); } });
    return { label: '定位', submenu: subs };
  }
  function locateTask(id, target) {
    call('locate_task', id, target).then(function (r) {
      if (r && !r.ok) toast('定位失败：' + (r.error || '未知错误'), true);
    }).catch(function (e) { toast('定位失败：' + e.message, true); });
  }
  function showTaskMenu(x, y, t) {
    var items = [];
    function openFolder() {
      if (t.type === 'replica') {
        // 复刻：打开复刻产物目录（月份/MMdd/模式目录），而非原日志所在成片目录
        call('open_replica_output', t.id).then(function (r) {
          if (r && !r.ok) toast(r.error || '复刻成片文件夹不存在', true);
        }).catch(function (e) { toast(e.message, true); });
        return;
      }
      call('open_folder_select', t.outDir).then(function (r) {
        if (r && !r.ok) toast(r.error || '成片文件夹不存在', true);
      }).catch(function () {});
    }
    // 打开前的只读探测：目标不可达时把菜单项直接置灰禁用，避免点击后再弹窗
    // （复刻实际打开的是推算产物目录，走专用探测；其余直接 check 成片文件夹）
    function probeOpenable() {
      if (t.type === 'replica' && t.id) {
        return call('task_replica_outdir', t.id).then(function (r) { return !!(r && r.ok && r.dir); })
          .catch(function () { return false; });
      }
      if (!t.outDir) return Promise.resolve(false);
      return call('check_exists', [t.outDir]).then(function (m) { return !!(m && m[t.outDir]); })
        .catch(function () { return false; });
    }
    // 已结束任务（完成/停止/失败/中断）只读：已完成批量任务可重分组，其余仅提供打开成片文件夹
    if (t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted') {
      var mItems = [];
      if (t.status === 'done' && t.type === 'batch') {
        mItems.push({ label: '重分组', action: function () { openRegroupDialog(t); } });
      }
      // 复刻任务失败/中断/停止：提供「继续制作」——仅续跑失败/未完成的成片，不删除已成功产物
      if (t.type === 'replica' && (t.status === 'error' || t.status === 'interrupted' || t.status === 'stopped')) {
        var failN = (Array.isArray(t.failedVideos) && t.failedVideos.length) ? t.failedVideos.length : 0;
        var cItem = { label: '继续制作', action: function () { confirmContinue(t); } };
        if (!failN && !(t.log || []).some(function (l) { return /❌ 失败成片/.test(String(l)); })) {
          cItem.disabled = true;
          cItem.title = '未检测到失败成片，无法续跑';
        } else if (failN) {
          cItem.title = '仅续跑失败或未完成的 ' + failN + ' 个成片，不删除已成功产物';
        }
        mItems.push(cItem);
      }
      var it = { label: '打开成片文件夹', action: openFolder };
      if (!t.outDir) { it.disabled = true; it.title = '该任务没有成片文件夹信息'; }
      else { it.disabled = true; it.title = '正在侦测成片文件夹…'; }
      mItems.push(it);
      // 遮罩任务无配置/日志可定位；视频处理任务没有成片/配置概念 —— 都不提供「定位」子菜单
      if (t.type !== 'mask' && t.type !== 'tool') mItems.push(buildLocateItem(t));
      // 视频处理任务：提供「重新执行」（按同样参数重跑，**不删除任何文件**）
      if (t.type === 'tool') mItems.push({ label: '重新执行', action: function () { confirmRerun(t); } });
      probeOpenable().then(function (ok) {
        if (ok) { it.disabled = false; it.title = ''; }
        else { it.disabled = true; it.title = '成片文件夹不存在'; }
        showMenu(x, y, mItems);
      });
      return;
    }
    if (t.status === 'queued') {
      items.push({ label: '置顶任务', action: function () {
        call('pin_task', t.id).then(function (r) {
          if (r && !r.ok) toast('置顶失败：' + (r.error || '未知错误'), true);
        }).catch(function (e) { toast('置顶失败：' + e.message, true); });
      } });
      items.push({ label: '暂停任务', action: function () { confirmPause(t); } });
    } else if (t.status === 'paused') {
      items.push({ label: '继续任务', action: function () { confirmResume(t); } });
    } else if (t.status === 'running') {
      if (t.type !== 'tool') items.push({ label: '暂停（当前成片完成后）', action: function () { confirmPause(t); } });
      items.push({ label: '停止任务', action: function () { confirmStop(t); } });
    }
    var folderItem = { label: '打开成片文件夹', action: openFolder };
    if (!t.outDir) { folderItem.disabled = true; folderItem.title = '该任务没有成片文件夹信息'; }
    else { folderItem.disabled = true; folderItem.title = '正在侦测成片文件夹…'; }
    items.push(folderItem);
    items.push(buildLocateItem(t));
    probeOpenable().then(function (ok) {
      if (ok) { folderItem.disabled = false; folderItem.title = ''; }
      else { folderItem.disabled = true; folderItem.title = '成片文件夹不存在'; }
      showMenu(x, y, items);
    });
  }

  function confirmStop(t, anchor) {
    var warn = t.status === 'running' && t.lockState === 'locked'
      ? '\n\n停止会中断当前生成，可能留下不完整文件'
      : '';
    var msg = '任务「' + (t.title || t.id) + '」' + warn;
    confirmPopover({ title: t.status === 'running' ? '停止任务' : '取消任务', message: msg, okLabel: t.status === 'running' ? '停止' : '取消任务', danger: true }, anchor).then(function (ok) {
      if (!ok) return;
      call('stop_task', t.id).then(function (r) {
        if (!r || !r.ok) toast('停止失败：' + ((r && r.error) || '未知错误'), true);
      }).catch(function (e) { toast('停止失败：' + e.message, true); });
    });
  }

  // 暂停是不可逆地打断当前推进（运行时为软暂停：当前成片完成后才停），故先做二次确认
  function confirmPause(t, anchor) {
    var running = t.status === 'running';
    var msg = running
      ? '任务「' + (t.title || t.id) + '」将在当前成片完成后暂停，剩余成片稍后可用「继续任务」续跑。'
      : '任务「' + (t.title || t.id) + '」将从执行队列移出，稍后可用「继续任务」恢复。';
    confirmPopover({ title: '暂停任务', message: msg, okLabel: '暂停' }, anchor).then(function (ok) {
      if (!ok) return;
      call('pause_task', t.id).then(function (r) {
        if (!r || !r.ok) { toast('暂停失败：' + ((r && r.error) || '未知错误'), true); return; }
        if (r.soft) toast('当前成片完成后暂停，剩余部分可「继续任务」续跑');
      }).catch(function (e) { toast('暂停失败：' + e.message, true); });
    });
  }

  function confirmResume(t) {
  call('resume_task', t.id).then(function (r) {
    if (!r || !r.ok) toast('恢复失败：' + ((r && r.error) || '未知错误'), true);
  }).catch(function (e) { toast('恢复失败：' + e.message, true); });
}

  function confirmContinue(t, anchor) {
    var failN = (Array.isArray(t.failedVideos) && t.failedVideos.length) ? t.failedVideos.length : 0;
    var msg = '仅续跑失败或未完成的' + (failN ? ' ' + failN + ' 个' : '') + '成片，已成功生成的成片和日志将保留';
    confirmPopover({ title: '继续制作', message: msg, okLabel: '继续制作' }, anchor).then(function (ok) {
      if (!ok) return;
      call(t.type === 'mask' ? 'continue_mask' : 'continue_replica', t.id).then(function (r) {
        if (!r || !r.ok) toast('继续制作失败：' + ((r && r.error) || '未知错误'), true);
      }).catch(function (err) { toast('继续制作失败：' + err.message, true); });
    });
  }

  function confirmRerun(t, anchor) {
    if (t.type === 'tool') {
      confirmPopover({
        title: '重新执行',
        message: '将按相同的步骤与参数重跑一遍，不会删除任何文件。',
        okLabel: '重新执行'
      }, anchor).then(function (ok) {
        if (!ok) return;
        call('rerun_tool_task', t.id).then(function (r) {
          if (!r || !r.ok) toast('重新执行失败：' + ((r && r.error) || '未知错误'), true);
        }).catch(function (err) { toast('重新执行失败：' + err.message, true); });
      });
      return;
    }
    var msg = '将删除上次的成片与日志、从第 1 个成片重新制作；若只想补做缺失的成片，请改用「继续制作」';
    confirmPopover({ title: '重新开始', message: msg, okLabel: '重新开始', danger: true }, anchor).then(function (ok) {
      if (!ok) return;
      call('rerun_task', t.id).then(function (r) {
        if (!r || !r.ok) toast('重新开始失败：' + ((r && r.error) || '未知错误'), true);
      }).catch(function (err) { toast('重新开始失败：' + err.message, true); });
    });
  }

  function renderTasks(tasks) {
    var list = $('taskList');
    if (!list) return;
    tasks = tasks || [];
    state.tasks = tasks;   // 留一份快照：清除弹窗要据此判断清单里是否含视频处理任务
    // 把「当前任务」告知日志兜底：前端异常落盘时会带上该 id，便于与任务日志/引擎日志串链
    // 。优先进行中/暂停的任务，其次最近一条。
    try {
      if (window.vlSetTaskId) {
        var act = tasks.filter(function (x) { return x && (x.status === 'running' || x.status === 'paused'); })[0] || tasks[0];
        window.vlSetTaskId(act ? act.id : '');
      }
    } catch (e) {}
    // 顶部三个 tab 计数 + 已停止 tab 报错提醒
    updateTabCounts(tasks);
    // 按当前 tab 过滤出列表内容
    var cur;
    if (state.tab === 'done') {
      cur = tasks.filter(function (t) { return t.status === 'done'; });
      // 已完成列表：分组头按完成日期降序；组内跨日凌晨(0-4时)完成的任务（业务日收官产出）置顶，
      // 其余按结束时刻降序——两层排序保证组序与组内顺序都稳定
      var isDawn = function (t) { var e = Number(t.endedAt) || 0; return e > 0 && new Date(e).getHours() < 4; };
      cur.sort(function (a, b) {
        var da = dayKey(a.endedAt), db = dayKey(b.endedAt);
        if (da !== db) return da < db ? 1 : -1; // 日期降序
        var ad = isDawn(a) ? 0 : 1, bd = isDawn(b) ? 0 : 1;
        if (ad !== bd) return ad - bd;          // 同日组内凌晨任务置顶
        return (b.endedAt || 0) - (a.endedAt || 0);
      });
    }
    else if (state.tab === 'stopped') cur = tasks.filter(function (t) { return t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted'; });
    else cur = tasks.filter(function (t) { return t.status === 'running' || t.status === 'queued' || t.status === 'paused'; });
    if (!cur.length) { list.innerHTML = '<div class="task-empty">' + emptyText(state.tab) + '</div>'; rendered = {}; return; }
    var ids = {};
    cur.forEach(function (t) { ids[t.id] = true; });
    Object.keys(rendered).forEach(function (id) {
      if (!ids[id]) { var el = rendered[id].el; if (el.parentNode) el.parentNode.removeChild(el); delete rendered[id]; }
    });
    var emptyEl = list.querySelector('.task-empty');
    if (emptyEl) emptyEl.remove();
    if (state.tab !== 'done') {
      // 非已完成列表不用日期分组：清掉切换 tab 时可能残留的分组头
      Array.prototype.slice.call(list.querySelectorAll('.task-day-group')).forEach(function (h) { h.parentNode.removeChild(h); });
      cur.forEach(function (t) {
        var rec = rendered[t.id];
        if (!rec) { rec = buildCard(t); rendered[t.id] = rec; }
        updateCard(rec, t);
        // 清理在已完成 tab 可能残留的分组标记与隐藏
        delete rec.el.dataset.day;
        rec.el.style.display = '';
        // 已在列表中的节点不移动：移动会 detach/attach 导致卡片内部
        // 日志滚动位置被重置（每秒轮询时控制台会被强行拉回顶部）
        if (rec.el.parentNode !== list) list.appendChild(rec.el);
      });
      return;
    }
    // 已完成列表：按日期降序分组渲染（分组头严格按日期降序，不受组内置顶顺序影响）
    var dayOrder = [];
    var dayCount = {};
    cur.forEach(function (t) {
      var d = dayKey(t.endedAt);
      if (!dayCount[d]) { dayCount[d] = 0; dayOrder.push(d); }
      // 视频数 = 该任务生成的成片数（progress.total），无进度数据时按 1 个任务计 1
      var n = (t.progress && t.progress.total > 0) ? t.progress.total : 1;
      dayCount[d] += n;
    });
    // 分组头按日期字符串降序（yy.mm.dd 零填充可直接比较）：凌晨置顶不影响组序
    dayOrder.sort().reverse();
    var firstDay = dayOrder.length ? dayOrder[0] : null;
    // 清理已过期的日期分组头（该日已无任务）；仍在的头保留 DOM 原位，
    // 避免每轮整体删除重建导致头被追加到该组卡片之后、顺序错乱（首行分组头跳动）
    var keepDays = {};
    dayOrder.forEach(function (d) { keepDays[d] = 1; });
    Array.prototype.slice.call(list.querySelectorAll('.task-day-group')).forEach(function (h) {
      if (!keepDays[h.getAttribute('data-day')]) h.parentNode.removeChild(h);
    });
    dayOrder.forEach(function (day, di) {
      // 默认首组展开、其余折叠；记录过展开状态则保持
      if (!(day in doneGroupsExpanded)) doneGroupsExpanded[day] = (di === 0);
    });
    var lastDay = null;
    var curDay = null;
    cur.forEach(function (t) {
      var day = dayKey(t.endedAt);
      if (day !== lastDay) {
        lastDay = day; curDay = day;
        // 分组头复用：存在则保留原位仅更新计数（避免重建追加到卡片后被甩到组尾），
        // 不存在才创建；新组此刻没有卡片在列表，尾部追加即正确组序（头在卡片前）
        var hdr = list.querySelector('.task-day-group[data-day="' + day + '"]');
        if (!hdr) {
          hdr = document.createElement('div');
          hdr.className = 'task-day-group';
          hdr.dataset.day = day;
          hdr.innerHTML =
            '<span class="task-day-group__label">' + day + '</span>' +
            '<span class="task-day-group__line"></span>' +
            '<span class="task-day-group__count">共 ' + dayCount[day] + ' 个视频</span>';
          // 点击整个分组头即展开/折叠该日列表（按钮已移除）
          hdr.addEventListener('click', function () {
            doneGroupsExpanded[day] = !doneGroupsExpanded[day];
            applyDoneGroupState(day);
          });
          list.appendChild(hdr);
        } else {
          var cntEl = hdr.querySelector('.task-day-group__count');
          if (cntEl) cntEl.textContent = '共 ' + dayCount[day] + ' 个视频';
        }
        hdr.classList.toggle('is-collapsed', !doneGroupsExpanded[day]);
      }
      var rec = rendered[t.id];
      if (!rec) { rec = buildCard(t); rendered[t.id] = rec; }
      updateCard(rec, t);
      rec.el.dataset.day = day;
      if (rec.el.parentNode !== list) list.appendChild(rec.el);
    });
    // 应用各日期组隐显与分组头按钮状态
    dayOrder.forEach(function (day) { applyDoneGroupState(day); });
  }

  // 按展开状态更新某日期组：折叠时隐藏该组卡片、分组头打上折叠样式
  function applyDoneGroupState(day) {
    var list = $('taskList');
    if (!list) return;
    var expanded = !!doneGroupsExpanded[day];
    list.querySelectorAll('.task-card[data-day="' + day + '"]').forEach(function (el) {
      el.style.display = expanded ? '' : 'none';
    });
    var hdr = list.querySelector('.task-day-group[data-day="' + day + '"]');
    if (!hdr) return;
    hdr.classList.toggle('is-collapsed', !expanded);
  }

  // 完成时间 → yy.mm.dd 分组键
  function dayKey(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return String(d.getFullYear()).slice(2) + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
  }

  function emptyText(tab) {
    if (tab === 'done') return '暂无已完成任务';
    if (tab === 'stopped') return '暂未停止或出错的任务';
    return '暂无正在运行的任务，在主窗口点击「开始制作」或「复刻」开始生成';
  }

  function setCnt(id, n) { var el = $(id); if (el) el.textContent = String(n); }
  function updateTabCounts(tasks) {
    var run = 0, done = 0, stop = 0, err = 0;
    tasks.forEach(function (t) {
      if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') run++;
      else if (t.status === 'done') done++;
      else if (t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted') { stop++; if (t.status === 'error' || t.status === 'interrupted') err++; }
    });
    setCnt('cntRunning', run);
    setCnt('cntDone', done);
    setCnt('cntStopped', stop);
    // 已停止 tab：新增因报错/中断进入的任务且尚未查看时，按钮标浅红底提醒
    state._errCount = err;
    var tabStop = $('tabStopped');
    if (!tabStop) return;
    if (err > state._viewedErr) tabStop.classList.add('task-tab--alert');
    else tabStop.classList.remove('task-tab--alert');
  }

  // 右下角悬浮按钮：正在运行=「全部继续（左）」+「全部暂停（右）」；已完成/已停止=清除列表
  function updateFab() {
    var actions = $('taskFabActions'), fab = $('taskFab');
    if (!actions || !fab) return;
    if (state.tab === 'running') { actions.style.display = ''; fab.style.display = 'none'; }
    else { actions.style.display = 'none'; fab.style.display = ''; }
  }
  // 右下角清除按钮：已完成/已停止均弹出三按钮清除弹窗（全部清除另有二次确认）
  function onFabClearClick() { openClearDialog(null); }

  // 清除弹窗：仅清除列表 / 清除列表和成片(仅mp4) / 全部清除；文件删除均由后端移入回收站
  function openClearDialog(day, opts) {
    var isDone = state.tab === 'done';
    var scopeName = isDone ? '已完成' : '已停止';
    var title = day ? '清除当日任务' : '清除全部' + scopeName + '任务';
    var msg = (day ? '将清除 ' + day + ' 这一天的' : '将清除全部' + scopeName) + '任务，请选择清除方式：\n\n' +
      '· 仅清除列表：移除任务记录，成片文件保留\n' +
      '· 清除列表和成片：另删除成片视频（mp4，移入回收站）\n' +
      '· 全部清除：连同成片文件夹一并移入回收站';
    var statuses = (opts && opts.statuses) || (isDone ? ['done'] : ['stopped', 'error', 'interrupted']);
    var ids = (opts && opts.ids) || null;
    // 清单里若含视频处理任务，必须说清楚它的清除语义完全不同：
    // 工具任务的产物就是被覆盖后的源视频，没有第二份副本 —— 只会移除列表项，一个文件都不会碰
    var toolN = (state.tasks || []).filter(function (x) {
      if (x.type !== 'tool') return false;
      if (ids) return ids.indexOf(x.id) >= 0;
      if (statuses.indexOf(x.status) < 0) return false;
      return day ? x.groupDate === day : true;
    }).length;
    if (toolN) {
      msg += '\n\n其中 ' + toolN + ' 个是视频处理任务：这部分**仅移除列表记录，不会删除任何视频文件**'
        + '（它的产物就是处理后的原视频，需要还原请到备份文件夹取回）。';
    }
    if (ids) {
      title = '清除任务';
      msg = '将清除选中的任务记录与成片，请选择清除方式：\n\n' +
        '· 仅清除列表：移除任务记录，成片文件保留\n' +
        '· 清除列表和成片：另删除成片视频（mp4，移入回收站）\n' +
        '· 全部清除：连同成片文件夹一并移入回收站';
    }
    showDialog({
      title: title,
      message: msg,
      cardClass: 'modal-card--wide',
      buttons: [
        { label: '仅清除列表', value: 'list', primary: true },
        { label: '清除列表和成片', value: 'video', primary: true },
        { label: '全部清除', value: 'all', danger: true }
      ]
    }).then(function (v) {
      if (!v || v === 'cancel') return;
      if (v === 'all') {
        // 全部清除二次确认：删除后无法根据日志和配置恢复成片
        showDialog({
          title: '确认全部清除',
          message: '删除后无法根据日志和配置恢复成片，是否继续？',
          buttons: [
            { label: '继续删除', value: 'go', danger: true, primary: true }
          ]
        }).then(function (ok) {
          if (!ok || ok === 'cancel') return;
          doClearDone(day, 'all', statuses, ids);
        });
      } else doClearDone(day, v, statuses, ids);
    });
  }

  function doClearDone(day, scope, statuses, ids) {
    call('clear_done_tasks', { day: day || null, scope: scope, statuses: statuses, ids: ids || null }).then(function (r) {
      if (!r || !r.ok) { toast('清除失败：' + ((r && r.error) || '未知错误'), true); return; }
      if (r.errors && r.errors.length) toast('部分项目清除失败：' + r.errors.slice(0, 3).join('；'), true);
      var api = getApi();
      if (api && api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    }).catch(function (e) { toast('清除失败：' + e.message, true); });
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.task-tab'), function (b) {
      var active = b.getAttribute('data-tab') === tab;
      b.classList.toggle('task-tab--active', active);
    });
    if (tab === 'stopped') state._viewedErr = state._errCount; // 进入查看即消除红底
    updateFab();
    var api = getApi();
    if (api && api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
  }

  function init() {
    var api = getApi();
    if (!api) return;
    if (api.get_skin) api.get_skin().then(function (skin) { document.documentElement.setAttribute('data-skin', skin || 'white_blue'); }).catch(function () {});
    // 设置页切换皮肤时实时生效（无需关闭重开任务列表）
    if (api.on_settings_saved) api.on_settings_saved(function (cfg) {
      if (cfg && cfg.skin) document.documentElement.setAttribute('data-skin', cfg.skin);
    });
    hydrateIcons(document);
    Array.prototype.forEach.call(document.querySelectorAll('.task-tab'), function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    var fabResume = $('fabResumeAll');
    if (fabResume) fabResume.addEventListener('click', function () {
      call('resume_all_tasks').then(function (r) {
        if (r && !r.ok) toast('暂无暂停的任务', true);
      }).catch(function (e) { toast('全部继续失败：' + e.message, true); });
    });
    var fabPause = $('fabPauseAll');
    if (fabPause) fabPause.addEventListener('click', function () {
      call('pause_all_tasks').then(function (r) {
        if (r && !r.ok) toast('暂无排队中的任务', true);
      }).catch(function (e) { toast('全部暂停失败：' + e.message, true); });
    });
    // 已完成分组头右键：清除当日任务（后续三按钮弹窗二次确认）
    var taskListEl = $('taskList');
    if (taskListEl) taskListEl.addEventListener('contextmenu', function (e) {
      var hdr = e.target.closest('.task-day-group');
      if (!hdr) return;
      e.preventDefault();
      var day = hdr.getAttribute('data-day');
      showMenu(e.clientX, e.clientY, [{ label: '清除当日任务', action: function () { openClearDialog(day); } }]);
    });
    $('taskFab').addEventListener('click', onFabClearClick);
    updateFab();
    if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    if (api.on_task_update) api.on_task_update(renderTasks);
    // 1 秒轮询兜底刷新：解决 IPC 推送偶发丢失导致"有任务却显示暂无任务"，
    // 并保证控制台日志/状态每 1 秒刷新一次，而非仅在成片生成时才更新。
    // ⚠ 窗口不可见时（最小化到托盘/被其他窗口完全遮挡）必须停：list_tasks 返回的是全部任务的
    setInterval(function () {
      if (document.hidden) return;   // 隐藏期间不轮询；重新可见时由 visibilitychange 立即补一次
      if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    }, 1000);
    // 恢复到可见的那一刻立刻拉一次，避免"刚唤出时还显示着隐藏前的旧内容"
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
