// -*- coding: utf-8 -*-
// Video Lab — 设置窗口逻辑（通用设置 / 批量拼接 / 视频复刻）
'use strict';
(function () {
  var _backupCfgDir = ''; // 备份配置目录（输入框只读显示实际落盘位置，保存用此值）
  var $ = VL.$;   // 取元素：实现见 common.js
  var api = window.txapi;
  // HTML 转义：IIFE 顶层共享 —— 供 renderMd（Markdown 渲染）与 loadAboutInfo（关于页组件区）共用。
  // 定义在 IIFE 顶层供 renderMd 与 loadAboutInfo 共用；只定义在某一函数内时，另一处会报「esc is not defined」。
  var esc = VL.esc;   // HTML 转义：实现见 common.js

  // 数字输入框：禁用滚轮滚动改值（仅保留手动输入）
  document.addEventListener('wheel', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'range')) ev.preventDefault();
  }, { passive: false });

  var THEMES = [
    { id: 'white_blue', label: '浅色', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '深色', bg: '#111113', theme: '#FF6600' },
    { id: 'Maid_Atelier', label: '深海女仆', bg: '#0e1d49', theme: '#c5a468' }
  ];
  var state = {
    batch: { root: '', max_duration: '', max_retry: '', speed_limit: '', txt_prefix: [], producer: '', suffix_mark: '' },
    // ⚠ 复刻不再携带 max_duration / speed_limit —— 这两项与批量拼接共用同一套（后端 runReplica 读 config.batch），
    //   携带空字符串随保存写库会把后端校验/默认值覆盖掉，导致所有复刻任务启动被拒
    replica: { dedup_ratio: '', dedup_ratio_max: '', dedup_ratio_on: true, dedup_ratio_max_on: true },
    mask: { root: '', watermark_mov: '', watermark_alpha: '' }
  };
  // 轻量 Markdown 渲染（标题 / 有序无序列表 / 表格 / 引用 / 行内链接与粗体 / 代码块 / 空行）
  function renderMd(text) {
    // 行内：剥离 img 标签 → 转义 → 反引号代码 / **粗体** / [text](url) / <url>
    function inline(s) {
      s = String(s == null ? '' : s).replace(/<img[^>]*>/gi, '');
      s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 剥离 markdown 图片语法（badge 图等）
      s = esc(s);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // [text](url)：仅文字非空才渲染链接；剥图残留的空 [](url) 直接移除不显示
      s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (m, txt, u) {
        if (!txt) return '';
        return '<a href="' + u + '">' + txt + '</a>';
      });
      // 尖括号裸链：< > 已转义为实体，需按实体匹配
      s = s.replace(/&lt;((?:https?:\/\/)[^>&\s]+)&gt;/g, '<a href="$1">$1</a>');
      return s;
    }
    var lines = String(text || '').split(/\r?\n/);
    var html = '', inList = false, inCode = false, inBlock = false;
    var flushList = function () { if (inList) { html += '</ul>'; inList = false; } };
    var flushBlock = function () { if (inBlock) { html += '</blockquote>'; inBlock = false; } };
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i];
      if (/^\s*```/.test(t)) { flushList(); flushBlock(); html += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
      if (inCode) { html += esc(t) + '\n'; continue; }
      // 表格：收集连续 | 行
      if (/^\s*\|/.test(t)) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        i--;
        flushList(); flushBlock();
        var header = rows[0].replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/);
        var bodyStart = 1;
        if (rows[1] && /^\s*\|?\s*:?-{2,}/.test(rows[1])) bodyStart = 2;
        html += '<table><thead><tr><th>' + header.map(inline).join('</th><th>') + '</th></tr></thead><tbody>';
        for (var r = bodyStart; r < rows.length; r++) {
          var cells = rows[r].replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/);
          html += '<tr><td>' + cells.map(inline).join('</td><td>') + '</td></tr>';
        }
        html += '</tbody></table>';
        continue;
      }
      // 引用
      var q = /^>\s?(.*)$/.exec(t);
      if (q) { flushList(); if (!inBlock) { html += '<blockquote>'; inBlock = true; } html += '<p>' + inline(q[1] || '') + '</p>'; continue; }
      if (inBlock) { flushBlock(); }
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { flushList(); var lv = Math.min(h[1].length, 4); html += '<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'; continue; }
      var ul = /^\s*[-*]\s+(.*)$/.exec(t);
      if (ul) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(ul[1]) + '</li>'; continue; }
      flushList();
      if (/^\s*<(\/)?(div|br)[^>]*>\s*$/i.test(t)) { continue; }
      if (/^-{3,}\s*$/.test(t)) { flushList(); flushBlock(); html += '<hr>'; continue; }
      if (!t.trim()) { continue; } // 空行不输出，避免多余空隙
      var para = inline(t);
      if (para) html += '<p>' + para + '</p>';
    }
    flushList(); flushBlock();
    return html;
  }

  // 不需要保存的控件：容器打 data-nosave 标记，绑定时跳过
  function isNoSave(el) { return !!(el.closest && el.closest('[data-nosave]')); }

  // 绑定「变更即保存」：只负责事件绑定（即时保存靠它触发）；
  // 不再插红色 *（未保存标记）与包裹层 —— 已无「未保存」概念。
  function wrapAllInputs() {
    document.querySelectorAll('.form-input').forEach(function (input) {
      if (input.dataset.wrapped) return;
      if (isNoSave(input)) return;
      input.dataset.wrapped = '1';
      input.addEventListener('input', recomputeDirty);
      input.addEventListener('change', recomputeDirty);
    });
  }

  // ── 全即时保存──
  // 设置页取消「保存」按钮与「未保存」概念：任何改动都在防抖后直接落库。
  // 依据：① 设置项都是开关与标量，不存在"编辑半成品"的语义（那是配置编辑器的场景）；
  var _saveTimer = null;
  var _saving = false, _saveAgain = false;   // 保存串行化：进行中再次改动 → 合并为"完成后再存一次"
  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () { _saveTimer = null; collectAndSave(true); }, 400);
  }

  /** 立即落库（取消防抖窗口）：离开/隐藏页面时调用，避免 400ms 内的改动丢失 */
  function flushSave() {
    if (!_saveTimer) return;
    clearTimeout(_saveTimer);
    _saveTimer = null;
    collectAndSave(true);
  }

  function recomputeDirty() {
    scheduleSave();
  }

  function setSkin(id) {
    var real = THEMES.some(function (t) { return t.id === id; }) ? id : THEMES[0].id;
    document.documentElement.setAttribute('data-skin', real);
    try { localStorage.setItem('vl_skin', real); } catch (e) {}   // 与主窗口共享，供内嵌页首屏注入
    var items = document.querySelectorAll('#themeRow .theme-item');
    items.forEach(function (it) { it.classList.toggle('is-active', it.dataset.theme === id); });
  }

  function buildThemeRow() {
    var row = $('themeRow');
    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-item';
      b.dataset.theme = t.id;
      b.innerHTML = '<span class="theme-item__swatch"><i class="theme-item__bg" style="background:' + t.bg + '"></i><i class="theme-item__theme" style="background:' + t.theme + '"></i></span>' + t.label;
      b.addEventListener('click', function () { setSkin(t.id); recomputeDirty(); });
      row.appendChild(b);
    });
  }

  // 兼容旧单值（字符串）与新多值（数组）：字符串按分号/换行拆多值，否则单元素数组
  function toArr(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
    var s = String(v == null ? '' : v).trim();
    if (!s) return [];
    return s.split(/[;\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // 多值输入（提取前缀/后缀）：回车添加 → tags 列表展示，可拖拽排序（顺序即成片名前后顺序），点击删除。
  // 列表默认折叠：输入框兼作折叠开关 —— 点击输入框/箭头展开，点击两者之外折叠；
  // 折叠态下 placeholder 显示已设项摘要，因此不展开也能看清配了什么。
  function setupMultiTags(inputId, listId, storeRef, onChange, caretId) {
    var input = $(inputId);
    var list = $(listId);
    if (!input || !list) return;
    var getStore = (typeof storeRef === 'function') ? storeRef : function () { return storeRef; };
    // 幂等：本函数在两条初始化流程中各被调用一次，重复绑定会让回车/失焦处理各跑两遍；
    // 但第二次仍需重新渲染 —— 配置可能在这两次调用之间才加载完，直接 return 会让已设项不显示
    if (input.dataset.mtBound === '1') { if (input._mtRender) input._mtRender(); return; }
    input.dataset.mtBound = '1';
    var caret = caretId ? $(caretId) : null;
    var group = input.closest ? input.closest('.form-group') : null;
    var expanded = false; // 默认折叠

    var summarize = function () {
      var store = getStore();
      if (!store.length) return '输入后回车添加，可添加多个';
      return '已设 ' + store.length + ' 项，点击可调整前后顺序';
    };
    var applyFold = function () {
      list.hidden = !expanded;
      if (caret) caret.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (group) group.classList.toggle('is-tags-open', expanded);
      input.placeholder = !getStore().length ? '输入后回车添加，可添加多个' : (expanded ? '回车继续添加…' : summarize());
    };
    var render = function () {
      var store = getStore(); // 每次渲染都取最新引用
      list.innerHTML = '';
      store.forEach(function (v, i) {
        var row = document.createElement('div');
        row.className = 'multi-tags__row';
        row.draggable = true;
        row.dataset.idx = i;
        row.innerHTML = '<span class="multi-tags__drag">&#9776;</span><span class="multi-tags__text" title="' + v.replace(/"/g, '&quot;') + '">' + v + '</span><button type="button" class="multi-tags__del" title="删除该项">&#10005;</button>';
        // 拖拽排序：行可拖，落到其它行前/后交换位置（顺序即成片名顺序）
        row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('multi-tags__row--drag'); });
        row.addEventListener('dragend', function () { row.classList.remove('multi-tags__row--drag'); });
        row.addEventListener('dragover', function (e) { e.preventDefault(); });
        row.addEventListener('drop', function (e) {
          e.preventDefault();
          var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (Number.isNaN(from) || from === i) return;
          var arr = getStore();
          var moved = arr.splice(from, 1)[0];
          arr.splice(i, 0, moved);
          render();
          if (onChange) onChange();
        });
        row.querySelector('.multi-tags__del').addEventListener('click', function () {
          getStore().splice(i, 1);
          render();
          if (onChange) onChange();
        });
        list.appendChild(row);
      });
      applyFold();
    };
    var expand = function (focusInput) {
      if (!expanded) { expanded = true; render(); }
      if (focusInput && document.activeElement !== input) input.focus();
    };
    var collapse = function () { if (expanded) { expanded = false; render(); } };

    input.addEventListener('mousedown', function () { expand(false); });
    input.addEventListener('focus', function () { expand(false); });
    if (caret) {
      caret.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 不让箭头抢走输入焦点
      caret.addEventListener('click', function () { if (expanded) collapse(); else expand(true); });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var v = input.value.trim();
        var arr = getStore();
        if (v && arr.indexOf(v) === -1) { arr.push(v); input.value = ''; expanded = true; render(); if (onChange) onChange(); }
        else if (!v) { render(); }
      }
    });
    input.addEventListener('blur', function () {
      var v = input.value.trim();
      var arr = getStore();
      if (v && arr.indexOf(v) === -1) { arr.push(v); input.value = ''; render(); if (onChange) onChange(); }
    });
    // 点击输入框与列表之外的区域折叠；列表内部的拖拽/删除不触发，否则无法连续操作
    document.addEventListener('mousedown', function (e) {
      if (!expanded) return;
      var t = e.target;
      if (input.contains(t) || list.contains(t) || (caret && caret.contains(t))) return;
      collapse();
    });
    input._mtRender = render; // 供重复调用时刷新（见上方幂等分支）
    render();
  }

  function updatePreview() {
    // 预览里只用占位符「前缀」表示该段：实际命中哪几个前缀要到运行时才判定
    // （多命中会按设置顺序全部写入、以 - 分隔），此处展开真实值反而误导
    var prefixCount = toArr(state.batch.txt_prefix).length;
    var producer = $('batchProducer').value.trim();
    var suffixMark = String(state.batch.suffix_mark || '');
    var now = new Date();
    var datePrefix = String(now.getFullYear()).slice(2)
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0');
    var items = [datePrefix];
    if (producer) items.push(producer);
    if (prefixCount) items.push('前缀');
    items.push('项目文件夹');
    items.push('TXT配置名');
    // 成片名：<日期>-<创作者>-<前缀>-项目文件夹-TXT配置名[-后缀]-1.mp4
    // 后缀先去掉首尾多余横线再插入，保证「-后缀-序号」；无后缀时不产生连续分隔符（--）
    var sm = String(state.batch.suffix_mark || '').replace(/^-+|-+$/g, '');
    var base = items.join('-').replace(/-{2,}/g, '-');
    var name = base + (sm ? '-' + sm : '') + '-1.mp4';
    $('batchNamePreview').textContent = name;
  }

  // 多值标签（提取前缀 / 后缀）增删或改序后：刷新成片名预览并重算「未保存」标记。
  // ⚠ 必须定义在顶层：loadSettings 的回调与 bindSave 两处都要引用它 ——
  // 定义在 bindSave 内部会让 loadSettings 回调求值该标识符时抛 ReferenceError，
  function onBatchTagsChanged() { updatePreview(); recomputeDirty(); }

  // 每日定时检查更新时间下拉：24 小时制整点选项（默认 9:00）
  function fillCheckUpdateHourOptions() {
    var sel = $('checkUpdateHour');
    if (!sel || sel.options.length > 0) return;
    for (var i = 0; i < 24; i++) {
      var o = document.createElement('option');
      o.value = i;
      o.textContent = i + ':00';
      if (i === 9) o.selected = true;
      sel.appendChild(o);
    }
  }

  function loadSettings() {
    fillCheckUpdateHourOptions();
    api.get_settings().then(function (s) {
      if (!s) return;
      setSkin(s.skin);
      // 工作路径属批量拼接（batch.root）：随该页的表单项一起读写
      $('cfgRoot').value = (s.batch && s.batch.root) || '';
      var chk = $('autoCheckUpdate');
      if (chk) chk.checked = s.auto_check_update !== false;
      var cd = $('checkUpdateDaily');
      if (cd) cd.checked = s.check_update_daily === true;
      var ch = $('checkUpdateHour');
      if (ch) ch.value = (s.check_update_hour >= 0 && s.check_update_hour <= 23) ? s.check_update_hour : 9;
      var as = $('autoStart');
      if (as) as.checked = s.autostart === true;
      var nte = $('notifyTaskEnd');
      if (nte) nte.checked = s.notify_task_end !== false;   // 默认开启
      var bd = $('backupDir');
      if (bd) {
        // 只读：备份目录仅能通过「选择文件夹」按钮修改；显示实际落盘位置
        bd.readOnly = true;
        bd.placeholder = s.backup_dir_effective || '';
        if (s.backup_root_effective) { bd.value = s.backup_root_effective; bd.title = '实际落盘位置：' + s.backup_root_effective; }
      }
      _backupCfgDir = String(s.backup_dir || '');
      // 「打开备份目录」行：显示备份实际落盘根（自定义目录时含「Video Lab 备份」层）
      var bdp = $('backupDirPath');
      if (bdp) { bdp.textContent = s.backup_root_effective || ''; bdp.title = bdp.textContent; }   // 路径过长时 CSS 省略号收尾，完整值放 title
      var bac = $('backupAutoClean');
      if (bac) bac.checked = s.backup_auto_clean === true;
      var bkd = $('backupKeepDays');
      if (bkd) bkd.value = String(s.backup_keep_days || 7);
      var cbv = s.close_behavior === 'exit' ? 'exit' : 'tray';
      document.querySelectorAll('input[name="closeBehavior"]').forEach(function (r) { r.checked = r.value === cbv; });
      document.querySelectorAll('input[name="updateSource"]').forEach(function (r) { r.checked = r.value === s.update_source; });
      var um = s.update_mode === 'auto' ? 'auto' : 'notify';
      document.querySelectorAll('input[name="updateMode"]').forEach(function (r) { r.checked = r.value === um; });
      // 数据目录已写死 AppData，设置页不再有 configStorage 单选项（无 radio 可回填）
      var hp = $('httpPort'); if (hp) hp.value = s.http_port || 9527;
      var htk = $('httpToken');
      if (htk) htk.value = s.http_token || '';
      // 访问链接：可点击直访（a 标签），随端口/token 变化实时重建
      function refreshHttpUrl() {
        var hu = $('httpUrl');
        if (!hu) return;
        var port = parseInt(($('httpPort') || {}).value, 10) || 9527;
        var tk = (($('httpToken') || {}).value || '').trim() || (s.http_token || '');
        if (tk) {
          hu.textContent = 'http://localhost:' + port + '/?token=' + tk;
          hu.href = hu.textContent;
          hu.title = '点击在浏览器中打开该访问地址';
        } else {
          hu.textContent = '浏览器访问地址待生成';
          hu.href = '#';
          hu.title = '保存后生成浏览器访问地址';
        }
      }
      refreshHttpUrl();
      var hpInp = $('httpPort'); if (hpInp) hpInp.addEventListener('input', refreshHttpUrl);
      var tkInp = $('httpToken'); if (tkInp) tkInp.addEventListener('input', refreshHttpUrl);
      // 点击访问链接：浏览器侧直接新标签打开；本体用 open_external
      var urlLink = $('httpUrl');
      if (urlLink) urlLink.addEventListener('click', function (e) {
        var href = urlLink.getAttribute('href');
        if (!href || href === '#') { e.preventDefault(); setStatus('浏览器访问地址尚未生成', false); return; }
        e.preventDefault();
        if (!VL.host.isElectron) { try { window.open(href); } catch (err) {} return; }
        if (api && api.open_external) api.open_external(href).catch(function () {});
        else try { window.open(href); } catch (err) {}
      });
      // 随机生成令牌：32 位十六进制（与后端生成规则一致），并重建链接
      var genBtn = $('btnGenToken');
      if (genBtn) genBtn.addEventListener('click', function () {
        var bytes = [];
        for (var i2 = 0; i2 < 16; i2++) bytes.push(Math.floor(Math.random() * 256));
        var hex = bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        if (htk) { htk.value = hex; }
        refreshHttpUrl();
        recomputeDirty();
      });
      // 数据目录已写死 AppData：只显示这一个路径（页面上的 program 侧元素已移除）。
      // 回退到 storageDir（当前实际生效的数据根），保证这一行任何时候都不空。
      var pa = $('cfgPathAppdata');
      if (pa) { pa.textContent = s.config_path_appdata || s.storageDir || ''; pa.title = pa.textContent; }   // 同上
      var ld = $('logDirPath');
      if (ld) { ld.textContent = s.log_dir || ''; ld.title = ld.textContent; }   // 同上
      // 「缓存管理」：单选策略（不删 / 自动删除+天数）；天数下拉始终可改（记忆预选值）
      var ci = s.cache_info || {};
      var cs = $('cacheSize');
      if (cs) cs.textContent = fmtSize(ci.size);
      var ckc = $('cacheKeepDays');
      var policy = (s.cache_keep_days || 0) > 0 ? 'auto' : 'off';
      document.querySelectorAll('input[name="cachePolicy"]').forEach(function (rd) { rd.checked = rd.value === policy; });
      if (ckc) ckc.value = String((s.cache_keep_days || 0) > 0 ? s.cache_keep_days : 7);
      var b = s.batch || {};
      $('batchSuffixMark').value = b.suffix_mark != null ? b.suffix_mark : '';
      $('batchMaxDuration').value = b.max_duration != null ? b.max_duration : '';
      $('batchMaxRetry').value = b.max_retry != null ? b.max_retry : '';
      $('batchSpeedLimit').value = b.speed_limit != null ? b.speed_limit : '';
      state.batch.txt_prefix = toArr(b.txt_prefix);
      $('batchProducer').value = b.producer != null ? b.producer : '';
      var r = s.replica || {};
      // 复刻的「成片时长上限 / 加速阈值 / 每档轮数」已与批量拼接共用同一套（副本遵循批量设置），
      // 独立视图已移除，这里不再单独渲染这些字段。
      $('replicaDedupRatio').value = r.dedup_ratio != null ? r.dedup_ratio : '';
      var rdm = $('replicaDedupMax');
      if (rdm) rdm.value = r.dedup_ratio_max != null ? r.dedup_ratio_max : '';
      var rdo = $('replicaDedupRatioOn');
      if (rdo) rdo.checked = r.dedup_ratio_on !== false;      // 默认启用
      var rdmo = $('replicaDedupMaxOn');
      if (rdmo) rdmo.checked = r.dedup_ratio_max_on !== false;
      var mk = s.mask || {};
      $('maskRoot').value = mk.root || '';
      $('maskWatermark').value = mk.watermark_mov || '';
      $('maskAlpha').value = mk.watermark_alpha != null && String(mk.watermark_alpha).trim() !== '' ? mk.watermark_alpha : '';
      setupMultiTags('batchTxtPrefix', 'batchTxtPrefixTags', function () { return state.batch.txt_prefix; }, onBatchTagsChanged, 'batchTxtPrefixCaret');
      updatePreview();
      // 读取设置完毕：不再需要记录原始值（已无「未保存」概念），也不触发保存
    }).catch(function (e) { setStatus('读取设置失败：' + ((e && e.message) || e), false); });
  }

  // 缓存栏位用的轻量格式化（体积 / 时间）
  var fmtSize = VL.fmtSize;   // 文件大小格式化：实现见 common.js
  function fmtTime(ts) {
    var d = new Date(Number(ts) || 0);
    if (!(d.getTime() > 0)) return '';
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtNum(n) {
    var v = Number(n) || 0;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // 缓存构成：[一个词的名称, 是否会被自动清理]。用户只需知道「这是什么」与「会不会被清」
  var CACHE_TABLE_INFO = {
    video_cache: ['视频信息', true],
    txt_content: ['配置文本', true],
    scan_cache: ['目录扫描记录', true],
    log_cache: ['日志索引', true],
    cache_kv: ['杂项缓存', true],
    verify_cache: ['预检测结果', true],
    clip_index: ['成片素材清单', false],   // 业务记录：只在成片本身已被删除时才回收
    tasks: ['任务记录', false],
    task_logs: ['任务日志', false],
    task_marks: ['任务标记', false],
    meta: ['其他数据', false],
  };

  // 轻量角落提示（toast）：仅告知、无需操作，自动消失。type：ok/error/info/warn
  // 提示统一走 VL.ui 门面：日志由门面记一次（唯一日志点），这里只负责渲染。
  function toast(message, type) { try { return VL.ui.toast(message, type); } catch (e) { return null; } }
  try { VL.ui.registerToast(_toastRender); } catch (e) { /* 门面未就绪也要让页面继续跑 */ }
  function _toastRender(message, type) { return VL.ui.toastRender(message, type); }
  // 底部状态栏已移除（那个栏除了一行平时空着的状态没别的内容，
  // 关闭由标题栏右上角按钮承接）→ 进度与结果提示统一走 toast。
  function setStatus(msg, ok) {
    var s = String(msg || '');
    if (!s) return;
    var isProgress = /^正在/.test(s) || /…$/.test(s) || /\.\.\.$/.test(s);
    // 过程提示用 info 样式；结果提示用 ok / error
    if (isProgress) { toast(s, ok === false ? 'error' : 'info'); return; }
    // ⚠ ok 必须显式传：省略会被当作成功（走 'ok' 样式），错误提示务必传 false
    toast(s, ok === false ? 'error' : 'ok');
  }
  function statusTimer() { setStatus('', true); }

  function bindNav() {
    var changelogLoaded = false;
    var changelogLoading = false;
    function loadChangelog() {
      if (changelogLoaded || changelogLoading) return;
      changelogLoading = true;
      var hint = $('changelogHint');
      if (hint) hint.textContent = '正在加载…';
      api.get_changelog().then(function (r) {
        changelogLoading = false;
        if (!r || !r.ok) {
          if (hint) hint.textContent = '更新日志加载失败：' + ((r && r.error) || '未知错误');
          return;
        }
        changelogLoaded = true;
        var box = $('changelogBox');
        if (box) { box.innerHTML = ''; var frag = document.createElement('div'); frag.innerHTML = renderMd(r.content || ''); box.appendChild(frag); }
        if (hint) hint.parentNode && hint.parentNode.removeChild(hint);
      }).catch(function (e) {
        changelogLoading = false;
        if (hint) hint.textContent = '更新日志加载失败：' + e.message;
      });
    }
    // 更新源不再需要单独渲染文字：名片栏里的 radio 自身就显示当前选中项（见 settings.html）
    /** 关于页 · 运行环境与组件信息：组件是自动下载的，把版本号 / 来源 / 目录显式摆出来便于核对 */
    function loadAboutInfo() {
      var box = $('aboutInfo');
      if (!box) return;
      if (!api || !api.get_about_info) { box.textContent = '（当前版本不支持）'; return; }
      api.get_about_info().then(function (r) {
        if (!r || !r.ok) { box.textContent = '读取失败：' + ((r && r.error) || '未知错误'); return; }
        var c = r.component || {}, ap = r.app || {}, rt = r.runtime || {}, ev = r.env || {};
        // 版本号放到顶部版本卡（大号字），表格里不再重复
        var vEl = $('aboutVer'); if (vEl) vEl.textContent = 'v' + (ap.version || '—');
        var rows = [
          ['数据目录', ap.storageDir || '—'],
          ['运行环境', [rt.platform, rt.electron ? ('Electron ' + rt.electron) : '', rt.chrome ? ('Chrome ' + rt.chrome) : '', rt.node ? ('Node ' + rt.node) : ''].filter(Boolean).join(' · ')],
          ['FFmpeg', (c.ffmpegVersion || c.version || '—') + (c.source ? ('（源：' + c.source + '）') : '')],
          ['FFprobe', c.ffprobeVersion || '—'],
          ['组件目录', c.dir || '—'],
          ['组件下载时间', c.downloadedAt ? String(c.downloadedAt).replace('T', ' ').slice(0, 19) : '—'],
          ['组件校验', (ev.missing && ev.missing.length) || (ev.missingEncoders && ev.missingEncoders.length)
            ? ('缺滤镜 ' + (ev.missing || []).length + ' 项 / 缺编码器 ' + (ev.missingEncoders || []).length + ' 项')
            : (ev.probeFailed ? '探测未完成' : '正常')],
        ];
        box.innerHTML = rows.map(function (it) {
          return '<div class="about-info__row"><span class="about-info__k">' + esc(it[0]) + '</span>'
            + '<span class="about-info__v">' + esc(it[1]) + '</span></div>';
        }).join('');
        // 项目仓库也放进同一容器、用同一行结构 —— 样式与上面各行完全一致（含末行无分隔线）。
        var repo = document.createElement('div');
        repo.className = 'about-info__row';
        repo.innerHTML = '<span class="about-info__k">项目仓库</span>'
          + '<span class="about-info__v">'
          + '<a href="https://github.com/HirannU-OVO/video-lab" target="_blank" rel="noopener">GitHub</a>'
          + '<span class="about-info__sep"> · </span>'
          + '<a href="https://gitcode.com/HirannU-OVO/video-lab" target="_blank" rel="noopener">GitCode</a>'
          + '</span>';
        box.appendChild(repo);
      }).catch(function (e) { box.textContent = '读取失败：' + String((e && e.message) || e); });
    }

    function loadAbout() {
      // 关于页只展示运行环境与组件；版本号与更新入口在顶部版本卡。
      loadAboutInfo();
    }
    document.querySelectorAll('.settings-nav__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.settings-nav__item').forEach(function (x) { x.classList.remove('is-active'); });
        document.querySelectorAll('.settings-view').forEach(function (v) { v.classList.remove('is-active'); });
        btn.classList.add('is-active');
        var view = $('view-' + btn.dataset.view);
        if (view) view.classList.add('is-active');
        if (btn.dataset.view === 'changelog') loadChangelog();
        else if (btn.dataset.view === 'about') loadAbout();
      });
    });
    document.querySelectorAll('[data-dir]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inputId = btn.dataset.dir;
        var cur = $(inputId).value.trim();
        // 输入框留空时，以 placeholder 显示的实际默认地址作为对话框初始位置（而非无关的工作路径）
        var startAt = cur || $(inputId).placeholder || undefined;
        api.pick_directory('选择文件夹', startAt).then(function (p) { if (p) { $(inputId).value = p; recomputeDirty(); } });
      });
    });
    // 遮罩固定水印：选择 mov 文件
    var mw = $('btnMaskWatermark');
    if (mw) mw.addEventListener('click', function () {
      var cur = $('maskWatermark').value.trim();
      api.choose_mask_file(cur || undefined).then(function (r) {
        if (r && r.ok && r.path) { $('maskWatermark').value = r.path; recomputeDirty(); }
      }).catch(function () {});
    });
  }

  // 收集全部设置项并落库。silent=true 表示由即时保存触发：
  // 此时必填项可能正被用户改写，校验失败只静默跳过，不弹「参数未设置」打扰输入。
  function collectAndSave(silent) {
    // 串行化：保存进行中又有改动 → 只记标记，等这次回来再用**最新值**存一次（避免并发互相覆盖）
    if (_saving) { _saveAgain = true; return; }
    {
      state.batch.root = $('cfgRoot').value.trim();
      state.batch.max_duration = $('batchMaxDuration').value.trim();
      state.batch.max_retry = $('batchMaxRetry').value.trim();
      state.batch.speed_limit = $('batchSpeedLimit').value.trim();
      state.batch.txt_prefix = (state.batch.txt_prefix || []).slice();
      state.batch.producer = $('batchProducer').value.trim();
      state.batch.suffix_mark = $('batchSuffixMark').value.trim();
      // 同上：复刻不再保存时长上限 / 加速阈值（与批量共用）
      state.replica.dedup_ratio = $('replicaDedupRatio').value.trim();
      state.replica.dedup_ratio_max = ($('replicaDedupMax') || {}).value ? $('replicaDedupMax').value.trim() : '';
      state.replica.dedup_ratio_on = !!($('replicaDedupRatioOn') && $('replicaDedupRatioOn').checked);
      state.replica.dedup_ratio_max_on = !!($('replicaDedupMaxOn') && $('replicaDedupMaxOn').checked);
      state.mask.root = $('maskRoot').value.trim();
      state.mask.watermark_mov = $('maskWatermark').value.trim();
      state.mask.watermark_alpha = $('maskAlpha').value.trim();

      var missing = [];
      var bn = ['max_duration', 'max_retry', 'speed_limit'];
      for (var i = 0; i < bn.length; i++) if (!(parseFloat(state.batch[bn[i]]) > 0)) missing.push('批量拼接·' + ({ max_duration: '最大时长', max_retry: '重试次数', speed_limit: '倍速阈值' })[bn[i]]);
      if (!state.batch.producer.trim()) missing.push('批量拼接·创作者名');
      
      // ⚠ 复刻**不再单独保存**时长上限与倍速阈值（两者与批量共用，见上方 state 收集处的注释），
      //    这两个字段在 state 里恒为空字符串 —— 若仍拿它们做必填校验，missing 会永远非空，
      //    于是 collectAndSave 每次都在校验处提前 return：**全部即时保存（含皮肤）静默失效**。
      if (!(parseFloat(state.replica.dedup_ratio) > 0)) missing.push('视频复刻·重复度下限');
      // 上下限关系校验（仅两者都启用时）；上限用于规避「去重过高被判定为全新视频」
      var rdMin = parseFloat(state.replica.dedup_ratio), rdMax = parseFloat(state.replica.dedup_ratio_max);
      if (state.replica.dedup_ratio_max_on && !(rdMax > 0)) missing.push('视频复刻·重复度上限');
      if (state.replica.dedup_ratio_max_on && rdMax > 0 && rdMin > 0 && rdMax < rdMin) missing.push('视频复刻·重复度上限（不能小于下限）');
      // 即时保存（silent）时必填项可能正被用户改写 → 只跳过，不弹「参数未设置」打扰输入
      // ⚠ 即时保存的「失败可见」原则：silent 只用于"用户正在输入、必填暂空"的草稿态，
      //   但**拦下保存**这件事本身必须让用户看见 —— 静默拦下会让人以为已生效。
      if (missing.length) { setStatus('暂未保存（请先补全）：' + missing.join('、'), false); return; }

      // 访问令牌：主进程只接受 8–64 位，越界会被**静默忽略**（表现为"改了没反应"）→ 这里先给可读提示
      var tkEl = $('httpToken');
      var tkVal = tkEl ? String(tkEl.value || '').trim() : '';
      if (tkVal && (tkVal.length < 8 || tkVal.length > 64)) {
        if (!silent) setStatus('访问令牌需 8–64 位（当前 ' + tkVal.length + ' 位）—— 已暂不保存该项，其余设置照常保存', false);
      }

      var skin = document.documentElement.getAttribute('data-skin') || THEMES[0].id;
      var srcEl = document.querySelector('input[name="updateSource"]:checked');
      var umEl = document.querySelector('input[name="updateMode"]:checked');
      var cbEl = document.querySelector('input[name="closeBehavior"]:checked');
      _saving = true;   // 从这里起才算"保存进行中"：校验提前返回不会把后续保存永久堵住
      api.save_settings({
        skin: skin,
        auto_check_update: !!$('autoCheckUpdate').checked,
        check_update_daily: !!$('checkUpdateDaily').checked,
        check_update_hour: parseInt($('checkUpdateHour').value, 10) || 9,
        autostart: !!$('autoStart').checked,
        notify_task_end: !!$('notifyTaskEnd').checked,
        backup_dir: _backupCfgDir || '',
        backup_auto_clean: !!($('backupAutoClean') && $('backupAutoClean').checked),
        backup_keep_days: parseInt(($('backupKeepDays') && $('backupKeepDays').value) || '7', 10) || 7,
        close_behavior: cbEl ? cbEl.value : 'tray',
        update_source: srcEl ? srcEl.value : 'gitcode',
        update_mode: umEl ? umEl.value : 'notify',
        http_port: parseInt($('httpPort').value, 10) || 9527,
        http_token: tkVal,
        batch: state.batch,
        replica: state.replica,
        mask: state.mask
      }).then(function (res) {
        if (res && res.ok) {
          // 即时保存给一个轻量反馈（不再有「保存」按钮，用户需要知道改动已落库）
          setStatus(silent ? '已自动保存' : '已保存', true); setTimeout(statusTimer, 1500);
          if (res.config_moved) setStatus('配置和数据位置已切换并生效，配置与缓存库已自动迁移', true);
        } else {
          // 失败一律可见（含自动保存）：不得静默失败
          setStatus('保存失败：' + ((res && res.error) || '未知原因') + '（改动未落库）', false);
        }
      }).catch(function (e) {
        setStatus('保存失败：' + ((e && e.message) || e) + '（改动未落库）', false);
      }).then(function () {
        _saving = false;
        if (_saveAgain) { _saveAgain = false; collectAndSave(true); }   // 保存期间的改动：完成后再存一次
      });
    }

    // 关闭按钮已移除：退出由外层控制（独立窗口失焦自动关闭；内嵌后面板显隐控制）
    setupMultiTags('batchTxtPrefix', 'batchTxtPrefixTags', function () { return state.batch.txt_prefix; }, onBatchTagsChanged, 'batchTxtPrefixCaret');
    // 后缀/创作者改动需先同步 state 再刷新预览 —— updatePreview 读的是 state，
    // 只调刷新不回写 state 的话，预览永远不包含刚输入的内容
    $('batchSuffixMark').addEventListener('input', function () {
      state.batch.suffix_mark = $('batchSuffixMark').value.trim();
      updatePreview();
    });
    $('batchProducer').addEventListener('input', function () {
      state.batch.producer = $('batchProducer').value.trim();
      updatePreview();
    });
  }

  // 全局兜底统一由 logbootstrap.js 注入（四窗口共用）；本页只挂 toast。
  // 就地 catch 请用 window.logError(where, err)（toast + 落盘一次完成）。
  window.vlToast = toast;

  function init() {
    wrapAllInputs();
    // 勾选 / 单选切换同样触发即时保存；已无「未保存」标记概念
    document.querySelectorAll('input[type=checkbox], input[type=radio]').forEach(function (input) {
      if (isNoSave(input)) return;
      input.addEventListener('change', recomputeDirty);
    });
    buildThemeRow();
    bindNav();
    // ── 检查更新：结果弹窗 + 按钮绑定 ──
    // 结果由设置页自己弹：软件端设置页是主窗口内的 iframe，浏览器端更是独立页面
    // （那里没有主窗口脚本）—— 自己弹才能同时覆盖两种形态。
    function cuBusy(on) {
      var b = $('btnCheckUpdate');
      if (!b) return;
      b.disabled = !!on;
      b.textContent = on ? '检查中…' : '检查更新';
    }
    // ── 结果弹窗：按【运行形态】分流，判据是协议而非「是否在 iframe 内」──
    //  · 软件端（file://，preload 注入 api）：设置页是主窗口内的 iframe（.settings-frame 是
    //    z-index 9999 的覆盖层且带 transform），自弹浮层会被裁切 —— 结果统一由主窗口弹
    var IS_BROWSER = !VL.host.isElectron;
    var _UR = {
      none:   { sym: '✓', cls: 'ok',   title: '已是最新版本',     close: '知道了' },
      update: { sym: '↑', cls: 'new',  title: '发现新版本',       close: '稍后', go: '立即更新' },
      error:  { sym: '!', cls: 'err',  title: '检查更新失败',     close: '知道了' },
      busy:   { sym: '…', cls: 'wait', title: '已有更新操作进行中', close: '知道了' }
    };
    function showUr(info, kind) {
      if (!IS_BROWSER) return; // 软件端交给主窗口，见上
      var mask = $('updateResultMask');
      if (!mask) return;
      var cfg = _UR[kind] || _UR.error;
      var ic = $('updateResultIcon'), ti = $('updateResultTitle'), de = $('updateResultDesc');
      var go = $('updateResultGo'), cl = $('updateResultClose');
      var cur = (info && info.current) || '';
      var ver = kind === 'update' ? ((info && info.latest) || '') : (kind === 'none' ? cur : '');
      if (ic) { ic.textContent = cfg.sym; ic.className = 'update-result__icon update-result__icon--' + cfg.cls; }
      if (ti) ti.textContent = cfg.title + (ver ? ' v' + ver : '');
      var desc;
      // 回执要能说明**实际走的是哪个仓库**：优先用后端回传的 source（它就是本次实际使用的），
      // 后端未带时按界面当前勾选兜底 —— 切了源没保存也要看得到真实去向。
      var srcLabel = (info && info.source) ? (info.source === 'github' ? 'GitHub' : 'GitCode') : '';
      if (!srcLabel) {
        var srcEl = document.querySelector('input[name="updateSource"]:checked');
        srcLabel = ((srcEl ? srcEl.value : 'gitcode') === 'github') ? 'GitHub' : 'GitCode';
      }
      var srcTag = ' · ' + srcLabel + ' 源';
      if (kind === 'none') {
        var t0 = new Date();
        var hm = ('0' + t0.getHours()).slice(-2) + ':' + ('0' + t0.getMinutes()).slice(-2);
        desc = (info && info.message) || ('当前版本' + (cur ? ' v' + cur : '') + ' 已是最新 · ' + hm + ' 完成检查' + srcTag);
      } else if (kind === 'update') {
        desc = '当前版本' + (cur ? ' v' + cur : '') + ' · 是否立即下载更新？下载完成后可在主窗口继续操作。';
      } else if (kind === 'busy') {
        desc = (info && (info.message || info.error)) || '请等当前操作结束后再试';
      } else {
        // 失败时更要指明实际走的源：换个源就能通的场景，用户得先知道刚才走的是哪个
        desc = ((info && (info.message || info.error)) || '未知错误') + srcTag;
      }
      if (de) de.textContent = desc;
      if (go) { if (cfg.go) { go.style.display = ''; go.textContent = cfg.go; } else { go.style.display = 'none'; } }
      if (cl) cl.textContent = cfg.close || '知道了';
      mask.style.display = 'flex';
    }
    function hideUr() { var m = $('updateResultMask'); if (m) m.style.display = 'none'; }
    (function initUr() {
      var mask = $('updateResultMask');
      if (!mask) return;
      mask.addEventListener('click', function (e) { if (e.target === mask) hideUr(); });
      var cl = $('updateResultClose');
      if (cl) cl.addEventListener('click', hideUr);
      var go = $('updateResultGo');
      if (go) go.addEventListener('click', function () {
        hideUr();
        if (!api || !api.start_update) { setStatus('更新功能不可用', true); return; }
        setStatus('正在连接更新服务器…', true);
        api.start_update().then(function (r) {
          if (r && r.busy) setStatus('已有更新操作进行中，请稍候', true);
        }).catch(function () { setStatus('下载更新失败', true); });
      });
    })();
    document.addEventListener('click', function (e) {
      var hit = e.target && e.target.closest ? e.target.closest('#btnCheckUpdate') : null;
      if (!hit) return;
      // 检查更新按界面当前选中值执行：先让「仓库选择 / 更新方式」即时落盘，
      // 否则切了仓库没保存就点这里，后端仍按旧配置检查，结果与界面显示不一致。
      var srcNow = document.querySelector('input[name="updateSource"]:checked');
      var modeNow = document.querySelector('input[name="updateMode"]:checked');
      var pref = {
        update_source: srcNow ? srcNow.value : 'gitcode',
        update_mode: modeNow ? modeNow.value : 'notify'
      };
      var srcLabel = pref.update_source === 'github' ? 'GitHub' : 'GitCode';
      cuBusy(true);
      setStatus('正在检查更新…', true);
      var applyPref = (api && api.apply_update_pref) ? api.apply_update_pref(pref) : Promise.resolve(null);
      applyPref.catch(function () { return null; }).then(function () {
        api.check_update(false).then(function (info) {
          cuBusy(false);
          if (!info) { showUr(null, 'error'); return; }
          if (info.busy) { showUr(info, 'busy'); return; }
          if (info.hasUpdate) {
            if (info.noAsset) {
              showUr({ current: info.current, error: '发现新版本 v' + info.latest + '，但这次发布缺少安装文件：可稍后再试，或在设置里换一个更新源（当前' + srcLabel + '）' }, 'error');
              return;
            }
            if (info.autoDownload) {
              showUr({ current: info.current, message: '发现新版本 v' + info.latest + '，已自动开始下载，进度见主窗口状态栏' }, 'busy');
              return;
            }
            showUr(info, 'update');
            return;
          }
          if (info.ok) showUr(info, 'none');
          else showUr(info, 'error');
          // 软件端里 showUr 静默不弹，结果由主窗口呈现；但「检查本身失败」这一支后端不会发
          // update_error（它只在抛错时发），不补一条状态栏提示就会毫无反应。
          if (!IS_BROWSER && !info.ok && !info.hasUpdate && !info.busy) {
            setStatus('检查更新失败：' + ((info.message || info.error) || '网络或更新源不可达'), false);
          }
        }).catch(function () { cuBusy(false); showUr(null, 'error'); if (!IS_BROWSER) setStatus('检查更新失败：请检查网络后重试', false); });
      });
    });

    // 「维护」区：重建预检测缓存（低频兜底操作）。两段式确认，避免误触这个耗时动作
    var brp = document.getElementById('btnRebuildPrecheck');
    if (brp && api && api.reset_precheck) brp.addEventListener('click', function () {
      if (brp.dataset.armed !== '1') {
        brp.dataset.armed = '1';
        brp.textContent = '再次点击确认重建';
        setStatus('将清空并重新检测全部素材，视频较多时较耗时', true);
        setTimeout(function () { if (brp.dataset.armed === '1') { brp.dataset.armed = '0'; brp.textContent = '重建'; } }, 4000);
        return;
      }
      brp.dataset.armed = '0';
      brp.disabled = true;
      brp.textContent = '重建中…';
      setStatus('正在重建预检测缓存…', true);
      api.reset_precheck().then(function (r) {
        brp.disabled = false;
        brp.textContent = '重建';
        // 环境不可用时后端直接拦下（不返回 total/valid）—— 别把它显示成「重建了 0 个」
        if (r && r.ok === false) { setStatus(String(r.error || '重建失败'), false); return; }
        setStatus('预检测缓存已重建：检测 ' + ((r && r.total) || 0) + ' 个视频，合规 ' + ((r && r.valid) || 0) + ' 个', true);
      }).catch(function (e) {
        brp.disabled = false;
        brp.textContent = '重建';
        setStatus('重建失败：' + ((e && e.message) || e), false);
      });
    });
    // 「配置与缓存库位置」行：打开**固定**的数据目录（AppData）—— 已无「当前生效的那一个」之分
    var openCfg = document.getElementById('btnOpenCfgDir');
    if (openCfg && api && api.open_folder_select) openCfg.addEventListener('click', function () {
      var pa = document.getElementById('cfgPathAppdata');
      var dir = pa ? String(pa.textContent || '').trim() : '';
      if (!dir) { setStatus('尚未确定数据文件夹', false); return; }
      api.open_folder_select(dir).then(function (r) {
        if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || '路径不存在'), true);
      }).catch(function (e) { toast('打开失败：' + e.message, true); });
    });
    // 「缓存」栏位：查看构成（页内展开）/ 立即清理 / 保留缓存时间
    var bCacheStats = document.getElementById('btnCacheStats');
    if (bCacheStats && api && api.cache_stats) bCacheStats.addEventListener('click', function () {
      var box = document.getElementById('cacheStatsBox');
      if (!box) return;
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      bCacheStats.disabled = true;
      api.cache_stats().then(function (r) {
        bCacheStats.disabled = false;
        var st = (r && r.stats) || {};
        var clean = [], keep = [];
        (st.tables || []).forEach(function (t) {
          if (!t || !t.rows) return;
          var info = CACHE_TABLE_INFO[t.table] || ['其他', false];
          var line = '　' + info[0] + '　' + fmtNum(t.rows) + ' 条 · ' + fmtSize(t.bytes);
          (info[1] ? clean : keep).push(line);
        });
        var lines = ['合计 ' + fmtSize(st.fileBytes)];
        if (clean.length) lines.push('可清理', clean.join('\n'));
        if (keep.length) lines.push('不可清理', keep.join('\n'));
        box.textContent = lines.join('\n');
        box.style.display = '';
      }).catch(function (e) {
        bCacheStats.disabled = false;
        toast('读取缓存构成失败：' + ((e && e.message) || e), true);
      });
    });
    var bCacheClean = document.getElementById('btnCacheClean');
    if (bCacheClean && api && api.clean_caches) bCacheClean.addEventListener('click', function () {
      bCacheClean.disabled = true;
      bCacheClean.textContent = '清理中…';
      api.clean_caches().then(function (r) {
        bCacheClean.disabled = false;
        bCacheClean.textContent = '立即清理';
        toast('缓存已清理：移除 ' + ((r && r.removed) || 0) + ' 条，释放 ' + fmtSize(r && r.freed) + '，现 ' + fmtSize(r && r.size), 'ok');
        var cs = document.getElementById('cacheSize');
        if (cs && r) cs.textContent = fmtSize(r.size);
        var box = document.getElementById('cacheStatsBox');
        if (box) box.style.display = 'none';
      }).catch(function (e) {
        bCacheClean.disabled = false;
        bCacheClean.textContent = '立即清理';
        toast('清理失败：' + ((e && e.message) || e), true);
      });
    });
    // 「数据目录」清理：扫描 → 勾选 → 清理。
    // 不可清项照样列出来（灰显 + 原因）—— 让用户知道它们为什么还在，免得以为「没清干净」。
    var ddList = document.getElementById('dataDirList');
    var bDDScan = document.getElementById('btnDataDirScan');
    var bDDClean = document.getElementById('btnDataDirClean');
    function ddRender(r) {
      if (!ddList) return;
      ddList.textContent = '';
      var its = (r && r.items) || [];
      var head = document.createElement('div');
      head.className = 'form-group__desc';
      head.textContent = '可清理 ' + fmtNum((r && r.cleanableCount) || 0) + ' 项 · '
        + fmtSize((r && r.cleanableBytes) || 0) + (r && r.dir ? '　' + r.dir : '');
      ddList.appendChild(head);
      its.forEach(function (it) {
        if (!it) return;
        var n = it.count || 0;
        if (!it.cleanable && !n) return;                 // 既不可清又没东西：不占版面
        var lb = document.createElement('label');
        lb.className = 'opt-check';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('data-dd-key', String(it.key || ''));
        cb.checked = !!(it.cleanable && n);
        cb.disabled = !it.cleanable || !n;
        lb.appendChild(cb);
        var bx = document.createElement('span'); bx.className = 'opt-check__box'; lb.appendChild(bx);
        var tx = document.createElement('span');
        tx.textContent = (it.label || it.key) + '　' + (n ? fmtNum(n) + ' 项 · ' + fmtSize(it.bytes) : '无')
          + (it.cleanable ? '' : '（保留：' + (it.reason || '—') + '）');
        lb.appendChild(tx);
        ddList.appendChild(lb);
        if (it.desc) {
          var d = document.createElement('div');
          d.className = 'form-group__desc';
          d.style.marginLeft = '22px';
          d.textContent = it.desc;
          ddList.appendChild(d);
        }
      });
      ddList.style.display = '';
    }
    if (bDDScan && api && api.data_dir_scan) bDDScan.addEventListener('click', function () {
      bDDScan.disabled = true;
      api.data_dir_scan().then(function (r) {
        bDDScan.disabled = false;
        ddRender(r);
      }).catch(function (e) {
        bDDScan.disabled = false;
        toast('读取数据目录失败：' + ((e && e.message) || e), true);
      });
    });
    if (bDDClean && api && api.data_dir_clean) bDDClean.addEventListener('click', function () {
      if (!ddList) return;
      var keys = [];
      ddList.querySelectorAll('input[data-dd-key]').forEach(function (c) {
        if (c.checked && !c.disabled) keys.push(c.getAttribute('data-dd-key'));
      });
      if (!keys.length) { toast('没有勾选任何可清理项', true); return; }
      bDDClean.disabled = true;
      bDDClean.textContent = '清理中…';
      api.data_dir_clean(keys).then(function (r) {
        bDDClean.disabled = false;
        bDDClean.textContent = '清理勾选项';
        // 一项都没动就说清楚原因，别让「清理成功」的吐司掩盖静默失败
        if (!r || !r.removed) {
          toast('没有可清理的内容：勾选项可能已被清理，或处于保留状态（在跑任务的快照 / 在用组件）', true);
        } else {
          toast('已清理：移除 ' + r.removed + ' 项，释放 ' + fmtSize(r.freed || 0), 'ok');
        }
        ddRender(r);
      }).catch(function (e) {
        bDDClean.disabled = false;
        bDDClean.textContent = '清理勾选项';
        toast('清理失败：' + ((e && e.message) || e), true);
      });
    });
    // 「缓存管理」：偏好单选触发保存（off=0 / auto=天数）；天数下拉始终可改
    var iCacheKeep2 = document.getElementById('cacheKeepDays');
    var cacheRadios = document.querySelectorAll('input[name="cachePolicy"]');
    function cachePolicyVal() {
      var auto = Array.prototype.some.call(cacheRadios, function (r) { return r.checked && r.value === 'auto'; });
      return auto;
    }
    if (iCacheKeep2) iCacheKeep2.addEventListener('change', function () {
      var n = parseInt(iCacheKeep2.value, 10); if (!(n > 0)) n = 7;
      iCacheKeep2.value = String(n);
      api.save_settings({ cache_keep_days: cachePolicyVal() ? n : 0 }).catch(function () {});
    });
    cacheRadios.forEach(function (rd) { rd.addEventListener('change', function () {
      if (!rd.checked) return;
      var n = parseInt((iCacheKeep2 && iCacheKeep2.value) || '7', 10); if (!(n > 0)) n = 7;
      api.save_settings({ cache_keep_days: rd.value === 'auto' ? n : 0 }).catch(function () {});
    }); });
    // 备份目录只读（仅按钮可改）：选择后保存配置目录，并即时刷新显示实际落盘位置
    var bdBtn = document.getElementById('btnPickBackupDir');
    if (bdBtn && api && api.pick_directory) {
      bdBtn.addEventListener('click', function () {
        api.pick_directory('选择备份文件夹', _backupCfgDir || '').then(function (dir) {
          if (typeof dir !== 'string' || !dir.trim()) { setStatus('已取消选择', false); return; }
          _backupCfgDir = dir.trim();
          api.save_settings({ backup_dir: _backupCfgDir }).then(function (r) {
            if (r && r.ok) toast('备份文件夹已保存', 'ok');
          }).catch(function () { setStatus('保存备份文件夹失败', true); });
          if (api.get_settings) api.get_settings().then(function (s) {
            var bdE = document.getElementById('backupDir');
            if (bdE && s && s.backup_root_effective) { bdE.value = s.backup_root_effective; bdE.title = '实际落盘位置：' + s.backup_root_effective; }
          }).catch(function () {});
        }).catch(function () { setStatus('选择备份文件夹失败', true); });
      });
    }
    // 「关闭行为」「任务结束通知」：同属「改完立刻影响当前行为」的开关 → 即时保存
    //（与皮肤 / 开机自启 / 备份目录 口径一致）
    if (api && api.save_settings) {
      document.querySelectorAll('input[name="closeBehavior"]').forEach(function (r) {
        r.addEventListener('change', function () {
          if (r.checked) api.save_settings({ close_behavior: r.value }).catch(function () {});
        });
      });
      var nteInput = document.getElementById('notifyTaskEnd');
      if (nteInput) {
        nteInput.addEventListener('change', function () {
          api.save_settings({ notify_task_end: !!nteInput.checked }).catch(function () {});
        });
      }
    }
    var openBackup = document.getElementById('btnOpenBackupDir');
    if (openBackup && api && api.open_folder_select) openBackup.addEventListener('click', function () {
      var el = document.getElementById('backupDirPath');
      var dir = el ? el.textContent : '';
      if (!dir) { setStatus('备份文件夹尚未就绪', false); return; }
      api.open_folder_select(dir).then(function (r) {
        if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || '路径不存在'), true);
      }).catch(function () { setStatus('打开失败', false); });
    });
    // 「运行日志」行：打开日志目录（排查时先找到文件）
    var openLog = document.getElementById('btnOpenLogDir');
    if (openLog && api && api.open_folder_select) openLog.addEventListener('click', function () {
      var el = document.getElementById('logDirPath');
      var dir = el ? el.textContent : '';
      if (!dir) { setStatus('日志文件夹尚未就绪', false); return; }
      api.open_folder_select(dir).then(function (r) {
        if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || '路径不存在'), true);
      }).catch(function () { setStatus('打开失败', false); });
    });
    // 失败原因映射为普通用户可读的文案
    function readableDiagErr(msg) {
      var s = String(msg || '');
      if (/EBUSY|resource busy|locked|另一个程序正在使用|正由另一进程使用/i.test(s)) {
        return '导出失败：文件被占用，请换文件名';
      }
      if (/EACCES|EPERM|permission denied|拒绝访问/i.test(s)) {
        return '导出失败：无写入权限，请换位置';
      }
      if (/ENOENT|no such file|找不到指定的路径/i.test(s)) {
        return '导出失败：路径不存在';
      }
      if (/ENOSPC|no space|空间不足|磁盘空间/i.test(s)) {
        return '导出失败：磁盘空间不足';
      }
      return '导出失败，请重试';
    }
    (function bindDiagButton() {
      var btn = document.getElementById('btnExportDiag');
      if (!btn || !api || !api.export_diag_pack || !api.pick_save_file) return;
      var LABEL = { today: '今日', '3d': '近3天', '7d': '近7天', all: '全部' };
      btn.addEventListener('click', function () {
        var sel = document.getElementById('diagRange');
        var range = (sel && sel.value) || 'today';
        btn.disabled = true;
        Promise.resolve(api.pick_save_file('保存问题反馈包到', 'VideoLab-' + (LABEL[range] || '') + '记录.zip')).then(function (p) {
          var out = String(p || '').trim();
          if (!out) { btn.disabled = false; return; }   // 用户取消：不导出
          return api.export_diag_pack('', { range: range, outPath: out }).then(function (r) {
            btn.disabled = false;
            if (r && r.ok) toast('已打包 ' + r.files + ' 个日志文件，可直接发给开发者', 'ok');
            else toast(readableDiagErr(r && r.error), true);
          });
        }).catch(function () { btn.disabled = false; toast('导出失败，请重试', true); });
      });
    })();
    // 复制浏览器访问地址：该按钮在当前设置页 DOM 中并不存在（历史残留绑定）——
    // 地址本身由 #httpUrl 链接承担（点击即用系统浏览器打开），这里显式置空以免留下"看起来会生效"的死代码。
    var btnCopyUrl = null;
    if (btnCopyUrl) btnCopyUrl.addEventListener('click', function () {
      var hu = document.getElementById('httpUrl');
      var url = hu ? hu.value : '';
      if (!url) { setStatus('浏览器访问地址尚未就绪', false); return; }
      function copyVia(txt) {
        var ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { setStatus('已复制浏览器访问地址', true); }).catch(function () { copyVia(url); setStatus('已复制浏览器访问地址', true); });
      } else { copyVia(url); setStatus('已复制浏览器访问地址', true); }
    });
    loadSettings();
    // 即时保存的兜底：页面被隐藏/卸载时，把仍在防抖窗口内（400ms）的改动立刻落库，避免丢改动
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });
    // 文档内 http 链接统一用系统默认浏览器打开（README/更新日志里的外部链接）
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
      if (!a) return;
      e.preventDefault();
      if (api && api.open_external) api.open_external(a.getAttribute('href')).catch(function () {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();