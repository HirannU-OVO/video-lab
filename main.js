// -*- coding: utf-8 -*-
// Video Lab — Electron 主进程
'use strict';

// ── 启动阶段计时 ──
// 启动阶段计时：从进程第一行起记录 whenReady → 窗口可见 → 后端就绪各阶段耗时，统一落到运行日志的 app.timing 事件，供冷启动排查直接查看。
const _BOOT_T0 = process.hrtime.bigint();
function bootMs() { return Number(process.hrtime.bigint() - _BOOT_T0) / 1e6; }
// 极早探针：本行之前只有 V8 启动 + 本文件解析，若这里「进程已存活很久」说明卡在
// 进程创建/加载阶段（杀软扫描未签名 exe、磁盘冷读），而非任何 JS 逻辑。
// 用 process.uptime() 反推进程真实创建时刻（Electron 主进程里该值自进程创建累计），
// 写入独立文件（文件名带 pid + 时刻，每个进程一份不覆盖）—— 此时 runLog 尚未初始化。
const _EARLY_UPTIME_MS = Math.round(process.uptime() * 1000);
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, net, screen } = require('electron');
const _bootReqElectron = bootMs();

// 预览版标识：按可执行文件名判定（Video Lab Preview.exe / Video Lab.exe / 开发态 electron.exe）
// ⚠ 不要改用 app.getName()：asar 内 package.json 无顶层 productName 时它回落到 name，两版同值
// ⚠ 必须在下方 app.setPath('userData') 与 appdataConfigPath() 之前定义（后者在模块顶层即被调用）
const IS_PREVIEW = (() => {
  try {
    if (process.argv.indexOf('--vl-preview') >= 0) return true;
    return /preview/i.test(String(process.execPath || ''));
  } catch (e) { return false; }
})();
console.log('[BUILD] preview=' + IS_PREVIEW + ' exe=' + path.basename(process.execPath || ''));
// 默认端口：预览版 9528，正式版 9527（仅在未配置端口时生效）
const DEFAULT_HTTP_PORT = IS_PREVIEW ? 9528 : 9527;

const { Api, DEFAULT_CONFIG } = require('./backend');
const { startHttpServer } = require('./server');
const _bootReqBackend = bootMs();
// 内嵌 HTTP 服务器：浏览器访问 http://localhost:<port> 获得与本体等价的功能
let httpServerInfo = null; // { ok, port, token, url, broadcastAll, close }
// 浏览器访问地址：优先取内存运行态；服务器已停/未启动时回退到 config.json 的 http_token 重建链接
// （token 在实例启动时写入 config，供开发测试读取；typeOf 守卫避免 config 声明前的 TDZ）
function httpUrl() {
  if (httpServerInfo && httpServerInfo.ok) return httpServerInfo.url;
  try {
    if (typeof config !== 'undefined' && config && config.http_token) {
      const p = parseInt(config.http_port, 10) || DEFAULT_HTTP_PORT;
      return 'http://localhost:' + p + '/?token=' + config.http_token;
    }
  } catch (e) {}
  return '';
}

// 启动/重启内嵌 HTTP 服务器：固定 token（首次生成持久化到 config.http_token，此后复用）；
// 端口或令牌在设置页变更后由 save_settings 调用本函数重启服务器，新配置即时生效
function restartHttpServer() {
  let httpToken = '';
  try {
    httpToken = String(config.http_token || '').trim();
    if (httpToken.length < 16) {
      httpToken = crypto.randomBytes(16).toString('hex');
      config.http_token = httpToken;
      saveConfig(config);
    }
  } catch (e) { try { httpToken = crypto.randomBytes(16).toString('hex'); } catch (e2) {} }
  startHttpServer({
    api,
    getMainWin: () => mainWin,
    getSettingsWin: () => null,   // 设置已内嵌为主窗口面板，不再有独立窗口
    httpPort: parseInt(config.http_port, 10) || DEFAULT_HTTP_PORT,
    httpToken: httpToken,
    extraRoutes: buildHttpExtraRoutes(),
    runLog: runLog,
    broadcast: function (event, data) { /* webContents.send 由各 send 函数完成，此处仅占位 */ }
  }).then(function (info) {
    httpServerInfo = info;
    if (info.ok) console.log('[HTTP] 浏览器访问: ' + info.url);
    else console.error('[HTTP] 启动失败: ' + (info.error || '未知错误'));
  }).catch(function (e) { console.error('[HTTP] 异常: ' + e); });
}

// 卸载准备形态：只显示卸载询问窗口，不进入主界面（不初始化托盘 / HTTP / 扫描 / 任务恢复）
// 两种来源：① 系统卸载入口调起（--uninstall-prep，自己收尾）；
//          ② 卸载器在卸载流程中调起（--uninstall-prep-child <结果文件>，只回传选择，由卸载器继续）
const UNINSTALL_CHILD_IDX = process.argv.indexOf('--uninstall-prep-child');
const UNINSTALL_CHILD = UNINSTALL_CHILD_IDX >= 0;
const UNINSTALL_RESULT = UNINSTALL_CHILD ? (process.argv[UNINSTALL_CHILD_IDX + 1] || '') : '';
const IS_UNINSTALL_PREP = UNINSTALL_CHILD || process.argv.includes('--uninstall-prep');

// 单实例锁：统一 userData 到固定全局路径（跨盘 / 开发版与打包版共享同一把锁），使"同一时刻仅允许一个主进程实例"真正生效；重复打开时唤出现有实例主窗口
// ⚠ 预览版须用独立 userData：锁的标识与浏览器存储（Local Storage）都挂在这个目录下
// ⚠ 卸载准备形态不取锁：安装器会把本程序复制成 old-uninstaller.exe 后执行，
//   撞上正在运行的实例会被锁挡下秒退，安装器便等不到结果。
app.setPath('userData', path.join(os.homedir(), IS_PREVIEW ? '.video-lab-preview' : '.video-lab'));
const gotTheLock = IS_UNINSTALL_PREP ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    // 卸载请求转交给已有实例处理
    if (argv && argv.indexOf('--uninstall-prep') >= 0) { openUninstallWindow(); return; }
    showMainWindow();
  });
}

// 版本形态判定：electron-builder portable 运行时注入 PORTABLE_EXECUTABLE_FILE；
// setup(NSIS) 安装版无该环境变量，且 resources 下存在 app-update.yml（第二重保险）——两者更新方式不同，据此分叉。
// 开发版（electron . / run.js）无上述特征，按便携形态处理。
const IS_PORTABLE = (() => {
  try {
    if (process.env.PORTABLE_EXECUTABLE_FILE) return true;
    return !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  } catch (e) {
    return true;
  }
})();

// 开机自启动形态：由登录项以 --autostart 启动时静默到托盘，不打扰用户
const IS_AUTOSTART = process.argv.includes('--autostart');

function projectDir() {
  if (!app.isPackaged) return __dirname;
  // 便携版：取 electron-builder portable 注入的 exe 所在目录，不依赖文件夹名（目录可在任意层级）
  if (IS_PORTABLE) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir && fs.existsSync(portableDir)) return path.resolve(portableDir);
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableFile) return path.dirname(portableFile);
  }
  // setup 安装版：exe 所在目录即程序根（引导文件与三库同级定位）
  return path.dirname(process.execPath);
}
// Node 引擎目录动态解析：引擎必须是真实文件系统路径（asar 内无法被 spawn 执行）。
// 源码共存形态（开发机）：引擎就在 main.js 同级 app\engines；
// 打包形态：便携/开发形态用 resources\app\engines，setup 安装在 resources\Engines（extraResources 产物）。
function resolveEnginesDir() {
  if (!app.isPackaged) {
    const local = path.join(__dirname, 'engines');
    try { if (fs.existsSync(local)) return fs.realpathSync(local); } catch (e) {}
    return local;
  }
  const base = projectDir();
  const src = path.join(base, 'resources', 'app', 'engines');
  const dist = path.join(base, 'resources', 'Engines');
  try { if (fs.existsSync(src)) return src; } catch (e) {}
  return dist;
}
function configFilePath() { return configFile; }
function programConfigPath() { return path.join(projectDir(), 'config.json'); }
// ⚠ %APPDATA% 的解析必须容错：app.getPath('appData') 在 APPDATA 缺失/无效时（企业环境、便携启动器清理环境、被外部工具改坏）会【抛异常】，而本函数在模块顶层就被调用。
//   异常一旦冒泡会导致主进程无法启动。回退链：appData → $APPDATA → home → userData。
function appdataConfigPath() {
  let base = '';
  try { base = app.getPath('appData'); } catch (e) {}
  if (!base) { try { base = process.env.APPDATA || ''; } catch (e) {} }
  if (!base) { try { base = app.getPath('home'); } catch (e) {} }
  if (!base) { try { base = app.getPath('userData'); } catch (e) {} }
  // 预览版使用独立数据目录（三库 config.json / settings.db / cache.db 同目录）
  return path.join(base, IS_PREVIEW ? 'Video Lab Preview' : 'Video Lab', 'config.json');
}
// 数据目录**恒为 %APPDATA%\Video Lab**（写死，不提供「程序目录」选项）：
//   程序目录可能在受控环境下不可写，且卸载重装会随目录丢数据；旧版留在程序目录的数据由下方「启动期搬迁」接管。
function resolveConfigLocation() {
  return appdataConfigPath();
}
let configFile = resolveConfigLocation();
// 数据根目录 = 引导文件所在目录：三库（config.json / settings.db / cache.db）扁平同目录，无 Cache\ / Config\ 中间层；
// 库路径一律由 storageDir() 派生，杜绝「路径重算」类 bug
const SETTINGS_DB = 'settings.db';
const CACHE_DB = 'cache.db';
const storageDir = () => path.dirname(configFilePath());

// ═══ 便携数据静默搬迁 + 留线索 + 接管标记 ═══
// 数据根固定为 %APPDATA%\Video Lab；旧版留在程序目录的数据由下方启动期搬迁接管。
const _migrateNotes = [];   // runLog 就绪前（搬迁在本句之后、runLog.init 之前）暂存，稍后补写
function _migLog(msg) { try { console.log('[migrate] ' + msg); } catch (e) {} _migrateNotes.push(String(msg)); }
// 复制 srcDir 的三库（含 sqlite 的 -wal/-shm）与 log\ 到 dstDir；成功判据 = dst 侧出现 config.json
function _migCopyData(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const n of ['config.json', SETTINGS_DB, CACHE_DB]) {
    for (const suf of ['', '-wal', '-shm']) {
      const src = path.join(srcDir, n + suf);
      try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, n + suf)); } catch (e) {}
    }
  }
  try {
    const srcLog = path.join(srcDir, 'log');
    if (fs.existsSync(srcLog) && fs.statSync(srcLog).isDirectory()) {
      const dstLog = path.join(dstDir, 'log');
      fs.mkdirSync(dstLog, { recursive: true });
      for (const f of fs.readdirSync(srcLog)) {
        try { fs.copyFileSync(path.join(srcLog, f), path.join(dstLog, f)); } catch (e) {}
      }
    }
  } catch (e) {}
  return fs.existsSync(path.join(dstDir, 'config.json'));
}
// 把 srcDir 接管为数据源：复制到 appdata → 改 config_storage → 源侧改名 → touch mtime。返回是否完成搬迁
function _adoptDirAsDataRoot(srcDir) {
  const appdDir = path.dirname(appdataConfigPath());
  const appdCfg = appdataConfigPath();
  if (!srcDir || path.resolve(srcDir) === path.resolve(appdDir)) return false;   // 源即目标
  if (!fs.existsSync(path.join(srcDir, 'config.json'))) return false;            // 源无引导文件
  if (fs.existsSync(appdCfg)) { _migLog('appdata 侧已有数据，跳过搬迁（保护既有数据）'); return false; }
  if (!_migCopyData(srcDir, appdDir)) { _migLog('复制未完成，保持原状下次再试'); return false; }
  // ① appdata 那份的 config_storage 写 'appdata'
  try {
    const j = JSON.parse(fs.readFileSync(appdCfg, 'utf8').replace(/^\uFEFF/, ''));
    j.config_storage = 'appdata';
    fs.writeFileSync(appdCfg, JSON.stringify(j, null, 2), 'utf8');
  } catch (e) {}
  // ② 源侧三库改名 *.migrated（改名非删除，可回滚取证；源侧从此无 config.json，不会再次触发搬迁）
  for (const n of ['config.json', SETTINGS_DB, CACHE_DB]) {
    for (const suf of ['', '-wal', '-shm']) {
      const src = path.join(srcDir, n + suf);
      try { if (fs.existsSync(src)) fs.renameSync(src, src + '.migrated'); } catch (e) {}
    }
  }
  // ③ touch appdata 的 config.json（刷新时间戳）
  try { const now = new Date(); fs.utimesSync(appdCfg, now, now); } catch (e) {}
  _migLog('已接管数据：' + srcDir + ' → ' + appdDir);
  return true;
}
// 线索/标记的存放目录：%LOCALAPPDATA%\Video Lab\
// ⚠ 刻意不放数据目录内 —— 数据目录可能被删/迁，线索要独立存活（供 NSIS 与后续排查使用）。
// ⚠ 取值必须容错：LOCALAPPDATA 在极端环境下可能缺失，回退链与 appdataConfigPath() 同款。
function localAppDir() {
  let base = '';
  try { base = process.env.LOCALAPPDATA || ''; } catch (e) {}
  if (!base) { try { base = app.getPath('appData'); } catch (e) {} }
  if (!base) { try { base = app.getPath('userData'); } catch (e) {} }
  return path.join(base, 'Video Lab');
}
// ── 历史数据根：旧版遗留清理与清单的**扩展扫描范围** ──────────────────────
//   程序目录里可能仍留着更早版本写入的 ffmpeg\ / preview\ / backup\ / log\ 等（不在当前数据根下）；⚠ 调用方必须按白名单逐个确认遗留物名，禁止通配删除或整目录回收。
function legacyDataDirs() {
  const out = [];
  const cur = (() => { try { return path.resolve(storageDir()); } catch (e) { return ''; } })();
  const push = (p) => {
    try {
      if (!p) return;
      const a = path.resolve(p);
      if (a === cur) return;                                  // 当前数据根不算"历史"
      if (out.indexOf(a) >= 0) return;
      if (!fs.statSync(a).isDirectory()) return;
      out.push(a);
    } catch (e) { /* 不存在/无权限：跳过 */ }
  };
  push(path.dirname(programConfigPath()));                    // ① 程序目录（旧版安装版与便携版的默认落点）
  push(path.dirname(appdataConfigPath()));                    // ② %APPDATA%\Video Lab（旧版切过保存位置时的落点）
  try {                                                       // ③ 线索里记录的便携目录（可能是第三处）
    const og = JSON.parse(fs.readFileSync(path.join(localAppDir(), 'portable-origin.json'), 'utf8').replace(/^\uFEFF/, ''));
    push(og && og.portableDir);
  } catch (e) { /* 无线索：正常 */ }
  return out;
}
// 留线索：%LOCALAPPDATA%\Video Lab\portable-origin.json
// 刻意不放数据目录内 —— 数据目录可能被删/迁，线索要独立存活；供 NSIS 安装包与后续排查使用。
function _writePortableOrigin(migrated) {
  try {
    const dir = localAppDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'portable-origin.json');
    let old = {};
    try { old = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
    fs.writeFileSync(f, JSON.stringify({
      portableDir: path.dirname(programConfigPath()),
      version: app.getVersion(),
      at: Date.now(),
      migrated: (migrated === true) || (old && old.migrated === true),
    }, null, 2), 'utf8');
  } catch (e) { _migLog('线索写入失败（不影响使用）：' + ((e && e.message) || e)); }
}
// ── 启动期执行（仅此处；开发形态一律跳过）：把旧版留在程序目录里的数据搬过来 ──
// ⚠ 判据 = 程序目录有数据且 appdata 侧没有：旧安装版默认把数据放程序目录，卸载/换目录会随目录丢失；appdata 非空时绝不覆盖。
try {
  const _progDir = path.dirname(programConfigPath());
  const _hasProgData = (() => { try { return fs.existsSync(programConfigPath()); } catch (e) { return false; } })();
  const _hasAppdData = (() => { try { return fs.existsSync(appdataConfigPath()); } catch (e) { return true; } })();
  if (app.isPackaged && _hasProgData && !_hasAppdData) {
    // 存量数据搬迁（只在 appdata 侧为空时动手；非空则保护既有数据，绝不覆盖）
    const done = _adoptDirAsDataRoot(_progDir);
    if (done) configFile = appdataConfigPath();   // 本次会话起即用 appdata（storageDir 随之派生）
    // 留线索（顺序不可颠倒：先搬迁完成，再写线索，migrated 才准确）
    _writePortableOrigin(done);
  } else if (app.isPackaged && _hasProgData && _hasAppdData) {
    // 两侧都有数据：**以 appdata 为准**（单一数据根），程序目录那份不在这里删 ——它属于历史遗留，交给「数据目录清理」清单（可查、可清、进回收站可还原）。
    _migLog('程序目录仍有数据，但 AppData 已有数据 → 以 AppData 为准，原位置留给清理清单：' + _progDir);
  }
  // 线索目录的空壳回收：portable-origin.json 按设计常驻（供排查与安装包参考，不删）；目录里已经什么都没有时（用户清过 / 从未产生过线索）纯属空壳 —— 收回。
  try {
    const ldir = localAppDir();
    if (fs.existsSync(ldir) && fs.statSync(ldir).isDirectory() && fs.readdirSync(ldir).length === 0) {
      fs.rmdirSync(ldir);
      _migLog('已回收空的线索目录：' + ldir);
    }
  } catch (e) { /* 非致命 */ }
} catch (e) { _migLog('搬迁流程异常（已忽略，不影响使用）：' + ((e && e.message) || e)); }

// ── 运行日志（排查用，保留 7 天）──
// 任务记录 / 任务标记 / 成片产物都可能被清除或删除，一旦清除就只剩"反推"。本日志独立留存、任何清除操作都不触碰它 —— 它是事后唯一还在的证据。
const runLog = require(path.join(resolveEnginesDir(), 'base', 'runlog.js'));
runLog.init(path.join(storageDir(), 'log'));
// 搬迁发生在 runLog 初始化之前（见上方"便携数据静默搬迁"）：就绪后补写，保证排查有据
try { _migrateNotes.forEach(function (m) { runLog.sys('app.migrate', m, {}); }); } catch (e) {}
const _pruned = runLog.pruneOld();
const _bootLogReady = bootMs();
runLog.sys('app.start',
  '启动 · 版本 ' + app.getVersion() + ' · ' + (app.isPackaged ? (IS_PORTABLE ? '便携形态' : '安装形态') : '源码形态')
  + (_pruned.removed ? ' · 已清理 ' + _pruned.removed + ' 个过期日志' : ''),
  { version: app.getVersion(), packaged: app.isPackaged, portable: IS_PORTABLE, storageDir: storageDir(), enginesDir: resolveEnginesDir(), keepDays: runLog.KEEP_DAYS });
runLog.sys('app.timing', '启动阶段 · 日志就绪',
  { electronReq: Math.round(_bootReqElectron), backendReq: Math.round(_bootReqBackend), logReady: Math.round(_bootLogReady) });
// 进程创建 → JS 首行 的间隔：这一段时间完全在业务代码之外（框架加载/杀软扫描/磁盘冷读）。
// 它异常大时，本行之内的一切耗时都不值得看 —— 问题在进程被外部阻塞。
// 注意 two clock：uptimeMs 以进程创建为基准，bootMs 以本文件首行为基准，两者相减才是真间隔。
runLog.sys('app.timing', '启动阶段 · 进程创建→JS 首行',
  { uptimeMsAtFirstLine: _EARLY_UPTIME_MS, jsFromFirstLineToLogReadyMs: Math.round(_bootLogReady),
    totalFromProcessCreateMs: Math.round(_EARLY_UPTIME_MS + _bootLogReady) });

