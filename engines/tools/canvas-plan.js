// 画布合成（竖转横）· 参数模型与滤镜链构造   ← 「方案构造」这一半；「引擎侧执行」那一半见 canvas-run.js
//
// 分工与引用关系：
//   · 本文件（canvas-plan.js）：**纯逻辑**，两端共用 ——
//       - Electron 主进程：backend.js 的 _canvasModule() → buildCanvasPlan()（单帧预览渲染）
//       - 引擎子进程：canvas-run.js（批量执行）
//   · canvas-run.js：只在引擎里跑（探测 / 编码 / 落盘 / 备份），由 module.js 调用。
//   · 之所以分两个文件：主进程为做预览**不该**被拉进探测/编码/落盘这些执行侧依赖；
//     而「预览与批量执行共用同一份表达式」是所见即所得的结构保证 —— 两者职责不同，不可合并。
//
// 设计约束：
//   · 纯逻辑：无 IO、无子进程、不依赖 Electron —— 主进程（预览渲染）与引擎子进程（批量执行）共用
//   · 单一真相：预览与正式处理都走 buildCanvasPlan()，参数一致则表达式一致（预览所见即所得由结构保证）
//   · 滤镜一律 CPU：本模块不提供任何硬件滤镜入口
//   · 内容缩放默认**等比**；拉伸为显式开关，开启时写 warnings，由前端提示画面会变形
//
// 用法：
//   const plan = buildCanvasPlan(params, src);
//   // plan.ffmpegInputs → 依次拼 -i（各输入自带前置参数，如 -loop 1 / -stream_loop -1）
//   // plan.filterComplex → -filter_complex
//   // plan.maps → { composed, bg, raw } 三个输出映射（预览取三张 PNG；正式处理只用 composed）

'use strict';

/** 参数默认值 */
const DEFAULTS = {
  bgMode: 'dir',          // dir=背景目录随机 | image | video | color=纯色
  bgDir: '',              // 背景目录（bgMode=dir 时用于枚举候选）
  bgPath: '',             // 背景文件（bgMode=image|video 时直接指定）
  bgColor: '#000000',     // 纯色背景（bgMode=color）
  watermark: '',          // 水印 PNG，可留空
  targetW: 1920,          // 成片画布宽（输出分辨率）
  targetH: 1080,          // 成片画布高（输出分辨率）
  scale: 0.74,            // 内容等比缩放系数（决定视频在画布中的大小）
  bgFit: 'cover',         // 背景适合方式（与 Windows 桌面背景同名）：cover=填充 | contain=适应 | stretch=拉伸
  posMode: 'center',      // center | tl | tr | bl | br | custom
  dx: 0,                  // 相对基准的水平偏移（像素；custom 时为绝对 X）
  dy: 160,                // 相对基准的垂直偏移（像素；custom 时为绝对 Y）
  radius: 0,              // 内容圆角半径（像素，0=直角）
  borderW: 0,             // 内容边框宽度（像素，0=无边框）
  borderColor: '#ffffff', // 边框颜色
  bgBlur: 0,              // 背景高斯模糊 sigma（0=不模糊）
  // 批量：勾选后，每个背景各出一条成片（内容 × 背景，在一个任务内逐条编码）。
  // 语义放在这里而不是只在界面：引擎要按它决定「每个内容配一个随机背景」还是「遍历全部背景」。
  eachBackground: false,
  // ── 编码（与后处理「转码 / 码率」同一套语义，取值同样）──
  // ⚠ 默认值与后处理保持一致（恒定质量 + CQ 26 + h264），否则同一素材在两个模块
  //   跑出来的体积/画质会有差异，用户无从解释。
  encCodec: 'H.264',            // H.264 | H.265 / HEVC | AV1（界面下拉不带括号，此处必须同形）
  encMode: 'cq',                // cq=恒定质量 | abr=码率上限 | size=目标体积
  encCq: 26,                    // 恒定质量的 CQ（0~51，越大越省体积）
  encBitrateKbps: 0,            // 码率上限（kbps，abr 模式用）
  encTargetMB: 0,               // 目标体积（MB，size 模式用）
  // 容器格式：mp4 通用；mov 便于进剪辑软件（ProRes 管线）或承接 .mov 素材的既有流程
  container: 'mp4',             // mp4 | mov
};

const NUM_RANGES = {
  targetW: [16, 7680], targetH: [16, 7680],
  scale: [0.05, 3],
  dx: [-7680, 7680], dy: [-7680, 7680],
  radius: [0, 2000], borderW: [0, 400], bgBlur: [0, 200],
};

