// 步骤 · 截取时间段
//
// 「删帧区间」只是截取的特例；工具里统一为**保留集**，与删帧共用同一套区间代数。
// 本步产出「保留区间」（keep），不产生滤镜片段 —— 时间轴裁剪由 pipeline 统一归约。
'use strict';

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

module.exports = {
  id: 'trim',
  title: '截取时间段',
  group: '内容',
  danger: 'lossy',
  schema: [
    { key: 'mode', label: '方式', type: 'select', default: '保留区间',
      options: ['保留区间', '去掉片头', '去掉片尾'],
      hint: '只留中间一段，还是掐头 / 去尾' },
    { key: 'start', label: '保留起点(秒)', type: 'number', default: 0, min: 0, step: 0.01,
      hint: '从第几秒开始保留', showWhen: { key: 'mode', in: ['保留区间'] } },
    { key: 'end', label: '保留终点(秒)', type: 'number', default: 0, min: 0, step: 0.01,
      hint: '保留到第几秒，填 0 表示到结尾', showWhen: { key: 'mode', in: ['保留区间'] } },
    { key: 'sec', label: '时长(秒)', type: 'number', default: 0, min: 0, step: 0.01,
      hint: '要掐掉多少秒', showWhen: { key: 'mode', in: ['去掉片头', '去掉片尾'] } },
  ],

  decide(info, params) {
    const dur = Number(info.duration) || 0;
    if (!(dur > 0)) return { skip: true, reason: '无法读取时长，跳过' };
    const mode = String(params.mode || '保留区间');
    const EPS = 0.001;

    if (mode === '去掉片头' || mode === '去掉片尾') {
      const sec = num(params.sec, 0);
      if (!(sec > 0)) return { skip: true, reason: '未填写时长，跳过' };
      if (sec >= dur) return { skip: true, reason: '时长不小于原片长，跳过' };
      const keep = (mode === '去掉片头') ? [[sec, dur]] : [[0, dur - sec]];
      return { keep, note: mode + ' ' + sec + 's（保留 ' + (dur - sec).toFixed(2) + 's）' };
    }

    const a = Math.max(0, num(params.start, 0));
    const bRaw = num(params.end, 0);
    const b = bRaw > 0 ? bRaw : dur;
    if (b - a <= EPS) return { skip: true, reason: '起止时间无效（终点须大于起点），跳过' };
    if (a <= EPS && b >= dur - EPS) return { skip: true, reason: '区间覆盖全片，无需截取' };
    return {
      keep: [[a, Math.min(b, dur)]],
      note: '保留 ' + a.toFixed(2) + 's ~ ' + Math.min(b, dur).toFixed(2) + 's（共 ' + (Math.min(b, dur) - a).toFixed(2) + 's）',
    };
  },

  /** 时间轴裁剪不产生独立滤镜片段 */
  filter() { return { video: [], audio: [] }; },
};
