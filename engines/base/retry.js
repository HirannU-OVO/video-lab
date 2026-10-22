// 重试基座：统一 batch/replica 的渐进替换重试（首段固定 / 只接受更短 / 并列随机 / 失败记忆 / 耗尽源沿用）
'use strict';

// 与 P0 基线对齐的关键行为：
// 1. 首段固定：首个位置选定后重试轮不变
// 2. 替换只接受严格更短候选（ShorterThan），等长不做无效替换
// 3. PreferShort 并列时长随机（不许 Sort 确定性锁定单文件）
// 4. 失败记忆：batch 按「位置索引|路径」、replica 按「原路径|替换路径」
// 5. 耗尽源沿用上轮；无沿用基础 → 快速失败

/** 失败记忆键（batch 语义：位置索引 + 视频路径，配置允许同一路径重复出现，必须各位置各记各的） */
function failKey(index, videoPath) {
  return String(index) + '|' + String(videoPath);
}

/** 取该位置已试过的视频路径集合（键的前缀为「索引|」） */
function triedPathsFor(memory, index) {
  const prefix = String(index) + '|';
  const out = [];
  for (const key of memory) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

/** 随机取一个元素（空数组返回 null） */
function pickRandom(arr, rng = Math.random) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/**
 * 候选选择（对齐 PS 的 Select-VideoCandidate）：
 * 1) 过滤掉已在本轮使用 / 已排除的候选；可选「只保留时长严格更短者」
 * 2) 取使用次数最少的一批（minCount；次数缺失记 0）
 * 3) PreferShort 时按时长取最短的一批后随机；否则直接随机
 * 返回 null 表示无候选（调用方据此判定该源耗尽 / 走忽略 RoundUsed 重选分支）
 */
function pickCandidate(candidates, { usedCount, preferShort = false, shorterThan = 0, durationOf, rng = Math.random } = {}) {
  let pool = candidates;
  if (shorterThan > 0) {
    pool = pool.filter((f) => durationOf(f) < shorterThan);
  }
  if (pool.length === 0) return null;

  let minCount = Infinity;
  for (const f of pool) {
    const c = usedCount ? usedCount(f) : 0;
    const n = c == null ? 0 : c;
    if (n < minCount) minCount = n;
  }
  const minFiles = pool.filter((f) => {
    const c = usedCount ? usedCount(f) : 0;
    return (c == null ? 0 : c) === minCount;
  });
  if (minFiles.length === 0) return null;

  if (preferShort) {
    let shortest = Infinity;
    const durs = new Map();
    for (const f of minFiles) {
      const d = durationOf(f);
      durs.set(f, d);
      if (d < shortest) shortest = d;
    }
    // 时长并列时随机取（排序对相同键的输出是确定的，直接取首个会长期锁定同一文件）
    const tied = minFiles.filter((f) => durs.get(f) <= shortest);
    return pickRandom(tied, rng);
  }
  return pickRandom(minFiles, rng);
}

class RetryLoop {
  constructor({ maxAttempts = 45, firstFixed = true } = {}) {
    this.maxAttempts = maxAttempts;
    this.firstFixed = firstFixed;
    this._attempt = 0;
    this._failureMemory = new Set(); // 键由调用方构造（位置索引|路径 or 原路径|替换路径）
    this._exhausted = new Set();     // 已无可替换候选的源标识
  }

  get attempt() { return this._attempt; }
  get exhausted() { return this._exhausted; }
  get failureMemory() { return this._failureMemory; }

  markFailed(key) { this._failureMemory.add(key); }
  isTried(key) { return this._failureMemory.has(key); }
  markExhausted(key) { this._exhausted.add(key); }
  isExhausted(key) { return this._exhausted.has(key); }
  triedPaths(index) { return triedPathsFor(this._failureMemory, index); }

  next() { return this._attempt++ < this.maxAttempts; }

  // 选择第 idx 个位置的候选：首个位置锁定（firstFixed），后续位置按规则过滤
  pick(select, { idx, isFirstPlace, previous = null, candidates, shorterThan = null, randomizeTie = true } = {}) {
    if (isFirstPlace && this.firstFixed && previous) return previous;
    return select({ candidates, shorterThan, randomizeTie, tried: this._failureMemory, exhausted: this._exhausted });
  }
}

module.exports = { RetryLoop, pickCandidate, pickRandom, failKey, triedPathsFor };
