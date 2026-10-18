// 画布合成（竖转横）· 引擎侧批量执行器   ← 「执行」这一半；「方案构造」那一半见 canvas-plan.js
//
// 分工与引用关系：
//   · 本文件（canvas-run.js）：**只在引擎子进程运行**，负责探测 / 编码 / 落盘 / 备份 / 进度；
//     引用 canvas-plan.js 取合成方案；被 module.js 以 `run(spec, ctx, { lockDirFor, lockPathFor })` 调用。
//   · canvas-plan.js：纯逻辑（参数模型 + buildCanvasPlan），被主进程（backend.js 预览渲染）与
//     本文件两端共用 —— 这正是两者必须分开、不能合并的原因（主进程不该被拉进探测/编码/落盘依赖）。
//   · 锁：路径计算由调用方注入（它依赖本次扫描出的文件清单，而清单在本文件里才得到）；
//     真正的加锁实现是 base/lock.js 的 acquireLock，与其它模块同一套语义。
//
// 与「后处理」（engines/tools 的步骤链）**互相独立**：不共用步骤清单、不共用输出设置、各自有各自的
// 「开始处理」入口 —— 两者的能力本就有重叠（转分辨率 ↔ 画布尺寸、裁剪/变速 ↔ 合成时长），
// 混在一条滤镜链里会互相干扰（例如两处都想决定输出分辨率）。
//
// 逐文件流程：探测（尺寸/时长/音轨）→ 挑背景（目录随机 = **每个视频独立随机**，原脚本 Get-Random 语义）
//   → 构造 forEncode 滤镜链（canvas-plan 的 buildCanvasPlan）→ 一次编码（NVENC）→ 按输出策略落盘（临时文件成功后替换 + 备份）
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runFfmpeg, nvencArgs } = require('../base/ffmpeg');
const { probeDetail } = require('../base/probe');
const outplan = require('../base/outplan');
const paths = require('../base/paths');
const canvas = require('./canvas-plan');

const IMG_RE = /\.(png|jpg|jpeg|webp|bmp)$/i;
// 视频扩展名以底座为准（保留正则 test 的调用形态）
const VID_RE = { test: (p) => paths.isVideoExt(String(p)) };
const exists = (p) => {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
};

/** 待处理清单：显式 files 优先，否则按目录扫描（复用后处理的 scanVideos：同一套递归与排除规则） */
function resolveFiles(spec, storageDir) {
  const list = Array.isArray(spec.files) ? spec.files.filter((p) => p && fs.existsSync(p)) : [];
  if (list.length) return list.slice();
  const root = String(spec.root || '').trim();
  if (!root || !fs.existsSync(root)) return [];
  const { scanVideos } = require('./pipeline');
  return scanVideos(root, { recursive: spec.recursive !== false, storageDir });
}

