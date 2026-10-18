/* eslint-disable */
/**
 * 跨窗口公共函数（任务状态文案 / 转义 / 格式化）。
 *
 * 为什么挂在 window.VL 下：五个窗口（index / task / tool / settings / guide）都引入了
 * txapi.js，而本文件紧跟其后加载，任何窗口都能直接拿到 —— 不需要为每个 HTML 再加一行
 * <script>。挂在全局命名空间下而不是各自 window.VL.xxx，是为了让各窗口看到的**是同一份**
 * （而不是各窗口各存一份副本，那正是本次要消除的问题）。
 *
 * ⚠ 这里的函数都是**纯函数**（无 DOM 依赖），因此渲染进程之外也能安全加载。
 *   依赖 DOM 的 UI 基建（toast / setStatus / showDialog 等）刻意**不**放进来：
 *   各窗口的 DOM 结构不同（有的没有底部状态栏），共用的前提不存在。
 */
(function (root) {
  'use strict';

  /** 任务状态 → 中文文案。全项目唯一一份，避免两个窗口对同一状态显示不同文字。 */
  var STATUS_TEXT = {
    queued: '排队中',
    paused: '已暂停',
    running: '运行中',
    done: '已完成',
    error: '失败',
    stopped: '已停止',
    interrupted: '已中断',
  };

  /** HTML 转义（innerHTML 拼接前的必经步骤）。 */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  /** 秒 → 12.3s / 1m05s / 1h02m03s（够到分钟才进位，保持"一眼看出大概多久"）。 */
  function fmtDur(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n < 0) return '-';
    var s = Math.floor(n % 60);
    var m = Math.floor((n / 60) % 60);
    var h = Math.floor(n / 3600);
    if (h > 0) return h + 'h' + (m < 10 ? '0' : '') + m + 'm' + (s < 10 ? '0' : '') + s + 's';
    if (m > 0) return m + 'm' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
  }

  /** 字节 → 1.2 KB / 3.4 MB / 1.2 GB（十进制单位，与文件管理器一致）。 */
  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 时间戳 → MM-DD HH:MM（列表里的"何时"）。 */
  function fmtWhen(ts) {
    var d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '-';
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 秒 → HH:MM:SS（播放进度类）。 */
  function fmtHms(sec) {
    var n = Math.max(0, Math.floor(Number(sec) || 0));
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(Math.floor(n / 3600)) + ':' + p(Math.floor((n % 3600) / 60)) + ':' + p(n % 60);
  }

  // ── 画幅尺寸：比例判定 / 标准档位 / 锁链状态机 ──
  //
  // 为什么抽成底座：画布输出尺寸 与 后处理转分辨率 在界面上是同一套控件
  // （比例下拉 + 锁链 + 宽 + 高），行为也必须一致。两份独立实现迟早对同一问题
  // 给出不同答案，改一处另一处不跟进 —— 那不是疏漏，是重复代码的必然结果。
  //
  // 这里只放**纯逻辑与状态**，不碰 DOM：画布是静态节点、后处理每次重渲染参数区，
  // 两者的绑定方式本就不同，硬塞一个"帮你绑事件"的函数反而会把差异藏起来。
  var RATIO_PRESETS = {
    '16:9': [1920, 1080],   // 横屏
    '9:16': [1080, 1920],   // 竖屏
    '4:3': [1440, 1080],
    '3:4': [1080, 1440],
    '1:1': [1080, 1080],
  };
  // 比例**识别**表：只要宽高比落在这里，下拉就显示它的名字（如 2520×1080 → 21:9）。
  // 与 RATIO_PRESETS（下拉里的可选项 + 标准档位）是两件事 ——
  // 识别要多（用户手输的尺寸是五花八门的），可选要少（选项太多反而挑不过来）。
  // 不在 PRESETS 里的比例会显示在下拉的「自定义」项上，仍能一眼看出是几比几。
  var RATIO_RATIOS = {
    '16:9': [16, 9],        // 横屏标准
    '9:16': [9, 16],        // 竖屏标准
    '21:9': [21, 9],        // 超宽屏 / 电影宽银幕
    '16:10': [16, 10],      // 笔记本屏（1920×1200）
    '4:3': [4, 3],
    '3:4': [3, 4],
    '1:1': [1, 1],
    '3:2': [3, 2],          // 相机 / 平板
    '2:3': [2, 3],
    '4:5': [4, 5],          // 竖版社交图
    '5:4': [5, 4],          // 旧式方屏
    '2.35:1': [235, 100],   // 宽银幕（整数表示，交叉相乘可精确匹配）
    '2.39:1': [239, 100],
  };

  /** 宽高的比例文案：命中常用比例返回其名字，否则返回实际比值（两位小数，如 1.43:1） */
  function ratioLabelOf(w, h) {
    var W = Number(w), H = Number(h);
    if (!(W > 0) || !(H > 0)) return '';
    for (var k in RATIO_RATIOS) {
      var a = RATIO_RATIOS[k][0], b = RATIO_RATIOS[k][1];
      if (W * b === H * a) return k;          // 交叉相乘，避开浮点误差
    }
    return (W / H).toFixed(2) + ':1';
  }

  /** 某个比例是否是固定选项（非常用比例在下拉里没有对应 option） */
  function isPresetRatio(name) {
    return Object.prototype.hasOwnProperty.call(RATIO_PRESETS, name);
  }

  /** 取某比例的标准档位；非预设返回 null */
  function presetOf(name) {
    return isPresetRatio(name) ? RATIO_PRESETS[name].slice() : null;
  }

  /** 按比例从宽算高 / 从高算宽（偶数对齐） */
  function pairByWidth(ratioName, w) {
    var a = RATIO_RATIOS[ratioName];
    if (!a) return 0;
    return Math.max(2, Math.round((Number(w) * a[1]) / a[0] / 2) * 2);
  }
  function pairByHeight(ratioName, h) {
    var a = RATIO_RATIOS[ratioName];
    if (!a) return 0;
    return Math.max(2, Math.round((Number(h) * a[0]) / a[1] / 2) * 2);
  }

  /**
   * 锁链状态机：**用户的选择**与"当前选了哪个比例"是两件事。
   *
   * 解绑后先挑一个常用画幅当起点、再自由微调宽高，是很自然的用法 ——
   * 若把"选了常用比例"当成"要锁定"，这个用法会被一直锁住（改宽自动改高）。
   *
   * @returns {{isLinked:function(string):boolean, isUserLocked:function():boolean,
   *            setUserLocked:function(boolean):void, toggle:function():boolean}}
   */
  function createSizeLink(initiallyLocked) {
    var userLocked = initiallyLocked !== false;
    return {
      /** 当前是否按比例联动：用户锁了、且选的是常用比例（自定义没有整数比可依） */
      isLinked: function (ratioName) { return userLocked && ratioName !== '自定义' && isPresetRatio(ratioName); },
      isUserLocked: function () { return userLocked; },
      setUserLocked: function (v) { userLocked = !!v; },
      toggle: function () { userLocked = !userLocked; return userLocked; },
    };
  }

  // ── 界面动作与提示的日志上报 ──
  //
  // 存在理由：用户报问题时**不应该需要复述他做过什么**。之前只有异常进日志，
  // 于是「界面上弹过的提示」「切过的配置」「搜了什么都搜不到」全都不留痕 ——
  // 排查只能靠用户口述 + 反复试，而口述经常和真实操作顺序对不上。
  //
  // 为什么要有节流：toast 在正常操作里出现得很频繁（每切一次配置都可能弹一条），
  // 逐条发 IPC 会把日志文件灌满、拖慢界面。
  // 策略：**error / warn 级一条不落**（这些正是要排查的）；info 级按「同文案间隔」合并。
  var _actLogAt = Object.create(null);
  var _actSentAt = 0;

  /** 落盘的唯一出口：复用 logbootstrap 的 vlReportError（它按 txapi / call / api 三种形态择一） */
  function vlSendReport(p) {
    try {
      if (root.vlReportError) { root.vlReportError(p); return true; }
      // logbootstrap 尚未加载时自行择一 —— ⚠ 必须覆盖 window.txapi：
      //   浏览器端走的就是 txapi，只试 call/api 会整条链路静默失败（本轮踩过）。
      var api = root.txapi;
      if (api && api.report_ui_error) { api.report_ui_error(p); return true; }
      if (typeof root.call === 'function') { root.call('report_ui_error', p); return true; }
      if (root.api && root.api.report_ui_error) { root.api.report_ui_error(p); return true; }
    } catch (e) { /* 上报失败绝不能影响界面 */ }
    return false;
  }

  function vlLogAction(action, msg, opts) {
    var o = opts || {};
    var level = String(o.level || 'info').toLowerCase();
    var text = String(msg == null ? '' : msg);
    // 空文案且没带上下文 ⇒ 没有排查价值，不记（避免日志被无意义条目稀释）
    if (!text && !o.ctx) return;
    var now = Date.now();
    // 节流：同 action + 同文案，info 级 8 秒内只记一次；error 级放行
    if (level === 'info') {
      var key = String(action) + '\u0000' + text;
      if (_actLogAt[key] && now - _actLogAt[key] < 8000) return;
      _actLogAt[key] = now;
    }
    // 全局限流：极端情况下（脚本连点）不至于把 IPC 打满。error 级不受此限 —— 那些正是要查的。
    if (level !== 'error' && now - _actSentAt < 120) return;
    _actSentAt = now;
    vlSendReport({ kind: 'action', action: String(action || 'ui.action'), level: level, msg: text.slice(0, 400),
                  where: String(o.where || (root.location && root.location.pathname) || '').slice(0, 80),
                  taskId: (root.vlGetTaskId ? root.vlGetTaskId() : ''), ctx: o.ctx || null });
  }

  // ── 自动捕获用户操作（一次覆盖全部窗口的交互）──
  // 为什么用"委托捕获"而不是逐处埋点：各窗口合计 300+ 个事件绑定，逐个人工埋既不可能维护，
  // 新增控件也必然漏；而"用户到底点过什么、改过什么"恰恰是排查时最缺的信息。
  // 语义优先级：data-log > aria-label > 可见文本 > id > class —— 让日志行直接可读，不必再对照代码。
  // 噪声控制：只认可交互元素；文本输入 500ms 去抖只记最终值；密码类不记内容；复用 vlLogAction 的节流。
  var _capInstalled = false;
  var _capTimers = {};
  var _CAP_SEL = 'button,a,label,input,select,textarea,[data-log],[role="button"],[onclick]';

  function _capDescribe(el) {
    if (!el || !el.getAttribute) return null;
    try {
      var label = el.getAttribute('data-log')
        || el.getAttribute('aria-label')
        || (el.innerText || el.textContent || '').trim()
        || el.id || el.className || el.tagName;
      label = String(label).replace(/\s+/g, ' ').slice(0, 80);
      return label || null;
    } catch (e) { return null; }
  }

  function _capValue(el) {
    try {
      var tag = String(el.tagName || '').toLowerCase();
      var type = String(el.type || '').toLowerCase();
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return el.checked ? '勾选' : '取消勾选';
      if (tag === 'select') return '选中「' + String(el.value || '').slice(0, 60) + '」';
      if (tag === 'input' || tag === 'textarea') {
        if (type === 'password' || /password|token|secret/i.test(String(el.id || el.name || ''))) return '已输入（内容不记录）';
        var v = String(el.value == null ? '' : el.value);
        return v ? ('输入「' + v.slice(0, 100) + (v.length > 100 ? '…' : '') + '」') : '清空';
      }
      if (tag === 'a' && el.getAttribute('href')) return 'href=' + String(el.getAttribute('href')).slice(0, 60);
    } catch (e) {}
    return '';
  }

  function _capLog(action, el) {
    var label = _capDescribe(el);
    if (!label) return;
    var val = _capValue(el);
    var lvl = (el && el.getAttribute && el.getAttribute('data-log-level')) || 'info';
    vlLogAction(action, label + (val ? ' · ' + val : ''), {
      level: lvl,
      where: (root.location && root.location.pathname) || '',
      ctx: { el: String(el.id || el.className || el.tagName || '').slice(0, 60), tag: String(el.tagName || '').toLowerCase() },
    });
  }

  function vlInstallUiCapture() {
    if (_capInstalled || typeof document === 'undefined' || !document.addEventListener) return;
    _capInstalled = true;
    document.addEventListener('click', function (ev) {
      try {
        var el = ev.target && ev.target.closest ? ev.target.closest(_CAP_SEL) : null;
        if (!el) return;
        // label 的点击交给它自己的控件记（change 会触发），避免同一动作两条
        if (String(el.tagName).toLowerCase() === 'label' && el.querySelector(_CAP_SEL)) return;
        _capLog('ui.click', el);
      } catch (e) {}
    }, true);
    document.addEventListener('change', function (ev) {
      try { if (ev.target && ev.target.tagName) _capLog('ui.change', ev.target); } catch (e) {}
    }, true);
    document.addEventListener('input', function (ev) {
      try {
        var el = ev.target;
        if (!el || !el.tagName) return;
        var tag = String(el.tagName).toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') return;
        var type = String(el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio' || type === 'file') return;   // 归 change
        var key = String(el.id || el.name || el.className || tag);
        if (_capTimers[key]) { try { clearTimeout(_capTimers[key]); } catch (e) {} }
        _capTimers[key] = setTimeout(function () { _capTimers[key] = null; _capLog('ui.input', el); }, 500);
      } catch (e) {}
    }, true);
    // 右键菜单：成片/配置/路径的右键操作（打开、定位、删除…）在排查里同样是"用户做了什么"
    document.addEventListener('contextmenu', function (ev) {
      try {
        var el = ev.target && ev.target.closest ? ev.target.closest(_CAP_SEL + ',[data-ctx],[data-menu]') : null;
        _capLog('ui.contextmenu', el || ev.target);
      } catch (e) {}
    }, true);
    // 键盘快捷键：只记**带修饰键或功能键**的组合（Ctrl/Alt/Shift/Meta/F1-F12/Delete），
    // 普通字符输入交给 input 事件，避免把用户打的每个字母都写进日志。
    document.addEventListener('keydown', function (ev) {
      try {
        var k = String(ev.key || '');
        var mod = ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey;
        var fn = /^F([1-9]|1[0-2])$/.test(k) || k === 'Delete' || k === 'Escape' || k === 'Enter';
        if (!mod && !fn) return;
        var combo = (ev.ctrlKey ? 'Ctrl+' : '') + (ev.altKey ? 'Alt+' : '') + (ev.shiftKey ? 'Shift+' : '') + (ev.metaKey ? 'Meta+' : '') + k;
        var where = ev.target && ev.target.getAttribute ? (_capDescribe(ev.target) || '') : '';
        vlLogAction('ui.key', combo + (where ? ' @ ' + where : ''), {
          where: (root.location && root.location.pathname) || '',
          ctx: { key: k, el: String((ev.target && (ev.target.id || ev.target.className)) || '').slice(0, 60) },
        });
      } catch (e) {}
    }, true);
  }

  // DOM 就绪即自动安装：五个窗口都引用了本文件，各页不必再各自调用
  try {
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vlInstallUiCapture);
      else vlInstallUiCapture();
    }
  } catch (e) {}

  // ── UI 提示门面 ──
  // toast / setStatus / showDialog 的日志统一在此记录，各窗口只注册自己的渲染函数；
  // 业务代码里的 toast(...) / setStatus(...) 调用保持不变。
  // 新增窗口需调 VL.ui.registerToast / registerStatus / registerDialog。
  var _toastRender = null;
  var _statusRender = null;
  var _statusDoneRender = null;
  var _dialogRender = null;

  function _uiLog(action, msg, level) {
    try { vlLogAction(action, String(msg == null ? '' : msg), { level: level || 'info' }); } catch (e) {}
  }

  // 未注册渲染器时的告警：新增窗口忘记调 registerXxx 是最典型的漏接。
  // 每个 kind 只报一次（不刷屏），但**同时写一条 error 级日志** —— 既不会静默丢现场，
  // 也能在用户日志里被直接看见，不必等到有人发现"提示没弹出来"。
  var _uiWarned = {};
  function _uiWarn(kind, msg) {
    if (_uiWarned[kind]) return;
    _uiWarned[kind] = true;
    try { console.warn('[VL.ui] 未注册 ' + kind + ' 渲染器（该页面未接提示门面）· 首条：' + String(msg || '').slice(0, 80)); } catch (e) {}
    try { vlLogAction('ui.facade.unregistered', kind + ' 渲染器未注册（该页面未接提示门面）', { level: 'error' }); } catch (e) {}
  }

  var VLUI = {
    registerToast: function (fn) { if (typeof fn === 'function') _toastRender = fn; },
    registerStatus: function (fn) { if (typeof fn === 'function') _statusRender = fn; },
    registerStatusDone: function (fn) { if (typeof fn === 'function') _statusDoneRender = fn; },
    registerDialog: function (fn) { if (typeof fn === 'function') _dialogRender = fn; },
    /** 对话框 / 确认框：先记一条（标题 + 正文摘要），再交页面渲染；返回值原样透传。
     *  用户"被问到过什么、按了什么"同样是还原现场的关键 —— 只记 toast 会漏掉确认类交互。 */
    dialog: function (opts) {
      var o = opts || {};
      try {
        var title = String(o.title || o.heading || '').slice(0, 60);
        var body = String(o.message || o.text || o.body || o.desc || '').slice(0, 160);
        var danger = !!(o.danger || o.type === 'danger' || o.kind === 'error');
        _uiLog('ui.dialog', (title ? title + ' · ' : '') + body, danger ? 'error' : 'info');
      } catch (e) {}
      if (!_dialogRender) { _uiWarn('dialog', o.message || o.title); return null; }
      try { return _dialogRender(opts); } catch (e) { return null; }
    },
    /** @param {string} message @param {true|'info'|'ok'|'error'} [type] */
    toast: function (message, type) {
      _uiLog('ui.toast', message, (type === true || type === 'error') ? 'error' : 'info');
      if (!_toastRender) { _uiWarn('toast', message); return null; }
      try { return _toastRender(message, type); } catch (e) { return null; }
    },
    /** @param {string} message @param {{ok?: boolean, kind?: string}} [opts] */
    status: function (message, opts) {
      var fail = !!(opts && (opts.ok === false || opts.kind === 'error'));
      _uiLog('ui.status', message, fail ? 'error' : 'info');
      if (!_statusRender) { _uiWarn('status', message); return null; }
      try { return _statusRender(message, opts); } catch (e) { return null; }
    },
    statusDone: function (message) {
      _uiLog('ui.status.done', message, 'info');
      if (!_statusDoneRender) { _uiWarn('statusDone', message); return null; }
      try { return _statusDoneRender(message); } catch (e) { return null; }
    },
    _registered: function () {
      return { toast: !!_toastRender, status: !!_statusRender, statusDone: !!_statusDoneRender };
    },
  };

  root.VL = root.VL || {};
  root.VL.ui = VLUI;
  root.VL.STATUS_TEXT = STATUS_TEXT;
  root.VL.esc = esc;
  root.VL.fmtDur = fmtDur;
  root.VL.fmtSize = fmtSize;
  root.VL.vlLogAction = vlLogAction;
  root.VL.vlInstallUiCapture = vlInstallUiCapture;
  root.VL.fmtWhen = fmtWhen;
  root.VL.fmtHms = fmtHms;
  root.VL.RATIO_PRESETS = RATIO_PRESETS;
  root.VL.RATIO_RATIOS = RATIO_RATIOS;
  root.VL.ratioLabelOf = ratioLabelOf;
  root.VL.isPresetRatio = isPresetRatio;
  root.VL.presetOf = presetOf;
  root.VL.pairByWidth = pairByWidth;
  root.VL.pairByHeight = pairByHeight;
  root.VL.createSizeLink = createSizeLink;
})(typeof window !== 'undefined' ? window : globalThis);
