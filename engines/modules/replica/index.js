// engines/modules/replica/index.js —— 日志复刻（迁移自旧版脚本，行为等价优先）
// 模式1=原片复刻 / 模式2=去重复刻（尾部替换 + 渐进压时长）
// 硬约束：片段以「文件名」为身份（同名即同一片段，成片内不得重复）；缺失片段三路修复，
//         任一缺失且修复失败 → 该成片不生成；成片内重复最终校验；GPU 编码 h264_nvenc。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runFfmpeg } = require('../../base/ffmpeg');
const { probe } = require('../../base/probe');
const { acquireLock } = require('../../base/lock');
const { stripQuotes, getNumberSuffix, exists, renameWithRetry, tempNameFor } = require('../../base/paths');
const dedupe = require('../../base/dedupe');
// 「加速换档重试」策略（与批量拼接共用同一套，见 engines/base/ladder.js）
const ladder = require('../../base/ladder');

// 缓存作用域位掩码（与 engines/base/cache.js 的 SCOPES 同源）。
// 惰性取用：持久层不可用时不影响复刻执行，故不在模块顶层 require。
const SCOPES_FALLBACK = { batch: 1, replica: 2, mask: 4 };
function scopes() {
  try { return require('../../base/cache').SCOPES || SCOPES_FALLBACK; } catch (e) { return SCOPES_FALLBACK; }
}

const VIDEO_EXT_RE = /\.(mp4|mov|avi|mkv|m4v)$/i;
const PATH_LIKE_RE = /^[A-Za-z]:\\|^\\\\/;
const MAX_ATTEMPT = 45;          // 渐进压时长轮数上限（与 PS1 一致）
// 缓存写入时间用 .NET DateTime.Ticks（0001-01-01 基准），故偏移取 621355968000000000；
// 注意不要与 FILETIME（1601 基准）的 116444736000000000 混淆，否则缓存永不命中。
const DOTNET_TICKS_OFFSET = 621355968000000000;

// ────────────────────────────── env ──────────────────────────────
function readEnv(env = process.env) {
  const n = (k, d = '') => (env[k] == null ? d : String(env[k]));
  const num = (k, d) => { const v = parseFloat(n(k)); return Number.isNaN(v) ? d : v; };
  return {
    txt: n('REPLICA_TXT'),
    mode: n('REPLICA_MODE'),                       // '1' | '2'（由应用注入）
    // 成片时长上限 / 加速阈值 / 每档轮数：与批量拼接**共用同一套**（这些参数与去重无关，属副本通用属性）。
    // 复刻不单独设置：直接读全局的 BATCH_*（副本遵循批量设置；界面上改的是批量那套参数）。
    maxDuration: num('BATCH_MAX_DURATION', 179),
    speedLimit: num('BATCH_SPEED_LIMIT', 1.2),
    maxRetry: num('BATCH_MAX_RETRY', 45),
    dedupRatio: num('REPLICA_DEDUP_RATIO', 0.4),
    // 重复度区间（平台规则：占比过低判重复不过审、过高判全新视频继承不到流量）
    dedupMin: num('REPLICA_DEDUP_MIN', num('REPLICA_DEDUP_RATIO', 0.4)),
    dedupMax: num('REPLICA_DEDUP_MAX', 0),
    dedupMinOn: n('REPLICA_DEDUP_MIN_ON', '1') !== '0',
    dedupMaxOn: n('REPLICA_DEDUP_MAX_ON', '1') !== '0',
    outputDir: n('REPLICA_OUTPUT_DIR'),
    fallbackDir: n('REPLICA_FALLBACK_DIR'),
    onlyNames: n('REPLICA_ONLY_NAMES'),
    onlyName: n('REPLICA_ONLY_NAME'),
    submitTs: parseInt(n('REPLICA_SUBMIT_TS', '0'), 10) || 0,
  };
}

/** 任务日期：提交时刻优先（跨天不回退实际运行日期） */
function taskDate(submitTs) { return submitTs > 0 ? new Date(submitTs) : new Date(); }
function pad(n) { return String(n).padStart(2, '0'); }
/** PS 的 [math]::Round(v, 2) 且去尾随零（164.8 而非 164.80） */
function round2(v) { return Math.round(Number(v) * 100) / 100; }
function round1(v) { return Math.round(Number(v) * 10) / 10; }

// ──────────────────── video_cache（只读；复刻只消费不写回） ────────────────────
/** JS 文件时间 → .NET DateTime.Ticks（与 PS 的 $fileInfo.LastWriteTimeUtc.Ticks 同语义）
 *  用 statSync 的 bigint mtimeNs（100ns 精度，与 Ticks 同单位）换算，避免 mtimeMs 的毫秒精度损失。
 *  返回值经 Number() 转换会引入约 ±128 ticks 误差，故比较处使用 TICKS_TOLERANCE 容差。 */
function mtimeToTicks(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    return Number(st.mtimeNs / 100n) + DOTNET_TICKS_OFFSET;
  } catch (e) {
    try { return Math.floor(fs.statSync(p).mtimeMs * 10000) + DOTNET_TICKS_OFFSET; } catch (e2) { return 0; }
  }
}
/** 缓存时间戳比较容差（1ms = 10000 ticks）：吸收 JSON double 精度（±128）与文件系统精度差异 */
const TICKS_TOLERANCE = 10000;

function loadVideoCache() {
  // 持久层只有数据库一种形态：VL_CACHE_DB 指向 cache.db，由主进程注入（backend 的 _spawnEngine）。
  // 未注入或库不存在时返回空表，复刻退化为逐文件 ffprobe（不影响正确性，只是慢）。
  const dbPath = String(process.env.VL_CACHE_DB || '').trim();
  if (!dbPath) return {};
  try {
    if (!fs.existsSync(dbPath)) return {};
    const CacheStore = require('../../base/cache');
    const store = new CacheStore(dbPath, { root: '' });
    store.open({ readOnly: true }); // 只读用途：不建表、不写 meta（replica 仅消费缓存）
    // 显式声明读取范围（批量 + 复刻）：不显式放宽时看不到遮罩素材条目 ——
    // 复刻修复依赖「同名即同一片段」，混入其它模式的素材会把修复指向错误的文件
    const map = store.loadVideoMap({ scopesMask: scopes().batch | scopes().replica });
    store.close();
    return map || {};
  } catch (e) { return {}; }
}

/** Get-CachedVideoInfo（防御版）：命中缓存用缓存，否则 ffprobe */
function makeVideoInfo(cache) {
  const mem = new Map();
  return async function videoInfo(p) {
    if (!p) return { valid: false, duration: 0, width: 0, height: 0, lastWriteTicks: 0 };
    if (mem.has(p)) return mem.get(p);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (!st) {
      const r = { valid: false, duration: 0, width: 0, height: 0, lastWriteTicks: 0 };
      mem.set(p, r);
      return r;
    }
    const ticks = mtimeToTicks(p);
    const cached = cache[p];
    if (cached && Math.abs(Number(cached.LastWriteTime) - ticks) <= TICKS_TOLERANCE) {
      const r = { valid: !!cached.Valid, duration: cached.Duration || 0, width: cached.Width || 0, height: cached.Height || 0, lastWriteTicks: ticks };
      mem.set(p, r);
      return r;
    }
    const info = await probe(p);
    const r = { valid: !!info.valid, duration: info.duration || 0, width: info.width || 0, height: info.height || 0, lastWriteTicks: ticks };
    mem.set(p, r);
    return r;
  };
}

// ───────────────────────── 日志解析（ConvertTo-ReplicaJobs） ─────────────────────────
function parseJobs(allLines) {
  const jobs = [];
  let current = null;
  for (let i = 0; i < allLines.length; i++) {
    const line = String(allLines[i] == null ? '' : allLines[i]).trim();
    if (/使用片段列表：/.test(line)) {
      if (current) jobs.push(current);
      const nameLine = i > 0 ? String(allLines[i - 1] == null ? '' : allLines[i - 1]).trim() : '';
      let name = nameLine;
      const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
      if (m) name = m[1].trim().replace(/^=+|=+$/g, '').trim();
      if (PATH_LIKE_RE.test(name)) name = path.basename(name);
      current = { name, videos: [], watermark: '', missingReplacedIndices: [], missingEquivalentIndices: [] };
      continue;
    }
    if (current) {
      const p = stripQuotes(line);
      if (PATH_LIKE_RE.test(p)) {
        if (/\.png$/i.test(p)) current.watermark = p;
        else if (VIDEO_EXT_RE.test(p)) current.videos.push(p);
      }
    }
  }
  if (current) jobs.push(current);
  return jobs;
}

