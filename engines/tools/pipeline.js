// 视频处理工具 · 编排（pipeline）
//
// 四段式：
//   ① 分析 —— probeDetail 拿全（时长/分辨率/帧率/码率/音轨）；需逐帧的步骤（去黑屏）单独扫
//   ② 决策 —— 各步骤算出：待删区间 / 缩放目标 / 倍率 / 目标 CQ
//   ③ 处理 —— **合并成一条滤镜链，一次 ffmpeg 调用**（避免重复编码伤画质与效率）
//   ④ 落盘 —— 按输出策略（覆盖原文件 / 指定目录 + 子目录规则 + 备份）
//
// 两条硬约束：
//   · 时间轴裁剪统一归约（ranges.js）—— 所有区间以**原时间轴**为准
//   · 音画同步 —— 视频 select 与音频 aselect 用**同一条件串**
//
// 唯一的例外是「码率控制」的**目标体积·精确模式**：它必须试编码 → 测码率 → 调 CQ 再编码，
// 天然无法一遍完成。除它之外任何步骤都不允许多遍编码。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runFfmpeg, nvencArgs } = require('../base/ffmpeg');
const { probeDetail } = require('../base/probe');
const outplan = require('../base/outplan');
const vf = require('../base/vf');
const ranges = require('./ranges');
const { listSteps } = require('./index');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv', '.ts']);

/** 扫描目录下的视频（跳过应用自管产物目录，防"备份被当素材"反复增生） */
function scanVideos(root, { recursive = true, storageDir = '' } = {}) {
  const skip = outplan.excludedFromScan(storageDir, root);
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.some((s) => path.resolve(s) === path.resolve(p))) continue;
        if (recursive) walk(p);
        continue;
      }
      if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 解析本次启用的步骤（保持注册表的固定次序） */
function resolveSteps(stepIds, paramsById) {
  const chosen = new Set((stepIds || []).map(String));
  return listSteps()
    .filter((s) => chosen.has(s.id))
    .map((s) => ({ mod: s, params: Object.assign({}, paramsById && paramsById[s.id]) }));
}

