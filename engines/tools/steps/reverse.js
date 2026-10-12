// 步骤 · 倒放
//
// 原脚本做法（既有工具口径）：
//   核心是 `-vf reverse -af areverse`（其余是"倒放 + 拼接 + 章节标记"的特殊业务组合，
//   不属于本工具范围 —— 本工具只纳入「倒放」这一项能力）。
//
// ★ 位次固定：倒放必须排在所有时间裁剪之后——
//   先倒放再裁剪的话，裁剪区间就变成"倒序时间轴"上的区间，会整体错位。
//   注册表的固定次序已经保证了这一点。
//
// ★ 内存代价：reverse 会把**整段视频解码帧全部驻留内存**，长视频/高分辨率下开销很大，
//   因此本步给出注记提示（不做静默处理）。
'use strict';

module.exports = {
  id: 'reverse',
  title: '倒放',
  group: '内容',
  danger: '',
  schema: [
    { key: 'both', label: '同时倒放音频', type: 'bool', default: true,
      hint: '关闭后只倒画面，声音照常（一般开着）' },
  ],

  decide(info, params) {
    const both = params.both !== false;
    const sec = Number(info.duration) || 0;
    const note = '整段倒放' + (both ? '（含音频）' : '（仅画面）')
      + (sec >= 60 ? '；★ 该片 ' + sec.toFixed(0) + 's，倒放需整段驻留内存，耗时与内存占用较高' : '');
    return { both, note };
  },

  filter(d, info) {
    const video = ['reverse'];
    const audio = (d.both !== false && info.hasAudio) ? ['areverse'] : [];
    return { video, audio };
  },
};
