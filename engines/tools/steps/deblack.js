// 步骤 · 去黑屏
//
// 原脚本做法（既有工具口径）：
//   用 `signalstats,metadata=print:key=lavfi.signalstats.YAVG` **逐帧**输出平均亮度，
//   从结尾向前找连续暗帧（Y < PixTh），确定裁剪点后重编码。
//   ★ 刻意不用 blackdetect —— 原脚本注释说明：blackdetect 对"结尾黑屏"不可靠
//   （黑段结束需要后续非黑帧才判定，单帧黑屏也检不出）。
//
// 本步骤只负责「分析 + 产出待删区间」，裁剪由 pipeline 统一归约。
'use strict';

const { runFfmpeg } = require('../../base/ffmpeg');

const PTS_RE = /pts_time:([0-9.]+)/;
const YAVG_RE = /lavfi\.signalstats\.YAVG=([0-9.]+)/;

/**
 * 解析逐帧亮度序列。
 * metadata=print 每帧输出两行：`frame:.. pts:.. pts_time:..` 然后 `lavfi.signalstats.YAVG=..`，
 * 因此必须**先记 pts_time、再配对 YAVG**（不能要求同行）。
 * @returns {Array<{t:number|null, y:number}>}
 */
function parseLuma(text) {
  const out = [];
  let curTime = null;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    // ffmpeg 日志可能带 ANSI 颜色转义，先剥掉再解析
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const mt = PTS_RE.exec(line);
    if (mt) { curTime = parseFloat(mt[1]); continue; }
    const my = YAVG_RE.exec(line);
    if (my) {
      const y = parseFloat(my[1]);
      if (isFinite(y)) out.push({ t: isFinite(curTime) ? curTime : null, y });
    }
  }
  return out;
}

/**
 * 从结尾向前找连续暗帧（Y < PixTh）→ 返回裁剪点（秒）。
 * 无结尾黑屏返回 null。
 *
 * 裁剪点回退 0.3 帧（与原脚本一致）：保留区间用 `between(t,a,b)` 是闭区间，
 * 若裁剪点正好等于黑屏首帧的 pts，该帧会被包含进来 —— 回退 0.3 帧可避开。
 */
function findTrailingBlack(series, pixTh, minBlackSec, duration, secPerFrame) {
  if (!series.length) return null;
  const last = series[series.length - 1];
  if (!(last.y < pixTh)) return null;                 // 结尾本身不是暗帧 → 无结尾黑屏
  let i = series.length - 1;
  while (i > 0 && series[i - 1].y < pixTh) i--;

  const startT = series[i].t != null ? series[i].t : i * secPerFrame;
  const endT = (Number(duration) > 0)
    ? Number(duration)
    : (series[series.length - 1].t != null
        ? series[series.length - 1].t + secPerFrame
        : series.length * secPerFrame);
  if (endT - startT < minBlackSec) return null;       // 太短，不算黑屏段
  return startT;
}

module.exports = {
  id: 'deblack',
  title: '去黑屏',
  group: '内容',
  danger: 'lossy',
  schema: [
    { key: 'pixTh', label: '黑屏亮度阈值', type: 'number', default: 40, min: 0, max: 255,
      hint: '越小越难判成黑屏（0~255，默认 40）' },
    { key: 'minBlackSec', label: '最短黑屏时长(秒)', type: 'number', default: 0.03, min: 0, step: 0.01,
      hint: '黑屏短于这个秒数就不管（默认 0.03）' },
  ],

  /**
   * 逐帧分析结尾黑屏（只读，不编码）。
   * @returns {{cuts:Array<[number,number]>, note:string, allBlack?:boolean}}
   */
  async analyze(file, params, ctx) {
    const pixTh = Number(params.pixTh == null ? 40 : params.pixTh);
    const minBlackSec = Number(params.minBlackSec == null ? 0.03 : params.minBlackSec);
    const info = (ctx && ctx.info) || {};
    const fps = Number(info.fps) > 0 ? Number(info.fps) : 30;
    let secPerFrame = 1 / fps;

    const args = [
      '-hide_banner', '-i', file,
      '-an',
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-f', 'null', '-',
    ];
    const r = await runFfmpeg(args, { signal: ctx && ctx.signal, captureStdout: true });

    // metadata=print 的落点随 ffmpeg 版本而异（实测本机在 stderr），两路都扫
    const series = parseLuma(String(r.stderr || '') + '\n' + String(r.stdout || ''));
    if (!series.length) return { cuts: [], note: '未取到亮度序列' };

    // 帧长优先用「时长 / 帧数」（比名义 fps 更贴近实际），无时长则退回 1/fps
    const n = series.length;
    if (Number(info.duration) > 0 && n > 1) secPerFrame = Number(info.duration) / n;

    const from = findTrailingBlack(series, pixTh, minBlackSec, info.duration, secPerFrame);
    if (from == null) return { cuts: [], note: '结尾无黑屏（共 ' + n + ' 帧）' };

    if (from <= 0.1) return { cuts: [], note: '整段视频均为黑屏，无法裁剪', allBlack: true };

    const cutFrom = Math.max(0, from - secPerFrame * 0.3);
    return {
      cuts: [[cutFrom, Number(info.duration) > 0 ? Number(info.duration) : from + secPerFrame]],
      note: '结尾黑屏 ' + (Number(info.duration) - from).toFixed(2) + 's（自 ' + from.toFixed(2) + 's 起，共 ' + n + ' 帧）',
    };
  },

  /** 本步只产出待删区间（裁剪由 pipeline 统一归约） */
  decide(info, params, analysis) {
    const cuts = (analysis && Array.isArray(analysis.cuts)) ? analysis.cuts : [];
    return { cuts, note: (analysis && analysis.note) || '' };
  },

  /** 时间轴裁剪不产生独立滤镜片段 */
  filter() { return { video: [], audio: [] }; },
};
