// 步骤 · 帧率转换
//
// 原脚本做法：
//   · 既有工具口径 —— 处理前先 `-r 30` 预渲染到 30 帧（其余「生成 N 个版本」属特殊业务，暂不做）
//   · 既有工具口径 —— 用 avg_frame_rate 读帧率，说明帧率口径以 avg 为准
//
// ★ VFR（可变帧率）源：转成指定恒定帧率时，抽帧/补帧位置由 ffmpeg 自行处置，
//   本步给出注记；去黑屏/删帧那类**依赖帧号**的步骤在 VFR 源上才真正不安全（已在各自步骤提示）。
'use strict';

module.exports = {
  id: 'fps',
  title: '帧率转换',
  group: '编码',
  danger: '',
  schema: [
    { key: 'fps', label: '目标帧率', type: 'number', default: 30, min: 1, max: 240, step: 1,
      hint: '每秒帧数：越小文件越小、画面越不流畅（常见 30 / 60）' },
  ],

  decide(info, params) {
    const target = Number(params.fps);
    if (!(target > 0)) return { skip: true, reason: '目标帧率无效，跳过' };
    const cur = Number(info.fps) > 0 ? Number(info.fps) : Number(info.avgFps);
    if (cur > 0 && Math.abs(cur - target) < 0.01) {
      return { skip: true, reason: '源帧率已是 ' + cur.toFixed(2) + '，无需转换' };
    }
    const note = '帧率 ' + (cur > 0 ? cur.toFixed(2) : '未知') + ' → ' + target
      + (info.isVfr ? '（源为可变帧率，输出为恒定帧率）' : '');
    return { fps: target, note };
  },

  filter(d) {
    return { video: ['fps=' + Number(d.fps)], audio: [] };
  },
};
