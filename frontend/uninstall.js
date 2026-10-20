// -*- coding: utf-8 -*-
// 卸载准备窗口：读取个人数据位置与体积，收集「是否一并删除个人数据」，交给主进程执行卸载。
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.txapi || {};

  function human(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' 字节';
  }

  async function load() {
    if (typeof api.uninstall_info !== 'function') {
      $('dataPath').textContent = '请在软件中运行以读取';
      $('dataSize').textContent = '—';
      return;
    }
    try {
      const info = await api.uninstall_info();
      $('dataPath').textContent = (info && info.dataDir) || '—';
      $('dataSize').textContent = human(((info && info.dataBytes) || 0) + ((info && info.markerBytes) || 0));
      if (!info || !info.hasData) {
        $('wrapCheck').style.display = 'none';
        $('warnNoData').classList.add('show');
      }
    } catch (e) {
      $('dataPath').textContent = '读取失败，可直接继续卸载';
      $('dataSize').textContent = '—';
    }
  }

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
        $('dataPath').textContent = '未找到卸载程序，请重新安装后再卸载';
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

  load();
})();
