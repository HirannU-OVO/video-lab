// 输出落点规则（工具共用）
//
// 三条硬规则：
//   1. 覆盖原文件 → 临时文件写完后替换（见 caller；本模块只给路径）
//   2. 输出到指定目录 → **空目录直接输出**；**已有文件则新建子文件夹**
//   3. 落点必须在**开始处理前判定一次并记住** —— 处理中反复判定会导致第一个文件落盘后目录变非空，
//      后续文件被判进另一个子目录（同一批输出被拆散）
'use strict';

const path = require('node:path');
const fs = require('node:fs');
// 临时产物名统一由 paths.tempNameFor 生成（batch / replica / mask 共用）。
//   ① 保留视频扩展名 → 「覆盖原视频」模式下临时文件落在源目录，下次扫描会把它当视频素材；
//   ② 形态不匹配 backend 的残留清理规则（只认 ^[0-9a-z]{6,}\.tmp$）→ 中断残留清不掉、永久占盘。
const paths = require('./paths');

const MODE_OVERWRITE = 'overwrite';   // 覆盖原视频
const MODE_DIRECTORY = 'directory';   // 输出到指定目录

const OUT_SUBDIR_PREFIX = '输出-';    // 新建子目录名前缀（后接时间戳）

/** 目录是否为空（不存在 / 不可读 一律视为空） */
function isEmptyDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return true;
    return fs.readdirSync(dir).length === 0;
  } catch (e) {
    return true;
  }
}

/** 唯一子目录名：重名则追加 -2 / -3 …（最多尝试 999 次） */
function uniqueSubdir(parent, base) {
  let cand = path.join(parent, base);
  if (!fs.existsSync(cand)) return cand;
  for (let i = 2; i <= 999; i++) {
    cand = path.join(parent, base + '-' + i);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(parent, base + '-' + Date.now());
}

/**
 * 判定本次运行的输出根目录 —— **必须在开始处理前调用一次**，之后全程复用其返回值。
 * @param {string} targetDir 用户指定的目标目录
 * @param {string} stamp     时间戳串，如 `0921-1130`（用于新建子目录命名）
 * @returns {{dir:string, created:boolean, reason:string}}
 */
function resolveRunDir(targetDir, stamp, opts) {
  const dir = String(targetDir || '').trim();
  if (!dir) return { dir: '', created: false, reason: '未指定目标目录' };
  // ★ 目录不存在必须先创建 —— 否则「不存在」会被当「空目录」放行，ffmpeg 写盘直接失败（退出码 -2）；创建失败才回退错误。
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return { dir, created: true, reason: '目标目录不存在，已创建' };
    } catch (e) {
      return { dir, created: false, reason: '目标目录不存在且创建失败：' + ((e && e.message) || e) };
    }
  }
  if (isEmptyDir(dir)) return { dir, created: false, reason: '目标目录为空，直接输出到该目录' };
  // ★ noSubdir：**同批任务共享一个输出目录**（批量展开时由提交侧指定）。
  //   默认逻辑是"目标目录非空就新建「输出-MMDD-HHMM」子目录"，同一次提交展开出的 N 个任务会各自建
  //   一个目录、产物散在 N 处；指定后它们写进同一个目录，靠**文件名**区分（提交侧已把区分信息并入后缀）。
  if (opts && opts.noSubdir) return { dir, created: false, reason: '同批任务共享输出目录（不建子目录）' };
  const sub = uniqueSubdir(dir, OUT_SUBDIR_PREFIX + String(stamp || ''));
  try {
    fs.mkdirSync(sub, { recursive: true });
  } catch (e) {
    return { dir, created: false, reason: '创建子目录失败，回退为直接输出：' + e.message };
  }
  return { dir: sub, created: true, reason: '目标目录已有文件，已新建子目录' };
}

/** 备份目录：备份根下按 工具/日期 分层 —— 用户自选的目录只作为根，备份不散落在其根下 */
function backupDirFor(backupRoot, toolName, dateStr) {
  const parts = [String(backupRoot || ''), 'tool', String(toolName || 'misc')];
  if (dateStr) parts.push(String(dateStr));
  return path.join.apply(path, parts);
}

