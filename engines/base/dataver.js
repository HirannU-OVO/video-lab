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

/** 给拒绝启动的场景生成一段用户能看懂的文案（含可执行的下一步）。 */
function tooNewMessage(info, dbPath) {
  const dir = dbPath ? path.dirname(dbPath) : '';
  return [
    '数据格式不兼容，已阻止启动。',
    '',
    '这个数据目录是由更新版本的程序创建的：',
    '  数据格式版本 v' + info.found + '，当前程序只支持到 v' + info.supported + '。',
    '',
    '继续运行可能让数据变得无法读取。请任选一种处理方式：',
    '  1）使用最新版本的程序打开（推荐）；',
    '  2）若要继续使用当前版本，请先备份并移走数据目录：',
    dir ? '     ' + dir : '     （数据目录）',
    '',
    '⚠ 不要直接删除该目录 —— 里面是你的项目设置与缓存。',
  ].join('\n');
}

module.exports = { DATA_VERSION, META_KEY, checkDataVersion, writeDataVersion, tooNewMessage };