// ── IPC 统一留痕：一处覆盖全部通道 ──
// 回答"用户到底点了什么"——任务窗口与主窗口的写操作都会经过这里，包括删除配置、新增配置、添加/删除路径、重分组、清除产物等。
const _origIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function (channel, fn) {
  return _origIpcHandle(channel, async function (e, ...args) {
    const t0 = Date.now();
    try {
      const r = await fn(e, ...args);
      runLog.chEvent('ipc', channel, args, r, Date.now() - t0);
      return r;
    } catch (err) {
      runLog.err('ipc.' + channel, err, { args: runLog.briefArgs(args, 400) });
      throw err;
    }
  });
};
// 删除总入口（与 backend.js 同构的两级语义）：
//   hardDelete —— 直接删（程序自产、可再生的残留）；recycleFile —— 送回收站（用户资产 / 需重新下载）。
// 送站分两步：① 同步改名成 `<名>.<时间戳>.deleting` 摘除原路径；② 异步送站。
// 降级落点为数据目录的 recycle-failed\ 暂存区，不留在用户目录；① 与 ② 之间被中断的残留，
// 由后端的 .deleting 清扫按后缀自动收走。
function hardDelete(p) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  } catch (e) { return false; }
}
function stashRecycleFailed(staged, why) {
  try {
    if (!staged || !fs.existsSync(staged)) return false;
    const dest = path.join(storageDir(), 'recycle-failed', path.basename(staged));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(staged, dest); }
    catch (e) { fs.copyFileSync(staged, dest); fs.unlinkSync(staged); }   // 跨卷：复制后删除
    try { runLog.sys('recycle.failed', '移入回收站失败，已暂存到数据目录 · ' + String(why || ''), { to: dest }); } catch (e2) {}
    return true;
  } catch (e) { return false; }
}
function recycleFile(p, why) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    let target = p;
    try {
      const staged = p + '.' + Date.now() + '.deleting';
      fs.renameSync(p, staged);
      target = staged;
    } catch (e) { /* 改名失败：直接送站 */ }
    try {
      const { shell } = require('electron');
      if (shell && typeof shell.trashItem === 'function') {
        shell.trashItem(target).catch(() => { stashRecycleFailed(target, why); });
        return true;
      }
    } catch (e) {}
    stashRecycleFailed(target, why);
    return true;
  } catch (e) { return false; }
}
function defaultRoot() { return path.dirname(projectDir()); }
// 已废弃的配置键（读入内存与写入设置库前一律剔除）：scripts_dir / use_node_engine（旧脚本目录 / 引擎开关）、
//   config_storage（数据目录选择）。数据目录**恒为 %APPDATA%\Video Lab**，该键不再参与路径决策；
//   老版本可能已把它写进设置库/旧 config.json，不剔除会带着一起进内存并被 get_settings 带出去。
const OBSOLETE_CONFIG_KEYS = ['scripts_dir', 'use_node_engine', 'config_storage'];
// 主题（皮肤）白名单 —— 须与前端 app.js 的 SKINS、settings.js 的 THEMES 三处一致
// （回归断言会核对三者同步，任一漏改即报错）。
// 写入口必须校验：皮肤 id 是**外部可见**的值（配置文件、IPC、HTTP API 都能写），
// 前端遇到无法识别的 id 会静默回落到第一个主题 —— 故非法值一律忽略、保留原值，不抛错也不改动其它键。
const SKIN_IDS = ['white_blue', 'Black_Orange', 'Maid_Atelier'];
const isValidSkin = (v) => typeof v === 'string' && SKIN_IDS.indexOf(v.trim()) >= 0;
// ── 配置读取：settings.db 为唯一业务来源，config.json 只用于「首次引导」与开发者开关 ──
// ⚠ 业务键一律只从 settings.db 取，**不得回退读 config.json**：config 会逐步简化，
// 任何「config 缺失就回退读它」的路径都会变成取到 undefined 的隐患（表现为设置莫名丢失）；库里没有就用 DEFAULT_CONFIG 的默认值。
// ⚠ config.json **不参与写入**：数据版本守卫不允许回退到旧版本，维护一份历史快照无人可读，
//   写它只会让磁盘上多一份与真实设置可能不一致的副本。

// ── 批量模式的工作目录：唯一真相 = `config.batch.root` ──
// 工作路径属于**批量模式**而非整个软件：各模式的工作目录由各模式自己承接（遮罩有自己的 `mask.root`）。
// 读取一律用 getBatchRoot()；写入一律用 setBatchRoot()。
function getBatchRoot(cfg) {
  const b = cfg && cfg.batch;
  return (b && typeof b === 'object' && typeof b.root === 'string') ? b.root.trim() : '';
}
function setBatchRoot(cfg, dir) {
  if (!cfg) return;
  const v = String(dir == null ? '' : dir).trim();
  cfg.batch = Object.assign({}, cfg.batch || {}, { root: v });
}
// 待落库的工作路径迁移值：loadConfig 首阶段只能做**内存**迁移（那时 api 还没构造），
// 真正落库（写 batch.root、删旧 root）由 applySettingsFromDb 在 api 就绪后完成。
let _pendingRootMigration = '';
// 待落库的旧顶层 root 清理标记（batch.root 已就位却仍有残留 root 时置真）
let _pendingRootCleanup = false;

// 直读 settings.db 的 app scope（**不依赖 api**）：启动初期需先用 settings 里的 root 定位工作目录，而 api 的构造又必须先有 root，走 api 会形成死循环。
// ⚠ 故直接从 storageDir() 派生库路径读一次；读不到返回 null（调用方保持默认值，不回退 config.json）。
function readSettingsAppDirect() {
  try {
    const dbPath = path.join(storageDir(), SETTINGS_DB);
    if (!fs.existsSync(dbPath)) return null;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let out = null;
    try {
      const rows = db.prepare('SELECT key, value FROM settings WHERE scope = ?').all('app');
      out = {};
      for (const r of rows) {
        // 与 SettingsStore.all 同语义：单条脏数据不拖垮整体
        try { out[String(r.key)] = JSON.parse(String(r.value)); } catch (e) {}
      }
    } finally {
      try { db.close(); } catch (e) {}
    }
    return out;
  } catch (e) { return null; }
}

// 读 settings.db 的 app scope（失败返回 null 表示库不可用，调用方据此保持默认值）
// 优先走 api（已建立连接、语义与 SettingsStore 完全一致）；api 尚未就绪时退回直读。
function readSettingsApp() {
  try {
    if (typeof api === 'undefined' || !api || typeof api.getAppSettings !== 'function') return readSettingsAppDirect();
    const all = api.getAppSettings();
    return (all && typeof all === 'object') ? all : {};
  } catch (e) { return readSettingsAppDirect(); }
}

// 写 settings.db 的 app scope（不占用调用方的异常路径：库不可用时静默，内存 config 仍生效）
function writeSettingsApp(values) {
  try {
    if (typeof api === 'undefined' || !api || typeof api._saveAppSettings !== 'function') return;
    api._saveAppSettings(values || {});
  } catch (e) {}
}

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  // ① config.json 现有内容（一次性引导的取值来源；此后不再参与业务键读取）
  // ② 业务键：settings.db 全量载入（库不可用时保持默认值 —— 不回退 config.json）
  const app = readSettingsApp();
  if (app) {
    // ③ 一次性迁移：旧顶层 root → batch.root。⚠ **必须在取值循环之前**完成 —— 否则首阶段 `resolveRoot()` 取不到工作目录（会回退成程序目录的上一级）。
    //    这里只改内存（api 尚未构造、无法落库）；落库在 applySettingsFromDb 完成。
    const legacyRoot = typeof app.root === 'string' ? app.root.trim() : '';
    const batchObj = (app.batch && typeof app.batch === 'object') ? app.batch : {};
    const hasBatchRoot = typeof batchObj.root === 'string' && batchObj.root.trim();
    const appHasRootKey = Object.prototype.hasOwnProperty.call(app, 'root');
    if (!hasBatchRoot && legacyRoot) {
      app.batch = Object.assign({}, batchObj, { root: legacyRoot });
      _pendingRootMigration = legacyRoot;   // 待落库：写 batch.root
      _pendingRootCleanup = true;           // 待落库：删旧顶层 root
    } else if (hasBatchRoot && appHasRootKey) {
      // 残留清理：batch.root 已就位却仍留着旧顶层 root 时删除 —— 否则 settings 里会多出一个与 batch.root 不一致的旧键。
      _pendingRootCleanup = true;
    }
    for (const k of Object.keys(app)) {
      if (app[k] === undefined || app[k] === null) continue;
      cfg[k] = app[k];
    }
  } else {
    // 设置库确实读不到（api 与直读两条路都失败）—— 保持默认值，不回退 config.json。
    // ⚠ 此处**不可引用 api**：顶层首调时 const api 尚在 TDZ，即使 typeof 也会抛 ReferenceError
    //   （会让整个启动崩溃）。readSettingsApp 内部已做 try 探测，走到这里就是真读不到。
    try { runLog.sys('app.config', '设置库不可用：本次按默认值运行（不回退 config.json）', {}); } catch (e) {}
  }
  for (const k of OBSOLETE_CONFIG_KEYS) delete cfg[k];
  return cfg;
}
// 保存配置：以「实际变更的键」为单位落盘，避免每次保存全量重写。
// 唯一落盘目标是 settings.db（也是唯一读取来源）。
// ⚠ config.json 不是写入目标：数据版本守卫（engines/base/dataver.js）不允许回退到旧版本，
//   那份历史快照无人可读；写它只会让磁盘上多一份与真实设置可能不一致的副本。
let _configBaseline = {};
function saveConfig(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const changed = {};
  for (const k of Object.keys(cfg)) {
    if (OBSOLETE_CONFIG_KEYS.indexOf(k) >= 0) continue;
    if (!_configValueEqual(_configBaseline[k], cfg[k])) changed[k] = cfg[k];
  }
  // 基线同步（无论是否有变更：入参即当前真值，下次比对以它为准）
  _configBaseline = JSON.parse(JSON.stringify(cfg));
  if (!Object.keys(changed).length) return [];
  // settings.db 不落顶层 root：它已被 batch.root 取代。
  // 若写进 settings，下次 loadConfig 会把它读回内存 → 形成两个真相
  // （用户改工作路径时可能只更新其中一个，工作目录随之错乱）。
  const forSettings = Object.assign({}, changed);
  delete forSettings.root;
  if (Object.keys(forSettings).length) writeSettingsApp(forSettings);
  return Object.keys(changed);
}
// 配置值等价判定（对象按键逐层比，其余直接比）：用于「只写变更键」的差异计算
function _configValueEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!_configValueEqual(a[k], b[k])) return false; }
    return true;
  }
  return false;
}
// 应用级设置的合入（软件端 IPC 与浏览器端 HTTP 两条保存路径共用）。
// 落盘统一由 saveConfig 完成：settings.db 是唯一读取来源，config.json 仅作旧版本兼容快照（只更新它原本就有的键）；
// 故此处只做「把提交值合入 cfg」，不单独落库。
function mergeAppSettings(cfg, s) {
  if (!s || typeof s !== 'object') return cfg;
  if (typeof s.notify_task_end === 'boolean') cfg.notify_task_end = s.notify_task_end;
  if (typeof s.backup_dir === 'string') cfg.backup_dir = s.backup_dir;
  if (typeof s.backup_auto_clean === 'boolean') cfg.backup_auto_clean = s.backup_auto_clean;
  if (s.backup_keep_days !== undefined) cfg.backup_keep_days = parseInt(s.backup_keep_days, 10) || 7;
  return cfg;
}
function resolveRoot(config) {
  const env = (process.env.TXT_MANAGER_ROOT || '').trim().replace(/^"|"$/g, '');
  if (env && fs.existsSync(env) && fs.statSync(env).isDirectory()) return env;
  // 工作目录取自批量模式的 batch.root（旧顶层 root 已在 loadConfig 中迁移过来）
  const br = getBatchRoot(config);
  if (br && fs.existsSync(br) && fs.statSync(br).isDirectory()) return br;
  return defaultRoot();
}

const config = loadConfig();
// 落盘基线：saveConfig 以此判定「哪些键真的变了」，只写变更键（避免每次保存全量重写两个文件）。
// 初值 = 启动时载入的完整配置（此后每次 saveConfig 都会更新它）。
_configBaseline = JSON.parse(JSON.stringify(config));
// ── 每日定时检查更新：按设置整点触发静默检查，检查后滚动安排次日（应用需保持运行） ──
let dailyUpdateTimer = null;
function scheduleDailyUpdateCheck() {
  if (dailyUpdateTimer) { clearTimeout(dailyUpdateTimer); dailyUpdateTimer = null; }
  if (!UPDATE_ENABLED || config.check_update_daily !== true) return;
  const hour = parseInt(config.check_update_hour, 10);
  if (!(hour >= 0 && hour <= 23)) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  dailyUpdateTimer = setTimeout(function () {
    dailyUpdateTimer = null;
    checkForUpdate({ silent: true }).catch(function () {});
    scheduleDailyUpdateCheck();
  }, Math.min(next.getTime() - now.getTime(), 24 * 3600 * 1000));
}

const root = resolveRoot(config);
// 库与引导文件同目录（扁平布局）：没有 Cache\ / Config\ 中间层，也无「配置侧 / 缓存侧对齐」问题
const { migrateToFlatLayout, listStagingDirs } = require(path.join(resolveEnginesDir(), 'base', 'migrate.js'));
// 库路径一律由 storageDir() 派生（见上方定义）：不存在需要重算的路径，杜绝「写回旧位置」类 bug
// 一次性布局迁移：旧布局（Cache\ + Config\ + config 同级旧设置文件）→ 三库（config.json / settings.db / cache.db）。
// 每次启动执行且幂等（逐条 upsert 合并，便于回退旧版后再升级收敛）；校验通过才把旧物暂存，失败则保持旧布局可启动。
const pendingTrashDirs = [];
try {
  const mr = migrateToFlatLayout({ configDir: path.dirname(configFile), log: (m) => console.log(m) });
  if (mr.migrated && mr.stagingDir) pendingTrashDirs.push(mr.stagingDir);
  if (mr.errors && mr.errors.length) console.error('[migrate] ' + mr.errors.join('；'));
} catch (e) { console.error('[migrate] 迁移异常：' + ((e && e.message) || e)); }
// config.json 已退休（设置项全在 settings.db），含明文令牌 → hard 级直接删：进回收站反而让令牌在磁盘多留一份
try {
  if (fs.existsSync(configFile)) {
    if (hardDelete(configFile)) {
      try { runLog.sys('app.config', '已删除退休的 config.json（设置项全部存于 settings.db）', {}); } catch (e) {}
    }
  }
} catch (e) {}
// ⚠ 跨根收集：暂存目录（.video-lab-legacy-*）可能落在历史数据根里（搬迁前后各产生过一次）。
//   只扫当前根会让旧根里的暂存永不清理。legacyDataDirs 已按当前根去重。
const _stagingRoots = [path.dirname(configFile)].concat(legacyDataDirs());
for (const _sr of _stagingRoots) {
  try {
    for (const d of listStagingDirs(_sr)) {
      if (pendingTrashDirs.indexOf(d) < 0) pendingTrashDirs.push(d); // 回收上次运行未及清理的暂存目录
    }
  } catch (e) { /* 单根失败不影响其余 */ }
}
// 暂存目录是本次搬迁刚创建、且内容已搬走的中间物 → hard 级直接删
if (pendingTrashDirs.length) {
  app.whenReady().then(() => { for (const d of pendingTrashDirs) { try { hardDelete(d); } catch (e) {} } });
}
// ── 数据格式版本守卫 ──
// 开库前用**只读连接**检查数据格式版本：库比程序新即拒绝启动，避免旧程序把新格式数据写坏。
// 判据是「**数据格式**版本」而非「程序版本」—— 后者每次发版都变，会误伤只想回退功能的用户。
(() => {
  try {
    const dataver = require(path.join(resolveEnginesDir(), 'base', 'dataver.js'));
    const dvDbPath = path.join(storageDir(), 'settings.db');
    const dv = dataver.checkDataVersion(dvDbPath);
    if (dv.status === 'too-new') {
      try { dialog.showErrorBox('数据版本不兼容', dataver.tooNewMessage(dv, dvDbPath)); } catch (e2) { /* 弹框失败也要拒绝 */ }
      app.exit(1);
      // showErrorBox 是同步的，正常不会走到下一行；显式抛出以确保后续初始化一个都不执行
      throw new Error('DATA_VERSION_TOO_NEW');
    }
    // 库存在但没有版本标记（首次接触这份数据）⇒ 补记一次，供将来判断
    if (dv.status === 'ok' && dv.found == null && fs.existsSync(dvDbPath)) dataver.writeDataVersion(dvDbPath);

    // 数据比程序旧 ⇒ 后续要迁移。迁移**不可逆**（旧库被就地改写），中途失败即旧结构、新结构都用不了 ——所以先整套备份，成功才继续；备份同时也是回退旧版本时的那份可用数据。
    if (dv.status === 'ok' && dv.found != null && dv.found < dv.supported) {
      const bk = dataver.preMigrateBackup(dvDbPath, dv.found);
      if (bk.ok) {
        console.error('[dataver] 迁移前已备份：' + bk.dir + '（' + bk.files.join('、') + '）');
        try { dataver.pruneBackups(dvDbPath); } catch (e3) { /* 清理失败不影响迁移 */ }
      } else {
        // 备份不成功就**不迁移**：宁可让用户继续用旧数据，也不能在没有退路的情况下动它；弹框提示后退出。
        console.error('[dataver] 迁移前备份失败，已跳过迁移：' + bk.error);
        try {
          dialog.showErrorBox('无法安全升级数据',
            '备份当前数据失败，为保护你的数据，软件没有继续升级。\n'
            + '请检查磁盘空间是否充足，然后重新打开软件。\n\n'
            + '错误信息：' + bk.error);
        } catch (e2) { /* 弹框失败也要停下来 */ }
        app.exit(1);
        throw new Error('DATA_VERSION_BACKUP_FAILED');
      }
    }
  } catch (e) {
    // 这两种是**主动拒绝启动**，必须继续抛出去（不然下面的"放行"会把它们吞掉）
    if (e && (e.message === 'DATA_VERSION_TOO_NEW' || e.message === 'DATA_VERSION_BACKUP_FAILED')) throw e;
    // 检查本身出错（权限不足 / 库损坏 / 被独占）⇒ 放行。守卫的职责是拦住"确定不兼容"，而不是因为查不动就把用户锁在门外。
    console.error('[dataver] 版本检查失败，按放行处理：' + ((e && e.message) || e));
  }
})();
const api = new Api(root, config, resolveEnginesDir(), storageDir());
// 把「历史数据根」交给后端：旧版遗留的清单与清理必须能看见"当前数据根之外"的那几处
// （搬迁后仍留在程序目录里的 ffmpeg\ / preview\ / .locks\ / txt-snap\ / backup\ / 老 log\），
// 否则那批遗留永远不会出现在清单一里。详见 legacyDataDirs() 的注释。
try { api.setLegacyDataDirs(legacyDataDirs()); } catch (e) { console.error('[legacy] 历史数据根注入失败：' + ((e && e.message) || e)); }
// 启动清理触发点：暂存目录 / config.json / 后端 cleanupLegacyArtifacts
try { if (api && typeof api.cleanupLegacyArtifacts === 'function') api.cleanupLegacyArtifacts(); }
catch (e) { console.error('[legacy] 启动清理失败：' + ((e && e.message) || e)); }
// ── 设置库载入（两阶段之二）：api 就绪后用 settings.db 的真实值覆盖内存 config ──
// 分两阶段：loadConfig() 需要 api 才能读 settings.db，而 api 的构造又需要 config.root（库路径由 storageDir 派生，无法自举）——
// 故顶层先用「锚点 + 默认值」建 api，再用真值覆盖。
(function applySettingsFromDb() {
  try {
    const app = api.getAppSettings();
    if (!app || typeof app !== 'object') {
      runLog.sys('app.config', '设置库不可用：本次会话按默认值运行（不回退 config.json）', {});
      return;
    }
    let n = 0;
    for (const k of Object.keys(app)) {
      if (app[k] === undefined || app[k] === null) continue;
      config[k] = app[k];
      n++;
    }
    runLog.sys('app.config', '设置库已载入（' + n + ' 项）', { keys: Object.keys(app).length });
    // 工作路径迁移落库（api 此时已就绪）：把旧顶层 root 写进 batch.root 并删除旧键，
    // 保持「唯一真相」。内存迁移已在 loadConfig 完成（首阶段就要用它定位工作目录）。
    if (_pendingRootMigration) {
      try {
        api._saveAppSettings({ batch: Object.assign({}, config.batch || {}, { root: _pendingRootMigration }) });
        api._removeAppSetting('root');
        runLog.sys('app.config', '工作路径已迁移至 batch.root（' + _pendingRootMigration + '）', { root: _pendingRootMigration });
      } catch (e) {}
      _pendingRootMigration = '';
      _pendingRootCleanup = false;
    } else if (_pendingRootCleanup) {
      // 清理残留的旧顶层 root（真相是 batch.root）
      try {
        api._removeAppSetting('root');
        runLog.sys('app.config', '已清理残留的顶层 root（工作路径的真相在 batch.root）', {});
      } catch (e) {}
      _pendingRootCleanup = false;
    }
  } catch (e) {
    try { runLog.err('app.config', e, { at: 'applySettingsFromDb' }); } catch (e2) {}
  }
  // 载入后刷新落盘基线：此后 saveConfig 的「变更判定」以设置库真值为基准
  try { _configBaseline = JSON.parse(JSON.stringify(config)); } catch (e) {}
})();
// 扫描/重建环节进度：推送主窗口渲染层实时状态（walk/收集日志/重建成片索引/水印统计 一一对应）
api.onScanProgress = (p) => {
  try {
    const targets = [];
    if (mainWin && !mainWin.isDestroyed()) targets.push(mainWin);
    if (!targets.length) { const w = BrowserWindow.getAllWindows()[0] || null; if (w) targets.push(w); }
    for (const w of targets) { try { w.webContents.send('scan_progress', p); } catch (e) {} }
  } catch (e) {}
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('scan_progress', p);
};
// FFmpeg 环境自愈进度：主窗（更新浮窗复用）+ 设置页（维护区行内进度）双通道
api.onFfmpegProgress = (p) => {
  sendToMain('env_fix_progress', p);
  sendToSettings('env_fix_progress', p);
};
// 运行期环境失效（用的时候才发现的 ffmpeg/ffprobe 不可用）：横幅（可一键下载修复）+ 吐司（更醒目的即时提示）双通道，两个窗口都发。
api.onEnvLost = (info) => {
  const payload = { missing: (info && info.missing) || '', hasFfmpeg: !!(info && info.ffmpeg) };
  sendToMain('env_fix_available', payload);
  sendToSettings('env_fix_available', payload);
  sendToMain('env_lost', payload);
  sendToSettings('env_lost', payload);
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('env_lost', payload);
};

