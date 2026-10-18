// 步骤 · 转分辨率
//
// ★ 比例与联动是**前端交互**（常用比例下拉 + 宽/高联动 + 锁链按钮）；引擎只收最终 width/height，输出 scale=W:H ——
//   源画面比例与目标不同时画面会拉伸适配。
//   防呆只在**真不合理**时触发：比例差异 > 2% 才警告（微调尺寸如 1080×1916 → 1080×1920 直接放行）。
'use strict';

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

module.exports = {
  id: 'resize',
  title: '转分辨率',
  group: '画面',
  danger: '',
  schema: [
    { key: 'ratio', label: '画面比例', type: 'select', default: '9:16',
      options: ['9:16', '16:9', '4:3', '3:4', '1:1', '自定义'],
      hint: '选比例后宽高自动匹配；「自定义」自由填' },
    { key: 'width', label: '宽', type: 'number', default: 1080, min: 16, step: 2,
      hint: '画面宽度（像素）' },
    { key: 'height', label: '高', type: 'number', default: 1920, min: 16, step: 2,
      hint: '画面高度（像素）' },
  ],

  decide(info, params) {
    const W = Math.round(num(params.width, 0));
    const H = Math.round(num(params.height, 0));
    const sw = Number(info.width) || 0;
    const sh = Number(info.height) || 0;
    if (!(W > 0) || !(H > 0)) return { skip: true, reason: '目标宽高无效，跳过' };
    if (!sw || !sh) return { skip: true, reason: '无法读取源分辨率，跳过' };
    if (sw === W && sh === H) return { skip: true, note: '已是目标尺寸 ' + W + '×' + H };
    // 比例差异 > 2% 才算「变形」（微调尺寸如 1916→1920 差 0.2%，直接放行）
    const srcRatio = sw / sh;
    const dstRatio = W / H;
    const deform = Math.abs(srcRatio - dstRatio) > srcRatio * 0.02;
    return {
      expr: 'scale=' + W + ':' + H,
      note: '缩放至 ' + W + '×' + H
        + (deform ? '（★ 目标比例与源画面不同，画面将拉伸变形）' : '（与源画面同比例，正常缩放）'),
    };
  },

  filter(d) {
    if (!d || d.skip || !d.expr) return { video: [], audio: [] };
    return { video: [d.expr], audio: [] };
  },
};
