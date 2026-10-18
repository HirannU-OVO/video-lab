// engines/modules/batch/index.js —— 批量拼接（行为等价优先）
// 解析 TXT 配置 → 扫描素材（含 .lnk 展开、索引自动修复、1080×1920 合规过滤）→ 选片状态机
// （Round/RoundUsed/SubRound/SubUsedInRound/SubUsageCount）→ 渐进替换重试 → ffmpeg 拼接 → 命名/分组/日志。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runFfmpeg, nvencArgs, aacTail } = require('../../base/ffmpeg');
const { probe } = require('../../base/probe');
const { acquireLock } = require('../../base/lock');
const { stripQuotes, exists, sortKey, renameWithRetry, tempNameFor, videoExts } = require('../../base/paths');
const { pickCandidate, pickRandom, failKey, triedPathsFor } = require('../../base/retry');
// 「加速换档重试」策略统一由 base/ladder.js 提供（批量与复刻共用）；本模块不内联档位常量，档位语义只改 ladder.js。
const ladder = require('../../base/ladder');

// 缓存作用域位掩码（与 engines/base/cache.js 的 SCOPES 同源，惰性取用：持久层不可用时不应影响任务执行，故不在模块顶层 require）。
const SCOPES_FALLBACK = { batch: 1, replica: 2, mask: 4 };
let _scopesCache = null;
function scopes() {
  if (!_scopesCache) {
    try { _scopesCache = require('../../base/cache').SCOPES || SCOPES_FALLBACK; }
    catch (e) { _scopesCache = SCOPES_FALLBACK; }
  }
  return _scopesCache;
}

// 视频扩展名以底座为准（base/paths 的 videoExts）：各模块自建白名单会让同一份素材
// 在某些模块被当视频、在另一些被忽略 —— .webm/.flv/.ts 的差异正是这么来的。
const VIDEO_EXTS = Array.from(videoExts);
const VIDEO_EXT_SET = new Set(VIDEO_EXTS);
// PS 的 LastWriteTimeUtc.Ticks 是 .NET DateTime.Ticks（0001-01-01 基准），
// 偏移为 621355968000000000（**不是** FILETIME 的 1601 基准 116444736000000000）
const DOTNET_EPOCH_TICKS = 621355968000000000;
const DOTNET_EPOCH_TICKS_BIG = 621355968000000000n;
// Ticks 在 JS Number 下超出 2^53 会丢精度（ulp≈128 ticks）：容差 1ms（10000 ticks）内视为同一时刻
const TICKS_TOLERANCE = 10000;

const isVideoFile = (p) => VIDEO_EXT_SET.has(path.extname(String(p || '')).toLowerCase());

/** 文件最后写入的 .NET Ticks（对齐 PS 的 $fileInfo.LastWriteTimeUtc.Ticks） */
function ticksOf(stat) {
  return stat.mtimeMs * 10000 + DOTNET_EPOCH_TICKS;
}

/** 精确 .NET Ticks（BigInt）：缓存写回必须与既有条目的 LastWriteTime 精确相等，Number 精度不够。 */
function ticksBigOfFile(videoPath) {
  try {
    const st = fs.statSync(videoPath, { bigint: true });
    return st.mtimeNs / 100n + DOTNET_EPOCH_TICKS_BIG;
  } catch (e) {
    return null;
  }
}

/** video_cache 持久层：VL_CACHE_DB 指向的 cache.db，由主进程注入（backend 的 _spawnEngine）。
 *  库未注入或不可用时返回 null，缓存退化为内存态（不影响出片，只是每次重探）。
 *  写回只落本次新探测的条目，不重写全表。
 *  ⚠ 不要加 `existsSync` 前置检查：`CacheStore.open()` 自己会建目录与库文件 ——
 *    加检查会让「库还没被创建时引擎直接放弃写库」，使用计数与现场探测结果被静默丢弃
 *    （首次运行 / 新机器 / 隔离环境必现；常规路径下因主进程先建好了库而被掩盖）。 */
function openVideoStore() {
  const dbPath = String(process.env.VL_CACHE_DB || '').trim();
  if (!dbPath) return null;
  try {
    const CacheStore = require('../../base/cache');
    const store = new CacheStore(dbPath, { root: '' });
    store.open();   // 自动建目录 + 建表（库不存在即创建）
    return store;
  } catch (e) {
    return null; // 库不可用：静默降级，不影响任务
  }
}

// ────────────────────────── .lnk 解析 ──────────────────────────
// 与 backend 共用同一份实现（engines/base/lnk.js）：纯 Node 读二进制解析，不起子进程。
const { parseLnkTarget, resolveBrokenTarget } = require('../../base/lnk');

/** 解析快捷方式目标（对齐 Get-ShortcutTarget；失败返回 null 并告警，不中断） */
function getShortcutTarget(lnkPath, log) {
  try {
    const target = String(parseLnkTarget(lnkPath) || '').trim();
    if (target && exists(target)) return target;
    const fixed = resolveBrokenTarget(target, log);
    if (fixed) { log.info(`🔧 快捷方式已智能修复：${lnkPath} -> ${fixed}`); return fixed; }
    log.warn(`快捷方式失效：${lnkPath} 目标无法解析（${target}）`);
    return null;
  } catch (e) {
    log.warn(`解析快捷方式 ${lnkPath} 失败：${e.message}`);
    return null;
  }
}

// ────────────────────────── env 解析 ──────────────────────────
function readEnv(env = process.env) {
  const s = (k, d = '') => (env[k] == null ? d : String(env[k]));
  const num = (k, d) => {
    const v = parseFloat(s(k));
    return Number.isFinite(v) ? v : d;
  };
  const intOrNull = (k) => {
    const v = s(k).trim();
    return /^\d+$/.test(v) ? parseInt(v, 10) : null;
  };
  // 多值文本项：分号分隔（设置页多值输入框存储为数组，经 env 用分号连接传递）
  const list = (k) => String(env[k] == null ? '' : env[k]).split(';').map((x) => x.trim()).filter(Boolean);
  return {
    txt: s('REPLICA_TXT'),
    maxTotalDuration: num('BATCH_MAX_DURATION', 179),
    maxRetry: num('BATCH_MAX_RETRY', 45),
    speedThreshold: num('BATCH_SPEED_LIMIT', 1.2),
    txtNamePrefix: list('BATCH_TXT_PREFIX'),
    producerName: s('BATCH_PRODUCER', '默认'),
    suffixMark: s('BATCH_SUFFIX_MARK'),
    // 续跑过滤：失败成片名（分号分隔）。据此反解序号只重做这些，其余按原始 totalOutput/groupCount 计算
    onlyNames: s('BATCH_ONLY_NAMES'),
    // 续跑「按序号补做」：失败发生在成片命名之前时没有名字可用，只能以序号标识（优先级高于 onlyNames）
    onlyIndices: list('BATCH_ONLY_INDEX'),
    count: intOrNull('BATCH_COUNT'),
    group: intOrNull('BATCH_GROUP'),
    submitTs: parseInt(s('BATCH_SUBMIT_TS', '0'), 10) || 0,
    outputDirOverride: s('REPLICA_OUTPUT_DIR'),
    noWait: s('REPLICA_NO_WAIT') === '1',
  };
}

/** 任务日期：提交时刻优先（跨天不回退实际运行日期） */
function taskDate(submitTs) {
  return submitTs > 0 ? new Date(submitTs) : new Date();
}
const pad = (n) => String(n).padStart(2, '0');

/** MMdd-HH时mm分 */
function timeTag(d) {
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}时${pad(d.getMinutes())}分`;
}
/** yyMMdd */
function datePrefix(d) {
  return `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ────────────────────────── 扫描与合规过滤 ──────────────────────────
/** 递归收集视频文件（跳过 .lnk，对齐 Get-VideoFile） */
function collectVideoFiles(rootPath, log) {
  const out = [];
  const walk = (dir) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      log.warn(`遍历文件夹 ${dir} 失败：${e.message}`);
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full); continue; }
      if (isVideoFile(full)) out.push(full);
    }
  };
  walk(rootPath);
  return out;
}

/** 排除规则命中（对齐 Test-ExcludePath：子串、忽略大小写、去尾斜杠） */
function isExcluded(videoFullPath, excludePaths) {
  if (!excludePaths || excludePaths.length === 0) return false;
  const hay = String(videoFullPath).toLowerCase();
  for (const ex of excludePaths) {
    const clean = String(ex == null ? '' : ex).trim().replace(/\\+$/, '');
    if (!clean) continue;
    if (hay.includes(clean.toLowerCase())) return true;
  }
  return false;
}

