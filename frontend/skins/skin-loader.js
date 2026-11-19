// Video Lab — 皮肤运行时：行为层注册表、按清单加载行为脚本、切换编排
// 契约：皮肤可通过 VL_SkinRuntime.register(id, { apply(), dispose() }) 注册可选行为模块；
// 切换皮肤时先 dispose 旧模块、再 apply 新模块，保证热切换零残留。
// 行为脚本不再由页面硬编码 <script>：清单（skins/skins.json）里写了 js 的皮肤，由本文件按需注入。
'use strict';
(function () {
  var MODS = {};
  var current = null; // { id, mod }
  var manifest = null;
  var pending = {};   // id → 等待脚本加载完成的回调队列

  function safe(fn, label) {
    try { fn(); } catch (e) { console.error('[skin:' + label + ']', e); }
  }

  // 清单读取（同步 XHR：几百字节本地文件，换来「调用点不需要异步改造」）
  function skins() {
    if (manifest) return manifest;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'skins/skins.json', false);
      xhr.send(null);
      manifest = (JSON.parse(xhr.responseText) || {}).skins || [];
    } catch (e) { manifest = []; }
    return manifest;
  }

  // 按需加载某皮肤的行为脚本（清单没写 js 就直接回调）
  function ensureBehavior(id, cb) {
    var ent = null;
    var list = skins();
    for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === id) { ent = list[i]; break; } }
    if (!ent || !ent.js) { cb(); return; }
    if (MODS[id]) { cb(); return; }                 // 已注册（脚本已执行完）
    var tag = 'script[data-skin-behavior="' + id + '"]';
    if (pending[id]) { pending[id].push(cb); return; }
    if (document.querySelector(tag)) { pending[id] = [cb]; return; }
    pending[id] = [cb];
    var el = document.createElement('script');
    el.src = ent.js;
    el.setAttribute('data-skin-behavior', id);
    var done = function () {
      var q = pending[id] || [];
      delete pending[id];
      for (var k = 0; k < q.length; k++) safe(q[k], 'load:' + id);
    };
    el.onload = done;
    el.onerror = function () { console.error('[skin] 行为脚本加载失败: ' + ent.js); done(); };
    document.head.appendChild(el);
  }

  function applyNow(id) {
    if (current && current.id === id) return;
    if (current) {
      safe(function () { current.mod.dispose(); }, 'dispose:' + current.id);
      current = null;
    }
    var mod = MODS[id];
    if (!mod) return;
    // 若该皮肤之前发生过重复 apply（如老版本 bug 堆积），apply 前幂等清理残留装饰
    if (mod.disposeLocal) safe(function () { mod.disposeLocal(); }, 'disposeLocal:' + id);
    safe(function () { mod.apply(); }, 'apply:' + id);
    current = { id: id, mod: mod };
  }

  var runtime = {
    register: function (id, mod) { MODS[id] = mod; },

    // 切换皮肤行为：id 为最终生效的皮肤 id（行为脚本按需加载后再生效）
    sync: function (id) {
      ensureBehavior(id, function () { applyNow(id); });
    },

    disposeAll: function () {
      if (!current) return;
      safe(function () { current.mod.dispose(); }, 'dispose:' + current.id);
      current = null;
    },

    isActive: function (id) { return current !== null && current.id === id; },

    // 供调试/守门使用：当前清单
    list: function () { return skins().slice(); }
  };

  window.VL_SkinRuntime = runtime;
})();
