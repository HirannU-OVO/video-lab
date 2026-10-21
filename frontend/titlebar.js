// -*- coding: utf-8 -*-
// 自制窗口标题栏：标题居中 + 最小化/最大化/关闭控制
// 依赖 preload 暴露的 txapi.window_* 系列；无 txapi（纯浏览器预览）时按钮静默无操作。
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function applyCaps() {
    var bar = $('winTitlebar');
    if (!bar || !window.txapi || !txapi.window_caps) return;
    txapi.window_caps().then(function (caps) {
      caps = caps || {};
      var min = bar.querySelector('[data-wctl="min"]');
      var max = bar.querySelector('[data-wctl="max"]');
      var close = bar.querySelector('[data-wctl="close"]');
      // iframe 内嵌模态（如浏览器内打开设置）：仅保留关闭按钮（与本体一致），去掉最小化/最大化
      if (window.self !== window.top) {
        if (min) min.style.display = 'none';
        if (max) max.style.display = 'none';
        if (close) close.style.display = '';
      } else {
        if (min) min.style.display = caps.minimizable ? '' : 'none';
        if (max) max.style.display = caps.maximizable ? '' : 'none';
        if (close) close.style.display = caps.closable ? '' : 'none';
      }
      var title = bar.querySelector('.win-titlebar__title');
      if (title) title.textContent = pageTitleText();
    }).catch(function () {});
  }
  // 标题栏显示文本：剥离产品名前缀，只留页面名；主窗口回落为 "Video Lab"
  function pageTitleText() {
    var t = String(document.title || '');
    t = t.replace(/^Video Lab Preview\s*-\s*/, '').replace(/^Video Lab\s*-\s*/, '');
    if (!t || /^Video Lab Preview$/.test(t)) return 'Video Lab';
    return t;
  }
  // 预览版标识：标题栏徽标 + 窗口标题加 "Preview" 前缀（仅顶层窗口；浏览器端无 vlBuild，不显示）
  function applyPreviewBadge(bar) {
    if (!(window.vlBuild && window.vlBuild.preview)) return;
    if (window.self !== window.top) return;
    try {
      var t = String(document.title || '');
      if (t && !/^Video Lab Preview/.test(t)) document.title = t.replace(/^Video Lab/, 'Video Lab Preview');
    } catch (e) {}
    var titleEl = bar.querySelector('.win-titlebar__title');
    var badge = document.createElement('span');
    badge.className = 'win-titlebar__preview';
    badge.textContent = '预览版';
    badge.title = '预览版：设置与缓存与正式版完全隔离，不会影响正式数据';
    if (titleEl && titleEl.parentNode) titleEl.parentNode.insertBefore(badge, titleEl.nextSibling);
    else bar.appendChild(badge);
    bar.setAttribute('data-preview', '1');
  }
  // 预览版界面品牌：把页面里写死的产品名与内嵌图标换成预览版（顶层与 iframe 内均生效）
  function applyPreviewBranding() {
    if (!(window.vlBuild && window.vlBuild.preview)) return;
    // 产品名：静态文本补"预览版"后缀
    ['.settings-nav__brand', '.about-hero__name', '.guide-hero__title'].forEach(function (sel) {
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) {
        var t = String(nodes[i].textContent || '');
        if (/Video Lab(?!\s*预览版)/.test(t)) nodes[i].textContent = t.replace('Video Lab', 'Video Lab 预览版');
      }
    });
    // 界面内图标：关于页/引导页的 <img> 指向预览版图标
    var imgs = document.querySelectorAll('img[src*="app-icon.png"], img[src*="app_icon.svg"]');
    for (var j = 0; j < imgs.length; j++) {
      var src = imgs[j].getAttribute('src') || '';
      if (src.indexOf('/preview/') >= 0) continue;
      imgs[j].setAttribute('src', src.replace(/\/(app-icon\.png|app_icon\.svg)$/, '/preview/$1'));
    }
  }
  function syncMaxIcon() {
    var bar = $('winTitlebar');
    if (!bar) return;
    var max = bar.querySelector('[data-wctl="max"]');
    if (!max) return;
    var active = !!(bar.getAttribute('data-max') === '1');
    // 最大/还原：切换 svg 图形
    var svg = max.querySelector('.win-titlebar__svg-max');
    var svgR = max.querySelector('.win-titlebar__svg-restore');
    if (svg) svg.style.display = active ? 'none' : '';
    if (svgR) svgR.style.display = active ? '' : 'none';
  }
  function init() {
    var bar = $('winTitlebar');
    if (!bar) return;
    // 浏览器侧隐藏窗口控制按钮：独立标签页（不在 iframe 内）时浏览器自带标签栏，隐藏按钮；
    // iframe 内嵌模态（设置页在浏览器模态中）则保留关闭按钮，与本体一致的关闭交互
    if (VL.host.isHttp && window.self === window.top) {
      var ctrls = bar.querySelector('.win-titlebar__controls');
      if (ctrls) ctrls.style.display = 'none';
    }
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-wctl]');
      if (!btn || !window.txapi) return;
      var c = btn.getAttribute('data-wctl');
      if (c === 'min' && txapi.window_minimize) txapi.window_minimize();
      else if (c === 'max' && txapi.window_toggle_maximize) txapi.window_toggle_maximize();
      else if (c === 'close' && txapi.window_close) txapi.window_close();
    });
    // 双击空白区最大化/还原（按钮 no-drag 不受影响）
    bar.addEventListener('dblclick', function (e) {
      if (bcloseBtn(e.target)) return;
      if (window.txapi && txapi.window_toggle_maximize) txapi.window_toggle_maximize();
    });
    // 主窗口模式切换按钮：仅主窗口标题栏有（其他窗口无此元素，跳过即可）
    var modeBtn = $('winModeToggle');
    if (modeBtn) modeBtn.addEventListener('click', function () {
      try { document.dispatchEvent(new CustomEvent('vl:toggle-mask')); } catch (e) {}
    });
    function bcloseBtn(el) { return !!(el && el.closest && el.closest('[data-wctl]')); }
    if (window.txapi && txapi.on_window_max_changed) {
      txapi.on_window_max_changed(function (m) {
        if (m) bar.setAttribute('data-max', '1'); else bar.removeAttribute('data-max');
        syncMaxIcon();
      });
    }
    applyPreviewBadge(bar);
    applyPreviewBranding();
    applyCaps();
    syncMaxIcon();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();