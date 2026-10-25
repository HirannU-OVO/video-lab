// -*- coding: utf-8 -*-
// Video Lab — 首次引导窗口（选择工作路径；水印自动配置）
'use strict';
(function () {
  var $ = VL.$;   // 取元素：实现见 common.js
  var api = window.txapi;

  // 提示统一走 VL.ui 门面：日志由门面记一次（唯一日志点），这里只负责渲染。
  function setStatus(msg, ok) { try { return VL.ui.status(msg, { ok: ok }); } catch (e) {} }
  function _statusRender(msg, opts) {
    var el = $('guideStatus');
    if (!el) return;
    var ok = !(opts && opts.ok === false);
    el.textContent = msg || '';
    if (el.classList) el.classList.toggle('is-error', !ok);
  }
  try { VL.ui.registerStatus(_statusRender); } catch (e) { /* 同上 */ }

  // 跳过引导：用户使用窗口自带关闭按钮（右上角 X）即可，不保存直接关闭

  // 用户主动点击按钮才弹资源管理器
  $('guidePick').addEventListener('click', function () {
    api.pick_directory('选择项目数据工作路径', '').then(function (p) {
      if (p) { $('guideRoot').value = p; setStatus('', true); }
    }).catch(function () { setStatus('选择文件夹失败', false); });
  });

  $('guideSave').addEventListener('click', function () {
    var root = $('guideRoot').value.trim();
    if (!root) { setStatus('请先选择工作路径', false); return; }
    $('guideSave').disabled = true;
    api.save_guide({ root: root }).then(function (r) {
      // 引导页已内嵌为主窗口面板（iframe）：关闭需通知父窗口；window.close() 在 iframe 内无效
      if (r && r.ok) {
        try {
          if (window.self !== window.top) window.parent.postMessage({ type: 'vl-close-guide' }, '*');
          else window.close();
        } catch (e) { try { window.close(); } catch (e2) {} }
        return;
      }
      $('guideSave').disabled = false;
      setStatus('保存失败：' + ((r && r.error) || '未知错误'), false);
    }).catch(function () { $('guideSave').disabled = false; setStatus('保存失败', false); });
  });
})();