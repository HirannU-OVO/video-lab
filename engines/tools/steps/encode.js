// 步骤 · 转码 / 码率控制 / 目标体积压缩
//
// ★ 转码：可选 H.264 / H.265 / AV1 三种编码格式（全部 NVENC）。
//   兼容性硬保障（转码产物必须能被下游模块与常见软件正常使用）：
//   · 像素格式统一 yuv420p（vf 的 FORCE_FORMAT 兜底）
//   · 音轨统一 AAC 192k、mp4 容器 + faststart
//   · H.265 强制 hvc1 标签（不写会导致部分软件打不开）
//
// 原脚本做法（既有工具口径）：
//   · 码率阈值 5000 kbps —— 超过才处理；CQ 从 26 起，每次 +1，最高 40
//   · 每编一遍就测一次实际码率，达标则覆盖原文件，**到上限仍不达标则原文件保持不变**
//   · 另有一个「分辨率归位」开关：横屏归 1920×1080、竖屏归 1080×1920，不符也触发重编码
//
// ★ 这是唯一「先试后编」的步骤：先按 10% 样本试算定 CQ，再整片编码一遍。
//   NVENC 没有 2-pass，反复整片重编码（原脚本做法）代价太大且画质被反复损失，
//   故改为「样本试算 → 整片一遍」。本步通过 decide 返回 `ramp` 把这一意图交给 pipeline 执行。
//
// 目标体积的口径：目标 MB → 码率，`kbps = 目标MB × 8192 ÷ 时长(s)`。
'use strict';

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

/** 编码格式文案 → NVENC 编码器键（未知/缺省回退 h264，保持既有行为） */
function codecKeyOf(v) {
  const s = String(v || '');
  if (s.indexOf('H.265') >= 0 || s.indexOf('HEVC') >= 0) return 'hevc';
  if (s.indexOf('AV1') >= 0) return 'av1';
  return 'h264';
}

/** 竖屏 → 1080×1920，横屏（含正方）→ 1920×1080（与原脚本一致） */
function canonicalRes(w, h) {
  return (Number(w) > Number(h)) ? [1920, 1080] : [1080, 1920];
}

module.exports = {
  id: 'encode',
  title: '转码 / 码率',
  group: '编码',
  danger: '',
  schema: [
    { key: 'codec', label: '编码格式', type: 'select', default: 'H.264（最通用）',
      options: ['H.264（最通用）', 'H.265 / HEVC（体积更小）', 'AV1（体积最小）'],
      hint: '换格式会重编一遍；H.265/AV1 更省空间，老设备可能不支持' },
    { key: 'mode', label: '方式', type: 'select', default: '恒定质量',
      options: ['恒定质量', '码率上限', '目标体积'],
      hint: '恒定质量 = 只管画质；另两种按大小压' },
    { key: 'cq', label: 'CQ 值', type: 'number', default: 27, min: 0, max: 51,
      hint: '越大文件越小、画质越差（0~51，默认 27）',
      showWhen: { key: 'mode', in: ['恒定质量'] } },
    { key: 'bitrateKbps', label: '码率上限(kbps)', type: 'number', default: 5000, min: 100, step: 100,
      hint: '码率不超过这个值（默认 5000）',
      showWhen: { key: 'mode', in: ['码率上限'] } },
    { key: 'targetMB', label: '目标体积(MB)', type: 'number', default: 0, min: 0, step: 1,
      hint: '希望压到大约多少 MB',
      showWhen: { key: 'mode', in: ['目标体积'] } },
    { key: 'initialCq', label: '起始 CQ', type: 'number', default: 26, min: 0, max: 51,
      hint: '从哪个画质开始试（默认 26）',
      showWhen: { key: 'mode', in: ['码率上限', '目标体积'] } },
    { key: 'cqIncrement', label: '每次递增', type: 'number', default: 1, min: 1, max: 10,
      hint: '每次试完没达标就压多重一点（默认 1）',
      showWhen: { key: 'mode', in: ['码率上限', '目标体积'] } },
    { key: 'maxCq', label: 'CQ 上限', type: 'number', default: 40, min: 1, max: 51,
      hint: '画质最差到这个程度就放弃（默认 40）',
      showWhen: { key: 'mode', in: ['码率上限', '目标体积'] } },
    { key: 'snapRes', label: '分辨率归位', type: 'bool', default: false,
      hint: '自动改成横 1920×1080 / 竖 1080×1920' },
  ],

  decide(info, params) {
    const dur = Number(info.duration) || 0;
    const mode = String(params.mode || '恒定质量');
    const codec = codecKeyOf(params.codec);
    const codecName = codec === 'hevc' ? 'H.265' : (codec === 'av1' ? 'AV1' : 'H.264');
    const snapRes = params.snapRes === true;
    const curW = Number(info.width) || 0;
    const curH = Number(info.height) || 0;
    const want = canonicalRes(curW, curH);
    const resOff = snapRes && curW > 0 && (curW !== want[0] || curH !== want[1]);

    const base = {
      mode, codec, snapRes, snapTo: resOff ? want : null,
      curW, curH, curKbps: Math.round((Number(info.bitrate) || 0) / 1000),
    };

    const resNote = resOff ? '分辨率归位 ' + curW + '×' + curH + ' → ' + want[0] + '×' + want[1] : '';

    if (mode === '恒定质量') {
      const cq = num(params.cq, 27);
      return Object.assign(base, {
        cq,
        note: ['重编码为 ' + codecName + '（CQ ' + cq + '）', resNote].filter(Boolean).join('；'),
      });
    }

    const initialCq = Math.max(0, num(params.initialCq, 26));
    const cqIncrement = Math.max(1, num(params.cqIncrement, 1));
    const maxCq = Math.max(initialCq, num(params.maxCq, 40));

    let targetKbps = 0;
    let what = '';
    if (mode === '码率上限') {
      targetKbps = num(params.bitrateKbps, 5000);
      what = '码率上限 ' + Math.round(targetKbps) + ' kbps';
    } else {
      const mb = num(params.targetMB, 0);
      if (!(mb > 0)) return { skip: true, reason: '未填写目标体积，跳过' };
      if (!(dur > 0)) return { skip: true, reason: '无法读取时长，不能按体积反推码率，跳过' };
      targetKbps = (mb * 8192) / dur;
      what = '目标体积 ' + mb + ' MB（约 ' + Math.round(targetKbps) + ' kbps）';
    }
    if (!(targetKbps > 0)) return { skip: true, reason: '目标码率无效，跳过' };

    const alreadyOk = base.curKbps > 0 && base.curKbps <= targetKbps && !resOff;
    if (alreadyOk) {
      return { skip: true, reason: '当前码率 ' + base.curKbps + ' kbps 已达标（' + what + '），无需处理' };
    }

    return Object.assign(base, {
      ramp: { targetKbps, initialCq, increment: cqIncrement, maxCq },
      note: [what + '（转 ' + codecName + '；当前 ' + (base.curKbps || '未知') + ' kbps；'
        + '先按 10% 样本试算定 CQ（' + initialCq + ' 起，每次 +' + cqIncrement + '，上限 ' + maxCq
        + '），再整片编码一遍）', resNote].filter(Boolean).join('；'),
    });
  },

  filter(d) {
    const v = [];
    if (d.snapTo) v.push('scale=' + d.snapTo[0] + ':' + d.snapTo[1]);
    return { video: v, audio: [] };
  },
};
