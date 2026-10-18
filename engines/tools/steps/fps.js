// 步骤 · 帧率转换
//
// 处理前先 `-r 30` 预渲染到 30 帧（「生成 N 个版本」属特殊业务，不纳入）；帧率口径以 avg_frame_rate 为准。
// ★ VFR（可变帧率）源：转恒定帧率时抽帧/补帧位置由 ffmpeg 自行处置，本步给出注记。
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