// 主窗口与任务窗口：主窗口仅在原生模态对话框/载入遮罩时被禁用；任务列表窗口不随父窗口禁用
let mainWin = null;
// 扫描全程后台：不弹独立窗口，进度写状态栏与运行日志。

// 按需预热扫描：**只在用户主动唤起主窗口时调用**（托盘点击 / 再次双击图标 / 托盘菜单）。
// 开机自启（--autostart）是静默常驻托盘形态，绝不弹窗、也不预热，避免无谓打扰与机械盘唤醒。
let _scanWarmBusy = false;
function warmScanOnDemand(reason) {
  try {
    if (_scanWarmBusy) return;
    if (!getBatchRoot(config)) return;
    if (api.hasProjectsCache) return;      // 已有完整结果，无需扫描
    _scanWarmBusy = true;
    const _t = process.hrtime.bigint();
    const _elapsed = () => Math.round(Number(process.hrtime.bigint() - _t) / 1e6);
    api.isScanCacheFreshAsync().then((fresh) => {
      if (fresh) {
        _scanWarmBusy = false;
        logTiming('唤起检查：扫描缓存有效，无需扫描（' + reason + '，' + _elapsed() + 'ms）');
        return;
      }
      // 唤起时同样后台扫描：不弹窗、也不推迟窗口显示
      const finish = () => {
        _scanWarmBusy = false;
        logTiming('唤起预热扫描完成（' + reason + '，' + _elapsed() + 'ms）');
      };
      api.listProjectsAsync().then(finish).catch(finish);
    }).catch(() => { _scanWarmBusy = false; });
  } catch (e) { _scanWarmBusy = false; }
}

// 系统托盘：关闭主窗口仅最小化到托盘，右键托盘图标菜单可退出或显示主窗口
let tray = null;
let isQuitting = false;
let exitLogged = false;   // 退出留痕只记一次（before-quit 因 preventDefault 会被多次触发）
let quitConfirmed = false; // 有运行中任务退出时，经主窗口确认后才真正退出
let closeAskOpen = false; // 关闭主窗口行为引导弹窗打开中：避免重复弹窗/重复触发
// 配置未保存确认：关闭/退出前询问主窗口（覆盖当前配置/保存为当日配置/取消），避免修改丢失
let discardAskOpen = false;      // 「配置未保存确认」弹窗进行中，避免重复询问
let discardCloseHandled = false; // close 路径：未保存已确认（一次性，本次关闭不再询问）
let discardQuitHandled = false;  // quit 路径：未保存已确认（本次退出不再询问）
// 图标源文件（resources/app/icon/），托盘图标使用多分辨率适配不同缩放的任务栏
const ICON_DIR = path.join(__dirname, 'icon');
// 托盘图标单例：图标文件在 asar 内、体积小，但 createFromPath 是同步读盘 ——冷态 + 安全软件扫描下首次读取可能被放大，故只构建一次并复用。
let _trayIcon = null;
function trayIcon() {
  if (_trayIcon) return _trayIcon;
  // 预览版托盘图标取 icon/preview/（橙色剪影）
  // ⚠ 托盘图标只有 16px：深灰在深色任务栏上辨识度极低，预览版须用高饱和色
  const dir = IS_PREVIEW ? path.join(ICON_DIR, 'preview') : ICON_DIR;
  const img = nativeImage.createFromPath(path.join(dir, 'tray-icon.png'));
  for (const rep of ['tray-icon@1.25x.png', 'tray-icon@1.5x.png', 'tray-icon@2x.png']) {
    img.addRepresentation(nativeImage.createFromPath(path.join(dir, rep)));
  }
  _trayIcon = img.isEmpty() ? nativeImage.createEmpty() : img;
  return _trayIcon;
}
function showMainWindow() {
  // 托盘唤出计时：用于定位「点托盘要等很久、窗口迟迟不出现」。
  // 主进程只能测到 show() 调用本身返回的耗时；窗口是否真的画出来要看渲染侧首帧，
  // 故同时向渲染进程要一次 rAF 双帧确认，两个数字分开记 —— 若 show() 很快而首帧很慢，说明卡在渲染/合成。
  const _t = process.hrtime.bigint();
  const needRebuild = !mainWin || mainWin.isDestroyed();
  if (needRebuild) createWindow();
  mainWin.show();
  mainWin.focus();
  const ms = Number(process.hrtime.bigint() - _t) / 1e6;
  // 用户主动唤起：若扫描缓存已失效则后台补扫（自启形态启动时跳过了预热）。
  // isQuitting 时跳过 —— 退出流程里也会 showMainWindow()，那不是用户"想打开界面"。
  if (!isQuitting) warmScanOnDemand('唤起主窗口');
  try {
    runLog.sys('app.timing', '托盘唤出主窗口'
      + (needRebuild ? '（窗口已销毁 → 重建）' : '（窗口仅隐藏 → 直接显示）'),
      { costMs: Math.round(ms), rebuilt: needRebuild });
  } catch (e) {}
  // 渲染侧首帧确认（异步）：与上面的 costMs 对照即可区分「主进程卡」还是「渲染卡」
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.executeJavaScript(
        'new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res(1);});});})'
      ).then(() => {
        const total = Number(process.hrtime.bigint() - _t) / 1e6;
        try { runLog.sys('app.timing', '托盘唤出 · 渲染首帧确认', { showMs: Math.round(ms), firstFrameMs: Math.round(total), rebuilt: needRebuild }); } catch (e) {}
      }).catch(() => {});
    }
  } catch (e) {}
}
function createTray() {
  if (tray) return; // 已创建：避免重复 new Tray 与重复绑定 click 回调（会触发多次 showMainWindow）
  tray = new Tray(trayIcon());
  // 托盘悬停提示（预览版带线别）
  tray.setToolTip(IS_PREVIEW ? 'Video Lab 预览版（与正式版数据互不影响）' : 'Video Lab');
  // 左键直接唤起主窗口；右键唤出自绘托盘菜单
  // ⚠ 点击留痕放在回调**最前**：用于区分两种「图标在、点不动」——① 没有「托盘收到点击」日志 = 事件没送达主进程（托盘对象异常）；
  //   ② 有「托盘收到点击」但没有后续「托盘唤出主窗口」= 回调执行了但卡在 show() 之前。
  tray.on('click', () => {
    try { runLog.sys('app.timing', '托盘收到点击（左键）', { atSinceProcessStart: Math.round(bootMs()) }); } catch (e) {}
    hideTrayMenu();
    showMainWindow();
  });
  tray.on('right-click', () => {
    try { runLog.sys('app.timing', '托盘收到点击（右键）', { atSinceProcessStart: Math.round(bootMs()) }); } catch (e) {}
    showTrayMenu();
  });
  // 托盘对象存活探针：explorer 重启等情况下托盘可能失效，定期确认并在失效时留痕
  if (!global.__vlTrayProbe) {
    global.__vlTrayProbe = setInterval(() => {
      try {
        if (!tray || tray.isDestroyed()) {
          runLog.sys('app.timing', '托盘对象已失效（isDestroyed）', {});
          clearInterval(global.__vlTrayProbe); global.__vlTrayProbe = null;
        }
      } catch (e) {}
    }, 30000);
  }
}
// 自绘托盘菜单窗口：皮肤变量从主窗口实时读取注入（单一来源，避免皮肤定义重复漂移）；高度按内容自适应，锚定托盘图标上方弹出，失去焦点自动收起
let trayMenuWin = null;
const TRAY_MENU_W = 200;
function hideTrayMenu() { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); }
async function showTrayMenu() {
  const fresh = !trayMenuWin || trayMenuWin.isDestroyed();
  if (fresh) {
    // ⚠ 不用透明窗口（transparent）：Windows 上每次 show 都要重新合成，会闪一帧。
    //   用不透明窗口 + 系统圆角（Win11 默认 roundedCorners）：窗口背景色在注入皮肤变量后用 setBackgroundColor 对齐 --bg-base-default，圆角外不会露出杂色。
    trayMenuWin = new BrowserWindow({ width: TRAY_MENU_W, height: 60, show: false, frame: false, transparent: false, roundedCorners: true, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    trayMenuWin.setMenu(null);
    trayMenuWin.loadFile(path.join(__dirname, 'frontend', 'trayMenu.html'));
    trayMenuWin.on('blur', () => { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); });
    trayMenuWin.on('closed', () => { trayMenuWin = null; });
    // 等 ready-to-show（首帧已绘制）而非 did-finish-load：后者只代表文档加载完，此时 show 会先出现空白/半透明窗再刷出内容
    await new Promise((res) => { const t = setTimeout(res, 300); trayMenuWin.webContents.once('ready-to-show', () => { clearTimeout(t); res(); }); });
  }
  // 注入当前皮肤变量（从主窗口 computed style 读取，与界面完全一致）
  try {
    const cssText = await mainWin.webContents.executeJavaScript(`(function(){
      var s=getComputedStyle(document.documentElement);
      var names=['--bg-base-default','--text-default','--text-secondary','--border-neutral-l1','--bg-overlay-l2','--radius-6','--radius-8','--body-base-font-size'];
      var p=names.map(function(n){var v=s.getPropertyValue(n).trim();return v?(n+':'+v):null;}).filter(Boolean).join(';');
      return p;
    })()`);
    if (cssText) {
      await trayMenuWin.webContents.executeJavaScript("document.getElementById('skinVars').textContent=':root{" + cssText + "}';");
      // 窗口不透明：取皮肤的 --bg-base-default 作为窗口背景色，使圆角外的矩形角落与菜单底色一致（否则会露出默认白/黑角）
      const mBg = /--bg-base-default:\s*([^;]+)/.exec(cssText);
      if (mBg) { try { trayMenuWin.setBackgroundColor(mBg[1].trim()); } catch (e) {} }
    }
  } catch (e) {}
  // 检查更新项仅 UPDATE_ENABLED 时显示
  const updJs = "(function(){var on=" + (UPDATE_ENABLED ? 'true' : 'false') + ";var b=document.getElementById('btnUpdate'),s=document.getElementById('sepUpdate');if(b)b.style.display=on?'':'none';if(s)s.style.display=on?'':'none';})();";
  try { await trayMenuWin.webContents.executeJavaScript(updJs); } catch (e) {}
  // 高度按内容自适应（避免固定高裁切/留白）
  try {
    const h = await trayMenuWin.webContents.executeJavaScript("document.getElementById('trayMenu').offsetHeight");
    trayMenuWin.setContentSize(TRAY_MENU_W, Math.max(50, Number(h) || 50));
  } catch (e) {}
  // 定位：以鼠标指针为锚点，菜单从鼠标右上紧贴弹出（右边界贴 x、下边界贴 y）；钳制按整屏 bounds（允许覆盖任务栏区域），越界时再就近收拢
  let mx = 0, my = 0;
  try { const c = screen.getCursorScreenPoint(); mx = c.x; my = c.y; } catch (e) {}
  const disp = screen.getDisplayNearestPoint({ x: mx, y: my });
  const bd = disp.bounds;
  const [w, h] = trayMenuWin.getSize();
  let x = mx;                 // 默认从鼠标向右展开
  let y = my - h;             // 菜单底部贴住鼠标（弹出在鼠标上方）
  if (x + w > bd.x + bd.width) x = bd.x + bd.width - w; // 右侧越界改向左收拢
  if (x < bd.x) x = bd.x;
  if (y < bd.y) y = bd.y;
  trayMenuWin.setPosition(Math.round(x), Math.round(y));
  // ⚠ 关键：上面刚注入皮肤变量、显隐「检查更新」项、setContentSize 都改动了 DOM 与窗口尺寸 ——
  //   ready-to-show 给的"首帧"当场作废（切换皮肤后第一次尤其明显），故此处统一等资源就绪 + 重绘再显示。
  await waitForWindowContent(trayMenuWin);
  trayMenuWin.show();
  trayMenuWin.focus();
}
// 视频处理工具窗口：独立于主窗口的**非模态**窗口（可与主窗口并排、同时操作；关掉窗口不影响正在跑的任务；任务结果回主窗口任务列表查看）
let toolWin = null;
function createToolWindow() {
  // 复用已有窗口：关闭时只 hide 不销毁，这里需显式 show 回前台（focus 不会让隐藏窗口出现）
  if (toolWin && !toolWin.isDestroyed()) { try { if (!toolWin.isVisible()) toolWin.show(); } catch (e) {} toolWin.focus(); return toolWin; }
  // 尺寸=主窗口（1360×860）同比例缩小到 0.75：1020×645 —— 一眼看出是同一套界面的小窗
  toolWin = new BrowserWindow({
    title: IS_PREVIEW ? 'Video Lab Preview - 视频处理' : 'Video Lab - 视频处理', width: 1020, height: 645, minWidth: 760, minHeight: 520,
    resizable: true, frame: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (mainWin && !mainWin.isDestroyed()) {
    const pb = mainWin.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: Math.round(pb.x + pb.width / 2), y: Math.round(pb.y + pb.height / 2) }).workArea;
    const x = Math.max(wa.x, Math.round(pb.x + (pb.width - 1020) / 2));
    const y = Math.max(wa.y, Math.round(pb.y + (pb.height - 645) / 2));
    toolWin.setPosition(Math.min(x, wa.x + wa.width - 1020), Math.min(y, wa.y + wa.height - 645));
  }
  // 首帧就绪后再显示（与主窗口一致）：避免「先出现空白窗、再刷出内容」的闪烁观感
  toolWin.once('ready-to-show', async () => { await waitForWindowContent(toolWin); try { if (toolWin && !toolWin.isDestroyed()) { toolWin.show(); toolWin.focus(); } } catch (e) {} });
  toolWin.loadFile(path.join(__dirname, 'frontend', 'tool.html'));
  // 关闭只隐藏、不销毁：重建需重新加载整套皮肤资源（女仆皮肤 64KB CSS + 1.7MB 图片），hide 复用后再次打开瞬时显示。
  // 仅在应用真正退出（isQuitting）时才允许销毁。
  toolWin.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    try { toolWin.hide(); } catch (err) {}
  });
  toolWin.on('closed', () => { toolWin = null; });
  return toolWin;
}
// 任务窗口：显示所有生成任务的状态与实时日志
let taskWin = null;
function createTaskWindow() {
  // 复用已有窗口：同工具窗，需显式 show 回前台
  if (taskWin && !taskWin.isDestroyed()) { try { if (!taskWin.isVisible()) taskWin.show(); } catch (e) {} taskWin.focus(); return taskWin; }
  taskWin = new BrowserWindow({ title: IS_PREVIEW ? 'Video Lab Preview - 任务' : 'Video Lab - 任务', width: 760, height: 620, resizable: false, maximizable: false, minimizable: false, frame: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  // 首帧就绪后再显示：避免「先出现空白窗、再刷出内容」的闪烁观感
  taskWin.once('ready-to-show', async () => { await waitForWindowContent(taskWin); try { if (taskWin && !taskWin.isDestroyed()) { taskWin.show(); taskWin.focus(); } } catch (e) {} });
  taskWin.loadFile(path.join(__dirname, 'frontend', 'task.html'));
  // 关闭只隐藏、不销毁（同工具窗）：常开常看，重建要重载整套皮肤资源；应用真正退出时才销毁。
  taskWin.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    try { taskWin.hide(); } catch (err) {}
  });
  taskWin.on('closed', () => { taskWin = null; });
  return taskWin;
}
// 设置面板：在主窗口内以 iframe 显示；打开即显示、关闭仅隐藏。内嵌避免独立窗口每次打开都要重建并重新解码整套皮肤资源（女仆皮肤 64KB CSS + 1.7MB 图片）。
let settingsPanelOpen = false;
function openSettingsWindow() {
  settingsPanelOpen = true;
  // 通知主窗口：显示模糊遮罩 + 内嵌设置页 iframe
  try {
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
      mainWin.webContents.send('settings_window_opened');
    }
    // ⚠ 刻意**不广播**：内嵌设置面板是软件端主窗口的 UI 状态；广播会让浏览器端主页面也弹出设置面板，而浏览器端没有 IPC 通道去关闭它。
    //   浏览器端要用设置页，走它自己的入口（settings.html 本身就是完整页面）。
  } catch (e) {}
  return null;
}
// 关闭设置面板：渲染层「点击面板外 / Esc」调用
function closeSettingsPanel() {
  settingsPanelOpen = false;
  try {
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
      mainWin.webContents.send('settings_window_closed');
    }
    // 同上：与 settings_window_opened 成对，不广播。
  } catch (e) {}
  // 关闭后把主窗口提回前台：面板里可能开过资源管理器（打开日志/选择目录），explorer 会压在 Z 序上方，Windows 激活的常常不是主窗
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      else mainWin.show();
      mainWin.focus();
      if (!mainWin.isFocused()) app.focus({ steal: true });
    }
  } catch (e2) {}
}
// 任务快照变化时推送给所有窗口（主窗口按钮计数 + 任务窗口列表）
function sendTasksToAll() {
  const tasks = api.snapshotTasks();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('task_update', tasks);
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('task_update', tasks);
}
api.onTasksChanged = sendTasksToAll;
// 配置文件写操作（保存/清理/迁移）广播：前端据此即时自愈版本列表、日期分支与侧栏徽章
function sendVersionsChangedToAll() {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('versions_changed');
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('versions_changed', null);
}
api.onVersionsChanged = sendVersionsChangedToAll;