/** 偶数对齐：h264 要求宽高为偶数，非偶数会让正式处理失败（预览无此要求，但两处共用同一表达式） */
function evenRound(v) {
  const n = Math.round(Number(v) || 0);
  return n % 2 === 0 ? n : n + 1;
}

/** 颜色归一化为 ffmpeg 的 0xRRGGBB（非法值回退默认并记警告） */
function toFfmpegColor(v, fallback, warnings, label) {
  const s = String(v == null ? '' : v).trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s) || /^0x([0-9a-fA-F]{6})$/.exec(s);
  if (m) return '0x' + m[1].toLowerCase();
  if (s && warnings) warnings.push(label + '颜色格式无法识别（' + s + '），已按默认值处理');
  return '0x' + String(fallback).replace('#', '').toLowerCase();
}

/** 参数归一化与校验：越界回落默认值并累积 warnings（供前端提示，不抛异常） */
function normalizeParams(params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const warnings = [];
  for (const k of Object.keys(NUM_RANGES)) {
    const [lo, hi] = NUM_RANGES[k];
    const n = Number(p[k]);
    if (!isFinite(n)) { p[k] = DEFAULTS[k]; continue; }
    if (n < lo || n > hi) {
      warnings.push(k + ' 超出允许范围 [' + lo + ', ' + hi + ']，已按 ' + Math.min(hi, Math.max(lo, n)) + ' 处理');
      p[k] = Math.min(hi, Math.max(lo, n));
    } else p[k] = n;
  }
  const modes = ['center', 'tl', 'tr', 'bl', 'br', 'custom'];
  if (modes.indexOf(p.posMode) < 0) { warnings.push('位置模式无法识别，已按居中处理'); p.posMode = 'center'; }
  const bgModes = ['dir', 'image', 'video', 'color'];
  if (bgModes.indexOf(p.bgMode) < 0) { warnings.push('背景方式无法识别，已按纯色处理'); p.bgMode = 'color'; }
  // 画布宽高必须为偶数（编码器硬要求）：直接对齐而不是留给正式处理阶段报错
  const tw = evenRound(p.targetW), th = evenRound(p.targetH);
  if (tw !== Math.round(p.targetW) || th !== Math.round(p.targetH)) warnings.push('画布宽高已对齐为偶数（编码要求）');
  p.targetW = tw; p.targetH = th;
  p.borderColor = toFfmpegColor(p.borderColor, DEFAULTS.borderColor, warnings, '边框');
  p.bgColor = toFfmpegColor(p.bgColor, DEFAULTS.bgColor, warnings, '背景');
  // 背景「适合方式」：措辞与 Windows 桌面背景的「选择适合方式」对齐（填充 / 适应 / 拉伸），
  // 用户不必学新词；非法值回落「填充」。
  const bgFits = ['cover', 'contain', 'stretch'];
  if (bgFits.indexOf(String(p.bgFit == null ? '' : p.bgFit)) < 0) {
    if (p.bgFit) warnings.push('背景适合方式无法识别，已按「填充」处理');
    p.bgFit = 'cover';
  }
  return { params: p, warnings };
}

/**
 * 内容层在画布中的左上角坐标（像素）—— 前端手柄定位与滤镜表达式**共用本函数**，
 * 保证「拖动所见」与「渲染所得」不会因两处各算一遍而漂移。
 */
function contentOffset(posMode, dx, dy, canvasW, canvasH, cw, ch) {
  const d = Number(dx) || 0, e = Number(dy) || 0;
  switch (posMode) {
    case 'tl': return { x: d, y: e };
    case 'tr': return { x: canvasW - cw + d, y: e };
    case 'bl': return { x: d, y: canvasH - ch + e };
    case 'br': return { x: canvasW - cw + d, y: canvasH - ch + e };
    case 'custom': return { x: d, y: e };
    case 'center':
    default: return { x: (canvasW - cw) / 2 + d, y: (canvasH - ch) / 2 + e };
  }
}

