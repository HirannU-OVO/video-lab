// -*- coding: utf-8 -*-
// Video Lab — 内嵌 HTTP 服务器
// 在 Electron 主进程内启动，对外暴露与本体等价的功能，浏览器访问 http://localhost:<port>
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, dialog, shell } = require('electron');

const FRONTEND_DIR = path.join(__dirname, 'frontend');
const ICON_DIR = path.join(__dirname, 'icon');
// 前端资源版本指纹：每次进程启动都会变化 —— 注入 HTML 里 JS/CSS 引用 URL（?v=），URL 变化后浏览器必然重新拉取、避免强缓存。
const FRONTEND_VER = Date.now().toString(36);

// 打开目录后把资源管理器窗口前置：浏览器发起时同样会被前台锁压到后台。
// ⚠ 不给资源管理器设持久置顶（会一直压着其它窗口），只做一次前置。
const RAISE_EXPLORER_PS = [
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
  "Add-Type -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  "'@ -Name R -Namespace W",
  '$r = [System.Windows.Automation.AutomationElement]::RootElement',
  '$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "CabinetWClass")',
  '$t = $env:VL_FOLDER_TITLE',
  '$h = [IntPtr]::Zero',
  'for ($i = 0; $i -lt 40; $i++) {',
  '  Start-Sleep -Milliseconds 100',
  '  $all = @($r.FindAll([System.Windows.Automation.TreeScope]::Children, $c))',
  '  if ($all.Count -eq 0) { continue }',
  '  $pick = $null',
  '  if ($t) { foreach ($w in $all) { if ($w.Current.Name -eq $t) { $pick = $w; break } } }',
  '  if (-not $pick) { $pick = $all[0] }',
  '  $h = [IntPtr]$pick.Current.NativeWindowHandle',
  '  break',
  '}',
  'if ($h -ne [IntPtr]::Zero) {',
  '  $fg = [W.R]::GetForegroundWindow()',
  '  $p = 0',
  '  $tid = [W.R]::GetWindowThreadProcessId($fg, [ref]$p)',
  '  $my = [W.R]::GetCurrentThreadId()',
  '  [W.R]::AttachThreadInput($my, $tid, $true) | Out-Null',
  '  [W.R]::BringWindowToTop($h) | Out-Null',
  '  [W.R]::SetForegroundWindow($h) | Out-Null',
  '  [W.R]::AttachThreadInput($my, $tid, $false) | Out-Null',
  '}'
].join('\r\n');
const RAISE_EXPLORER_PATH = path.join(require('os').tmpdir(), 'vl-raise-explorer.ps1');
function raiseExplorerWindow(folderName) {
  try {
    fs.writeFileSync(RAISE_EXPLORER_PATH, '\ufeff' + RAISE_EXPLORER_PS, 'utf8');
    const cp = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', RAISE_EXPLORER_PATH], {
      windowsHide: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { VL_FOLDER_TITLE: String(folderName || '') })
    });
    cp.on('error', () => {});
    cp.unref();
  } catch (e) {}
}

// 打开目录 / 文件：先用 Electron 的 shell.openPath（有真实错误串），失败再回退 cmd /c start。
// ⚠ 回退时整个命令行必须作为**一个参数**传给 cmd：拆成多个参数时 Node 会给含引号的参数再加一层
//   转义，start 的「标题 + 目标」会错位并静默失败（表现为调用返回成功但窗口不出现）。
// ⚠ 回退不能用等待进程退出的方式：start 拉起的 explorer 会继承管道句柄，回调要等到窗口关闭才触发。
function openDirForeground(target) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    Promise.resolve()
      .then(() => shell.openPath(target))
      .then((err) => {
        if (!err) {
          raiseExplorerWindow(path.basename(target));
          finish({ ok: true });
          return;
        }
        try {
          const cp = spawn('cmd.exe', ['/c', 'start "" "' + target + '"'], { windowsHide: true, detached: true, stdio: 'ignore' });
          cp.unref();
          cp.on('error', (e) => finish({ ok: false, error: String(e && e.message || e) }));
          setTimeout(() => { raiseExplorerWindow(path.basename(target)); finish({ ok: true }); }, 300);
        } catch (e) { finish({ ok: false, error: String(e && e.message || e) }); }
      })
      .catch((e) => finish({ ok: false, error: String(e && e.message || e) }));
  });
}

