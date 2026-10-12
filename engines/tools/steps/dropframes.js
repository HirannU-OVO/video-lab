// 步骤 · 删除帧区间
//
// 原脚本做法（既有工具口径）：
//   输入「起始帧 / 结束帧」（**从 1 开始计数，含首尾**），删除该区间所有帧，
//   并同步删除对应时间段的音频（保证音画同步）。编码 h264_nvenc cq 25。
//
// ★ 帧号语义换算：
//   · 脚本帧号从 1 起，ffmpeg 的 `n` 从 0 起 → 内部换算时减 1
//   · 删帧区间按帧号给出，但**内部一律折算成原时间轴秒数**（ranges 统一归约）
//   · VFR 源上帧号不可靠，命中时给出明确警告
'use strict';

const ranges = require('../ranges');

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

module.exports = {
  id: 'dropframes',
  title: '删除帧区间',
  group: '内容',
  danger: 'lossy',
  schema: [
    { key: 'startFrame', label: '起始帧号', type: 'number', default: 1, min: 1,
      hint: '从第几帧开始删（开头是第 1 帧）' },
    { key: 'endFrame', label: '结束帧号', type: 'number', default: 1, min: 1,
      hint: '删到第几帧（含）' },
  ],

  decide(info, params) {
    const fps = Number(info.fps) > 0 ? Number(info.fps) : (Number(info.avgFps) > 0 ? Number(info.avgFps) : 0);
    if (!(fps > 0)) return { skip: true, reason: '无法读取帧率，跳过' };
    const s1 = Math.round(num(params.startFrame, 0));
    const e1 = Math.round(num(params.endFrame, 0));
    if (s1 < 1 || e1 < 1) return { skip: true, reason: '帧号须从 1 开始，跳过' };
    if (e1 < s1) return { skip: true, reason: '结束帧号小于起始帧号，跳过' };

    // 1 基闭区间 [s1, e1] → 0 基闭区间 [s1-1, e1-1] → 秒
    const secs = ranges.framesToSeconds([[s1 - 1, e1 - 1]], fps);
    if (!secs.length) return { skip: true, reason: '帧号换算失败，跳过' };
    const total = ranges.totalLength(secs);
    if (!(total > 0)) return { skip: true, reason: '待删区间为空，跳过' };

    const notes = ['删除第 ' + s1 + ' ~ ' + e1 + ' 帧（' + secs[0][0].toFixed(3) + 's ~ ' + secs[0][1].toFixed(3)
      + 's，共 ' + Math.round(e1 - s1 + 1) + ' 帧）'];
    if (info.isVfr) notes.push('源为可变帧率，帧号定位可能不准（建议改用「截取时间段」按秒处理）');

    return { cuts: secs, note: notes.join('；') };
  },

  filter() { return { video: [], audio: [] }; },
};
