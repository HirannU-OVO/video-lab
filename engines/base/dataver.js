// 数据格式版本守卫：阻止「用旧程序打开新数据」。
//
// 为什么需要它：数据格式一旦破坏性升级（库结构 / 字段语义变化），旧版程序读到的
// 是它不认识的形状 —— 最坏的情况不是报错，而是**看似正常地写坏数据**。
// 用户回退版本往往只是想退回某个功能，不会意识到数据已经不可逆地升级过。
//
// 为什么守卫「数据格式版本」而不是「程序版本」：
//   程序版本每次发版都变；若拿它做守卫，任何一次功能升级后回退都会被拦，
//   对「我只是想退回上个功能版本」的用户过于激进，最终会被绕过或关掉。
//   数据格式版本只在**库结构真的变化时**才 +1，普通功能升级不动它 ——
//   于是「功能回退」照常可用，「格式回退」才拒绝。
//
// ⚠ 一个物理限制：本守卫对**已经发布的旧版本**无效（那些版本的代码里没有这段检查）。
//   所以它只能挡住「从本版之后回退到本版之前」之后再次发生的**向前**升级场景；
//   真正的兜底是升级前备份（见 migrate.js 的 preMigrateBackup）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SettingsStore = require('./settings.js');

/**
 * 当前程序能够读写的**最高**数据格式版本。
 * - 库结构 / 字段语义发生不兼容变化时 +1，并在此处写清「vN 改了什么」；
 * - **不要**随程序版本号变动而改动它。
 *
 * v1 —— 三库同目录（config.json / settings.db / cache.db）+ 扁平化布局。
 */
const DATA_VERSION = 1;

/** 存进 settings.db 的 meta 表的键名 */
const META_KEY = 'data_version';

/**
 * 读取数据版本（**只读**，绝不建表 / 改 journal_mode / 写 WAL）。
 *
 * ⚠ 必须只读：调用点位于启动最早期，一旦用读写连接打开，SQLite 会自动恢复 WAL
 *   并回写文件 —— 那等于在「即将拒绝启动」的路径上污染了更高版本的数据，
 *   比不检查更糟。
 *
 * @param {string} dbPath settings.db 的完整路径
 * @returns {{status:'ok'|'too-new'|'unreadable', found:number|null, supported:number, reason?:string}}
 *   ok        —— 版本不高于当前程序，可以启动
 *   too-new   —— 数据由更高版本的程序写过，**必须拒绝启动**
 *   unreadable —— 库不存在 / 读不到（不可判定）⇒ 调用方应放行，不能因检查本身把用户锁死
 */
function checkDataVersion(dbPath) {
  const supported = DATA_VERSION;
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { status: 'unreadable', found: null, supported, reason: 'settings.db 不存在（首次安装）' };
  }
  let store = null;
  try {
    store = new SettingsStore(dbPath);
    store.open({ readOnly: true });
    const raw = store.getMeta(META_KEY);
    if (!raw) {
      // 库存在但没有版本标记 ⇒ 本版首次接触该数据，视为当前版本（稍后由写侧补记）
      return { status: 'ok', found: null, supported, reason: '尚无版本标记' };
    }
    const found = parseInt(String(raw), 10);
    if (!isFinite(found) || found <= 0) {
      return { status: 'ok', found: null, supported, reason: '版本标记无法解析，按当前版本处理' };
    }
    if (found > supported) {
      return { status: 'too-new', found, supported };
    }
    return { status: 'ok', found, supported };
  } catch (e) {
    // 只读都打不开：可能是权限、损坏、或库正被别的进程独占。
    // 这时**不能**判定为 too-new —— 那会把用户锁在门外且无从自救。
    return { status: 'unreadable', found: null, supported, reason: (e && e.message) || String(e) };
  } finally {
    try { if (store) store.close(); } catch (e) { /* 关闭失败不影响判定 */ }
  }
}

/**
 * 写入数据版本（**读写**）。仅在「确认当前程序能正确处理该数据」之后调用 ——
 * 即首次安装、或迁移成功之后。不要在每次启动时无脑写：那会让「装上新版但没用就回退」
 * 也被判定为数据已升级。
 *
 * @param {string} dbPath
 * @param {number} [ver] 缺省为当前 DATA_VERSION
 * @returns {boolean} 是否写入成功
 */
