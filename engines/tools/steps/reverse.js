// 步骤 · 倒放
//
// 核心是 `-vf reverse -af areverse`（其余是"倒放 + 拼接 + 章节标记"的特殊业务组合，不属于本工具范围）。
// ★ 位次固定：倒放必须排在所有时间裁剪之后 —— 先倒放再裁剪会让裁剪区间错位（注册表固定次序已保证）。
// ★ 内存代价：reverse 会把整段视频解码帧全部驻留内存，长视频 / 高分辨率下开销很大，因此给出注记提示。
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