// ────────────────────────── 索引辅助（批量路径自动修复） ──────────────────────────
function findIndexInTree(startPath) {
  if (!startPath) return '';
  let dir = startPath;
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch (e) { dir = path.dirname(dir); }
  while (dir && dir !== path.dirname(dir)) {
    let cands = [];
    try {
      cands = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.isDirectory())
        .filter((e) => /\.tsv$/i.test(e.name) || (/\.txt$/i.test(e.name) && /索引|index/i.test(e.name)))
        .map((e) => {
          const full = path.join(dir, e.name);
          let mt = 0; try { mt = fs.statSync(full).mtimeMs; } catch (e2) { mt = 0; }
          return { full, mt };
        });
    } catch (e) { cands = []; }
    if (cands.length > 0) { cands.sort((a, b) => b.mt - a.mt); return cands[0].full; }
    dir = path.dirname(dir);
  }
  return '';
}

function findIndexFile(hintPath, hintPaths, pscriptRoot) {
  const votes = new Map();
  const all = [hintPath, ...(hintPaths || [])].filter(Boolean);
  for (const hp of all) {
    const found = findIndexInTree(hp);
    if (found) {
      const dir = path.dirname(found);
      votes.set(dir, (votes.get(dir) || 0) + 1);
    }
  }
  if (votes.size > 0) {
    let maxCount = 0;
    for (const v of votes.values()) if (v > maxCount) maxCount = v;
    const topDirs = [...votes.entries()].filter(([, c]) => c === maxCount).map(([d]) => d);
    if (topDirs.length === 1) {
      let best = null;
      try {
        const cands = fs.readdirSync(topDirs[0], { withFileTypes: true })
          .filter((e) => !e.isDirectory())
          .filter((e) => /\.tsv$/i.test(e.name) || (/\.txt$/i.test(e.name) && /索引|index/i.test(e.name)))
          .map((e) => {
            const full = path.join(topDirs[0], e.name);
            let mt = 0; try { mt = fs.statSync(full).mtimeMs; } catch (e2) { mt = 0; }
            return { full, mt };
          });
        cands.sort((a, b) => b.mt - a.mt);
        if (cands.length) best = cands[0].full;
      } catch (e) { best = null; }
      if (best) return best;
    }
  }
  const roots = [...new Set([...all, pscriptRoot].filter(Boolean))];
  for (const r of roots) {
    const found = findIndexInTree(r);
    if (found) return found;
  }
  return '';
}

/** 取文件夹名最后一个 '-' 之后的后缀（无 '-' 返回整名） */
function folderSuffix(folderPath) {
  const name = path.basename(folderPath);
  const idx = name.lastIndexOf('-');
  if (idx >= 0 && idx < name.length - 1) return name.slice(idx + 1);
  return name;
}

/** 载入索引（TSV：跳过首行，取第 3 列作为目录） */
function loadBatchIndex(indexPath) {
  const byDirLeaf = new Map();
  const byDirSuffix = new Map();
  if (!exists(indexPath)) return { byDirLeaf, byDirSuffix, loaded: false };
  let lines = [];
  try { lines = fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/); } catch (e) { lines = []; }
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const dir = cols[2];
    const leafKey = path.basename(dir).toLowerCase();
    if (!byDirLeaf.has(leafKey)) byDirLeaf.set(leafKey, []);
    byDirLeaf.get(leafKey).push(dir);
    const sKey = folderSuffix(dir).toLowerCase();
    if (!byDirSuffix.has(sKey)) byDirSuffix.set(sKey, []);
    byDirSuffix.get(sKey).push(dir);
  }
  return { byDirLeaf, byDirSuffix, loaded: true };
}

function resolveFolderFromIndex(index, missingPath) {
  const leaf = path.basename(missingPath);
  if (!leaf) return null;
  const dirs = index.byDirLeaf.get(leaf.toLowerCase());
  if (!dirs) return null;
  for (const d of [...new Set(dirs)]) if (exists(d)) return d;
  return null;
}

function resolveFolderBySuffix(index, missingPath) {
  const suffix = folderSuffix(missingPath);
  if (!suffix) return [];
  const dirs = index.byDirSuffix.get(suffix.toLowerCase());
  if (!dirs) return [];
  return [...new Set(dirs)].filter((d) => exists(d));
}

// ────────────────────────── 选片状态机 ──────────────────────────
// 记录某位置本轮已选片段/子组：配置允许同一路径重复出现，同一成片内相同路径的多个位置
// 必须共用本轮排除集合，否则（沿用片段未登记时）后续位置会选到与前面相同的片段
function registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, video, plan) {
  if (!video) return;
  if (!sourceExcludedPaths.has(srcPath)) sourceExcludedPaths.set(srcPath, []);
  sourceExcludedPaths.get(srcPath).push(video.fullName);
  if (plan && plan.selectedGroup) {
    if (!sourceExcludedSubGroups.has(srcPath)) sourceExcludedSubGroups.set(srcPath, []);
    sourceExcludedSubGroups.get(srcPath).push(plan.selectedGroup);
  }
}

/**
 * 候选选择（对齐 Select-VideoCandidate）：本轮未用 + 未排除 → 可选「只保留更短」→
 * 使用次数最少的一批 → PreferShort 时取最短的一批随机，否则随机。
 */
function selectVideoCandidate({ fileList, usedCount, roundUsed, exclude, preferShort, shorterThan, getInfo, rng }) {
  const excludeSet = new Set(exclude || []);
  let candidates = fileList.filter((f) => !roundUsed.has(f.fullName) && !excludeSet.has(f.fullName));
  if (shorterThan > 0) {
    candidates = candidates.filter((f) => getInfo(f.fullName).duration < shorterThan);
  }
  if (candidates.length === 0) return null;
  return pickCandidate(candidates, {
    usedCount: (f) => {
      const v = usedCount.get(f.fullName);
      return v == null ? 0 : v;
    },
    preferShort: !!preferShort,
    shorterThan: 0,   // 更短过滤已在上方完成
    durationOf: (f) => getInfo(f.fullName).duration,
    rng,
  });
}

/**
 * 选片（对齐 Select-Video）：返回 { video, plan } 或 null。
 * plan 携带本轮状态推进信息：newRound/newRoundUsed/newSubRound/newSubUsedInRound/selectedGroup/incrementSubUsage
 */
function selectVideo({ srcPath, track, folderData, excludedPaths, excludedSubGroups, preferShort, shorterThan, getInfo, rng }) {
  const plan = {
    folder: srcPath,
    newRound: track.round,
    newRoundUsed: [...track.roundUsed],
    newSubRound: folderData.subRound,
    newSubUsedInRound: [...folderData.subUsedInRound],
    selectedGroup: null,
    incrementSubUsage: null,
  };
  const roundUsedSet = new Set(track.roundUsed);
  const common = { usedCount: track.usedCount, roundUsed: roundUsedSet, exclude: excludedPaths, preferShort, shorterThan, getInfo, rng };

  // ── 单组分支 ──
  if (folderData.subGroupList.length <= 1) {
    let video = selectVideoCandidate({ ...common, fileList: folderData.allVideos });
    if (video) return { video, plan };
    // 候选耗尽：忽略 RoundUsed 重选（状态推进到新轮）
    plan.newRound = track.round + 1;
    plan.newRoundUsed = [];
    video = selectVideoCandidate({ ...common, fileList: folderData.allVideos, roundUsed: new Set() });
    if (video) return { video, plan };
    return null;
  }

  // ── 多子组分支（组维度轮询）──
  // **硬约束**：同一成片内，该源的不同片段必须来自**不同子组**。
  // 降重由两条保证：① 组间按组使用计数均衡（subUsageCount 最少优先）；
  //   ② 组内按片段使用计数最少优先（selectVideoCandidate 内建）。
  // ⚠ 不要用「组内存在全局从未用过的片段」作组间门槛：小组用一次即出局、负载全压到最后一个大组。
  const excludedSubSet = new Set(excludedSubGroups || []);
  const allGroups = [...folderData.subGroupList];

  const pickFrom = (groups, useRoundUsed) => {
    const remaining = [...groups];
    while (remaining.length > 0) {
      // 取子组使用次数最少的一批，随机选一个子组
      let minCount = Infinity;
      for (const g of remaining) {
        const c = folderData.subUsageCount.get(g) || 0;
        if (c < minCount) minCount = c;
      }
      const bestGroups = remaining.filter((g) => (folderData.subUsageCount.get(g) || 0) === minCount);
      const selectedGroup = pickRandom(bestGroups, rng);
      const files = folderData.subGroups.get(selectedGroup) || [];
      const video = selectVideoCandidate({
        ...common,
        fileList: files,
        roundUsed: useRoundUsed ? roundUsedSet : new Set(),
      });
      if (video) {
        plan.selectedGroup = selectedGroup;
        plan.incrementSubUsage = selectedGroup;
        plan.newSubUsedInRound.push(selectedGroup);
        return video;
      }
      const idx = remaining.indexOf(selectedGroup);
      if (idx >= 0) remaining.splice(idx, 1);
    }
    return null;
  };

  // 组池：本轮（subRound）未选过的组优先 —— 轮询本体；全选过 → 推进 subRound 组维度重开一轮
  let pool = allGroups.filter((g) => !folderData.subUsedInRound.includes(g));
  if (pool.length === 0) {
    plan.newSubRound = folderData.subRound + 1;
    plan.newSubUsedInRound = [];
    pool = [...allGroups];
  }
  pool = pool.filter((g) => !excludedSubSet.has(g));   // 硬约束：本片内组不重复
  let video = pool.length > 0 ? pickFrom(pool, true) : null;
  if (video) return { video, plan };

  // 组池内无候选（本轮片段用满/被排除）→ 推进 subRound 让全部组重新参与，再按硬约束过滤重试
  plan.newSubRound = folderData.subRound + 1;
  plan.newSubUsedInRound = [];
  const pool2 = allGroups.filter((g) => !excludedSubSet.has(g));
  video = pool2.length > 0 ? pickFrom(pool2, true) : null;
  if (video) return { video, plan };

  // 仍无候选 → 忽略「本轮已用」跨轮复用（仍优先 usedCount 最少的片段；同片内文件不重复的约束不变）
  plan.newRound = track.round + 1;
  plan.newRoundUsed = [];
  video = pool2.length > 0 ? pickFrom(pool2, false) : null;
  if (video) return { video, plan };

  return null;
}