/** 单文件：分析 → 决策 → 合并 → 执行 */
async function processFile(file, steps, opts) {
  const o = opts || {};
  const notes = [];
  const pushNote = (t) => { const s = String(t || ''); if (s && notes.indexOf(s) < 0) notes.push(s); };

  const info = await probeDetail(file);
  if (!info.probeOk) return { ok: false, reason: '探测失败（非视频或已损坏）', encodes: 0, notes };
  // 单文件进度分母：任务窗口据此显示「该文件已处理到第几秒」
  if (o.stats && o.onProgress) o.onProgress({ phase: 'clip-duration', file, seconds: Number(info.duration) || 0 });

  // ── ① 分析（需额外分析的步骤）──
  const analyses = {};
  for (const { mod, params } of steps) {
    if (typeof mod.analyze !== 'function') continue;
    try {
      analyses[mod.id] = await mod.analyze(file, params, { signal: o.signal, info });
      if (analyses[mod.id] && analyses[mod.id].note) pushNote(mod.title + '：' + analyses[mod.id].note);
    } catch (e) {
      analyses[mod.id] = null;
      pushNote(mod.title + '：分析失败（' + e.message + '），该步跳过');
    }
  }

  // ── ② 决策 ──
  const decisions = {};
  const cuts = [];
  let keep = [[0, Number(info.duration || 0)]];   // 初始保留集 = 全片
  for (const { mod, params } of steps) {
    let d = null;
    try { d = mod.decide ? mod.decide(info, params, analyses[mod.id]) : null; } catch (e) { d = null; }
    decisions[mod.id] = d;
    if (!d) continue;
    if (Array.isArray(d.keep) && d.keep.length) keep = ranges.intersect(keep, d.keep);   // 截取时间段
    if (Array.isArray(d.cuts)) cuts.push.apply(cuts, d.cuts);                            // 删帧 / 去黑屏
    if (d.note) pushNote(mod.title + '：' + d.note);
    if (d.skip && d.reason) pushNote(mod.title + '：' + d.reason);
  }
  const keepSet = ranges.subtract(keep, cuts);
  const trimmed = !ranges.coversAll(keepSet, info.duration);
  if (trimmed && !keepSet.length) {
    return { ok: true, skip: true, encodes: 0, notes,
      reason: '裁剪后无可保留内容，已跳过（原文件不变）' };
  }

  // ── ③ 合并滤镜链 ──
  // 步骤滤镜的应用抽成函数：码率试算需要一条**不含时间轴裁剪**的样本链
  // （样本只测编码器对 CQ 的码率响应，select/setpts 与否不影响该响应）
  const applyStepFilters = (chain) => {
    for (const { mod } of steps) {
      const d = decisions[mod.id];
      if (!d || d.skip || typeof mod.filter !== 'function') continue;
      let f = null;
      try { f = mod.filter(d, info, chain) || null; } catch (e) { f = null; }
      if (!f) continue;
      (f.video || []).forEach((x) => chain.vf(x));
      (f.audio || []).forEach((x) => { if (info.hasAudio) chain.af(x); });
      if (f.note) pushNote(mod.title + '：' + f.note);
    }
  };

  const chain = vf.createChain({ hasAudio: info.hasAudio });
  if (trimmed) {
    chain.vf(ranges.videoFilter(keepSet));                       // select + setpts
    if (info.hasAudio) chain.af(ranges.audioFilter(keepSet));    // 同一条件串 → 音画同步
  }
  applyStepFilters(chain);
  // ── 编码参数（复用三模块的硬约束，CQ 可被「码率控制」步骤覆盖）──
  const enc = decisions.encode || {};
  const ramp = (enc && enc.ramp) ? {
    initialCq: Number(enc.ramp.initialCq),
    increment: Math.max(1, Number(enc.ramp.increment) || 1),
    maxCq: Number(enc.ramp.maxCq),
    targetKbps: Number(enc.ramp.targetKbps),
  } : null;
  // 「码率控制」步骤本身不产出滤镜片段，但**要求重编码一遍** ——
  // 若只看滤镜链是否为空，就会把它误判成「无需处理」而直接跳过。
  const encodeWanted = !!ramp || (enc.cq != null && isFinite(Number(enc.cq)));

  if (chain.isEmpty() && !trimmed && !encodeWanted) {
    return { ok: true, skip: true, encodes: 0, notes,
      reason: notes.length ? notes.join('；') : '所有步骤对本文件均无需处理' };
  }

  // ── ④ 落盘 ──
  const finalPath = o.destPath(file);
  if (finalPath.skip) return { ok: true, skip: true, reason: '目标已存在且策略为跳过', encodes: 0, notes };
  try {
    if (o.backupDir && fs.existsSync(file)) {
      fs.mkdirSync(o.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dst = path.join(o.backupDir, stamp + '_' + path.basename(file));
      fs.copyFileSync(file, dst);
      // ⚠ copyFileSync 会**继承源文件的 mtime**（Windows CopyFile 行为；实测素材的 8 月时间戳被原样带过来），
      //   而「备份自动清理」按 mtime 判过期（保留 N 天）—— 于是**刚写下的备份被当成几个月前的旧货当场清掉**，
      //   表现为"备份目录建了却是空的"。备份的年龄应从**备份时刻**算起，故显式写入当前时间。
      try { const now = new Date(); fs.utimesSync(dst, now, now); } catch (e2) { /* 时间戳写失败不影响备份本身 */ }
    }
  } catch (e) { pushNote('备份失败：' + e.message); }

  const tmp = outplan.tempPathFor(finalPath.path);
  const built = chain.build();
  // -stats：让 ffmpeg 持续输出帧进度行（frame= / time=），任务窗口据此显示实时进度
  const head = ['-y', '-hide_banner', '-loglevel', 'error'].concat(o.stats ? ['-stats'] : [])
    .concat(['-i', file]).concat(built.inputArgs || []);
  const tail = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp];
  const forward = o.stats && o.onProgress
    ? (line) => o.onProgress({ phase: 'frame', file, line })
    : o.onProgress;

  /** 一轮编码；返回 {ok, code} */
  const encodeOnce = async (cqNow) => {
    const list = head.concat(built.args).concat(nvencArgs(cqNow, enc.codec)).concat(tail);
    const r = await runFfmpeg(list, { signal: o.signal, onProgress: forward });
    // 失败时带上 ffmpeg 错误尾部（诊断不丢失）
    const errTail = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    return { ok: r.code === 0, code: r.code, errTail };
  };

  let encodes = 0;      // 整片编码次数（正常恒为 1）
  let samples = 0;      // 码率试算的样本编码次数（仅「码率上限 / 目标体积」会出现）

  if (!ramp) {
    encodes = 1;
    const r = await encodeOnce(enc.useAbr ? null : enc.cq);
    if (!r.ok) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
      pushNote('ffmpeg：' + (r.errTail || '（无错误输出）'));
      return { ok: false, reason: '编码失败（退出码 ' + r.code + '）', encodes: 0, samples, notes };
    }
  } else {
    // ── 码率上限 / 目标体积：先按 10% 样本试算定 CQ，再整片只编码一遍 ──
    // NVENC 没有 2-pass，反复整片重编码（原脚本做法）代价太大且画质被反复损失 ——
    // 样本试算 → 整片一遍出片（画质只损失一次）。
    const from = isFinite(ramp.initialCq) ? ramp.initialCq : 26;
    const to = isFinite(ramp.maxCq) ? ramp.maxCq : 40;
    const inc = ramp.increment;
    const dur = Number(info.duration) || 0;
    const sampleLen = dur > 0 ? Math.max(1, Math.min(20, dur * 0.1)) : 0;

    // 样本链：只含步骤滤镜，不含时间轴裁剪（样本测的是编码器对 CQ 的码率响应）
    const sampleChain = vf.createChain({ hasAudio: info.hasAudio });
    applyStepFilters(sampleChain);
    const sBuilt = sampleChain.build();
    const tmpSample = outplan.tempPathFor(tmp);
    const sTail = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmpSample];

    /** 编一段样本并测码率（失败返回 -1） */
    const trySample = async (cqNow) => {
      const sArgs = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (sampleLen > 0 && dur > sampleLen + 1) {
        // 从中部取样：片头片尾（黑场、字幕条）通常不能代表整片复杂度
        sArgs.push('-ss', String(Math.round(dur * 0.45 * 1000) / 1000),
          '-t', String(Math.round(sampleLen * 1000) / 1000));
      }
      sArgs.push('-i', file);
      const r = await runFfmpeg(sArgs.concat(sBuilt.inputArgs || []).concat(sBuilt.args)
        .concat(nvencArgs(cqNow, enc.codec)).concat(sTail), { signal: o.signal });
      samples++;
      if (r.code !== 0) return -1;
      const bit = await measureBitrateKbps(tmpSample);
      try { if (fs.existsSync(tmpSample)) fs.unlinkSync(tmpSample); } catch (e) {}
      return bit;
    };

    let chosen = null;
    let lastBit = 0;
    for (let k = 0; k < 64; k++) {
      const cqNow = Math.min(to, from + k * inc);
      lastBit = await trySample(cqNow);
      if (o.onProgress) o.onProgress({ phase: 'sample', file, cq: cqNow, bitrate: lastBit, target: ramp.targetKbps });
      if (lastBit > 0 && lastBit <= ramp.targetKbps) { chosen = cqNow; break; }
      if (cqNow >= to) break;
    }
    try { if (fs.existsSync(tmpSample)) fs.unlinkSync(tmpSample); } catch (e) {}

    if (chosen == null) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
      pushNote('码率未达标：样本试算到 CQ ' + to + ' 仍为 ' + Math.round(lastBit)
        + ' kbps > 目标 ' + Math.round(ramp.targetKbps) + ' kbps');
      return { ok: true, skip: true, encodes: 0, samples, notes,
        reason: '目标体积未达成，已保留原文件（未做任何改动）' };
    }

    encodes = 1;
    const r = await encodeOnce(chosen);
    if (!r.ok) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
      pushNote('ffmpeg：' + (r.errTail || '（无错误输出）'));
      return { ok: false, reason: '编码失败（退出码 ' + r.code + '）', encodes: 0, samples, notes };
    }
    // 整片实测复核：样本只是估计，整片仍超目标时按原脚本语义保留原文件
    const finalBit = await measureBitrateKbps(tmp);
    if (ramp.targetKbps > 0 && finalBit > ramp.targetKbps * 1.03) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
      pushNote('整片实测 ' + Math.round(finalBit) + ' kbps 仍高于目标 '
        + Math.round(ramp.targetKbps) + ' kbps');
      return { ok: true, skip: true, encodes, samples, notes,
        reason: '目标体积未达成，已保留原文件（未做任何改动）' };
    }
  }

  try {
    const st = fs.statSync(tmp);
    if (!st.size) throw new Error('产物为空');
    if (o.mode === outplan.MODE_OVERWRITE) fs.renameSync(tmp, finalPath.path);
    else { fs.copyFileSync(tmp, finalPath.path); fs.unlinkSync(tmp); }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    return { ok: false, reason: '落盘失败：' + e.message, encodes, notes };
  }
  return { ok: true, out: finalPath.path, encodes, samples, notes, trimmed };
}

