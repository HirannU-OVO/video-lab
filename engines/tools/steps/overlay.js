// 步骤 · 叠加图片
//
// 把 PNG 作为**额外输入**，用 `[outv]overlay=0:0[wateredv]` 贴在画面左上角（无需用 txt 选片）。
// ★ 分辨率双向对齐（默认开启）：先把图片 `scale=<视频宽>:<视频高>` 缩放对齐，避免只盖住一角或被裁掉。
// ★ 透明通道保留：缩放链显式 `format=rgba`，不透明度用 `colorchannelmixer=aa=<alpha>`。
// ★ 单张图片作为输入即可：overlay 默认 repeatlast=1 会持续贴上，不需要 `-loop 1`（后者引入无界帧流，还要配 -shortest）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

module.exports = {
  id: 'overlay',
  title: '叠加图片',
  group: '画面',
  danger: '',
  schema: [
    { key: 'image', label: '图片路径', type: 'file', default: '', fileTypes: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
      hint: '要盖在画面上的图片（开启对齐时任意尺寸都行）' },
    { key: 'x', label: '横向位置', type: 'number', default: 0,
      hint: '横向位置，0 = 最左' },
    { key: 'y', label: '纵向位置', type: 'number', default: 0,
      hint: '纵向位置，0 = 最顶' },
    { key: 'alpha', label: '不透明度', type: 'number', default: 1, min: 0, max: 1, step: 0.05,
      hint: '越小越透明（0~1，默认 1）' },
    { key: 'align', label: '双向对齐', type: 'bool', default: true,
      hint: '先把图片缩放到与视频同宽高再叠（关 = 按图片原尺寸贴）' },
  ],

  decide(info, params) {
    const p = String(params.image || '').trim();
    if (!p) return { skip: true, reason: '未选择图片，跳过' };
    if (!fs.existsSync(p)) return { skip: true, reason: '图片不存在：' + p };
    const ext = path.extname(p).toLowerCase();
    if (!IMG_EXTS.has(ext)) return { skip: true, reason: '不支持的图片格式：' + ext };
    const alpha = Math.max(0, Math.min(1, num(params.alpha, 1)));
    const align = params.align !== false;      // 默认开启双向对齐
    const W = Number(info.width) || 0;
    const H = Number(info.height) || 0;
    if (align && !(W > 0 && H > 0)) return { skip: true, reason: '无法读取视频分辨率，无法对齐，跳过' };
    return {
      image: p,
      x: Math.round(num(params.x, 0)),
      y: Math.round(num(params.y, 0)),
      alpha,
      align,
      alignTo: align ? [W, H] : null,
      note: '叠加 ' + path.basename(p) + ' 于 ' + Math.round(num(params.x, 0)) + ':' + Math.round(num(params.y, 0))
        + (align ? ('（已对齐到 ' + W + '×' + H + '）') : '（按图片原尺寸）')
        + (alpha < 1 ? ('，不透明度 ' + alpha) : ''),
    };
  },

  /** 需要额外输入 + 消费视频尾流，因此走 chain 的 afterVideo 通道 */
  filter(d, info, chain) {
    if (!chain) return { video: [], audio: [], note: '缺少滤镜链上下文，跳过叠加' };
    const idx = chain.addInput(d.image);
    const pos = d.x + ':' + d.y;
    const alpha = Number(d.alpha);
    chain.afterVideo((tail, out) => {
      var wm = 'wm' + idx;
      var pre = '';
      if (d.align && Array.isArray(d.alignTo)) {
        // 双向对齐：宽高都缩放到视频尺寸；format=rgba 保住透明通道
        pre = 'scale=' + d.alignTo[0] + ':' + d.alignTo[1] + ',format=rgba';
        if (alpha >= 0 && alpha < 0.999) pre += ',colorchannelmixer=aa=' + alpha;
        return '[' + idx + ':v]' + pre + '[' + wm + '];[' + tail + '][' + wm + ']overlay=' + pos + '[' + out + ']';
      }
      if (alpha >= 0 && alpha < 0.999) {
        return '[' + idx + ':v]format=rgba,colorchannelmixer=aa=' + alpha + '[wm];'
          + '[' + tail + '][wm]overlay=' + pos + '[' + out + ']';
      }
      return '[' + tail + '][' + idx + ':v]overlay=' + pos + '[' + out + ']';
    });
    return { video: [], audio: [] };
  },
};
