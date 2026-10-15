// engines/modules/mask/index.js —— 遮罩叠加（迁移自旧版脚本，行为等价优先）
// 模式1=遮罩+水印（预处理预合成）/ 模式2=仅水印 / 模式3=仅遮罩；多原片×多遮罩全组合。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runFfmpeg } = require('../../base/ffmpeg');
const { probe, probeDetail } = require('../../base/probe');
const { acquireLock } = require('../../base/lock');
const { exists, getMaskDirName, renameWithRetry, tempNameFor } = require('../../base/paths');

const RAW_EXTS = ['*.mp4', '*.mov', '*.avi', '*.mkv', '*.m4v', '*.webm', '*.flv'];
const MASK_EXTS = ['*.mov', '*.mp4'];

const splitList = (s) => String(s == null ? '' : s).split(';').map((x) => x.trim()).filter(Boolean);
const uniq = (arr) => Array.from(new Set(arr)).sort();

function readEnv(env = process.env) {
  const n = (k, d = '') => (env[k] == null ? d : String(env[k]));
  let mode = parseInt(n('MASK_MODE', '1'), 10);
  if (![1, 2, 3].includes(mode)) mode = 1;
  let alpha = 0.3;
  const a = parseFloat(n('MASK_WATERMARK_ALPHA'));
  if (!Number.isNaN(a) && a >= 0.05 && a <= 1.0) alpha = a;
  const ts = parseInt(n('MASK_SUBMIT_TS', '0'), 10) || 0;
  return {
    mode,
    alpha,
    rawDirs: splitList(n('MASK_RAW_DIRS')),
    videos: splitList(n('MASK_VIDEOS')),
    maskDirs: splitList(n('MASK_MASK_DIRS')),
    masks: splitList(n('MASK_MASKS')),
    watermark: n('MASK_WATERMARK'),
    outputDir: n('MASK_OUTPUT_DIR'),
    logDir: n('MASK_LOG_DIR'),
    onlyNames: splitList(n('MASK_ONLY_NAMES')),
    suffixMark: n('MASK_SUFFIX_MARK'),
    submitTs: ts,
    projectName: n('MASK_PROJECT_NAME'),
  };
}

/** 任务日期：提交时刻优先（跨天不回退实际运行日期） */
function taskDate(submitTs) {
  return submitTs > 0 ? new Date(submitTs) : new Date();
}
function pad(n) { return String(n).padStart(2, '0'); }

/** 递归扫描扩展名集合（对齐 PS 的 Get-ChildItem -Filter -Recurse + Sort-Unique） */
function scanByExts(dirs, patterns) {
  const out = [];
  for (const d of dirs) {
    let ok = false;
    try { ok = fs.statSync(d).isDirectory(); } catch (e) { ok = false; }
    if (!ok) continue;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        if (patterns.some((p) => p.slice(1).toLowerCase() === ext)) out.push(full);
      }
    };
    walk(d);
  }
  return uniq(out);
}

