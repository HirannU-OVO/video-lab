// -*- coding: utf-8 -*-
// 卸载询问窗口：收集「是否一并删除个人数据」，交给主进程执行卸载。
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.txapi || {};

  function cancel() {
    try { if (typeof api.uninstall_cancel === 'function') api.uninstall_cancel(); } catch (e) {}
  }

  function showErr(msg) {
    const el = $('errMsg');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
  }

  function resetBtn() {
    $('btnGo').disabled = false;
    $('btnCancel').disabled = false;
    $('btnConfirm').disabled = false;
    $('btnGo').textContent = '继续卸载';
  }

  async function run(deleteData) {
    $('btnGo').disabled = true;
    $('btnCancel').disabled = true;
    $('btnConfirm').disabled = true;
    $('btnGo').textContent = '正在卸载…';
    try {
      if (typeof api.uninstall_confirm !== 'function') {
        resetBtn();
        showErr('无法启动卸载（界面与主程序未连通），请关闭后重试');
        return;
      }
      const r = await api.uninstall_confirm({ deleteData: deleteData });
      if (r && r.ok === false) {
        resetBtn();
        showErr(r.error === 'uninstaller' ? '未找到卸载程序，请重新安装后再卸载' : '启动卸载失败，请关闭后重试');
      }
    } catch (e) {
      resetBtn();
      showErr('启动卸载失败：' + ((e && e.message) || '未知错误'));
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
