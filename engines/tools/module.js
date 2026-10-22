// 视频处理工具 · 引擎模块（第 4 个任务模块，与 batch / mask / replica 同机制）
//
// 做成任务模块以复用同一套任务体系：与成片任务共享同一队列（GPU 串行）、进度上报 / 停止 / 暂停 / 互斥锁语义、
// 任务窗口里的徽章与日志；不做独立执行通道（并行跑两路 NVENC 会互相拖慢）。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const pipeline = require('./pipeline');
const canvasRun = require('./canvas-run');

/** 读环境变量里的任务规格（主进程注入的 JSON） */
function readSpec() {
  const raw = String(process.env.TOOL_SPEC || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function isVideo(p) {
  return pipeline.VIDEO_EXTS.has(path.extname(String(p)).toLowerCase());
}

// 待处理文件清单：显式清单优先，否则按目录扫描（跳过应用自管产物目录）
function resolveFiles(spec, storageDir) {
  const list = Array.isArray(spec.files) ? spec.files.filter((p) => p && fs.existsSync(p)) : [];
  if (list.length) return list.slice();
  const root = String(spec.root || '').trim();
  if (root && fs.existsSync(root)) {
    return pipeline.scanVideos(root, { recursive: spec.recursive !== false, storageDir });
  }
  return [];
}

// 本次运行的加锁目录：输出到指定目录时锁该目录，覆盖原文件时锁源文件所在目录（文件可能分散在多个目录，取最上层公共目录）。
function lockDirFor(spec, files) {
  const mode = String((spec.output && spec.output.mode) || '');
  const outDir = String((spec.output && spec.output.dir) || '').trim();
  if (mode === 'directory' && outDir) return outDir;
  const dirs = files.map((f) => path.dirname(path.resolve(f)));
  if (!dirs.length) return '';
  if (dirs.length === 1) return dirs[0];
  let common = dirs[0].split(path.sep);
  for (const d of dirs.slice(1)) {
    const parts = d.split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  const joined = common.join(path.sep);
  return joined || dirs[0];
}

/**
 * 锁文件路径 —— 必须落在**被处理目录之外**，两条原因：
 *   ① 锁文件落在输出目录里会把它变成"非空"，直接破坏「空目录 → 直接输出」规则
 *   ② 不在用户的视频目录里留下与业务无关的残留文件
 */
function lockPathFor(dir) {
  const base = String(process.env.VL_STORAGE_DIR || '').trim() || os.tmpdir();
  const h = crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(base, '.locks', 'tool-' + h + '.lock');
}

async function run(ctx) {
  const logger = ctx.logger;
  const storageDir = String(process.env.VL_STORAGE_DIR || '').trim();
  const spec = readSpec();
  if (!spec) {
    logger.diag('fail', { step: '参数解析', msg: 'TOOL_SPEC 缺失或不是合法 JSON' });
    logger.error('参数解析', 'TOOL_SPEC 缺失或不是合法 JSON');
    return 1;
  }

  // 两种运行模式，**各自独立、互不干扰**：
  //   steps（默认）—— 后处理：步骤链（pipeline.js），带自己的输出设置
  //   canvas       —— 画布合成（竖转横批量）：独立执行器（canvas-run.js），带自己的输出设置
  if (String(spec.mode || 'steps') === 'canvas') {
    try {
      return await canvasRun.run(spec, ctx, { lockDirFor, lockPathFor });
    } catch (e) {
      logger.diag('fail', { step: '处理异常', msg: (e && e.message) || String(e), stack: String((e && e.stack) || '').slice(0, 800) });
      logger.error('处理异常', (e && e.message) || String(e));
      return 1;
    } finally {
      logger.done();
    }
  }

  const stepIds = Array.isArray(spec.stepIds) ? spec.stepIds.map(String) : [];
  if (!stepIds.length) {
    logger.diag('fail', { step: '参数校验', msg: '未选择任何处理步骤', spec: { stepIds: stepIds.length } });
    logger.error('参数校验', '未选择任何处理步骤');
    return 1;
  }

  const files = resolveFiles(spec, storageDir);
  logger.total(files.length);
  if (!files.length) {
    logger.info('未找到可处理的视频（已跳过应用自管的输出/备份目录）');
    logger.done();
    return 0;
  }

  // ── 互斥锁：与其它模块同一套语义（等待 / 已获取 / 已释放 三类协议行）──
  const lockRoot = lockDirFor(spec, files);
  logger.lockWaiting('准备处理视频...');
  let lock = null;
  let code = 1;
  try {
    if (lockRoot) {
      try { lock = await ctx.lock.acquireLock(lockPathFor(lockRoot)); } catch (e) {
        logger.diag('fail', { step: '互斥锁', msg: (e && e.message) || String(e), lockRoot: String(lockRoot || '') });
        logger.error('互斥锁', (e && e.message) || String(e));
        return 1;
      }
    }
    logger.lockAcquired(lockRoot ? ('处理目录 ' + lockRoot) : '');

    logger.section();
    logger.info('步骤：' + stepIds.join(' → '));
    logger.info('输出方式：' + (String((spec.output && spec.output.mode) || '') === 'directory' ? '输出到指定目录' : '覆盖原视频'));
    logger.info('处理前备份：' + ((spec.output && spec.output.backup === false) ? '关闭' : '开启'));
    logger.section();

    let results = null;
    try {
      results = await pipeline.runPipeline({
        files,
        stepIds,
        params: spec.params || {},
        output: spec.output || {},
        storageDir,
        toolName: spec.toolName || '视频处理',
        stats: true,
        onProgress: (ev) => {
          if (!ev) return;
          if (ev.phase === 'item') logger.toolProgress(ev.index, ev.total);
          else if (ev.phase === 'clip-duration') logger.fileDuration(ev.seconds);
          else if (ev.phase === 'sample') {
            logger.info('   样本试算 CQ ' + ev.cq + ' → ' + Math.round(ev.bitrate) + ' kbps（目标 ' + Math.round(ev.target) + '）');
          } else if (ev.phase === 'frame') logger.raw(ev.line);
        },
      });
    } catch (e) {
      logger.diag('fail', { step: '处理异常', msg: (e && e.message) || String(e), stack: String((e && e.stack) || '').slice(0, 800) });
      logger.error('处理异常', (e && e.message) || String(e));
      return 1;
    }

    // ── 逐项结果 ──
    let done = 0, skipped = 0, failed = 0;
    for (const it of results.items) {
      const name = path.basename(it.file);
      if (!it.ok) {
        failed++;
        logger.info('   ❌ ' + name + ' —— ' + (it.reason || '失败'));
        continue;
      }
      if (it.skip) {
        skipped++;
        logger.info('   ⏭️ ' + name + ' —— ' + (it.reason || '无需处理'));
        continue;
      }
      done++;
      logger.info('   ✅ ' + name + (it.out && String(it.out) !== String(it.file) ? (' → ' + path.basename(it.out)) : '（已更新原文件）'));
      for (const n of (it.notes || [])) logger.info('      · ' + n);
    }

    logger.section();
    logger.info('📊 处理完成：完成 ' + done + ' · 跳过 ' + skipped + ' · 失败 ' + failed
      + ' · 共 ' + results.total + ' 个视频');
    logger.info('   编码 ' + results.encodes + ' 次'
      + (results.samples ? ('（另含 ' + results.samples + ' 次样本试算，仅用于确定码率）') : ''));
    if (results.runNote) logger.info(results.runNote);
    if (results.runDir) logger.info('输出目录：' + results.runDir);
    if (results.backupDir) logger.info('备份目录：' + results.backupDir);
    code = failed > 0 ? 1 : 0;
  } finally {
    // 锁必须无条件释放：本进程内不释放会一直占着（同一引擎进程再次运行同目录会等到超时）；未真正持有过锁时不发「已释放」行。
    if (lock) {
      try { lock.release(); } catch (e) {}
      logger.lockReleased();
    }
    logger.done();
  }
  return code;
}

module.exports = {
  id: 'tool',
  title: '视频处理',
  envVars: ['TOOL_SPEC', 'VL_STORAGE_DIR'],
  run,
};