// ───────────────────────── 候选与替换（Select-ReplacementVideo） ─────────────────────────
/**
 * 配置排除项（`-` 前缀）命中判定 —— 与批量引擎同语义：路径（小写）含任一排除词即拒用。
 * ⚠ 这是**全流程硬约束**，不只是"配置素材池"自己的过滤：用户把素材刻意挪走或删除，
 *   往往正是靠配置里的排除项表达"这个不要用"；替换候选若不看排除项，就会把这些素材
 *   又换回来（甚至是正被排除的那一个），等于把排除白做。
 */
function deniedByConfig(p, deny) {
  if (!deny || !deny.length) return false;
  const s = String(p || '').toLowerCase();
  for (const d of deny) { if (d && s.includes(d)) return true; }
  return false;
}

/** 归一化排除项：trim + 小写 + 去空（大小写不敏感，对齐批量引擎） */
function normDeny(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x == null ? '' : x).trim().toLowerCase())
    .filter(Boolean);
}

function sameDirCandidates(videoPath) {
  // 候选目录：优先原目录；**原目录不存在时退回上一级** ——
  // 素材常被「改名 + 上移」（如 260723-示例A-xxx 整理成 260924-示例B-xxx 后直接放在父目录下），
  // 若仍只在原目录内枚举，候选恒为空 → 缺失修复与去重替换会整体失效（任务直接失败）。
  // 退回父目录后，同后缀匹配仍可能命中；命中不了也还有"其它候选"可换，至少不连累整个任务。
  let dir = path.dirname(videoPath);
  const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
  if (!isDir(dir)) {
    const up = path.dirname(dir);
    if (up && up !== dir && isDir(up)) dir = up;
    else return [];
  }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    if (!VIDEO_EXT_RE.test(ent.name)) continue;
    if (full === videoPath) continue;
    if (/\\旧水印\\/i.test(full) || /旧水印/.test(ent.name)) continue;
    out.push(full);
  }
  return out;
}

/** 不轮询子目录（配置行以 `=` 开头）：只取该目录下的直接子文件 */
function directVideos(dir) {
  let ok = false; try { ok = fs.statSync(dir).isDirectory(); } catch (e) { ok = false; }
  if (!ok) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!VIDEO_EXT_RE.test(ent.name)) continue;
    if (/旧水印/.test(ent.name)) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

/**
 * 读取「原配置」的素材池 —— 复刻的替换候选应当来自**配置里声明的素材目录**，
 * 而不是"缺失片段所在的那一层子目录"。理由：只换同目录编号 ≈ 换汤不换药，
 * 「换了不如用原配置重跑一遍批量」；只有从配置素材池里挑新片段才是真正的换新内容。
 * 配置正本位于拼接日志同目录（引擎会把配置移入成片文件夹作为正本）。
 * 语法与批量引擎完全一致：普通行 = 素材目录（递归）、`=` 前缀 = 不轮询子目录、`-` 前缀 = 排除、
 * 末行为水印（此处忽略）。
 */
function loadConfigPool(logTxtPath, logger, opts) {
  // skipScan：只要排除项时跳过素材目录扫描 —— 递归扫描几十个大目录很重，
  // 而排除项是**全流程硬约束**（原片复刻模式也要用），必须能在建池之前单独廉价拿到。
  const skipScan = !!(opts && opts.skipScan);
  const empty = { pools: [], exclude: [], src: '' };
  const dir = path.dirname(logTxtPath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return empty; }
  const cands = names.filter((n) => /\.txt$/i.test(n) && !/拼接日志/.test(n));
  if (!cands.length) return empty;
  const base = path.basename(logTxtPath).replace(/-?拼接日志/, '').replace(/\.txt$/i, '');
  cands.sort((a, b) => (b.includes(base) ? 1 : 0) - (a.includes(base) ? 1 : 0));
  const src = path.join(dir, cands[0]);
  let lines = [];
  try {
    lines = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => /\S/.test(s));
  } catch (e) { return empty; }
  if (lines.length < 2) return empty;   // 至少 1 个素材行 + 1 个水印行

  const exclude = [];
  const pools = [];
  for (const raw of lines.slice(0, lines.length - 1)) {
    const line = raw.trim();
    if (line.includes('=')) {
      const d = stripQuotes(line.replace(/=/g, '').trim());
      if (d) pools.push({ dir: d, recursive: false });
    } else if (line.startsWith('-')) {
      const ex = stripQuotes(line.slice(1).trim());
      if (ex) exclude.push(ex);
    } else {
      const d = stripQuotes(line);
      if (d) pools.push({ dir: d, recursive: true });
    }
  }
  if (skipScan) return { pools: [], exclude, src };
  for (const p of pools) {
    let vids = p.recursive ? recursiveVideos(p.dir) : directVideos(p.dir);
    if (exclude.length) {
      const ex = exclude.map((x) => x.toLowerCase());
      vids = vids.filter((v) => !ex.some((e) => v.toLowerCase().includes(e)));
    }
    p.videos = vids;
  }
  const live = pools.filter((p) => p.videos.length);
  if (logger) logger.info(`📚 已加载原配置素材池：${path.basename(src)}（${live.length} 个可用目录）`);
  return { pools: live, exclude, src };
}

/**
 * 兜底池：日志中出现的「片段所属文件夹」—— 这些目录必然来自原配置（成片由批量拼接按配置产出），
 * 因此当配置正本缺失、或配置与日志明显对不上时，可以拿它们作为候选来源。
 * 注意：只影响"候选从哪里选"，**片段的拼接顺序恒定不变**（替换一律原位进行）。
 */
function poolsFromJobs(jobs) {
  const dirMap = new Map();
  for (const job of jobs || []) {
    for (const v of (job.origVideos || job.videos || [])) {
      if (!v) continue;
      const d = path.dirname(v);
      if (!d) continue;
      const k = d.toLowerCase();
      if (!dirMap.has(k)) dirMap.set(k, d);
    }
  }
  const pools = [];
  for (const d of dirMap.values()) {
    const vids = recursiveVideos(d);
    if (vids.length) pools.push({ dir: d, recursive: true, videos: vids });
  }
  return pools;
}

/**
 * 构建最终候选池：以配置正本为主，补充「日志里出现但配置未覆盖」的目录。
 * 这样即使配置缺失/与日志对不上，替换依然有来自原配置的候选可用。
 */
function buildReplicaPools({ txtPath, jobs, logger }) {
  const cfgp = loadConfigPool(txtPath, logger);
  const logPools = poolsFromJobs(jobs);
  const seen = new Set(cfgp.pools.map((p) => String(p.dir).toLowerCase()));
  const denyList = normDeny(cfgp.exclude);
  // 日志补充池（配置未声明的目录）同样要过排除项：它们来自"原成片用过的片段所在目录"，
  // 其中可能就含已被排除的素材 —— 不能因为"日志里出现过"就放行。
  const extra = logPools
    .filter((p) => !seen.has(String(p.dir).toLowerCase()))
    .map((p) => ({ dir: p.dir, recursive: p.recursive, videos: (p.videos || []).filter((v) => !deniedByConfig(v, denyList)) }))
    .filter((p) => p.videos.length);
  const pools = cfgp.pools.concat(extra);
  if (logger) {
    if (!cfgp.pools.length && extra.length) {
      logger.warn(`未读到可用的原配置素材池 → 改用日志中 ${extra.length} 个片段目录作为候选来源`);
    } else if (extra.length) {
      logger.info(`📚 候选池：配置 ${cfgp.pools.length} 个目录 + 日志补充 ${extra.length} 个目录`);
    }
  }
  // exclude 一并返回：调用方（缺失修复 / 主动替换）要把它传给各个候选来源做统一过滤
  return { pools, src: cfgp.src, exclude: cfgp.exclude, fromConfig: cfgp.pools.length, fromLog: extra.length };
}

