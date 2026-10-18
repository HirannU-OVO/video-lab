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

  root.VL = root.VL || {};
  root.VL.STATUS_TEXT = STATUS_TEXT;
  root.VL.esc = esc;
  root.VL.fmtDur = fmtDur;
  root.VL.fmtSize = fmtSize;
  root.VL.fmtWhen = fmtWhen;
  root.VL.fmtHms = fmtHms;
})(typeof window !== 'undefined' ? window : globalThis);