/** 圆角遮罩表达式（作用于 rgba 的 alpha 通道）：中心区不透明，四角按半径做圆弧判定 */
function roundRectAlpha(radius, w, h) {
  const r = Math.max(1, Math.round(radius));
  const cx = '(W-1)/2', cy = '(H-1)/2';
  const ax = 'abs(X-' + cx + ')', ay = 'abs(Y-' + cy + ')';
  const ix = '(' + w + '/2-' + r + ')', iy = '(' + h + '/2-' + r + ')';
  // 注：表达式内的逗号在 filter_complex 中必须转义为 \,
  return 'if(gt(' + ax + '\\,' + ix + ')*gt(' + ay + '\\,' + iy + ')\\,'
    + 'if(lte(pow(' + ax + '-' + ix + '\\,2)+pow(' + ay + '-' + iy + '\\,2)\\,pow(' + r + '\\,2))\\,255\\,0)\\,255)';
}

/**
 * 内容层滤镜片段（缩放 → 边框 → 圆角）。
 * @returns {{segs:string[], outW:number, outH:number}}
 */
function contentSegments(p, contentW, contentH, warnings) {
  const segs = [];
  // 内容层**一律等比缩放**（回归原脚本：原方案没有非等比拉伸能力）；尺寸取偶（编码器硬要求）
  let w = evenRound(contentW * p.scale);
  let h = evenRound(contentH * p.scale);
  if (w < 2 || h < 2) { w = 2; h = 2; warnings.push('缩放后尺寸过小，已按最小 2×2 处理'); }
  segs.push('scale=' + w + ':' + h);
  if (p.borderW > 0) {
    const b = Math.round(p.borderW);
    segs.push('pad=' + (w + 2 * b) + ':' + (h + 2 * b) + ':' + b + ':' + b + ':color=' + p.borderColor);
    w += 2 * b; h += 2 * b;
  }
  if (p.radius > 0) {
    // 圆角需要 alpha 通道；在本层内完成，最终与背景叠加时透明处自然露出背景
    segs.push('format=rgba');
    segs.push("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='" + roundRectAlpha(p.radius, w, h) + "'");
    if (p.radius > 0) warnings.push('内容圆角为逐像素计算，正式处理长视频时耗时明显（预览不受影响）');
  }
  return { segs: segs, outW: w, outH: h };
}

/**
 * 背景层滤镜片段：按「适合方式」适配到画布尺寸（**不限制背景素材尺寸**，任意尺寸都能用），可选高斯模糊。
 * 措辞与 Windows 桌面背景的「选择适合方式」一致，用户不必学新词：
 *   · cover（填充，默认）：等比放大到铺满画布，超出部分裁掉
 *   · contain（适应）：等比缩到放得下，四周留黑边
 *   · stretch（拉伸）：直接拉伸铺满画布（画面比例可能变化）
 * 另：背景小于画布时给出「会被放大、可能模糊」的提醒（只提示，不拦截）。
 */
function bgSegments(p, warnings, src) {
  const W = p.targetW, H = p.targetH;
  const segs = [];
  if (p.bgFit === 'contain') {
    segs.push('scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease:flags=bicubic');
    segs.push('pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=black');
  } else if (p.bgFit === 'stretch') {
    segs.push('scale=' + W + ':' + H + ':flags=bicubic');
  } else {
    segs.push('scale=' + W + ':' + H + ':force_original_aspect_ratio=increase:flags=bicubic');
    segs.push('crop=' + W + ':' + H);
  }
  if (p.bgBlur > 0) segs.push('gblur=sigma=' + p.bgBlur);
  segs.push('format=yuv420p');
  if (p.bgMode === 'video') warnings.push('背景为视频：正式处理需 -stream_loop -1 与 -shortest 成对使用，否则编码不结束');
  const bw = Number(src && src.bgW) || 0, bh = Number(src && src.bgH) || 0;
  if (bw > 0 && bh > 0) {
    const need = p.bgFit === 'contain'
      ? Math.min(W / bw, H / bh)          // 适应：按较小的比例缩，放大倍数以「能放下」为准
      : Math.max(W / bw, H / bh);         // 填充 / 拉伸：铺满所需的放大倍数
    if (need > 1.05) {
      warnings.push('背景尺寸 ' + bw + '×' + bh + ' 小于画布 ' + W + '×' + H + '，会被放大（可能模糊）');
    }
  }
  return segs;
}