// ═══ 自动更新 ═══ 启动/设置页/托盘触发检查，主窗口提示条由用户确认后下载
// 走 electron-updater：静默升级安装并重启，安装过程不经应用代码。
const UPDATE_ENABLED = true;
const GITHUB_REPO = 'HirannU-OVO/video-lab';
// 国内镜像仓库与 GitHub 同名（仅域名不同）
const GITCODE_REPO = 'HirannU-OVO/video-lab';
const UPDATE_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
// 国内镜像 release 检查地址（API 结构：tag_name + assets[]；读接口匿名可用、无需令牌；⚠ assets 无 size 字段，大小为 0 时须走兜底）
const GITCODE_API_URL = 'https://api.gitcode.com/api/v5/repos/' + GITCODE_REPO + '/releases/latest';
// 当前更新源（跟随设置 update_source，动态切换 GitHub / GitCode）
// ⚠ 设置里遗留的旧源标识一律规范为当前国内源：更新源只认 GitHub 与国内镜像两种，
//   否则这类配置会指向不可用的源、永远收不到新版本。
function currentUpdateSource() {
  return (loadConfig().update_source === 'github') ? 'github' : 'gitcode';
}
// 更新源/更新方式即时落盘：设置页「检查更新」按界面当前选中值执行，
// 避免「切了仓库没保存就检查」时静默沿用旧值（用户看到的与实际的必须一致）。
// 仅接受合法值，非法/缺省不改动 —— 只覆盖这两个字段，其余设置保持原样。
function applyUpdatePref(pref) {
  const cfg = loadConfig();
  let changed = false;
  if (pref && typeof pref === 'object') {
    // 兼容历史值 'gitee'（老配置）：落库统一规范为 'gitcode'
    if (pref.update_source === 'github' || pref.update_source === 'gitcode' || pref.update_source === 'gitee') {
      const next = pref.update_source === 'github' ? 'github' : 'gitcode';
      if (cfg.update_source !== next) { cfg.update_source = next; changed = true; }
    }
    if (pref.update_mode === 'auto' || pref.update_mode === 'notify') {
      if (cfg.update_mode !== pref.update_mode) { cfg.update_mode = pref.update_mode; changed = true; }
    }
  }
  if (changed) {
    saveConfig(cfg);
    Object.assign(config, cfg);
    scheduleDailyUpdateCheck();   // 与 save_settings 保持一致：更新方式变化后重排定时检查
    writeUpdateLog('更新偏好即时生效：source=' + currentUpdateSource() + ' mode=' + (cfg.update_mode === 'auto' ? 'auto' : 'notify'));
  }
  return { ok: true, changed, update_source: currentUpdateSource(), update_mode: cfg.update_mode === 'auto' ? 'auto' : 'notify' };
}
// 根据更新源生成检查地址：GitCode 直连不打加速前缀，GitHub 走原加速链
function updateCheckUrls() {
  if (currentUpdateSource() === 'github') return accelUrls(UPDATE_API_URL);
  return [GITCODE_API_URL];
}
// GitHub 加速前缀链：更新检查与下载按序尝试各加速站，全部不可达最后回退直连；增删/换加速站只需改 UPDATE_PROXIES
const UPDATE_PROXIES = ['https://gh-proxy.com', 'https://gh-proxy.org'];
// setup 安装版 electron-updater 的 generic 发布源（对应 package.json 的 publish.url）
const UPDATE_PUBLISH_URL = 'https://github.com/' + GITHUB_REPO + '/releases/latest/download';
// 目标为 GitHub 官方域名时生成 [加速1, 加速2, …, 直连] 候选列表，其他地址原样返回单元素
function accelUrls(url) {
  if (url && (url.indexOf('https://github.com/') === 0 || url.indexOf('https://api.github.com/') === 0)) {
    const out = UPDATE_PROXIES.map((p) => p + '/' + url);
    out.push(url);
    return out;
  }
  return [url];
}
const APP_VERSION = (function () { try { return require('./package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; } })();
let lastUpdateInfo = null; // 最近一次检查结果（含资产信息，供确认后下载使用）
let updateBusy = false;    // 检查/下载互斥锁：同一时刻仅允许一个更新操作在跑

function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
// 不跨端广播的事件：更新链路（见下方两处调用的说明）
//   · 浏览器端发起检查走 HTTP，结果由返回值给到发起页面（页面自己弹窗）；
//     若把事件也广播回去，浏览器端会重复弹（主页面一个 + 内嵌设置页一个，要关两次）。
const NO_BROADCAST = /^(update_|check_update_result$|settings_window_)/;
function sendToMain(channel, payload) {
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload); } catch (e) {}
  if (!NO_BROADCAST.test(channel) && httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll(channel, payload);
}
function sendToSettings(channel, payload) {
  // 设置已内嵌为主窗口面板：发给设置页的广播直接投递到主窗口
  try { if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) mainWin.webContents.send(channel, payload); } catch (e) {}
  if (!NO_BROADCAST.test(channel) && httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll(channel, payload);
}
// 更新链路日志：不落盘（函数保留为空实现）
function writeUpdateLog(line) {}
// Electron net 请求：走 Chromium 网络栈（跟随系统代理），自动跟随重定向
function netGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ url, method: 'GET', redirect: 'follow' }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch (e2) {} reject(new Error('请求超时')); }, timeoutMs || 15000);
    req.on('response', (res) => {
      const chunks = [];
      const headers = res.headers || {};
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode,
          headers,
          body: Buffer.concat(chunks),
          get(key) { const v = headers[String(key).toLowerCase()]; return Array.isArray(v) ? v[0] : (v == null ? '' : String(v)); }
        });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}
// 检查更新：silent=true 时不打扰（启动自动检查）；notifyMain=false 表示来源为设置页（主窗口不弹「发现新版本」，下载完成后才弹操作条）
async function checkForUpdate(opts) {
  if (!UPDATE_ENABLED) return { ok: false, current: APP_VERSION, latest: '', hasUpdate: false, url: '', size: 0, error: '自动更新已停用', source: currentUpdateSource() };
  const silent = !!(opts && opts.silent);
  const notifyMain = !opts || opts.notifyMain !== false;
  if (updateBusy) {
    const busyInfo = { ok: false, busy: true, current: APP_VERSION, latest: '', hasUpdate: false, url: '', size: 0, error: '已有更新操作进行中，请稍候', source: currentUpdateSource() };
    // 托盘等非静默入口：把「进行中」提示发到主窗口状态栏
    if (!silent && notifyMain) sendToMain('update_error', busyInfo);
    return busyInfo;
  }
  const t0 = Date.now();
  try {
    let res = null;
    let accelErr = '';
    for (const cand of updateCheckUrls()) {
      try {
        res = await netGet(cand, 10000);
        if (res.status === 200) break;
        throw new Error('HTTP ' + res.status);
      } catch (e2) {
        res = null;
        accelErr = (e2 && e2.message) || String(e2);
        writeUpdateLog('检查源不可用：' + cand + ' → ' + accelErr);
      }
    }
    if (!res) throw new Error(accelErr || '检查更新失败');
    const data = JSON.parse(res.body.toString('utf-8'));
    const tagRaw = String(data.tag_name || '');   // 原始 tag（含 v 前缀）—— 拼附件地址必须用它
    const tag = tagRaw.replace(/^v/i, '');        // 纯版本号：用于版本比较与界面展示
    const assets = Array.isArray(data.assets) ? data.assets : [];
    // GitCode / GitHub 均会自动附带源码归档（如 v1.4.6.zip），须排除以免误下载源码包。
    const setupRe = /^Video-Lab-.*-x64-Setup\.exe$/i;
    let asset = assets.find((a) => setupRe.test(String(a.name || ''))) || null;
    // release 资产的 digest 为 sha256:<hex>，作为下载完整性校验依据
    const sha256 = (asset && asset.digest && String(asset.digest).replace(/^sha256:/i, '')) || '';
    const hasUpdate = cmpVersion(tag, APP_VERSION) > 0;
    // assetName：资产原名，下载落地即用它
    const assetName = asset ? String(asset.name || '') : '';
    const info = {
      ok: true, current: APP_VERSION, latest: tag || '', hasUpdate,
      url: asset ? asset.browser_download_url : '',
      size: asset ? asset.size : 0,
      sha256, sha512: '', assetName, error: '',
      // 回执要标明**实际用的**仓库：用户切了源没保存就点检查，界面值已被 applyUpdatePref 落盘，
      // 这里回传它就是"实际走的那个"；不带这个字段，用户无从确认，只能看到一句结论
      source: currentUpdateSource()
    };
    lastUpdateInfo = info;
    writeUpdateLog('检查成功：current=' + APP_VERSION + ' latest=v' + tag + ' hasUpdate=' + hasUpdate + ' (' + (Date.now() - t0) + 'ms)');
    if (hasUpdate) {
      if (asset) {
        // 更新方式=自动检查并下载：发现新版本立即自动下载，不弹「发现新版本」提示条；进度直接走主窗口状态栏，下载完成后再弹「更新并重启」操作条；启动/定时/手动检查均生效
        if (loadConfig().update_mode === 'auto') {
          info.autoDownload = true;
          // 回执要先于自动下载发出：否则设置页一直停在「正在检查更新…」等下载完成
          if (!silent) sendToSettings('check_update_result', info);
          writeUpdateLog('更新方式=自动下载，发现 v' + tag + ' 开始自动下载');
          startUpdate().catch((e) => writeUpdateLog('自动下载异常：' + ((e && e.message) || e)));
          return info;
        }
        if (!silent) sendToSettings('check_update_result', info);
        if (notifyMain) sendToMain('update_available', info);
      } else {
        // 发现新版本但资产不全：同样要回执，否则设置页状态停在「正在检查更新…」不收敛
        if (!silent) sendToSettings('check_update_result', Object.assign({}, info, { noAsset: true }));
      }
    } else {
      if (!silent) sendToSettings('check_update_result', info);
      if (!silent && notifyMain) sendToMain('update_none', info);
    }
    return info;
  } catch (e) {
    const msg = e.message || String(e);
    writeUpdateLog('检查失败：' + msg + ' (' + (Date.now() - t0) + 'ms)');
    const info = { ok: false, current: APP_VERSION, latest: '', hasUpdate: false, url: '', size: 0, error: msg, silent, source: currentUpdateSource() };
    lastUpdateInfo = info;
    if (!silent && notifyMain) { sendToMain('update_error', info); sendToSettings('check_update_result', info); }
    else if (!silent) sendToSettings('check_update_result', info);
    return info;
  }
}
// 下载最新便携包到程序根目录（便携版：用户自行关闭应用后解压覆盖），进度 % 经 onProgress 回报
// 计算文件 sha256（hex 小写），用于下载完整性校验（优先哈希，字节数兜底）
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}
// 计算文件 sha512（base64）—— 与 electron-builder 生成的 latest.yml 里的 sha512 同格式，可直接字符串比对
function sha512Base64File(filePath) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('base64')));
    stream.on('error', reject);
  });
}
let lastDownload = null; // 已下载但未安装的更新包 { zipPath, info }，等待用户二次确认（UPDATE_ENABLED 下使用）

