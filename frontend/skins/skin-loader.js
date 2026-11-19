// Video Lab — 皮肤运行时：行为层注册表、按清单加载行为脚本、切换编排与生命周期契约
// 契约：皮肤可通过 VL_SkinRuntime.register(id, { apply(), dispose() }) 注册可选行为模块；
// apply 记下所做的全部修改，dispose 必须完全还原（含内联样式、注入的 <style>、加在 body 上的类与属性）。
// 切换皮肤时先 dispose 旧模块并还原 DOM、再 apply 新模块，保证热切换零残留。
'use strict';
(function () {
  var MODS = {};
  var current = null; // { id, mod, snapshot }
  var manifest = null;
  var pending = {};   // id → 等待脚本加载完成的回调队列

  function safe(fn, label) {
    try { fn(); } catch (e) { console.error('[skin:' + label + ']', e); }
  }

  // 记录 apply 前的 DOM 与环境快照
  function takeSnapshot() {
    var doc = document;
    var snap = {
      skinAttr: doc.documentElement ? doc.documentElement.getAttribute('data-skin') : null,
      bodyClass: doc.body ? doc.body.className : '',
      bodyStyle: doc.body ? doc.body.getAttribute('style') : null,
      bodyAttrs: [],
      headStyles: []
    };
    if (doc.body) {
      for (var i = 0; i < doc.body.attributes.length; i++) {
        var a = doc.body.attributes[i];
        snap.bodyAttrs.push({ name: a.name, value: a.value });
      }
    }
    if (doc.head) {
      var styles = doc.head.querySelectorAll('style');
      for (var j = 0; j < styles.length; j++) snap.headStyles.push(styles[j]);
    }
    return snap;
  }

  // 契约还原：保证 apply 所做的修改在 dispose 时被完全撤销
  function restoreSnapshot(snap, skinId) {
    var doc = document;
    if (!snap) return;

    // 1. 还原 documentElement 的 data-skin 属性
    if (doc.documentElement) {
      if (snap.skinAttr !== null && snap.skinAttr !== undefined) {
        doc.documentElement.setAttribute('data-skin', snap.skinAttr);
      } else {
        doc.documentElement.removeAttribute('data-skin');
      }
    }

    // 2. 还原 body 类名与内联样式
    if (doc.body) {
      doc.body.className = snap.bodyClass;
      if (snap.bodyStyle !== null && snap.bodyStyle !== undefined) {
        doc.body.setAttribute('style', snap.bodyStyle);
      } else {
        doc.body.removeAttribute('style');
      }

      // 3. 还原 body 属性（移除所有在皮肤期间新增的 data-* 属性，还原被修改的原有属性）
      var snapAttrMap = {};
      for (var i = 0; i < snap.bodyAttrs.length; i++) {
        snapAttrMap[snap.bodyAttrs[i].name] = snap.bodyAttrs[i].value;
      }
      var currentAttrs = Array.prototype.slice.call(doc.body.attributes);
      for (var k = 0; k < currentAttrs.length; k++) {
        var attrName = currentAttrs[k].name;
        if (!(attrName in snapAttrMap)) {
          doc.body.removeAttribute(attrName);
        } else if (doc.body.getAttribute(attrName) !== snapAttrMap[attrName]) {
          doc.body.setAttribute(attrName, snapAttrMap[attrName]);
        }
      }
    }

    // 4. 清理所有注入的装饰 DOM 元素（通过 owner / chrome 标记）
    var ownerSel = '[data-skin-owner], [data-skin-chrome]';
    var injected = doc.querySelectorAll(ownerSel);
    for (var m = 0; m < injected.length; m++) {
      if (injected[m].parentNode) injected[m].parentNode.removeChild(injected[m]);
    }

    // 5. 清理在 head 中新增的 <style>（未在快照中的 style）
    if (doc.head) {
      var currentStyles = doc.head.querySelectorAll('style');
      for (var n = 0; n < currentStyles.length; n++) {
        var s = currentStyles[n];
        if (snap.headStyles.indexOf(s) < 0) {
          if (s.parentNode) s.parentNode.removeChild(s);
        }
      }
    }
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

  function applyNow(id, existingSnap) {
    if (current && current.id === id) return;
    if (current) {
      runtime.disposeAll();
    }
    var snap = existingSnap || takeSnapshot();
    var mod = MODS[id];
    current = { id: id, mod: mod || null, snapshot: snap };
    if (!mod) return;
    // apply 前幂等清理残留装饰
    if (mod.disposeLocal) safe(function () { mod.disposeLocal(); }, 'disposeLocal:' + id);
    safe(function () { mod.apply(); }, 'apply:' + id);
  }

  var runtime = {
    register: function (id, mod) { MODS[id] = mod; },

    // 切换皮肤行为：id 为最终生效的皮肤 id（行为脚本按需加载后再生效）
    sync: function (id, cb) {
      ensureBehavior(id, function () {
        applyNow(id);
        if (typeof cb === 'function') cb();
      });
    },

    // 契约 API：显式应用皮肤（设置属性 + 注入行为）并记录快照
    apply: function (id, cb) {
      var self = this;
      return new Promise(function (resolve) {
        if (current) {
          self.disposeAll();
        }
        var snap = takeSnapshot();
        if (document.documentElement) {
          document.documentElement.setAttribute('data-skin', id);
        }
        ensureBehavior(id, function () {
          applyNow(id, snap);
          if (typeof cb === 'function') safe(cb, 'apply-cb:' + id);
          resolve();
        });
      });
    },

    // 契约 API：显式销毁指定皮肤并完全还原 DOM
    dispose: function (id) {
      if (id && current && current.id !== id) return;
      this.disposeAll();
    },

    disposeAll: function () {
      if (!current) return;
      var cur = current;
      current = null;
      if (cur.mod && cur.mod.dispose) {
        safe(function () { cur.mod.dispose(); }, 'dispose:' + cur.id);
      }
      if (cur.snapshot) {
        restoreSnapshot(cur.snapshot, cur.id);
      }
    },

    isActive: function (id) { return current !== null && current.id === id; },

    // 供调试/守门使用：当前清单
    list: function () { return skins().slice(); },

    // 供守门获取当前活跃状态与快照
    getCurrent: function () { return current; }
  };

  window.VL_SkinRuntime = runtime;
})();
