// -*- coding: utf-8 -*-
// Video Lab — Electron 主进程
'use strict';

// ── 启动阶段计时 ──
// 冷启动慢的排查长期缺少数据：日志只记了「什么时候启动」，没记「各阶段花了多久」，
// 导致每次优化都靠猜。这里从进程第一行起就开始计时，whenReady → 窗口可见 → 后端就绪
// 各阶段耗时统一落到运行日志的 app.timing 事件，下次再有人说慢可以直接看数。
const _BOOT_T0 = process.hrtime.bigint();
function bootMs() { return Number(process.hrtime.bigint() - _BOOT_T0) / 1e6; }
// 极早探针：本行之前只有 V8 启动 + 本文件解析，若这里「进程已存活很久」说明卡在
// 进程创建/加载阶段（杀软扫描未签名 exe、磁盘冷读），而非任何 JS 逻辑。
// 用 process.uptime() 反推进程真实创建时刻（Electron 主进程里该值自进程创建累计），
// 写入独立文件而非 runLog —— 此时 runLog 尚未 require。
// ⚠ 每个进程单独一个文件（文件名带 pid + 时刻），不覆盖：冷启动现场常发生在无人值守时，
//    若只留单个文件，中途任何一次启动都会把冷启动那条证据冲掉。
const _EARLY_UPTIME_MS = Math.round(process.uptime() * 1000);
try {
  const _fs = require('fs');
  const _path = require('path');
  const _dir = _path.join(require('os').homedir(), '.video-lab', 'boot-probe');
  _fs.mkdirSync(_dir, { recursive: true });
  const _stamp = new Date().toISOString().replace(/[:.]/g, '-');
  _fs.writeFileSync(
    _path.join(_dir, _stamp + '_' + process.pid + '.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      argv: process.argv.slice(1),
      electronVersion: process.versions.electron,
      uptimeMsAtFirstLine: _EARLY_UPTIME_MS,
      // uptimeMsAtFirstLine 很大 = 进程创建后很久才轮到 JS 执行（杀软扫描 / exe 冷读 / 磁盘争抢）
      // 该值正常应在 10-40ms 量级
    }),
    'utf8');
  // 只保留最近 20 个，避免长期堆积
  const _files = _fs.readdirSync(_dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of _files.slice(0, Math.max(0, _files.length - 20))) {
    try { _fs.unlinkSync(_path.join(_dir, f)); } catch (e) {}
  }
} catch (e) {}

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, net, screen } = require('electron');
const _bootReqElectron = bootMs();
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
      const p = parseInt(config.http_port, 10) || 9527;
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
    httpPort: parseInt(config.http_port, 10) || 9527,
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

// 单实例锁：统一 userData 到固定全局路径（跨盘 / 开发版与打包版共享同一把锁），
// 使"同一时刻仅允许一个主进程实例"真正生效；重复打开时唤出现有实例主窗口
app.setPath('userData', path.join(os.homedir(), '.video-lab'));
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
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

// 开机自启动形态：由登录项以 --autostart 启动时静默到托盘并在后台预热工作目录，不打扰用户
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
// ⚠ 开发形态不能用 projectDir() 作基准 —— 未打包时它等于 __dirname（app 目录本身），
//    拼出的 resources\app\engines 并不存在，会让源码形态的实例解析不到引擎。
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
// ⚠ %APPDATA% 的解析必须容错：app.getPath('appData') 在 APPDATA 缺失/无效时（企业环境、
//   便携启动器清理环境、被外部工具改坏）会【抛异常】，而本函数在模块顶层就被
//   resolveConfigLocation() 调用（见下方 let configFile = ...）—— 异常一旦冒泡即为
//   “主进程未捕获异常”，直接弹框崩溃、应用完全无法启动（实测复现过）。
//   回退链：appData → $APPDATA → home → userData（userData 已在文件顶部显式固定，必定可用）。
function appdataConfigPath() {
  let base = '';
  try { base = app.getPath('appData'); } catch (e) {}
  if (!base) { try { base = process.env.APPDATA || ''; } catch (e) {} }
  if (!base) { try { base = app.getPath('home'); } catch (e) {} }
  if (!base) { try { base = app.getPath('userData'); } catch (e) {} }
  return path.join(base, 'Video Lab', 'config.json');
}
// 启动时自动仲裁「配置和数据」的保存位置：
//  1) 两侧都无配置 → 默认程序目录（随后由 ensureConfig 打开启动引导窗口）
//  2) 两侧各有一份 → 取修改时间较新的一份生效，并删除旧的一份（防双份残留复发）
//  3) 库与引导文件同目录（扁平布局）——不再有「配置在一侧、缓存在对侧」的情形
function resolveConfigLocation() {
  const prog = programConfigPath();
  const appd = appdataConfigPath();
  const hasProg = (() => { try { return fs.existsSync(prog); } catch (e) { return false; } })();
  const hasAppd = (() => { try { return fs.existsSync(appd); } catch (e) { return false; } })();
  if (hasProg && hasAppd) {
    let progNewer = false;
    try { progNewer = fs.statSync(prog).mtimeMs >= fs.statSync(appd).mtimeMs; } catch (e) {}
    const chosen = progNewer ? prog : appd;
    const stale = progNewer ? appd : prog;
    try { fs.unlinkSync(stale); } catch (e) {} // 以新的一份为准并清理旧的（防双份残留复发）
    return chosen;
  }
  return hasAppd ? appd : prog;
}
let configFile = resolveConfigLocation();
// 数据根目录 = 引导文件所在目录：三库（config.json / settings.db / cache.db）扁平同目录，
// 不再有 Cache\ / Config\ 中间层；库路径一律由 storageDir() 派生，杜绝「路径重算」类 bug
const SETTINGS_DB = 'settings.db';
const CACHE_DB = 'cache.db';
const storageDir = () => path.dirname(configFilePath());

// ═══ 过渡版 2.5.1：便携数据静默搬迁 + 留线索 + 接管标记 ═══
// 目的：把「数据位置」与「用户用哪个版本」解耦 —— 数据迁到 %APPDATA% 后，无论下次启动便携版还是安装版，
//       resolveConfigLocation() 的 mtime 仲裁都会选 appdata。
// ⚠ 复核补充 1（关键）：复制完成后必须把源侧三库改名 `*.migrated` —— 否则本次会话继续读写源侧，
//   mtime 反超 appdata → 下次启动仲裁选回源侧并删掉 appdata 副本 → 搬迁自我回滚且不再重试。
// 触发条件严格（便携形态 + 数据当前在程序目录）；非便携/已迁用户只做几次 existsSync，开销可忽略；
// 真正搬迁仅在「便携版首次启动」发生一次（复制为幂等操作）。
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
  // ② 源侧三库改名 *.migrated（复核补充 1：改名非删除，可回滚取证；源侧从此无 config.json → 仲裁必选 appdata）
  for (const n of ['config.json', SETTINGS_DB, CACHE_DB]) {
    for (const suf of ['', '-wal', '-shm']) {
      const src = path.join(srcDir, n + suf);
      try { if (fs.existsSync(src)) fs.renameSync(src, src + '.migrated'); } catch (e) {}
    }
  }
  // ③ touch appdata 的 config.json（保证其 mtime 不早于源文件，仲裁必选它）
  try { const now = new Date(); fs.utimesSync(appdCfg, now, now); } catch (e) {}
  _migLog('已接管数据：' + srcDir + ' → ' + appdDir);
  return true;
}
// 留线索：%LOCALAPPDATA%\Video Lab\portable-origin.json
// 刻意不放数据目录内 —— 数据目录可能被删/迁，线索要独立存活；供 NSIS 安装包与后续排查使用。
function _writePortableOrigin(migrated) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Video Lab');
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
// ⚠ 闸门判据修正：**便携包是"安装形态原料（win-unpacked）原样压 zip"**，
// 它带着 resources\app-update.yml → `IS_PORTABLE` 恒为 false（走安装形态分支）。
// 若用 IS_PORTABLE 当闸门，真实便携用户的搬迁**永不触发**（早期的人造测试曾掩盖这一点）。
// 可靠区分点 = **安装痕迹**：setup(NSIS) 安装会在程序目录放 Uninstall*.exe，zip 解压出来的没有。
// 故闸门为「数据落在程序目录 + 该目录无 Uninstall*.exe」——零注册表开销、不误伤 setup 用户。
function _looksLikeUninstalledCopy(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    return !fs.readdirSync(dir).some(function (n) { return /^uninstall.*\.exe$/i.test(n); });
  } catch (e) { return false; }
}
// 「便携分发形态」判据（供更新链路使用）：只认「程序目录无 Uninstall*.exe」。
// ⚠ 刻意**不**包含「数据是否还在程序目录」—— 搬迁完成后数据已在 appdata，但程序目录的性质没变，
//   更新时仍应下载 Setup 安装包（否则便携版会去找便携包 zip，而 2.5.1 起不再发布该资产）。
// ⚠ 也不能用 IS_PORTABLE：真实便携包（win-unpacked 压 zip）自带 app-update.yml，该值为 false。
function isPortableDistribution() {
  if (!app.isPackaged) return false;
  return _looksLikeUninstalledCopy(projectDir());
}
// ── 启动期执行（仅此处；开发形态与已安装形态一律跳过）──
try {
  const _progDir = path.dirname(programConfigPath());
  if (app.isPackaged && path.resolve(configFile) === path.resolve(programConfigPath())
    && _looksLikeUninstalledCopy(_progDir)) {
    // A1 静默搬迁（数据落在程序目录，且该目录不像 setup 安装现场）
    const done = _adoptDirAsDataRoot(_progDir);
    if (done) configFile = appdataConfigPath();   // 本次会话起即用 appdata（storageDir 随之派生）
    // A2 留线索（顺序不可颠倒：先搬迁完成，再写线索，migrated 才准确）
    _writePortableOrigin(done);
  }
  // A3 接管标记：安装程序（NSIS，见 build/installer.nsh）在"未搬迁就装 Setup"时写下 pending-takeover.json。
  // ⚠ 安装程序刻意只写"信号"不解析 JSON（避免两套实现漂移）→ 源目录若不在标记里，回退读线索文件。
  try {
    const ldir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Video Lab');
    const tf = path.join(ldir, 'pending-takeover.json');
    if (fs.existsSync(tf)) {
      const tk = JSON.parse(fs.readFileSync(tf, 'utf8').replace(/^\uFEFF/, ''));
      let src = String((tk && tk.portableDir) || '');
      if (!src) {
        try {
          const og = JSON.parse(fs.readFileSync(path.join(ldir, 'portable-origin.json'), 'utf8').replace(/^\uFEFF/, ''));
          src = String((og && og.portableDir) || '');
        } catch (e2) { _migLog('标记无源目录且线索不可读（跳过接管）：' + ((e2 && e2.message) || e2)); }
      }
      if (src && fs.existsSync(path.join(src, 'config.json')) && !fs.existsSync(appdataConfigPath())) {
        if (_adoptDirAsDataRoot(src)) configFile = appdataConfigPath();
      }
      fs.unlinkSync(tf);   // 一次性：无论是否接手，标记用完即删
    }
  } catch (e) { _migLog('接管标记处理失败（不影响使用）：' + ((e && e.message) || e)); }
} catch (e) { _migLog('搬迁流程异常（已忽略，不影响使用）：' + ((e && e.message) || e)); }