function safeBaseName(p) {
  return path.basename(p, path.extname(p)).replace(/[\\/:*?"<>|]/g, '_');
}

/** 转义正则以做“以 X 开头”判断（PS 的 StartsWith 语义） */
function startsWith(s, prefix) { return s.startsWith(prefix); }

function buildJobs(cfg, allVideos, allMasks, dateStr) {
  const yy = `${String(dateStr.getFullYear()).slice(2)}${pad(dateStr.getMonth() + 1)}${pad(dateStr.getDate())}`;
  const jobs = [];
  if (cfg.mode === 2) {
    for (const vp of allVideos) {
      const base = safeBaseName(vp);
      const outName = `${base}-水印${cfg.suffixMark ? '-' + cfg.suffixMark : ''}.mp4`;
      let dirName = base.replace(/-水印$/, '');
      if (!dirName.trim()) dirName = base;
      if (cfg.suffixMark) dirName += `-${cfg.suffixMark}`;
      jobs.push({ vidPath: vp, maskPath: '', outFile: path.join(cfg.outputDir, dirName, outName), outName, theme: yy });
    }
    return jobs;
  }
  for (const vp of allVideos) {
    for (const mp of allMasks) {
      const maskName = path.basename(mp, path.extname(mp));
      const theme = maskName;
      const vidIdx = allVideos.indexOf(vp) + 1;
      const projName = cfg.projectName && cfg.projectName.trim() ? cfg.projectName : theme;
      // 遮罩名常已带项目名前缀 → 不再重复拼接，避免成片名出现两个项目名
      const dedupName = startsWith(maskName, projName) ? maskName : `${projName}-${maskName}`;
      const baseName = `${yy}-${dedupName}`;
      let dirName = getMaskDirName(`${baseName}-${vidIdx}.mp4`);
      if (cfg.suffixMark) dirName += `-${cfg.suffixMark}`;
      const outName = `${baseName}-${cfg.suffixMark}${vidIdx}.mp4`;
      jobs.push({ vidPath: vp, maskPath: mp, outFile: path.join(cfg.outputDir, dirName, outName), outName, theme });
    }
  }
  return jobs;
}

/** 续跑过滤：成片名或其去扩展名形式命中即保留（PS 的 OutName/BaseName 双匹配） */
function filterOnlyNames(jobs, onlyNames) {
  if (!onlyNames.length) return jobs;
  const bases = onlyNames.map((n) => path.basename(n, path.extname(n)));
  return jobs.filter((j) => {
    const b = path.basename(j.outName, path.extname(j.outName));
    return onlyNames.includes(j.outName) || bases.includes(b);
  });
}

async function durationOf(p) {
  const info = await probe(p);
  return info && info.duration > 0 ? info.duration : 0;
}

function makeFfArgs(args, logger) {
  return runFfmpeg(args, {
    onProgress: (line) => logger.raw(line),
  });
}

async function run(ctx, env = process.env) {
  const { logger } = ctx;
  const cfg = readEnv(env);
  const fail = (msg, step) => { logger.diag('fail', { step: String(step || ''), msg: String(msg || '').slice(0, 300) }); logger.error(step, msg); return 1; };

  // ── 参数校验（与 PS1 顺序、文案一致） ──
  if (!cfg.rawDirs.length || !cfg.outputDir.trim()) {
    return fail('未选择原片文件夹或输出目录：请在主窗口重新选择后开始制作', '参数校验');
  }
  if ((cfg.mode === 1 || cfg.mode === 3) && !cfg.maskDirs.length && !cfg.masks.length) {
    return fail(`缺少遮罩（模式 ${cfg.mode} 需要：遮罩目录或 .mov 文件）`, '参数校验');
  }
  if ((cfg.mode === 1 || cfg.mode === 2) && !cfg.watermark.trim()) {
    return fail(`缺少水印文件（模式 ${cfg.mode} 需要）`, '参数校验');
  }
  if (cfg.mode !== 2) {
    // 遮罩项可以是目录（扫描其下 .mov），也可以是用户直接添加的单个 .mov 文件 —— 两者都算可用
    const dirCount = cfg.maskDirs.filter((d) => { try { const st = fs.statSync(d); return st.isDirectory() || st.isFile(); } catch (e) { return false; } }).length;
    const fileCount = cfg.masks.filter((m) => { try { return fs.statSync(m).isFile(); } catch (e) { return false; } }).length;
    if (dirCount === 0 && fileCount === 0) {
      return fail(`遮罩均不存在：${cfg.maskDirs.join(';')}${cfg.masks.length ? ' / ' + cfg.masks.join(';') : ''}`, '遮罩扫描');
    }
  }
  try { fs.mkdirSync(cfg.outputDir, { recursive: true }); } catch (e) {}
  if (cfg.mode !== 3 && !exists(cfg.watermark)) {
    return fail(`水印文件不存在：${cfg.watermark}`, '参数校验');
  }

  // ── 扫描原片 ──
  let allVideos = scanByExts(cfg.rawDirs, RAW_EXTS);
  for (const rd of cfg.rawDirs) {
    try { if (!fs.statSync(rd).isDirectory()) logger.warn(`原片文件夹不存在，已跳过：${rd}`); } catch (e) { logger.warn(`原片文件夹不存在，已跳过：${rd}`); }
  }
  if (cfg.videos.length) {
    const pick = new Set(cfg.videos);
    allVideos = allVideos.filter((v) => pick.has(v));
  }
  if (!allVideos.length) return fail('未找到任何原片视频', '原片扫描');

  // ── 扫描遮罩 ──
  let allMasks = [];
  if (cfg.mode !== 2) {
    // 目录项 → 扫描其下 .mov；直接给出的文件项 → 作为单个遮罩直接使用
    const dirItems = [], fileItems = [];
    for (const d of cfg.maskDirs) {
      let isFile = false;
      try { isFile = fs.statSync(d).isFile(); } catch (e) {}
      (isFile ? fileItems : dirItems).push(d);
    }
    const extOk = (f) => MASK_EXTS.some((p) => p.slice(1).toLowerCase() === path.extname(f).toLowerCase());
    allMasks = scanByExts(dirItems, MASK_EXTS).concat(fileItems.filter(extOk));
    const pick = new Set(cfg.masks.concat(fileItems));
    if (pick.size) allMasks = allMasks.filter((m) => pick.has(m));
    if (!allMasks.length) return fail(`未找到任何遮罩素材（${cfg.maskDirs.join(';')}）`, '遮罩扫描');
  }

  // ── 构建任务列表 + 续跑过滤 ──
  const dateStr = taskDate(cfg.submitTs);
  let jobs = buildJobs(cfg, allVideos, allMasks, dateStr);
  jobs = filterOnlyNames(jobs, cfg.onlyNames);
  if (cfg.onlyNames.length && !jobs.length) {
    return fail(`未找到指定成片：${cfg.onlyNames.join('、')}`, '续跑过滤');
  }

  // ── 模式1：遮罩+水印预处理（独立临时目录，任务结束清理） ──
  const combinedMap = new Map();
  let combineDir = null;
  if (cfg.mode === 1) {
    combineDir = path.join(os.tmpdir(), 'MaskWatermarkTemp');
    try { fs.mkdirSync(combineDir, { recursive: true }); } catch (e) {}
    for (const j of jobs) {
      if (combinedMap.has(j.maskPath)) continue;
      const maskName = path.basename(j.maskPath, path.extname(j.maskPath));
      let lastWrite = '';
      try { const st = fs.statSync(j.maskPath); lastWrite = st.mtime.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); } catch (e) {}
      const combinedPath = path.join(combineDir, `combined_${maskName}_${lastWrite}.mov`);
      if (exists(combinedPath)) { combinedMap.set(j.maskPath, combinedPath); continue; }
      logger.info('');
      logger.info(`🔧 预处理合并遮罩与水印：${maskName} ...`);
      let maskDur = await durationOf(j.maskPath);
      if (maskDur <= 0) maskDur = 5.0;
      const filter = `[0:v]trim=duration=${maskDur},setpts=PTS-STARTPTS[mask];[1:v]trim=duration=${maskDur},setpts=PTS-STARTPTS,colorchannelmixer=aa=${cfg.alpha}[wm];[mask][wm]overlay=0:0[outv]`;
      const args = ['-y', '-loglevel', 'error', '-stats',
        '-i', j.maskPath, '-i', cfg.watermark,
        '-filter_complex', filter,
        '-map', '[outv]', '-map', '0:a?',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        '-c:a', 'aac', '-b:a', '192k',
        combinedPath];
      const { code } = await makeFfArgs(args, logger);
      if (code !== 0 || !exists(combinedPath)) return fail(`遮罩与水印预处理失败：${maskName}`, '预处理');
      logger.info('✅ 预处理完成');
      combinedMap.set(j.maskPath, combinedPath);
    }
  }

  // ── 主流程（锁 + 批量合成） ──
  const lockPath = path.join(cfg.outputDir, '.video-lab-mask.lock');
  logger.lockWaiting();
  const lock = await acquireLock(lockPath);
  logger.lockAcquired('开始遮罩叠加任务');
  let hasError = false;
  try {
    const total = jobs.length;
    const themeLogs = new Map();
    logger.info('');
    logger.info(`开始遮罩叠加，共 ${total} 个成片`);
    for (let i = 0; i < total; i++) {
      const j = jobs[i];
      const idx = i + 1;
      logger.raw('-'.repeat(48));   // 与 batch 同款片头分隔线（统一任务日志格式）
      logger.info('');
      logger.info(`生成第 ${idx} / ${total} 个成片：${j.outName}`);

      // 跳过检测：输出已存在且时长一致（±1s）
      let skip = false;
      if (exists(j.outFile)) {
        let srcPath = cfg.mode === 2 ? j.vidPath : j.maskPath;
        if (combinedMap.has(j.maskPath)) srcPath = combinedMap.get(j.maskPath);
        const expected = await durationOf(srcPath);
        const existing = await durationOf(j.outFile);
        if (expected > 0 && existing > 0 && Math.abs(expected - existing) <= 1.0) skip = true;
      }
      if (skip) { logger.info('   ⏭️ 跳过（已存在且时长一致）'); continue; }
      if (exists(j.outFile)) logger.info('   🔄 覆盖现有文件');

      const subDir = path.dirname(j.outFile);
      if (subDir) { try { fs.mkdirSync(subDir, { recursive: true }); } catch (e) {} }

      // 与 batch/replica 同规则：先写 `<随机>.tmp` 临时名（与正式名完全无关），编码成功后原子改名 ——
      // 否则编码中途停止会留下正式名半截文件（用户误取 / 跳过检测误判）。见 batch/index.js 同处说明。
      const tmpOut = tempNameFor(j.outFile);

      let targetDur;
      let ffArgs;
      if (cfg.mode === 2) {
        let vidDur = await durationOf(j.vidPath);
        if (vidDur <= 0) vidDur = 5.0;
        targetDur = vidDur;
        const filter = `[0:v]trim=duration=${vidDur},setpts=PTS-STARTPTS[base];[1:v]trim=duration=${vidDur},setpts=PTS-STARTPTS,colorchannelmixer=aa=${cfg.alpha}[wm];[base][wm]overlay=0:0[outv]`;
        ffArgs = ['-y', '-loglevel', 'error', '-stats',
          '-i', j.vidPath, '-i', cfg.watermark,
          '-filter_complex', filter,
          '-map', '[outv]', '-map', '0:a?',
          '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '25',
          '-c:a', 'aac', '-b:a', '192k', '-shortest',
          // 临时名无扩展名可推断容器 → 必须显式 -f mp4（与 batch/replica 同）
          '-f', 'mp4',
          tmpOut];
      } else {
        const srcForDur = cfg.mode === 1 ? combinedMap.get(j.maskPath) : j.maskPath;
        let vidDur = await durationOf(j.vidPath);
        if (vidDur <= 0) vidDur = 5.0;
        let maskDur = await durationOf(srcForDur);
        if (maskDur <= 0) maskDur = 5.0;
        targetDur = Math.min(vidDur, maskDur);
        if (vidDur < maskDur && (maskDur - vidDur) > 1.0) {
          logger.warn(`原片时长（${Math.round(vidDur * 100) / 100} s）比遮罩时长（${Math.round(maskDur * 100) / 100} s）短超过1秒，将按原片时长输出`);
        }
        // 音频来源判定：有音频流还不够 —— 可能是静音音轨（有流但全程没声音），
        // 这种情况按「无音频」处理，成片改用原视频音轨，否则成片会没有声音。
        //
        // ⚠ 留痕分两条通道，各司其职（沿用引擎既有的诊断通道设计）：
        //   · **用户视图**（任务窗口）只给一句话结论：用户关心的是「这条音轨从哪来」，
        //     不需要看文件名 / 分贝值 / 探测字段（实测反馈：一行太长）。
        //   · **运行日志**（engine-<日期>.log）给**完整可定位**的信息：完整文件路径、
        //     探测字段、实测均值、最终决定。缺了它就无法回答「判的到底是哪个文件」——
        //     遮罩常来自外部素材文件夹（同名文件遍地），只给 basename 根本定位不到；
        //     而 mode 1 探测的还是**预处理后的合并文件**（%TEMP%\MaskWatermarkTemp\combined_*.mov），
        //     用户更会误以为是自己的原遮罩有问题，方向从一开始就错了。
        //   实现走 `@@VLDIAG@@` 前缀行：backend 的 pushLine 会先把**所有**引擎行落进
        //   engine 日志（在状态检查之前），再把带前缀的行从用户视图里剥离 —— 正好是我们要的两分法。
        const srcLabel = srcForDur ? path.basename(String(srcForDur)) : '(空)';
        const srcKind = cfg.mode === 1 ? '预处理合并文件' : '遮罩原文件';
        const diagAudio = (decision, extra) => {
          try {
            logger.raw('@@VLDIAG@@' + JSON.stringify([{
              t: Date.now(), ev: 'mask.audioProbe',
              d: Object.assign({
                kind: srcKind,                 // 预处理合并文件 / 遮罩原文件
                file: srcForDur ? String(srcForDur) : '',   // ★ 完整路径：外部素材夹也能定位
                name: srcLabel,
                decision: decision,            // mask = 用遮罩音轨 / source = 用原视频音轨
                out: j.outName,                // 这条决定作用于哪个成片
              }, extra || {}),
            }]));
          } catch (e) { /* 诊断失败绝不影响主流程 */ }
        };
        let maskHasAudio = false;
        if (!srcForDur) {
          // 预处理未产出（combinedMap 未命中）时不能静默降级，否则看起来像"遮罩没声音"
          logger.warn('   · 遮罩素材不可用 → 成片使用原视频音轨');
          diagAudio('source', { why: '遮罩源路径为空（预处理未产出）', mode: cfg.mode });
        } else {
          let pb = null;
          try { pb = await probeDetail(srcForDur); } catch (e) { pb = null; }
          maskHasAudio = !!(pb && pb.hasAudio);
          if (!maskHasAudio) {
            logger.info('   · 遮罩无音频 → 成片使用原视频音轨');
            diagAudio('source', {
              why: '无音频流',
              hasAudio: !!(pb && pb.hasAudio), probeOk: !!(pb && pb.probeOk),
              codecV: (pb && pb.vcodec) || '', codecA: (pb && pb.audioCodec) || '',
            });
          } else {
            let vol = NaN;
            let vdWhy = '';
            try {
              const vd = await runFfmpeg(
                ['-hide_banner', '-i', srcForDur, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
                { captureStdout: true }
              );
              const txt = String((vd && (vd.stderr || vd.stdout)) || '');
              const mM = txt.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
              if (mM) vol = parseFloat(mM[1]);
              else vdWhy = '输出中无 mean_volume' + ((vd && vd.code !== 0) ? `（ffmpeg 退出码 ${vd.code}）` : '');
            } catch (e) { vdWhy = String((e && e.message) || e); }
            // ★ 只有**确实测出**平均音量低于 -60dB（近乎静音）才降级为「无音频」；
            //   测不出来（命令失败 / 超时 / 输出格式变化）一律**维持「有音频」** ——
            //   把工具自身的失败算成素材没有声音，会静默丢掉遮罩音轨，用户完全无从察觉。
            //   （原实现 `if (!(vol > -60)) maskHasAudio = false;` 把 NaN 也判成无音频，
            //     与上方 catch 注释「探测失败则按有音频处理」自相矛盾。）
            if (isFinite(vol)) {
              if (!(vol > -60)) {
                maskHasAudio = false;
                logger.info('   · 遮罩音轨近乎静音 → 成片使用原视频音轨');
                diagAudio('source', { why: '音轨近乎静音', meanVolume: vol, hasAudio: true, codecA: (pb && pb.audioCodec) || '' });
              } else {
                logger.info('   · 遮罩音频可用 → 成片沿用遮罩音轨');
                diagAudio('mask', { meanVolume: vol, hasAudio: true, codecA: (pb && pb.audioCodec) || '' });
              }
            } else {
              logger.warn('   · 音量检测未取到数值 → 维持遮罩音轨');
              diagAudio('mask', { why: '音量检测未取到数值：' + vdWhy, hasAudio: true, codecA: (pb && pb.audioCodec) || '' });
            }
          }
        }
        ffArgs = ['-y', '-loglevel', 'error', '-stats', '-t', String(targetDur),
          '-i', j.vidPath, '-i', srcForDur,
          '-filter_complex', '[1:v]setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=0:0[outv]',
          // 音频来源：遮罩自带音轨时用遮罩音轨；遮罩没有音频流时回退原视频音轨，
          // ⚠ 否则成片会完全没有声音（固定取 1:a? 时，遮罩无声即输出无音轨）
          '-map', '[outv]', '-map', maskHasAudio ? '1:a?' : '0:a?',
          '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '25',
          '-c:a', 'aac', '-b:a', '192k',
          // 临时名无扩展名可推断容器 → 必须显式 -f mp4（与 batch/replica 同）
          '-f', 'mp4',
          tmpOut];
      }
      logger.clipDuration(targetDur);
      const { code, stderr: maskFfErr } = await makeFfArgs(ffArgs, logger);
      const maskFfTail = logger.ffmpegTail(maskFfErr);
      if (code === 0) {
        // 编码成功 → 原子改名到正式名（带重试，对齐 batch/replica：杀软/索引服务会瞬时占用刚写完的大文件）
        const rnErr = await renameWithRetry(tmpOut, j.outFile);
        if (rnErr) {
          // 保留临时产物：改名失败多为瞬时占用，删掉等于白编码一次；残留由续跑清理直接删除
          logger.error('遮罩-产物改名', `产物改名失败：${j.outName} · ${(rnErr && rnErr.message) || rnErr}`);
          logger.fail(j.outName, '产物改名失败');
          hasError = true;
          continue;
        }
      } else {
        // 编码失败：清掉半截临时产物（临时名与正式名无关，正式目录里不会出现半截成片）
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) {}
      }
      if (code === 0 && exists(j.outFile)) {
        logger.info(`   ✅ 成片完成：${j.outFile}`);
        if (cfg.logDir) {
          const cfgName = cfg.mode === 2 ? '水印叠加' : j.theme;
          const d = taskDate(cfg.submitTs);
          const timeTag = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}时${pad(d.getMinutes())}分`;
          const logFile = path.join(cfg.logDir, `${timeTag}-${cfgName}-遮罩日志.txt`);
          if (!themeLogs.has(logFile)) {
            try { fs.mkdirSync(cfg.logDir, { recursive: true }); } catch (e) {}
            fs.writeFileSync(logFile, '', 'utf8');
            themeLogs.set(logFile, true);
          }
          const lines = [j.outName, '使用片段列表：', j.vidPath];
          if (cfg.mode !== 2) lines.push(j.maskPath);
          lines.push('', `@out: ${j.outFile}`, '', '='.repeat(46));
          fs.appendFileSync(logFile, lines.join('\r\n') + '\r\n', 'utf8');
        }
      } else {
        // 合成失败：把 ffmpeg 的 stderr 尾部带出来（不能只留一句「退出码 N」）
        if (maskFfTail) logger.diag('ffmpeg.fail', { step: 'mask.synth', name: j.outName, code, tail: maskFfTail });
        logger.fail(j.outName, `编码失败（退出码 ${code}）`);
        hasError = true;
      }
    }
  } finally {
    if (cfg.mode === 1 && combineDir) {
      try { fs.rmSync(combineDir, { recursive: true, force: true }); } catch (e) {}
    }
    try { lock.release(); } catch (e) {}
    logger.lockReleased();
  }

  if (hasError) { logger.info(''); logger.info('任务完成（有错误）'); return 1; }
  logger.info(''); logger.info('任务完成');
  return 0;
}

module.exports = {
  id: 'mask',
  title: '遮罩叠加',
  envVars: ['MASK_*'],
  run,
  // 供测试复用
  _internals: { readEnv, buildJobs, filterOnlyNames, scanByExts, getMaskDirName },
};
