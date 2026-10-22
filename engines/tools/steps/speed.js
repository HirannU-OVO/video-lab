// 步骤 · 变速（时长控制）
//
// probe 时长 → 超目标则算倍率（不超过上限）→ `-filter_complex "[0:v]setpts=(1/ratio)*PTS,format=yuv420p[v];[0:a]atempo=ratio[a]"`。
// 两个关键点：① **atempo 单段上限 2.0**，倍率超过 2 必须分段串联；
//   ② **源视频已短于目标 → 跳过**（只有超时长才加速），不做无意义的重编码。
'use strict';

/** atempo 分段：把任意倍率拆成若干 ≤2.0 的段（atempo 单段上限 2.0） */
function atempoChain(ratio) {
  const out = [];
  let r = Number(ratio);
  let guard = 0;
  while (r > 2 + 1e-9 && guard++ < 20) { out.push('atempo=2.0'); r /= 2; }
  out.push('atempo=' + Number(r.toFixed(6)));
  return out;
}

module.exports = {
  id: 'speed',
  title: '变速（时长控制）',
  group: '时长',
  danger: 'lossy',
  schema: [
    { key: 'targetSec', label: '目标时长(秒)', type: 'number', default: 180, min: 1,
      hint: '原片超过这个秒数就加速压到它（默认 180）' },
    { key: 'maxRatio', label: '最大加速倍率', type: 'number', default: 1.25, min: 1, step: 0.05,
      hint: '最快加到几倍，防止画质太差（默认 1.25）' },
  ],

  decide(info, params) {
    const target = Number(params.targetSec == null ? 180 : params.targetSec);
    const maxR = Number(params.maxRatio == null ? 1.25 : params.maxRatio);
    const dur = Number((info && info.duration) || 0);
    if (!dur || !target || dur <= target) {
      return { skip: true, reason: '源视频 ' + dur.toFixed(2) + 's 未超目标 ' + target + 's，跳过（不重编码）' };
    }
    const ratio = Math.min(dur / target, maxR > 1 ? maxR : 1.25);
    if (ratio <= 1.0001) return { skip: true, reason: '倍率≈1，无需加速' };
    return { ratio, note: '目标 ' + target + 's，倍率 ' + ratio.toFixed(4) };
  },

  filter(decision) {
    if (!decision || decision.skip) return { video: [], audio: [] };
    const r = Number(decision.ratio);
    return {
      video: ['setpts=PTS/' + r],
      // 音频侧：无音轨时由 pipeline 决定是否拼接（vf 链在无音轨时不产出音频段）
      audio: atempoChain(r),
    };
  },

  _internals: { atempoChain },
};
