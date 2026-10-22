// 数据格式版本守卫：阻止「用旧程序打开新数据」—— 破坏性升级后旧版程序会读到不认识的形状，最坏是看似正常地写坏数据。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SettingsStore = require('./settings.js');

/**
 * 当前程序能够读写的**最高**数据格式版本。
 * - 库结构 / 字段语义发生不兼容变化时 +1，并在此处写清「vN 改了什么」；
 * - **不要**随程序版本号变动而改动它。
 */
const DATA_VERSION = 1;

/** 存进 settings.db 的 meta 表的键名 */
const META_KEY = 'data_version';

/**
 * 读取数据版本（**只读**，绝不建表 / 改 journal_mode / 写 WAL）。
  * ⚠ 必须只读：调用点位于启动初期，用读写连接打开会让 SQLite 自动恢复 WAL 并回写文件，
 * 等于在「即将拒绝启动」的路径上污染更高版本的数据。
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
    // 只读都打不开：可能是权限、损坏、或库正被别的进程独占；这时**不能**判定为 too-new —— 那会把用户锁在门外且无从自救。
    return { status: 'unreadable', found: null, supported, reason: (e && e.message) || String(e) };
  } finally {
    try { if (store) store.close(); } catch (e) { /* 关闭失败不影响判定 */ }
  }
}

/**
 * 写入数据版本（**读写**）。仅在「确认当前程序能正确处理该数据」之后调用 ——
 * 即首次安装、或迁移成功之后。不要在每次启动时无脑写：那会让「装上新版但没用就回退」
 * 也被判定为数据已升级。
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
// 数据格式迁移不可逆（旧库被就地改写），中途失败（磁盘满 / 进程被杀 / 写了一半）会既回不到旧结构、
// 也用不了新结构，故先整套备份；备份存放在 <数据目录>/backup/_premigrate_v<旧版本>_<时间戳>/，也是回退旧版本时的可用数据。

const BACKUP_SUBDIR = 'backup';
/** 只保留最近几份迁移前备份：每次迁移复制整个 settings.db，攒多了会白占空间 */
const BACKUP_KEEP = 3;

function _pad(n) { return (n < 10 ? '0' : '') + n; }

/** 备份目录名前缀（pruneBackups 靠它识别「这是迁移前备份」） */
const PREMIGRATE_PREFIX = '_premigrate_v';

/**
 * 迁移前备份数据目录里的关键文件。
 * ⚠ 复制的是**多个文件**而非只复制 settings.db：WAL 模式下未提交的事务在 settings.db-wal 里，
 * 只拷主库会丢最近写入；config.json 存的是引导配置，迁移失败后回滚要靠它。
 * @param {string} dbPath settings.db 的完整路径（其余文件按同目录推导）
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
 * ⚠ 只删自己创建的（前缀匹配）：backup/ 下还有别的备份（如用户手动备份、rootswitch 前的自动备份），不能误删。
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
