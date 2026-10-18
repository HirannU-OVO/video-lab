// -*- coding: utf-8 -*-
// Video Lab — 浏览器侧 txapi 实现
// 仅在 http/https 协议下挂载 window.txapi（Electron file: 协议下 preload.js 已注入，本脚本跳过）
(function () {
  'use strict';
  if (!location.protocol.startsWith('http')) return; // Electron 侧由 preload.js 注入

  var token = localStorage.getItem('tx_token') || '';
  // 从 URL query 取 token 存 localStorage（首次访问带 token 的 URL）
  try {
    var q = new URL(location.href).searchParams.get('token');
    if (q) { token = q; localStorage.setItem('tx_token', token); }
  } catch (e) {}

  // fetch 封装：POST /api/<channel>，body 为 JSON 数组（args），返回 data 或抛错
  function invoke(channel, args) {
    return fetch('/api/' + channel, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': token },
      body: JSON.stringify(args || [])
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) return j.data;
      // 浏览器重定向指令：前端跳转到指定 URL
      if (j && j.error === 'browser_redirect' && j.url) { window.open(j.url); return { ok: true }; }
      throw new Error((j && j.error) || '请求失败');
    });
  }
  function invokeArgs(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    return invoke(channel, args);
  }

  // SSE 事件订阅：EventSource 连接 /events?token=...，监听具名事件
  var evtSource = null;
  var evtCallbacks = {};
  function ensureSSE() {
    if (evtSource) return;
    try {
      evtSource = new EventSource('/events?token=' + encodeURIComponent(token));
      evtSource.onopen = function () {};
      evtSource.onerror = function () { // 断线重连由浏览器自动处理
      };
    } catch (e) {}
  }
  // 注册事件回调：返回取消订阅函数
  function onEvent(name, cb) {
    ensureSSE();
    if (!evtCallbacks[name]) evtCallbacks[name] = [];
    var listener = function (e) {
      var data = null;
      try { data = JSON.parse(e.data); } catch (err) {}
      try { cb(data); } catch (err) {}
    };
    evtSource.addEventListener(name, listener);
    evtCallbacks[name].push({ cb: cb, listener: listener });
    return function () {
      try { evtSource.removeEventListener(name, listener); } catch (e) {}
    };
  }

  // 浏览器侧窗口控制：返回禁用态
  function windowCaps() { return Promise.resolve({ minimizable: false, maximizable: false, closable: false }); }

  // ── 内嵌模态窗口（设置页）：浏览器侧在主页面内弹出覆盖层，视觉/操作与本体一致 ──
  // 本体设置是主窗口上的模态子窗口；浏览器无独立窗口概念，用同款 modal 样式内嵌渲染，
  // 避免新开标签页造成「视觉与操作不一致」。
  var _embeddedModal = null;
  function closeEmbeddedModal() {
    if (_embeddedModal) { _embeddedModal.remove(); _embeddedModal = null; }
  }
  // 打开内嵌模态：url 为 /settings 等相对路径，w/h 参考本体子窗口尺寸（px）
  // ⚠ 尺寸与本体「主窗口上的设置面板」保持一致（styles.css 的 .settings-frame：840×910，
  //   视口不足时按 100vw/100vh - 96px 收缩）。两侧取值必须同步，否则同一页面在两端尺寸不同。
  // 带两个参数：token（API 校验）+ skin（当前皮肤，iframe 页在渲染前同步应用，避免白闪）
  function openEmbeddedModal(url, w, h) {
    closeEmbeddedModal();
    var params = 'token=' + encodeURIComponent(token);
    var curSkin = document.documentElement ? document.documentElement.getAttribute('data-skin') : '';
    if (curSkin) params += '&skin=' + encodeURIComponent(curSkin);
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var src = url + sep + params;
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    // 与本体「主窗口上的内嵌面板遮罩」(.settings-dim) 同层级，避免浏览器端遮罩被
    // 页面内其它浮层（菜单、提示条）压住。两端一致地都低于窗口标题栏（99999）。
    ov.style.zIndex = '9998';
    var card = document.createElement('div');
    card.className = 'browser-embedded-card';
    card.style.width = (w || 840) + 'px';
    card.style.height = (h || 910) + 'px';
    card.style.maxWidth = 'calc(100vw - 96px)';
    card.style.maxHeight = 'calc(100vh - 96px)';
    card.innerHTML =
      '<iframe src="' + src + '" title="设置" style="width:100%;height:100%;border:0;display:block;background:var(--bg-base-default)"></iframe>';
    ov.appendChild(card);
    document.body.appendChild(ov);
    _embeddedModal = ov;
    bindOverlayClose(ov);
    // 监听 iframe 内请求关闭（设置页/任务页标题栏关闭、未保存确认放弃修改后关闭）
    if (!window.__vlEmbeddedListen) {
      window.__vlEmbeddedListen = true;
      window.addEventListener('message', function (e) {
        if (e.data && (e.data.type === 'vl-close-settings' || e.data.type === 'vl-close-modal')) closeEmbeddedModal();
      });
    }
    // Esc 关闭：与本体一致（本体 app.js 的 Esc 同样只挂在主文档，焦点在 iframe 内时不触发）。
    // 绑一次即可，用标志位避免每次打开都叠加监听。
    if (!window.__vlEmbeddedEsc) {
      window.__vlEmbeddedEsc = true;
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && _embeddedModal) closeEmbeddedModal();
      });
    }
  }
  // 点击遮罩背景关闭模态
  function bindOverlayClose(ov) {
    ov.addEventListener('click', function (e) {
      if (e.target === ov) closeEmbeddedModal();
    });
  }

  // 暴露与 preload.js 完全一致的接口签名
  var api = {
    list_projects: function (force) { return invokeArgs('list_projects', force); },
  // A6 数据目录清理。⚠ 三处登记必须齐全（preload / txapi / server）：
  // settings.js 用 `if (api && api.data_dir_scan)` 守卫，缺一处时该形态下按钮静默失效
  data_dir_scan: function () { return invokeArgs('data_dir_scan'); },
  data_dir_clean: function (keys) { return invokeArgs('data_dir_clean', keys); },
    list_versions: function (project, name, force) { return invokeArgs('list_versions', project, name, force); },
    read_config: function (p) { return invokeArgs('read_config', p); },
    save_config: function (p, folders, excludes, watermark, newName) { return invokeArgs('save_config', p, folders, excludes, watermark, newName); },
    save_config_today: function (project, name, configName, folders, excludes, watermark) { return invokeArgs('save_config_today', project, name, configName, folders, excludes, watermark); },
    new_empty_config: function (project) { return invokeArgs('new_empty_config', project); },
  create_project: function (name, kind) { return invokeArgs('create_project', name, kind); },
  rename_project: function (oldName, newName, kind) { return invokeArgs('rename_project', oldName, newName, kind); },
    remove_branch: function (p, scope) { return invokeArgs('remove_branch', p, scope); },
    branch_other_txt: function (p) { return invokeArgs('branch_other_txt', p); },
    precheck: function (paths, excludes) { return invokeArgs('precheck', paths, excludes); },
    reset_precheck: function () { return invoke('reset_precheck', []); },
    refresh_precache: function () { return invoke('refresh_precache', []); },
    clean_video_cache: function () { return invoke('clean_video_cache', []); },
    cache_info: function () { return invoke('cache_info', []); },
    cache_stats: function () { return invoke('cache_stats', []); },
    clean_caches: function () { return invoke('clean_caches', []); },
    cancel_precheck: function () { return invoke('cancel_precheck', []); },

    on_reset_progress: function (cb) { return onEvent('reset_progress', cb); },
    on_scan_progress: function (cb) { return onEvent('scan_progress', cb); },
    list_logs: function (project, name, versionPath) { return invokeArgs('list_logs', project, name, versionPath); },
    search_logs: function (query) { return invokeArgs('search_logs', query); },
    get_log_content: function (fromPath, configName) { return invokeArgs('get_log_content', fromPath, configName); },
    list_log_files: function (fromPath, configName) { return invokeArgs('list_log_files', fromPath, configName); },
    find_replica_output: function (logPath, videoName) { return invokeArgs('find_replica_output', logPath, videoName); },
    check_exists: function (paths) { return invokeArgs('check_exists', paths); },
    open_folder_select: function (p) { return invokeArgs('open_folder_select', p); },
    check_watermark_project: function (project, wm) { return invokeArgs('check_watermark_project', project, wm); },
    find_watermark_project: function (project, wm) { return invokeArgs('find_watermark_project', project, wm); },
    get_project_watermark: function (project) { return invokeArgs('get_project_watermark', project); },
    set_project_watermark: function (project, wm, enabled, applyToAll, group, groupEnabled) { return invokeArgs('set_project_watermark', project, wm, enabled, applyToAll, group, groupEnabled); },
    run_batch: function (p, count, group) { return invokeArgs('run_batch', p, count, group); },
    run_replica: function (logPath, mode, entryVideo, opts) { return invokeArgs('run_replica', logPath, mode, entryVideo, opts); },
    continue_replica: function (taskId) { return invokeArgs('continue_replica', taskId); },
    run_mask: function (payload) { return invokeArgs('run_mask', payload); },
    continue_mask: function (taskId) { return invokeArgs('continue_mask', taskId); },
    list_mask_projects: function () { return invoke('list_mask_projects', []); },
    list_mask_videos: function (dir) { return invokeArgs('list_mask_videos', dir); },
    list_mask_masks: function (dir) { return invokeArgs('list_mask_masks', dir); },
    scan_mask_raw_dirs: function (dir) { return invokeArgs('scan_mask_raw_dirs', dir); },
    scan_mask_theme_sig: function (dir) { return invokeArgs('scan_mask_theme_sig', dir); },
    list_mask_logs: function (projectPath) { return invokeArgs('list_mask_logs', projectPath); },
    get_mask_session: function (name) { return invokeArgs('get_mask_session', name); },
    get_mask_default_dir: function (name) { return invokeArgs('get_mask_default_dir', name); },
    set_mask_default_dir: function (name, dir) { return invokeArgs('set_mask_default_dir', name, dir); },
    save_mask_session: function (name, data) { return invokeArgs('save_mask_session', name, data); },
    clear_mask_session: function (name) { return invokeArgs('clear_mask_session', name); },
    delete_mask_videos: function (projectPath, names) { return invokeArgs('delete_mask_videos', projectPath, names); },
    move_mask_out: function (projectPath, videoName, newDir) { return invokeArgs('move_mask_out', projectPath, videoName, newDir); },
    relocate_mask_out: function (projectPath, videoName, newDir) { return invokeArgs('relocate_mask_out', projectPath, videoName, newDir); },
    delete_mask_log: function (projectPath, logPath) { return invokeArgs('delete_mask_log', projectPath, logPath); },
    delete_secondary_products: function (projectPath, maskOutPaths) { return invokeArgs('delete_secondary_products', projectPath, maskOutPaths); },
    choose_mask_file: function (prev) { return invokeArgs('choose_mask_file', prev); },
    pick_paths_files: function () { return invoke('pick_paths_files', []); },
    pick_paths_dirs: function () { return invoke('pick_paths_dirs', []); },
    resolve_shortcut: function (p) { return invokeArgs('resolve_shortcut', p); },
    mask_add_source: function (side, p) { return invokeArgs('mask_add_source', side, p); },
    list_tasks: function () { return invoke('list_tasks', []); },
    locate_task: function (taskId, target) { return invokeArgs('locate_task', taskId, target); },
    open_replica_output: function (taskId) { return invokeArgs('open_replica_output', taskId); },
    task_replica_outdir: function (taskId) { return invokeArgs('task_replica_outdir', taskId); },
    on_locate: function (cb) { return onEvent('locate_request', cb); },
    stop_task: function (id) { return invokeArgs('stop_task', id); },
    rerun_task: function (id) { return invokeArgs('rerun_task', id); },
    pin_task: function (id) { return invokeArgs('pin_task', id); },
    reorder_tasks: function (ids) { return invokeArgs('reorder_tasks', ids); },
    pause_task: function (id) { return invokeArgs('pause_task', id); },
    resume_task: function (id) { return invokeArgs('resume_task', id); },
    clear_finished_tasks: function (statuses) { return invokeArgs('clear_finished_tasks', statuses); },
    clear_done_tasks: function (opts) { return invokeArgs('clear_done_tasks', opts); },
    get_changelog: function () { return invoke('get_changelog', []); },
    get_changelog_popup: function () { return invoke('get_changelog_popup', []); },
    ack_changelog_popup: function () { return invoke('ack_changelog_popup', []); },
    get_readme: function () { return invoke('get_readme', []); },
  get_about_info: function () { return invoke('get_about_info', []); },
    clear_task: function (id) { return invokeArgs('clear_task', id); },
    regroup_task: function (id, groupCount) { return invokeArgs('regroup_task', id, groupCount); },
    resume_all_tasks: function () { return invoke('resume_all_tasks', []); },
    pause_all_tasks: function () { return invoke('pause_all_tasks', []); },
    confirm_quit: function () { return invoke('confirm_quit', []); },
    on_confirm_quit_request: function (cb) { return onEvent('confirm_quit_request', cb); },
    choose_close_behavior: function (behavior, skip) { return invokeArgs('choose_close_behavior', behavior, !!skip); },
    on_close_behavior_request: function (cb) { return onEvent('close_behavior_request', cb); },
    open_task_window: function () {
      // 任务窗口：本体是独立 BrowserWindow（与主窗口独立，非子模态），浏览器侧同样弹独立 popup 窗口，
      // 计算屏幕居中坐标（与本体居中打开体验一致）；features 隐藏工具栏/地址栏/菜单栏（接近本体无壳）
      var w = 760, h = 620;
      var L = Math.max(0, Math.round((window.screen.availWidth - w) / 2));
      var T = Math.max(0, Math.round((window.screen.availHeight - h) / 2));
      var uv = '/task?token=' + encodeURIComponent(token);
      var curSkin = document.documentElement ? document.documentElement.getAttribute('data-skin') : '';
      if (curSkin) uv += '&skin=' + encodeURIComponent(curSkin);
      var win = window.open(uv, 'vlabtasks', 'width=' + w + ',height=' + h + ',left=' + L + ',top=' + T + ',resizable=no,toolbar=no,menubar=no,location=no,status=no,scrollbars=no');
      // popup 被拦截（返回 null）时回退新标签页，保证功能可用
      if (!win) window.open('/task?token=' + encodeURIComponent(token));
      return Promise.resolve({ ok: true });
    },
    open_settings_window: function () { openEmbeddedModal('/settings', 840, 910); return Promise.resolve({ ok: true }); },
    // 关闭内嵌面板：本体由主进程按「当前打开的是设置页还是引导页」分派，
    // 浏览器侧的内嵌面板就是同一个 modal，故两者都收起它。
    // ⚠ preload 与 txapi 必须同时提供这两个接口：app.js 的关闭交互（点击面板外 / Esc /
    //   引导页标题栏关闭）以 window.txapi.close_*_panel 为守卫，缺任一处该形态下按钮静默失灵。
    close_settings_panel: function () { closeEmbeddedModal(); return Promise.resolve({ ok: true }); },
    close_embed_panel: function () { closeEmbeddedModal(); return Promise.resolve({ ok: true }); },
    // 视频处理工具窗口：本体是独立非模态窗口，浏览器侧同样弹独立 popup（可并排、非模态）
    open_tool_window: function () {
      // 与本体同尺寸（主窗口 1360×860 的同比例缩小）
      var w = 1020, h = 645;
      var L = Math.max(0, Math.round((window.screen.availWidth - w) / 2));
      var T = Math.max(0, Math.round((window.screen.availHeight - h) / 2));
      var uv = '/tool?token=' + encodeURIComponent(token);
      var curSkin = document.documentElement ? document.documentElement.getAttribute('data-skin') : '';
      if (curSkin) uv += '&skin=' + encodeURIComponent(curSkin);
      var win = window.open(uv, 'vlabtool', 'width=' + w + ',height=' + h + ',left=' + L + ',top=' + T + ',resizable=yes,toolbar=no,menubar=no,location=no,status=no,scrollbars=yes');
      if (!win) window.open('/tool?token=' + encodeURIComponent(token));
      return Promise.resolve({ ok: true });
    },
    list_tools: function () { return invoke('list_tools', []); },
    run_tool: function (spec) { return invokeArgs('run_tool', spec); },
    rerun_tool_task: function (id) { return invokeArgs('rerun_tool_task', id); },
    list_dir: function (dir) { return invokeArgs('list_dir', dir); },
    pick_image: function (prev) { return invokeArgs('pick_image', prev); },
    // 画布合成（竖转横）：单帧预览 / 背景候选 / 参数预设
    canvas_preview_frame: function (payload) { return invokeArgs('canvas_preview_frame', payload); },
    canvas_list_backgrounds: function (dir) { return invokeArgs('canvas_list_backgrounds', dir); },
    canvas_list_sources: function (root, recursive) { return invokeArgs('canvas_list_sources', root, recursive); },
    canvas_preset_list: function () { return invoke('canvas_preset_list', []); },
    canvas_preset_save: function (name, params) { return invokeArgs('canvas_preset_save', name, params); },
    canvas_preset_delete: function (name) { return invokeArgs('canvas_preset_delete', name); },
    get_runlog: function (opts) { return invokeArgs('get_runlog', opts); },
    get_app_info: function () { return invoke('get_app_info', []); },
    get_api_index: function () { return invoke('get_api_index', []); },
    // 获取浏览器访问地址（含 token）：本体/浏览器侧都可调用，便于开发测试拿到真实 token
    get_browser_url: function () { return invoke('get_browser_url', []); },
    // 关闭设置内嵌模态（未保存确认放弃修改后调用，本体为真正关闭设置窗口）
    // 关设置：先收起内嵌模态，再真正关窗口。
    // ⚠ 这是一个**两步动作**，必须成对出现：只收起内嵌模态则窗口还在，
    force_close_settings: function () { closeEmbeddedModal(); return invoke('force_close_settings', []); },
    tray_menu_click: function (action) { return invokeArgs('tray_menu_click', action); },
    clean_duplicate_star: function (commit) { return invokeArgs('clean_duplicate_star', commit); },
    open_external: function (url) { return invokeArgs('open_external', url); },
    check_update: function (silent) { return invokeArgs('check_update', !!silent); },
    apply_update_pref: function (pref) { return invokeArgs('apply_update_pref', pref); },
    get_runtime: function () { return invoke('get_runtime', []); },
    get_app_version: function () { return invoke('get_app_version', []); },
    start_update: function () { return invoke('start_update', []); },
    apply_update: function () { return invoke('apply_update', []); },
    on_update_available: function (cb) { return onEvent('update_available', cb); },
    on_update_progress: function (cb) { return onEvent('update_downloading', cb); },
    on_update_status: function (cb) { return onEvent('update_status', cb); },
    on_update_none: function (cb) { return onEvent('update_none', cb); },
    on_update_error: function (cb) { return onEvent('update_error', cb); },
    on_update_ready: function (cb) { return onEvent('update_ready', cb); },
    on_update_downloaded: function (cb) { return onEvent('update_downloaded', cb); },
    on_check_update_result: function (cb) { return onEvent('check_update_result', cb); },
    env_fix_start: function () { return invoke('env_fix_start'); },
    on_env_fix_available: function (cb) { return onEvent('env_fix_available', cb); },
    on_env_fix_progress: function (cb) { return onEvent('env_fix_progress', cb); },
    on_env_fix_done: function (cb) { return onEvent('env_fix_done', cb); },
    on_env_lost: function (cb) { return onEvent('env_lost', cb); },
    get_settings: function () { return invoke('get_settings', []); },
    save_settings: function (s) { return invokeArgs('save_settings', s); },
    pick_directory: function (title, defaultPath) { return invokeArgs('pick_directory', title, defaultPath); },
    on_settings_saved: function (cb) { return onEvent('settings_saved', cb); },
    notify_dirty: function (d) { /* 浏览器侧无需通知主进程脏标记 */ },
    on_settings_window_opened: function (cb) { return onEvent('settings_window_opened', cb); },
    on_settings_window_closed: function (cb) { return onEvent('settings_window_closed', cb); },
    // 引导页开关事件在浏览器侧不广播，保留订阅以与 preload 的接口清单对齐
    on_guide_window_opened: function (cb) { return onEvent('guide_window_opened', cb); },
    on_guide_window_closed: function (cb) { return onEvent('guide_window_closed', cb); },
    on_task_update: function (cb) { return onEvent('task_update', cb); },
    on_versions_changed: function (cb) { return onEvent('versions_changed', cb); },
    on_confirm_discard_config: function (cb) { return onEvent('confirm_discard_config_request', cb); },
    respond_discard_config: function (a) { return invokeArgs('respond_discard_config', a); },
    open_path: function (p) { return invokeArgs('open_path', p); },
    report_ui_error: function (p) { return invokeArgs('report_ui_error', p); },
    read_log: function (o) { return invokeArgs('read_log', o); },
    get_log_level: function () { return invokeArgs('get_log_level'); },
    set_log_level: function (lvl) { return invokeArgs('set_log_level', lvl); },
    export_diag_pack: function (id, opts) { return invokeArgs('export_diag_pack', id, opts); },
    open_parent: function (p) { return invokeArgs('open_parent', p); },
    open_project_dir: function (p) { return invokeArgs('open_project_dir', p); },
    external_edit: function (p) { return invokeArgs('external_edit', p); },
    pick_watermark: function (prev) { return invokeArgs('pick_watermark', prev); },
    pick_exclude: function () { return invoke('pick_exclude', []); },
    pick_paths: function () { return invoke('pick_paths', []); },
    pick_single_folder: function () { return invoke('pick_single_folder', []); },
    get_root: function () { return invoke('get_root', []); },
    save_guide: function (s) { return invokeArgs('save_guide', s); },
    check_env: function () { return invoke('check_env', []); },
    get_skin: function () { return invoke('get_skin', []); },
    set_skin: function (skin) { return invokeArgs('set_skin', skin); },
    choose_workdir: function () { return invoke('choose_workdir', []); },
    // 浏览器侧窗口控制：返回禁用态
    window_caps: windowCaps,
    window_minimize: function () { return Promise.resolve({ ok: true }); },
    window_toggle_maximize: function () { return Promise.resolve({ ok: true }); },
    // iframe 内嵌模态（设置页）：关闭按钮通知父窗口关模态；独立标签页尝试 window.close()
    window_close: function () {
      if (window.self !== window.top) { try { window.parent.postMessage({ type: 'vl-close-settings' }, '*'); } catch (e) {} return Promise.resolve({ ok: true }); }
      try { window.close(); } catch (e) {}
      return Promise.resolve({ ok: true });
    },
    listen_window_max: function () { /* 浏览器侧无窗口最大化事件 */ },
    on_window_max_changed: function (cb) { /* 浏览器侧无窗口最大化事件，不触发 */ },
    // 在浏览器中打开（供前端菜单调用，直接刷新本页或打开新标签）
    open_browser: function () { return Promise.resolve({ ok: true, url: location.origin }); },
  };

  window.txapi = api;
})();