/** 测容器码率（kbps）—— 与「码率阈值」比较用，含音轨，口径同原脚本 */
async function measureBitrateKbps(file) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    // 与 base/probe.js 统一口径：只认注入的 VL_FFPROBE_BIN
    // ⚠ 不要用裸名 ffprobe：同文件内两种口径并存会在无 PATH 时静默失败
    const bin = process.env.VL_FFPROBE_BIN || '';
    if (!bin) return resolve(0);
    let child;
    try {
      child = spawn(bin, ['-v', 'error', '-show_entries', 'format=bit_rate',
        '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true });
    } catch (e) { return resolve(0); }
    child.stdout && child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('error', () => resolve(0));
    child.on('close', () => resolve((parseFloat(out.trim()) || 0) / 1000));
  });
}

/**
 * 批量执行。
 * @param {{files?:string[], root?:string, recursive?:boolean, stepIds:string[],
 *   params:Object, output:Object, storageDir:string, toolName?:string,
 *   onProgress?:Function, signal?:any}} opts
 */
async function runPipeline(opts) {
  const o = opts || {};
  const storageDir = String(o.storageDir || '');
  const output = Object.assign({}, o.output);

  // 输入清单
  const files = Array.isArray(o.files) && o.files.length
    ? o.files.slice()
    : (o.root ? scanVideos(o.root, { recursive: o.recursive !== false, storageDir }) : []);

  // 落点：**开始处理前判定一次并记住**（处理中反复判定会把同一批输出拆散）
  const stamp = (function () {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  })();
  let runDir = '';
  let runNote = '';
  if (output.mode === outplan.MODE_DIRECTORY) {
    const rr = outplan.resolveRunDir(output.dir, stamp, { noSubdir: output.noSubdir === true });
    runDir = rr.dir;
    if (rr.reason) runNote = '输出落点：' + rr.reason;
  }

  // 备份根：默认用数据目录下的 backup（本身就在应用专属目录内）；
  // 用户自选目录（如 E:\Cache）时，在其下再建一层应用专属文件夹 ——
  // ① 备份不散落在用户目录根下；② 避免与别的应用的同名子文件夹（如 tool）混淆
  // ⚠ 层级必须是 `output.defaultBackupDir`（= spec.output.defaultBackupDir，后端 runTool 填的设置项）。
  //   不能读顶层的 `o.defaultBackupDir`：调用方（engines/tools/module.js）只传 output、不传顶层，
  //   该值恒为 undefined → 任务没带 backupDir 就一律落到数据目录 backup，
  //   表现为「设了备份路径却仍落在数据目录」。
  const customRoot = String(output.backupDir || '').trim() || String(output.defaultBackupDir || '').trim();
  const backupRoot = customRoot ? path.join(customRoot, 'Video Lab 备份') : path.join(storageDir, 'backup');
  // ⚠ 开关语义：`output.backup === true` 表示**用户勾选了「处理前备份」**（见 tool.js outCollect：
  //   `d.backup = !!$('outBackup').checked`，与「已开启备份」的告警文案一致）。
  //   ⚠ 分支不可写反：写成 `=== true ? '' : 备份` 会「勾了备份反而不备份、不勾反而备份」。
  const backupDir = output.backup === true
    ? outplan.backupDirFor(backupRoot, o.toolName || 'misc')
    : '';

  const steps = resolveSteps(o.stepIds, o.params);
  const results = { total: files.length, ok: 0, failed: 0, skipped: 0, encodes: 0, samples: 0, items: [] };

  for (let i = 0; i < files.length; i++) {
    if (o.signal && o.signal.aborted) break;
    const f = files[i];
    if (o.onProgress) o.onProgress({ phase: 'item', index: i + 1, total: files.length, file: f });
    try {
      const r = await processFile(f, steps, {
        mode: output.mode,
        signal: o.signal,
        stats: o.stats === true,
        onProgress: o.onProgress,
        backupDir,
        destPath: (src) => {
          if (output.mode === outplan.MODE_OVERWRITE) return { path: src, skip: false, conflict: false };
          return outplan.targetPath(runDir, src, {
            nameMode: output.nameMode, suffix: output.suffix, onConflict: output.onConflict,
          });
        },
      });
      results.encodes += r.encodes || 0;
      results.samples += r.samples || 0;
      if (r.ok && r.skip) results.skipped++;
      else if (r.ok) results.ok++;
      else results.failed++;
      results.items.push({ file: f, ok: !!r.ok, skip: !!r.skip, out: r.out || '', reason: r.reason || '',
        notes: r.notes || [], encodes: r.encodes || 0, samples: r.samples || 0, trimmed: !!r.trimmed });
    } catch (e) {
      results.failed++;
      results.items.push({ file: f, ok: false, reason: String(e && e.message || e) });
    }
  }
  results.runDir = runDir;
  results.runNote = runNote;
  results.backupDir = backupDir;
  return results;
}

module.exports = { runPipeline, processFile, scanVideos, resolveSteps, VIDEO_EXTS };