// ── 运行日志（排查用，保留 7 天）──
// 任务记录 / 任务标记 / 成片产物都可能被清除或删除，一旦清除就只剩"反推"。
// 本日志独立留存、任何清除操作都不触碰它 —— 它是事后唯一还在的证据。
// 位置与三库同级：<storageDir>\log\app-YYYY-MM-DD.log
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
// 回答"用户到底点了什么"——任务窗口与主窗口的写操作都会经过这里，
// 包括删除配置、新增配置、添加/删除路径、重分组、清除产物等。
// 只读与展示类通道、以及保存设置时的冗余配置项，都由 runlog 侧统一过滤。
// 浏览器端（HTTP）走 server.js，用同一套 chEvent 留痕，两边格式一致。
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
// 切换配置保存位置：复制到目标位置并删除旧位置文件（迁移式，不留两份）
function moveConfigFile(target) {
  const src = configFile;
  if (path.resolve(target) === path.resolve(src)) return { ok: true, moved: false };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(src)) fs.copyFileSync(src, target);
    try { if (fs.existsSync(src) && path.resolve(target) !== path.resolve(src)) fs.unlinkSync(src); } catch (e) {}
    const fromDir = path.dirname(src);
    configFile = target;                        // 引导文件已到新位置
    moveStorage(fromDir, path.dirname(target)); // 两个库随其后（关连接 → rename/cp → 读回校验 → 回收站源）
    return { ok: true, moved: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
// 移入系统回收站（可还原）；Electron 不可用时降级为重命名备份，绝不静默删除
function recycleFile(p) {
  try {
    const { shell } = require('electron');
    if (shell && typeof shell.trashItem === 'function') {
      shell.trashItem(p).catch(() => { try { fs.renameSync(p, p + '.bak'); } catch (e) {} });
      return true;
    }
  } catch (e) {}
  try { fs.renameSync(p, p + '.bak'); return true; } catch (e) { return false; }
}
// 回收「搬空后的对侧空壳目录」：搬迁完成后旧位置若已无任何内容则整个移入回收站，
// 否则便携版切到程序目录后会在 AppData 侧留下空文件夹（目录非空则保留，不误删用户手放的内容）
function recycleIfEmpty(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    if (fs.readdirSync(dir).length) return false;
    return recycleFile(dir);
  } catch (e) { return false; }
}
// 迁移「配置和数据保存位置」：只搬 2 个库（settings.db / cache.db）及其 -wal/-shm，不再递归搬目录树
// （引导文件由 moveConfigFile 负责）。前置：关全部连接 + 无任务在跑 —— Windows 下持有句柄会阻止移动。
// 策略：rename 优先（同盘瞬时完成），跨盘降级 cp + 读回校验 + 源文件入回收站。
function moveStorage(fromDir, toDir) {
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return { ok: true, moved: false };
  if (api && typeof api.hasRunningTasks === 'function' && api.hasRunningTasks()) {
    return { ok: false, error: '有任务正在运行，请等待任务结束后再切换保存位置' };
  }
  const moved = [];
  try {
    if (api && typeof api.closeStorageConnections === 'function') api.closeStorageConnections();
    fs.mkdirSync(toDir, { recursive: true });
    for (const base of [SETTINGS_DB, CACHE_DB]) {
      for (const name of [base, base + '-wal', base + '-shm']) {
        const p = path.join(fromDir, name);
        if (!fs.existsSync(p)) continue;
        const dst = path.join(toDir, name);
        try { fs.renameSync(p, dst); } catch (e) { fs.copyFileSync(p, dst); }
        moved.push([p, dst]);
      }
    }
    // 读回校验：目标侧必须存在且大小与源一致（rename 成功时源已不在，以目标为准）
    for (const [srcPath, dstPath] of moved) {
      let srcSize = 0, dstSize = -1;
      try { dstSize = fs.statSync(dstPath).size; } catch (e) { dstSize = -1; }
      try { srcSize = fs.statSync(srcPath).size; } catch (e) { srcSize = dstSize; }
      if (dstSize < 0 || srcSize !== dstSize) throw new Error('读回校验失败：' + path.basename(dstPath));
    }
    for (const [srcPath] of moved) { if (fs.existsSync(srcPath)) recycleFile(srcPath); } // 跨盘复制留下的源文件
    if (api && typeof api.onStorageMoved === 'function') api.onStorageMoved(toDir);
    // 运行日志随存储位置一起搬：否则切换后日志仍写旧位置、重启又写新位置，历史被割成两处。
    try {
      const oldLog = path.join(fromDir, 'log');
      const newLog = path.join(toDir, 'log');
      if (path.resolve(oldLog) !== path.resolve(newLog)) {
        runLog.close();                       // 先断开旧文件句柄，否则 Windows 上 rename 会失败
        if (fs.existsSync(oldLog)) {
          fs.mkdirSync(newLog, { recursive: true });
          for (const f of fs.readdirSync(oldLog)) {
            const s = path.join(oldLog, f);
            try { fs.renameSync(s, path.join(newLog, f)); }
            catch (e) { try { fs.copyFileSync(s, path.join(newLog, f)); } catch (e2) {} }
          }
          try { if (!fs.readdirSync(oldLog).length) fs.rmdirSync(oldLog); } catch (e) {}
        }
        runLog.init(newLog);                  // 无论搬移是否顺利，都把写入口切到新位置
      }
    } catch (e) {}
    recycleIfEmpty(fromDir); // 旧位置已搬空则整目录入回收站，避免留下空壳（非空则保留）
    return { ok: true, moved: true, count: moved.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
function defaultRoot() { return path.dirname(projectDir()); }
// 已废弃的配置键（写入设置库前一律剔除）：scripts_dir（旧脚本目录）、use_node_engine（引擎开关）。
// 代码已不再读取，但不显式剔除就会随 saveConfig 一直写回磁盘，成为永久残留。
const OBSOLETE_CONFIG_KEYS = ['scripts_dir', 'use_node_engine'];
// ── 配置读取：settings.db 为唯一业务来源，config.json 不参与业务键读取 ──
// ⚠ 业务键一律只从 settings.db 取，**不得回退读 config.json**：config 会被逐步简化，
// 任何「config 缺失就回退读它」的路径都会变成取到 undefined 的隐患（表现为设置莫名丢失）；
// 库里没有就用 DEFAULT_CONFIG 的默认值。
// config.json 仍保留并写入全部键，但只为「回滚旧版本」服务（旧版本读 config.json 时能拿到完整值）。
const CONFIG_ANCHOR_KEYS = ['config_storage'];   // 唯一仍需从 config.json 读的键

// ── 批量模式的工作目录：唯一真相 = `config.batch.root` ──
// 工作路径属于**批量模式**而非整个软件：各模式的工作目录由各模式自己承接（遮罩有自己的 `mask.root`）。
// 读取一律用 getBatchRoot()；写入一律用 setBatchRoot()。
// 顶层 `root` 只在「落盘 config.json」时作为**兼容镜像**保留（旧版本回滚仍读它）；
// 它**不写入 settings.db**（否则下次 loadConfig 读回来会形成两个真相，见 saveConfig）。
function getBatchRoot(cfg) {
  const b = cfg && cfg.batch;
  return (b && typeof b === 'object' && typeof b.root === 'string') ? b.root.trim() : '';
}
function setBatchRoot(cfg, dir) {
  if (!cfg) return;
  const v = String(dir == null ? '' : dir).trim();
  cfg.batch = Object.assign({}, cfg.batch || {}, { root: v });
  cfg.root = v;   // 兼容镜像（仅随 config.json 落盘）
}
// 待落库的工作路径迁移值：loadConfig 首阶段只能做**内存**迁移（那时 api 还没构造），
// 真正落库（写 batch.root、删旧 root）由 applySettingsFromDb 在 api 就绪后完成。
let _pendingRootMigration = '';
// 待落库的旧顶层 root 清理标记（batch.root 已就位却仍有残留 root 时置真）
let _pendingRootCleanup = false;

// 直读 settings.db 的 app scope（**不依赖 api**）。
// ⚠ 必需存在的原因：启动早期要先用 settings 里的 root 才能定位工作目录，而 api 的构造又必须先有 root ——
//   若此时只能靠 api 读设置，就形成死循环，root 只能取默认值，
//   表现为「工作目录被解析成程序目录的上一级」（进而在该盘做全量扫描，冷启动被拖到数十秒）。
//   故本函数直接从 storageDir() 派生库路径读一次，专供启动首阶段使用。
//   库读不到一律返回 null（调用方保持默认值，不回退 config.json）。
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
  const disk = readConfigDisk();
  // ② 业务键：settings.db 全量载入（库不可用时保持默认值 —— 不回退 config.json）
  const app = readSettingsApp();
  if (app) {
    // ③ 一次性迁移：旧顶层 root → batch.root。
    //    ⚠ **必须在取值循环之前**完成 —— 否则首阶段 `resolveRoot()` 取不到工作目录，
    //    会回退成程序目录的上一级（实测工作目录会落到上级目录，冷启动全量扫描 29.7 秒）。
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
      // 残留清理：batch.root 已就位却仍留着旧顶层 root —— 历史上 root 被 seed 从
      // config.json 灌回过（当时它还没被排除）；不清理会一直留着一个「假真相」。
      _pendingRootCleanup = true;
    }
    for (const k of Object.keys(app)) {
      if (app[k] === undefined || app[k] === null) continue;
      cfg[k] = app[k];
    }
    // ③ 一次性引导：settings.db 尚未落过的键，用 config.json 的同名值补齐并落库
    //    （详规见 seedSettingsFromConfig 注释）。
    const seed = seedSettingsFromConfig(disk, app);
    for (const k of Object.keys(seed)) cfg[k] = seed[k];
    // ④ 兼容镜像：settings 里已无顶层 root，用 batch.root 回填 ——
    //    保证 config.json 的 root 键跟随更新（旧版本回滚时读到的是**当前**工作路径）。
    //    该镜像只在写 config.json 时使用，不会写回 settings（见 saveConfig）。
    if (!Object.prototype.hasOwnProperty.call(app, 'root')) {
      const br = getBatchRoot(cfg);
      if (br) cfg.root = br;
    }
  } else {
    // 设置库确实读不到（api 与直读两条路都失败）—— 保持默认值，不回退 config.json。
    // ⚠ 此处**不可引用 api**：顶层首调时 const api 尚在 TDZ，即使 typeof 也会抛 ReferenceError
    //   （会让整个启动崩溃）。readSettingsApp 内部已做 try 探测，走到这里就是真读不到。
    try { runLog.sys('app.config', '设置库不可用：本次按默认值运行（不回退 config.json）', {}); } catch (e) {}
  }
  // ④ 锚点键：仅 config_storage（定位数据目录所必需，库路径由它派生，无法自举）
  for (const k of CONFIG_ANCHOR_KEYS) {
    if (disk[k] !== undefined && disk[k] !== null) cfg[k] = disk[k];
  }
  // ⑤ 开发者开关 show_maintenance：前端无控件，只认 config.json（编辑器直改即生效），不随 settings.db
  cfg.show_maintenance = (disk && typeof disk.show_maintenance === 'boolean')
    ? disk.show_maintenance
    : DEFAULT_CONFIG.show_maintenance;
  for (const k of OBSOLETE_CONFIG_KEYS) delete cfg[k];
  return cfg;
}
// 读 config.json 全量内容（读不到返回空对象）；顺带清理上次中断遗留的临时文件
function readConfigDisk() {
  try {
    const p = configFilePath();
    try { if (fs.existsSync(p + '.tmp')) fs.unlinkSync(p + '.tmp'); } catch (e2) {}
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (e) { return {}; }
}
// 一次性引导：settings.db 尚未落过的键，用 config.json 的同名值补齐并落库。
//   这是「修好断点」而非数据迁移 —— 补齐之后读路径完全只认 settings，config.json 不再被读。
//   幂等：仅写 settings 里**不存在**的键，已落过库的值绝不覆盖；config.json 没有该键就跳过
//   （留给 DEFAULT_CONFIG 默认值，不用默认值充数写库，避免污染「哪些键是用户真设过的」语义）。
// ⚠ 不参与引导的键（SEED_EXCLUDE_KEYS）必须显式排除，否则会出现「删了又被灌回来」：
//   顶层 `root` 是 config.json 的**兼容镜像**（真相在 batch.root），迁移时会被删掉；
//   而 loadConfig() 每次调用（如 get_settings）都会跑一次本引导 —— 若 root 参与引导，
//   它会被 config.json 的同名键立刻灌回 settings（删掉马上又回来）。
const SEED_EXCLUDE_KEYS = CONFIG_ANCHOR_KEYS.concat(OBSOLETE_CONFIG_KEYS).concat([
  'root',   // 兼容镜像键：只写 config.json，真相是 batch.root
]);
function seedSettingsFromConfig(disk, app) {
  const seed = {};
  try {
    for (const k of Object.keys(disk || {})) {
      if (SEED_EXCLUDE_KEYS.indexOf(k) >= 0) continue;
      if (Object.prototype.hasOwnProperty.call(app || {}, k)) continue;
      if (disk[k] === undefined || disk[k] === null) continue;
      seed[k] = disk[k];
    }
    if (Object.keys(seed).length) {
      writeSettingsApp(seed);
      try { runLog.sys('app.config', '设置库首次引导（' + Object.keys(seed).length + ' 项，取自 config.json）', { keys: Object.keys(seed) }); } catch (e) {}
    }
  } catch (e) {}
  return seed;
}
// 保存配置：以「实际变更的键」为单位落盘，避免每次保存全量重写两侧。
//  ① settings.db（唯一读取来源）：写入本次变更的键；
//  ② config.json（仅为回滚旧版本而留的兼容快照）：**只更新本文件原本就有的键** ——
//     代码新引入的键不写进去（旧版本不认识它们，写了只是污染）。
// 变更判定以 _configBaseline（最近一次落盘的快照）为基准，而非入参本身 —— 调用方普遍
// 先改内存 config 再 saveConfig(config)，若拿入参自比会得出「零变更」。
// 返回本次实际变更的键名数组（供调用方按需广播/重排定时器）。
let _configBaseline = {};
function saveConfig(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const keys = Object.keys(cfg).filter((k) => OBSOLETE_CONFIG_KEYS.indexOf(k) < 0);
  const changed = {};
  for (const k of keys) {
    if (!_configValueEqual(_configBaseline[k], cfg[k])) changed[k] = cfg[k];
  }
  // 基线同步（无论是否有变更：入参即当前真值，下次比对以它为准）
  _configBaseline = JSON.parse(JSON.stringify(cfg));
  if (!Object.keys(changed).length) return [];
  // settings.db 不落顶层 root：它已被 batch.root 取代，只作 config.json 的兼容镜像存在。
  // 若写进 settings，下次 loadConfig 会把它读回内存 → 形成两个真相
  // （用户改工作路径时可能只更新其中一个，工作目录随之错乱）。
  const forSettings = Object.assign({}, changed);
  delete forSettings.root;
  if (Object.keys(forSettings).length) writeSettingsApp(forSettings);
  // config.json：仅合并「磁盘上已存在的键」，不新增键
  try {
    const p = configFilePath();
    let disk = {};
    try { if (fs.existsSync(p)) disk = JSON.parse(fs.readFileSync(p, 'utf-8')) || {}; } catch (e) { disk = {}; }
    if (!disk || typeof disk !== 'object' || Array.isArray(disk)) disk = {};
    let touched = false;
    for (const k of Object.keys(changed)) {
      if (!Object.prototype.hasOwnProperty.call(disk, k)) continue;   // 旧版本没有的键：不新增
      if (_configValueEqual(disk[k], changed[k])) continue;
      disk[k] = changed[k];
      touched = true;
    }
    if (touched) {
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      // 原子写：主配置写坏会丢设置与工作路径，先写临时文件再 rename 覆盖
      fs.writeFileSync(p + '.tmp', JSON.stringify(disk, null, 2), 'utf-8');
      fs.renameSync(p + '.tmp', p);
    }
  } catch (e) {
    try { if (fs.existsSync(configFilePath() + '.tmp')) fs.unlinkSync(configFilePath() + '.tmp'); } catch (e2) {}
  }
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
// 落盘统一由 saveConfig 完成：settings.db 是唯一读取来源，config.json 仅作旧版本兼容快照
// （只更新它原本就有的键）。故此处只做「把提交值合入 cfg」，不再区分新旧键、不再单独落库。
// ⚠ 必须是模块级函数：HTTP 版 save_settings（buildHttpExtraRoutes 内）与 IPC 版都要调用，
//    若定义在 registerIpc 内则 HTTP 路径取不到（会报 mergeAppSettings is not defined，
//    浏览器端保存应用级设置静默失败）。
function mergeAppSettings(cfg, s) {
  if (!s || typeof s !== 'object') return cfg;
  if (typeof s.notify_task_end === 'boolean') cfg.notify_task_end = s.notify_task_end;
  if (typeof s.show_maintenance === 'boolean') cfg.show_maintenance = s.show_maintenance;
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
// 库与引导文件同目录（扁平布局）：不再有 Cache\ / Config\ 中间层，也不需要「配置侧 / 缓存侧对齐」
const { migrateToFlatLayout, listStagingDirs } = require(path.join(resolveEnginesDir(), 'base', 'migrate.js'));
// 库路径一律由 storageDir() 派生（见上方定义）：不存在需要重算的路径，杜绝「写回旧位置」类 bug
// 一次性布局迁移：旧布局（Cache\ + Config\ + config 同级旧设置文件）→ 三库（config.json / settings.db / cache.db）。
// 每次启动执行且幂等（逐条 upsert 合并，便于回退旧版后再升级收敛）；校验通过才把旧物暂存，失败则保持旧布局可启动。
// 暂存目录交由 app ready 后的回收任务（启动早期调用 shell.trashItem 不可靠）。
const pendingTrashDirs = [];
try {
  const mr = migrateToFlatLayout({ configDir: path.dirname(configFile), log: (m) => console.log(m) });
  if (mr.migrated && mr.stagingDir) pendingTrashDirs.push(mr.stagingDir);
  if (mr.errors && mr.errors.length) console.error('[migrate] ' + mr.errors.join('；'));
} catch (e) { console.error('[migrate] 迁移异常：' + ((e && e.message) || e)); }
for (const d of listStagingDirs(path.dirname(configFile))) {
  if (pendingTrashDirs.indexOf(d) < 0) pendingTrashDirs.push(d); // 回收上次运行未及清理的暂存目录
}
if (pendingTrashDirs.length) {
  app.whenReady().then(() => { for (const d of pendingTrashDirs) { try { recycleFile(d); } catch (e) {} } });
}
const api = new Api(root, config, resolveEnginesDir(), storageDir());
// ── 设置库载入（两阶段之二）：api 就绪后用 settings.db 的真实值覆盖内存 config ──
// 为什么分两阶段：loadConfig() 需要 api 才能读 settings.db，而 api 的构造又需要 config.root
// （库路径由 storageDir 派生，无法自举）。故顶层先用「锚点 + 默认值」建 api，再用真值覆盖。
// 覆盖范围 = 业务键全集：凡 settings.db 里有的键，一律以库值为准（不回退 config.json）。
// 本段同时承担**首次引导**：顶层 loadConfig 调用时 api 尚未存在，引导无法执行；到此处补齐。
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
    // 首次引导：settings.db 尚未落过的键用 config.json 同名值补齐（幂等，详见 seedSettingsFromConfig）
    const seed = seedSettingsFromConfig(readConfigDisk(), app);
    for (const k of Object.keys(seed)) config[k] = seed[k];
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
      // 清理残留的旧顶层 root（batch.root 已是真相；留着它会被 seed 反复灌回、形成两个真相）
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
// FFmpeg 环境自愈进度：主窗（更新浮窗复用）+ 设置窗（维护区行内进度）双通道
api.onFfmpegProgress = (p) => {
  sendToMain('env_fix_progress', p);
  sendToSettings('env_fix_progress', p);
};
// 运行期环境失效（用的时候才发现的 ffmpeg/ffprobe 不可用）：
// 横幅（可一键下载修复）+ 吐司（更醒目的即时提示）双通道，两个窗口都发。
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
// 注：扫描小窗（scanWin / scanning.html）已移除 —— 扫描全程后台，不再需要独立的进度窗口
//（预检测与扫描均不弹前台窗，进度写状态栏与运行日志）。

// 按需预热扫描：**只在用户主动唤起主窗口时调用**（托盘点击 / 再次双击图标 / 托盘菜单）。
// 开机自启（--autostart）是静默常驻托盘形态，用户很可能根本不打开界面 ——
// 那种情况下绝不弹小窗、也不预热，避免无谓打扰与机械盘唤醒占用。
// 唤起时若扫描缓存已失效（工作目录结构变了），补一次扫描并弹小窗反馈；
// 缓存有效则静默放行（连小窗都不出现）。
// 小窗延迟 1.2 秒出现：先让主窗口画出来，避免"刚弹出小窗又立刻关掉"的抖动。
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
      // 唤起时同样后台扫描：不弹小窗、也不推迟窗口显示
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
// 托盘图标单例：图标文件在 asar 内、体积小，但 createFromPath 是同步读盘 ——
// 冷态 + 安全软件扫描下首次读取可能被放大，故只构建一次并复用。
let _trayIcon = null;
function trayIcon() {
  if (_trayIcon) return _trayIcon;
  const img = nativeImage.createFromPath(path.join(ICON_DIR, 'tray-icon.png'));
  for (const rep of ['tray-icon@1.25x.png', 'tray-icon@1.5x.png', 'tray-icon@2x.png']) {
    img.addRepresentation(nativeImage.createFromPath(path.join(ICON_DIR, rep)));
  }
  _trayIcon = img.isEmpty() ? nativeImage.createEmpty() : img;
  return _trayIcon;
}
function showMainWindow() {
  // 托盘唤出计时：用于定位「点托盘要等很久、窗口迟迟不出现」。
  // 主进程只能测到 show() 调用本身返回的耗时；窗口是否真的画出来要看渲染侧首帧，
  // 故同时向渲染进程要一次 rAF 双帧确认，两个数字分开记 —— 若 show() 很快而首帧很慢，
  // 说明卡在渲染/合成（主进程事件循环被占住时最典型）。
  const _t = process.hrtime.bigint();
  const needRebuild = !mainWin || mainWin.isDestroyed();
  if (needRebuild) createWindow();
  mainWin.show();
  mainWin.focus();
  const ms = Number(process.hrtime.bigint() - _t) / 1e6;
  // 用户主动唤起：若扫描缓存已失效则补扫并弹小窗（自启形态启动时跳过了预热）。
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
  tray.setToolTip('Video Lab');
  // 左键直接唤起主窗口；右键唤出自绘托盘菜单
  // ⚠ 点击留痕放在回调**最前**：出现「图标在、点不动」时，这两条能区分两种情况 ——
  //   ① 日志里没有「托盘收到点击」→ 事件根本没送达主进程（托盘对象异常）
  //   ② 有「托盘收到点击」但没有后续「托盘唤出主窗口」→ 回调执行了但被卡在 show() 之前
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
// 自绘托盘菜单窗口：皮肤变量从主窗口实时读取注入（单一来源，避免皮肤定义重复漂移）；
// 高度按内容自适应，锚定托盘图标上方弹出，失去焦点自动收起
let trayMenuWin = null;
const TRAY_MENU_W = 200;
function hideTrayMenu() { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); }
async function showTrayMenu() {
  const fresh = !trayMenuWin || trayMenuWin.isDestroyed();
  if (fresh) {
    // ⚠ 不用透明窗口（transparent）：Windows 上透明窗口每次 show 都要重新合成，
    //   表现为"打开必闪一帧"，且等重绘也治不好。
    //   改用不透明窗口 + 系统圆角（Win11 默认 roundedCorners），窗口背景色在注入皮肤变量后
    //   用 setBackgroundColor 对齐 --bg-base-default，圆角外不会露出杂色。
    trayMenuWin = new BrowserWindow({ width: TRAY_MENU_W, height: 60, show: false, frame: false, transparent: false, roundedCorners: true, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    trayMenuWin.setMenu(null);
    trayMenuWin.loadFile(path.join(__dirname, 'frontend', 'trayMenu.html'));
    trayMenuWin.on('blur', () => { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); });
    trayMenuWin.on('closed', () => { trayMenuWin = null; });
    // 等 ready-to-show（首帧已绘制）而非 did-finish-load：后者只代表文档加载完，
    // 此时 show 仍可能先出现空白/半透明窗再刷出内容 —— 表现为托盘菜单"闪一下"
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
      // 窗口已改为不透明：取皮肤的 --bg-base-default 作为窗口背景色，
      // 使圆角外的矩形角落与菜单底色一致（否则会露出默认白/黑角）
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
  // 定位：以鼠标指针为锚点，菜单从鼠标右上紧贴弹出（右边界贴 x、下边界贴 y）；
  // 钳制按整屏 bounds（允许覆盖任务栏区域），越界时再就近收拢
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
// 视频处理工具窗口：独立于主窗口的**非模态**窗口（可与主窗口并排、同时操作；
// 关掉窗口不影响正在跑的任务；任务结果回主窗口任务列表查看）
let toolWin = null;
function createToolWindow() {
  // 复用已有窗口：关闭时只 hide 不销毁，这里需显式 show 回前台（focus 不会让隐藏窗口出现）
  if (toolWin && !toolWin.isDestroyed()) { try { if (!toolWin.isVisible()) toolWin.show(); } catch (e) {} toolWin.focus(); return toolWin; }
  // 尺寸=主窗口（1360×860）同比例缩小到 0.75：1020×645 —— 一眼看出是同一套界面的小窗
  toolWin = new BrowserWindow({
    title: 'Video Lab - 视频处理', width: 1020, height: 645, minWidth: 760, minHeight: 520,
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
  // 关闭只隐藏、不销毁：工具窗带整套皮肤资源（女仆皮肤 64KB CSS + 1.7MB 图片），
  // 每次重建都要重新加载解码 —— 正是"每次打开都有刷新感"的来源；hide 复用后再次打开瞬时显示。
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
  taskWin = new BrowserWindow({ title: 'Video Lab - 任务', width: 760, height: 620, resizable: false, maximizable: false, minimizable: false, frame: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
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
// 设置面板：改为在主窗口内以 iframe 显示（原独立设置窗口已取消）。
// 为什么：设置页带整套皮肤资源（女仆皮肤 64KB CSS + 1.7MB 图片），独立窗口每次打开都要
// 重新创建窗口并重新加载解码 —— 这是"每次打开都有刷新感"的来源；内嵌后打开即显示、关闭仅隐藏。
// 附带收益：少一套窗口生命周期管理（关闭拦截/失焦关闭/未保存提醒一并不再需要）。
let settingsPanelOpen = false;
function openSettingsWindow() {
  settingsPanelOpen = true;
  // 通知主窗口：显示模糊遮罩 + 内嵌设置页 iframe
  try {
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
      mainWin.webContents.send('settings_window_opened');
    }
    // ⚠ 刻意**不广播**：内嵌设置面板是软件端主窗口的 UI 状态；广播会让浏览器端主页面也弹出设置面板，
    //   而浏览器端没有 IPC 通道去关闭它（表现为「浏览器端那个关不掉，得软件端关」）。
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
  // 关闭后把主窗口提回前台：面板里可能开过资源管理器（打开日志/选择目录），
  // explorer 会压在 Z 序上方，Windows 激活的常常不是主窗
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
// 便携版：只检查 + 下载，更新包落地后由「打开更新文件」在资源管理器中选中，用户关闭应用后自行解压覆盖；
//         安装过程不经应用代码（早期曾实现自动安装脚本，因调试不稳定已弃用）
// setup 安装版：electron-updater 静默升级安装并重启
const UPDATE_ENABLED = true;
const GITHUB_REPO = 'HirannU-OVO/video-lab';
// 国内仓库已由 Gitee 迁至 GitCode（仓库路径与 GitHub 同名，仅域名不同）
const GITCODE_REPO = 'HirannU-OVO/video-lab';
const UPDATE_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
// GitCode release 检查地址（与 Gitee 同款 API 结构：tag_name + assets[]；
// 读接口匿名可用、无需令牌；⚠ assets 无 size 字段，大小为 0 时须走兜底）
const GITCODE_API_URL = 'https://api.gitcode.com/api/v5/repos/' + GITCODE_REPO + '/releases/latest';
// 当前更新源（跟随设置 update_source，动态切换 GitHub / GitCode）
// ⚠ 历史配置里的 'gitee' 一律按 'gitcode' 处理 —— Gitee 已停止更新（最后一版停在 2.5.0），
//   若沿用旧值继续走 Gitee，老用户将永远收不到新版本。
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
// GitHub 加速前缀链：许多机器直连 GitHub 慢/不稳，更新检查与下载按序尝试各加速站（实测
// gh-proxy.com 最快），全部不可达最后回退直连；增删/换加速站只需改 UPDATE_PROXIES
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
//   · 窗口 UI 状态（settings_window_*）同理：那是软件端窗口的事。
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
// 更新链路日志：不落盘（保留调用点，便于需要时接回）
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
// 带断点续传的流式下载：支持 HTTP Range 续传（206）、已完整（416）、错误页拦截；
// 中断时保留已下载部分文件，供重试 / 下次继续
function netDownload(url, dst, onProgress, expectedSize) {
  return new Promise((resolve, reject) => {
    let start = 0;
    try { start = fs.existsSync(dst) ? fs.statSync(dst).size : 0; } catch (e) { start = 0; }
    let req;
    try { req = net.request({ url, method: 'GET', redirect: 'follow', headers: start > 0 ? { 'Range': 'bytes=' + start + '-' } : {} }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch (e2) {} reject(new Error('下载超时')); }, 120000);
    req.on('response', (res) => {
      const h = res.headers || {};
      const status = res.statusCode || 0;
      if (status >= 400) { clearTimeout(timer); reject(new Error('HTTP ' + status)); return; }
      if (status === 416) { clearTimeout(timer); resolve({ ok: true, complete: true }); return; } // 范围超出 = 文件已完整
      const cl = Array.isArray(h['content-length']) ? h['content-length'][0] : (h['content-length'] == null ? '' : String(h['content-length']));
      let total = expectedSize || parseInt(cl, 10) || 0;
      const resume = start > 0 && status === 206;
      if (resume) {
        const cr = h['content-range'];
        const crv = Array.isArray(cr) ? cr[0] : cr;
        const m = crv ? /(\d+)\/(\d+|\*)/.exec(String(crv)) : null;
        if (m && m[2] !== '*') total = parseInt(m[2], 10) || total;
      }
      let received = resume ? start : 0;
      const ws = fs.createWriteStream(dst, { flags: resume ? 'a' : 'w' });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      res.on('data', (chunk) => { ws.write(chunk); received += chunk.length; if (total && onProgress) onProgress(Math.min(100, Math.round((received / total) * 100))); });
      res.on('end', () => { ws.end(); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); }); // 中断：保留部分文件供续传
      ws.on('finish', () => { clearTimeout(timer); resolve({ ok: true, size: received }); });
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
    //
    // 便携分发形态改为下载 Setup 安装包
    //   —— 2.5.1 起不再把便携包当作升级目标，便携版用户升级即改用安装版（设置与数据由静默搬迁保留）。
    //   形态判定用 isPortableDistribution()（== 程序目录无 Uninstall*.exe），不用 IS_PORTABLE（见其注释）。
    //   非便携分发形态保持旧规则找便携包，以免影响既有发布兼容期行为。
    // 历史分卷兼容：老版本（≤2.5.0）发布在 Gitee 时因单附件 100MB 限制，便携包曾按
    // xxx.zip.001/.002 分卷上传；GitCode 附件上限宽裕、今后不再分卷，此处保留识别能力以兼容旧资产
    const portableDist = isPortableDistribution();
    const setupRe = /^Video-Lab-.*-x64-Setup\.exe$/i;
    const portableRe = /^Video-Lab-.*-x64-Portable\.zip$/i;
    const partRe = /^(Video-Lab-.*-x64-Portable\.zip)\.(\d{3,})$/i;
    let asset = portableDist
      ? (assets.find((a) => setupRe.test(String(a.name || ''))) || null)
      : (assets.find((a) => portableRe.test(String(a.name || ''))) || null);
    let parts = [];
    if (!asset && !portableDist) {
      const group = new Map();
      for (const a of assets) {
        const m = partRe.exec(String(a.name || ''));
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (!group.has(key)) group.set(key, []);
        group.get(key).push({ name: a.name, url: a.browser_download_url, size: a.size || 0, index: parseInt(m[2], 10) });
      }
      for (const list of group.values()) {
        list.sort((x, y) => x.index - y.index);
        if (list.length >= 2 && list.every((p, i) => p.index === list[0].index + i)) { parts = list; break; }
      }
    }
    // release 资产的 digest 为 sha256:<hex>，作为下载完整性校验依据（分卷组一般无 digest）
    const sha256 = (asset && asset.digest && String(asset.digest).replace(/^sha256:/i, '')) || '';
    const hasUpdate = cmpVersion(tag, APP_VERSION) > 0;
    // assetName：资产原名，下载落地即用它
    const assetName = asset ? String(asset.name || '') : '';
    const info = {
      ok: true, current: APP_VERSION, latest: tag || '', hasUpdate,
      url: asset ? asset.browser_download_url : (parts.length ? parts[0].url : ''),
      size: asset ? asset.size : parts.reduce((s, p) => s + (p.size || 0), 0),
      parts, sha256, sha512: '', assetName, error: '',
      // 回执要标明**实际用的**仓库：用户切了源没保存就点检查，界面值已被 applyUpdatePref 落盘，
      // 这里回传它就是"实际走的那个"；不带这个字段，用户无从确认，只能看到一句结论
      source: currentUpdateSource()
    };
    // 完整性校验依据补齐：GitCode 的 release 资产不带 digest / size →
    // **便携分发**（唯一走自研下载的形态：下 Setup.exe）从**同 release 的 latest.yml** 取 sha512。
    // ⚠ 不再自造 update-info.yml —— Setup 的校验依据 latest.yml 里本来就有；
    //   它缺的 size 由下载层兜底：netDownload 用响应头 Content-Length 作总长度，进度不受影响。
    // ⚠ 也不再读 portable-info.yml：它当初是为「便携版下载便携包」补依据，
    //   而 A4 起便携分发改下 Setup、非便携分发直接走 electron-updater（不来自研下载），该分支已无消费者。
    // ⚠ 两源地址形式不同：GitHub 用 releases/latest/download；**GitCode 必须带 tag**
    //   （实测 GitCode 的 latest/download 会返回 HTML 页面而非文件）。
    if (portableDist && asset && !info.sha512) {
      const base = currentUpdateSource() === 'github'
        ? 'https://github.com/' + GITHUB_REPO + '/releases/latest/download/'
        : 'https://gitcode.com/' + GITCODE_REPO + '/releases/download/' + tagRaw + '/';
      try {
        const lr = await netGet(base + 'latest.yml', 8000);
        if (lr.status === 200) {
          const got = parseLatestYml(lr.body.toString('utf-8'), assetName);
          if (got && got.sha512) { info.sha512 = got.sha512; writeUpdateLog('已从 latest.yml 取得 sha512（资产无 digest 时回退）'); }
          else writeUpdateLog('latest.yml 内未找到与本资产匹配的 sha512');
        } else writeUpdateLog('latest.yml 不可用（HTTP ' + lr.status + '），本次无哈希依据');
      } catch (e) { writeUpdateLog('latest.yml 读取失败（仅少一层校验依据，不影响更新）：' + ((e && e.message) || e)); }
    }
    lastUpdateInfo = info;
    writeUpdateLog('检查成功：current=' + APP_VERSION + ' latest=v' + tag + ' hasUpdate=' + hasUpdate + ' (' + (Date.now() - t0) + 'ms)');
    if (hasUpdate) {
      if (asset || parts.length) {
        // 更新方式=自动检查并下载：发现新版本立即自动下载，不弹「发现新版本」提示条；
        // 进度直接走主窗口状态栏，下载完成后再弹「更新并重启」操作条；启动/定时/手动检查均生效
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
        // 文案不写死资产类型：便携分发找 Setup、其他形态找便携包，普通用户也不必知道资产叫什么
        if (!silent && notifyMain) sendToMain('update_none', Object.assign({}, info, { message: '发现新版本，但发布缺少安装文件' }));
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
// 解析 electron-builder 生成的 latest.yml，取指定文件名的 sha512（base64）。
// 结构形如：
//   version: 2.5.0
//   files:
//     - url: Video-Lab-2.5.0-x64-Setup.exe
//       sha512: xxxx==
//   path: Video-Lab-2.5.0-x64-Setup.exe
//   sha512: xxxx==
// 按行解析（不引入 yaml 依赖）：先按 `- url:` 分组，再取组内 sha512；wantName 命中优先，
// 否则退回「任意带 sha512 的条目」；顶层 sha512 作为最后兜底。
function parseLatestYml(txt, wantName) {
  const out = [];
  let cur = null;
  for (const ln of String(txt || '').split(/\r?\n/)) {
    let m = /^\s*-\s*url:\s*(\S+)/.exec(ln);
    if (m) { cur = { url: m[1], sha512: '' }; out.push(cur); continue; }
    m = /^\s*sha512:\s*(\S+)/.exec(ln);
    if (m) {
      if (cur && !cur.sha512) cur.sha512 = m[1];
      else if (!cur) out.push({ url: '', sha512: m[1] });   // 顶层 sha512（files 为空时）
    }
  }
  if (wantName) {
    const hit = out.find((x) => x.url === wantName && x.sha512);
    if (hit) return hit;
  }
  return out.find((x) => x.sha512) || null;
}
// 下载最新便携包到程序根目录（便携版：用户自行关闭应用后解压覆盖）。
// 支持断点续传 + 自动重试（共 4 次尝试）：网络中断保留部分文件续传，哈希校验失败清空重下
async function downloadUpdate(info, onProgress, onStatus) {
  const dir = projectDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // 落地文件名：A4 起便携分发下载的是 Setup.exe，故按资产原名落地；无 assetName（分卷场景）时按便携包名，供拼回
  const ver = String(info.latest || '').replace(/^v/i, '');
  const dlName = String(info.assetName || '') || ('Video-Lab-' + ver + '-x64-Portable.zip');
  const zipPath = path.join(dir, dlName);
  // Gitee 分卷：逐卷下载到 zipPath.partXXX 后拼回完整 zip
  if (info.parts && info.parts.length > 0) return downloadUpdateParts(info, zipPath, onProgress, onStatus);
  const t0 = Date.now();
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (onStatus) {
      if (attempt === 1) onStatus('正在下载更新（首次尝试）…');
      else onStatus('下载中断，正在重试（' + attempt + '/4）…');
    }
    try {
      let dl = null;
      let accelErr = '';
      for (const cand of accelUrls(info.url)) {
        try {
          dl = await netDownload(cand, zipPath, onProgress, info.size);
          accelErr = '';
          break;
        } catch (ep) {
          accelErr = (ep && ep.message) || String(ep);
          writeUpdateLog('下载源不可用：' + cand + ' → ' + accelErr);
        }
      }
      if (!dl) throw new Error(accelErr || '下载失败');
      if (dl.complete) return { ok: true, zipPath };
      const size = (() => { try { return fs.statSync(zipPath).size; } catch (e) { return 0; } })();
      // 完整性：sha512（latest.yml，便携分发下 Setup）与 sha256（release digest 或 portable-info.yml）取其一；
      // 两者都没有才退回字节数比对（下载层已用 Content-Length 兜底总长度）
      if (info.sha512 || info.sha256) {
        if (onStatus) onStatus('正在校验更新包完整性…');
        if (info.sha512) {
          const a512 = await sha512Base64File(zipPath);
          if (a512 !== String(info.sha512)) throw new Error('哈希校验失败：期望 ' + String(info.sha512).slice(0, 12) + '… 实际 ' + a512.slice(0, 12) + '…');
        } else {
          const actual = await sha256File(zipPath);
          if (actual !== String(info.sha256).toLowerCase()) throw new Error('哈希校验失败：期望 ' + String(info.sha256).slice(0, 12) + '… 实际 ' + actual.slice(0, 12) + '…');
        }
      } else if (info.size && size !== info.size) {
        throw new Error('下载大小不匹配：' + size + '/' + info.size);
      }
      writeUpdateLog('下载完成：' + size + ' 字节，校验通过（尝试 ' + attempt + '/4，' + (Date.now() - t0) + 'ms）');
      return { ok: true, zipPath };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      writeUpdateLog('下载失败（尝试 ' + attempt + '/4）：' + lastErr);
      if (/哈希校验失败/.test(lastErr)) { try { fs.unlinkSync(zipPath); } catch (u) {} } // 校验失败：清空重下（续传可能延续损坏）
      if (attempt < 4) { if (onStatus) onStatus('下载失败（' + lastErr + '），正在重试…'); await new Promise((r) => setTimeout(r, 1500)); } // 间隔后重试（断点续传）
    }
  }
  writeUpdateLog('下载失败：' + lastErr);
  return { ok: false, error: lastErr };
}
// Gitee 分卷下载：info.parts 为同一便携 zip 的 .001/.002… 分卷（已按序号排序），
// 逐卷经断点续传下载到 zipPath.partXXX，全部完成后按序拼回 zipPath 并校验总大小
async function downloadUpdateParts(info, zipPath, onProgress, onStatus) {
  const parts = info.parts;
  const total = info.size || parts.reduce((s, p) => s + (p.size || 0), 0);
  const partDst = (p) => zipPath + '.part' + String(p.index).padStart(3, '0');
  const t0 = Date.now();
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (onStatus) onStatus(attempt === 1 ? '正在下载更新分卷（' + parts.length + ' 卷）…' : '分卷下载中断，正在重试（' + attempt + '/4）…');
    try {
      // 逐卷下载（netDownload 自带断点续传，中断保留局部继续）
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const dst = partDst(part);
        let dl = null, accelErr = '';
        for (const cand of accelUrls(part.url)) {
          try {
            dl = await netDownload(cand, dst, function () {
              try {
                const done = parts.slice(0, i).reduce((s, p) => s + (p.size || 0), 0) + fs.statSync(dst).size;
                if (total && onProgress) onProgress(Math.min(100, Math.round((done / total) * 100)));
              } catch (e) {}
            }, part.size || 0);
            accelErr = '';
            break;
          } catch (ep) {
            accelErr = (ep && ep.message) || String(ep);
            writeUpdateLog('分卷下载源不可用：' + cand + ' → ' + accelErr);
          }
        }
        if (!dl) throw new Error(accelErr || ('分卷下载失败：' + part.name));
      }
      // 按序拼接成完整 zip
      const ws = fs.createWriteStream(zipPath, { flags: 'w' });
      for (const part of parts) {
        const buf = fs.readFileSync(partDst(part));
        await new Promise((resolve, reject) => ws.write(buf, (err) => (err ? reject(err) : resolve())));
      }
      await new Promise((resolve) => ws.end(resolve));
      // 清理分卷临时文件
      for (const part of parts) { try { fs.unlinkSync(partDst(part)); } catch (e) {} }
      const size = (() => { try { return fs.statSync(zipPath).size; } catch (e) { return 0; } })();
      if (total && size !== total) throw new Error('分卷合并后大小不匹配：' + size + '/' + total);
      // 分卷场景只出现在便携包（latest.yml 不含它）→ 正常只有 sha256；此处一并兼容 sha512 以防万一
      if (info.sha512 || info.sha256) {
        if (onStatus) onStatus('正在校验更新包完整性…');
        if (info.sha512) {
          const a512 = await sha512Base64File(zipPath);
          if (a512 !== String(info.sha512)) throw new Error('哈希校验失败：期望 ' + String(info.sha512).slice(0, 12) + '… 实际 ' + a512.slice(0, 12) + '…');
        } else {
          const actual = await sha256File(zipPath);
          if (actual !== String(info.sha256).toLowerCase()) throw new Error('哈希校验失败：期望 ' + String(info.sha256).slice(0, 12) + '… 实际 ' + actual.slice(0, 12) + '…');
        }
      }
      writeUpdateLog('分卷下载合并完成：' + size + ' 字节，校验通过（尝试 ' + attempt + '/4，' + (Date.now() - t0) + 'ms）');
      return { ok: true, zipPath };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      writeUpdateLog('分卷下载失败（尝试 ' + attempt + '/4）：' + lastErr);
      if (/哈希校验失败/.test(lastErr)) { try { fs.unlinkSync(zipPath); } catch (u) {} }
      if (attempt < 4) { if (onStatus) onStatus('分卷下载失败（' + lastErr + '），正在重试…'); await new Promise((r) => setTimeout(r, 1500)); }
    }
  }
  writeUpdateLog('分卷下载失败：' + lastErr);
  return { ok: false, error: lastErr };
}
// 便携版更新包落地后由用户自行解压覆盖（早期自动安装脚本因调试不稳定已弃用，见文件头「自动更新」说明）
let lastDownload = null; // 已下载但未安装的更新包 { zipPath, info }，等待用户二次确认（UPDATE_ENABLED 下使用）

// ═══ setup 安装版更新（electron-updater）═══
// 检测环节复用上方 GitHub API 的 checkForUpdate；下载/安装阶段经 electron-updater：
// 下载时读 resources/app-update.yml（publish provider=generic）→ 拉取 latest.yml → 下载 setup 安装包；
// 安装时 quitAndInstall 静默升级（NSIS /S）后自动重启。仅 setup 版 require，便携版不加载。
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

// 用户点击「立即更新」：仅下载更新包（两步式第一步，需 UPDATE_ENABLED）。
// 统一互斥：同一时刻仅一个下载；已有下载完成的更新包直接复用不重复下载
async function startUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  if (lastDownload) {
    sendToMain('update_downloaded', lastDownload.info || { ok: true, current: APP_VERSION });
    return { ok: true, downloaded: true };
  }
  if (updateBusy) return { ok: false, busy: true, error: '已有更新操作进行中，请稍候' };
  updateBusy = true;
  try {
    // 操作一开始就给前端反馈（立即出现 0% 状态栏进度，避免"点了没反应"）
    sendToMain('update_downloading', Object.assign({}, lastUpdateInfo || {}, { percent: 0 }));
    // 安装形态：走 electron-updater 下载 setup 安装包。
    // 便携分发形态（解压即用，判定见 isPortableDistribution —— 不可用 IS_PORTABLE，真实便携包该值为 false）：
    //   走下方自研下载 —— A4 起下载的是 Setup.exe，随后由 portableApplyUpdate 完成「搬迁 + 线索 + 退出 + 拉起安装程序」。
    if (!isPortableDistribution()) {
      sendToMain('update_status', '正在连接更新服务器…');
      return await runSetupStartUpdate();
    }
    let info = lastUpdateInfo;
    if (!info || !info.ok || !info.hasUpdate || !info.url) {
      sendToMain('update_status', '正在连接更新服务器…');
      info = await checkForUpdate({ silent: true });
    }
    if (!info || !info.ok) {
      // 顶层已发 0%：失败必须有收尾事件，否则状态栏进度卡住
      sendToMain('update_error', { message: '检查更新失败：' + ((info && info.error) || '未知错误') });
      return { ok: false, error: (info && info.error) || '检查更新失败' };
    }
    if (!info.hasUpdate) {
      sendToMain('update_none', { current: APP_VERSION, message: '暂无可用更新' });
      return { ok: false, error: '暂无可用更新' };
    }
    if (!info.url) {
      // 文案中性（便携分发找 Setup、其他形态找便携包）：说清现象 + 下一步，不提资产名
      sendToMain('update_error', { message: '发布缺少安装文件，请稍后再试' });
      return { ok: false, error: '发布缺少安装文件' };
    }
    const dl = await downloadUpdate(info, (p) => sendToMain('update_downloading', Object.assign({}, info, { percent: p })), (text) => sendToMain('update_status', text));
    if (!dl.ok) {
      sendToMain('update_error', { error: dl.error, message: '下载失败：' + dl.error });
      return { ok: false, error: dl.error };
    }
    lastDownload = { zipPath: dl.zipPath, info };
    writeUpdateLog('更新包下载就绪：' + dl.zipPath);
    sendToMain('update_downloaded', info);
    return { ok: true, downloaded: true };
  } finally {
    updateBusy = false;
  }
}
// 便携分发形态的「下载并安装」。
// 时序不可颠倒：① 确保搬迁完成（复制到 appdata + 源侧三库改名 .migrated 防 mtime 反超）
//   → ② 写线索 → ③ 应用退出 → ④ 拉起已校验的 Setup.exe（便携用户借此平稳转成安装版）。
// 这样无论安装程序是否走完整流程，用户数据都已在新位置：装完打开新版即见旧设置（零操作无感）。
function portableApplyUpdate() {
  if (!lastDownload || !lastDownload.zipPath || !fs.existsSync(lastDownload.zipPath)) {
    return { ok: false, error: '更新文件不存在，请重新下载后再试' };
  }
  const setupPath = lastDownload.zipPath;
  // ① 搬迁（数据已在 appdata 时 _adoptDirAsDataRoot 自行跳过 —— 幂等，不算失败）
  let migrated = false;
  try {
    if (path.resolve(configFile) === path.resolve(programConfigPath())) {
      migrated = _adoptDirAsDataRoot(projectDir());
      if (migrated) configFile = appdataConfigPath();   // 本次会话起即用 appdata
    } else {
      migrated = true;   // 数据此前已在 appdata：线索里 migrated 记 true（NSIS 据此免写接管标记）
    }
  } catch (e) { _migLog('安装前搬迁异常（不阻断安装）：' + ((e && e.message) || e)); }
  // ② 留线索（幂等；NSIS 安装时读它决定是否写 pending-takeover.json）
  _writePortableOrigin(migrated);
  sendToMain('update_status', '正在启动安装程序…');
  // ③④ 先安排拉起、再退出：cmd /c start 让 Setup 独立于本进程（参数由 Node 转义，含空格路径安全）
  try {
    const child = require('child_process').spawn('cmd.exe', ['/c', 'start', '', setupPath], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (e) {
    writeUpdateLog('拉起安装程序失败：' + ((e && e.message) || e));
    return { ok: false, error: '启动安装程序失败，请手动打开更新文件' };
  }
  writeUpdateLog('已安排安装程序启动，应用即将退出：' + setupPath);
  isQuitting = true;   // 守卫"最小化到托盘"等退出拦截，确保真的退出让安装程序接手
  setTimeout(function () { try { app.exit(0); } catch (e) { app.quit(); } }, 600);
  return { ok: true, installing: true };
}
// 用户点击「立即安装」（两步式第二步，需 UPDATE_ENABLED）：
//   便携分发形态 → 搬迁 + 线索 + 退出 + 拉起 Setup（改用安装版，设置与数据自动保留）；
//   安装形态 → electron-updater 静默升级安装并重启。
async function applyUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  if (isPortableDistribution()) return portableApplyUpdate();
  if (!IS_PORTABLE) return setupApplyUpdate(); // setup 安装版：electron-updater 静默升级安装并重启
  return { ok: false, error: '更新文件已就绪，请关闭应用后手动安装' };
}

// HTTP 服务器 extraRoutes：涉及 main.js 内部状态（config/loadConfig/saveConfig 等）的路由
// 浏览器侧请求这些路由时，复用与 ipcMain handler 相同的逻辑
function buildHttpExtraRoutes() {
  return {
    // ── agent 友好接口：三条均为纯新增，不改动任何现有接口 ──
    // 读运行日志：任务记录/标记/成片都可能被清除，运行日志是事后唯一证据
    get_runlog: (args) => {
      const o = (args && args[0]) || {};
      if (o.list) return { ok: true, dir: runLog.getDir(), files: runLog.listDays() };
      return runLog.readDay(o.date, o);
    },
    // 一次拿全环境上下文，省去 agent 多次探测
    // ⚠ 整体走异步（env 用 checkEnvAsync）：同步探测会阻塞事件循环数十秒
    get_app_info: async () => {
      const c = loadConfig();
      const t = (() => { try { return api.listTools(); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })();
      const enginesDir = resolveEnginesDir();
      const ready = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
      const env = await api.checkEnvAsync().catch(() => null);
      return {
        ok: true,
        app: 'Video Lab',
        version: app.getVersion(),
        form: IS_PORTABLE ? 'portable' : 'installed',
        autostart: IS_AUTOSTART,
        storageDir: storageDir(),
        enginesDir,
        configPath: configFilePath(),
        logDir: runLog.getDir(),
        root: api.getRoot(),
        skin: c.skin || '',
        http: { url: httpUrl(), port: parseInt(c.http_port, 10) || 9527 },
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
        config_storage: c.config_storage === 'appdata' ? 'appdata' : 'program',
        config_path_program: path.dirname(programConfigPath()),
        config_path_appdata: path.dirname(appdataConfigPath()),
        autostart: c.autostart === true,
        close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
        http_port: parseInt(c.http_port, 10) || 9527,
        http_token: String(c.http_token || ''),
        http_url: httpUrl(),
        log_dir: runLog.getDir(),
        cache_keep_days: (() => { const n = parseInt(c.cache_keep_days, 10); return Number.isFinite(n) && n >= 0 ? n : 30; })(),
        cache_info: (() => { try { return api.cacheInfo(); } catch (e) { return {}; } })(),
        show_maintenance: c.show_maintenance === true,
        notify_task_end: c.notify_task_end !== false,
        backup_dir: String(c.backup_dir || ''),
        backup_auto_clean: c.backup_auto_clean === true,
        backup_keep_days: parseInt(c.backup_keep_days, 10) || 7,
        backup_dir_effective: String(c.backup_dir || '').trim()
          || require('path').join(storageDir(), 'backup'),   // 占位符直接显示实际默认地址
        backup_root_effective: api.getBackupRoot(),   // 备份实际落盘根（自定义目录时含「Video Lab 备份」层）
      };
    },
    // 运行日志目录（设置页「维护」区）
    get_log_dir: () => ({ ok: true, dir: runLog.getDir() }),
    save_settings: (args) => {
      const s = args[0];
      const cfg = loadConfig();
      const prevBackupDir = String(cfg.backup_dir || '').trim();   // 变更前值：用于备份目录迁移
      let configMoved = false;
      if (s && typeof s === 'object') {
        // 工作路径已迁入 batch.root（见下方 batch 分支），不再从顶层 s.root 取
        if (typeof s.skin === 'string') cfg.skin = s.skin.trim();
        if (s.config_storage === 'program' || s.config_storage === 'appdata') cfg.config_storage = s.config_storage;
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
          // 同步顶层 root 兼容镜像；空值不得覆盖已有工作路径（与旧逻辑一致）
          setBatchRoot(cfg, getBatchRoot(cfg) || prevRoot);
        }
        if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
        if (s.mask && typeof s.mask === 'object') cfg.mask = Object.assign({}, DEFAULT_CONFIG.mask, s.mask);
      }
      const target = cfg.config_storage === 'appdata' ? appdataConfigPath() : programConfigPath();
      if (path.resolve(target) !== path.resolve(configFilePath())) {
        const mv = moveConfigFile(target);
        if (mv.ok && mv.moved) { configMoved = true; }
      }
      saveConfig(cfg);   // 只写实际变更的键：settings.db（唯一读取来源）+ config.json（旧版本兼容快照）
      Object.assign(config, cfg);
      // 端口/令牌实际变更才重启 HTTP 服务器（重启会断开浏览器既有 SSE 连接）；
      // 皮肤等其它设置变更保留连接，settings_saved 广播可即时送达浏览器，无需手动刷新
      const httpPortWanted = parseInt(cfg.http_port, 10) || 9527;
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
      return { ok: true, config_moved: configMoved };
    },
    save_guide: (args) => {
      const s = args[0];
      const root = s && typeof s.root === 'string' ? s.root.trim() : '';
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, error: '路径无效或不存在' };
      setBatchRoot(config, root); saveConfig(config); api.setRoot(root);
      return { ok: true, root };
    },
    get_skin: () => String(config.skin || 'white_blue'),
    set_skin: (args) => { const v = String(args[0] || '').trim(); config.skin = v || 'white_blue'; saveConfig(config); return config.skin; },
    get_autostart: () => ({ enabled: config.autostart === true }),
    set_autostart: (args) => {
      const v = !!args[0]; config.autostart = v; saveConfig(config);
      try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: v, args: ['--autostart'] }); } catch (e) {}
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', loadConfig());
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', loadConfig());
      return { ok: true, enabled: v };
    },
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
    // portable_dist = 便携分发形态（解压即用）—— 更新链路据此决定「下载 Setup 并就地转安装版」；
    // is_portable 保留原语义（IS_PORTABLE，仅表达 electron-builder portable target 形态）。
    get_runtime: () => ({ is_portable: IS_PORTABLE, portable_dist: isPortableDistribution(), version: APP_VERSION }),
    get_app_version: () => APP_VERSION,
    // A6 数据目录清理（HTTP 侧同样开放，便于浏览器与脚本调用；扫描为只读，清理一律进回收站）
    data_dir_scan: () => api.dataDirScan(),
    // HTTP 侧参数是「按位置展开的数组」→ 键清单须写成 [["a","b"]]。
    // ⚠ 但直白的 ["a","b"] 极易写出（实测就栽在这：args[0] 拿到字符串 → Array.isArray 不成立
    //   → 静默清 0 项、界面无任何反馈）。故两种写法都接受，宁可容错，不要静默失败。
    data_dir_clean: (args) => api.dataDirClean(
      Array.isArray(args) && Array.isArray(args[0]) ? args[0] : args),
    // 返回带 token 的浏览器访问地址（含真实 token）；HTTP 侧需要自身已带 token 才能调用（本机防护），
    // Electron 本体侧 ipcMain 无需 token —— 用于设置页/开发测试获取链接
    get_browser_url: () => {
      const url = httpUrl();
      return url ? { ok: true, url } : { ok: false, error: 'HTTP 服务未就绪' };
    },
    check_update: (args) => {
      // 浏览器端发起：结果由返回值给到发起页面（自己弹窗），不通知软件端主窗口 —— 否则
      // 浏览器端点一下，软件端也会弹一个（跨端串扰）。
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
  // ⚠ 走异步版：同步版会 walkFiles + 逐文件 contentHash 占死事件循环数十秒（冷启动）
  ipcMain.handle('list_projects', (e, force) => api.listProjectsAsync(!!force));
  ipcMain.handle('list_versions', (e, project, name) => api.listVersions(project, name));
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
    // 窗口显示统一交给各自的 ready-to-show（首帧就绪才出现）；
    // 这里只在「已加载完且被隐藏」时补 show，防止首次打开抢先显示空白窗。
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
      config_storage: c.config_storage === 'appdata' ? 'appdata' : 'program',
      config_path_program: path.dirname(programConfigPath()),   // 显示目录（含引导文件与三库）
      config_path_appdata: path.dirname(appdataConfigPath()),
      log_dir: runLog.getDir(),   // 运行日志目录（设置页「打开文件夹」用；与 HTTP 版 get_settings 对齐）
      cache_keep_days: (() => { const n = parseInt(c.cache_keep_days, 10); return Number.isFinite(n) && n >= 0 ? n : 30; })(),
      cache_info: (() => { try { return api.cacheInfo(); } catch (e) { return {}; } })(),
      show_maintenance: c.show_maintenance === true,   // 「维护」板块可见性（用户侧默认关闭）
      notify_task_end: c.notify_task_end !== false,   // 任务通知（默认开启）
      backup_dir: String(c.backup_dir || ''),
      backup_auto_clean: c.backup_auto_clean === true,
      backup_keep_days: parseInt(c.backup_keep_days, 10) || 7,
      backup_dir_effective: String(c.backup_dir || '').trim()
        || path.join(storageDir(), 'backup'),   // 占位符直接显示实际默认地址
      backup_root_effective: api.getBackupRoot(),   // 备份实际落盘根（自定义目录时含「Video Lab 备份」层）
      autostart: c.autostart === true,
      close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
      http_port: parseInt(c.http_port, 10) || 9527,
      http_token: String(c.http_token || ''),
      http_url: httpUrl(),
    };
  });
  // 设置页：保存完整配置，写入 config.json 并同步内存/后端/主窗口皮肤；切换保存位置时迁移并删除旧文件
  ipcMain.handle('save_settings', (e, s) => {
    const cfg = loadConfig();
    const prevBackupDir = String(cfg.backup_dir || '').trim();   // 变更前值：用于备份目录迁移
    let configMoved = false;
    if (s && typeof s === 'object') {
      // 工作路径已迁入 batch.root（见下方 batch 分支），不再从顶层 s.root 取
      if (typeof s.skin === 'string') cfg.skin = s.skin.trim();
      if (s.config_storage === 'program' || s.config_storage === 'appdata') cfg.config_storage = s.config_storage;
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
        // 同步顶层 root 兼容镜像；空值不得覆盖已有工作路径（与旧逻辑一致）
        setBatchRoot(cfg, getBatchRoot(cfg) || prevRoot);
      }
      if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
      if (s.mask && typeof s.mask === 'object') cfg.mask = Object.assign({}, DEFAULT_CONFIG.mask, s.mask);
    }
    mergeAppSettings(cfg, s);   // 应用级设置（含 v2.2.1 新增项）
    // 配置保存位置切换：迁移并删除旧位置文件（迁移式，防止两处配置不一致）
    const target = cfg.config_storage === 'appdata' ? appdataConfigPath() : programConfigPath();
    if (path.resolve(target) !== path.resolve(configFilePath())) {
      const mv = moveConfigFile(target);
      if (mv.ok && mv.moved) { configMoved = true; } // 库随配置一并迁移（moveConfigFile 内部完成）
    }
    saveConfig(cfg);   // 只写实际变更的键：settings.db（唯一读取来源）+ config.json（旧版本兼容快照）
    // 应用开机自启动（openAtLogin + --autostart 静默托盘启动）；开发版不注册，避免污染开发环境
    try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.autostart === true, args: ['--autostart'] }); } catch (e) {}
    Object.assign(config, cfg);
    // 端口/令牌实际变更才重启 HTTP 服务器（重启会断开浏览器既有 SSE 连接）；
    // 皮肤等其它设置变更保留连接，settings_saved 广播可即时送达浏览器，无需手动刷新
    const httpPortWanted = parseInt(cfg.http_port, 10) || 9527;
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
    return { ok: true, config_moved: configMoved };
  });
  // 运行时形态（便携分发 / setup 安装版），供前端决定「更新文件就绪」后的按钮动作与说明
  // portable_dist 见 isPortableDistribution()：便携包解压即用也是它（IS_PORTABLE 对真实便携包为 false）
  ipcMain.handle('get_runtime', () => ({ is_portable: IS_PORTABLE, portable_dist: isPortableDistribution(), version: APP_VERSION }));
  // 返回带 token 的浏览器访问地址（含真实 token）；HTTP 侧需要自身已带 token 才能调用（本机防护），
  // Electron 本体侧 ipcMain 无需 token —— 用于设置页/开发测试获取链接
  ipcMain.handle('get_browser_url', () => {
    const url = httpUrl();
    return url ? { ok: true, url } : { ok: false, error: 'HTTP 服务未就绪' };
  });
  // 设置页：检查更新（仅在自动更新启用时生效，UPDATE_ENABLED=false 时返回停用）。
  // ⚠ notifyMain 必须为 true（默认）：三条入口的结果统一由主窗口弹（index.html 的 #updateResultMask
  //   + app.js 的 showUpdateResult）。设置页在软件端是主窗口内的 iframe，自弹浮层会被
  //   .settings-frame（z-index 9999 且带 transform）裁切，所以 settings.js 的 showUr 内有
  //   IN_APP_IFRAME 闸门 —— 软件端不弹、交给主窗口；浏览器端设置页是独立页面（txapi 的 SSE
  //   事件表不含 update_*）才由它自己弹。此处若传 notifyMain:false，软件端就会【两边都不弹】。
  // ⚠ checkForUpdate 内的三处事件都有 !silent 闸门：后台自动/每日检查不会弹窗打扰。
  ipcMain.handle('check_update', (e, silent) => {
    return checkForUpdate({ silent: !!silent });
  });
  // 设置页：更新源/更新方式即时落盘（检查更新前调用，使界面当前选中值立刻生效）
  ipcMain.handle('apply_update_pref', (e, pref) => applyUpdatePref(pref));
  // 主窗口状态栏：当前应用版本号（左下角常驻显示）
  ipcMain.handle('get_app_version', () => APP_VERSION);
  // 开机自启动开关（独立读写，设置页「通用设置」可用；openAtLogin + --autostart 静默托盘启动）
  ipcMain.handle('get_autostart', () => ({ enabled: config.autostart === true }));
  ipcMain.handle('set_autostart', (e, en) => {
    const v = !!en;
    config.autostart = v;
    saveConfig(config);
    try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: v, args: ['--autostart'] }); } catch (e) {}
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', loadConfig());
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', loadConfig());
    return { ok: true, enabled: v };
  });
  // 手动取消进行中的后台预检测（后端 token 自增即中断旧探测）
  ipcMain.handle('cancel_precheck', () => api.cancelPrecheck());
  // 主窗口提示条：两步式第一步（仅下载，需 UPDATE_ENABLED）
  ipcMain.handle('start_update', () => startUpdate());
  // 主窗口提示条：两步式第二步（安装并重启，需 UPDATE_ENABLED，setup 版使用）
  ipcMain.handle('apply_update', () => applyUpdate());
  // 便携版：打开资源管理器并选中已下载的更新包（用户关闭应用后自行解压）
  ipcMain.handle('reveal_update_file', () => {
    if (!lastDownload || !fs.existsSync(lastDownload.zipPath)) return { ok: false, error: '更新包不存在' };
    try { shell.showItemInFolder(lastDownload.zipPath); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, path: lastDownload.zipPath };
  });
  // 关闭设置面板（渲染层点击面板外 / Esc 调用）
  ipcMain.handle('close_settings_panel', () => { closeSettingsPanel(); return { ok: true }; });
  // 内嵌面板标题栏的关闭按钮（设置页 / 引导页共用）：按当前打开的面板分派
  ipcMain.handle('close_embed_panel', () => {
    if (guidePanelOpen) closeGuidePanel(); else closeSettingsPanel();
    return { ok: true };
  });
  // 设置页：通用「选择目录」对话框（parent 取调用方窗口，引导窗口/设置窗口/主窗口通用）
  let settingsPickingDir = false; // 目录选择中的互斥标记（勿删：pick_directory 依赖它）
  ipcMain.handle('pick_directory', async (e, title, defaultPath) => {
    settingsPickingDir = true;
    try {
      const win = BrowserWindow.fromWebContents(e.sender) || mainWin;
      const result = await dialog.showOpenDialog(win, { title: title || '选择目录', defaultPath: defaultPath || api.getRoot() || defaultRoot() || os.homedir(), properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    } finally { settingsPickingDir = false; }
  });
  ipcMain.handle('get_root', () => api.getRoot());
  // ⚠ 必须走异步版：同步 checkEnv 会在冷启动时用 spawnSync 阻塞主进程事件循环数十秒
  //（首次加载 200MB+ 未签名 ffmpeg + 安全软件扫描），直接把窗口显示推迟到分钟级
  ipcMain.handle('check_env', () => api.checkEnvAsync());
  // 首次引导窗口：保存工作路径
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
  ipcMain.handle('set_skin', (e, skin) => { const v = String(skin || '').trim(); config.skin = v || 'white_blue'; saveConfig(config); return config.skin; });
  // 运行日志目录（设置页「维护」区展示与打开）
  ipcMain.handle('get_log_dir', () => ({ ok: true, dir: runLog.getDir() }));
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
  // 启动检测 FFmpeg 环境：**确证缺失即静默自动下载**
  //   · 组件不内置只是为了省体积，不该把「体积优化」转成用户的决策负担 → 不弹确认；
  //   · 下载进度走状态栏（env_fix_progress，见 api.onFfmpegProgress）；
  //   · 只有**下载失败**才提示（横幅可重试 + 吐司），此时才需要用户介入。
  // ⚠ 用异步版（不阻塞事件循环）；且延迟到窗口就绪之后再跑，避免与首帧竞争
  // ⚠ 冷启动首次加载 ffmpeg 可能超时 → probeFailed：此时**不下载也不弹窗**，延后 10 秒重探一次 ——
  //   ⚠ 不要把「超时」当成「缺滤镜」：否则冷启动必然误报「FFmpeg 组件不完整」（热态重跑却正常）
  // 组件「能用但版本过旧」时**静默升级**：旧源（ffmpeg-static）最高 6.1.1，其进度行**不含 elapsed（实际耗时）**，
  // 界面那一行永远为空。这是换源留下的历史包袱，不该让用户承担 → 启动空闲期自动升到 FFmpeg-Builds（国内镜像）。
  // 失败**不弹窗**（只在运行日志留痕），且 7 天内不重复尝试，避免每次启动都去下 140MB。
  function maybeUpgradeFfmpeg() {
    try {
      // ⚠ 内置已就位时一律不下载、不升级：内置是随程序发布的固定版本，不存在「过旧」问题；
      //   而数据目录那份遗留会被「清理数据目录」清掉，读不到 _meta.json 会被误判成版本过旧/缺失，
      //   于是每次启动静默重下 310MB —— 正好把用户刚清理的空间又填回去。
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

  // 旧版遗留的**一次性**清理：内置组件就位后，数据目录那份 310MB「下载组件」即成为纯遗留 ——
  // 它只增不减，且普通用户无从知晓可以删。
  // 闸门（**三个都要满足，缺一不动**）：
  //   ① 内置组件就位（`ffmpegBuiltinReady`）；
  //   ② 环境探测确认内置**确实可用**（不是"文件在"就算数 —— 缺滤镜/编码器同样不可用）；
  //   ③ 数据目录那份确实存在，且**不是当前正在用的那一份**（防止把唯一可用组件删掉）。
  // 清理**走回收站**（可还原，遵循项目硬约束），并落一次性标记，此后不再检查。
  function cleanupLegacyFfmpeg(env) {
    try {
      const legacy = path.join(storageDir(), 'ffmpeg');
      // ⚠ 刻意**不留任何标记文件**。
      //   本操作天然幂等 —— 下面第二句就是「没有遗留就直接返回」，成本一次 existsSync；
      //   不留标记反而更正确：将来若又冒出遗留（例如回装旧版再升级），照样能被清掉 ——
      //   有了"一次性"标记，那种情况就永远不会再清，反倒留坑。
      if (!api.ffmpegBuiltinReady || !api.ffmpegBuiltinReady()) return;   // 内置不在 → 绝不动那份兜底
      if (!env || env.downloadNeeded) return;                            // 内置不可用 → 同上
      if (!fs.existsSync(path.join(legacy, 'ffmpeg.exe'))) return;       // 没有遗留 → 直接返回
      const active = String(env.ffmpegDir || '');
      // 正在用它 → 不动（判不出来时也按"在用"处理：宁可少清，不能把唯一可用的组件清掉）
      try { if (!active || path.resolve(active) === path.resolve(legacy)) return; } catch (e) { return; }
      let freed = 0;
      try { freed = fs.readdirSync(legacy).reduce((s, n) => s + (fs.statSync(path.join(legacy, n)).size || 0), 0); } catch (e) {}
      try { shell.trashItem(legacy); } catch (e) { return; }             // 送站失败：保留现场，下次启动再试
      try { writeUpdateLog('已自动清理旧版 FFmpeg 组件遗留（' + Math.round(freed / 1048576) + ' MB，进回收站可还原）：' + legacy); } catch (e) {}
    } catch (e) {}
  }

  runAfterWindowLoad(() => {
    const probe = (allowRetry) => {
      api.checkEnvAsync().then((env) => {
        if (env.probeFailed) {
          if (allowRetry) setTimeout(() => probe(false), 10000);
          return;
        }
        // 组件已就绪 → 再看**版本是否过旧**（旧源 6.1.1 缺 elapsed），过旧则静默升级；
        // 同时做 A7 旧版遗留的一次性清理（内置可用才动，见上）
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
  // 打开「文件夹」类操作的统一入口，按目标类型分流：
  //   目录 → 在资源管理器中打开该目录（进入，而不是打开父级再选中它）；
  //   文件 → 打开其所在文件夹并选中该文件（定位）。
  ipcMain.handle('open_folder_select', async (e, p, opts) => {
    const target = path.resolve(String(p || '').replace(/^"|"$/g, ''));
    // opts.create：调用方明确知道该目录「按需生成」（如备份目录要等首次备份才落盘）——
    // 此时先按需创建，避免点「打开」直接报「路径不存在」
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
  ipcMain.handle('pick_single_folder', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要修改为的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });
  // 遮罩「添加文件」（原片/遮罩两栏共用）：多选视频文件（含 .lnk 快捷方式）
  ipcMain.handle('pick_paths_files', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '选择视频文件（支持 mp4/mov/avi/mkv 等 / .lnk 快捷方式）',
      defaultPath: api.getRoot(),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm', 'flv', 'lnk'] }]
    });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  // 遮罩「添加文件夹」（原片/遮罩两栏共用）：多选文件夹，其中视频将递归扫描
  ipcMain.handle('pick_paths_dirs', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择文件夹（将递归扫描其中视频）', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
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

// 关闭主窗口：已记忆行为直接生效；未记忆时请求主窗口弹窗引导选择（可勾选"不再提醒"持久化）。
// 关闭前先确认配置未保存修改（覆盖当前配置/保存为当日配置/取消），避免修改丢失。
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
  mainWin = new BrowserWindow({ title: 'Video Lab', width: 1360, height: 860, minWidth: 1120, minHeight: 700, frame: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, nodeIntegrationInSubFrames: true } });
  mainWin.loadFile(path.join(__dirname, 'frontend', 'index.html'));
  // 页面加载完成即放行「窗口加载后」初始化。注册必须紧跟 loadFile：
  // ⚠ 若推迟到第一次 runAfterWindowLoad 调用时才注册，那时页面往往已经加载完，
  // 监听永不触发 → 只能等 3 秒兜底 → 托盘 / HTTP 就绪被无谓推迟约 2.7 秒。
  try {
    mainWin.webContents.once('did-finish-load', () => {
      logTiming('主窗口 did-finish-load');
      setImmediate(() => flushAfterWindowLoad('did-finish-load'));
    });
  } catch (e) {}
  // 普通启动：页面就绪后显示；开机自启（--autostart）保持隐藏，仅托盘常驻。
  // 扫描（缓存未命中时）全程后台进行，不推迟显示、也不弹扫描小窗。
  mainWin.once('ready-to-show', () => {
    logTiming('主窗口 ready-to-show（首帧可显示）');
    // 冷启动定位用：把「回调返回」与 show() 各自夹出来。冷态出现过 ready-to-show 之后
    // 事件循环被冻数十秒（3 秒兜底定时器被推迟到二十多秒才跑）的情形 —— 此处三条埋点可一次判定
    // 卡点究竟在 show() 之内、还是其后的初始化里。
    setImmediate(() => logTiming('ready-to-show 回调后 setImmediate'));
    if (IS_AUTOSTART) return;
    // 不再因扫描而推迟显示：扫描全程后台进行，窗口首帧就绪即显示，
    // 列表由后台扫描完成后自动填充。⚠ 不要"等扫描完再显示主窗口"：那是启动冻结感的来源。
    logTiming('即将 show()');
    mainWin.show();
    logTiming('show() 返回');
  });
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); handleMainWindowClose(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 启动阶段计时落日志（app.timing）：冷启动排查的唯一数据来源，避免今后只能靠体感猜
function logTiming(label) {
  try { runLog.sys('app.timing', '启动阶段 · ' + label, { sinceProcessStart: Math.round(bootMs()) }); } catch (e) {}
}

// 窗口渲染完成后再执行后台初始化：把重活（读任务日志、起 HTTP、建托盘）排到窗口可见之后，
// 使其不再叠加到「点了图标迟迟不出窗口」的体感上。
// ⚠ 不能用 ready-to-show 作为唯一触发：开机自启场景窗口从不 show，"首帧显示"语义不成立；
// 用 did-finish-load（页面加载完成，与窗口是否可见无关）保证两种启动方式都能及时触发。
// 另加 3 秒兜底：页面加载异常时也不能把后续初始化永久挂住。
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

// 首次引导窗口：工作路径缺失时打开（仿设置页样式），用户主动点按钮才弹资源管理器；
// 可保存并关闭，也可直接点右上角关闭跳过（跳过时主窗口进入"空列表 + 中央选择路径"引导态）
// 首次引导：改为在主窗口内以 iframe 显示（与设置页同一模式，独立窗口已取消）。
// 返回 Promise：保存成功或被跳过（关闭）后 resolve，调用方 await 语义保持不变。
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
    // ⚠ 工作目录可能在机械盘：主进程**不得**同步 stat —— 冷态首次访问会冻结事件循环；
    //   改用 fs.promises 异步判断，且只判一次。
    let ok = false;
    if (br) {
      try { const st = await fs.promises.stat(br); ok = st.isDirectory(); } catch (e) { ok = false; }
    }
    // 开机自启为静默后台启动：配置缺失也不弹首次引导窗，保持无打扰（用户稍后手动打开时再引导）
    if (!IS_AUTOSTART && !ok) {
      await openGuideWindow(); // 保存或右上角关闭（跳过）都会关闭该窗口
    }
    // root 已在 Api 构造时由 resolveRoot 正确设置；此处仅为确认，相同路径时快速返回
    api.setRoot(ok ? br : '');
  }

app.whenReady().then(async () => {
  // ── 主进程事件循环心跳（启动期）──
  // 「托盘图标在、点不动、要等很久才出窗口」= 主进程事件循环被同步操作占死的典型表现。
  // 单靠各阶段打点看不出"两次打点之间事件循环是否卡住"，故起一个 500ms 心跳：
  // 正常应每 500ms 一跳；若某两个心跳间隔远大于 500ms，说明中间那段代码阻塞了事件循环，
  // 该间隔会被记成 app.timing 的「事件循环卡顿」事件（含卡顿时长），直接把元凶段暴露出来。
  // 启动完成后（60 秒或首次交互后）自动停，不影响稳定态。
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
  try { app.setAppUserModelId('com.videolab.manager'); } catch (e) {}
  Menu.setApplicationMenu(null);
  registerIpc();
  logTiming('whenReady 后 注册 IPC 完成');
  // ── 启动顺序原则：**能在窗口显示后做的，绝不放在窗口显示前** ──
  // 早期实现把 ensureConfig / createTray / createWindow / HTTP / restoreTasks 全串在这里，
  // 任一环节慢都会直接叠加到「点了图标迟迟不出窗口」的体感上（而 restoreTasks 要读上百条任务日志）。
  // 现在只保留「窗口必须先有的最小集」，其余一律在首帧之后再跑。
  createWindow();
  logTiming('主窗口已创建（loadFile 已发起）');
  // ── 启动期全量扫描的「小窗 + 异步预热」 ──
  // 缓存未命中（首次启动 / 工作目录结构变化）时才需要全量扫描，实测冷态可达 20-30 秒。
  // 此时：① 弹轻量扫描小窗给即时反馈；② 主窗口推迟到扫描完成再显示（避免空白窗口）；
  //      ③ 在后台异步预热，前端随后调 list_projects 时直接命中同一结果，不重复扫描。
  // ⚠ 判定必须走**异步版**（isScanCacheFreshAsync）：同步版会在机械盘冷态首次访问时
  //    冻结主进程达 117 秒（实测），连托盘和窗口都出不来。
  // ⚠ 开机自启（--autostart）直接跳过整段：托盘静默常驻，用户不打开就不该弹小窗；
  //    用户真去唤起时由 warmScanOnDemand() 按需补扫。
  (() => {
    if (IS_AUTOSTART) return;                 // 自启形态静默，不打扰
    if (!getBatchRoot(config)) return;        // 未配置工作路径：无扫描可言
    // 缓存未命中（首次启动 / 工作目录结构变化）时才预热全量扫描，实测冷态可达 20-30 秒。
    // 扫描全程后台：主窗口立即显示、界面可交互 —— 不弹小窗、也不推迟显示
    // ⚠ 不要"弹小窗 + 等扫描完才显示主窗口"：那是启动冻结感的来源。
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
    // 首次引导窗口（配置缺失时）：必须在窗口加载后，避免阻塞启动。
    // ⚠ ensureConfig 内部已改为异步 stat（工作目录在机械盘，同步 stat 会冻结事件循环）。
    //   这里补打完成埋点：下次冷态若它仍慢，只会体现在这行，不再拖累 createTray / HTTP。
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
    // 启动后空闲期（15s）：先做 video_cache 失效核验，再做缓存治理
    // （保守失效 + 保留期 + 释放显著时 VACUUM）—— 恢复默认「用户无需手动清缓存」
    setTimeout(() => {
      try { api.gcVideoCacheIdle().catch(() => {}); } catch (e) {}
      try { api.gcCachesIdle().catch(() => {}); } catch (e) {}
    }, 15000);
    // 启动自动检查更新（仅检查；UPDATE_ENABLED=false 时便携版静默停用）
    if (UPDATE_ENABLED && mainWin && !mainWin.isDestroyed()) {
      if (config.auto_check_update !== false) setTimeout(() => checkForUpdate({ silent: true }), 3000);
      scheduleDailyUpdateCheck();
    }
    // 任务列表恢复：读上百条任务日志，是最重的一步 —— 放到窗口加载后且让出一轮事件循环，
    // 保证窗口已经画出来再占用主进程。
    // ⚠ 这里只计「同步段」：批量任务的输出目录校验已由 backend 转入异步（冷态下同步 existsSync
    //   会逐任务冷访问机械盘 → 冻结主进程，实测约 9 秒），故异步部分不计入本耗时。
    setTimeout(() => {
      const _t = process.hrtime.bigint();
      try { api.restoreTasks(); } catch (e) {}
      logTiming('窗口加载后：任务恢复同步段完成（耗时 ' + Math.round(Number(process.hrtime.bigint() - _t) / 1e6) + 'ms · 输出目录校验已转异步）');
      // 存量备份迁移（先迁后清）：老版本（画布合成路径不读设置）把备份写进了数据目录，
      // 用户早已设好自定义根 → migrateBackups 那种"值变化才触发"的时机永远不会到，得在启动时补一次。
      // 必须**先迁后清**：否则"保留 N 天"的清理可能先把数据目录里那些旧备份删掉，用户等于白丢。
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
// 程序异常退出后，"发生了什么"往往只剩这一行 —— 这是本日志最该覆盖的场景。
// 注意：监听 uncaughtException 会让 Node 不再自动退出，因此记录后仍需 process.exit(1)
// 保持「未捕获异常即退出」的原有行为，避免进程带病继续运行。
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
// 首帧必须等这些资源解码完成，否则会「先出空框、再刷出装饰」—— 正是设置页（每次重建）与
// 切换皮肤后的托盘菜单（首次注入新变量）出现的刷新感。
// 这里统一等：字体就绪 → 图片解码完成（含 <img>）→ 两帧重绘；超时兜底避免卡住不显示。
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

// 渲染进程 / 子进程异常退出（主进程仍在运行，但往往正是故障现场）
// ★ 自愈（偶发白屏且显示源码，托盘菜单同样异常，只能强制结束重开）：
//   这里**必须做恢复** —— 只记日志的话，一旦渲染进程异常，界面就永久白屏，必须手动重启。
//   现补「自动重载」：崩溃后重建页面；带次数限制（5 分钟内最多 3 次），避免真正性崩溃时无限循环。
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
