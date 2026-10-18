// Video Lab — 皮肤运行时：行为层注册表与切换编排
// 契约：皮肤可通过 VL_SkinRuntime.register(id, { apply(), dispose() }) 注册可选行为模块；
// 切换皮肤时先 dispose 旧模块、再 apply 新模块，保证热切换零残留。
'use strict';
(function () {
  var MODS = {};
  var current = null; // { id, mod }

  function safe(fn, label) {
    try { fn(); } catch (e) { console.error('[skin:' + label + ']', e); }
  }

  var runtime = {
    register: function (id, mod) { MODS[id] = mod; },

    // 切换皮肤行为：id 为最终生效的皮肤 id
    sync: function (id) {
      if (!current || current.id !== id) {
        // 不同皮肤或首次：先卸旧皮肤行为
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
    },

    disposeAll: function () {
      if (!current) return;
      safe(function () { current.mod.dispose(); }, 'dispose:' + current.id);
      current = null;
    },

    isActive: function (id) { return current !== null && current.id === id; }
  };

  window.VL_SkinRuntime = runtime;
})();