// 步骤 · 旋转 / 镜像：transpose / hflip / vflip。
// ★ 旋转 90/270 会交换宽高 —— 若同时勾了「转分辨率」，两者先后会影响结果（位次上 resize 在前、rotate 在后，见注册表）。
'use strict';

const MODES = {
  '顺时针90°': ['transpose=1'],
  '逆时针90°': ['transpose=2'],
  '旋转180°': ['hflip', 'vflip'],
  '水平镜像': ['hflip'],
  '垂直镜像': ['vflip'],
};

module.exports = {
  id: 'rotate',
  title: '旋转/镜像',
  group: '画面',
  danger: '',
  schema: [
    { key: 'mode', label: '方式', type: 'select', default: '顺时针90°',
      options: Object.keys(MODES),
      hint: '转 90° 时画面宽高会对调' },
  ],

  decide(info, params, analysis) {
    const mode = String(params.mode || '顺时针90°');
    if (!MODES[mode]) return { skip: true, reason: '未识别的旋转方式，跳过' };
    const swap = mode === '顺时针90°' || mode === '逆时针90°';
    return {
      mode,
      note: mode + (swap ? '（宽高互换：' + info.width + '×' + info.height + ' → ' + info.height + '×' + info.width + '）' : ''),
    };
  },

  filter(d) {
    const f = MODES[String(d.mode)] || [];
    return { video: f.slice(), audio: [] };
  },
};