/** 背景目录兜底枚举（两层内，按路径稳定排序） */
function listBackgrounds(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= 500 || depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (IMG_RE.test(e.name) || VID_RE.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** 为该文件挑背景：目录随机模式**每个文件独立随机**；候选清单优先用前端带来的（与预览同批） */
function pickBackground(params) {
  const mode = String(params.bgMode || 'dir');
  if (mode === 'color') return { path: '', kind: '', note: '纯色 ' + String(params.bgColor || '#000000') };
  if (mode === 'image' || mode === 'video') {
    const p = String(params.bgPath || '').trim();
    if (!exists(p)) return { error: '背景文件不存在：' + (p || '(未指定)') };
    return { path: p, kind: VID_RE.test(p) ? 'video' : 'image', note: '指定 ' + path.basename(p) };
  }
  let cands = Array.isArray(params.bgList) ? params.bgList.map(String).filter(exists) : [];
  if (!cands.length) {
    const dir = String(params.bgDir || '').trim();
    if (!exists(dir)) return { error: '未选择背景目录' };
    cands = listBackgrounds(dir);
  }
  if (!cands.length) return { error: '背景目录里没有可用素材（图片或视频）' };
  const k = Math.floor(Math.random() * cands.length);
  const p = cands[k];
  return { path: p, kind: VID_RE.test(p) ? 'video' : 'image', note: '背景 ' + (k + 1) + '/' + cands.length + ' · ' + path.basename(p) };
}

const pad2 = (n) => String(n).padStart(2, '0');
const stampOf = (d) => '' + (d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
const isoStampOf = (d) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function run(spec, ctx, lockUtils) {
  const logger = ctx.logger;
  // 锁路径计算由调用方（module.js）注入 —— 锁目录依赖本次扫描出的文件清单，而清单在这里才得到；
  // 未注入时退化为不加锁（正常调用路径不会发生，仅保证单独调用本模块时不崩）
  const lockDirFor = (lockUtils && typeof lockUtils.lockDirFor === 'function') ? lockUtils.lockDirFor : () => '';
  const lockPathFor = (lockUtils && typeof lockUtils.lockPathFor === 'function') ? lockUtils.lockPathFor : () => '';
  const storageDir = String(process.env.VL_STORAGE_DIR || '').trim();
  const params = (spec.params && spec.params.canvas) || {};
  const out = spec.output || {};

  // ── 编码参数（与后处理「转码 / 码率」同一套取值）──
  // 编码格式文案 → NVENC 键。文案与后处理保持一致，用户在两个模块看到的是同一组选项。
  const CODEC_KEYS = { 'H.264': 'h264', 'H.265 / HEVC': 'hevc', 'H.265': 'hevc', 'HEVC': 'hevc', 'AV1': 'av1' };
  const codecKey = CODEC_KEYS[String(params.encCodec || '')] || 'h264';
  const encCqRaw = Number(params.encCq);
  const encCq = isFinite(encCqRaw) ? Math.min(51, Math.max(0, Math.round(encCqRaw))) : 26;
  const container = String(params.container || 'mp4').toLowerCase() === 'mov' ? 'mov' : 'mp4';

  // ── 参数预检（避免遍历到一半才发现没配背景）──
  const bgMode = String(params.bgMode || 'dir');
  if (bgMode === 'image' || bgMode === 'video') {
    const p = String(params.bgPath || '').trim();
    if (!exists(p)) { logger.error('参数校验', '背景文件不存在：' + (p || '(未指定)')); return 1; }
  } else if (bgMode === 'dir') {
    const hasList = Array.isArray(params.bgList) && params.bgList.some(exists);
    if (!hasList && !exists(String(params.bgDir || '').trim())) { logger.error('参数校验', '未选择背景目录'); return 1; }
  }

  const files = resolveFiles(spec, storageDir);
  if (!files.length) {
    logger.total(0);
    logger.info('未找到可处理的视频（已跳过应用自管的输出/备份目录）');
    return 0;
  }

  // ── 产出清单（jobs）──
  // 默认「一个内容一条」；勾选「每个背景各出一批」时按 **内容 × 背景** 展开，
  // 全部在**本任务内**逐条编码 —— 而不是拆成 N 个任务。
  // 为什么放引擎内：拆任务会让「进度 / 失败重试 / 续跑 / 逐任务日志」各自为政，
  // 而且 N 个背景就污染出 N 条任务记录（用户要的是一件事一个任务，进度按产物数走）。
  // 这与遮罩叠加的组织方式一致（那本就是 N 原片 × M 遮罩 在一个任务里跑完）。
  const eachBg = params.eachBackground === true;
  let bgFixed = [];
  if (eachBg) {
    bgFixed = (Array.isArray(params.bgList) ? params.bgList : []).map(String).filter(exists);
    if (bgFixed.length < 2) {
      const bd = String(params.bgDir || '').trim();
      if (exists(bd)) bgFixed = listBackgrounds(bd);
    }
    // 只有 0/1 张时退回「每内容一条」—— 展开没有意义，还会多绕一圈
    if (bgFixed.length < 2) bgFixed = [];
  }
  const jobs = [];
  if (bgFixed.length) {
    for (const f of files) for (const b of bgFixed) jobs.push({ file: f, bgPath: b });
    logger.info('每个背景各出一批：' + bgFixed.length + ' 个背景 × ' + files.length + ' 个内容 = ' + jobs.length + ' 条成片');
  } else {
    for (const f of files) jobs.push({ file: f, bgPath: '' });
  }
  logger.total(jobs.length);

  // ── 互斥锁：与后处理同一套语义（等待 / 已获取 / 已释放）──
  const lockRoot = lockDirFor(spec, files);
  logger.lockWaiting('准备合成视频...');
  let lock = null;
  try {
    if (lockRoot) {
      try { lock = await ctx.lock.acquireLock(lockPathFor(lockRoot)); } catch (e) {
        logger.diag('fail', { step: '互斥锁', msg: (e && e.message) || String(e), lockRoot: String(lockRoot || '') });
        logger.error('互斥锁', (e && e.message) || String(e));
        return 1;
      }
    }
    logger.lockAcquired(lockRoot ? ('处理目录 ' + lockRoot) : '');

    // 输出落点：**处理前判定一次并记住**（否则第一个文件落盘后目录变非空，后续文件会被拆到子目录）
    const now = new Date();
    const dirMode = String(out.mode || '') === outplan.MODE_DIRECTORY;
    let runDir = { dir: '', reason: '', ok: true };
    if (dirMode) {
      runDir = outplan.resolveRunDir(String(out.dir || '').trim(), stampOf(now), { noSubdir: out.noSubdir === true });
      if (!runDir.dir) { logger.error('输出目录', runDir.reason || '未指定输出目录'); return 1; }
    }
    // 备份根：与「视频处理」（pipeline.js）**同一口径** ——
    //   ① 任务自带 backupDir 优先，否则回退设置里的默认备份目录 defaultBackupDir；
    //   ② 用户自选目录时在其下再建「Video Lab 备份」层（设置页显示的也是这一层）；
    //   ③ 都没设才用数据目录下的 backup。
    // ⚠ 必须同时读 out.defaultBackupDir：画布任务不带 backupDir（cvCollectSpec 未传），
    //   只读前者会**永远落到数据目录 backup**，与用户在设置里指定的备份目录无关。
    const customRoot = String(out.backupDir || '').trim() || String(out.defaultBackupDir || '').trim();
    const backupRoot = customRoot ? path.join(customRoot, 'Video Lab 备份') : path.join(storageDir || process.cwd(), 'backup');
    const backupDir = out.backup === false ? ''
      : outplan.backupDirFor(backupRoot, String(spec.toolName || '画布合成'), now.toISOString().slice(0, 10));

    logger.section();
    logger.info('画布合成：' + params.targetW + '×' + params.targetH
      + '·内容 等比 ' + params.scale
      + '·位置 ' + params.posMode
      + (params.radius > 0 ? '·圆角 ' + params.radius : '')
      + (params.borderW > 0 ? '·边框 ' + params.borderW : '')
      + (params.bgBlur > 0 ? '·背景模糊 ' + params.bgBlur : ''));
    logger.info('背景方式：' + (bgFixed && bgFixed.length ? ('每个背景各出一批 · ' + bgFixed.length + ' 个背景') : ({ dir: '目录随机（每个视频独立随机）', image: '指定图片', video: '指定视频', color: '纯色 ' + params.bgColor }[bgMode] || bgMode)));
    logger.info('编码：' + ({ h264: 'H.264', hevc: 'H.265 / HEVC', av1: 'AV1' }[codecKey]) + ' · CQ ' + encCq + ' · 容器 ' + container);
    logger.info('输出方式：' + (dirMode ? '输出到指定目录' : '覆盖原视频'));
    logger.info('处理前备份：' + (out.backup === false ? '关闭' : '开启'));
    if (dirMode) logger.info('输出落点：' + runDir.reason + ' → ' + runDir.dir);
    logger.section();

    let done = 0, skipped = 0, failed = 0, encodes = 0;
    for (let i = 0; i < jobs.length; i++) {
      const file = jobs[i].file;
      // 本条的固定背景（仅「每个背景各出一批」时有）；空则由 pickBackground 随机挑
      const fixedBg = String(jobs[i].bgPath || '');
      // 背景名并入成片名：否则同一内容的多条产物文件名完全相同，
      // 光看文件名无法判断哪条用的是哪张背景图。
      const bgTag = fixedBg ? path.basename(fixedBg, path.extname(fixedBg)) : '';
      logger.toolProgress(i + 1, jobs.length);
      const name = path.basename(file);

      const info = await probeDetail(file);
      if (!info.probeOk) { failed++; logger.info('   ❌ ' + name + ' —— 探测失败（非视频或已损坏）'); continue; }
      if (Number(info.duration) > 0) logger.fileDuration(Number(info.duration));

      const bg = fixedBg
        ? { path: fixedBg, kind: VID_RE.test(fixedBg) ? 'video' : 'image', note: '指定 ' + path.basename(fixedBg) }
        : pickBackground(params);
      if (bg.error) { failed++; logger.info('   ❌ ' + name + ' —— ' + bg.error); continue; }

      // 背景尺寸：用于「小于画布会被放大（可能模糊）」的提醒；探测失败则跳过提醒，不影响处理
      let bgW = 0, bgH = 0;
      if (bg.path) {
        try {
          const bi = await probeDetail(bg.path);
          if (bi && bi.probeOk) { bgW = Number(bi.width) || 0; bgH = Number(bi.height) || 0; }
        } catch (e) {}
      }

      const plan = canvas.buildCanvasPlan(params, {
        contentW: Number(info.width) || 0, contentH: Number(info.height) || 0,
        duration: Number(info.duration) || 0,
        bgPath: bg.path, bgKind: bg.kind,
        bgW: bgW, bgH: bgH,                 // 尺寸不足时由 plan 累积提醒
        watermarkPath: exists(String(params.watermark || '').trim()) ? String(params.watermark).trim() : '',
        bgColorValue: params.bgColor,
      }, { forEncode: true, outLabel: '[vout]' });

      // 目标路径（覆盖原文件时即源文件本身）
      let dest = file;
      if (dirMode) {
        const r = outplan.targetPath(runDir.dir, file, {
          // ⚠ 有固定背景时**强制**用「原名 + 后缀」并把背景名并进去：
          //   同一内容会有多条产物，若沿用「保持原名」它们就完全同名，
          //   光看文件名分不清哪条对应哪张背景（用户要的正是"一眼对上"）。
          nameMode: bgTag ? 'suffix' : out.nameMode,
          suffix: bgTag
            ? ((out.nameMode === 'suffix' && out.suffix) ? String(out.suffix) + '-' + bgTag : '-' + bgTag)
            : out.suffix,
          onConflict: out.onConflict,
        });
        if (r.skip) { skipped++; logger.info('   ⏭️ ' + name + ' —— 目标已存在且策略为跳过'); continue; }
        dest = r.path;
      }
      // 容器格式：目标扩展名要跟着用户选的容器走 —— 否则会出现「按 mp4 封装却顶着 .mov 后缀」
      // 这种名不副实的产物，交给下游（剪辑软件 / 平台）时按扩展名解码必然出错。
      if (dirMode && dest !== file) {
        const wantExt = container === 'mov' ? '.mov' : '.mp4';
        const curExt = path.extname(dest);
        if (curExt.toLowerCase() !== wantExt) dest = dest.slice(0, dest.length - curExt.length) + wantExt;
      }

      // 备份（覆盖原文件前；备份落在源目录之外，不会被下次扫描当素材）
      if (backupDir && exists(file)) {
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          const bDst = path.join(backupDir, isoStampOf(new Date()) + '_' + name);
          fs.copyFileSync(file, bDst);
          // ⚠ 同 pipeline：copyFileSync 继承源 mtime，会被"保留 N 天"的过期清理判为旧货当场删掉，
          //   备份年龄必须从备份时刻算起（详见 pipeline.js 同处注释）。
          try { const now2 = new Date(); fs.utimesSync(bDst, now2, now2); } catch (e2) {}
        } catch (e) { logger.info('   · 备份失败：' + ((e && e.message) || e)); }
      }

      const tmp = outplan.tempPathFor(dest);
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats', '-i', file];
      for (let k = 1; k < plan.ffmpegInputs.length; k++) {
        const inp = plan.ffmpegInputs[k];
        for (const a of (inp.args || [])) args.push(a);       // 输入级选项（-loop / -stream_loop / -f lavfi）
        args.push('-i', inp.lavfi || inp.path);
      }
      args.push('-filter_complex', plan.filterComplex, '-map', '[vout]');
      if (info.hasAudio) args.push('-map', '0:a?');            // 音频取内容视频（背景音轨丢弃）
      args.push('-shortest');
      if (Number(info.duration) > 0) args.push('-t', String(info.duration));   // 无限背景按内容时长精确收尾
      const full = args.concat(nvencArgs(encCq, codecKey))
        // ⚠ 临时名是 `<随机>.tmp`（无扩展名）→ 必须显式 -f 声明容器，否则 ffmpeg 无法推断
        .concat(['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', container, tmp]);

      const r = await runFfmpeg(full, { onProgress: (line) => logger.raw(line) });
      if (r.code !== 0) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
        failed++;
        const tail = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
        logger.info('   ❌ ' + name + ' —— 编码失败：' + (tail || ('退出码 ' + r.code)));
        continue;
      }
      encodes++;

      try {
        const st = fs.statSync(tmp);
        if (!st.size) throw new Error('产物为空');
        // 统一落盘入口：同目录原子改名（带重试）；跨目录先复制到目标目录内的临时名再改名。
        // 覆盖原文件时 dest 与 tmp 同目录，走的也是原子改名。
        const placeErr = await outplan.placeFile(tmp, dest);
        if (placeErr) throw placeErr;
      } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
        failed++;
        logger.info('   ❌ ' + name + ' —— 落盘失败：' + ((e && e.message) || e));
        continue;
      }

      done++;
      logger.info('   ✅ ' + name + (String(dest) !== String(file) ? (' → ' + path.basename(dest)) : '（已更新原文件）')
        + '（' + bg.note + '）');
    }

    logger.section();
    logger.info('📊 处理完成：完成 ' + done + ' · 跳过 ' + skipped + ' · 失败 ' + failed + ' · 共 ' + files.length + ' 个视频');
    logger.info('   编码 ' + encodes + ' 次');
    if (dirMode) logger.info('输出目录：' + runDir.dir);
    if (backupDir) logger.info('备份目录：' + backupDir);
    return failed > 0 ? 1 : 0;
  } finally {
    if (lock) {
      try { lock.release(); } catch (e) {}
      logger.lockReleased();
    }
  }
}

module.exports = { run };