/**
 * 计算单个文件的输出路径。
 * @param {string} outDir   已判定的输出根目录
 * @param {string} srcPath  源文件全路径
 * @param {{nameMode?:'keep'|'suffix', suffix?:string, onConflict?:'index'|'overwrite'|'skip'}} opts
 */
function targetPath(outDir, srcPath, opts) {
  const o = opts || {};
  const base = path.basename(srcPath);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const nameMode = o.nameMode === 'suffix' ? 'suffix' : 'keep';
  const suffix = nameMode === 'suffix' ? String(o.suffix == null ? '_proc' : o.suffix) : '';
  const onConflict = ['overwrite', 'skip'].indexOf(o.onConflict) >= 0 ? o.onConflict : 'index';

  let candidate = path.join(outDir, stem + suffix + ext);
  if (onConflict === 'overwrite' || !fs.existsSync(candidate)) {
    return { path: candidate, skip: false, conflict: false };
  }
  if (onConflict === 'skip') {
    return { path: candidate, skip: true, conflict: true };
  }
  for (let i = 2; i <= 999; i++) {
    candidate = path.join(outDir, stem + suffix + '-' + i + ext);
    if (!fs.existsSync(candidate)) return { path: candidate, skip: false, conflict: true };
  }
  candidate = path.join(outDir, stem + suffix + '-' + Date.now() + ext);
  return { path: candidate, skip: false, conflict: true };
}

/**
 * 临时文件路径（同目录，成功后原子替换；ffmpeg 不允许输入输出同一文件）。
 * 形态委托 paths.tempNameFor：`<base36时间戳+8位随机>.tmp` —— 全仓同一形态，
 * 于是「中途残留的清理」与「续跑时的产物判定」只需认一套规则。
 * ⚠ 返回名**没有扩展名**，调用方必须给 ffmpeg 显式 -f 声明容器。
 */
function tempPathFor(finalPath) {
  return paths.tempNameFor(finalPath);
}

/**
 * 把编码完成的临时产物**原子地**放到最终位置 —— 画布与后处理的唯一落盘入口。
 * 同目录：直接原子改名（同分区内必原子），并套 renameWithRetry 抗 Windows 上杀软 / 索引服务对
 * 「刚写完的大文件」的瞬时占用 —— 单次失败会把**已编码成功**的成片误判为失败。
  * 跨目录（可能跨盘，rename 会 EXDEV 失败）：先复制到**目标目录内的临时名**，再原子改名到目标位置。
 */
async function placeFile(tmp, dest) {
  const sameDir = path.dirname(String(tmp)) === path.dirname(String(dest));
  if (sameDir) return paths.renameWithRetry(tmp, dest);
  const staged = paths.tempNameFor(dest);
  try {
    fs.copyFileSync(tmp, staged);
  } catch (e) {
    try { fs.unlinkSync(staged); } catch (e2) { /* 清理失败不影响返回值 */ }
    return e;
  }
  const err = await paths.renameWithRetry(staged, dest);
  if (err) { try { fs.unlinkSync(staged); } catch (e2) { /* 同上 */ } return err; }
  // 源临时文件用完即删（跨目录路径下才需要；同目录分支已由 rename 移走）
  try { fs.unlinkSync(tmp); } catch (e2) { /* 残留由续跑清理兜底 */ }
  return null;
}

/**
 * 扫描阶段应排除的目录名 —— 备份/预览等应用自管产物**绝不能**被当素材再处理。
 * @param {string} storageDir 数据根
 * @param {string} scanRoot   被扫描的根
 */
function excludedFromScan(storageDir, scanRoot) {
  const names = new Set(['backup', 'tool-spec', 'preview']);
  const out = [];
  const sd = String(storageDir || '');
  const sr = String(scanRoot || '');
  // 只有当 storageDir 落在 scanRoot 之内时，才需要显式排除（否则本就不在扫描范围）
  if (sd && sr && path.resolve(sd).toLowerCase().indexOf(path.resolve(sr).toLowerCase()) === 0) {
    names.forEach((n) => out.push(path.join(sd, n)));
  }
  return out;
}

module.exports = {
  MODE_OVERWRITE, MODE_DIRECTORY,
  isEmptyDir, resolveRunDir, uniqueSubdir,
  backupDirFor, targetPath, tempPathFor, placeFile, excludedFromScan,
};
