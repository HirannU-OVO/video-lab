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

  root.VL = root.VL || {};
  root.VL.STATUS_TEXT = STATUS_TEXT;
  root.VL.esc = esc;
  root.VL.fmtDur = fmtDur;
  root.VL.fmtSize = fmtSize;
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