// 纯 backend 类 channel：直接转发到 api.<method>，args 数组展开
// [channel, apiMethod, argTransform?] argTransform 可选，用于处理布尔/默认值
const PURE_BACKEND_ROUTES = {
  report_ui_error: { m: 'reportUiError', a: (args) => [args[0]] },
  read_log: { m: 'readLog', a: (args) => [args[0]] },
  get_log_level: { m: 'getLogLevel', a: () => [] },
  set_log_level: { m: 'setLogLevel', a: (args) => [args[0]] },
  export_diag_pack: { m: 'exportDiagPack', a: (args) => [args[0], args[1]] },
  list_projects: { m: 'listProjectsAsync', a: (args) => [!!args[0]] },
  // A6 数据目录清理（与 preload / IPC 三处登记保持一致，漏一处则该形态下静默失效）
  data_dir_scan: { m: 'dataDirScan', a: () => [] },
  data_dir_clean: { m: 'dataDirClean', a: (args) => [args[0]] },
  list_versions: { m: 'listVersions', a: (args) => [args[0], args[1], args[2]] },
  read_config: { m: 'readConfig', a: (args) => [args[0]] },
  save_config: { m: 'saveConfig', a: (args) => [args[0], args[1], args[2], args[3], args[4]] },
  save_config_today: { m: 'saveConfigToday', a: (args) => [args[0], args[1], args[2], args[3], args[4], args[5]] },
  new_empty_config: { m: 'newEmptyConfig', a: (args) => [args[0]] },
  create_project: { m: 'createProject', a: (args) => [args[0], args[1]] },
  rename_project: { m: 'renameProject', a: (args) => [args[0], args[1], args[2]] },
  remove_branch: { m: 'removeBranch', a: (args) => [args[0], args[1]] },
  branch_other_txt: { m: 'branchOtherTxt', a: (args) => [args[0]] },
  precheck: { m: 'precheck', a: (args) => [args[0], args[1]] },
  list_logs: { m: 'listLogs', a: (args) => [args[0], args[1], args[2]] },
  search_logs: { m: 'searchLogs', a: (args) => [args[0]] },
  get_log_content: { m: 'logContent', a: (args) => [args[0], args[1]] },
  list_log_files: { m: 'listLogFiles', a: (args) => [args[0], args[1]] },
  find_replica_output: { m: 'findReplicaOutput', a: (args) => [args[0], args[1]] },
  check_exists: { m: 'checkExists', a: (args) => [args[0]] },
  check_watermark_project: { m: 'checkWatermarkProject', a: (args) => [args[0], args[1]] },
  find_watermark_project: { m: 'findWatermarkProject', a: (args) => [args[0], args[1]] },
  get_project_watermark: { m: 'getProjectWatermark', a: (args) => [args[0]] },
  set_project_watermark: { m: 'setProjectWatermark', a: (args) => [args[0], args[1], args[2], args[3], args[4], args[5]] },
  run_batch: { m: 'runBatch', a: (args) => [args[0], args[1], args[2]] },
  run_replica: { m: 'runReplica', a: (args) => [args[0], args[1], args[2], args[3]] },
  continue_replica: { m: 'continueReplica', a: (args) => [args[0]] },
  list_tasks: { m: 'snapshotTasks', a: () => [] },
  stop_task: { m: 'stopTask', a: (args) => [args[0]] },
  rerun_task: { m: 'rerunTask', a: (args) => [args[0]] },
  pin_task: { m: 'pinTask', a: (args) => [args[0]] },
  reorder_tasks: { m: 'reorderTasks', a: (args) => [args[0]] },
  pause_task: { m: 'pauseTask', a: (args) => [args[0]] },
  resume_task: { m: 'resumeTask', a: (args) => [args[0]] },
  clear_finished_tasks: { m: 'clearFinishedTasks', a: (args) => [args[0]] },
  clear_done_tasks: { m: 'clearDoneTasks', a: (args) => [args[0] || {}] },
  get_changelog: { m: 'getChangelog', a: () => [] },
  get_readme: { m: 'getReadme', a: () => [] },
  get_about_info: { m: 'getAboutInfo', a: () => [] },
  clear_task: { m: 'clearTask', a: (args) => [args[0]] },
  regroup_task: { m: 'regroupTask', a: (args) => [args[0], args[1]] },
  resume_all_tasks: { m: 'resumeAllTasks', a: () => [] },
  pause_all_tasks: { m: 'pauseAllTasks', a: () => [] },
  run_mask: { m: 'runMask', a: (args) => [args[0]] },
  continue_mask: { m: 'continueMask', a: (args) => [args[0]] },
  // 视频处理工具（第 4 个模块）
  list_tools: { m: 'listTools', a: () => [] },
  run_tool: { m: 'runTool', a: (args) => [args[0]] },
  rerun_tool_task: { m: 'rerunToolTask', a: (args) => [args[0]] },
  list_dir: { m: 'listDir', a: (args) => [args[0]] },
  ensure_ffmpeg: { m: 'ensureFfmpeg', a: () => [{ force: true }] },
  // 画布合成（竖转横）：单帧预览 / 背景候选 / 参数预设
  canvas_preview_frame: { m: 'canvasPreviewFrame', a: (args) => [args[0]] },
  canvas_list_backgrounds: { m: 'canvasListBackgrounds', a: (args) => [args[0]] },
  canvas_list_sources: { m: 'canvasListSources', a: (args) => [args[0], args[1]] },
  canvas_preset_list: { m: 'canvasPresetList', a: () => [] },
  canvas_preset_save: { m: 'canvasPresetSave', a: (args) => [args[0], args[1]] },
  canvas_preset_delete: { m: 'canvasPresetDelete', a: (args) => [args[0]] },
  list_mask_projects: { m: 'listMaskProjects', a: () => [] },
  list_mask_videos: { m: 'listMaskVideos', a: (args) => [args[0]] },
  list_mask_masks: { m: 'listMaskMasks', a: (args) => [args[0]] },
  scan_mask_raw_dirs: { m: 'scanMaskRawDirs', a: (args) => [args[0]] },
  scan_mask_theme_sig: { m: 'maskThemeSig', a: (args) => [args[0]] },
  list_mask_logs: { m: 'listMaskLogs', a: (args) => [args[0]] },
  get_mask_session: { m: 'getMaskSession', a: (args) => [args[0]] },
  save_mask_session: { m: 'saveMaskSession', a: (args) => [args[0], args[1]] },
  clear_mask_session: { m: 'clearMaskSession', a: (args) => [args[0]] },
  get_mask_default_dir: { m: 'getMaskDefaultDir', a: (args) => [args[0]] },
  set_mask_default_dir: { m: 'setMaskDefaultDir', a: (args) => [args[0], args[1]] },
  delete_mask_videos: { m: 'deleteMaskVideos', a: (args) => [args[0], args[1]] },
  move_mask_out: { m: 'moveMaskOut', a: (args) => [args[0], args[1], args[2]] },
  relocate_mask_out: { m: 'relocateMaskOut', a: (args) => [args[0], args[1], args[2]] },
  delete_mask_log: { m: 'deleteMaskLog', a: (args) => [args[0], args[1]] },
  delete_secondary_products: { m: 'deleteSecondaryProducts', a: (args) => [args[0], args[1]] },
  clean_duplicate_star: { m: 'cleanDuplicateStar', a: (args) => [!!args[0]] },
  get_root: { m: 'getRoot', a: () => [] },
  check_env: { m: 'checkEnvAsync', a: () => [] },
  cancel_precheck: { m: 'cancelPrecheck', a: () => [] },
  clean_video_cache: { m: 'cleanVideoCache', a: () => [] },
  cache_info: { m: 'cacheInfo', a: () => [] },
  cache_stats: { m: 'cacheStats', a: () => [] },
  clean_caches: { m: 'cleanCaches', a: () => [] },
};

