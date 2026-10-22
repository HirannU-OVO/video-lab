// Video Lab — Maid_Atelier 行为层（移植自 dsh-deep-whale/maid-atelier 客户端）
// 装饰主窗口：角色舞台（宫殿背景 + 左右双女仆立绘）+ 侧栏 chibi/垂饰。
// 尺寸随侧栏宽度联动（CSSOM 写回 CSS 变量）；选中配置投影到
'use strict';
(function () {
  var SKIN_ID = 'Maid_Atelier';
  var OWNER = 'Maid_Atelier';
  var ROUND_PX = function (v) { return Math.round(v * 100) / 100 + 'px'; };

  function apply() {
    var doc = document;
    var sidebar = doc.querySelector('.sidebar');
    var sidebarRoot = doc.querySelector('.sidebar__root');
    var tree = doc.getElementById('sidebarTree');
    var center = doc.querySelector('.center-panel');
    if (!sidebar || !sidebarRoot || !tree || !center) return;

    // ── CSSOM 独立 style：变量默认值 + 运行时宽度更新（母本 widthSheet 模式） ──
    var sheet = doc.createElement('style');
    sheet.dataset.skinChrome = 'maid-width-rule';
    sheet.dataset.skinOwner = OWNER;
    doc.head.appendChild(sheet);
    var cssSheet = sheet.sheet;
    var ruleIndex = cssSheet.insertRule(
      'html[data-skin="Maid_Atelier"] { --vl-skin-maid-mascot-width: 260px; --vl-skin-maid-swag-height: 72px; }',
      cssSheet.cssRules.length
    );
    var widthRule = cssSheet.cssRules[ruleIndex];

    // ── 角色舞台：宫殿背景容器 + 左右双女仆立绘 ──
    var stage = doc.createElement('div');
    stage.dataset.skinChrome = 'character-stage';
    stage.dataset.skinOwner = OWNER;
    stage.setAttribute('aria-hidden', 'true');

    function makeCharacter(kind, src) {
      var img = doc.createElement('img');
      img.dataset.maidCharacter = kind;
      img.setAttribute('aria-hidden', 'true');
      img.alt = '';
      img.src = src;
      return img;
    }
    var leftMaid = makeCharacter('left', 'skins/assets/maid-left.webp');
    var rightMaid = makeCharacter('right', 'skins/assets/maid-right.webp');
    stage.append(leftMaid, rightMaid);
    // 舞台挂载点：center-panel（视频内容列，母本 chat column 对应物）。
    // 母本机制：stage 是内容列首子 z0，内容绘制在上方；右侧预览栏 / 底部配置栏
    // 出现时会把内容列挤窄/挤矮，stage 跟随内容列自动让位，因此右女仆始终锚定
    center.prepend(stage);

    // ── 日期分支装饰层（date-ornament）：金边 + 蕾丝 + 蝴蝶结，
    //    独立置于「日期分支」标题行下方（dates 之前），单独配置宽度；
    //    未选中配置时展示，body[data-maid-chat-active] 时由 CSS 隐藏。
    function buildOrnament() {
      var d3 = doc;
      var old = d3.querySelector('[data-skin-chrome="date-ornament"]');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      // 宿主：优先独立装饰容器（遮罩等无日期分支的场景），否则沿用「日期分支」行（dates 前）
      var host = d3.querySelector('.center-top__ornament-host');
      var datesHost = d3.querySelector('.center-top__dates');
      if (!host && datesHost && datesHost.parentNode) host = datesHost.parentNode;
      if (!host || !host.appendChild) return;
      var orn = d3.createElement('div');
      orn.dataset.skinChrome = 'date-ornament';
      orn.dataset.skinOwner = OWNER;
      orn.setAttribute('aria-hidden', 'true');
      if (datesHost && datesHost.parentNode === host) host.insertBefore(orn, datesHost);
      else host.appendChild(orn);
    }
    buildOrnament();
    function onSkinRefresh() { buildOrnament(); }
    doc.addEventListener('vl:skin-refresh', onSkinRefresh);

    // ── 侧栏金框角饰（sidebar-corners）：四角 62px span + 中间四段金线，
    //    注入 sidebarRoot 最前（z-index 4，母本 [data-skin-chrome='sidebar-corners']） ──
    //    母本原方式：四角共用同一张原图 sidebar-corner.webp（右上朝向），
    var corners = doc.createElement('div');
    corners.dataset.skinChrome = 'sidebar-corners';
    corners.dataset.skinOwner = OWNER;
    corners.setAttribute('aria-hidden', 'true');
    var cornerPositions = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
    for (var c = 0; c < cornerPositions.length; c++) {
      var cornerEl = doc.createElement('span');
      cornerEl.dataset.skinCorner = cornerPositions[c];
      cornerEl.dataset.skinOwner = OWNER;
      corners.append(cornerEl);
    }
    sidebarRoot.prepend(corners);

    // ── 侧栏吉祥物（sidebar-mascot）：chibi，注入 sidebarRoot 最前
    //    （z-index 0 在内容之下，母本 [data-skin-chrome='sidebar-mascot']） ──
    var mascot = doc.createElement('img');
    mascot.dataset.skinChrome = 'maid-mascot';
    mascot.dataset.skinOwner = OWNER;
    mascot.setAttribute('aria-hidden', 'true');
    mascot.alt = '';
    mascot.src = 'skins/assets/maid-chibi.webp';
    sidebarRoot.prepend(mascot);

    // ── 侧栏品牌行（sidebar-brand）：居中 appicon + 「Video Lab」标题，
    //    插到项目列表标题栏之前，将项目列表整体下移（母本 logoRow 机制） ──
    var brand = doc.createElement('div');
    brand.dataset.skinChrome = 'sidebar-brand';
    brand.dataset.skinOwner = OWNER;
    brand.setAttribute('aria-hidden', 'true');
    var brandIcon = doc.createElement('span');
    brandIcon.dataset.skinBrand = 'icon';
    brandIcon.setAttribute('aria-hidden', 'true');
    var brandText = doc.createElement('span');
    brandText.dataset.skinBrand = 'title';
    brandText.textContent = 'Video Lab';
    brand.append(brandIcon, brandText);
    var headerEl = sidebarRoot.querySelector('.sidebar__header');
    if (headerEl && headerEl.parentNode === sidebarRoot) sidebarRoot.insertBefore(brand, headerEl);
    else sidebarRoot.prepend(brand);
    // 点击品牌名片：通知应用层把中间配置栏复位到刚启动样式
    brand.addEventListener('click', function () {
      document.dispatchEvent(new CustomEvent('vl:reset-center'));
    });

    // ── 二级菜单迁移：把 sidebar-menu 从 tree-wrap(z2 栈) 移到 sidebarRoot 直接子，
    //    使其 z-index:1000 真正置顶（不被金框蕾丝饰遮住）；仍被 app.js 经
    //    #sidebarMenu 引用控制显隐 ──
    var sideMenu = doc.getElementById('sidebarMenu');
    if (sideMenu && sideMenu.parentNode !== sidebarRoot) sidebarRoot.appendChild(sideMenu);

    // 选中配置投影：.tree-txt-item--active（批量配置管理模式）或
    // .mask-proj-item--active（遮罩叠加模式选中项目）存在 ⟷ body[data-maid-chat-active]
    function syncActive() {
      var active = tree.querySelector('.tree-txt-item--active, .mask-proj-item--active') !== null;
      if (active && doc.body.dataset.maidChatActive === undefined) doc.body.dataset.maidChatActive = '';
      else if (!active && doc.body.dataset.maidChatActive !== undefined) delete doc.body.dataset.maidChatActive;
    }
    var activeObserver = null;
    if (typeof MutationObserver !== 'undefined') {
      activeObserver = new MutationObserver(syncActive);
      activeObserver.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    syncActive();

    // ── 尺寸联动：ResizeObserver 观察侧栏宽度，变化时写回 CSSOM 变量
    //    （侧栏文字 / chibi 宽度 / footer 垂饰高度，母本 applySidebarWidth 模式） ──
    function applyWidth(w) {
      var size = w <= 120 ? 'rail' : w <= 220 ? 'narrow' : 'wide';
      var mascotW = Math.min(320, w * 0.82);
      var swagH = Math.min(94, Math.max(54, w * 0.2575));
      var mascotPx = ROUND_PX(mascotW);
      var swagPx = ROUND_PX(swagH);
      if (widthRule.style.getPropertyValue('--vl-skin-maid-mascot-width') !== mascotPx) {
        widthRule.style.setProperty('--vl-skin-maid-mascot-width', mascotPx);
      }
      if (widthRule.style.getPropertyValue('--vl-skin-maid-swag-height') !== swagPx) {
        widthRule.style.setProperty('--vl-skin-maid-swag-height', swagPx);
      }
      if (doc.body.dataset.maidSidebarSize !== size) doc.body.dataset.maidSidebarSize = size;
    }
    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function (entries) {
        var w = entries[0].contentRect.width;
        if (w > 0) applyWidth(w);
      });
      ro.observe(sidebar);
    }
    var initRect = sidebar.getBoundingClientRect();
    if (initRect.width > 0) applyWidth(initRect.width);

    // 无「搜索让位」机制：女仆/装饰在点击与输入搜索时均保持显示

    // ── dispose：移除本皮肤所有装饰元素、投影属性与监听，完整还原 ──
    return function dispose() {
      doc.querySelectorAll('[data-skin-owner="' + OWNER + '"]').forEach(function (el) { el.remove(); });
      doc.removeEventListener('vl:skin-refresh', onSkinRefresh);
      var holder = doc.querySelector('[data-skin-chrome="maid-width-rule"]');
      if (holder && holder.parentNode === doc.head) doc.head.removeChild(holder);
      if (ro && typeof ro.disconnect === 'function') ro.disconnect();
      if (activeObserver && typeof activeObserver.disconnect === 'function') activeObserver.disconnect();
      delete doc.body.dataset.maidSidebarSize;
      delete doc.body.dataset.maidChatActive;
    };
  }

  var activeDispose = null;

  // 幂等清理：移除本皮肤全部装饰元素与投影（重复 apply 造成的残留也一并清掉）
  function disposeLocal() {
    var doc = document;
    doc.querySelectorAll('[data-skin-owner="' + OWNER + '"]').forEach(function (el) { el.remove(); });
    var holder = doc.querySelector('[data-skin-chrome="maid-width-rule"]');
    if (holder && holder.parentNode === doc.head) doc.head.removeChild(holder);
    delete doc.body.dataset.maidSidebarSize;
    delete doc.body.dataset.maidChatActive;
  }

  var mod = {
    apply: function () {
      activeDispose = apply();
    },
    dispose: function () {
      if (activeDispose) { try { activeDispose(); } catch (e) { console.error('[skin:Maid_Atelier] dispose', e); } }
      activeDispose = null;
    },
    disposeLocal: disposeLocal
  };

  if (window.VL_SkinRuntime) {
    window.VL_SkinRuntime.register(SKIN_ID, mod);
  }
})();