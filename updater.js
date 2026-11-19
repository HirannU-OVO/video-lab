// -*- coding: utf-8 -*-
// 自动升级策略壳：封装更新生命周期、双源探测、重算力避让、任务保护与目录锁定
'use strict';

const fs = require('fs');
const path = require('path');
let electron = null;
try {
  electron = require('electron');
} catch (e) {
  electron = {};
}
const app = (electron && electron.app) || {
  isPackaged: false,
  getVersion: () => '0.0.0',
  getName: () => 'Video Lab',
  getPath: () => '',
  getAppPath: () => process.cwd()
};
const net = (electron && electron.net) || {};

const GITHUB_REPO = 'HirannU-OVO/video-lab';
const DOMESTIC_KEY = ['git', 'code'].join('');
const DOMESTIC_REPO = 'HirannU-OVO/video-lab';
const UPDATE_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
const DOMESTIC_API_URL = 'https://api.' + DOMESTIC_KEY + '.com/api/v5/repos/' + DOMESTIC_REPO + '/releases/latest';
const UPDATE_PROXIES = ['https://gh-proxy.com', 'https://gh-proxy.org'];
const UPDATE_PUBLISH_URL = 'https://github.com/' + GITHUB_REPO + '/releases/latest/download';

function accelUrls(url) {
  if (url && (url.indexOf('https://github.com/') === 0 || url.indexOf('https://api.github.com/') === 0)) {
    const out = UPDATE_PROXIES.map((p) => p + '/' + url);
    out.push(url);
    return out;
  }
  return [url];
}

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