function startHttpServer(opts) {
  const api = opts.api;
  const getMainWin = opts.getMainWin || (() => null);
  const getSettingsWin = opts.getSettingsWin || (() => null);
  const extraRoutes = opts.extraRoutes || {};
  const httpPort = opts.httpPort || 9527;
  // 广播函数：由 main.js 注入，同时推 webContents.send 和 SSE
  const broadcast = opts.broadcast || (function () {});
  // 固定 token：main.js 注入（config.http_token，首次启动生成后持久化，此后长期复用）；未注入（如独立测试）时才临时随机生成。
  const httpToken = (typeof opts.httpToken === 'string' && opts.httpToken) || crypto.randomBytes(16).toString('hex');
  // 运行日志：main.js 注入；浏览器端的写操作也要留痕（IPC 包装只覆盖 Electron 侧）
  const runLog = opts.runLog || null;
  const sseClients = new Set();

  // SSE 广播：遍历所有连接的 SSE 客户端推送事件
  function sseBroadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data === undefined ? null : data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch (e) {}
    }
  }
  // 统一广播：同时推 Electron 窗口和 SSE 客户端
  function broadcastAll(event, data) {
    try { broadcast(event, data); } catch (e) {}
    sseBroadcast(event, data);
  }

  // dialog/shell 类路由（浏览器侧后端代劳）
  //
  // ★ 浏览器侧的对话框**不挂本体窗口**：用户焦点在浏览器，挂到本体窗口会让对话框被压到后面
        //   （看起来像操作未生效）；不传 parent 时 Electron 弹出独立对话框，正常显示到前台。
  //   桌面端不受影响 —— 那边走 IPC，父窗口就是发起操作的那个窗口。
  const dialogRoutes = {
    choose_mask_file: async (args) => {
      const prev = args[0] || (api.getRoot() || '');
      const r = await showOpen({ title: '选择水印文件', defaultPath: prev, properties: ['openFile'], filters: [{ name: '视频水印', extensions: ['mov', 'mp4'] }] });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
      return { ok: true, path: r.filePaths[0] };
    },
    pick_directory: async (args) => {
      const win = getMainWin() || getSettingsWin();
      const result = await showOpen({ title: args[0] || '选择目录', defaultPath: args[1] || api.getRoot() || '', properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
    pick_save_file: async (args) => {
      const win = getMainWin() || getSettingsWin();
      const opts = {
        title: args[0] || '保存到',
        defaultPath: args[1] || 'VideoLab.zip',
        filters: [{ name: '压缩包', extensions: ['zip'] }]
      };
      const result = await showSave(opts);
      return result.canceled || !result.filePath ? '' : result.filePath;
    },
    choose_workdir: async () => {
      const result = await showOpen({ title: '选择工作路径', defaultPath: api.getRoot(), properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, canceled: true };
      const dir = result.filePaths[0];
      return { ok: true, root: dir, projects: await api.listProjectsAsync() };
    },
    pick_watermark: async (args) => {
      const defaultPath = String(args[0] || '').trim();
      const result = await showOpen({ title: '选择水印 PNG', defaultPath, properties: ['openFile'], filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
    pick_image: async (args) => {
      const defaultPath = String(args[0] || '').trim() || api.getRoot();
      const result = await showOpen({ title: '选择要叠加的图片', defaultPath, properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
    pick_exclude: async () => {
      const result = await showOpen({ title: '选择要排除的路径（文件夹或视频文件）', defaultPath: api.getRoot(), properties: ['openFile', 'openDirectory', 'multiSelections'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    pick_paths: async () => {
      const result = await showOpen({ title: '选择要添加的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    pick_paths_files: async () => {
      const result = await showOpen({ title: '选择视频文件（支持 mp4/mov/avi/mkv 等 / .lnk 快捷方式）', defaultPath: api.getRoot(), properties: ['openFile', 'multiSelections'], filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm', 'flv', 'lnk'] }] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    pick_paths_dirs: async () => {
      const result = await showOpen({ title: '选择文件夹（将递归扫描其中视频）', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    resolve_shortcut: async (args) => api.resolveShortcut(args[0]),
    mask_add_source: async (args) => api.maskAddSource(args[0], args[1]),
    pick_single_folder: async () => {
      const result = await showOpen({ title: '选择要修改为的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
  };

  const shellRoutes = {
    open_external: async (args) => {
      const url = args[0];
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        const err = await shell.openExternal(url);
        return err ? { ok: false, error: err } : { ok: true };
      }
      return { ok: false, error: '无效链接' };
    },
    open_replica_output: async (args) => {
      const r = api.taskReplicaOutputDir(args[0]);
      if (!r.ok) return r;
      return openDirForeground(r.dir);
    },
    task_replica_outdir: (args) => api.taskReplicaOutputDir(args[0]),
    open_path: async (args) => {
      const p = args[0];
      const target = path.resolve(p);
      if (!fs.existsSync(target)) return { ok: false, error: '路径不存在' };
      // 目录走前台方式（与本体一致）；文件保持 shell.openPath 打开关联程序
      if (fs.statSync(target).isDirectory()) return openDirForeground(target);
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true };
    },
    open_parent: async (args) => {
      const p = args[0];
      const target = path.dirname(path.resolve(p));
      if (fs.existsSync(target)) return openDirForeground(target);
      return { ok: false, error: '路径不存在' };
    },
    open_folder_select: async (args) => {
      const p = String(args[0] || '').replace(/^"|"$/g, '');
      const target = path.resolve(p);
      if (!fs.existsSync(target)) return { ok: false, error: '路径不存在' };
      // 同 IPC 端：目录 → 打开该目录；文件 → 打开所在文件夹并选中该文件
      try {
        if (fs.statSync(target).isDirectory()) return openDirForeground(target);
      } catch (e) { /* stat 失败按文件处理 */ }
      shell.showItemInFolder(target);
      raiseExplorerWindow(path.basename(path.dirname(target)));
      return { ok: true };
    },
    open_project_dir: async (args) => {
      const project = args[0];
      const root = api.getRoot();
      const target = path.resolve(root || '', String(project || ''));
      if (fs.existsSync(target)) return openDirForeground(target);
      return { ok: false, error: '项目目录不存在' };
    },
    external_edit: async (args) => {
      const p = args[0];
      const target = path.resolve(p);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
      return { ok: false, error: '文件不存在' };
    },
  };

  // 推进度类路由（通过 broadcastAll 推送事件）
  const progressRoutes = {
    reset_precheck: (args) => api.resetPrecheck((s) => { broadcastAll('reset_progress', s); }),
    refresh_precache: (args) => api.refreshPrecache((s) => { broadcastAll('reset_progress', s); }),
    locate_task: (args) => {
      const taskId = args[0];
      const target = args[1];
      const info = api.taskLocate(taskId);
      if (!info || !info.ok) return info;
      const payload = Object.assign({}, info, { target: target === 'log' ? 'log' : 'config', taskId });
      broadcastAll('locate_request', payload);
      return info;
    },
  };

  // 浏览器侧的系统对话框一律**不挂父窗口**：独立对话框。
  // ⚠ 隐藏窗口（静默常驻在托盘）作父会让系统模态对话框卡住主进程，HTTP 请求全部超时。
  // ⚠ 也不能为了靠前就把本体窗口 show 出来，那等于凭空多一个窗口。
  //
  // 独立对话框在浏览器发起时会被系统放到后台（只在任务栏闪烁）。弹窗后用一次性隐藏进程
  // 按标题定位该对话框，借 AttachThreadInput 拿到前台权限再 SetForegroundWindow 前置。
  // ⚠ 直接 SetForegroundWindow 会被前台锁拒绝（本进程没有可见窗口），必须先附着输入线程。
  const RAISE_DIALOG_PS = [
    'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
    "Add-Type -MemberDefinition @'",
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    "'@ -Name R -Namespace W",
    '$r = [System.Windows.Automation.AutomationElement]::RootElement',
    '$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "#32770")',
    '$t = $env:VL_DLG_TITLE',
    '$h = [IntPtr]::Zero',
    'for ($i = 0; $i -lt 40; $i++) {',
    '  Start-Sleep -Milliseconds 100',
    '  foreach ($d in @($r.FindAll([System.Windows.Automation.TreeScope]::Children, $c))) {',
    '    if ((-not $t) -or ($d.Current.Name -eq $t)) { $h = [IntPtr]$d.Current.NativeWindowHandle; break }',
    '  }',
    '  if ($h -ne [IntPtr]::Zero) { break }',
    '}',
    'if ($h -ne [IntPtr]::Zero) {',
    '  $fg = [W.R]::GetForegroundWindow()',
    '  $p = 0',
    '  $tid = [W.R]::GetWindowThreadProcessId($fg, [ref]$p)',
    '  $my = [W.R]::GetCurrentThreadId()',
    '  [W.R]::AttachThreadInput($my, $tid, $true) | Out-Null',
    '  [W.R]::ShowWindow($h, 9) | Out-Null',
    '  [W.R]::BringWindowToTop($h) | Out-Null',
    '  $ok = [W.R]::SetForegroundWindow($h)',
    '  [W.R]::AttachThreadInput($my, $tid, $false) | Out-Null',
    // 置顶：前台锁可能拒绝 SetForegroundWindow，置顶不依赖前台权限，保证对话框在最上层可见
    '  [W.R]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null',
    '  try { [IO.File]::AppendAllText((Join-Path $env:TEMP "vl-raise.log"), ("h=" + $h + " ok=" + $ok + " at=" + (Get-Date -Format "HH:mm:ss.fff") + "`r`n")) } catch { }',
    '} else {',
    '  try { [IO.File]::AppendAllText((Join-Path $env:TEMP "vl-raise.log"), ("no-dialog at=" + (Get-Date -Format "HH:mm:ss.fff") + "`r`n")) } catch { }',
    '}'
  ].join('\r\n');
  const RAISE_SCRIPT_PATH = path.join(require('os').tmpdir(), 'vl-raise-dialog.ps1');
  const RAISE_NODE_LOG = path.join(require('os').tmpdir(), 'vl-raise-node.log');
  function raiseDialog(title) {
    try {
      // 落成脚本文件再执行：-EncodedCommand 传长脚本时静默失效，且出错时无从排查
      fs.writeFileSync(RAISE_SCRIPT_PATH, '\ufeff' + RAISE_DIALOG_PS, 'utf8');
      const cp = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', RAISE_SCRIPT_PATH], {
        windowsHide: true, stdio: 'ignore',
        env: Object.assign({}, process.env, { VL_DLG_TITLE: String(title || '') })
      });
      cp.on('error', (e) => { try { fs.appendFileSync(RAISE_NODE_LOG, 'ERR ' + String(e && e.message || e) + '\n'); } catch (x) {} });
      cp.unref();
    } catch (e) {
      try { fs.appendFileSync(RAISE_NODE_LOG, 'THROW ' + String(e && e.message || e) + '\n'); } catch (x) {}
    }
  }
  // 在途对话框复用：浏览器侧连点会连发请求，每次各弹一个会堆成一排窗口；
  // 这里让重复请求共享同一个结果（第一个选择对全部生效）。
  let inflightOpen = null;
  let inflightSave = null;
  function showOpen(opts) {
    if (inflightOpen) return inflightOpen;
    const p = dialog.showOpenDialog(opts).finally(() => { inflightOpen = null; });
    inflightOpen = p;
    raiseDialog(opts && opts.title);
    return p;
  }
  function showSave(opts) {
    if (inflightSave) return inflightSave;
    const p = dialog.showSaveDialog(opts).finally(() => { inflightSave = null; });
    inflightSave = p;
    raiseDialog(opts && opts.title);
    return p;
  }

  // 浏览器侧降级路由：返回不支持
  const unsupportedRoutes = {
    window_caps: () => ({ minimizable: false, maximizable: false, closable: false }),
    window_minimize: () => ({ ok: true }),
    window_toggle_maximize: () => ({ ok: true }),
    window_close: () => ({ ok: true }),
    window_max_changed_listen: () => ({ ok: true }),
    tray_menu_click: () => ({ ok: false, error: '浏览器侧不支持' }),
    choose_close_behavior: () => ({ ok: false, error: '浏览器侧不支持' }),
    confirm_quit: () => ({ ok: false, error: '浏览器侧不支持' }),
    force_close_settings: () => ({ ok: true }),
    open_task_window: () => { return { ok: false, error: 'browser_redirect', url: '/task' }; },
    open_tool_window: () => { return { ok: false, error: 'browser_redirect', url: '/tool' }; },
    open_settings_window: () => { return { ok: false, error: 'browser_redirect', url: '/settings' }; },
    start_update: () => ({ ok: false, error: '请在应用本体中完成更新' }),
    apply_update: () => ({ ok: false, error: '请在应用本体中完成更新' }),
  };

  // 合并所有路由
  function resolveRoute(channel) {
    if (PURE_BACKEND_ROUTES[channel]) {
      const r = PURE_BACKEND_ROUTES[channel];
      return (args) => api[r.m].apply(api, r.a(args || []));
    }
    if (dialogRoutes[channel]) return dialogRoutes[channel];
    if (shellRoutes[channel]) return shellRoutes[channel];
    if (progressRoutes[channel]) return progressRoutes[channel];
    if (unsupportedRoutes[channel]) return unsupportedRoutes[channel];
    if (extraRoutes[channel]) return extraRoutes[channel];
    return null;
  }

  // 可用通道清单：**由各路由表自动生成**（零维护成本）—— 新增通道只需加到某张表里，list_tools/get_api_index 自动可见。
  function channelIndex() {
    const rows = [];
    const push = (kind, table) => Object.keys(table || {}).forEach((name) => rows.push({ name, kind }));
    push('backend', PURE_BACKEND_ROUTES);
    push('dialog', dialogRoutes);
    push('shell', shellRoutes);
    push('progress', progressRoutes);
    push('unsupported', unsupportedRoutes);
    push('custom', extraRoutes);
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // token 校验
  function checkToken(req) {
    const url = new URL(req.url, 'http://localhost');
    const qToken = url.searchParams.get('token');
    if (qToken && qToken === httpToken) return true;
    const hToken = req.headers['x-token'];
    if (hToken && hToken === httpToken) return true;
    return false;
  }

  // MIME 类型（含皮肤素材 .webp、字体与音视频，浏览器端加载图片/字体不得回退 octet-stream）
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
  };

  function serveStatic(req, res, filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      // HTML 内的 JS/CSS 引用统一加 ?v=<版本指纹>：每次启动版本变化 → 资源 URL 变化 → 浏览器必然重拉（仅改 HTML，不动 CSS 内 url()）。
      if (ext === '.html') {
        data = Buffer.from(data.toString('utf8').replace(/(\b(?:src|href)=")([^"?]+\.(?:js|css))(")/g, '$1$2?v=' + FRONTEND_VER + '$3'));
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(data);
    });
  }

  function handleApi(req, res, body) {
    let args;
    try { args = body ? JSON.parse(body) : []; } catch (e) { args = []; }
    if (!Array.isArray(args)) args = [args];
    // 从 URL 路径提取 channel：/api/<channel>
    const m = req.url.match(/^\/api\/([a-z_]+)/);
    const channel = m ? m[1] : '';
    const handler = resolveRoute(channel);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未知接口: ' + channel }));
      return;
    }
    const t0 = Date.now();
    Promise.resolve().then(() => handler(args)).then((result) => {
      if (runLog) runLog.chEvent('http', channel, args, result, Date.now() - t0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: result === undefined ? null : result }));
    }).catch((err) => {
      if (runLog) runLog.err('http.' + channel, err, { args: runLog.briefArgs(args, 400) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    });
  }

  function handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
  }

  // PWA manifest：优先读应用根目录的静态 manifest.json（前端 <link rel="manifest"> 引同一份）
  const manifestPath = path.join(__dirname, 'frontend', 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8')
    : JSON.stringify({
    name: 'Video Lab',
    short_name: 'Video Lab',
    description: 'Video Lab — 批量成片项目管理',
    start_url: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#6a6fff',
    icons: [
      { src: '/icon/app-icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon/app-icon.png', sizes: '512x512', type: 'image/png' },
    ],
  });

  // 最小 service worker（仅满足 PWA 安装条件，不缓存）
  const SW_JS = `self.addEventListener('install', e => self.skipWaiting());\nself.addEventListener('activate', e => self.clients.claim());\nself.addEventListener('fetch', e => {});`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // 静态资源（无需 token）
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'index.html'));
      return;
    }
    if (pathname === '/task' || pathname === '/task.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'task.html'));
      return;
    }
    if (pathname === '/settings' || pathname === '/settings.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'settings.html'));
      return;
    }
    if (pathname === '/tool' || pathname === '/tool.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'tool.html'));
      return;
    }
    if (pathname === '/guide' || pathname === '/guide.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'guide.html'));
      return;
    }
    if (pathname === '/uninstall' || pathname === '/uninstall.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'uninstall.html'));
      return;
    }
    if (pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(manifest);
      return;
    }
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(SW_JS);
      return;
    }
    if (pathname.startsWith('/frontend/')) {
      const rel = pathname.slice('/frontend/'.length).replace(/\.\.\//g, '');
      serveStatic(req, res, path.join(FRONTEND_DIR, rel));
      return;
    }
    if (pathname.startsWith('/icon/')) {
      const rel = pathname.slice('/icon/'.length).replace(/\.\.\//g, '');
      serveStatic(req, res, path.join(ICON_DIR, rel));
      return;
    }
    // HTML/CSS/JS 相对路径兜底：HTML 引用「styles.css / skins/white_blue.css / icons.js /
    // app.js / txapi.js」等相对路径（与 Electron file: 协议下 HTML 位于 frontend/ 目录一致），
    // 以及 CSS 内 url() 相对资源（assets/...、skins/assets/...），统一按 frontend/ 根解析。
    {
      const rel = pathname.replace(/^\/+/, '').replace(/\.\.\//g, '');
      const fp = path.join(FRONTEND_DIR, rel);
      if (rel && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        serveStatic(req, res, fp);
        return;
      }
    }

    // SSE 端点（需 token）
    if (pathname === '/events') {
      if (!checkToken(req)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      handleSSE(req, res);
      return;
    }

    // API 端点（需 token）
    if (pathname.startsWith('/api/')) {
      if (!checkToken(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '无效 token' }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 10 * 1024 * 1024) req.destroy(); });
        req.on('end', () => handleApi(req, res, body));
        req.on('error', () => { res.writeHead(400); res.end('Bad Request'); });
      } else {
        // GET 请求也支持（无 body 时 args 为空数组）
        handleApi(req, res, '');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  let started = false;
  let actualPort = httpPort;
  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && !started) {
        // 端口被占用，尝试 +1 重试最多 10 次
        server.close();
        let tryPort = httpPort + 1;
        let attempts = 0;
        function tryNext() {
          if (attempts >= 10) {
            resolve({ ok: false, error: '端口 ' + httpPort + '-'+(httpPort+10)+' 均被占用', broadcastAll });
            return;
          }
          const tmp = http.createServer();
          tmp.on('error', () => { attempts++; tryPort++; tmp.close(); tryNext(); });
          tmp.listen(tryPort, '127.0.0.1', () => { tmp.close(); actualPort = tryPort; doListen(); });
        }
        tryNext();
      } else {
        resolve({ ok: false, error: String(err.message || err), broadcastAll });
      }
    });
    function doListen() {
      server.listen(actualPort, '127.0.0.1', () => {
        started = true;
        resolve({
          ok: true,
          port: actualPort,
          token: httpToken,
          url: 'http://localhost:' + actualPort + '/?token=' + httpToken,
          broadcastAll,
          channelIndex,
          close: () => { try { server.close(); } catch (e) {} },
        });
      });
    }
    doListen();
  });
}

module.exports = { startHttpServer };
