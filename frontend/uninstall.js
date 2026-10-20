// -*- coding: utf-8 -*-
// 卸载询问窗口：收集「是否一并删除个人数据」，交给主进程执行卸载。
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.txapi || {};

  function cancel() {
    try { if (typeof api.uninstall_cancel === 'function') api.uninstall_cancel(); } catch (e) {}
  }

  async function run(deleteData) {
    $('btnGo').disabled = true;
    $('btnCancel').disabled = true;
    $('btnConfirm').disabled = true;
    $('btnGo').textContent = '正在卸载…';
    try {
      const r = await api.uninstall_confirm({ deleteData: deleteData });
      if (r && r.ok === false) {
        $('btnGo').disabled = false;
        $('btnCancel').disabled = false;
        $('btnGo').textContent = '继续卸载';
      }
    } catch (e) {
      $('btnGo').disabled = false;
      $('btnCancel').disabled = false;
      $('btnGo').textContent = '继续卸载';
    }
  }

  $('btnClose').addEventListener('click', cancel);
  $('btnCancel').addEventListener('click', cancel);
  $('btnGo').addEventListener('click', () => {
    if ($('chkDelete').checked) { $('modal').classList.add('show'); return; }
    run(false);
  });
  $('btnBack').addEventListener('click', () => $('modal').classList.remove('show'));
  $('btnConfirm').addEventListener('click', () => { $('modal').classList.remove('show'); run(true); });
})();