function getAppVersion() {
  try {
    if (app && typeof app.getVersion === 'function') {
      const v = app.getVersion();
      if (v && v !== '0.0.0') return v;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

function getUpdaterLogPath() {
  try {
    const baseDir = (app && typeof app.getPath === 'function' && app.getPath('userData'))
      ? path.join(app.getPath('userData'), 'log')
      : path.join(process.cwd(), 'data', 'logs');
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    return path.join(baseDir, 'updater.log');
  } catch (e) {
    return path.join(process.cwd(), 'updater.log');
  }
}

function writeUpdateLog(line) {
  try {
    const logPath = getUpdaterLogPath();
    const time = new Date().toISOString();
    fs.appendFileSync(logPath, `[${time}] ${line}\n`, 'utf8');
  } catch (e) {}
}

function isSafeInstallDir(dir) {
  if (!dir || typeof dir !== 'string') return false;
  const normalized = path.resolve(dir).toLowerCase();
  const sysTemp = (require('os').tmpdir() || '').toLowerCase();
  if (sysTemp && normalized.startsWith(sysTemp)) return false;
  const envTemp = (process.env.TEMP || process.env.TMP || '').toLowerCase();
  if (envTemp && normalized.startsWith(envTemp)) return false;
  let appTemp = '';
  try {
    if (app && typeof app.getPath === 'function') appTemp = (app.getPath('temp') || '').toLowerCase();
  } catch (e) {}
  if (appTemp && normalized.startsWith(appTemp)) return false;
  if (/\\(temp|tmp)(\\.*)?$/i.test(normalized)) return false;
  return true;
}

function getSafeInstallArgs(installDir, restartAfter = false) {
  const targetDir = installDir || path.dirname(process.execPath);
  const args = ['--updated', '/S'];
  if (restartAfter) args.push('--force-run');
  args.push(`/D=${targetDir}`);
  return args;
}

function shouldEnableUpdater() {
  if (!app || !app.isPackaged) return false;
  if (process.env.VL_IS_PREVIEW === '1') return false;
  if (app.getName && app.getName().includes('Preview')) return false;
  if (process.argv && process.argv.includes('--dev')) return false;
  const updateYml = path.join(process.resourcesPath || '', 'app-update.yml');
  if (!fs.existsSync(updateYml)) return false;
  return true;
}

function checkAppOriginFfmpeg() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    const psCmd = `
$ff = @(Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe'" -ErrorAction SilentlyContinue)
if ($ff.Count -eq 0) { exit 0 }
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$byPid = @{}
foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
foreach ($f in $ff) {
  $cur = $f
  for ($i = 0; $i -lt 12; $i++) {
    if ($null -eq $cur) { break }
    if ($cur.Name -like '*Video Lab*') { exit 1 }
    $ppid = [int]$cur.ParentProcessId
    if ($ppid -le 0 -or -not $byPid.ContainsKey($ppid)) { break }
    $cur = $byPid[$ppid]
  }
}
exit 0
`.trim();
    const { exec } = require('child_process');
    exec(`powershell -NoProfile -Command "${psCmd.replace(/\r?\n/g, '; ')}"`, (err) => {
      if (err && err.code === 1) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

async function waitForEngineSettled(api, timeoutMs = 300000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = options.pollInterval || 1500;
  const checkFfmpeg = options.checkAppOriginFfmpeg || checkAppOriginFfmpeg;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  while (Date.now() < deadline) {
    let hasRunning = false;
    if (options.getPendingTasks) {
      const list = await options.getPendingTasks();
      hasRunning = (list || []).some((t) => t.status === 'running');
    } else if (api) {
      if (typeof api.getPendingTasks === 'function') {
        const list = await api.getPendingTasks();
        hasRunning = (list || []).some((t) => t.status === 'running');
      } else if (typeof api.hasRunningTask === 'function') {
        hasRunning = api.hasRunningTask();
      } else if (typeof api.snapshotTasks === 'function') {
        hasRunning = (api.snapshotTasks() || []).some((t) => t.status === 'running');
      }
    }

    const hasAppFfmpeg = await checkFfmpeg();
    if (!hasRunning && !hasAppFfmpeg) return true;
    await sleep(pollInterval);
  }
  writeUpdateLog('waitForEngineSettled 超时，继续退出流程');
  return false;
}

async function prepareQuitForUpdate(api, options = {}) {
  let pending = [];
  if (options.getPendingTasks) {
    pending = await options.getPendingTasks();
  } else if (api) {
    if (typeof api.getPendingTasks === 'function') {
      pending = await api.getPendingTasks();
    } else if (typeof api.snapshotTasks === 'function') {
      const list = api.snapshotTasks() || [];
      pending = list.filter((t) => t.status === 'running' || t.status === 'queued' || (t.status === 'paused' && (t.softPaused || t._softPaused)));
    }
  }

  if (!pending || pending.length === 0) {
    return { ok: true, frozen: [], softPaused: [] };
  }

  const queued = pending.filter((t) => t.status === 'queued');
  const running = pending.filter((t) => t.status === 'running');

  // 必须最先冻结排队中的任务
  for (const t of queued) {
    if (options.callApi) {
      await options.callApi('requeue', t.id);
    } else if (api) {
      if (typeof api.call === 'function') {
        await api.call('requeue', t.id);
      } else if (typeof api.resumeTask === 'function') {
        await api.resumeTask(t.id);
      }
    }
  }

  // 冻结队列后再向运行中任务发送软暂停
  for (const t of running) {
    if (options.callApi) {
      await options.callApi('pause', t.id);
    } else if (api) {
      if (typeof api.call === 'function') {
        await api.call('pause', t.id);
      } else if (typeof api.pauseTask === 'function') {
        await api.pauseTask(t.id);
      }
    }
  }

  await waitForEngineSettled(api, options.timeoutMs || 300000, options);
  return { ok: true, frozen: queued.map((t) => t.id), softPaused: running.map((t) => t.id) };
}

function checkVersionUpgradeOnStartup(mainWindow, settingsStore, appPath, versionOverride) {
  try {
    const currentVer = versionOverride || getAppVersion();
    let lastVer = null;
    if (settingsStore && typeof settingsStore.get === 'function') {
      lastVer = settingsStore.get('app', 'last_run_version');
    }

    if (!lastVer || cmpVersion(currentVer, lastVer) <= 0) {
      if (settingsStore && typeof settingsStore.set === 'function') {
        settingsStore.set('app', 'last_run_version', currentVer);
      }
      return null;
    }

    let releaseNotes = '';
    try {
      const baseDir = appPath || (app && typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd());
      const changelogPath = path.join(baseDir, 'CHANGELOG.md');
      if (fs.existsSync(changelogPath)) {
        const content = fs.readFileSync(changelogPath, 'utf8');
        const escapedVer = currentVer.replace(/\./g, '\\.');
        const baseVer = currentVer.replace(/-.*$/, '').replace(/\./g, '\\.');
        const reg = new RegExp(`##[^\\n]*v?(?:${escapedVer}|${baseVer})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
        const match = content.match(reg);
        if (match && match[1]) {
          releaseNotes = match[1].trim();
        }
      }
    } catch (readErr) {
      writeUpdateLog('CHANGELOG 读取降级: ' + readErr.message);
      releaseNotes = '';
    }

    if (settingsStore && typeof settingsStore.set === 'function') {
      settingsStore.set('app', 'last_run_version', currentVer);
    }

    if (releaseNotes && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app_upgraded_notice', {
        version: currentVer,
        notes: releaseNotes.slice(0, 800)
      });
      return { version: currentVer, notes: releaseNotes.slice(0, 800) };
    }
    return null;
  } catch (outerErr) {
    writeUpdateLog('版本升级检测外层兜底: ' + outerErr.message);
    return null;
  }
}

class UpdateManager {
  constructor(options = {}) {
    this.state = 'IDLE'; // IDLE | CHECKING | DOWNLOADING | UPDATE_DOWNLOADED | READY_ON_QUIT
    this.downloaded = false;
    this.readyPackagePath = null;
    this.updateInfo = null;
    this.mainWindow = options.mainWindow || null;
    this.api = options.api || null;
    this.settingsStore = options.settingsStore || null;
    this.autoUpdater = null;
    this.checkTimer = null;
    this.isBusy = false;
    this.currentInstallDir = path.dirname(process.execPath);
    this.initAutoUpdater(options.autoUpdater);
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  setApi(api) {
    this.api = api;
  }

  setSettingsStore(store) {
    this.settingsStore = store;
  }

  initAutoUpdater(customUpdater) {
    try {
      this.autoUpdater = customUpdater || require('electron-updater').autoUpdater;
    } catch (e) {
      this.autoUpdater = null;
    }
    if (!this.autoUpdater) return;

    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.installDirectory = this.currentInstallDir;

    try {
      this.autoUpdater.removeAllListeners('download-progress');
      this.autoUpdater.removeAllListeners('update-downloaded');
      this.autoUpdater.removeAllListeners('error');
    } catch (e) {}

    this.autoUpdater.on('download-progress', (p) => {
      const percent = Math.min(100, Math.max(0, Math.round((p && p.percent) || 0)));
      const latestVer = (this.updateInfo && this.updateInfo.version) || '';
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('update_downloading', {
          percent,
          bytesPerSecond: p && p.bytesPerSecond,
          current: getAppVersion(),
          latest: latestVer
        });
      }
    });

    this.autoUpdater.on('update-downloaded', (info) => {
      this.state = 'UPDATE_DOWNLOADED';
      this.downloaded = true;
      this.readyPackagePath = this.autoUpdater.downloadedUpdateFilePath || '';
      this.isBusy = false;
      writeUpdateLog('更新包下载就绪: ' + (info && info.version));
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('update_downloaded', {
          ok: true,
          current: getAppVersion(),
          latest: (info && info.version) || (this.updateInfo && this.updateInfo.version) || ''
        });
      }
    });

    this.autoUpdater.on('error', (err) => {
      this.isBusy = false;
      const msg = (err && err.message) || String(err);
      writeUpdateLog('更新异常: ' + msg);
      if (this.state === 'DOWNLOADING') {
        this.state = 'IDLE';
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('update_error', { message: '下载更新失败: ' + msg });
        }
      } else {
        this.state = 'IDLE';
      }
    });
  }

  hasReadyUpdate() {
    return this.downloaded === true;
  }

  dismissBanner() {
    if (this.state === 'UPDATE_DOWNLOADED') {
      this.state = 'READY_ON_QUIT';
    }
  }

  shouldEnableUpdater() {
    return shouldEnableUpdater();
  }

  startPolling(intervalMs = 6 * 3600 * 1000) {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    setTimeout(() => {
      if (this.shouldEnableUpdater()) {
        this.checkForUpdates({ silent: true }).catch(() => {});
      }
    }, 15000);

    this.checkTimer = setInterval(() => {
      if (this.shouldEnableUpdater()) {
        this.checkForUpdates({ silent: true }).catch(() => {});
      }
    }, intervalMs);
  }

  async checkForUpdates(opts = {}) {
    const silent = !!opts.silent;
    if (!this.shouldEnableUpdater()) {
      return { ok: false, error: '更新不可用', silent };
    }
    if (this.isBusy) {
      return { ok: false, busy: true, error: '已有更新任务在进行中', silent };
    }
    this.isBusy = true;
    this.state = 'CHECKING';
    try {
      if (!this.autoUpdater) {
        throw new Error('未加载 electron-updater 模块');
      }
      const feedUrl = await this.resolveFeedUrl();
      if (feedUrl) {
        this.autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
      }
      const result = await this.autoUpdater.checkForUpdates();
      const updateInfo = result && result.updateInfo;
      const latestVer = updateInfo ? String(updateInfo.version || '') : '';
      const currentVer = getAppVersion();
      const hasUpdate = cmpVersion(latestVer, currentVer) > 0;
      this.updateInfo = updateInfo;

      if (hasUpdate) {
        writeUpdateLog(`检测到新版本: v${latestVer} (当前 v${currentVer})`);
        const hasTask = this.api && typeof this.api.hasRunningTask === 'function' && this.api.hasRunningTask();
        if (hasTask) {
          writeUpdateLog('检测到任务运行中，延后自动静默下载');
          this.state = 'IDLE';
          this.isBusy = false;
          return { ok: true, hasUpdate: true, latest: latestVer, current: currentVer, deferred: true };
        }
        this.isBusy = false;
        this.downloadUpdate().catch((e) => writeUpdateLog('后台静默下载异常: ' + e.message));
        return { ok: true, hasUpdate: true, latest: latestVer, current: currentVer, downloading: true };
      } else {
        this.state = 'IDLE';
        this.isBusy = false;
        if (!silent && this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('update_none', { current: currentVer, latest: latestVer });
        }
        return { ok: true, hasUpdate: false, latest: latestVer, current: currentVer };
      }
    } catch (err) {
      this.state = 'IDLE';
      this.isBusy = false;
      const msg = err.message || String(err);
      writeUpdateLog('检查更新失败: ' + msg);
      if (!silent && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('update_error', { message: msg });
      }
      return { ok: false, error: msg, silent };
    }
  }

  async resolveFeedUrl() {
    const cands = accelUrls(UPDATE_PUBLISH_URL);
    for (const c of cands) {
      try {
        const r = await this.probeUrl(c + '/latest.yml', 8000);
        if (r && r.status === 200 && r.body && /version\s*:/.test(r.body.toString('utf8'))) {
          return c;
        }
      } catch (e) {}
    }
    return cands[cands.length - 1];
  }

  probeUrl(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = net.request({ url, method: 'GET', redirect: 'follow' });
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        try { req.abort(); } catch (e2) {}
        reject(new Error('探测超时'));
      }, timeoutMs);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        });
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
  }

  async downloadUpdate() {
    if (this.downloaded) {
      return { ok: true, downloaded: true };
    }
    if (this.state === 'DOWNLOADING') {
      return { ok: true, downloading: true };
    }
    if (!this.autoUpdater) {
      return { ok: false, error: '未加载 electron-updater 模块' };
    }
    this.state = 'DOWNLOADING';
    this.isBusy = true;
    try {
      writeUpdateLog('开始下载更新...');
      await this.autoUpdater.downloadUpdate();
      return { ok: true, downloaded: true };
    } catch (err) {
      this.state = 'IDLE';
      this.isBusy = false;
      const msg = err.message || String(err);
      writeUpdateLog('下载更新失败: ' + msg);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('update_error', { message: '下载更新失败: ' + msg });
      }
      return { ok: false, error: msg };
    }
  }

  async prepareQuitForUpdate(options = {}) {
    return await prepareQuitForUpdate(this.api, options);
  }

  installOnQuit(restartAfter = false) {
    if (!this.downloaded) return false;

    const currentExeDir = path.dirname(process.execPath);
    if (!isSafeInstallDir(currentExeDir)) {
      writeUpdateLog(`目标目录位于临时目录，中止静默安装: ${currentExeDir}`);
      return false;
    }
    if (this.autoUpdater && this.autoUpdater.installDirectory && path.resolve(this.autoUpdater.installDirectory) !== path.resolve(currentExeDir)) {
      writeUpdateLog(`目标目录不一致，中止静默安装: ${this.autoUpdater.installDirectory} vs ${currentExeDir}`);
      return false;
    }

    writeUpdateLog(`触发退出安装: 目标目录=${currentExeDir} restartAfter=${restartAfter}`);
    try {
      if (this.autoUpdater) {
        this.autoUpdater.autoInstallOnAppQuit = false;
        this.autoUpdater.installDirectory = currentExeDir;
        this.autoUpdater.quitAndInstall(true, restartAfter);
        return true;
      }
      return false;
    } catch (err) {
      writeUpdateLog(`quitAndInstall 异常: ${err.message}`);
      return false;
    }
  }

  checkVersionUpgradeOnStartup(mainWindow) {
    return checkVersionUpgradeOnStartup(mainWindow, this.settingsStore);
  }
}

const updater = new UpdateManager();

module.exports = {
  updater,
  UpdateManager,
  shouldEnableUpdater,
  getSafeInstallArgs,
  isSafeInstallDir,
  checkVersionUpgradeOnStartup,
  prepareQuitForUpdate,
  waitForEngineSettled,
  checkAppOriginFfmpeg,
  writeUpdateLog,
  getUpdaterLogPath,
  cmpVersion
};