// ────────────────────────── 分组重命名 ──────────────────────────
/** 从成片名反解序号（续跑过滤 BATCH_ONLY_NAMES 用）：容忍分组后缀 A/B/C 与序号标识后缀。
 *  分组任务的成片名形如 <配置名>-<序号><组后缀>.mp4（如 ...-2A.mp4）；配置了后缀标识时形如
 *  <配置名>-<后缀><序号><组后缀>.mp4（如 ...-A2A.mp4）。若只用 -(\d+)$ 匹配，
 *  这类名字全部解析失败 → 分组 / 带后缀任务的续跑永不命中。 */
function parseOnlyNameIndex(name) {
  const s = String(name || '');
  const base = path.basename(s, path.extname(s));
  // 末段 = 可选后缀标识（不含短横与数字）+ 序号 + 可选组后缀；`[^-\d]*` 同时兼容漏掉分隔符的旧名字，已产出的成片仍可续跑。
  const m = /-([^-\d]*)(\d+)([A-Z]?)$/.exec(base);
  return m ? parseInt(m[2], 10) : 0;
}

/** 组后缀：第 idx（1 起）个成片属于第几组 → A/B/C…（对齐 PS 的分桶公式） */
function groupSuffixFor(idx, total, groupCount) {
  if (groupCount <= 1) return '';
  const groupSize = Math.floor(total / groupCount);
  const remainder = total % groupCount;
  let start = 1;
  for (let g = 0; g < groupCount; g++) {
    const size = groupSize + (g < remainder ? 1 : 0);
    if (idx >= start && idx < start + size) return String.fromCharCode(65 + g);
    start += size;
  }
  return '';
}

