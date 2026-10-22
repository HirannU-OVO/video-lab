// 时间轴区间代数：把各步骤的时间裁剪归约成「最终保留区间集」
//
// 核心约束：所有步骤的区间一律以【原时间轴】为准 —— 每个步骤只声明「保留什么 / 删除什么」，
// 由本模块统一归约为一个 keep-set，消除「参考系漂移」与「交/并语义不明」。
// 音画同步：同一个 keep-set **同时**产出视频与音频两条表达式（同一条件串），否则删帧/去黑屏后音画会漂移。
'use strict';

const EPS = 1e-6;

function isNum(v) { return typeof v === 'number' && isFinite(v); }

/** 归一化：剔除非法与空区间 → 按起点升序 → 合并重叠或相接的区间 */
function normalize(ranges) {
  const list = [];
  for (const r of (Array.isArray(ranges) ? ranges : [])) {
    if (!r) continue;
    const s = Number(r[0]);
    const e = Number(r[1]);
    if (!isNum(s) || !isNum(e)) continue;
    if (e - s <= EPS) continue;                 // 空区间丢弃
    list.push([Math.min(s, e), Math.max(s, e)]);
  }
  list.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + EPS) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** 交集 */
function intersect(a, b) {
  const A = normalize(a), B = normalize(b);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i][0], B[j][0]);
    const e = Math.min(A[i][1], B[j][1]);
    if (e - s > EPS) out.push([s, e]);
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  return out;
}

/** 差集：base 减去 cuts（本模块的核心操作） */
function subtract(base, cuts) {
  let out = normalize(base);
  for (const [cs, ce] of normalize(cuts)) {
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s + EPS || cs >= e - EPS) { next.push([s, e]); continue; }  // 无交叠
      if (cs > s + EPS) next.push([s, Math.min(cs, e)]);                    // 左残留
      if (ce < e - EPS) next.push([Math.max(ce, s), e]);                    // 右残留
    }
    out = next;
  }
  return normalize(out);
}

/** 区间总长度 */
function totalLength(ranges) {
  return normalize(ranges).reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** 是否已覆盖全片（用于判断「本步无需裁剪」，避免无意义处理） */
function coversAll(ranges, duration) {
  const n = normalize(ranges);
  if (!n.length) return false;
  return n.length === 1 && n[0][0] <= EPS && n[0][1] >= Number(duration) - EPS;
}

/**
 * 构造「保留」条件表达式 —— 视频与音频**共用同一串**，这是音画同步的保证。
 * @param {Array} ranges 保留区间集
 * @returns {string} 如 `between(t,0,3.33)+between(t,6.67,90)`
 */
function keepExpr(ranges) {
  const n = normalize(ranges);
  if (!n.length) return '0';
  return n.map(([s, e]) => `between(t,${fmt(s)},${fmt(e)})`).join('+');
}

/** 视频侧滤镜：select + setpts（时间戳重排，与批量删除帧脚本同款写法的推广） */
function videoFilter(ranges) {
  return `select='${keepExpr(ranges)}',setpts=N/FRAME_RATE/TB`;
}

/** 音频侧滤镜：aselect + asetpts —— 条件串与视频完全一致 */
function audioFilter(ranges) {
  return `aselect='${keepExpr(ranges)}',asetpts=N/SR/TB`;
}

/** 是否等价于「不裁剪」 */
function isNoop(ranges, duration) {
  return coversAll(ranges, duration);
}

function fmt(n) {
  // 保留足够精度又避免 0.30000000000000004 之类的噪声
  const s = Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** 把「帧号区间」换算成秒（帧号从 0 开始，与 ffmpeg 的 n 一致） */
function framesToSeconds(ranges, fps) {
  const f = Number(fps);
  if (!isNum(f) || f <= 0) return [];
  return (Array.isArray(ranges) ? ranges : []).map(([s, e]) => [Number(s) / f, (Number(e) + 1) / f]);
}

/** 把「秒区间」换算成帧号区间（闭区间，含末帧） */
function secondsToFrames(ranges, fps) {
  const f = Number(fps);
  if (!isNum(f) || f <= 0) return [];
  return (Array.isArray(ranges) ? ranges : []).map(([s, e]) => [Math.round(Number(s) * f), Math.max(0, Math.round(Number(e) * f) - 1)]);
}

module.exports = {
  normalize, intersect, subtract, totalLength, coversAll,
  keepExpr, videoFilter, audioFilter, isNoop,
  framesToSeconds, secondsToFrames,
};