// ═══ setup 安装版更新（electron-updater）═══
// 检测环节复用上方 GitHub API 的 checkForUpdate；下载/安装阶段经 electron-updater：
// 下载时读 resources/app-update.yml（publish provider=generic）→ 拉取 latest.yml → 下载 setup 安装包；安装时 quitAndInstall 静默升级（NSIS /S）后自动重启。仅安装版加载。
function setupUpdater() {
  try { return require('electron-updater').autoUpdater; } catch (e) { return null; }
}
// 选择 setup 更新源：依次探测候选（取 latest.yml，仅数百字节）返回首个可用者，全失败回退直连。
// 仅判断「源是否可用」不校验版本：随后 electron-updater 会用同一源拉 latest.yml 与安装包。
async function pickSetupFeedUrl() {
  const cands = accelUrls(UPDATE_PUBLISH_URL);
  for (const c of cands) {
    try {
      const r = await netGet(c + '/latest.yml', 8000);
      if (r.status === 200 && r.body && /version\s*:/.test(r.body.toString('utf8'))) return c;
      writeUpdateLog('setup 更新源探测未通过：' + c + '（HTTP ' + r.status + '）');
    } catch (e) {
      writeUpdateLog('setup 更新源探测失败：' + c + ' → ' + ((e && e.message) || String(e)));
    }
  }
  return cands[cands.length - 1];
}
// setup 安装版下载：electron-updater 检查并下载 setup 安装包（调用方 startUpdate 负责互斥锁与已下载复用）
async function runSetupStartUpdate() {
  const au = setupUpdater();
  if (!au) return { ok: false, error: '未加载 electron-updater 模块' };
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  try {
    au.removeAllListeners('download-progress');
    au.removeAllListeners('update-downloaded');
    au.removeAllListeners('error');
  } catch (e) {}
  au.on('download-progress', (p) => {
    const percent = Math.min(100, Math.max(0, Math.round((p && p.percent) || 0)));
    const latestInfo = (au.updateInfoAndProvider && au.updateInfoAndProvider.result) ? au.updateInfoAndProvider.result.version : '';
    sendToMain('update_downloading', { percent, bytesPerSecond: p && p.bytesPerSecond, current: APP_VERSION, latest: latestInfo });
  });
  au.on('update-downloaded', () => {});
  au.on('error', (e) => { writeUpdateLog('electron-updater: ' + (e && e.message)); sendToMain('update_error', { message: e && e.message }); });
  // 更新源取探测出的可用加速地址（全不可用时回退直连），latest.yml 与安装包都经它拉取（generic 源）
  try {
    const feedUrl = await pickSetupFeedUrl();
    au.setFeedURL({ provider: 'generic', url: feedUrl });
    writeUpdateLog('setup 更新源：' + feedUrl);
  } catch (ef) {
    writeUpdateLog('setup 设置加速更新源失败（继续使用默认源）：' + ((ef && ef.message) || String(ef)));
  }
  try {
    const r = await au.checkForUpdates();
    const latest = r && r.updateInfo ? String(r.updateInfo.version || '') : '';
    writeUpdateLog('setup 检查：latest=' + latest + ' current=' + APP_VERSION);
    if (!latest || cmpVersion(latest, APP_VERSION) <= 0) {
      sendToMain('update_none', { current: APP_VERSION, latest });
      return { ok: false, error: '暂无可用更新' };
    }
    await au.downloadUpdate();
    lastDownload = { zipPath: au.downloadedUpdateFilePath || '', info: { current: APP_VERSION, latest } };
    writeUpdateLog('setup 更新包下载完成：v' + latest);
    sendToMain('update_downloaded', { ok: true, current: APP_VERSION, latest });
    return { ok: true, downloaded: true };
  } catch (e) {
    const m = (e && e.message) || String(e);
    writeUpdateLog('setup 更新失败：' + m);
    sendToMain('update_error', { message: '下载更新失败：' + m });
    return { ok: false, error: m };
  }
}
function setupApplyUpdate() {
  const au = setupUpdater();
  if (!au) return { ok: false, error: '未加载 electron-updater 模块' };
  sendToMain('update_ready', { current: APP_VERSION });
  try {
    au.autoInstallOnAppQuit = true;
    isQuitting = true;
    au.quitAndInstall();
    return { ok: true };
  } catch (e) {
    writeUpdateLog('quitAndInstall 失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

// 用户点击「立即更新」：仅下载更新包（两步式第一步，需 UPDATE_ENABLED）。统一互斥：同一时刻仅一个下载；已有下载完成的更新包直接复用不重复下载
async function startUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  if (lastDownload) {
    sendToMain('update_downloaded', lastDownload.info || { ok: true, current: APP_VERSION });
    return { ok: true, downloaded: true };
  }
  if (updateBusy) return { ok: false, busy: true, error: '已有更新操作进行中，请稍候' };
  updateBusy = true;
  try {
    sendToMain('update_downloading', Object.assign({}, lastUpdateInfo || {}, { percent: 0 }));
    sendToMain('update_status', '正在连接更新服务器…');
    return await runSetupStartUpdate();
  } finally {
    updateBusy = false;
  }
}
// 用户点击「立即安装」（需 UPDATE_ENABLED）：electron-updater 静默升级安装并重启。
async function applyUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  if (!IS_PORTABLE) return setupApplyUpdate(); // setup 安装版：electron-updater 静默升级安装并重启
  return { ok: false, error: '更新文件已就绪，请关闭应用后手动安装' };
}

// HTTP 服务器 extraRoutes：涉及 main.js 内部状态（config/loadConfig/saveConfig 等）的路由
// 浏览器侧请求这些路由时，复用与 ipcMain handler 相同的逻辑
function buildHttpExtraRoutes() {
  return {
    // ── agent 友好接口：只读运行日志与环境上下文，不改动现有接口 ──
    // 读运行日志：任务记录/标记/成片都可能被清除，运行日志是事后唯一证据
    get_runlog: (args) => {
      const o = (args && args[0]) || {};
      if (o.list) return { ok: true, dir: runLog.getDir(), files: runLog.listDays() };
      return runLog.readDay(o.date, o);
    },
    // 一次拿全环境上下文，省去 agent 多次探测 ⚠ 整体走异步（env 用 checkEnvAsync）：同步探测会阻塞事件循环数十秒
    get_app_info: async () => {
      const c = loadConfig();
      const t = (() => { try { return api.listTools(); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })();
      const enginesDir = resolveEnginesDir();
      const ready = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
      const env = await api.checkEnvAsync().catch(() => null);
      return {
        ok: true,
        app: IS_PREVIEW ? 'Video Lab Preview' : 'Video Lab',
        version: app.getVersion(),
        form: IS_PORTABLE ? 'portable' : 'installed',
        autostart: IS_AUTOSTART,
        storageDir: storageDir(),
        enginesDir,
        configPath: configFilePath(),
        logDir: runLog.getDir(),
        root: api.getRoot(),
        skin: c.skin || '',
        http: { url: httpUrl(), port: parseInt(c.http_port, 10) || DEFAULT_HTTP_PORT },
        env: env,
        modules: [
          { id: 'batch', ready: ready(path.join(enginesDir, 'modules', 'batch', 'index.js')) },
          { id: 'mask', ready: ready(path.join(enginesDir, 'modules', 'mask', 'index.js')) },
          { id: 'replica', ready: ready(path.join(enginesDir, 'modules', 'replica', 'index.js')) },
          { id: 'tool', ready: ready(path.join(enginesDir, 'tools', 'module.js')) },
        ],
        tools: t && t.ok ? { steps: t.stepCount, engine: t.engine } : { error: (t && t.error) || '不可用' },
      };
    },
    // 接口清单：**由路由表 + preload 自动生成**，新增通道无需登记
    get_api_index: () => {
      const info = httpServerInfo || {};
      const channels = (typeof info.channelIndex === 'function') ? info.channelIndex() : [];
      let uiChannels = [], events = [];
      try {
        const src = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
        const si = new Set(), se = new Set();
        for (const m of src.matchAll(/invoke\('([a-z0-9_]+)'/g)) if (!si.has(m[1])) { si.add(m[1]); uiChannels.push(m[1]); }
        for (const m of src.matchAll(/ipcRenderer\.on\('([a-z0-9_]+)'/g)) if (!se.has(m[1])) { se.add(m[1]); events.push(m[1]); }
      } catch (e) {}
      return {
        ok: true,
        http: { url: httpUrl() },
        count: channels.length,
        channels,
        uiChannels: uiChannels.sort(),
        events: events.sort(),
        notes: 'POST /api/<channel>，body 为 JSON 数组（参数按序）；需 token（?token= 或 X-Token 头）；返回 {ok, data} 或 {ok:false, error}',
      };
    },

    get_settings: () => {
      const c = loadConfig();
      return {
        skin: c.skin,
        batch: Object.assign({}, DEFAULT_CONFIG.batch, c.batch),   // 含批量模式的工作目录 batch.root
        replica: Object.assign({}, DEFAULT_CONFIG.replica, c.replica),
        mask: Object.assign({}, DEFAULT_CONFIG.mask, c.mask),
        auto_check_update: c.auto_check_update !== false,
        check_update_daily: c.check_update_daily === true,
        check_update_hour: (() => { const h = parseInt(c.check_update_hour, 10); return (h >= 0 && h <= 23) ? h : 9; })(),
        update_source: c.update_source === 'github' ? 'github' : 'gitcode',
        update_mode: c.update_mode === 'auto' ? 'auto' : 'notify',
        // 数据目录固定 appdata，不向前端暴露 config_storage（设置页无此项）
        config_path_appdata: path.dirname(appdataConfigPath()),
        autostart: c.autostart === true,
        close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
        http_port: parseInt(c.http_port, 10) || DEFAULT_HTTP_PORT,
        http_token: String(c.http_token || ''),
        http_url: httpUrl(),
        log_dir: runLog.getDir(),
        cache_keep_days: (() => { const n = parseInt(c.cache_keep_days, 10); return Number.isFinite(n) && n >= 0 ? n : 30; })(),
        cache_info: (() => { try { return api.cacheInfo(); } catch (e) { return {}; } })(),
        notify_task_end: c.notify_task_end !== false,
        backup_dir: String(c.backup_dir || ''),
        backup_auto_clean: c.backup_auto_clean === true,
        backup_keep_days: parseInt(c.backup_keep_days, 10) || 7,
        backup_dir_effective: String(c.backup_dir || '').trim()
          || require('path').join(storageDir(), 'backup'),   // 占位符直接显示实际默认地址
        backup_root_effective: api.getBackupRoot(),   // 备份实际落盘根（自定义目录时含「Video Lab 备份」层）
      };
    },
    save_settings: (args) => {
      const s = args[0];
      const cfg = loadConfig();
      const prevBackupDir = String(cfg.backup_dir || '').trim();   // 变更前值：用于备份目录迁移
      // 数据目录固定 appdata，没有「切换保存位置」（config_moved 恒为 false，保留字段兼容前端）
      if (s && typeof s === 'object') {
        // 工作路径在 batch.root（见下方 batch 分支），不从顶层 s.root 取
        if (isValidSkin(s.skin)) cfg.skin = s.skin.trim();   // 非法主题 id 直接忽略（见 SKIN_IDS 注释）
        if (typeof s.auto_check_update === 'boolean') cfg.auto_check_update = s.auto_check_update;
        if (typeof s.check_update_daily === 'boolean') cfg.check_update_daily = s.check_update_daily;
        if (s.check_update_hour !== undefined && s.check_update_hour !== null) { const h = parseInt(s.check_update_hour, 10); if (h >= 0 && h <= 23) cfg.check_update_hour = h; }
        if (typeof s.autostart === 'boolean') cfg.autostart = s.autostart;
      mergeAppSettings(cfg, s);   // 与软件端 IPC 路径共用同一份合入逻辑
        if (s.close_behavior === 'exit' || s.close_behavior === 'tray') cfg.close_behavior = s.close_behavior;
        if (s.update_source === 'github' || s.update_source === 'gitcode' || s.update_source === 'gitee') cfg.update_source = s.update_source === 'github' ? 'github' : 'gitcode';
        if (s.update_mode === 'auto' || s.update_mode === 'notify') cfg.update_mode = s.update_mode;
        if (s.http_port !== undefined && s.http_port !== null) { const p = parseInt(s.http_port, 10); if (p > 0 && p < 65536) cfg.http_port = p; }
        if (typeof s.http_token === 'string') { const tk = s.http_token.trim(); if (tk.length >= 8 && tk.length <= 64) cfg.http_token = tk; }
        if (s.batch && typeof s.batch === 'object') {
          const prevRoot = getBatchRoot(cfg);
          cfg.batch = Object.assign({}, DEFAULT_CONFIG.batch, s.batch);
          // 同步顶层 root 兼容镜像；空值不得覆盖已有工作路径
          setBatchRoot(cfg, getBatchRoot(cfg) || prevRoot);
        }
        if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
        if (s.mask && typeof s.mask === 'object') cfg.mask = Object.assign({}, DEFAULT_CONFIG.mask, s.mask);
      }
      saveConfig(cfg);   // 只写实际变更的键：settings.db（唯一读取来源）+ config.json（旧版本兼容快照）
      Object.assign(config, cfg);
      // 端口/令牌实际变更才重启 HTTP 服务器（重启会断开浏览器既有 SSE 连接）；皮肤等其它设置变更保留连接，settings_saved 广播可即时送达浏览器，无需手动刷新
      const httpPortWanted = parseInt(cfg.http_port, 10) || DEFAULT_HTTP_PORT;
      const httpTokenWanted = String(cfg.http_token || '').trim();
      if (httpServerInfo && httpServerInfo.close && (httpServerInfo.port !== httpPortWanted || httpServerInfo.token !== httpTokenWanted)) {
        try { httpServerInfo.close(); } catch (e) {}
        httpServerInfo = null;
      }
      if (!httpServerInfo) restartHttpServer();
      scheduleDailyUpdateCheck();
      api.updateSettings(cfg);
      // 备份目录实际变更：把旧目录里已有的备份迁移到新目录（异步执行，不阻塞保存返回）
      const nextBackupDir = String(cfg.backup_dir || '').trim();
      if (nextBackupDir !== prevBackupDir) {
        try { api.migrateBackups(prevBackupDir, nextBackupDir); } catch (e) {}
      }
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', cfg);
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', cfg);
      return { ok: true, config_moved: false };   // 数据目录写死，不存在「切换后已搬迁」这回事
    },
    save_guide: (args) => {
      const s = args[0];
      const root = s && typeof s.root === 'string' ? s.root.trim() : '';
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, error: '路径无效或不存在' };
      setBatchRoot(config, root); saveConfig(config); api.setRoot(root);
      return { ok: true, root };
    },
    get_skin: () => String(config.skin || 'white_blue'),
    set_skin: (args) => { const v = String(args[0] || '').trim(); if (isValidSkin(v)) config.skin = v; saveConfig(config); return config.skin; },
    get_changelog_popup: () => {
      try {
        const cfg = loadConfig();
        if (String(cfg.last_changelog_version || '') === APP_VERSION) return { ok: true, show: false };
        const r = api.getChangelog();
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取更新日志失败' };
        // 此处不写 last_changelog_version：标记由前端在弹窗关闭时经 ack_changelog_popup 回写，
        // 避免「静默启动时主窗口 JS 已执行但用户没看到弹窗」就把展示机会消耗掉
        return { ok: true, show: true, content: r.content };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    ack_changelog_popup: () => {
      try {
        const cfg = loadConfig();
        cfg.last_changelog_version = APP_VERSION;
        saveConfig(cfg);
        try { Object.assign(config, cfg); } catch (e) {}
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
            get_app_version: () => APP_VERSION,
    // 数据目录清理（HTTP 侧同样开放，便于浏览器与脚本调用；扫描为只读，清理一律进回收站）
    data_dir_scan: () => api.dataDirScan(),
    // HTTP 侧参数是「按位置展开的数组」→ 键清单须写成 [["a","b"]]；也接受直白的 ["a","b"]
    // （否则 args[0] 拿到字符串 → Array.isArray 不成立 → 静默清 0 项）。两种写法都接受，宁可容错，不要静默失败。
    data_dir_clean: (args) => api.dataDirClean(
      Array.isArray(args) && Array.isArray(args[0]) ? args[0] : args),
    // 返回带 token 的浏览器访问地址（含真实 token）；HTTP 侧需要自身已带 token 才能调用（本机防护），
    // Electron 本体侧 ipcMain 无需 token —— 用于设置页/开发测试获取链接
    get_browser_url: () => {
      const url = httpUrl();
      return url ? { ok: true, url } : { ok: false, error: 'HTTP 服务未就绪' };
    },
    check_update: (args) => {
      // 浏览器端发起：结果由返回值给到发起页面（自己弹窗），不通知软件端主窗口 —— 否则浏览器端点一下，软件端也会弹一个（跨端串扰）。
      const silent = !!args[0];
      return checkForUpdate({ silent: silent, notifyMain: false });
    },
    // 浏览器侧同样支持「检查更新前先让更新源/方式即时生效」（与 IPC 路径共用同一处理函数）
    apply_update_pref: (args) => applyUpdatePref(args[0]),
    respond_discard_config: (args) => {
      // 浏览器侧响应未保存确认：简化处理（浏览器侧无关闭流程，直接返回成功）
      return { ok: true };
    },
    choose_close_behavior: (args) => {
      // 浏览器侧无关闭行为选择，返回不支持
      return { ok: false, error: '浏览器侧不支持' };
    },
  };
}

function registerIpc() {
  // ★ Windows 通知点击 → 置前主窗口并定位到该任务。
  // 复用既有的 locate_task 链路（api.taskLocate + locate_request 推送），
  // 不另造一套定位协议 —— 那样两处行为迟早会漂移。
  try {
    api._noticeActivateHandler = (taskId) => {
      try { showMainWindow(); } catch (e) {}
      if (!taskId) return;
      try {
        const info = api.taskLocate(taskId);
        if (!info || !info.ok) return;
        const payload = Object.assign({}, info, { target: 'config', taskId });
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('locate_request', payload);
        if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('locate_request', payload);
      } catch (e) {}
    };
  } catch (e) {}
  // ⚠ 走异步版：同步版会 walkFiles + 逐文件 contentHash 占死事件循环数十秒（冷启动）
  ipcMain.handle('list_projects', (e, force) => api.listProjectsAsync(!!force));
  ipcMain.handle('list_versions', (e, project, name, force) => api.listVersions(project, name, force));
  ipcMain.handle('read_config', (e, p) => api.readConfig(p));
  ipcMain.handle('save_config', (e, p, folders, excludes, watermark, newName) => api.saveConfig(p, folders, excludes, watermark, newName));
  ipcMain.handle('save_config_today', (e, project, name, configName, folders, excludes, watermark) => api.saveConfigToday(project, name, configName, folders, excludes, watermark));
  ipcMain.handle('new_empty_config', (e, project) => api.newEmptyConfig(project));
  // 项目增删改（软件侧新建 / 改名）：kind = 'batch' | 'mask'，缺省按 batch
  ipcMain.handle('create_project', (e, name, kind) => api.createProject(name, kind));
  ipcMain.handle('rename_project', (e, oldName, newName, kind) => api.renameProject(oldName, newName, kind));
  ipcMain.handle('remove_branch', (e, p, scope) => api.removeBranch(p, scope));
  ipcMain.handle('branch_other_txt', (e, p) => api.branchOtherTxt(p));
  ipcMain.handle('precheck', (e, paths, excludes) => api.precheck(paths, excludes));
  // 预检测重建/刷新的进度：发给调用方 + **所有窗口**（主界面状态栏有迷你进度条）——
  // ⚠ 必须广播到所有窗口：只在设置页点「维护-重建」时，若只发 sender，主界面收不到任何进度。
  const broadcastResetProgress = (sender, s) => {
    try { if (sender) sender.send('reset_progress', s); } catch (err) {}
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('reset_progress', s); } catch (err) {} }
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('reset_progress', s);
  };
  ipcMain.handle('reset_precheck', (e) => { const sender = e.sender; return api.resetPrecheck((s) => broadcastResetProgress(sender, s)); });
  // 仅刷新预缓存：不删缓存，只对缺失/变化的视频增量更新（与重置同通道回报进度）
  ipcMain.handle('refresh_precache', (e) => { const sender = e.sender; return api.refreshPrecache((s) => broadcastResetProgress(sender, s)); });
  ipcMain.handle('clean_video_cache', (e) => api.cleanVideoCache());
  ipcMain.handle('cache_info', () => api.cacheInfo());
  ipcMain.handle('cache_stats', () => api.cacheStats());
  ipcMain.handle('clean_caches', () => api.cleanCaches());
  ipcMain.handle('data_dir_scan', () => api.dataDirScan());                    // A6 数据目录清理：扫描可清项
  ipcMain.handle('data_dir_clean', (e, keys) => api.dataDirClean(keys));       // A6 数据目录清理：执行（进回收站）
  ipcMain.handle('list_logs', (e, project, name, versionPath) => api.listLogs(project, name, versionPath));
  ipcMain.handle('search_logs', (e, query) => api.searchLogs(query));
  ipcMain.handle('get_log_content', (e, fromPath, configName) => api.logContent(fromPath, configName));
  ipcMain.handle('list_log_files', (e, fromPath, configName) => api.listLogFiles(fromPath, configName));
  ipcMain.handle('find_replica_output', (e, logPath, videoName) => api.findReplicaOutput(logPath, videoName));
  ipcMain.handle('check_exists', (e, paths) => api.checkExists(paths));
  ipcMain.handle('check_watermark_project', (e, project, wm) => api.checkWatermarkProject(project, wm));
  ipcMain.handle('find_watermark_project', (e, project, wm) => api.findWatermarkProject(project, wm));
  ipcMain.handle('get_project_watermark', (e, project) => api.getProjectWatermark(project));
  ipcMain.handle('set_project_watermark', (e, project, wm, enabled, applyToAll, group, groupEnabled) => api.setProjectWatermark(project, wm, enabled, applyToAll, group, groupEnabled));
  ipcMain.handle('run_batch', (e, p, count, group) => api.runBatch(p, count, group));
  ipcMain.handle('run_replica', (e, logPath, mode, entryVideo, opts) => api.runReplica(logPath, mode, entryVideo, opts));
  ipcMain.handle('continue_replica', (e, taskId) => api.continueReplica(taskId));
  ipcMain.handle('list_tasks', () => api.snapshotTasks());
  ipcMain.handle('locate_task', (e, taskId, target) => {
    const info = api.taskLocate(taskId);
    if (!info || !info.ok) return info;
    showMainWindow();
    const payload = Object.assign({}, info, { target: target === 'log' ? 'log' : 'config', taskId });
    try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('locate_request', payload); } catch (err) {}
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('locate_request', payload);
    return info;
  });
  // 复刻任务「打开成片文件夹」：打开复刻产物目录（月份/MMdd/模式目录），未生成时报错
  ipcMain.handle('open_replica_output', async (e, taskId) => {
    const r = api.taskReplicaOutputDir(taskId);
    if (!r.ok) return r;
    const err = await shell.openPath(r.dir);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // 复刻任务成片目录只读探测（供前端打开前判定按钮可用性，避免点击后再弹窗）
  ipcMain.handle('task_replica_outdir', (e, taskId) => api.taskReplicaOutputDir(taskId));
  ipcMain.handle('stop_task', (e, id) => api.stopTask(id));
  ipcMain.handle('rerun_task', (e, id) => api.rerunTask(id));
  ipcMain.handle('pin_task', (e, id) => api.pinTask(id));
  ipcMain.handle('reorder_tasks', (e, ids) => api.reorderTasks(ids));
  ipcMain.handle('pause_task', (e, id) => api.pauseTask(id));
  ipcMain.handle('resume_task', (e, id) => api.resumeTask(id));
  ipcMain.handle('clear_finished_tasks', (e, statuses) => api.clearFinishedTasks(statuses));
  ipcMain.handle('clear_done_tasks', (e, opts) => api.clearDoneTasks(opts || {}));
  ipcMain.handle('get_changelog', () => api.getChangelog());
  ipcMain.handle('get_readme', () => api.getReadme());
  ipcMain.handle('get_about_info', () => api.getAboutInfo());   // 关于页 · 运行环境与组件信息
  // 启动弹更新日志：仅当配置里记录的上次展示版本与当前版本不同（含初次启动 / 版本更新后）才返回内容。
  // 标记（last_changelog_version）改由前端在弹窗关闭时经 ack_changelog_popup 回写，
  // 避免「静默到托盘启动时主窗口 JS 已执行、用户却没看到弹窗」白白消耗掉展示机会
  ipcMain.handle('get_changelog_popup', () => {
    try {
      const cfg = loadConfig();
      if (String(cfg.last_changelog_version || '') === APP_VERSION) return { ok: true, show: false };
      const r = api.getChangelog();
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取更新日志失败' };
      return { ok: true, show: true, content: r.content };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('ack_changelog_popup', () => {
    try {
      const cfg = loadConfig();
      cfg.last_changelog_version = APP_VERSION;
      saveConfig(cfg);
      try { Object.assign(config, cfg); } catch (e) {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('clear_task', (e, id) => api.clearTask(id));
  ipcMain.handle('regroup_task', (e, id, groupCount) => api.regroupTask(id, groupCount));
  ipcMain.handle('resume_all_tasks', () => api.resumeAllTasks());
  ipcMain.handle('pause_all_tasks', () => api.pauseAllTasks());
  ipcMain.handle('confirm_quit', () => { quitConfirmed = true; app.quit(); return { ok: true }; });
  // 关闭主窗口行为：主窗口弹窗选择结果（exit=退出软件 / tray=最小化至托盘）；勾选"不再提醒"则持久化下次直接生效
  ipcMain.handle('choose_close_behavior', (e, behavior, skipReminder) => {
    closeAskOpen = false;
    const b = behavior === 'exit' ? 'exit' : 'tray';
    config.close_behavior = b;
    if (skipReminder) config.close_behavior_skip = true;
    saveConfig(config);
    if (b === 'exit') { isQuitting = true; quitConfirmed = false; app.quit(); }
    else if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
    return { ok: true };
  });
  ipcMain.handle('open_task_window', () => { createTaskWindow(); return { ok: true }; });
  // 视频处理工具（第 4 个模块）：独立窗口 / 步骤 schema / 建任务 / 参数记忆 / 重新执行
  ipcMain.handle('open_tool_window', () => { createToolWindow(); return { ok: true }; });
  ipcMain.handle('list_tools', () => api.listTools());
  ipcMain.handle('run_tool', (e, spec) => api.runTool(spec));
  ipcMain.handle('get_tool_prefs', () => api.getToolPrefs());
  ipcMain.handle('save_tool_prefs', (e, prefs) => api.saveToolPrefs(prefs));
  ipcMain.handle('rerun_tool_task', (e, id) => api.rerunToolTask(id));
  // 画布合成（竖转横）：单帧预览与参数预设（预览与批量执行共用同一滤镜链构造，见 engines/tools/canvas-plan.js）
  ipcMain.handle('canvas_preview_frame', (e, payload) => api.canvasPreviewFrame(payload));
  ipcMain.handle('canvas_list_backgrounds', (e, dir) => api.canvasListBackgrounds(dir));
  ipcMain.handle('canvas_list_sources', (e, root, recursive) => api.canvasListSources(root, recursive));
  ipcMain.handle('canvas_preset_list', () => api.canvasPresetList());
  ipcMain.handle('canvas_preset_save', (e, name, params) => api.canvasPresetSave(name, params));
  ipcMain.handle('canvas_preset_delete', (e, name) => api.canvasPresetDelete(name));
  ipcMain.handle('pick_image', async (e, prev) => {
    const w = winOf(e) || mainWin;
    const r = await dialog.showOpenDialog(w || undefined, {
      title: '选择要叠加的图片',
      defaultPath: String(prev || '').trim() || api.getRoot(),
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    return (r.canceled || !r.filePaths || !r.filePaths.length) ? '' : r.filePaths[0];
  });
  // 遮罩叠加（复用主窗口）：任务提交 / 断点续跑 / 项目与素材只读扫描 / 水印文件选择
  ipcMain.handle('run_mask', (e, payload) => api.runMask(payload));
  ipcMain.handle('continue_mask', (e, taskId) => api.continueMask(taskId));
  ipcMain.handle('list_mask_projects', () => api.listMaskProjects());
  ipcMain.handle('list_mask_videos', (e, dir) => api.listMaskVideos(dir));
  ipcMain.handle('list_mask_masks', (e, dir) => api.listMaskMasks(dir));
  ipcMain.handle('scan_mask_raw_dirs', (e, dir) => api.scanMaskRawDirs(dir));
  ipcMain.handle('scan_mask_theme_sig', (e, dir) => api.maskThemeSig(dir));
  ipcMain.handle('list_mask_logs', (e, projectPath) => api.listMaskLogs(projectPath));
  ipcMain.handle('get_mask_session', (e, name) => api.getMaskSession(name));
  ipcMain.handle('save_mask_session', (e, name, data) => api.saveMaskSession(name, data));
  ipcMain.handle('clear_mask_session', (e, name) => api.clearMaskSession(name));
  ipcMain.handle('get_mask_default_dir', (e, name) => api.getMaskDefaultDir(name));
  ipcMain.handle('set_mask_default_dir', (e, name, dir) => api.setMaskDefaultDir(name, dir));
  ipcMain.handle('delete_mask_videos', (e, projectPath, names) => api.deleteMaskVideos(projectPath, names));
  ipcMain.handle('move_mask_out', (e, projectPath, videoName, newDir) => api.moveMaskOut(projectPath, videoName, newDir));
  ipcMain.handle('relocate_mask_out', (e, projectPath, videoName, newDir) => api.relocateMaskOut(projectPath, videoName, newDir));
  ipcMain.handle('delete_mask_log', (e, projectPath, logPath) => api.deleteMaskLog(projectPath, logPath));
  ipcMain.handle('delete_secondary_products', (e, projectPath, maskOutPaths) => api.deleteSecondaryProducts(projectPath, maskOutPaths));
  ipcMain.handle('choose_mask_file', async (e, prev) => {
    const win = mainWin && !mainWin.isDestroyed() ? mainWin : null;
    const r = await dialog.showOpenDialog(win, { title: '选择水印文件', defaultPath: prev || (api.getRoot() || os.homedir()), properties: ['openFile'], filters: [{ name: '视频水印', extensions: ['mov', 'mp4'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  });
  ipcMain.handle('clean_duplicate_star', (e, commit) => api.cleanDuplicateStar(!!commit));
  ipcMain.handle('open_external', async (e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) { const err = await shell.openExternal(url); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '无效链接' }; });
  ipcMain.handle('open_settings_window', () => { openSettingsWindow(); return { ok: true }; });
  // 自绘托盘菜单项点击：动作与原生托盘菜单一致
  ipcMain.handle('tray_menu_click', (e, action) => {
    hideTrayMenu();
    if (action === 'show_main') showMainWindow();
    // 窗口显示统一交给各自的 ready-to-show（首帧就绪才出现）；这里只在「已加载完且被隐藏」时补 show，防止首次打开抢先显示空白窗。
    else if (action === 'open_tasks') { showMainWindow(); const w = createTaskWindow(); if (w && !w.isDestroyed()) { if (w.webContents.isLoading()) w.once('ready-to-show', () => { try { w.show(); w.focus(); } catch (e) {} }); else { w.show(); w.focus(); } } }
    else if (action === 'open_settings') openSettingsWindow();
    else if (action === 'open_tools') { const w = createToolWindow(); if (w && !w.isDestroyed()) { if (w.webContents.isLoading()) w.once('ready-to-show', () => { try { w.show(); w.focus(); } catch (e) {} }); else { w.show(); w.focus(); } } }
    else if (action === 'open_browser') {
      const url = httpUrl();
      if (url) { shell.openExternal(url); return { ok: true }; }
      return { ok: false, error: 'HTTP 服务未就绪（请检查端口/令牌配置）' };
    }
    else if (action === 'check_update') { showMainWindow(); checkForUpdate({ silent: false }); }
    else if (action === 'quit') { isQuitting = true; app.quit(); }
    return { ok: true };
  });
  ipcMain.handle('get_settings', () => {
    const c = loadConfig();
    return {
      skin: c.skin,
      batch: Object.assign({}, DEFAULT_CONFIG.batch, c.batch),   // 含批量模式的工作目录 batch.root
      replica: Object.assign({}, DEFAULT_CONFIG.replica, c.replica),
      mask: Object.assign({}, DEFAULT_CONFIG.mask, c.mask),
      auto_check_update: c.auto_check_update !== false,
      check_update_daily: c.check_update_daily === true,
      check_update_hour: (() => { const h = parseInt(c.check_update_hour, 10); return (h >= 0 && h <= 23) ? h : 9; })(),
      update_source: c.update_source === 'github' ? 'github' : 'gitcode',
      update_mode: c.update_mode === 'auto' ? 'auto' : 'notify',
      // 数据目录固定 appdata，不向前端暴露 config_storage（设置页无此项）
      config_path_appdata: path.dirname(appdataConfigPath()),   // 显示目录（含引导文件与三库）
      log_dir: runLog.getDir(),   // 运行日志目录（设置页「打开文件夹」用；与 HTTP 版 get_settings 对齐）
      cache_keep_days: (() => { const n = parseInt(c.cache_keep_days, 10); return Number.isFinite(n) && n >= 0 ? n : 30; })(),
      cache_info: (() => { try { return api.cacheInfo(); } catch (e) { return {}; } })(),
      notify_task_end: c.notify_task_end !== false,   // 任务通知（默认开启）
      backup_dir: String(c.backup_dir || ''),
      backup_auto_clean: c.backup_auto_clean === true,
      backup_keep_days: parseInt(c.backup_keep_days, 10) || 7,
      backup_dir_effective: String(c.backup_dir || '').trim()
        || path.join(storageDir(), 'backup'),   // 占位符直接显示实际默认地址
      backup_root_effective: api.getBackupRoot(),   // 备份实际落盘根（自定义目录时含「Video Lab 备份」层）
      autostart: c.autostart === true,
      close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
      http_port: parseInt(c.http_port, 10) || DEFAULT_HTTP_PORT,
      http_token: String(c.http_token || ''),
      http_url: httpUrl(),
    };
  });
  // 设置页：保存完整配置，写入 settings.db 并同步内存/后端/主窗口皮肤
  ipcMain.handle('save_settings', (e, s) => {
    const cfg = loadConfig();
    const prevBackupDir = String(cfg.backup_dir || '').trim();   // 变更前值：用于备份目录迁移
    if (s && typeof s === 'object') {
      // 工作路径在 batch.root（见下方 batch 分支），不从顶层 s.root 取
      if (isValidSkin(s.skin)) cfg.skin = s.skin.trim();   // 非法主题 id 直接忽略（见 SKIN_IDS 注释）
      if (typeof s.auto_check_update === 'boolean') cfg.auto_check_update = s.auto_check_update;
      if (typeof s.check_update_daily === 'boolean') cfg.check_update_daily = s.check_update_daily;
      if (s.check_update_hour !== undefined && s.check_update_hour !== null) { const h = parseInt(s.check_update_hour, 10); if (h >= 0 && h <= 23) cfg.check_update_hour = h; }
      if (typeof s.autostart === 'boolean') cfg.autostart = s.autostart;
      if (s.close_behavior === 'exit' || s.close_behavior === 'tray') cfg.close_behavior = s.close_behavior;
      if (s.update_source === 'github' || s.update_source === 'gitcode' || s.update_source === 'gitee') cfg.update_source = s.update_source === 'github' ? 'github' : 'gitcode';
      if (s.update_mode === 'auto' || s.update_mode === 'notify') cfg.update_mode = s.update_mode;
      if (s.http_port !== undefined && s.http_port !== null) { const p = parseInt(s.http_port, 10); if (p > 0 && p < 65536) cfg.http_port = p; }
      if (typeof s.http_token === 'string') { const tk = s.http_token.trim(); if (tk.length >= 8 && tk.length <= 64) cfg.http_token = tk; }
      if (s.batch && typeof s.batch === 'object') {
        const prevRoot = getBatchRoot(cfg);
        cfg.batch = Object.assign({}, DEFAULT_CONFIG.batch, s.batch);
        // 同步顶层 root 兼容镜像；空值不得覆盖已有工作路径
        setBatchRoot(cfg, getBatchRoot(cfg) || prevRoot);
      }
      if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
      if (s.mask && typeof s.mask === 'object') cfg.mask = Object.assign({}, DEFAULT_CONFIG.mask, s.mask);
    }
    mergeAppSettings(cfg, s);   // 应用级设置（含 v2.2.1 新增项）
    saveConfig(cfg);   // 只写实际变更的键：settings.db（唯一读取来源）+ config.json（旧版本兼容快照）
    // 应用开机自启动（openAtLogin + --autostart 静默托盘启动）；开发版不注册，避免污染开发环境
    // 开机自启（预览版不注册）
    try { if (app.isPackaged && !IS_PREVIEW) app.setLoginItemSettings({ openAtLogin: cfg.autostart === true, args: ['--autostart'] }); } catch (e) {}
    Object.assign(config, cfg);
    // 端口/令牌实际变更才重启 HTTP 服务器（重启会断开浏览器既有 SSE 连接）；皮肤等其它设置变更保留连接，settings_saved 广播可即时送达浏览器，无需手动刷新
    const httpPortWanted = parseInt(cfg.http_port, 10) || DEFAULT_HTTP_PORT;
    const httpTokenWanted = String(cfg.http_token || '').trim();
    if (httpServerInfo && httpServerInfo.close && (httpServerInfo.port !== httpPortWanted || httpServerInfo.token !== httpTokenWanted)) {
      try { httpServerInfo.close(); } catch (e) {}
      httpServerInfo = null;
    }
    if (!httpServerInfo) restartHttpServer();
    scheduleDailyUpdateCheck(); // 定时检查设置可能变更：重新安排
    api.updateSettings(cfg);
    // 备份目录实际变更：把旧目录里已有的备份迁移到新目录（异步执行，不阻塞保存返回）
    const nextBackupDir = String(cfg.backup_dir || '').trim();
    if (nextBackupDir !== prevBackupDir) {
      try { api.migrateBackups(prevBackupDir, nextBackupDir); } catch (e) {}
    }
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', cfg);
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', cfg);
    return { ok: true, config_moved: false };   // 数据目录写死，不存在「切换后已搬迁」这回事
  });
      // 返回带 token 的浏览器访问地址（含真实 token）；HTTP 侧需要自身已带 token 才能调用（本机防护），
  // Electron 本体侧 ipcMain 无需 token —— 用于设置页/开发测试获取链接
  ipcMain.handle('get_browser_url', () => {
    const url = httpUrl();
    return url ? { ok: true, url } : { ok: false, error: 'HTTP 服务未就绪' };
  });
  // 设置页：检查更新（仅在自动更新启用时生效，UPDATE_ENABLED=false 时返回停用）。
  // ⚠ notifyMain 必须为 true（默认）：三条入口的结果统一由主窗口弹（index.html 的 #updateResultMask + app.js 的 showUpdateResult）。
  //   设置页是主窗口内的 iframe，自弹浮层会被 .settings-frame 裁切 —— 传 false 会导致软件端【两边都不弹】。
  ipcMain.handle('check_update', (e, silent) => {
    return checkForUpdate({ silent: !!silent });
  });
  // 设置页：更新源/更新方式即时落盘（检查更新前调用，使界面当前选中值立刻生效）
  ipcMain.handle('apply_update_pref', (e, pref) => applyUpdatePref(pref));
  // 主窗口状态栏：当前应用版本号（左下角常驻显示）
  ipcMain.handle('get_app_version', () => APP_VERSION);
  // 手动取消进行中的后台预检测（后端 token 自增即中断旧探测）
  ipcMain.handle('cancel_precheck', () => api.cancelPrecheck());
  // 主窗口提示条：两步式第一步（仅下载，需 UPDATE_ENABLED）
  ipcMain.handle('start_update', () => startUpdate());
  // 主窗口提示条：两步式第二步（安装并重启，需 UPDATE_ENABLED，setup 版使用）
  ipcMain.handle('apply_update', () => applyUpdate());
  // 关闭设置面板（渲染层点击面板外 / Esc 调用）
  ipcMain.handle('close_settings_panel', () => { closeSettingsPanel(); return { ok: true }; });
  // 内嵌面板标题栏的关闭按钮（设置页 / 引导页共用）：按当前打开的面板分派
  ipcMain.handle('close_embed_panel', () => {
    if (guidePanelOpen) closeGuidePanel(); else closeSettingsPanel();
    return { ok: true };
  });
  // 设置页：通用「选择目录」对话框（parent 取调用方窗口；引导面板与主窗口通用）
  let settingsPickingDir = false; // 目录选择中的互斥标记（勿删：pick_directory 依赖它）
  ipcMain.handle('pick_directory', async (e, title, defaultPath) => {
    settingsPickingDir = true;
    try {
      const win = BrowserWindow.fromWebContents(e.sender) || mainWin;
      const result = await dialog.showOpenDialog(win, { title: title || '选择目录', defaultPath: defaultPath || api.getRoot() || defaultRoot() || os.homedir(), properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    } finally { settingsPickingDir = false; }
  });
  ipcMain.handle('pick_save_file', async (e, title, defaultName) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender) || mainWin;
      const r = await dialog.showSaveDialog(win, {
        title: title || '保存到',
        defaultPath: defaultName || ('VideoLab-' + APP_VERSION + '.zip'),
        filters: [{ name: '压缩包', extensions: ['zip'] }]
      });
      return r.canceled || !r.filePath ? '' : r.filePath;
    } catch (e) { return ''; }
  });
  ipcMain.handle('get_root', () => api.getRoot());
  // ⚠ 必须走异步版：同步 checkEnv 会在冷启动时用 spawnSync 阻塞主进程事件循环数十秒
  //（首次加载 200MB+ 未签名 ffmpeg + 安全软件扫描），直接把窗口显示推迟到分钟级
  ipcMain.handle('check_env', () => api.checkEnvAsync());
  // 首次引导面板：保存工作路径
  ipcMain.handle('save_guide', (e, s) => {
    const root = s && typeof s.root === 'string' ? s.root.trim() : '';
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, error: '路径无效或不存在' };
    setBatchRoot(config, root);
    saveConfig(config);
    api.setRoot(root);
    return { ok: true, root };
  });
  ipcMain.handle('choose_workdir', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择工作路径', defaultPath: api.getRoot(), properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, canceled: true };
    const dir = result.filePaths[0];
    setBatchRoot(config, dir); saveConfig(config); api.setRoot(dir);
    return { ok: true, root: dir, projects: await api.listProjectsAsync() };
  });
  ipcMain.handle('get_skin', () => String(config.skin || 'white_blue'));
  ipcMain.handle('set_skin', (e, skin) => { const v = String(skin || '').trim(); if (isValidSkin(v)) config.skin = v; saveConfig(config); return config.skin; });
  // 自愈目录落盘：`api.config` 是构造期浅拷贝（backend 构造里 Object.assign），与顶层 config **不是同一对象**
  // ⚠ ensureFfmpeg 只改 api 侧内存，不显式写库的话下载目录重启即丢，必须在这里回写。
  function persistFfmpegDir(dir) {
    if (!dir) return;
    config.ffmpeg_dir = dir;
    try { saveConfig(config); } catch (e) {}
  }
  // 组件缺失/下载失败才打扰用户：横幅（可点重试）+ 吐司（更醒目，落在当前视野）
  function notifyEnvMissing(env, err) {
    const payload = { missing: (env && env.missing) || [], hasFfmpeg: !!(env && env.ffmpeg), error: err || '' };
    sendToMain('env_fix_available', payload);
    sendToSettings('env_fix_available', payload);
    sendToMain('env_lost', payload);
    sendToSettings('env_lost', payload);
  }
  // FFmpeg 环境自愈：前端点「重新下载」触发；完成/失败广播双窗，成功才落盘 ffmpeg_dir
  // ⚠ 手动重下必须 force：组件**损坏**（文件在但跑不起来，如被杀软替换/隔离）时探测会失败但
  //   downloadNeeded 为 false（探测失败 ≠ 缺失）→ 不 force 会被 skip，用户点了也修不好。
  ipcMain.handle('env_fix_start', async () => {
    const r = await api.ensureFfmpeg({ force: true });
    sendToMain('env_fix_done', r);
    sendToSettings('env_fix_done', r);
    if (r.ok) persistFfmpegDir(r.dir);
    return r;
  });
  // 启动检测 FFmpeg 环境：**确证缺失即静默自动下载**（不弹确认）；
  // 下载进度走状态栏（env_fix_progress，见 api.onFfmpegProgress）；只有下载失败才提示（横幅可重试 + 吐司）。
  function maybeUpgradeFfmpeg() {
    try {
      // ⚠ 内置已就位时一律不下载、不升级：内置是随程序发布的固定版本，不存在「过旧」问题；
      //   数据目录那份遗留会被「清理数据目录」清掉，读不到 _meta.json 会被误判为缺失/过旧 → 触发下载反而占回刚清理的空间。
      if (api.ffmpegBuiltinReady && api.ffmpegBuiltinReady()) return;
      const dir = String(config.ffmpeg_dir || path.join(storageDir(), 'ffmpeg'));
      const markPath = path.join(storageDir(), 'ffmpeg', '_upgrade.json');
      let ver = '';
      try { ver = String((JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8')) || {}).version || ''); } catch (e) {}
      const m = ver.match(/(\d+)\.(\d+)/);
      const major = m ? parseInt(m[1], 10) : 0;
      if (major >= 7) return;   // 7.0+ 的进度行带 elapsed —— 无需升级
      let mark = {};
      try { mark = JSON.parse(fs.readFileSync(markPath, 'utf8')) || {}; } catch (e) {}
      const COOL = 7 * 24 * 3600 * 1000;
      if (mark.at && (Date.now() - Number(mark.at)) < COOL) return;   // 近期已试过（成功或失败）→ 不再重试
      api.ensureFfmpeg({ force: true }).then((r) => {
        try {
          fs.mkdirSync(path.dirname(markPath), { recursive: true });
          fs.writeFileSync(markPath, JSON.stringify({ at: Date.now(), ok: !!(r && r.ok), version: (r && r.version) || '' }));
        } catch (e) {}
        if (r && r.ok) {
          persistFfmpegDir(r.dir);
          const done = { ok: true, auto: true, upgraded: true, dir: r.dir, version: r.version };
          sendToMain('env_fix_done', done);
          sendToSettings('env_fix_done', done);
        }
      }).catch((e) => {
        try {
          fs.writeFileSync(markPath, JSON.stringify({ at: Date.now(), ok: false, error: String((e && e.message) || e) }));
        } catch (e2) {}
        try { writeUpdateLog('FFmpeg 组件静默升级失败：' + String((e && e.message) || e)); } catch (e3) {}
      });
    } catch (e) {}
  }

  // 旧版遗留的**一次性**清理：内置组件就位后，数据目录那份「下载组件」即成为纯遗留（只增不减）。
  // 闸门（三个都满足才动）：内置组件就位 + 环境探测确认内置可用 + 该份不是当前正在用的那一份；清理走回收站。
  function cleanupLegacyFfmpeg(env) {
    try {
      // ⚠ 刻意**不留标记文件**：每轮「没有遗留就跳过」，天然幂等；有标记反而会永久排除将来再出现的遗留。
      if (!api.ffmpegBuiltinReady || !api.ffmpegBuiltinReady()) return;   // 内置不在 → 绝不动那份兜底
      if (!env || env.downloadNeeded) return;                            // 内置不可用 → 同上
      const active = String(env.ffmpegDir || '');
      // ⚠ 遍历**所有数据根**（当前 + 历史），不是只看 storageDir()：
      //   静默搬迁之后数据根变成 appdata，而旧版本那份自动下载的组件留在**程序目录**里 —— 只扫当前根会永远看不见它。
      for (const base of [storageDir()].concat(legacyDataDirs())) {
        let legacy = '';
        try { legacy = path.join(base, 'ffmpeg'); } catch (e) { continue; }
        if (!fs.existsSync(path.join(legacy, 'ffmpeg.exe'))) continue;     // 这一根没有遗留 → 下一根
        // 正在用它 → 不动（判不出来时也按"在用"处理：宁可少清，不能把唯一可用的组件清掉）
        try { if (!active || path.resolve(active) === path.resolve(legacy)) continue; } catch (e) { continue; }
        let freed = 0;
        try { freed = fs.readdirSync(legacy).reduce((s, n) => s + (fs.statSync(path.join(legacy, n)).size || 0), 0); } catch (e) {}
        try { recycleFile(legacy, '遗留的 FFmpeg 组件（内置已就绪）'); } catch (e) { continue; }   // 需重新下载，保留可还原
              try { writeUpdateLog('已自动清理遗留的 FFmpeg 组件（' + Math.round(freed / 1048576) + ' MB，进回收站可还原）：' + legacy); } catch (e) {}
      }
    } catch (e) {}
  }

  runAfterWindowLoad(() => {
    const probe = (allowRetry) => {
      api.checkEnvAsync().then((env) => {
        if (env.probeFailed) {
          if (allowRetry) setTimeout(() => probe(false), 10000);
          return;
        }
        // 组件已就绪 → 再看**版本是否过旧**（< 7.0 缺 elapsed）则静默升级，同时清理旧版遗留（见 cleanupLegacyFfmpeg，内置可用才动）
        if (!env.downloadNeeded) { cleanupLegacyFfmpeg(env); maybeUpgradeFfmpeg(); return; }
        api.ensureFfmpeg().then((r) => {
          if (r && r.ok) {
            persistFfmpegDir(r.dir);
            const done = { ok: true, auto: true, dir: r.dir, version: r.version };
            sendToMain('env_fix_done', done);
            sendToSettings('env_fix_done', done);
            return;
          }
          notifyEnvMissing(env, (r && r.error) || '');
        }).catch((e) => notifyEnvMissing(env, String((e && e.message) || e)));
      }).catch(() => {});
    };
    setTimeout(() => probe(true), 500);
  });
  ipcMain.handle('list_dir', async (e, dir) => api.listDir(dir));   // 工具页目录浏览对话框（preload 已定义，此处必须注册）
  ipcMain.handle('open_path', async (e, p) => { const target = path.resolve(p); if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '路径不存在' }; });
  ipcMain.handle('open_parent', async (e, p) => { const target = path.dirname(path.resolve(p)); if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '路径不存在' }; });
  // 打开「文件夹」类操作的统一入口，按目标类型分流：目录 → 在资源管理器中打开该目录（进入，而不是打开父级再选中它）；文件 → 打开其所在文件夹并选中该文件（定位）。
  ipcMain.handle('open_folder_select', async (e, p, opts) => {
    const target = path.resolve(String(p || '').replace(/^"|"$/g, ''));
    // opts.create：调用方明确知道该目录「按需生成」（如备份目录要等首次备份才落盘）——此时先按需创建，避免点「打开」直接报「路径不存在」
    if (opts && opts.create && target) {
      try { fs.mkdirSync(target, { recursive: true }); } catch (e3) { /* 创建失败仍走下方判定，返回真实错误 */ }
    }
    if (!target || !fs.existsSync(target)) return { ok: false, error: '路径不存在' };
    try {
      if (fs.statSync(target).isDirectory()) {
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
    } catch (e2) { /* stat 失败按文件处理：定位到所在目录 */ }
    shell.showItemInFolder(target);
    return { ok: true };
  });
  ipcMain.handle('report_ui_error', async (e, p) => { try { return api.reportUiError(p) || { ok: true }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('read_log', async (e, o) => { try { return api.readLog(o) || { ok: false }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('get_log_level', async () => { try { return api.getLogLevel() || { ok: false }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('set_log_level', async (e, lvl) => { try { return api.setLogLevel(lvl) || { ok: false }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('export_diag_pack', async (e, id, opts) => { try { return api.exportDiagPack(id, opts) || { ok: false }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('open_project_dir', async (e, project) => {
    const root = api.getRoot();
    const target = path.resolve(root || '', String(project || ''));
    if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; }
    return { ok: false, error: '项目目录不存在' };
  });
  ipcMain.handle('external_edit', async (e, p) => { const target = path.resolve(p); if (fs.existsSync(target) && fs.statSync(target).isFile()) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '文件不存在' }; });
  ipcMain.handle('pick_watermark', async (e, prevPath) => {
    // 默认定位到上一个水印所在位置（当前配置里已有的水印路径），便于就近选择新水印
    const defaultPath = String(prevPath || '').trim();
    const result = await dialog.showOpenDialog(mainWin, { title: '选择水印 PNG', defaultPath, properties: ['openFile'], filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });
  ipcMain.handle('pick_exclude', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要排除的路径（文件夹或视频文件）', defaultPath: api.getRoot(), properties: ['openFile', 'openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  ipcMain.handle('pick_paths', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要添加的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  ipcMain.handle('pick_single_folder', async (e) => {
    const result = await dialog.showOpenDialog(winOf(e) || mainWin, { title: '选择要修改为的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });
  // 遮罩「添加文件」（原片/遮罩两栏共用）：多选视频文件（含 .lnk 快捷方式）
  ipcMain.handle('pick_paths_files', async (e) => {
    const result = await dialog.showOpenDialog(winOf(e) || mainWin, {
      title: '选择视频文件（支持 mp4/mov/avi/mkv 等 / .lnk 快捷方式）',
      defaultPath: api.getRoot(),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm', 'flv', 'lnk'] }]
    });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  // 遮罩「添加文件夹」（原片/遮罩两栏共用）：多选文件夹，其中视频将递归扫描
  ipcMain.handle('pick_paths_dirs', async (e) => {
    const result = await dialog.showOpenDialog(winOf(e) || mainWin, { title: '选择文件夹（将递归扫描其中视频）', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  ipcMain.handle('resolve_shortcut', (e, p) => api.resolveShortcut(p));
  ipcMain.handle('mask_add_source', (e, side, p) => api.maskAddSource(side, p));

  // ── 自制标题栏（frame:false）窗口控制 ──
  // 查找请求来源窗口；无来源时回退主窗口
  function winOf(evt) { return BrowserWindow.fromWebContents(evt.sender) || mainWin; }
  ipcMain.handle('window_caps', (e) => {
    const w = winOf(e);
    return { minimizable: !!w && w.isMinimizable(), maximizable: !!w && w.isMaximizable(), closable: !!w && w.isClosable() };
  });
  ipcMain.handle('window_minimize', (e) => { const w = winOf(e); if (w) w.minimize(); return { ok: true }; });
  ipcMain.handle('window_toggle_maximize', (e) => { const w = winOf(e); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } return { ok: true }; });
  ipcMain.handle('window_close', (e) => { const w = winOf(e); if (w) w.close(); return { ok: true }; });
  // 最大化状态变化推送给渲染层，用于切换最大化/还原图标
  ipcMain.on('window_max_changed_listen', (e) => {
    const w = winOf({ sender: e.sender });
    if (w) {
      const emit = () => { try { if (!w.isDestroyed()) w.webContents.send('window_max_changed', w.isMaximized()); } catch (err) {} };
      w.on('maximize', emit); w.on('unmaximize', emit);
      emit();
    }
  });

  // 主窗口/退出前未保存确认：收到渲染进程响应后继续关闭或退出流程
  ipcMain.on('respond_discard_config', (e, action) => {
    discardAskOpen = false;
    if (action !== 'ok') { // 取消：复位退出意图，窗口保持现状
      if (isQuitting) { isQuitting = false; quitConfirmed = false; }
      return;
    }
    if (isQuitting) { // 托盘「退出」路径：确认完成，继续退出（before-quit 不再询问）
      discardQuitHandled = true;
      setTimeout(() => { try { app.quit(); } catch (err) {} }, 0);
      return;
    }
    // 关闭主窗口路径：跳过未保存询问，直接执行既有关闭行为
    discardCloseHandled = true;
    handleMainWindowClose();
  });
}

// 请求主窗口确认配置未保存修改；返回是否已发出请求
function askDiscardConfig() {
  if (discardAskOpen || !mainWin || mainWin.isDestroyed()) return false;
  discardAskOpen = true;
  try { mainWin.webContents.send('confirm_discard_config_request'); } catch (e) { discardAskOpen = false; }
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('confirm_discard_config_request', null);
  setTimeout(() => { discardAskOpen = false; }, 30000); // 兜底复位（窗口被销毁等情况）
  return true;
}

// 关闭主窗口：已记忆行为直接生效；未记忆时请求主窗口弹窗引导选择（可勾选"不再提醒"持久化）。关闭前先确认配置未保存修改（覆盖当前配置/保存为当日配置/取消），避免修改丢失。
function handleMainWindowClose() {
  if (!mainWin || mainWin.isDestroyed()) return;
  // 最小化到托盘：窗口仅隐藏，未保存的配置修改不丢失，无需询问
  if (config.close_behavior_skip === true && config.close_behavior !== 'exit') { mainWin.hide(); return; }
  // 配置可能未保存：先请求主窗口确认，确认后再走既有关闭行为
  if (!discardCloseHandled) {
    if (discardAskOpen) { mainWin.hide(); return; } // 确认弹窗已打开：本次先收回窗口，选择在弹窗中完成
    askDiscardConfig();
    return;
  }
  discardCloseHandled = false; // 一次性：本次关闭已确认，处理完复位，下次关闭继续询问
  if (config.close_behavior_skip === true) {
    if (config.close_behavior === 'exit') { isQuitting = true; app.quit(); }
    else mainWin.hide();
    return;
  }
  if (closeAskOpen) { mainWin.hide(); return; } // 引导弹窗已打开：本次先收回窗口，选择在弹窗中完成
  closeAskOpen = true;
  try { mainWin.webContents.send('close_behavior_request'); } catch (e) { closeAskOpen = false; }
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('close_behavior_request', null);
  setTimeout(() => { closeAskOpen = false; }, 20000); // 兜底复位（窗口被销毁等情况）
}

function createWindow() {
  // nodeIntegrationInSubFrames：让 preload 也注入 iframe。
  // 设置页已内嵌为主窗口面板（iframe），其 settings.js 依赖 preload 暴露的 window.txapi；
  // 不开此项则 iframe 内取不到，设置页所有接口都会失效。
  mainWin = new BrowserWindow({ title: IS_PREVIEW ? 'Video Lab Preview' : 'Video Lab', width: 1360, height: 860, minWidth: 1120, minHeight: 700, frame: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, nodeIntegrationInSubFrames: true } });
  mainWin.loadFile(path.join(__dirname, 'frontend', 'index.html'));
  // 页面加载完成即放行「窗口加载后」初始化。注册必须紧跟 loadFile：
  // ⚠ 若推迟到第一次 runAfterWindowLoad 调用时才注册，那时页面往往已经加载完，
  // 监听永不触发 → 只能等固定兜底时间 → 托盘 / HTTP 就绪被无谓推迟。
  try {
    mainWin.webContents.once('did-finish-load', () => {
      logTiming('主窗口 did-finish-load');
      setImmediate(() => flushAfterWindowLoad('did-finish-load'));
    });
  } catch (e) {}
  // 普通启动：页面就绪后显示；开机自启（--autostart）保持隐藏，仅托盘常驻。扫描（缓存未命中时）全程后台进行，不推迟显示、也不弹独立窗口。
  mainWin.once('ready-to-show', () => {
    logTiming('主窗口 ready-to-show（首帧可显示）');
    // 冷启动定位用：分别记录「回调返回」与 show() 的耗时，判定卡点在 show() 之内还是其后的初始化。
    setImmediate(() => logTiming('ready-to-show 回调后 setImmediate'));
    if (IS_AUTOSTART) return;
    // 不因扫描推迟显示：扫描全程后台，窗口首帧就绪即显示，列表由后台扫描完成后自动填充。⚠ 不要"等扫描完再显示主窗口"：那是启动冻结感的来源。
    logTiming('即将 show()');
    mainWin.show();
    logTiming('show() 返回');
  });
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); handleMainWindowClose(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// ═══ 卸载准备 ═══
// 卸载询问窗口：收集「是否一并删除个人数据」，随后交给原卸载程序收尾。
let uninstallWin = null;

function openUninstallWindow() {
  if (uninstallWin && !uninstallWin.isDestroyed()) {
    try { uninstallWin.show(); uninstallWin.focus(); } catch (e) {}
    return;
  }
  uninstallWin = new BrowserWindow({
    width: 520, height: 232, resizable: false, maximizable: false, minimizable: false,
    frame: false, show: false, alwaysOnTop: true, skipTaskbar: !!process.env.VL_UNINSTALL_HEADLESS,
    title: '卸载 Video Lab',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  uninstallWin.loadFile(path.join(__dirname, 'frontend', 'uninstall.html'));
  // VL_UNINSTALL_HEADLESS=1：渲染在屏幕外，供自动化验证读取界面
  const headless = !!process.env.VL_UNINSTALL_HEADLESS;
  // 显示时机：ready-to-show 为主，did-finish-load 兜底 —— 隐藏方式启动时前者可能不触发，窗口就永远不出现
  const showWin = () => {
    try {
      if (!uninstallWin || uninstallWin.isDestroyed()) return;
      if (headless) { uninstallWin.setPosition(-32000, -32000); uninstallWin.showInactive(); }
      else { uninstallWin.show(); uninstallWin.focus(); }
    } catch (e) {}
  };
  uninstallWin.once('ready-to-show', showWin);
  uninstallWin.webContents.once('did-finish-load', () => { setTimeout(showWin, 100); });
  uninstallWin.on('closed', () => { uninstallWin = null; });
}

function resolveUninstallPaths(installDirOverride) {
  const installDir = installDirOverride || path.dirname(process.execPath);
  // 卸载器位置：优先子目录里的 core（入口重定向后框架卸载器在此），否则回退扫描安装目录
  let uninstaller = '';
  const coreDir = path.join(installDir, 'uninstaller');
  try {
    const c = fs.readdirSync(coreDir).filter((n) => /\.exe$/i.test(n));
    if (c.length) uninstaller = path.join(coreDir, c[0]);
  } catch (e) {}
  if (!uninstaller) {
    uninstaller = path.join(installDir, 'Uninstall ' + (IS_PREVIEW ? 'Video Lab Preview' : 'Video Lab') + '.exe');
    if (!fs.existsSync(uninstaller)) {
      try {
        const cand = fs.readdirSync(installDir).filter((n) => /^Uninstall .+\.exe$/i.test(n));
        if (cand.length) uninstaller = path.join(installDir, cand[0]);
      } catch (e) {}
    }
  }
  return {
    dataDir: storageDir(),
    markerDir: localAppDir(),
    installDir, uninstaller,
    uninstallerExists: fs.existsSync(uninstaller),
  };
}

// 启动退出后执行的收尾脚本：（按选择）清理个人数据 → 调原卸载程序静默卸载。
// ⚠ 清理必须由独立进程执行：本进程持有数据目录里的库文件句柄。
function launchUninstallHelper(info, deleteData) {
  const q = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Start-Sleep -Seconds 3',
    "$log = Join-Path $env:TEMP 'vl-uninstall.log'",
    '(Get-Date -Format o) | Out-File -LiteralPath $log -Encoding UTF8',
    'if (' + (deleteData ? '$true' : '$false') + ') {',
    '  foreach ($d in @(' + q(info.dataDir) + ', ' + q(info.markerDir) + ')) {',
    '    if (-not (Test-Path -LiteralPath $d)) { continue }',
    '    try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } catch {}',
    '    $ok = -not (Test-Path -LiteralPath $d)',
    "    ('data ' + $d + ' removed=' + $ok) | Out-File -LiteralPath $log -Append -Encoding UTF8",
    '  }',
    '}',
    'if (Test-Path -LiteralPath ' + q(info.uninstaller) + ') {',
    "  'run uninstaller' | Out-File -LiteralPath $log -Append -Encoding UTF8",
    '  Start-Process -FilePath ' + q(info.uninstaller) + " -ArgumentList '/S' -Wait",
    "} else { 'uninstaller missing' | Out-File -LiteralPath $log -Append -Encoding UTF8 }",
  ];
  const stamp = Date.now();
  const ps1 = path.join(os.tmpdir(), 'vl-uninstall-' + stamp + '.ps1');
  // UTF-8 带 BOM：脚本内含数据路径，PowerShell 按 UTF-8 读取
  fs.writeFileSync(ps1, '\uFEFF' + lines.join('\r\n'), 'utf8');
  // ⚠ 不能直接 spawn powershell：它会随本进程退出被终止；经 wscript 脱离进程树后再拉起。
  const vbs = path.join(os.tmpdir(), 'vl-uninstall-' + stamp + '.vbs');
  const cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ps1 + '"';
  const vbsText = 'CreateObject("WScript.Shell").Run "' + cmd.replace(/"/g, '""') + '", 0, False';
  fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbsText, 'utf16le')]));   // UTF-16LE + BOM
  return new Promise((resolve) => {
    let settled = false;
    const child = require('child_process').spawn('wscript.exe', [vbs],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: String((e && e.message) || e) });
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true });
      child.unref();
    });
  });
}

async function startUninstall(opts, installDirOverride) {
  const deleteData = !!(opts && opts.deleteData);
  let info = null;
  try { info = resolveUninstallPaths(installDirOverride); } catch (e) {}
  try {
    runLog.sys('uninstall.start', '开始卸载', { deleteData, installDir: info && info.installDir });
  } catch (e) {}
  if (!info || !info.uninstallerExists) return { ok: false, error: 'uninstaller' };
  let launched = null;
  try { launched = await launchUninstallHelper(info, deleteData); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  if (!launched || !launched.ok) {
    try { runLog.sys('uninstall.startFail', '收尾进程未能启动', { error: launched && launched.error }); } catch (e) {}
    return { ok: false, error: (launched && launched.error) || 'launch' };
  }
  setTimeout(() => { isQuitting = true; app.exit(0); }, 800);
  return { ok: true };
}

// 已运行的实例被要求打开卸载窗口时（second-instance），这两个通道必须早已注册 —— 否则窗口能显示但点不动
let uninstallIpcReady = false;
// 带静默参数（/S、--updated）被调起时视为脚本化/安装器调用：直通、不弹询问，
// 免得无人应答把调用方挂住；此时只结束正在运行的同名实例并以 0 退出，
// 让调用方（安装器）认为旧版已卸下、继续覆盖安装 —— 卸载动作留给调用方自己完成。
function installerCallInfo() {
  let installDir = '';
  for (const a of process.argv) {
    const m = /^(?:\/_?|\?)=(.*)$/.exec(a);
    if (m) { installDir = String(m[1] || '').replace(/^"|"$/g, ''); break; }
  }
  for (const a of process.argv) {
    if (/^\/S$/i.test(a) || /^--updated$/i.test(a) || /KEEP_APP_DATA/i.test(a)) {
      return { installDir: installDir };
    }
  }
  // 卸载入口脚本判定"自己是被安装器复制到临时目录执行的"时带上的标记
  if (process.argv.indexOf('--from-installer') >= 0) return { installDir: installDir };
  return null;
}

// 结束正在运行的同名实例：安装器随后要覆盖这些文件，被占用会失败。
// ⚠ 普通 detached 子进程会随本进程退出被终止，必须经 wscript 脱离进程树。
function killRunningInstances(exeName) {
  try {
    const stamp = Date.now();
    const ps1 = path.join(os.tmpdir(), 'vl-kill-instances-' + stamp + '.ps1');
    const script = [
      'Start-Sleep -Seconds 2',
      "Get-Process -Name '" + String(exeName).replace(/'/g, "''") + "' -ErrorAction SilentlyContinue | Stop-Process -Force",
    ].join('\r\n');
    fs.writeFileSync(ps1, '\uFEFF' + script, 'utf8');
    const vbs = path.join(os.tmpdir(), 'vl-kill-instances-' + stamp + '.vbs');
    const cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ps1 + '"';
    const vbsText = 'CreateObject("WScript.Shell").Run "' + cmd.replace(/"/g, '""') + '", 0, False';
    fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbsText, 'utf16le')]));
    const child = require('child_process').spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('spawn', () => child.unref());
  } catch (e) {}
}

function registerUninstallIpc() {
  if (uninstallIpcReady) return;
  uninstallIpcReady = true;
  ipcMain.handle('uninstall_confirm', (e, opts) => {
    const deleteData = !!(opts && opts.deleteData);
    if (UNINSTALL_CHILD) {
      // 由卸载器调起：只回传选择（1=删除 / 0=保留），卸载流程由调用方继续
      try { if (UNINSTALL_RESULT) fs.writeFileSync(UNINSTALL_RESULT, deleteData ? '1' : '0', 'utf8'); } catch (er) {}
      setTimeout(() => { isQuitting = true; app.exit(0); }, 200);
      return { ok: true };
    }
    return startUninstall(opts);
  });
  // 取消：只有「为卸载而单独启动的进程」才整个退出；已运行的实例只关掉这个窗口
  ipcMain.handle('uninstall_cancel', () => {
    if (UNINSTALL_CHILD) {
      try { if (UNINSTALL_RESULT) fs.writeFileSync(UNINSTALL_RESULT, 'cancel', 'utf8'); } catch (er) {}
      setTimeout(() => { isQuitting = true; app.exit(0); }, 100);
      return { ok: true };
    }
    if (IS_UNINSTALL_PREP) { isQuitting = true; setTimeout(() => app.exit(0), 100); }
    else if (uninstallWin && !uninstallWin.isDestroyed()) uninstallWin.close();
    return { ok: true };
  });
}

// 统一卸载入口（幂等，每次启动校正）：注册表入口 + 开始菜单文件夹 + 安装目录中文入口。
// 只在安装形态生效；任何一步失败都保持原样，不影响既有卸载能力。
function ensureUninstallEntryPointsHere() {
  if (!app.isPackaged || IS_UNINSTALL_PREP || IS_PREVIEW) return;
  try {
    const { applyUninstallEntry } = require('./build/uninstall-entry.js');
    const key = applyUninstallEntry(path.dirname(process.execPath), process.execPath);
    runLog.sys('uninstall.entry', key ? '卸载入口已统一到本程序' : '未找到卸载注册表项（保持原样）', { key });
  } catch (e) {}
}

// 启动阶段计时落日志（app.timing）：冷启动排查的数据来源
function logTiming(label) {
  try { runLog.sys('app.timing', '启动阶段 · ' + label, { sinceProcessStart: Math.round(bootMs()) }); } catch (e) {}
}

// 窗口渲染完成后再执行后台初始化：把重活（读任务日志、起 HTTP、建托盘）排到窗口可见之后，避免叠加成「点了图标迟迟不出窗口」。
// ⚠ 不能用 ready-to-show 作为唯一触发：开机自启场景窗口从不 show，「首帧显示」语义不成立；用 did-finish-load + 3 秒兜底。
let _afterLoadDone = false;
const _afterLoadQueue = [];
// 放行「窗口加载后」初始化。触发源有两处：
//   ① did-finish-load（在 createWindow 里紧跟 loadFile 注册 —— 见那里的注释）
//   ② 3 秒兜底：页面加载异常时也不能把后续初始化永久挂住
function flushAfterWindowLoad(reason) {
  if (_afterLoadDone) return;
  _afterLoadDone = true;
  logTiming('runAfterWindowLoad flush（' + reason + '，队列 ' + _afterLoadQueue.length + ' 项）');
  for (const f of _afterLoadQueue.splice(0)) { try { f(); } catch (e) {} }
}
function runAfterWindowLoad(fn) {
  if (_afterLoadDone) { setTimeout(fn, 0); return; }
  _afterLoadQueue.push(fn);
  if (_afterLoadQueue.length > 1) return;
  setTimeout(() => flushAfterWindowLoad('兜底超时'), 3000);   // 兜底
}

// 首次引导：工作路径缺失时在主窗口内以 iframe 显示（与设置页同一模式）；用户主动点按钮才弹资源管理器，
// 可保存并关闭，也可关闭跳过（跳过时主窗口进入"空列表 + 中央选择路径"引导态）。
let guidePanelOpen = false;
let guidePanelResolve = null;
function openGuideWindow() {
  return new Promise((resolve) => {
    if (guidePanelOpen) { resolve(); return; }
    guidePanelOpen = true;
    guidePanelResolve = resolve;
    try {
      if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
        mainWin.webContents.send('guide_window_opened');
      }
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('guide_window_opened', null);
    } catch (e) { guidePanelOpen = false; guidePanelResolve = null; resolve(); }
  });
}
// 关闭引导面板（保存成功 / 用户跳过 / 标题栏关闭）
function closeGuidePanel() {
  if (!guidePanelOpen) return;
  guidePanelOpen = false;
  try {
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
      mainWin.webContents.send('guide_window_closed');
    }
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('guide_window_closed', null);
  } catch (e) {}
  const r = guidePanelResolve; guidePanelResolve = null;
  if (r) { try { r(); } catch (e) {} }
}// 首次（或配置缺失）时：若有工作路径直接继续；否则打开引导窗口由用户保存或跳过。
// 跳过（root 仍无效）时保持 root 为空：主窗口进入「空项目列表 + 居中选择路径」引导态
async function ensureConfig() {
    const br = getBatchRoot(config);   // 工作目录取自批量模式的 batch.root
    // ⚠ 工作目录可能在机械盘：主进程**不得**同步 stat —— 冷态首次访问会冻结事件循环；用 fs.promises 异步判断，且只判一次。
    let ok = false;
    if (br) {
      try { const st = await fs.promises.stat(br); ok = st.isDirectory(); } catch (e) { ok = false; }
    }
    // 开机自启为静默后台启动：配置缺失也不显示首次引导，保持无打扰（用户稍后手动打开时再引导）
    if (!IS_AUTOSTART && !ok) {
      await openGuideWindow(); // 保存或右上角关闭（跳过）都会关闭该窗口
    }
    // root 已在 Api 构造时由 resolveRoot 正确设置；此处仅为确认，相同路径时快速返回
    api.setRoot(ok ? br : '');
  }

app.whenReady().then(async () => {
  // ── 主进程事件循环心跳（启动期）──
  // 「托盘图标在、点不动、要等很久才出窗口」= 主进程事件循环被同步操作占死的典型表现。
  // 单靠各阶段打点看不出「两次打点之间事件循环是否卡住」，故起一个 500ms 心跳：间隔明显超过 500ms 即记 app.timing「事件循环卡顿」事件（含卡顿时长）。
  if (!global.__vlHeartbeat) {
    global.__vlHeartbeat = { last: Date.now(), n: 0 };
    const hb = setInterval(() => {
      const now = Date.now();
      const gap = now - global.__vlHeartbeat.last;
      global.__vlHeartbeat.last = now;
      global.__vlHeartbeat.n++;
      if (gap > 800) { // 明显超过 500ms 才记，避免调度抖动噪声
        try { runLog.sys('app.timing', '事件循环卡顿（心跳间隔异常）',
          { gapMs: Math.round(gap), atSinceProcessStart: Math.round(bootMs()), beat: global.__vlHeartbeat.n }); } catch (e) {}
      }
      if (global.__vlHeartbeat.n >= 120) clearInterval(hb); // 约 60 秒后停
    }, 500);
  }
  // 应用身份（AppUserModelID）与 build.appId 统一（com.videolab.manager）：
  // 需配合「开始菜单快捷方式 + 相同 AUMID」一起注册，Windows 才能解析显示名（Video Lab）与图标；
  // 不可移除——缺失时任务管理器会把应用识别为框架名 "Electron"、图标解析失败（乱码）
  // AppUserModelID（须与 build.appId 一致；预览版用独立 AUMID）
  try { app.setAppUserModelId(IS_PREVIEW ? 'com.videolab.preview' : 'com.videolab.manager'); } catch (e) {}
  Menu.setApplicationMenu(null);
  // 卸载准备：只装载询问窗口所需的能力后返回
  if (IS_UNINSTALL_PREP) {
    registerUninstallIpc();
    // 被安装器调起（升级/重装旧版）：结束运行中的实例后以 0 退出，让安装器继续覆盖安装
    const byInstaller = installerCallInfo();
    if (byInstaller) {
      killRunningInstances(path.basename(process.execPath, '.exe'));
      setTimeout(() => { isQuitting = true; app.exit(0); }, 300);
      return;
    }
    openUninstallWindow();
    return;
  }
  registerIpc();
  registerUninstallIpc();
  logTiming('whenReady 后 注册 IPC 完成');
  // ── 启动顺序原则：**能在窗口显示后做的，绝不放在窗口显示前** ──
  // 此处只保留窗口必须先有的最小集（createWindow）；ensureConfig / createTray / HTTP / restoreTasks 一律在首帧之后再跑，避免任一环节慢叠加成「点了图标迟迟不出窗口」。
  createWindow();
  logTiming('主窗口已创建（loadFile 已发起）');
  // 卸载入口接管（窗口就绪后延迟执行）
  setTimeout(() => { try { ensureUninstallEntryPointsHere(); } catch (e) {} }, 5000);
  // ── 启动期全量扫描：缓存未命中时后台预热（不弹窗、不推迟窗口显示） ──
  (() => {
    if (IS_AUTOSTART) return;                 // 自启形态静默，不打扰
    if (!getBatchRoot(config)) return;        // 未配置工作路径：无扫描可言
    // 扫描全程后台：主窗口立即显示、界面可交互 —— 不弹窗、也不推迟显示
    // ⚠ 不要"等扫描完才显示主窗口"：那是启动冻结感的来源。
    // ⚠ 判定必须走**异步版**（isScanCacheFreshAsync）：同步版会在机械盘冷态首次访问时冻结主进程上百秒。
    const runWarmScan = () => {
      logTiming('启动需要全量扫描（后台进行）');
      const _s = process.hrtime.bigint();
      api.listProjectsAsync()
        .then(() => { logTiming('启动预热扫描完成（耗时 ' + Math.round(Number(process.hrtime.bigint() - _s) / 1e6) + 'ms）'); })
        .catch(() => {});
    };
    api.isScanCacheFreshAsync()
      .then((fresh) => { if (!fresh) runWarmScan(); })
      .catch(() => { runWarmScan(); });   // 判定异常按「需要扫描」处理
  })();
  // 开机自启（--autostart）：进程静默常驻托盘，窗口保持隐藏
  runAfterWindowLoad(() => {
    const _t0 = process.hrtime.bigint();
    const _ms = () => Math.round(Number(process.hrtime.bigint() - _t0) / 1e6);
    // 首次引导（配置缺失时）：必须在窗口加载后，避免阻塞启动。 ⚠ ensureConfig 内部用异步 stat（工作目录在机械盘，同步 stat 会冻结事件循环）；此处补打完成埋点。
    ensureConfig().catch(() => {}).then(() => { logTiming('窗口加载后：ensureConfig 完成（' + _ms() + 'ms）'); });
    logTiming('窗口加载后：createTray 开始');
    try { createTray(); } catch (e) {}
    logTiming('窗口加载后：托盘已创建（' + _ms() + 'ms）');
    restartHttpServer();              // 内嵌 HTTP 服务器：浏览器访问 http://localhost:<port>
    if (IS_AUTOSTART && mainWin && !mainWin.isDestroyed()) mainWin.hide();
    logTiming('窗口加载后：托盘 / HTTP 就绪');
    // 数据缓存失效清理：**窗口就绪后 15 秒**的空闲期增量执行（限量 600 条 + 细让路 + 批间小睡）。
    // ⚠ 绝不放在启动关键路径：冷态全量核验近万条机械盘路径会把事件循环冻住几十秒
    //   （窗口已画出来、用户却点不动近一分钟）。清理是维护任务，摊到多次启动完成即可。
    setTimeout(() => {
      try { api.gcVideoCacheIdle().catch(() => {}); } catch (e) {}
      try { api.gcCachesIdle().catch(() => {}); } catch (e) {}
    }, 15000);
    // 启动自动检查更新（仅检查；UPDATE_ENABLED=false 时便携版静默停用）
    if (UPDATE_ENABLED && mainWin && !mainWin.isDestroyed()) {
      if (config.auto_check_update !== false) setTimeout(() => checkForUpdate({ silent: true }), 3000);
      scheduleDailyUpdateCheck();
    }
    // 任务列表恢复：读上百条任务日志，是最重的一步 —— 放到窗口加载后且让出一轮事件循环，保证窗口已经画出来再占用主进程。
    // ⚠ 这里只计「同步段」：输出目录校验在 backend 侧为异步（同步 existsSync 会逐任务冷访问机械盘），异步部分不计入本耗时。
    setTimeout(() => {
      const _t = process.hrtime.bigint();
      try { api.restoreTasks(); } catch (e) {}
      logTiming('窗口加载后：任务恢复同步段完成（耗时 ' + Math.round(Number(process.hrtime.bigint() - _t) / 1e6) + 'ms · 输出目录校验已转异步）');
      // 存量备份迁移（先迁后清）：老版本把备份写进数据目录，而 migrateBackups 只在备份根值变化时触发，故启动时补迁一次。
      // 必须**先迁后清**：否则"保留 N 天"的清理可能先删掉数据目录里的旧备份，用户等于白丢。
      try { api.migrateLegacyBackupsAsync().then(() => { try { api._cleanupBackupsAsync(); } catch (e) {} }); }
      catch (e) { try { api._cleanupBackupsAsync(); } catch (e2) {} }
    }, 0);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', (e) => {
  // 仅管理主动退出（托盘「退出」）；若主窗口仍在运行任务，先经主窗口弹确认框（与界面同款样式）
  if (!isQuitting) return;
  // 配置可能未保存：先经主窗口确认（覆盖当前配置/保存为当日配置/取消），确认后再继续退出
  if (!discardQuitHandled && mainWin && !mainWin.isDestroyed()) {
    e.preventDefault();
    showMainWindow();
    askDiscardConfig();
    return;
  }
  if ((api.hasRunningTask() || api.hasQueuedTask()) && !quitConfirmed) {
    e.preventDefault();
    showMainWindow();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('confirm_quit_request');
    else { api.shutdownTasks(); quitConfirmed = true; app.quit(); }
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('confirm_quit_request', null);
    return;
  }
  // 收尾：运行中→已中断、排队→暂停，随后持久化任务列表并退出
  api.shutdownTasks();
  quitConfirmed = true;
  // 退出留痕要用同步写 —— 此刻进程即将结束，流缓冲里的最后几行等不到 flush
  if (!exitLogged) {
    exitLogged = true;
    try {
      runLog.logEventSync('SYS', 'app.exit', '退出 · 任务已收尾（运行中→已中断、排队→暂停）', {});
      runLog.close();
    } catch (err) {}
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

// ── 崩溃留痕 ──
// 崩溃留痕：未捕获异常时同步写入日志。
// 注意：监听 uncaughtException 会让 Node 不再自动退出，因此记录后仍需 process.exit(1)，保持「未捕获异常即退出」的行为，避免进程带病继续运行。
process.on('uncaughtException', (err) => {
  try {
    runLog.logEventSync('ERR', 'app.uncaughtException',
      String((err && err.message) || err).slice(0, 300),
      { stack: String((err && err.stack) || '').slice(0, 1200) });
    runLog.close();
  } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { runLog.err('app.unhandledRejection', reason); } catch (e) {}
});
// ── 窗口内容就绪等待 ──
// 女仆皮肤带 64KB CSS + 多张 webp 装饰图（sidebar-corner / maid-swag / top-trim-tile / maid-chibi …），
// 首帧必须等这些资源解码完成，否则会「先出空框、再刷出装饰」；统一等字体就绪 → 图片解码完成（含 <img>）→ 两帧重绘，并有超时兜底。
async function waitForWindowContent(win, timeoutMs) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return;
  try {
    await Promise.race([
      win.webContents.executeJavaScript(
        '(function(){' +
        ' var done=[];' +
        ' try{ if(document.fonts&&document.fonts.ready) done.push(document.fonts.ready); }catch(e){}' +
        ' var imgs=Array.prototype.slice.call(document.images).filter(function(i){return !i.complete;});' +
        ' if(imgs.length) done.push(Promise.all(imgs.map(function(i){return new Promise(function(r){i.onload=i.onerror=r;});})));' +
        // CSS 背景图不在 document.images 中：额外等两帧，给解码/合成留出时间
        ' return Promise.all(done).then(function(){return new Promise(function(r){' +
        '   requestAnimationFrame(function(){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true);});});});' +
        ' });});' +
        '})()'),
      new Promise(function (r) { setTimeout(r, timeoutMs || 500); }),   // 兜底：隐藏窗口 rAF 可能被节流
    ]);
  } catch (e) {}
}

// 渲染进程 / 子进程异常退出（主进程仍在运行）；★ 自愈：渲染进程异常时**必须做恢复** —— 只记日志的话界面会永久白屏，只能手动重启。
const _renderGoneAt = [];
function _shouldAutoReload() {
  const now = Date.now();
  while (_renderGoneAt.length && now - _renderGoneAt[0] > 5 * 60 * 1000) _renderGoneAt.shift();
  if (_renderGoneAt.length >= 3) return false;   // 频繁崩溃 → 不再重载，保留现场供排查
  _renderGoneAt.push(now);
  return true;
}
app.on('render-process-gone', (e, contents, details) => {
  const reason = String((details && details.reason) || '');
  try {
    runLog.err('app.renderGone', '渲染进程退出 · ' + reason,
      { exitCode: details && details.exitCode, url: contents && contents.getURL && contents.getURL() });
  } catch (err) {}
  // clean-exit / killed 属正常关闭路径，不重载
  if (reason === 'clean-exit' || reason === 'killed') return;
  try {
    if (!contents || contents.isDestroyed || contents.isDestroyed()) return;
    if (!_shouldAutoReload()) {
      try { runLog.err('app.renderGone', '渲染进程反复崩溃，已停止自动重载（保留现场）'); } catch (err) {}
      return;
    }
    const url = contents.getURL && contents.getURL();
    try { runLog.err('app.renderGone', '尝试自动重载渲染进程 · ' + String(url || '')); } catch (err) {}
    // 走 reload：正常页面重载即恢复；极端情况（连 reload 都失败）留给下方 did-fail-load 兜底
    contents.reload();
  } catch (err) {}
});
// 页面加载失败（含渲染失败后 reload 仍失败）→ 记录并延时重试一次，避免停在白屏/源码页
app.on('web-contents-created', (e, contents) => {
  try {
    contents.on('did-fail-load', (ev, errorCode, errorDesc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      try { runLog.err('app.didFailLoad', '页面加载失败 · ' + errorDesc + '(' + errorCode + ')', { url: validatedURL }); } catch (err) {}
      setTimeout(() => {
        try {
          if (contents.isDestroyed && contents.isDestroyed()) return;
          if (_shouldAutoReload()) contents.reload();
        } catch (err) {}
      }, 800);
    });
    contents.on('unresponsive', () => {
      try { runLog.err('app.unresponsive', '渲染进程无响应 · ' + String(contents.getURL && contents.getURL() || '')); } catch (err) {}
    });
    contents.on('responsive', () => {
      try { runLog.err('app.responsive', '渲染进程已恢复响应 · ' + String(contents.getURL && contents.getURL() || '')); } catch (err) {}
    });
  } catch (err) {}
});
app.on('child-process-gone', (e, details) => {
  try {
    runLog.err('app.childGone',
      '子进程退出 · ' + String((details && details.type) || '') + '/' + String((details && details.reason) || ''),
      { exitCode: details && details.exitCode, name: details && details.name });
  } catch (err) {}
});