// ────────────────────────── 主流程 ──────────────────────────
async function run(ctx, env = process.env) {
  const { logger } = ctx;
  const cfg = readEnv(env);
  const scriptRoot = __dirname;
  // 缓存库缺失时的兜底目录：仅用于放互斥锁，绝不写模块目录（那会污染源码仓并随打包进入发布物）
  const cacheDir = path.join(os.tmpdir(), 'video-lab-engine-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {}
  const fail = (msg, step) => { logger.diag('fail', { step: String(step || ''), msg: String(msg || '').slice(0, 300) }); logger.error(step, msg); return 1; };

  // ── 缓存载入：缓存库只读复用（避免 Ticks 精度回写风险），计数语义在库内维护 ──
  const videoStore = openVideoStore();
  // 读取范围收紧为「批量 + 复刻」：遮罩素材的探测条目不得进入批量候选
  const diskVideoCache = videoStore
    ? videoStore.loadVideoMap({ scopesMask: scopes().batch | scopes().replica })
    : {};
  const memInfo = new Map();          // 本次任务内的探测结果缓存
  // 本次真正探测过的条目 → 任务结束后合并写回（只增/更新，不删；GC 仍归 backend），让执行期现场探测的新文件沉淀进缓存库供预检测复用。
  const probedForWriteBack = new Map();
  // 本任务内的使用计数（文件名 → { UsageCount, LastWriteTime }）：由缓存库认领结果填充，出片后按增量累加，仅作本次调度依据（持久化在库内）。
  const usageCacheMap = {};

  /** 视频信息（对齐 Get-CachedVideoInfo：Ticks 命中则复用，否则探测并记内存） */
  const getInfo = (videoPath) => {
    if (memInfo.has(videoPath)) return memInfo.get(videoPath);
    let stat = null;
    try { stat = fs.statSync(videoPath); } catch (e) { stat = null; }
    if (!stat) {
      const invalid = { valid: false, duration: 0, width: 0, height: 0, ticks: 0 };
      memInfo.set(videoPath, invalid);
      return invalid;
    }
    const ticks = ticksOf(stat);
    const cached = diskVideoCache[videoPath];
    if (cached && Math.abs(Number(cached.LastWriteTime) - ticks) < TICKS_TOLERANCE) {
      const info = {
        valid: !!cached.Valid,
        duration: Number(cached.Duration) || 0,
        width: Number(cached.Width) || 0,
        height: Number(cached.Height) || 0,
        ticks,
      };
      memInfo.set(videoPath, info);
      return info;
    }
    return null; // 需异步探测，见下方 getInfoAsync
  };

  /** 异步版（需要真正探测时使用） */
  const getInfoAsync = async (videoPath) => {
    const hit = getInfo(videoPath);
    if (hit) return hit;
    let stat = null;
    try { stat = fs.statSync(videoPath); } catch (e) { stat = null; }
    if (!stat) {
      const invalid = { valid: false, duration: 0, width: 0, height: 0, ticks: 0 };
      memInfo.set(videoPath, invalid);
      return invalid;
    }
    const r = await probe(videoPath);
    const info = { valid: !!r.valid, duration: r.duration || 0, width: r.width || 0, height: r.height || 0, ticks: ticksOf(stat) };
    memInfo.set(videoPath, info);
    // 精确 Ticks（BigInt）用于写回：PS 侧 `-eq` 是精确比较，Number 精度不足会永不命中
    const bigTicks = ticksBigOfFile(videoPath);
    if (bigTicks !== null) {
      probedForWriteBack.set(videoPath, {
        LastWriteTime: bigTicks,
        Duration: info.duration,
        Width: info.width,
        Height: info.height,
        Valid: info.valid,
        FileSize: Number(stat.size) || 0,
      });
    }
    return info;
  };

  const durationOf = (videoPath) => {
    const hit = memInfo.get(videoPath);
    return hit ? hit.duration : 0;
  };

  // ── TXT 输入校验 ──
  // ⚠ 失败文案面向**普通用户**：只讲「怎么了 + 怎么办」，禁止出现「环境变量 / 脚本 / 手动输入」等技术措辞。
  const txtCandidate = stripQuotes(cfg.txt).replace(/^"|"$/g, '');
  let txtFilePath = '';
  if (!txtCandidate) {
    return fail('未选择配置文件：请在主窗口选择配置 TXT 后重新开始制作', 'TXT输入');
  }
  try {
    if (fs.statSync(txtCandidate).isFile() && path.extname(txtCandidate).toLowerCase() === '.txt') {
      txtFilePath = txtCandidate;
      logger.info(`✅ 配置文件：${path.basename(txtFilePath)}`);
    }
  } catch (e) { txtFilePath = ''; }
  if (!txtFilePath) {
    return fail(`配置文件不可用：${txtCandidate}（可能已被移动、重命名或删除，请在主窗口重新选择配置后开始制作）`, 'TXT输入');
  }

  const txtDir = path.dirname(txtFilePath);
  const txtName = path.basename(txtFilePath, path.extname(txtFilePath));
  let txtNamePrefixPart = '';
  let txtNameSuffix = txtName;
  // 多前缀：取首个命中 TXT 名的作剥离，其余在成片命名时按设置顺序继续命中追加（见命名段）
  for (const p of cfg.txtNamePrefix) {
    if (txtName.startsWith(p)) {
      txtNamePrefixPart = p;
      txtNameSuffix = txtName.slice(p.length);
      break;
    }
  }

  // ── baseDir：向上找「N月」或四位年份目录 ──
  const pathParts = txtDir.split(/[\\/]+/);
  let dateDirIndex = -1;
  for (let i = 0; i < pathParts.length; i++) {
    if (/^\d+月$/.test(pathParts[i]) || /^\d{4}$/.test(pathParts[i])) { dateDirIndex = i; break; }
  }
  let baseDir;
  if (dateDirIndex > 0) baseDir = pathParts.slice(0, dateDirIndex).join('\\');
  else if (dateDirIndex === 0) baseDir = pathParts[0];
  else baseDir = txtDir;
  if (!baseDir) baseDir = txtDir;

  const now = taskDate(cfg.submitTs);
  const monthName = `${now.getMonth() + 1}月`;
  const dayName = `${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let outputRootDir = path.join(baseDir, monthName, dayName);
  if (cfg.outputDirOverride) outputRootDir = cfg.outputDirOverride;
  logger.info('');
  logger.info(`✅ 输出目录：${outputRootDir}`);

  // ── 解析 TXT ──
  let allLines = [];
  try {
    allLines = fs.readFileSync(txtFilePath, 'utf8').replace(/^\uFEFF/, '')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => /\S/.test(l));
  } catch (e) {
    // 原始系统错误（如 ENOENT/权限）只进日志供排查，用户可见文案不暴露英文技术细节
    logger.error('TXT输入', '读取配置失败（底层错误）：' + e.message);
    return fail('读取配置失败：文件可能已损坏或无法访问，请重新选择配置 TXT 后开始制作', 'TXT输入');
  }
  if (allLines.length < 2) return fail('配置内容不完整：至少需要 1 个文件夹和 1 个水印，请检查配置 TXT 的内容', 'TXT输入');

  const watermark = stripQuotes(allLines[allLines.length - 1]);
  const excludePaths = [];
  const folderLines = [];
  const noSubRoundFolders = new Set();
  for (const raw of allLines.slice(0, allLines.length - 1)) {
    const line = raw.trim();
    if (line.includes('=')) {
      const folderPath = line.replace(/=/g, '').trim();
      if (folderPath) { folderLines.push(folderPath); noSubRoundFolders.add(folderPath); }
    } else if (line.startsWith('-')) {
      const ex = stripQuotes(line.slice(1).trim());
      if (ex) excludePaths.push(ex);
    } else {
      const folderPath = stripQuotes(line);
      folderLines.push(folderPath);
    }
  }

  // ── 索引自动修复不存在的目录 ──
  const invalidInput = async (msg) => {
    if (msg) { logger.info(''); logger.info(msg); }
    // ⚠ 不要说「请修改 TXT」—— 走到这里的多数原因跟 TXT 无关（素材不合规、水印不是 PNG、文件夹里没有视频…），改用中性、可执行的措辞。
    logger.info('请按上面的提示处理后，重新拖入 TXT。');
    return 1;
  };
  const missingPaths = folderLines.filter((p) => !exists(p));
  if (missingPaths.length > 0) {
    const idxFile = findIndexFile(txtFilePath, folderLines, scriptRoot);
    let index = { byDirLeaf: new Map(), byDirSuffix: new Map(), loaded: false };
    if (idxFile) {
      index = loadBatchIndex(idxFile);
      logger.info(`📇 已加载索引：${idxFile}`);
    }
    const replacements = new Map();
    for (const mp of missingPaths) {
      let newDir = index.loaded ? resolveFolderFromIndex(index, mp) : null;
      if (newDir && newDir !== mp) {
        logger.info(`🔎 索引自动修正（相同文件夹名）：${mp} -> ${newDir}`);
      } else {
        const cands = index.loaded ? resolveFolderBySuffix(index, mp) : [];
        if (cands.length > 0) {
          let selected = null;
          if (cands.length === 1) {
            selected = cands[0];
            logger.info(`🔎 索引自动修正（相同后缀）：${mp} -> ${selected}`);
          } else {
            logger.info('');
            logger.info(`🔎 路径 ${mp} 未找到同名文件夹，但找到以下相同后缀候选：`);
            cands.forEach((c, i) => logger.info(`  ${i + 1}. ${c}`));
            selected = cands[0];
            logger.info('（由 Video Lab 驱动，自动选择第 1 项）');
          }
          if (selected && selected !== mp) {
            logger.info(`🔎 索引自动修正：${mp} -> ${selected}`);
            newDir = selected;
          }
        }
      }
      if (newDir) {
        replacements.set(mp, newDir);
        for (let i = 0; i < folderLines.length; i++) {
          if (folderLines[i].toLowerCase() === mp.toLowerCase()) {
            folderLines[i] = newDir;
            if (noSubRoundFolders.has(mp)) { noSubRoundFolders.delete(mp); noSubRoundFolders.add(newDir); }
          }
        }
      }
    }
    if (replacements.size > 0) {
      try {
        const txtLines = fs.readFileSync(txtFilePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
        for (let i = 0; i < txtLines.length; i++) {
          const trim = txtLines[i].trim();
          let key = trim;
          if (key.startsWith('=')) key = key.slice(1).trim();
          if (replacements.has(key)) {
            txtLines[i] = trim.startsWith('=') ? '=' + replacements.get(key) : replacements.get(key);
          }
        }
        fs.writeFileSync(txtFilePath, txtLines.join('\r\n'), 'utf8');
        logger.info(`✅ TXT文件已同步更新：${txtFilePath}`);
      } catch (e) {
        logger.warn(`TXT 回写失败：${e.message}`);
      }
    }
  }

  // ── 路径 / 水印 / 文件夹校验 ──
  const stillInvalid = folderLines.filter((p) => !exists(p));
  if (stillInvalid.length > 0) {
    logger.info('');
    logger.info('❌ 以下路径无法通过索引自动修复：');
    stillInvalid.forEach((p) => logger.info(`   ${p}`));
    return invalidInput('');
  }
  if (!/\.png$/i.test(watermark) || !exists(watermark)) {
    logger.info('');
    logger.info(`❌ 水印必须是有效PNG文件：${watermark}`);
    return invalidInput('');
  }
  if (folderLines.length === 0) {
    logger.info('');
    logger.info('❌ 无有效视频文件夹');
    return invalidInput('');
  }

  // ── 重复路径提示 ──
  const sourceRequests = folderLines;
  const uniqueFolders = [...new Set(sourceRequests)];
  const pathCounts = new Map();
  for (const p of sourceRequests) pathCounts.set(p, (pathCounts.get(p) || 0) + 1);
  const repeatPaths = new Set([...pathCounts.entries()].filter(([, c]) => c > 1).map(([p]) => p));
  if (repeatPaths.size > 0) {
    logger.info('🔁 检测到重复路径，将在拼接时输出这些路径的详细选取信息');
    for (const rp of repeatPaths) logger.info(`   📂 ${rp} (出现 ${pathCounts.get(rp)} 次)`);
  }

  // ── 扫描每个源目录，构建 folderVideos / usageTracker ──
  logger.info('');
  logger.info('预检测视频文件');
  const folderVideos = new Map();
  const usageTracker = new Map();

  // 计数认领：路径发生变化（改名 / 移位）的素材先尝试继承既有条目的使用计数，避免被当作全新素材重新计数。
  // 与 app 侧预检测共用持久层的同一实现，保证两条路径行为一致；继承的计数沿用既有语义「≥1 归为 1」。
  // 未认领到计数的素材在本次任务内按 0 起算，其计数由出片时的增量写入库。
  const claimUsageFor = (vPath) => {
    if (!videoStore) return null;
    try {
      const tb = ticksBigOfFile(vPath);
      if (tb === null) return null;
      const r = videoStore.claimUsage(vPath, String(tb), {
        fileSize: Number(fs.statSync(vPath).size) || 0,
        scopesMask: scopes().batch | scopes().replica,
        scopes: scopes().batch,
      });
      if (!r || !(Number(r.usageCount) > 0)) return null;
      return { usageCount: Number(r.usageCount), ticks: tb };
    } catch (e) { return null; }
  };

  const pushValid = (target, fullName, name, info) => {
    target.push({ fullName, name, duration: info.duration });
    if (Object.prototype.hasOwnProperty.call(usageCacheMap, fullName)) return;
    const claimed = claimUsageFor(fullName);
    if (claimed) usageCacheMap[fullName] = { UsageCount: claimed.usageCount >= 1 ? 1 : claimed.usageCount, LastWriteTime: claimed.ticks };
  };

  for (const f of uniqueFolders) {
    let stat = null;
    try { stat = fs.statSync(f); } catch (e) { stat = null; }
    if (!stat) return fail(`路径不存在：${f}`, '预检测');

    const subGroups = new Map();
    if (stat.isDirectory()) {
      let rootItems = [];
      try { rootItems = fs.readdirSync(f, { withFileTypes: true }); } catch (e) { rootItems = []; }
      const subDirPaths = [];
      const lnkFiles = [];
      const rootVideoItems = [];
      for (const it of rootItems) {
        const full = path.join(f, it.name);
        if (it.isDirectory()) subDirPaths.push(full);
        else if (path.extname(it.name).toLowerCase() === '.lnk') lnkFiles.push(full);
        else if (isVideoFile(full)) rootVideoItems.push(full);
      }

      // 根目录视频
      const validRoot = [];
      for (const vp of rootVideoItems) {
        if (isExcluded(vp, excludePaths)) continue;
        const info = await getInfoAsync(vp);
        if (info.valid) pushValid(validRoot, vp, path.basename(vp), info);
      }
      if (validRoot.length) subGroups.set('(根目录)', validRoot);

      // 子目录
      for (const subDir of subDirPaths) {
        const files = collectVideoFiles(subDir, logger);
        if (!files.length) continue;
        const validSub = [];
        for (const vp of files) {
          if (isExcluded(vp, excludePaths)) continue;
          const info = await getInfoAsync(vp);
          if (info.valid) pushValid(validSub, vp, path.basename(vp), info);
        }
        if (validSub.length) subGroups.set(subDir, validSub);
      }

      // 快捷方式
      for (const lnk of lnkFiles) {
        const target = getShortcutTarget(lnk, logger);
        if (!target) continue;
        let tstat = null;
        try { tstat = fs.statSync(target); } catch (e) { tstat = null; }
        if (!tstat) continue;
        if (tstat.isDirectory()) {
          const files = collectVideoFiles(target, logger);
          if (!files.length) continue;
          const validT = [];
          for (const vp of files) {
            if (isExcluded(vp, excludePaths)) continue;
            const info = await getInfoAsync(vp);
            if (info.valid) pushValid(validT, vp, path.basename(vp), info);
          }
          if (validT.length) subGroups.set(`[快捷方式] ${path.basename(lnk)}`, validT);
        } else if (isVideoFile(target) && !isExcluded(target, excludePaths)) {
          const info = await getInfoAsync(target);
          if (info.valid) {
            if (!subGroups.has('(根目录)')) subGroups.set('(根目录)', []);
            pushValid(subGroups.get('(根目录)'), target, path.basename(target), info);
          }
        }
      }
    } else if (isVideoFile(f)) {
      if (isExcluded(f, excludePaths)) {
        logger.warn(`文件被排除规则命中：${f}`);
      } else {
        const info = await getInfoAsync(f);
        if (info.valid) {
          const arr = [];
          pushValid(arr, f, path.basename(f), info);
          subGroups.set('(根目录)', arr);
        }
      }
    } else {
      logger.warn(`指定的文件不是视频格式：${f}`);
      continue;
    }

    // 汇总：AllVideos 去重排序；子组列表
    let allVideos = [];
    let subGroupList = [];
    for (const [key, arr] of subGroups.entries()) { allVideos = allVideos.concat(arr); subGroupList.push(key); }
    const seen = new Set();
    allVideos = allVideos
      .filter((v) => (seen.has(v.fullName) ? false : (seen.add(v.fullName), true)))
      .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));

    if (allVideos.length === 0) {
      logger.info('');
      // 写清「什么才算合规」：合规标准是竖版 1080×1920 且有时长。
      logger.info(`❌ 路径 ${f} 里没有可用素材：只认竖版 1080×1920 且有时长的视频（素材确实符合时，请检查 FFprobe 是否可用）`);
      return invalidInput('');
    }

    if (noSubRoundFolders.has(f)) {
      subGroups.clear();
      subGroups.set('全部', allVideos);
      subGroupList = ['全部'];
    }

    if (subGroupList.length <= 1) logger.info(`${f} ：${allVideos.length} 个视频`);
    else logger.info(`${f} ：${allVideos.length} 个视频，分为 ${subGroupList.length} 个子组`);

    const subUsageCount = new Map();
    for (const g of subGroupList) subUsageCount.set(g, 0);
    folderVideos.set(f, {
      allVideos,
      subGroups,
      subGroupList,
      subRound: 1,
      subUsedInRound: [],
      subUsageCount,
    });

    const usedCount = new Map();
    for (const v of allVideos) {
      const entry = usageCacheMap[v.fullName];
      usedCount.set(v.fullName, entry ? Number(entry.UsageCount) || 0 : 0);
    }
    usageTracker.set(f, { folder: f, usedCount, roundUsed: [], round: 1 });
  }

  // ── 生成数量 / 分组数 ──
  logger.info('');
  logger.info('设置生成数量');
  if (cfg.count == null || cfg.count <= 0) {
    return fail('未设置生成数量：请在主窗口设置份数后重新开始制作', '生成数量');
  }
  const totalOutput = cfg.count;
  logger.info(`已通过 BATCH_COUNT 指定生成数量: ${totalOutput}`);

  let groupCount = 0;
  if (totalOutput > 1) {
    logger.info('');
    logger.info('设置分组数');
    if (cfg.group == null) {
      return fail('未设置分组数：请在主窗口设置分组后重新开始制作', '分组数');
    }
    groupCount = cfg.group;
    logger.info(`已通过 BATCH_GROUP 指定分组数: ${groupCount}`);
  }

  // ── 互斥锁（backend 已串行；此处为兜底）──
  // 位置固定：与缓存库同级（跨进程稳定的同一把锁），库未注入时退回系统临时目录
  logger.info('');
  logger.lockWaiting('准备拼接...');
  const lockDir = path.dirname(String(process.env.VL_CACHE_DB || '').trim() || cacheDir);
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch (e) {}
  const lockPath = path.join(lockDir, '.video-lab-batch.lock');
  let lock = null;
  try {
    lock = await acquireLock(lockPath);
  } catch (e) {
    return fail(`获取互斥锁失败：${e.message}`, '互斥锁');
  }
  logger.lockAcquired('开始执行拼接任务');

  let hasError = false;
  // 当前加速档位（0 基）：必须定义在**函数级** —— 除了「档位循环」内部，失败诊断（round / fail 事件）也要读它。
  // ⚠ 若用 const 定义在 retryCount 循环体内，循环外引用会抛 `thrStep is not defined`
  //   （只在首个「超阈值未达标」成片才走到该路径，报错后整批中断）。
  let thrStep = 0;
  try {
    // ── 创建输出目录 ──
    logger.info('');
    logger.info('创建输出目录');
    const monthDir = path.dirname(outputRootDir);
    fs.mkdirSync(monthDir, { recursive: true });
    fs.mkdirSync(outputRootDir, { recursive: true });
    const tag = timeTag(taskDate(cfg.submitTs));
    const outDir = path.join(outputRootDir, `${tag}-${txtName}-成片`);
    if (!exists(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      logger.outDir(outDir);
    }
    // 配置移入成片文件夹作为正本（移动而非复制）
    const txtDest = path.join(outDir, path.basename(txtFilePath));
    try {
      fs.renameSync(txtFilePath, txtDest);
    } catch (e) {
      fs.copyFileSync(txtFilePath, txtDest);
      try { fs.unlinkSync(txtFilePath); } catch (e2) { /* 忽略 */ }
    }
    // ★ 通知主进程「配置的归属位置已改变」：主进程据此立刻失效配置树缓存并广播前端。
    //   这一步只可能发生在引擎进程内（主进程 spawn 时文件还在原处），所以必须由引擎主动上报；
    //   否则界面会继续显示已失效的旧条目（开始任务后列表仍是「0927*」外部配置，点进去是空的）。
    logger.info('配置正本就位：' + path.basename(txtDest));

    const logFilePath = path.join(outDir, `${tag}-${txtName}-拼接日志.txt`);
    // 续跑时日志已存在 → 保留并追加，不清空（否则会抹掉首次记录）
    if (!exists(logFilePath)) fs.writeFileSync(logFilePath, '', 'utf8');

    logger.info('');

    // 续跑：仅重做 BATCH_ONLY_NAMES 指定的序号；totalOutput / groupCount 保持原始值不动，使成片命名与分组后缀与首次运行一致。
    let indexList = [];
    for (let i = 1; i <= totalOutput; i++) indexList.push(i);
    let resumeMode = false;
    if (cfg.onlyIndices.length) {
      // 按序号补做（失败于命名之前的成片走这条）：直接取序号，无需从成片名反解
      const idxs = cfg.onlyIndices.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= totalOutput);
      if (!idxs.length) return fail(`续跑过滤未从序号解析出有效值：${cfg.onlyIndices.join(';')}（应为 1..${totalOutput}）`, '续跑过滤');
      indexList = Array.from(new Set(idxs)).sort((a, b) => a - b);
    } else if (cfg.onlyNames) {
      const onlyIdx = [];
      for (const nm of String(cfg.onlyNames).split(';').map((x) => x.trim()).filter(Boolean)) {
        const idx = parseOnlyNameIndex(nm);
        if (idx > 0) onlyIdx.push(idx);
      }
      if (onlyIdx.length === 0) {
        return fail(`续跑过滤未从成片名解析出序号：${cfg.onlyNames}（应为 <成片名>-<序号>.mp4）`, '续跑过滤');
      }
      indexList = Array.from(new Set(onlyIdx)).sort((a, b) => a - b);
      resumeMode = true;
    }
    // 先声明模式与范围、再报总数：否则续跑时那句「开始批量生成（共 N 个）」会被误读成要重做 N 个
    logger.info(resumeMode
      ? `🔁 续跑模式：仅重做 ${indexList.length} 个成片（序号 ${indexList.join(', ')}）—— 本批总量 ${totalOutput} 个，其余保留既有产物`
      : `开始批量生成（共 ${totalOutput} 个）`);

    const dPrefix = datePrefix(taskDate(cfg.submitTs));
    const parentFolder = path.basename(baseDir);
    // ★ 分级降级：先按用户设置跑足重试轮数，仍凑不出组合再逐级加大加速倍率；倍率设硬顶，避免画面加速过狠。
    //   红线：输出时长始终以 maxTotalDuration 封顶（平台规则，超出无法过审）—— 加大倍率只放宽「允许的组合时长」。
    //   「每档轮数」直接取设置页「重试次数」的设定值；⚠ 不要用 Math.max(100, ...) 等兜底，会把 ≤100 的设定值一律抬成 100。
    const L = ladder.createRunner({
      maxDuration: cfg.maxTotalDuration,
      speedThreshold: cfg.speedThreshold,
      maxRetry: cfg.maxRetry,
      logger,
    });
    const ladderRounds = L.rounds;

    for (const outIndex of indexList) {
      logger.info('');
      logger.info('-'.repeat(48));
      // 续跑：进度按「本次补做」视角显示（第 k / N 片），否则会显示成整批的 X / 20 与实际不符；绝对序号在命名与日志中不受影响。
      logger.progress('生成', resumeMode ? (indexList.indexOf(outIndex) + 1) : outIndex,
        resumeMode ? indexList.length : totalOutput);

      let selectedParts = null;
      let updatePlans = [];
      let foundCombination = false;
      let failReason = null;
      let totalDuration = 0;

      let firstPickVideo = null;              // 首段固定
      const retryExcluded = new Set();        // 跨轮失败记忆：键 =「位置索引|视频路径」
      let retryTargetSrc = -1;
      const staleParts = new Map();           // [srcIdx] 上轮片段（沿用基础）
      const stalePlans = new Map();
      const exhaustedSrcs = new Set();
      let retryCount = 0;

      // 某源位置的「真实剩余候选数」（本轮未用 + 未被本片排除 + 未被跨轮失败记忆排除）：用于失败分支判定「素材真用尽 / 组排除受限」与诊断报告。
      const countRemain = (i, exMap) => {
        const p = String(sourceRequests[i]);
        const fd = folderVideos.get(p);
        if (!fd) return 0;
        const tr = usageTracker.get(p);
        const used = new Set(tr ? tr.roundUsed : []);
        const ex = new Set(exMap && exMap.get(p) ? exMap.get(p) : []);
        if (i > 0) for (const k of triedPathsFor(retryExcluded, i)) ex.add(k);
        return fd.allVideos.filter((f) => !used.has(f.fullName) && !ex.has(f.fullName)).length;
      };

      // 当前生效的"允许组合时长"（随档位变化；输出上限不变，见上方红线说明）
      let ladderAllowed = L.allowedOf(0);
      for (retryCount = 0; retryCount < ladderRounds; retryCount++) {
        thrStep = L.stepOf(retryCount);
        ladderAllowed = L.allowedOf(retryCount);
        if (L.isShift(retryCount)) {
          // 换档：清掉上一档的失败记忆与耗尽标记，否则候选一直被挡、换档等于没换
          exhaustedSrcs.clear();
          retryExcluded.clear();
          L.announceShift(retryCount);
        }
        const tempParts = [];
        const tempPlans = [];
        totalDuration = 0;
        let allValid = true;
        let failSrcIdx = -1;

        const sourceExcludedSubGroups = new Map();
        const sourceExcludedPaths = new Map();
        const repeatPickCount = new Map();
        let srcIdx = 0;

        for (const srcPath of sourceRequests) {
          const track = usageTracker.get(srcPath);
          const folderData = folderVideos.get(srcPath);

          // 首段固定：重试轮复用首轮选定片段（含其 plan）
          if (retryCount > 0 && srcIdx === 0 && firstPickVideo) {
            tempParts.push(firstPickVideo.video);
            totalDuration += firstPickVideo.video.duration;
            tempPlans.push(firstPickVideo.plan);
            registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, firstPickVideo.video, firstPickVideo.plan);
            srcIdx++;
            continue;
          }

          // 渐进沿用：非目标源且上轮有选择 → 直接复用（已耗尽源也沿用，仅不再作为替换目标）
          if (retryCount > 0 && retryTargetSrc !== srcIdx && staleParts.has(srcIdx)) {
            tempParts.push(staleParts.get(srcIdx));
            totalDuration += staleParts.get(srcIdx).duration;
            tempPlans.push(stalePlans.get(srcIdx));
            registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, staleParts.get(srcIdx), stalePlans.get(srcIdx));
            srcIdx++;
            continue;
          }

          const excludedSubs = sourceExcludedSubGroups.get(srcPath) || [];
          let excludedFiles = [...(sourceExcludedPaths.get(srcPath) || [])];
          // 跨轮失败记忆：按「位置索引」隔离（配置允许同一路径重复出现）
          if (srcIdx > 0) {
            excludedFiles = excludedFiles.concat(triedPathsFor(retryExcluded, srcIdx));
          }

          const isRepeat = repeatPaths.has(srcPath);
          let pickSeq = 0;
          if (isRepeat) {
            if (!repeatPickCount.has(srcPath)) repeatPickCount.set(srcPath, 0);
            pickSeq = repeatPickCount.get(srcPath) + 1;
          }

          const preferShort = srcIdx > 0 && retryCount > 0;
          // 替换目标源只接受更短片段：该源无更短候选时换片段不会降低总时长 → 判耗尽、改试其它源
          let shorterThan = 0;
          if (preferShort && retryTargetSrc === srcIdx && staleParts.has(srcIdx)) {
            shorterThan = staleParts.get(srcIdx).duration;
          }

          const result = selectVideo({
            srcPath, track, folderData,
            excludedPaths: excludedFiles,
            excludedSubGroups: excludedSubs,
            preferShort, shorterThan, getInfo: durationOf,
          });
          if (!result) { allValid = false; failSrcIdx = srcIdx; break; }

          if (srcIdx === 0 && !firstPickVideo) firstPickVideo = result;

          tempParts.push(result.video);
          totalDuration += result.video.duration;
          tempPlans.push(result.plan);

          if (isRepeat) {
            const groupName = result.plan.selectedGroup || '(根目录)';
            logger.info(`🔁 [重复源] 第 ${pickSeq} 次选取: ${groupName}\\${result.video.name}`);
            repeatPickCount.set(srcPath, pickSeq);
          }

          registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, result.video, result.plan);
          staleParts.set(srcIdx, result.video);
          stalePlans.set(srcIdx, result.plan);
          srcIdx++;
        }

        if (!allValid) {
          if (retryCount > 0) {
            // 无沿用基础 → 该源选不出片段，替换其它源也补不齐，直接失败。
            // 文案要按**真实剩余候选**区分成因：⚠ 笼统说「无合规视频」会与素材实况矛盾，误导排查
            //（「组约束受限」与「素材用尽」是两回事）。
            if (!staleParts.has(failSrcIdx)) {
              const nm = path.basename(sourceRequests[failSrcIdx]);
              const left = countRemain(failSrcIdx, sourceExcludedPaths);
              failReason = left > 0
                ? `源「${nm}」无可用片段（本成片内子组约束无法满足：该路径出现次数多于可用子组数）`
                : `源「${nm}」无可用片段（素材已全部用尽）`;
              break;
            }
            exhaustedSrcs.add(failSrcIdx);
            retryTargetSrc = -1;
            let maxDur = -1;
            for (let pi = 1; pi < sourceRequests.length; pi++) {
              if (exhaustedSrcs.has(pi)) continue;
              // 本轮在此处中断时 tempParts 不完整 → 回退用沿用基础评估时长
              const dur = tempParts[pi] ? tempParts[pi].duration : (staleParts.has(pi) ? staleParts.get(pi).duration : 0);
              if (dur > maxDur) { maxDur = dur; retryTargetSrc = pi; }
            }
            if (retryTargetSrc < 0) {
              // 本档可替换源已全部用尽：若还有加速档位，提前进入下一档（放宽允许时长）再试，避免「每档 N 轮」跑不满。
              const nextStart = L.nextStepStart(retryCount);
              if (nextStart >= 0) {
                L.announceStepSkip();
                retryCount = nextStart - 1; continue;
              }
              failReason = '所有源的可替换片段均已用尽（首段固定不参与替换）'; break;
            }
            continue;
          }
          continue; // 首轮失败：静默进入渐进替换
        }

        // 诊断通道：记录每轮「凑出多少 / 允许多少 / 在哪档 / 是否达标」，只进内存缓冲，任务失败时随错误一并交给后端。
        logger.diag('round', { n: outIndex, r: retryCount, step: thrStep + 1,
          dur: Math.round(totalDuration * 10) / 10, allow: Math.round(ladderAllowed * 10) / 10,
          ok: totalDuration <= ladderAllowed, exhausted: exhaustedSrcs.size });
        if (totalDuration <= ladderAllowed) {
          if (totalDuration > cfg.maxTotalDuration) {
            logger.warn(`预估时长 ${totalDuration} 秒 超过设定值但未超过阈值 ${Math.round((cfg.speedThreshold - 1) * 100)}%，后续将加速处理`);
          }
          if (retryCount > 0) {
            logger.warn(`该成片经 ${retryCount} 轮渐进替换后达标（总时长 ${totalDuration} 秒）`);
          }
          selectedParts = tempParts;
          updatePlans = tempPlans;
          foundCombination = true;
          break;
        }

        // 时长超限：记录失败记忆 + 存沿用基础 + 定下一轮目标源（非首段中最长、未耗尽）
        for (let pi = 1; pi < sourceRequests.length; pi++) {
          if (pi < tempParts.length) retryExcluded.add(failKey(pi, tempParts[pi].fullName));
          if (tempParts[pi]) { staleParts.set(pi, tempParts[pi]); stalePlans.set(pi, tempPlans[pi]); }
        }
        retryTargetSrc = -1;
        let maxDur = -1;
        for (let pi = 1; pi < sourceRequests.length; pi++) {
          if (exhaustedSrcs.has(pi)) continue;
          if (tempParts[pi] && tempParts[pi].duration > maxDur) { maxDur = tempParts[pi].duration; retryTargetSrc = pi; }
        }
        if (retryTargetSrc < 0) {
          const nextStart2 = L.nextStepStart(retryCount);
          if (nextStart2 >= 0) {
            L.announceStepSkip();
            retryCount = nextStart2 - 1; continue;
          }
          failReason = `非首段源的可替换片段均已用尽，仍超出时长上限 ${cfg.maxTotalDuration} 秒`;
          break;
        }
      }

      if (!foundCombination) {
        const rounds = retryCount + 1;   // 本片累计重试轮数（跨档累加；每档上限 = 设置页「重试次数」）
        // 面向用户的文案：只说「发生了什么」，用户不需要缺口/源状态这类内部细节
        const userMsg = failReason || `重试 ${rounds} 轮仍无法找到满足时长的组合（时长上限 ${cfg.maxTotalDuration} 秒）`;
        // 面向排查的完整诊断：只进诊断通道（后端日志），不出现在任务窗口
        let diagText = userMsg;
        // 面向用户的「如何解决」：时长凑不满属于素材/配置问题，给出可操作建议而非笼统「反馈日志」
        let userHow = '';
        // ★ 可操作诊断：把「能凑出多少 / 缺口多少 / 哪些源耗尽 / 可调什么」写进错误详情，人照着提示就能动手。
        try {
          const overPct = Math.round((cfg.speedThreshold - 1) * 100);
          const isOver = totalDuration > cfg.maxTotalDuration;
          const gap = isOver ? (totalDuration - cfg.maxTotalDuration) : (cfg.maxTotalDuration - totalDuration);
          // 源状态按「真实剩余候选数」报告：⚠ 只看 exhaustedSrcs 标记会在候选被排除集挡光时仍显示「仍可用」，与报错自相矛盾。
          const remainOf = (i) => countRemain(i, sourceExcludedPaths);
          const srcStat = sourceRequests.map((p, i) => {
            const nm = path.basename(String(p));
            if (i === 0) return `首段「${nm}」固定不替换`;
            const left = remainOf(i);
            const tag = left > 0 ? `可用候选还剩 ${left} 个` : (exhaustedSrcs.has(i) ? '已耗尽' : '已无可用候选');
            return `${tag}「${nm}」`;
          }).join('；');
          const deadNames = sourceRequests.map((p, i) => i)
            .filter((i) => i > 0 && remainOf(i) === 0)
            .map((i) => path.basename(String(sourceRequests[i])));
          const hints = [];
          if (deadNames.length) hints.push(`向已无可用候选的源补充素材（${deadNames.join('、')}）`);
          hints.push(`放宽时长上限（当前 ${cfg.maxTotalDuration}s）或允许超出比例（当前 ${overPct}%）`);
          if (L.isLastStep(retryCount)) hints.push(`提高重试轮数（每档 ${Math.round(cfg.maxRetry)} 轮，${ladder.THR_STEPS.length} 档已全部用尽）`);
          diagText += ` ｜ 诊断：${isOver ? '最优组合仍超出' : '最优组合距上限还差'} ${gap.toFixed(1)}s`
            + `（可凑出 ${totalDuration.toFixed(1)}s / 上限 ${cfg.maxTotalDuration}s，允许超出 ${overPct}%，已重试 ${rounds} 轮）`
            + ` ｜ 源状态：${srcStat}`
            + ` ｜ 可尝试：${hints.map((h, k) => (k + 1) + ') ' + h).join('；')}`;
          userHow = hints.join('；');
        } catch (e3) { /* 诊断失败不影响主流程 */ }
        // 命名前的失败：输出「序号」协议行 —— 后端据此记录 failedIndices，续跑时按序号补做。
        // ⚠ 顺序很关键：**必须先记序号、再写诊断** —— 诊断一旦抛错（如引用作用域越界的变量），
        //   序号就没机会落盘 → 任务虽标为失败，续跑却报「没有找到需要完成的成片」，只能整批重做。
        logger.failIndex(outIndex, userMsg);
        try {
          logger.diag('fail', { n: outIndex, rounds: retryCount + 1, step: thrStep + 1,
            dur: Math.round(totalDuration * 10) / 10, allow: Math.round(ladderAllowed * 10) / 10,
            limit: cfg.maxTotalDuration, reason: String(failReason || '').slice(0, 200),
            detail: diagText,
            exhausted: Array.from(exhaustedSrcs).map((i) => i + 1) });
        } catch (eDiag) { /* 诊断失败绝不影响失败序号与后续流程 */ }
        // 时长凑不满不是程序 bug：归为「素材或配置」并给出可操作建议；⚠ 不传 hint 会落到默认「反馈日志」并被误归为「程序」。
        const failHint = userHow
          ? { who: '素材或配置', how: userHow }
          : { who: '程序', how: '若反复出现，请把运行日志（log 目录里的 error-日期.log）反馈以便定位' };
        logger.error(`第 ${outIndex} 个成片`, userMsg, failHint);
        hasError = true;
        continue;
      }

      const currentParts = selectedParts.map((v) => v.fullName);

      // ── 成片命名 ──
      const nameItems = [dPrefix, cfg.producerName];
      // 多前缀：全部命中（TXT 名剥离命中 或 任一素材路径包含）的前缀按设置顺序全部写入，`-` 分隔
      const hitPrefixes = [];
      const partsLow = selectedParts.map((v) => String(v.fullName).toLowerCase());
      const checkHit = (p) => {
        if (p && partsLow.some((f) => f.includes(String(p).toLowerCase()))) return true;
        return false;
      };
      for (const p of cfg.txtNamePrefix) {
        if (p === txtNamePrefixPart || checkHit(p)) hitPrefixes.push(p);
      }
      if (txtNamePrefixPart && !hitPrefixes.includes(txtNamePrefixPart)) hitPrefixes.unshift(txtNamePrefixPart);
      for (const p of hitPrefixes) nameItems.push(String(p).replace(/-+$/, ''));
      nameItems.push(parentFolder);
      nameItems.push(txtNameSuffix.replace(/^-+/, ''));
      // 后缀：单值字符串（多值已回滚），兼容数组形态；为空则不加内容
      const mk = cfg.suffixMark;
      const suffixStr = (Array.isArray(mk) ? mk.join('-') : String(mk == null ? '' : mk)).trim();
      // 序号前的 `-` 分隔必须保留 —— 续跑要按 `-<序号>` 反解成片名（parseOnlyNameIndex）；
      // 整串再合并连续 `--`，消除 txtNameSuffix 为空时出现的 `--序号`
      let finalOutName = `${nameItems.join('-')}-${suffixStr}${outIndex}.mp4`.replace(/-{2,}/g, '-');
      let finalOut = path.join(outDir, finalOutName);
      // ★ 先写临时名，编码成功后再原子改名：
      //   ⚠ 不要直接写正式名：编码到一半意外停止（进程被杀 / 断电 / 编码器崩溃）会留下**正式名的半截文件** ——
      //   ① 用户会把它当成品拿走，但根本放不出来；② 续跑反推「还缺哪些序号」时会算作已完成 → 该序号被永久跳过。
      //   用临时名后：**正式名 ⇔ 完整可播放产物**；临时名 = `<随机>.tmp`（tempNameFor 统一生成），
      //   ffmpeg 无法从 `.tmp` 推断容器，故 encArgs 显式 `-f mp4` 强制 mp4 封装。
      const tmpOut = tempNameFor(finalOut);

      // ── 输入文件存在性 ──
      let allExist = true;
      for (const p of currentParts) {
        if (!exists(p)) { logger.info(`⚠️  文件不存在：${p}`); allExist = false; }
      }
      if (!allExist) {
        logger.error(`第 ${outIndex} 个成片-文件检查`, '部分输入文件不存在');
        logger.fail(finalOutName, '部分输入文件不存在');
        hasError = true;
        continue;
      }

      // ── 加速判定（共用底座唯一实现：按达标档位给出倍率；retryCount 即达标轮次） ──
      const fin = L.finalize(totalDuration, retryCount);
      const needSpeed = fin.needSpeed;
      const speedRatio = fin.speedRatio;

      const n = currentParts.length;
      if (n === 0) {
        logger.error(`第 ${outIndex} 个成片-片段数检查`, '无有效视频片段');
        logger.fail(finalOutName, '无有效视频片段');
        hasError = true;
        continue;
      }

      // ── 拼接参数 ──
      const inputArgs = [];
      for (const p of currentParts) { inputArgs.push('-i', p); }
      inputArgs.push('-i', watermark);

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
        // 编码参数统一走底座：nvencArgs 给视频段（含 profile/level），aacTail 给音轨+容器。
        // ⚠ 不要在此手写编码参数 —— 音频尾巴与 faststart 必须跟底座走，
        //   否则同一款 mp4 在不同模块的头部结构不同（无 faststart 不能边下边播）。
        ...nvencArgs(null, 'h264'),
        ...aacTail('mp4'),
        '-y', tmpOut,
      ];
      const targetDur = totalDuration > cfg.maxTotalDuration ? cfg.maxTotalDuration : totalDuration;
      logger.clipDuration(targetDur);
      const { code, stderr } = await runFfmpeg(inputArgs.concat(encArgs), { onProgress: (line) => logger.raw(line) });
      if (code !== 0) {
        // ffmpeg 的真实报错要带出来，不能只留「编码失败」：退出码与 stderr 尾部一并带出，结论进用户视图、完整尾部进诊断通道。
        const ffTail = logger.ffmpegTail(stderr);
        logger.diag('ffmpeg.fail', { step: 'batch.encode', n: outIndex, code, tail: ffTail });
        logger.error(`第 ${outIndex} 个成片`, '一次性编码失败');
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) { /* 清掉半截临时产物 */ }
        logger.fail(finalOutName, 'ffmpeg 编码失败（退出码 ' + code + '）');
        hasError = true;
        continue;
      }
      // ★ 编码成功 → 原子改名到正式名；改名前不得有任何"正式名"产物出现
      // 带重试：Windows 上杀软 / 索引服务会瞬时占用刚写完的大文件，单次失败即把成片误判为失败
      //（合成完成后要确保改名能完成，不被其他软件影响）
      const rnErr = await renameWithRetry(tmpOut, finalOut);
      if (rnErr) {
        logger.error(`第 ${outIndex} 个成片`, '产物改名失败：' + ((rnErr && rnErr.message) || rnErr));
        // ⚠ 保留临时产物：改名失败多为瞬时占用，删掉等于白编码一次；残留会被续跑的临时产物清理回收
        logger.fail(finalOutName, '产物改名失败');
        hasError = true;
        continue;
      }

      // ── 状态更新 ──
      const planGroups = new Map();
      for (const plan of updatePlans) {
        if (!planGroups.has(plan.folder)) planGroups.set(plan.folder, []);
        planGroups.get(plan.folder).push(plan);
      }
      for (const [f, plans] of planGroups.entries()) {
        const track = usageTracker.get(f);
        const folderData = folderVideos.get(f);
        let maxRound = track.round;
        let maxSubRound = folderData.subRound;
        const mergedRoundUsed = [...track.roundUsed];
        const mergedSubUsed = [...folderData.subUsedInRound];
        const subUsageIncrements = new Map();
        for (const plan of plans) {
          if (plan.newRound > maxRound) maxRound = plan.newRound;
          if (plan.newSubRound > maxSubRound) maxSubRound = plan.newSubRound;
          for (const p of plan.newRoundUsed) if (!mergedRoundUsed.includes(p)) mergedRoundUsed.push(p);
          for (const g of plan.newSubUsedInRound) if (!mergedSubUsed.includes(g)) mergedSubUsed.push(g);
          if (plan.incrementSubUsage) {
            subUsageIncrements.set(plan.incrementSubUsage, (subUsageIncrements.get(plan.incrementSubUsage) || 0) + 1);
          }
        }
        track.round = maxRound;
        track.roundUsed = mergedRoundUsed;
        folderData.subRound = maxSubRound;
        folderData.subUsedInRound = mergedSubUsed;
        for (const [g, inc] of subUsageIncrements.entries()) {
          folderData.subUsageCount.set(g, (folderData.subUsageCount.get(g) || 0) + inc);
        }
      }
      for (let i = 0; i < selectedParts.length; i++) {
        const video = selectedParts[i];
        const plan = updatePlans[i];
        const track = usageTracker.get(plan.folder);
        track.usedCount.set(video.fullName, (track.usedCount.get(video.fullName) || 0) + 1);
        if (!track.roundUsed.includes(video.fullName)) track.roundUsed.push(video.fullName);
      }

      // 计数增量：随出片即时累加进缓存库（唯一持久层）
      const increments = new Map();
      for (const video of selectedParts) increments.set(video.fullName, (increments.get(video.fullName) || 0) + 1);
      for (const [p, inc] of increments.entries()) {
        try { videoStore.addVideoUsage(p, inc); } catch (e) { /* 计数写库失败不影响出片 */ }
      }

      // ── 最终时长 + 完成行 ──
      const finalInfo = await probe(finalOut);
      const finalDuration = finalInfo.duration || 0;
      logger.clipDoneBatch(finalDuration, needSpeed ? speedRatio : 1);

      // ── 即时分组重命名 ──
      if (groupCount > 0 && totalOutput > 1) {
        const gs = groupSuffixFor(outIndex, totalOutput, groupCount);
        if (gs && exists(finalOut)) {
          const base = path.basename(finalOut, path.extname(finalOut));
          const ext = path.extname(finalOut);
          const renamed = path.join(outDir, base + gs + ext);
          if (!exists(renamed)) {
            try { fs.renameSync(finalOut, renamed); finalOut = renamed; } catch (e) { /* 静默 */ }
          }
        }
      }

      // ── 写拼接日志 ──
      const logLines = [path.basename(finalOut), '使用片段列表：', ...currentParts, '', watermark];
      if (outIndex < totalOutput) logLines.push('='.repeat(46));
      fs.appendFileSync(logFilePath, logLines.join('\r\n') + '\r\n', 'utf8');
    }

    logger.info('');
    logger.info('================================================');
  } finally {
    // video_cache 写回：把本次现场探测到的条目合并进缓存库（只增/更新，不删；GC 仍归 backend）。
    // 目的：让执行期新扫描到的素材沉淀下来，供预检测复用，避免每次重探。
    // 写失败不影响任务结果，保持静默（不额外输出）。
    if (probedForWriteBack.size > 0 && videoStore) {
      try {
        // 只写本次新探测的条目（增量事务），无需读全量再整份重写
        const rows = {};
        for (const [p, v] of probedForWriteBack) {
          rows[p] = { LastWriteTime: String(v.LastWriteTime), Duration: v.Duration, Valid: v.Valid, Width: v.Width, Height: v.Height, FileSize: v.FileSize };
        }
        videoStore.applyVideoDelta(rows, null);
      } catch (e) { /* 忽略：缓存写回失败不应影响成片产出 */ }
    }
    if (videoStore) { try { videoStore.close(); } catch (e) { /* 忽略 */ } }
    if (lock) { try { lock.release(); } catch (e) { /* 忽略 */ } }
    logger.lockReleased();
  }

  if (hasError) {
    logger.info('');
    logger.info('任务完成（有错误）');
    return 1;
  }
  logger.info('');
  logger.info('任务全部完成');
  return 0;
}

module.exports = {
  id: 'batch',
  title: '批量拼接',
  envVars: ['BATCH_*', 'VL_CACHE_DB'],
  run,
  // 供测试复用
  _internals: {
    readEnv, taskDate, timeTag, datePrefix, ticksOf,
    parseLnkTarget, resolveBrokenTarget, collectVideoFiles, isExcluded,
    findIndexInTree, findIndexFile, folderSuffix, loadBatchIndex,
    resolveFolderFromIndex, resolveFolderBySuffix,
    selectVideo, selectVideoCandidate, registerPickedClip, groupSuffixFor,
    openVideoStore, parseOnlyNameIndex,
  },
};
