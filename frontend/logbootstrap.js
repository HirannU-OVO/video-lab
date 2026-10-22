// -*- coding: utf-8 -*-
// 前端日志引导：全部窗口共用，替代各页面自带的重复钩子。
//
(function () {
  'use strict';
  if (window.__vlLogBoot) return;
  window.__vlLogBoot = true;

  var _inReport = false;

  // 当前任务 id：VL_TASK_ID 需同时注入前端，否则前端异常落盘后无法与任务日志关联。
  // 页面在"当前任务"变化时调用 window.vlSetTaskId(id)（任务窗口最明确）；未设置时保持空，不臆造。
  var _taskId = '';
  window.vlSetTaskId = function (id) { _taskId = String(id == null ? '' : id).slice(0, 80); };
  window.vlGetTaskId = function () { return _taskId; };

  /** 落盘（唯一出口）：兼容 txapi / call / api 三种通道形态；失败静默，绝不再抛 */
  window.vlReportError = function (payload) {
    if (_inReport) return;
    _inReport = true;
    try {
      var p = payload || {};
      if (_taskId && !p.taskId) p.taskId = _taskId;   // 统一附上当前任务 id，主进程据此写入日志字段
      var api = window.txapi;
      if (api && api.report_ui_error) { api.report_ui_error(p); }
      else if (typeof window.call === 'function') { window.call('report_ui_error', p); }
      else if (window.api && window.api.report_ui_error) { window.api.report_ui_error(p); }
    } catch (x) { /* 静默 */ }
    _inReport = false;
  };

  /** 就地 catch 统一入口：toast（用户可见）+ 落盘（事后可查）一次完成。
   *  @param {string} where  调用点标识，如 'app.deleteTask'
   *  @param {Error|string} err
   *  @param {{toast?:string, ctx?:object}} [extra] toast 自定义文案 / 附加结构化上下文 */
  window.logError = function (where, err, extra) {
    var e = (err instanceof Error) ? err : new Error(String(err == null ? '' : err));
    var extra = extra || {};
    try { if (typeof window.vlToast === 'function') window.vlToast(extra.toast || ('操作失败：' + e.message), true); } catch (x) {}
    window.vlReportError({
      kind: 'catch', msg: e.message, stack: e.stack || '',
      where: String(where || ''), href: String(location.href || ''),
      ctx: extra.ctx || null,
    });
  };

  // ── 全局兜底三件套 ──
  window.addEventListener('error', function (e) {
    try { if (typeof window.vlToast === 'function') window.vlToast('界面异常：' + ((e && e.message) || '未知错误'), true); } catch (x) {}
    window.vlReportError({
      kind: 'exception', msg: String((e && e.message) || ''),
      stack: String((e && e.error && e.error.stack) || ''),
      where: 'window.error', href: String(location.href || ''),
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    try { if (typeof window.vlToast === 'function') window.vlToast('操作失败：' + ((r && r.message) || r || '未知错误'), true); } catch (x) {}
    window.vlReportError({
      kind: 'rejection', msg: String((r && r.message) || r || ''),
      stack: String((r && r.stack) || ''),
      where: 'window.rejection', href: String(location.href || ''),
    });
  });
  // console.error 也上报（很多库/分支只 console.error，界面毫无提示）—— 转发不吞：原输出保留
  var _origConsoleError = console.error;
  console.error = function () {
    try {
      var args = Array.prototype.slice.call(arguments);
      var msg = args.map(function (a) {
        try { return (a && a.stack) ? String(a.stack) : (typeof a === 'object' ? JSON.stringify(a) : String(a)); }
        catch (x) { return String(a); }
      }).join(' ');
      window.vlReportError({
        kind: 'console', msg: msg.slice(0, 4000),
        stack: (args[0] && args[0].stack) ? String(args[0].stack) : '',
        where: 'console.error', href: String(location.href || ''),
      });
    } catch (x) { /* 静默 */ }
    return _origConsoleError.apply(console, arguments);
  };
})();