/**
 * 组装完整合成方案（预览与正式处理共用）。
 *
 * @param {object} params 画布参数（见 DEFAULTS）
 * @param {object} src 素材信息（调用方探测后传入）
 *   @param {number} src.contentW 内容视频宽（像素）
 *   @param {number} src.contentH 内容视频高
 *   @param {string} [src.contentPath] 内容视频路径（帧预览与正式处理用）
 *   @param {string} [src.bgPath] 背景文件路径（bgMode=image|video）
 *   @param {string} [src.watermarkPath] 水印 PNG 路径
 *   @param {string} [src.bgColorValue] 纯色背景值（bgMode=color，优先于 params.bgColor）
 * @returns {{ffmpegInputs:Array, filterComplex:string, maps:object, meta:object}}
 */
function buildCanvasPlan(params, src, opts) {
  // opts（可选）—— 让**正式处理**复用同一套表达式，只换标签与出口：
  //   forEncode  : true 时只产出合成结果（不做预览用的 split 第二路出口）
  //   contentLabel / outLabel : 内容层入口标签 / 最终输出标签（正式处理由工具滤镜链传入）
  const o = opts || {};
  const forEncode = o.forEncode === true;
  const contentIn = o.contentLabel ? String(o.contentLabel) : '[0:v]';
  const finalLabel = o.outLabel ? String(o.outLabel) : '';
  const norm = normalizeParams(params);
  const p = norm.params;
  const warnings = norm.warnings.slice();
  const s = src || {};
  const contentW = Number(s.contentW) > 0 ? Number(s.contentW) : p.targetH;   // 缺省按竖版处理
  const contentH = Number(s.contentH) > 0 ? Number(s.contentH) : p.targetW;

  // ── 输入列表：0=内容（帧预览与处理的主输入）；1=背景（文件或纯色 lavfi）；2=水印（可选）──
  const ffmpegInputs = [];
  ffmpegInputs.push({ path: s.contentPath || '', args: [] });
  // 背景输入以**调用方已解析的 src.bgPath** 为准（bgMode=dir 的候选挑选在调用方完成，本模块只管表达式）；
  // 视频背景需无限循环填充 —— 正式处理时必须与 -shortest 成对，否则编码永不结束。
  const bgIsVideo = s.bgKind ? (s.bgKind === 'video') : /\.(mp4|mov|mkv|avi)$/i.test(String(s.bgPath || ''));
  // ⚠ 背景输入的可结束性由**滤镜级 shortest=1** 负责（见下方 overlay 段），这里不要再加 -t 上限：
  //   上限比内容短时会把成片截短（内容 5 分钟、上限 60 秒 → 只出 60 秒）。
  //   · 图片背景 → **单帧输入**（不加 -loop 1），靠 overlay 默认 repeatlast=1 持续贴上
  //     （与 steps/overlay.js 的既有做法一致：那里早已写明图片不该加 -loop 1）
  //   · 视频背景 → -stream_loop -1 循环填充（无限流，由 shortest=1 收尾）
  //   · 纯色背景 → lavfi 源（无限流，同上）
  if (s.bgPath) {
    ffmpegInputs.push({ path: s.bgPath, args: bgIsVideo ? ['-stream_loop', '-1'] : [] });
  } else if (p.bgMode === 'image' || p.bgMode === 'video') {
    warnings.push('背景文件未提供，已按纯色处理');
  }
  const needSolid = !s.bgPath || p.bgMode === 'color';
  if (!needSolid && p.bgMode === 'image' && bgIsVideo) warnings.push('背景方式为图片但所选文件是视频，已按视频背景处理');
  if (!needSolid && p.bgMode === 'video' && !bgIsVideo) warnings.push('背景方式为视频但所选文件不是视频，已按图片背景处理');
  if (needSolid) {
    const color = s.bgColorValue ? toFfmpegColor(s.bgColorValue, p.bgColor, warnings, '背景') : p.bgColor;
    ffmpegInputs.splice(1, ffmpegInputs.length - 1, {
      lavfi: 'color=c=' + color + ':s=' + p.targetW + 'x' + p.targetH + ':r=30',
      path: '', args: ['-f', 'lavfi'],
    });
  }
  const bgIdx = 1;
  if (s.watermarkPath) ffmpegInputs.push({ path: s.watermarkPath, args: [] });
  const wmIdx = ffmpegInputs.length - 1;
  const hasWm = !!s.watermarkPath;

  // ── 内容层 ──
  const cSeg = contentSegments(p, contentW, contentH, warnings);
  const offset = contentOffset(p.posMode, p.dx, p.dy, p.targetW, p.targetH, cSeg.outW, cSeg.outH);

  // ── 滤镜图 ──
  // 注：同一 filter 输出标签只能被消费一次 —— 背景层与内容层都要「既参与合成、又单独输出」，
  // 故各自经 split 分流（否则 -map 复用标签会报 "was already used elsewhere"）。
  const parts = [];
  const bgSegs = bgSegments(p, warnings, s).join(',');
  // ⚠ 两条流都要把时间戳归零（`setpts=PTS-STARTPTS`）：预览用 `-ss` 前置定位取帧时，内容流
  //   首帧 PTS 不为 0（seek 到关键帧后仍带着原时间轴），而背景（lavfi / 图片）从 0 起 ——
  //   overlay 以**先到的时间轴**为准，`-frames:v 1` 拿到的第一帧就只有背景：
  //   表现为「合成图只剩背景，而内容原帧正常」。
  //   归零后两条流同时起步，任意时间点都能正确合成。
  const TS0 = 'setpts=PTS-STARTPTS';
  if (forEncode) {
    // 正式处理：背景与内容各只被消费一次，直接落到合成（省掉预览用的分流，也少一层拷贝）
    parts.push('[' + bgIdx + ':v]' + TS0 + ',' + bgSegs + '[bg]');
    parts.push(contentIn + TS0 + ',' + cSeg.segs.join(',') + '[c]');
  } else {
    // 预览：背景与内容都得「既参与合成、又单独输出一张图」，故各自 split 分流
    parts.push('[' + bgIdx + ':v]' + TS0 + ',' + bgSegs + '[bgsrc]');
    parts.push('[bgsrc]split=2[bg][bgout]');
    parts.push(contentIn + TS0 + ',split=2[craw][csrc]');
    parts.push('[csrc]' + cSeg.segs.join(',') + '[c]');
  }
  let composedLabel = forEncode ? (hasWm ? '[comp0]' : (finalLabel || '[comp0]')) : '[comp0]';
  // ⚠ 这里**不要**用 overlay 的 shortest=1：它让 overlay 跟随最短输入提前收尾 ——
  //   预览用 -ss 定位取帧时（内容与背景各自 seek），两条流的首帧到达时机不同，
  //   会出现「合成图只剩背景、内容原帧却正常」的**概率性**现象。
  //   无限背景的收尾交给**输出级 `-t`（= 内容时长）**（见 canvas-run.js），确定且无竞态；
  //   图片背景是单帧输入 + overlay 默认 repeatlast=1，本身就是有限流。
  parts.push('[bg][c]overlay=' + Math.round(offset.x) + ':' + Math.round(offset.y) + ':format=auto' + composedLabel);
  if (hasWm) {
    parts.push('[' + wmIdx + ':v]format=rgba[wm]');
    const wmOut = forEncode ? (finalLabel || '[compWm]') : '[compWm]';
    parts.push(composedLabel + '[wm]overlay=0:0:format=auto' + wmOut);
    composedLabel = wmOut;
  }

  // 越界提示：缩放系数与位置组合可能让内容超出画布（例如 1080×1920 素材按 0.74 缩放后比 1080 高的画布更高）——
  // 预览据此直接提示，避免整片跑完才发现构图被裁
  if (offset.x < 0 || offset.y < 0 || offset.x + cSeg.outW > p.targetW || offset.y + cSeg.outH > p.targetH) {
    warnings.push('内容超出画布范围，超出部分会被裁切（可减小缩放或调整位置）');
  }

  const meta = {
    canvasW: p.targetW,
    canvasH: p.targetH,
    contentBox: {
      x: Math.round(offset.x), y: Math.round(offset.y),
      w: cSeg.outW, h: cSeg.outH,
    },
    contentSrcW: contentW,
    contentSrcH: contentH,
    scaleUsed: p.scale,
    bgFitUsed: p.bgFit,
    radiusUsed: p.radius > 0,
    borderWUsed: p.borderW > 0 ? Math.round(p.borderW) : 0,
    bgBlurUsed: p.bgBlur > 0 ? p.bgBlur : 0,
    bgModeUsed: needSolid ? 'color' : (bgIsVideo ? 'video' : 'image'),
    warnings: warnings,
  };

  return {
    ffmpegInputs: ffmpegInputs,
    filterComplex: parts.join(';'),
    // 单帧预览：三张图（合成 / 纯背景层 / 内容原帧）；正式处理只用 composed
    maps: { composed: composedLabel, bg: '[bgout]', raw: '[craw]' },
    meta: meta,
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  normalizeParams: normalizeParams,
  contentOffset: contentOffset,
  buildCanvasPlan: buildCanvasPlan,
};