/** 某个片段属于哪个配置素材目录（最长前缀匹配）→ 返回该目录的候选列表 */
function poolForPath(pools, videoPath) {
  if (!Array.isArray(pools) || !pools.length) return null;
  const p = String(videoPath).toLowerCase().replace(/\//g, '\\');
  let best = null;
  for (const pool of pools) {
    const d = String(pool.dir).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
    if (p === d || p.startsWith(d + '\\')) {
      if (!best || pool.dir.length > best.dir.length) best = pool;
    }
  }
  return best ? best.videos : null;
}

function recursiveVideos(dir) {
  let ok = false; try { ok = fs.statSync(dir).isDirectory(); } catch (e) { ok = false; }
  if (!ok) return [];
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!VIDEO_EXT_RE.test(ent.name)) continue;
      if (/旧水印/.test(ent.name)) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 排序键：invalid 排后，其次时长升序（对齐 PS 的 Sort-Object {Valid -eq $false}, {Duration}） */
async function sortByValidThenDuration(list, info) {
  const decorated = [];
  for (const p of list) {
    const i = await info(p);
    decorated.push({ p, invalid: i.valid ? 0 : 1, dur: i.duration || 0 });
  }
  decorated.sort((a, b) => (a.invalid - b.invalid) || (a.dur - b.dur));
  return decorated.map((d) => d.p);
}

/**
 * 选替换候选：返回 { path, equivalent } 或 { path: null }
 * - exclude     完整路径排除（triedSubs / 成片内其它位置）
 * - excludeNames 文件名排除（同名即同一片段，成片内不得重复）
 * - deny        配置排除项（`-` 前缀，小写）；命中即拒用，**对所有候选来源都生效**
 * - shorterThan >0 时只接受严格更短的候选（无更短 → 返回空，由调用方标记该段耗尽）
 */
async function selectReplacementVideo({ originalPath, exclude = [], preferShort = false, shorterThan = 0, excludeNames = [], info, targetDurMax = 0, pool = null, noSameSuffix = false, stillNeed = false, deny = [] }) {
  const excludeSet = new Set(exclude);
  const nameSet = new Set(excludeNames);
  const denyList = normDeny(deny);
  // 候选来源：优先「原配置素材池」（配置声明的目录，递归），池不可用时退回同目录 + 父目录兜底
  // 候选必须排除「原片段自身」：配置池（递归）可能只包含它自己，若选中自己就是"表面替换成功"
  //（生成时计入占比 → 占比虚高 → 提前停止替换），而最终校验发现片段没变 → 不达标不出片。
  // 配置排除项在**这里**统一兜一道：池本身已过滤，但同目录兜底路径（sameDirCandidates）没有。
  let cands = (Array.isArray(pool) && pool.length ? pool.slice() : sameDirCandidates(originalPath))
    .filter((p) => !excludeSet.has(p) && !nameSet.has(path.basename(p)) && p !== originalPath
      && !deniedByConfig(p, denyList));
  if (shorterThan > 0) {
    const keep = [];
    for (const c of cands) { const i = await info(c); if ((i.duration || 0) < shorterThan) keep.push(c); }
    cands = keep;
  }
  if (targetDurMax > 0) {
    const keep = [];
    for (const c of cands) { const i = await info(c); if ((i.duration || 0) <= targetDurMax) keep.push(c); }
    // 预算装不下任何候选时**不放弃替换**：仍保留候选池（后续会选最短的那个），最终由「成片加速」把
    // 总时长压回设定值 —— 加速的定位是拼接完成后的兜底，不是用来放宽这里的替换预算。
    if (keep.length) cands = keep;
  }
  if (!cands.length) return { path: null, equivalent: false };

  const origSuffix = getNumberSuffix(originalPath);
  //  而"同后缀 = 内容等效"对去重没有意义（换了等于没换，占比仍为 0）。
  //  同后缀优先只用于**缺失修复**（找回与原片段等效的版本）。
  // noSameSuffix（主动替换/去重）：不走"同后缀优先" —— 配置素材池（递归）里几乎总能找到同编号片段，
  // 而"同后缀 = 内容等效"对去重没有意义（换了等于没换，最终占比仍为 0）。
  // 同后缀优先只保留给**缺失修复**（找回与原片段等效的版本）。
  const sameSuffix = (origSuffix && !noSameSuffix) ? cands.filter((c) => getNumberSuffix(c) === origSuffix) : [];
  const others = cands.filter((c) => !sameSuffix.includes(c));

  // 时长预算模式（targetDurMax>0）：在上限内选「最长」候选（并列随机）——
  // 去重复刻目标是换入尽量多的新内容，预算充裕时换更长的片段更容易达到不一致占比
  if (targetDurMax > 0) {
    const pickLongestTie = async (list) => {
      const s = await sortByValidThenDuration(list, info);
      if (!s.length) return null;
      const last = s[s.length - 1];
      const iL = await info(last);
      const tie = [last];
      for (let k = s.length - 2; k >= 0; k--) {
        const ik = await info(s[k]);
        if (ik.valid !== iL.valid || Math.abs((ik.duration || 0) - (iL.duration || 0)) > 0.05) break;
        tie.push(s[k]);
      }
      return tie[Math.floor(Math.random() * tie.length)];
    };
    // 尚未达到占比下限时，改选「预算内最短」的候选：占比是按**被替换原段的时长**计的，换更短的新片段
    // 并不会拉低占比，却能把 179s 时长预算省下来，让后面更多段也换得动（用户策略：不达标就依次往前再释放一段）。
    // 达标后再回到「预算内选最长」，最大化新内容量。
    const pickShortest = async (list) => {
      const s = await sortByValidThenDuration(list, info);
      if (!s.length) return null;
      const i0 = await info(s[0]);
      const tie = [s[0]];
      for (let k = 1; k < s.length; k++) {
        const ik = await info(s[k]);
        if (ik.valid !== i0.valid || Math.abs((ik.duration || 0) - (i0.duration || 0)) > 0.05) break;
        tie.push(s[k]);
      }
      return tie[Math.floor(Math.random() * tie.length)];
    };
    const pick = stillNeed ? pickShortest : pickLongestTie;
    if (sameSuffix.length) { const p = await pick(sameSuffix); if (p) return { path: p, equivalent: true }; }
    if (others.length) { const p = await pick(others); if (p) return { path: p, equivalent: false }; }
    return { path: null, equivalent: false };
  }

  if (preferShort) {
    // 排序后从「与首位并列」的候选组（valid/时长相同）里随机取一个：
    // 否则同一成片连续多次去重会每次选中同一片段，产出字节级相同的成片
    const pickTie = async (list) => {
      const s = await sortByValidThenDuration(list, info);
      if (!s.length) return null;
      const i0 = await info(s[0]);
      const best = [s[0]];
      for (let k = 1; k < s.length; k++) {
        const ik = await info(s[k]);
        if (ik.valid !== i0.valid || Math.abs((ik.duration || 0) - (i0.duration || 0)) > 0.05) break;
        best.push(s[k]);
      }
      return best[Math.floor(Math.random() * best.length)];
    };
    if (sameSuffix.length) return { path: await pickTie(sameSuffix), equivalent: true };
    if (others.length) return { path: await pickTie(others), equivalent: false };
    return { path: null, equivalent: false };
  }
  if (sameSuffix.length) return { path: sameSuffix[Math.floor(Math.random() * sameSuffix.length)], equivalent: true };
  if (others.length) return { path: others[Math.floor(Math.random() * others.length)], equivalent: false };
  return { path: null, equivalent: false };
}

/** 备用目录候选（Get-VideoFromDirectory：递归、同后缀优先） */
async function videoFromDirectory({ directory, originalPath = '', exclude = [], excludeNames = [], deny = [] }) {
  let ok = false; try { ok = fs.statSync(directory).isDirectory(); } catch (e) { ok = false; }
  if (!ok) return { path: null, equivalent: false };
  const excludeSet = new Set(exclude);
  const nameSet = new Set(excludeNames);
  const denyList = normDeny(deny);
  const vids = recursiveVideos(directory)
    .filter((p) => !excludeSet.has(p) && !nameSet.has(path.basename(p)) && !deniedByConfig(p, denyList));
  if (!vids.length) return { path: null, equivalent: false };
  const origSuffix = originalPath ? getNumberSuffix(originalPath) : '';
  const sameSuffix = origSuffix ? vids.filter((v) => getNumberSuffix(v) === origSuffix) : [];
  const others = vids.filter((v) => !sameSuffix.includes(v));
  if (sameSuffix.length) return { path: sameSuffix[Math.floor(Math.random() * sameSuffix.length)], equivalent: true };
  if (others.length) return { path: others[Math.floor(Math.random() * others.length)], equivalent: false };
  return { path: null, equivalent: false };
}

// ─────────────────── 缺失修复（Resolve-FromVideoCache：缓存按文件名反查） ───────────────────
function buildCacheByNameIndex(cache) {
  const idx = new Map();
  for (const p of Object.keys(cache || {})) {
    if (!p) continue;
    const fn = path.basename(p);
    if (!fn) continue;
    const key = fn.toLowerCase();
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(p);
  }
  return idx;
}

/**
 * 三路修复的第一路（PS 的首选）：缓存按文件名反查。
 * - exclude      完整路径排除（成片内其它位置）
 * - excludeNames 文件名排除：同名副本即同一片段，成片内已用则本位置不可再用
 */
function resolveFromVideoCache(oldPath, { exclude = [], excludeNames = [], index, deny = [] }) {
  let p = stripQuotes(oldPath).replace(/\\\\/g, '\\');
  if (!p) return null;
  const leaf = path.basename(p);
  const fnKey = leaf.toLowerCase();
  const origDir = path.dirname(p);
  const nameSet = new Set(excludeNames);
  if (nameSet.has(leaf)) return null;
  const excludeSet = new Set(exclude);
  const denyList = normDeny(deny);
  const list = index.get(fnKey) || [];
  let cands = Array.from(new Set(list))
    .filter((c) => exists(c) && !excludeSet.has(c) && !deniedByConfig(c, denyList));
  if (cands.length) {
    const sameDir = cands.filter((c) => path.dirname(c).toLowerCase() === origDir.toLowerCase());
    return sameDir.length ? sameDir[0] : cands[0];
  }
  // 无同名：同目录下相同数字后缀（原索引补位逻辑）
  const suffix = getNumberSuffix(p);
  let dirOk = false; try { dirOk = fs.statSync(origDir).isDirectory(); } catch (e) { dirOk = false; }
  if (suffix && dirOk) {
    let entries = [];
    try { entries = fs.readdirSync(origDir, { withFileTypes: true }); } catch (e) { entries = []; }
    const sameSeq = entries
      .filter((e) => e.isFile() && VIDEO_EXT_RE.test(e.name))
      .map((e) => path.join(origDir, e.name))
      .filter((f) => f.toLowerCase() !== p.toLowerCase() && !excludeSet.has(f) && getNumberSuffix(f) === suffix)
      .sort((a, b) => a.localeCompare(b));
    if (sameSeq.length) return sameSeq[0];
  }
  return null;
}

// ─────────────────── 模式2：尾部替换（Select-VariancePaths） ───────────────────
/**
 * 不一致时长占比 —— **唯一真相**，选位预估与最终校验共用本函数。
 * 分母 = 修复+替换后**实际播放列表**的时长和（观众看到的成片）；
 * 分子 = 「与原版不同且非等效修复」位的实际播放时长。
 * ⚠ 不得改回「对 origVideos 逐位 probe」的旧口径：原文件可能已不存在（info 返回 duration=0），
 *   缺失位时长会从分母蒸发（实测：190.83s → 101.53s），造成「选位账 37.2% / 校验账 33.2%」
 *   两套账打架、「下限设得高能过、设得低反而失败」的悖论。
 */
async function calcDedupRatio(videos, origVideos, equivalentIndices, info) {
  const eqSet = new Set(equivalentIndices || []);
  let num = 0, den = 0;
  for (let i = 0; i < videos.length; i++) {
    const d = (await info(videos[i])).duration || 0;
    den += d;
    const orig = origVideos ? origVideos[i] : videos[i];
    if (videos[i] !== orig && !eqSet.has(i)) num += d;
  }
  return den > 0 ? num / den : 0;
}

async function selectVariancePaths({
  originalPaths, alreadyChangedIndices = [], alreadyEquivalentIndices = [],
  triedSubs = new Map(), preferShort = false, dedupRatio, info, logger, durationCap = 0,
  dedupMax = 0, dedupMaxOn = false, pools = null, deny = [],
}) {
  const origDurations = [];
  let totalOrig = 0;
  for (const p of originalPaths) { const i = await info(p); origDurations.push(i.duration || 0); totalOrig += i.duration || 0; }
  if (totalOrig <= 0 || originalPaths.length === 0) return { paths: originalPaths.slice(), triedSubs };

  const changedSet = new Set(alreadyChangedIndices);
  const equivalentSet = new Set(alreadyEquivalentIndices);
  let alreadyChangedDur = 0;
  for (const idx of alreadyChangedIndices) if (idx >= 0 && idx < origDurations.length) alreadyChangedDur += origDurations[idx];
  if (alreadyChangedDur / totalOrig >= dedupRatio) {
    logger.info(`🔀 模式2：缺失替换片段已占 ${round1(alreadyChangedDur / totalOrig * 100)}%，无需再替换尾部`);
    return { paths: originalPaths.slice(), triedSubs };
  }

  const newPaths = originalPaths.slice();
  let trulyChangedDur = alreadyChangedDur;
  let actuallyReplaced = 0;
  let equivalentReplaced = 0;
  const replaceDetails = [];
  const equivalentDetails = [];
  const skippedOverCap = [];   // 会把占比推过上限而暂缓替换的位置（保下限时回补）
  // 策略：① 第一段永不主动替换（批量拼接重试的硬规则）② 越靠后越优先替换
  //   ③ 上限优先于顺序：靠后位置会超上限就跳过、继续往前找能在上限内完成的位置
  //   ④ 下限优先于上限：往前找遍仍不达标时回补，允许略微超上限（宁多不少）

  for (let i = originalPaths.length - 1; i >= 1; i--) {   // i>=1：第 0 段永不主动替换
    if (trulyChangedDur / totalOrig >= dedupRatio) break;
    if (changedSet.has(i) || equivalentSet.has(i)) continue;
    // 上限软约束：替换该位置会把占比推过上限 → 先跳过，继续往前试（靠前位置通常更短）
    if (dedupMaxOn && dedupMax > 0
      && (trulyChangedDur + (origDurations[i] || 0)) / totalOrig > dedupMax) {
      skippedOverCap.push(i);
      continue;
    }
    const poolHere = pools ? poolForPath(pools, originalPaths[i]) : null;
    if (logger && poolHere) logger.info(`     第 ${i + 1} 段候选池命中 ${poolHere.length} 个（${path.basename(originalPaths[i])}）`);
    const origKey = String(originalPaths[i]);
    const excludeSubs = [];
    for (const k of triedSubs.keys()) if (k.startsWith(origKey + '|')) excludeSubs.push(k.slice(origKey.length + 1));
    // 成片内不得出现相同片段：按文件名 + 完整路径双重排除该成片其它位置
    const usedNames = [];
    for (let k = 0; k < newPaths.length; k++) if (k !== i && newPaths[k]) usedNames.push(path.basename(newPaths[k]));
    const excludeAll = excludeSubs.concat(newPaths.filter((p) => p && p !== originalPaths[i]));

    // 时长预算：其余位置（已替换用新时长）之后本位置还可容纳的最大片段时长，
    // 用于「预算内选最长」；预算无余量则不传，维持原 preferShort 压时长语义
    let budget = 0;
    if (durationCap > 0) {
      let othersNewDur = 0;
      for (let k = 0; k < newPaths.length; k++) if (k !== i && newPaths[k]) { const ik = await info(newPaths[k]); othersNewDur += (ik.duration || 0); }
      budget = Math.max(0, durationCap - othersNewDur);
    }
    const sel = await selectReplacementVideo({
      originalPath: originalPaths[i], exclude: excludeAll, excludeNames: usedNames, preferShort, info,
      targetDurMax: budget > 0 ? budget : 0,
      pool: pools ? poolForPath(pools, originalPaths[i]) : null,
      noSameSuffix: true,   // 主动替换：换新内容，不走"同后缀等效"
      deny,
    });
    if (!sel.path) continue;
    newPaths[i] = sel.path;
    if (sel.equivalent) {
      equivalentReplaced++;
      equivalentDetails.push(`    第 ${i + 1} 段: ${path.basename(originalPaths[i])} -> ${path.basename(sel.path)}（等效，不进入30%）`);
    } else {
      actuallyReplaced++;
      changedSet.add(i);
      // 分子记「该位实际播放时长」（换上的新片段），与 calcDedupRatio 的最终校验口径一致
      trulyChangedDur += (await info(sel.path)).duration || 0;
      replaceDetails.push(`    第 ${i + 1} 段: ${path.basename(originalPaths[i])} -> ${path.basename(sel.path)}`);
    }
  }

  // 保下限优先：为守上限跳过的位置，若导致没达到下限则回补直到达标（允许略微超上限）
  let overCap = false;
  if (dedupMaxOn && dedupMax > 0 && trulyChangedDur / totalOrig < dedupRatio && skippedOverCap.length) {
    for (const i of skippedOverCap) {
      if (i <= 0) continue;   // 第一段硬约束
      if (trulyChangedDur / totalOrig >= dedupRatio) break;
      const origKey2 = String(originalPaths[i]);
      const excludeSubs2 = [];
      for (const k of triedSubs.keys()) if (k.startsWith(origKey2 + '|')) excludeSubs2.push(k.slice(origKey2.length + 1));
      const usedNames2 = [];
      for (let k = 0; k < newPaths.length; k++) if (k !== i && newPaths[k]) usedNames2.push(path.basename(newPaths[k]));
      const excludeAll2 = excludeSubs2.concat(newPaths.filter((pp) => pp && pp !== originalPaths[i]));
      const sel2 = await selectReplacementVideo({
        originalPath: originalPaths[i], exclude: excludeAll2, excludeNames: usedNames2, preferShort, info,
        pool: pools ? poolForPath(pools, originalPaths[i]) : null,
        noSameSuffix: true,
        deny,
      });
      if (!sel2.path) continue;
      newPaths[i] = sel2.path;
      if (sel2.equivalent) { equivalentReplaced++; }
      else {
        actuallyReplaced++;
        changedSet.add(i);
        trulyChangedDur += (await info(sel2.path)).duration || 0;
        overCap = true;
        replaceDetails.push(`    第 ${i + 1} 段: ${path.basename(originalPaths[i])} -> ${path.basename(sel2.path)}（为守住下限补足）`);
      }
    }
  }
  if (overCap) logger.warn(`模式2：为守住下限，替换后不一致占比略超上限（${round1(trulyChangedDur / totalOrig * 100)}% > ${round1(dedupMax * 100)}%）`);

  if (actuallyReplaced === 0 && equivalentReplaced === 0 && alreadyChangedDur / totalOrig < dedupRatio) {
    logger.warn('模式2：没有可替换的尾部片段，本次仅保留已随机替换的片段');
    return { paths: newPaths, triedSubs };
  }
  logger.info(`🔀 模式2：尾部新增替换 ${actuallyReplaced} 段（等效替换 ${equivalentReplaced} 段；合计不一致时长占比 ${round1(trulyChangedDur / totalOrig * 100)}%）`);
  for (const d of equivalentDetails) logger.info(d);
  for (const d of replaceDetails) logger.info(d);
  return { paths: newPaths, triedSubs };
}

// ────────────────────────────── 主流程 ──────────────────────────────
async function run(ctx, env = process.env) {
  const { logger } = ctx;
  const cfg = readEnv(env);
  const fail = (msg, step) => { logger.diag('fail', { step: String(step || ''), msg: String(msg || '').slice(0, 300) }); logger.error(step, msg); return 1; };

  // ── 输入 TXT ──
  // ⚠ 失败文案面向**普通用户**：只讲「怎么了 + 怎么办」，禁止出现「环境变量 / 脚本 / 手动输入」等
  //   技术措辞（用户不会用命令行，写出来只会让人以为是自己操作错了）。
  if (!cfg.txt) return fail('未选择复刻日志：请在主窗口选择日志 TXT 后重新开始制作', '日志TXT输入');
  let txtPath = stripQuotes(cfg.txt);
  if (!exists(txtPath)) return fail(`复刻日志不可用：${txtPath}（可能已被移动、重命名或删除，请在主窗口重新选择日志后开始制作）`, '日志TXT输入');
  logger.info(`✅ 复刻日志：${path.basename(txtPath)}`);

  // ── 输出根目录：REPLICA_OUTPUT_DIR 优先，否则由 TXT 路径推导 ──
  const txtDir = path.dirname(txtPath);
  const parts = txtDir.split('\\');
  let dateDirIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d+月$/.test(parts[i]) || /^\d{4}$/.test(parts[i])) { dateDirIndex = i; break; }
  }
  let baseDir;
  if (dateDirIndex > 0) baseDir = parts.slice(0, dateDirIndex).join('\\');
  else if (dateDirIndex === 0) baseDir = parts[0];
  else baseDir = txtDir;

  const d0 = taskDate(cfg.submitTs);
  // 打印的是「由 TXT 路径推导」的输出目录（与 PS1 主入口一致）；
  // REPLICA_OUTPUT_DIR 的覆盖只作用于实际写入，见下方 outRootBase（PS1 在 Invoke-ReplicaFromLog 内覆盖）
  const derivedRoot = path.join(baseDir, `${d0.getMonth() + 1}月`, `${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`);
  logger.info('');
  logger.info(`✅ 输出目录：${derivedRoot}`);

  // ── 读日志并解析 ──
  let allLines = [];
  try {
    allLines = fs.readFileSync(txtPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /\S/.test(s));
  } catch (e) {
    // 原始系统错误（如 ENOENT/权限）只进日志供排查，用户可见文案不暴露英文技术细节
    logger.error('日志TXT输入', '读取复刻日志失败（底层错误）：' + e.message);
    return fail('读取复刻日志失败：文件可能已损坏或无法访问，请重新选择日志后开始制作', '日志TXT输入');
  }
  if (!/使用片段列表：/.test(allLines.join('\n'))) return fail('不是有效的复刻日志：请选择本软件复刻任务生成的日志文件', '日志TXT输入');

  let jobs = parseJobs(allLines);
  if (jobs.length === 0) return fail('未从日志中解析出任何成片', '日志复刻-解析');

  // ── 仅复刻指定成片 ──
  const onlyRaw = cfg.onlyNames || cfg.onlyName || '';
  if (onlyRaw.trim()) {
    const onlyNames = onlyRaw.split(';').map((s) => s.trim()).filter(Boolean);
    jobs = jobs.filter((j) => onlyNames.some((o) => j.name === o || j.name === o + '.mp4' || path.basename(j.name, path.extname(j.name)) === path.basename(o, path.extname(o))));
    if (jobs.length === 0) return fail(`未找到指定成片：${onlyNames.join('、')}`, '日志复刻-单成片');
  }

  // ── 重复成片名检测 ──
  const nameCount = new Map();
  for (const j of jobs) nameCount.set(j.name, (nameCount.get(j.name) || 0) + 1);
  const dupJobNames = [...nameCount.entries()].filter(([, c]) => c > 1);
  if (dupJobNames.length) {
    logger.info('❌ 检测到重复成片名：');
    for (const [n, c] of dupJobNames) logger.info(`   ${n} 出现 ${c} 次`);
    return fail('存在重复成片名，已停止', '日志复刻-重复检测');
  }

  // ── 视频信息缓存（只读缓存库） ──
  const cache = loadVideoCache();
  const cacheByName = buildCacheByNameIndex(cache);
  const info = makeVideoInfo(cache);

  // ── 模式与候选池 ──
  // ⚠ 必须在「缺失片段修复」之前构建：缺失片段同样应当从**原配置声明的素材目录**里换新片段。
  //   曾经的写法把这段放在缺失修复之后，导致缺失修复只能退回"缺失片段的同目录"—— 而素材被
  //   整理（文件移入子目录/改名）后那一层往往是空的，于是明明配置里的素材目录还有大量可用片段，
  //   却直接判定"无法自动修复"把整条成片跳过（实测：16 个成片因 1 个片段被判死）。
  let mode = 0;
  if (cfg.mode === '1') mode = 1;
  else if (cfg.mode === '2') mode = 2;
  else return fail('未选择复刻模式：请在主窗口选择原片复刻或去重复刻后重新开始制作', '复刻模式');
  const modeName = mode === 1 ? '原片复刻' : '去重复刻';
  // 去重复刻：候选池 = 原配置素材池（+ 日志中片段目录补充）。第 1 段恒定不动，其余段**原位**
  // 换新片段（顺序不变），候选优先来自配置声明的素材目录。
  const configPool = (mode === 2)
    ? buildReplicaPools({ txtPath, jobs, logger })
    : { pools: [], exclude: [], src: '', fromConfig: 0, fromLog: 0 };
  // 配置排除项（`-` 前缀）是**与模式无关的硬约束**：原片复刻模式不建候选池，但缺失修复
  // 仍会从缓存 / 同目录 / 备用目录找候选 —— 那里同样不得使用被排除的素材。
  // 用户刻意把素材挪走或删除，往往正是靠排除项表达"这个不要用"，替换时找回来等于白排除。
  const deny = normDeny((configPool.exclude && configPool.exclude.length)
    ? configPool.exclude
    : loadConfigPool(txtPath, null, { skipScan: true }).exclude);
  if (deny.length) logger.info(`🚫 配置排除项 ${deny.length} 条（所有替换候选一律排除）：${deny.join('、')}`);

  // ── 缺失片段修复（三路） ──
  // 先冻结「原始片段列表」：缺失修复会就地改写 job.videos，而最终的不一致占比校验必须
  // 以**原始**为基准 —— 否则缺失修复带来的改动量会被自己抹掉（表现为：生成时按 24.7% 判定
  // 已达下限而停止替换，校验时只认到 5.1% → 误判「重复度过高」导致出片失败）。
  for (const job of jobs) job.origVideos = job.videos.slice();
  const missingAll = [];
  for (const job of jobs) {
    for (let i = 0; i < job.videos.length; i++) {
      if (!exists(job.videos[i])) missingAll.push({ job, index: i, p: job.videos[i] });
    }
  }
  if (missingAll.length > 0) {
    logger.info('');
    logger.info(`⚠️  检测到 ${missingAll.length} 个片段不存在，需要修复：`);
    for (const m of missingAll) logger.info(`   [${m.job.name}] ${path.basename(m.p)}`);
    const unfixable = new Map();

    for (const m of missingAll) {
      const job = m.job;
      const orig = m.p;
      let newPath = null;
      let isEquivalent = false;
      const otherInJob = job.videos.filter((v) => v && v !== orig);
      const otherNames = otherInJob.map((v) => path.basename(v));

      // 首选：缓存按文件名反查
      newPath = resolveFromVideoCache(orig, { exclude: otherInJob, excludeNames: otherNames, index: cacheByName, deny });
      if (newPath && otherInJob.includes(newPath)) {
        logger.info(`   ⚠️ 缓存命中与本成片其它片段重复，改用其它候选：${path.basename(newPath)}`);
        newPath = null;
      }
      if (newPath) {
        isEquivalent = true;
        logger.info(`   🔎 缓存命中：${path.basename(orig)} -> ${path.basename(newPath)}（等效，不进入30%）`);
      }
      // 其次：**原配置素材池**优先（与主替换同源，才是真正的换新内容）；
      // 池不可用（原片复刻模式 / 配置正本缺失）时才退回"同目录同数字后缀"。
      // ⚠ 缺失修复的语义同样是「从原配置声明的目录里换一个片段」，不是"把文件放回原处"。
      if (!newPath) {
        const sel = await selectReplacementVideo({
          originalPath: orig, exclude: otherInJob, excludeNames: otherNames, info,
          pool: (configPool.pools && configPool.pools.length) ? poolForPath(configPool.pools, orig) : null,
          deny,
        });
        newPath = sel.path; isEquivalent = sel.equivalent;
      }
      // 再试：全局备用目录
      if (!newPath && cfg.fallbackDir) {
        const sel = await videoFromDirectory({ directory: cfg.fallbackDir, originalPath: orig, exclude: otherInJob, excludeNames: otherNames, deny });
        newPath = sel.path; isEquivalent = sel.equivalent;
      }

      if (!newPath || !exists(newPath)) {
        if (!newPath) {
          logger.info(`   ❌ 无法自动修复：${orig}`);
          logger.info('      索引/同目录/备用目录均无可替换视频，请将对应视频放回原路径，或设置 REPLICA_FALLBACK_DIR 备用目录后重跑');
        } else {
          logger.info(`   ❌ 替换候选已失效：${orig} -> ${newPath}`);
          newPath = null;
        }
        unfixable.set(job.name, `片段缺失且无法自动修复：${path.basename(orig)}`);
        continue;
      }
      job.videos[m.index] = newPath;
      // 两类归属分开记：非等效（内容确实换了）计入去重配额；等效（同序号/缓存命中，内容相近）另记一份。
      // 等效位**不锁定**该位置（选位时不跳过，仍可能被换成非等效片段，从而真正贡献去重）；
      // 但最终口径校验要把它排除（等效填充不算"不一致"）。
      if (isEquivalent) job.missingEquivalentIndices.push(m.index);
      else job.missingReplacedIndices.push(m.index);
      if (newPath !== orig) logger.info(`   ✅ [${job.name}] ${path.basename(orig)} -> ${path.basename(newPath)}`);
    }

    if (unfixable.size > 0) {
      jobs = jobs.filter((j) => !unfixable.has(j.name));
      for (const [badName, reason] of unfixable) {
        logger.info(`   ⏭️  跳过无法复刻的成片：${badName}（${reason}）`);
        logger.fail(badName, reason);
      }
      if (jobs.length === 0) return fail('所有成片均因片段缺失无法复刻', '日志复刻-缺失片段处理');
    }
  }

  // ── 输出目录（mode / configPool 已在缺失修复之前构建）──
  const outRoot = path.join(cfg.outputDir || derivedRoot, modeName);
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch (e) {}
  // 源配置备份：主进程已在启动前按提交快照还原 txtPath，故此处复制到的即本次执行所用配置。
  // 放在处理开始前，任务失败/中断也能留档（对齐批量侧「正本随任务开始时移入成片目录」）。
  try {
    const snapDest = path.join(outRoot, '配置备份-' + path.basename(txtPath));
    fs.copyFileSync(txtPath, snapDest);
    logger.info('配置备份就位：' + path.basename(snapDest));
  } catch (e) { /* 备份失败不阻断任务 */ }

  // ── 复刻日志（同日同模式复用同一文件，续写时补分隔线） ──
  const timeTag0 = `${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`;
  const logFilePath = path.join(outRoot, `${timeTag0}-${modeName}日志.txt`);
  try {
    if (!exists(logFilePath)) fs.writeFileSync(logFilePath, '', 'utf8');
    else fs.appendFileSync(logFilePath, '='.repeat(46) + '\r\n', 'utf8');
  } catch (e) {}

  // ── 执行权（旧实现用全局互斥体；现用文件锁，协议行保持一致） ──
  // 顺序：先输出等待/开始行，再输出总数行
  // 等待行：replica 旧实现缺此态，但 batch/mask 均有，backend 也据此显示「排队中」；按统一口径补齐
  logger.lockWaiting();
  const lock = await acquireLock(path.join(outRoot, '.video-lab-replica.lock'));
  logger.lockAcquired('开始复刻任务');

  logger.info('');
  logger.info(`开始日志复刻，共 ${jobs.length} 个成片`);
  let hasError = false;
  try {
    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
      const job = jobs[jobIndex];
      logger.info('');
      logger.info('------------------------------------------------');
      logger.info(`复刻第 ${jobIndex + 1} / ${jobs.length} 个成片：${job.name}`);

      let videos = job.videos.slice();
      if (videos.length === 0) {
        logger.error('日志复刻-片段检查', `成片 ${job.name} 没有视频片段`);
        logger.fail(job.name, '没有视频片段');
        hasError = true;
        continue;
      }
      const stillMissing = videos.filter((v) => !exists(v));
      if (stillMissing.length > 0) {
        logger.info(`   ❌ [${job.name}] 仍有 ${stillMissing.length} 个片段无法读取，不生成该成片：${path.basename(stillMissing[0])}`);
        logger.fail(job.name, `片段缺失且无法自动修复：${path.basename(stillMissing[0])}`);
        hasError = true;
        continue;
      }
      if (!job.watermark || !exists(job.watermark)) {
        logger.error('日志复刻-水印检查', `成片 ${job.name} 水印无效：${job.watermark}`);
        logger.fail(job.name, '水印无效');
        hasError = true;
        continue;
      }

      let totalDuration = 0;
      // 达标时所处的换档轮次（仅模式2）：决定最终验收允许的加速倍率 ——
      // 验收上限必须跟随达标档位，不能写死 speedThreshold，否则第 2 档及以后才达标的
      // 成片（换档机制的正常产物）会被误判「超阈值」丢弃，换档等于白换。
      let okRound = 0;
      // 换段失败记忆（键 = 原片段|已试候选）：换档循环与回补共用，避免同一组合反复试败
      const triedSubs = new Map();
      const maxDuration = cfg.maxDuration;
      const speedThreshold = cfg.speedLimit;
      // 档位驱动器：模式1/2 共用（模式1 不换档，恒处第 0 档）。本模块不保留任何档位常量
      // —— 语义改动只改 ladder.js，避免与批量侧再次分叉。
      const L = ladder.createRunner({ maxDuration, speedThreshold, maxRetry: cfg.maxRetry, logger });

      if (mode === 2) {
        // ── 模式2：尾部替换 + 换档重试（与批量拼接共用 base/ladder.js 的同一套档位语义）──
        // 红线：输出时长恒以 maxDuration 封顶（平台规则）；换档只放宽「允许的组合时长」，
        // 最终由成片加速把超出的部分压回设定值 —— 不是用加速去放宽这里的替换预算。
        let ladderAllowed = L.allowedOf(0);
        let workVideos = job.videos.slice();
        const exhaustedIdx = new Set();
        let durOk = false;
        let attempt = 0;
        for (let round = 0; round < L.rounds; round++) {
          ladderAllowed = L.allowedOf(round);
          if (L.isShift(round)) {
            // 换档：清掉上一档的失败记忆与耗尽标记，否则候选一直被挡、换档等于没换
            exhaustedIdx.clear();
            triedSubs.clear();
            L.announceShift(round);
          }
          let newVideos = [];
          if (round === 0) {
            const r = await selectVariancePaths({
              originalPaths: job.videos,
              alreadyChangedIndices: job.missingReplacedIndices,
              // 等效填充位**不跳过**：仍参与去重选位（被命中就换成非等效片段，去重更充分）
              alreadyEquivalentIndices: [],
              triedSubs, preferShort: true, dedupRatio: cfg.dedupRatio, info, logger,
              durationCap: ladderAllowed,
              dedupMax: cfg.dedupMax,
              dedupMaxOn: cfg.dedupMaxOn,
              // 候选池来自"原配置的素材目录"（第1段不动、其余段原位替换，顺序恒定）
              pools: configPool.pools,
              deny,
            });
            newVideos = r.paths;
            for (let i = 0; i < job.videos.length; i++) {
              if (job.videos[i] !== newVideos[i]) triedSubs.set(String(job.videos[i]) + '|' + newVideos[i], true);
            }
          } else {
            let longestIdx = -1;
            let longestDur = -1;
            for (let i = 0; i < workVideos.length; i++) {
              if (exhaustedIdx.has(i)) continue;
              const d = (await info(workVideos[i])).duration || 0;
              if (d > longestDur) { longestDur = d; longestIdx = i; }
            }
            if (longestIdx < 0) {
              // 全部位置已耗尽：不再空转剩余轮数，提前进入下一档放宽允许时长（与批量同口径）
              const nx = L.nextStepStart(round);
              if (nx >= 0) { L.announceStepSkip(); round = nx - 1; continue; }
              break;
            }
            const workKey = String(workVideos[longestIdx]);
            const exclude = [];
            for (const k of triedSubs.keys()) if (k.startsWith(workKey + '|')) exclude.push(k.slice(workKey.length + 1));
            const sel = await selectReplacementVideo({
              originalPath: workVideos[longestIdx], exclude, preferShort: true, shorterThan: longestDur, info,
              deny,
            });
            if (!sel.path) {
              exhaustedIdx.add(longestIdx);
              // 本档可替换位置已全部耗尽 → 提前进档（与批量同口径），避免「每档 N 轮」白跑
              if (exhaustedIdx.size >= workVideos.length) {
                const nx = L.nextStepStart(round);
                if (nx >= 0) { L.announceStepSkip(); round = nx - 1; continue; }
              }
              continue;
            }
            newVideos = workVideos.slice();
            newVideos[longestIdx] = sel.path;
            triedSubs.set(workKey + '|' + sel.path, true);
          }
          totalDuration = 0;
          for (const p of newVideos) totalDuration += (await info(p)).duration || 0;
          workVideos = newVideos.slice();
          if (totalDuration <= ladderAllowed) { durOk = true; okRound = round; break; }
          attempt = round + 1;
        }
        videos = workVideos.slice();
        if (!durOk) {
          logger.error('日志复刻-时长检查', `总时长 ${round1(totalDuration)} 秒超过允许阈值（${ladder.THR_STEPS.length} 档 × ${L.perStep} 轮已用尽），请重选片段或调整日志`);
          logger.fail(job.name, `总时长超阈值：${round1(totalDuration)} 秒`);
          hasError = true;
          continue;
        }
        if (attempt > 0) logger.warn(`该成片经 ${attempt} 轮渐进压时长后达标（总时长 ${round1(totalDuration)} 秒）`);
      } else {
        totalDuration = 0;
        for (const p of videos) totalDuration += (await info(p)).duration || 0;
      }

      // ── 成片内重复最终校验（按文件名） ──
      let dupGroups = dedupe.findDuplicates('nameKey', videos);
      if (dupGroups.length > 0) {
        const dupFixed = dupGroups.length;
        logger.warn(`检测到成片内重复片段 ${dupFixed} 组，尝试替换消除…`);
        const seenName = new Set();
        for (let vi = 0; vi < videos.length; vi++) {
          if (!videos[vi]) continue;
          const viName = path.basename(videos[vi]);
          if (!seenName.has(viName)) { seenName.add(viName); continue; }
          const viOthers = [];
          for (let k = 0; k < videos.length; k++) if (k !== vi && videos[k]) viOthers.push(path.basename(videos[k]));
          const excludeDup = videos.filter((v) => v && v !== videos[vi]);
          const selDup = await selectReplacementVideo({ originalPath: videos[vi], exclude: excludeDup, excludeNames: viOthers, info, deny });
          if (selDup.path && exists(selDup.path)) {
            logger.info(`     第 ${vi + 1} 段: ${viName} -> ${path.basename(selDup.path)}`);
            videos[vi] = selDup.path;
          }
        }
        dupGroups = dedupe.findDuplicates('nameKey', videos);
        if (dupGroups.length > 0) {
          const dupNames = dupGroups.map((g) => path.basename(g[0])).join('、');
          logger.error('日志复刻-重复片段检查', `成片内存在重复片段：${dupNames}`);
          logger.fail(job.name, `成片内存在重复片段：${dupNames}`);
          hasError = true;
          continue;
        }
        logger.info(`   ✅ 已替换消除 ${dupFixed} 组重复片段`);
        totalDuration = 0;
        for (const p of videos) totalDuration += (await info(p)).duration || 0;
      }

      // ── 重复度区间校验（模式2）──
      // 占比口径统一走 calcDedupRatio（唯一真相）：分母 = 实际播放列表时长和，分子 = 非等效差异位的播放时长。
      // 旧口径对 baseVideos 逐位 probe：原文件已不存在时 od=0，缺失位（本例 89.3s）从分母蒸发
      // → 「下限高能过、下限低反而失败」的悖论（选位账 37.2% / 校验账 33.2%）。
      // 下限未达标 → 先回补（宁多不少），找遍仍不达标才不出片；超上限 → 告警。
      if (mode === 2 && job.videos.length) {
        const baseVideos = job.origVideos || job.videos;
        const eqSet = new Set(job.missingEquivalentIndices || []);
        let ratioFinal = await calcDedupRatio(videos, baseVideos, eqSet, info);
        const minTxt = cfg.dedupMinOn ? round1(cfg.dedupMin * 100) + '%' : '未启用';
        const maxTxt = (cfg.dedupMaxOn && cfg.dedupMax > 0) ? round1(cfg.dedupMax * 100) + '%' : '未启用';

        // 回补（下限优先于上限：宁多不少，找遍仍不达标则回补）：
        // 按「越靠后越优先」对「尚未与原版不同的位 / 等效填充位」追加替换，直到达标或候选枯竭。
        // 等效位被换成非等效后要移出 eqSet，否则校验仍把它当"内容相近"而不计分子。
        if (cfg.dedupMinOn && ratioFinal < cfg.dedupMin) {
          logger.warn(`🔀 占比 ${round1(ratioFinal * 100)}% 低于下限 ${minTxt}，按「越靠后越优先」回补替换`);
          for (let i = videos.length - 1; i >= 1 && ratioFinal < cfg.dedupMin; i--) {
            const origKey = String(baseVideos[i]);
            const excludeSubs = [];
            for (const k of triedSubs.keys()) if (k.startsWith(origKey + '|')) excludeSubs.push(k.slice(origKey.length + 1));
            const usedNames = [];
            for (let k = 0; k < videos.length; k++) if (k !== i && videos[k]) usedNames.push(path.basename(videos[k]));
            const sel = await selectReplacementVideo({
              originalPath: videos[i], exclude: excludeSubs, excludeNames: usedNames, info,
              pool: configPool.pools ? poolForPath(configPool.pools, videos[i]) : null,
              noSameSuffix: true,
              deny,
            });
            if (!sel.path || sel.equivalent) continue;
            videos[i] = sel.path;
            triedSubs.set(origKey + '|' + sel.path, true);
            const wasEq = eqSet.delete(i);
            ratioFinal = await calcDedupRatio(videos, baseVideos, eqSet, info);
            logger.info(`     第 ${i + 1} 段回补: ${path.basename(baseVideos[i])} -> ${path.basename(sel.path)}`
              + `（占比 ${round1(ratioFinal * 100)}%${wasEq ? '，等效位已转正' : ''}）`);
          }
          // 回补改变了片段列表 → 重算总时长供后续时长/加速验收
          totalDuration = 0;
          for (const p of videos) totalDuration += (await info(p)).duration || 0;
        }

        logger.info(`🔀 不一致时长占比 ${round1(ratioFinal * 100)}%（下限 ${minTxt} / 上限 ${maxTxt}）`);
        if (cfg.dedupMinOn && ratioFinal < cfg.dedupMin) {
          logger.error('复刻-重复度下限', `不一致占比 ${round1(ratioFinal * 100)}% 低于下限 ${round1(cfg.dedupMin * 100)}%（重复度过高，回补后仍不达标）`);
          logger.fail(job.name, `不一致占比 ${round1(ratioFinal * 100)}% 低于下限`);
          hasError = true;
          continue;
        }
        if (cfg.dedupMaxOn && cfg.dedupMax > 0 && ratioFinal > cfg.dedupMax) {
          logger.warn(`不一致占比 ${round1(ratioFinal * 100)}% 超过上限 ${round1(cfg.dedupMax * 100)}%（可能被判为全新视频）`);
        }
      }

      // ── 时长与加速（共用底座唯一实现：按达标档位给出倍率与超限判定） ──
      const fin = L.finalize(totalDuration, okRound);
      const needSpeed = fin.needSpeed;
      const speedRatio = fin.speedRatio;
      if (needSpeed) {
        logger.warn(`总时长 ${totalDuration} 秒超设定，将加速 ${Math.round(speedRatio * 1000) / 1000}x`);
      } else if (fin.exceeded) {
        logger.error('日志复刻-时长检查', `总时长 ${totalDuration} 秒超过允许阈值（达标档位允许加速至 ${L.speedOf(okRound).toFixed(2)}x），请重选片段或调整日志`);
        logger.fail(job.name, `总时长超阈值：${round1(totalDuration)} 秒`);
        hasError = true;
        continue;
      }

      // ── 命名（模式2：yyMMdd改- + 同日序号化） ──
      let outName = job.name;
      if (mode === 2) {
        const dayPrefix = `${String(d0.getFullYear()).slice(2)}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}改`;
        const baseStem = job.name.replace(/\.mp4$/, '');
        const re = new RegExp('^' + escapeRegExp(dayPrefix) + '(\\d*)-' + escapeRegExp(baseStem) + '$');
        let hits = [];
        try {
          hits = fs.readdirSync(outRoot).filter((f) => f.toLowerCase().endsWith('.mp4'))
            .map((f) => path.basename(f, path.extname(f)))
            .filter((b) => re.test(b));
        } catch (e) { hits = []; }
        if (hits.length === 0) {
          outName = dayPrefix + '-' + outName;
        } else {
          let maxN = 0;
          for (const h of hits) {
            const m = re.exec(h);
            if (m && m[1] !== '') { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
          }
          outName = dayPrefix + (maxN + 1) + '-' + outName;
        }
      }
      let finalOut = path.join(outRoot, outName);
      if (path.extname(finalOut) === '') finalOut += '.mp4';
      // ★ 同批量模块：先写临时名，编码成功后再原子改名 ——
      //   正式名必须是「完整可播放产物」的唯一标志，否则编码中途停止会留下正式名半截文件
      //   （用户会误取、且续跑反推序号会把它当成已完成而永久跳过）。见 batch/index.js 同处说明。
      // 临时名 = `<随机>.tmp`（tempNameFor 统一生成）：与正式名完全无关，用户一眼可辨；
      // ffmpeg 无法从 `.tmp` 推断容器，故 encArgs 显式 `-f mp4` 强制 mp4 封装。
      const tmpOut = tempNameFor(finalOut);

      // ── 拼接 + 水印 + 编码（GPU 硬约束） ──
      const n = videos.length;
      if (n === 0) {
        logger.error('日志复刻-片段数检查', '无有效视频片段');
        logger.fail(job.name, '无有效视频片段');
        hasError = true;
        continue;
      }
      const inputArgs = [];
      for (const p of videos) inputArgs.push('-i', p);
      inputArgs.push('-i', job.watermark);

      let concatInputs = '';
      for (let i = 0; i < n; i++) concatInputs += `[${i}:v][${i}:a]`;
      let filterComplex = `${concatInputs}concat=n=${n}:v=1:a=1[outv][outa];[outv]overlay=0:0[wateredv]`;
      let mapV, mapA;
      if (needSpeed) {
        filterComplex += `;[wateredv]setpts=PTS/(${speedRatio})[v];[outa]atempo=${speedRatio}[a]`;
        mapV = '[v]'; mapA = '[a]';
      } else {
        mapV = '[wateredv]'; mapA = '[outa]';
      }
      const encArgs = [
        '-filter_complex', filterComplex,
        '-map', mapV, '-map', mapA,
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26',
        '-profile:v', 'high', '-level', '4.1',
        '-c:a', 'aac', '-b:a', '192k',
        '-f', 'mp4',
        '-y', tmpOut,
      ];
      const targetDur = totalDuration > maxDuration ? maxDuration : totalDuration;
      logger.clipDuration(round2(targetDur));
      const { code, stderr } = await runFfmpeg(inputArgs.concat(encArgs), { onProgress: (line) => logger.raw(line) });
      if (code !== 0) {
        // 同批量模块：把 ffmpeg 的退出码与 stderr 尾部带出来，不再只有「编码失败」
        const ffTail = logger.ffmpegTail(stderr);
        logger.diag('ffmpeg.fail', { step: 'replica.encode', name: job.name, code, tail: ffTail });
        logger.error('日志复刻-编码', `编码失败：${job.name}`);
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) { /* 清掉半截临时产物 */ }
        logger.fail(job.name, 'ffmpeg 编码失败（退出码 ' + code + '）');
        hasError = true;
        continue;
      }
      // ★ 编码成功 → 原子改名到正式名（改名前不得出现正式名产物）
      // 带重试：Windows 上杀软 / 索引服务会瞬时占用刚写完的大文件，单次失败即把成片误判为失败
      //（合成完成后要确保改名能完成，不被其他软件影响）
      const rnErr = await renameWithRetry(tmpOut, finalOut);
      if (rnErr) {
        logger.error('日志复刻-编码', `产物改名失败：${job.name} · ${(rnErr && rnErr.message) || rnErr}`);
        // ⚠ 保留临时产物：改名失败多为瞬时占用，删掉等于白编码一次
        logger.fail(job.name, '产物改名失败');
        hasError = true;
        continue;
      }
      logger.clipDone(finalOut);

      // ── 写复刻日志 ──
      try {
        const lines = [path.basename(finalOut), '使用片段列表：', ...videos, '', job.watermark];
        if (jobIndex < jobs.length - 1) lines.push('='.repeat(46));
        fs.appendFileSync(logFilePath, lines.join('\r\n') + '\r\n', 'utf8');
      } catch (e) {}
    }
  } finally {
    try { lock.release(); } catch (e) {}
    logger.lockReleased();
  }

  if (hasError) { logger.info(''); logger.info('任务完成（有错误）'); return 1; }
  logger.info('');
  logger.info('任务完成');
  return 0;
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = {
  id: 'replica',
  title: '复刻',
  envVars: ['REPLICA_*', 'VL_CACHE_DB'],
  run,
  // 供测试与调用方复用
  _internals: {
    readEnv, taskDate, parseJobs, sameDirCandidates, selectReplacementVideo, videoFromDirectory,
    buildCacheByNameIndex, resolveFromVideoCache, selectVariancePaths, mtimeToTicks, round1, round2,
    loadVideoCache,
  },
};