function writeDataVersion(dbPath, ver) {
  const v = ver == null ? DATA_VERSION : Number(ver);
  let store = null;
  try {
    store = new SettingsStore(dbPath);
    store.open();
    store.setMeta(META_KEY, String(v));
    return true;
  } catch (e) {
    return false;
  } finally {
    try { if (store) store.close(); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 拒绝启动时给用户看的文案。
 *
 * ⚠ 面向**普通用户**，不是开发者：不写版本号、不写"数据格式 / schema"这类词。
 *   用户只需要知道三件事 —— 为什么打不开、该怎么做、哪样东西绝对不能删。
 *   版本号等细节写进日志，排查时再看。
 *
 * ⚠ 语气只陈述事实，不吓唬人：不说"可能把它弄坏"这类后果推演 ——
 *   既然已经拒绝启动了，就不会弄坏；再强调一遍只是让用户更慌。
 *
 * ⚠ 待「迁移前自动备份」落地后，第二条出路应改为引导用备份恢复
 *   （用户不必手动给文件夹改名）。备份目前尚未实现，这里先给可执行的手动路径。
 *   见 migrations 计划中的 preMigrateBackup。
 */
function tooNewMessage(info, dbPath) {
  const dir = dbPath ? path.dirname(dbPath) : '';
  return [
    '软件版本过旧，无法打开这份数据。',
    '这份数据是由更新版本的 Video Lab 创建的。',
    '',
    '请更新到最新版本后再试。',
    '',
    '如果你确实需要用旧版本，请先把下面这个文件夹改名备份，',
    '再重新打开软件（软件会当作全新使用）：',
    dir ? '  ' + dir : '  （软件的数据文件夹）',
    '⚠ 千万不要直接删除这个文件夹，里面是你的项目和设置。',
  ].join('\n');
}

// ── 迁移前自动备份 ──
// 为什么必须有：数据格式迁移是**不可逆**的（旧库被就地改写）。迁移一旦中途失败
// （磁盘满、进程被杀、写了一半），用户既回不到旧结构、也用不了新结构。
// 备份是唯一能在事后把数据捞回来的东西 —— 而且它同时也是「旧版本用户想回退」时的
// 那份可用数据（回退后旧程序读备份，而不是读已被改成新格式的库）。
//
// 存放位置：<数据目录>/backup/_premigrate_v<旧版本>_<时间戳>/ —— 放在数据目录内，
// 因为用户备份数据目录时会一并带走；与既有的 backup/ 同处，符合「备份都在 backup 下」的既有约定。

const BACKUP_SUBDIR = 'backup';
/** 只保留最近几份迁移前备份：每次迁移复制整个 settings.db，攒多了会白占空间 */
const BACKUP_KEEP = 3;

function _pad(n) { return (n < 10 ? '0' : '') + n; }

/** 备份目录名前缀（pruneBackups 靠它识别「这是迁移前备份」） */
const PREMIGRATE_PREFIX = '_premigrate_v';

/**
 * 迁移前备份数据目录里的关键文件。
 *
 * ⚠ 复制的是**多个文件**而非只复制 settings.db：WAL 模式下未提交的事务在
 *   settings.db-wal 里，只拷主库会丢最近写入；config.json 存的是引导配置，
 *   迁移失败后回滚要靠它。
 *
 * @param {string} dbPath settings.db 的完整路径（其余文件按同目录推导）
 * @param {number} fromVersion 迁移前的数据版本（仅用于命名，便于事后辨认）
 * @returns {{ok:boolean, dir:string, files:string[], error?:string}}
 */
function preMigrateBackup(dbPath, fromVersion) {
  const dataDir = path.dirname(dbPath);
  const d = new Date();
  const stamp = d.getFullYear() + _pad(d.getMonth() + 1) + _pad(d.getDate())
    + '-' + _pad(d.getHours()) + _pad(d.getMinutes()) + _pad(d.getSeconds());
  const dir = path.join(dataDir, BACKUP_SUBDIR, PREMIGRATE_PREFIX + (fromVersion == null ? 'x' : fromVersion) + '_' + stamp);
  const names = ['settings.db', 'settings.db-wal', 'settings.db-shm', 'config.json'];
  const copied = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      const src = path.join(dataDir, n);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(dir, n));
      copied.push(n);
    }
    if (!copied.length) {
      return { ok: false, dir, files: [], error: '没有可备份的文件（settings.db 不存在？）' };
    }
    return { ok: true, dir, files: copied };
  } catch (e) {
    return { ok: false, dir, files: copied, error: (e && e.message) || String(e) };
  }
}

/**
 * 清理过旧的迁移前备份，只保留最近 keep 份。
 *
 * ⚠ 只删自己创建的（前缀匹配）：backup/ 下还有别的备份（如用户手动备份、
 *   rootswitch 前的自动备份），不能误删。
 *
 * @returns {{removed:number, kept:number}}
 */
function pruneBackups(dbPath, keep) {
  const n = keep == null ? BACKUP_KEEP : Number(keep);
  const root = path.join(path.dirname(dbPath), BACKUP_SUBDIR);
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.indexOf(PREMIGRATE_PREFIX) === 0)
      .map((e) => e.name)
      .sort();                       // 名字含时间戳 ⇒ 字典序即时间序
  } catch (e) {
    return { removed: 0, kept: 0 };  // backup/ 不存在 ⇒ 无事可做
  }
  const extra = dirs.length - Math.max(0, n);
  if (extra <= 0) return { removed: 0, kept: dirs.length };
  let removed = 0;
  for (const name of dirs.slice(0, extra)) {
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); removed++; }
    catch (e) { /* 单个删不掉不影响其余 */ }
  }
  return { removed, kept: dirs.length - removed };
}

module.exports = {
  DATA_VERSION, META_KEY, BACKUP_KEEP,
  checkDataVersion, writeDataVersion, tooNewMessage,
  preMigrateBackup, pruneBackups,
};
