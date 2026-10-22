// ffprobe 封装：视频元信息 + 有效性判定（1080×1920 且 duration>0，与 PS1 对齐）
'use strict';

const { spawn } = require('node:child_process');
const { exists } = require('./paths');

function probe(videoPath) {
  return new Promise((resolve) => {
    if (!exists(videoPath)) {
      // 防御版（对齐 replica）：路径不存在返回无效对象，不抛异常
      return resolve({ valid: false, duration: 0, width: 0, height: 0 });
    }
    const args = ['-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath];
    // 只认 backend 注入的 VL_FFPROBE_BIN（不再回退裸名 ffprobe，见 base/ffmpeg.js 同款说明）
    const bin = process.env.VL_FFPROBE_BIN || '';
    if (!bin) return resolve({ valid: false, duration: 0, width: 0, height: 0 });
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); }
    catch (e) { return resolve({ valid: false, duration: 0, width: 0, height: 0 }); }
    let out = '';
    child.on('error', () => resolve({ valid: false, duration: 0, width: 0, height: 0 }));
    child.stdout && child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('close', (code) => {
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let width = 0, height = 0, duration = 0;
      if (code === 0 && lines.length >= 3) {
        width = parseInt(lines[0], 10) || 0;
        height = parseInt(lines[1], 10) || 0;
        duration = parseFloat(lines[2]) || 0;
      }
      const valid = width === 1080 && height === 1920 && duration > 0;
      resolve({ valid, duration, width, height });
    });
    child.on('error', () => resolve({ valid: false, duration: 0, width: 0, height: 0 }));
  });
}

/**
 * 详细探测（供视频处理工具使用）：一次 ffprobe 拿全 —— 时长 / 分辨率 / 帧率 / 码率 / 音轨。
 * 字段名刻意用 probeOk 而非 valid：probe() 的 valid 判定写死「1080×1920 且有时长」，是**成片素材**口径；
 * 工具面对任意分辨率的视频，沿用 valid 会把合法素材判成无效。
 * 另返回 isVfr —— 帧率类操作依赖帧号，VFR 源上帧号不可靠，调用方应据此警告或改按时间戳处理。
 */
function probeDetail(videoPath) {
  const empty = {
    probeOk: false, duration: 0, width: 0, height: 0,
    fps: 0, avgFps: 0, isVfr: false, bitrate: 0,
    hasAudio: false, audioCodec: '', vcodec: '', pixFmt: '',
  };
  return new Promise((resolve) => {
    if (!exists(videoPath)) return resolve(empty);
    const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath];
    const bin = process.env.VL_FFPROBE_BIN || '';
    if (!bin) return resolve(empty);
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); }
    catch (e) { return resolve(empty); }
    let out = '';
    child.stdout && child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('error', () => resolve(empty));
    child.on('close', (code) => {
      if (code !== 0) return resolve(empty);
      let j = null;
      try { j = JSON.parse(out); } catch (e) { return resolve(empty); }
      const streams = Array.isArray(j.streams) ? j.streams : [];
      const vs = streams.find((s) => s.codec_type === 'video') || null;
      const as = streams.find((s) => s.codec_type === 'audio') || null;
      const fmt = j.format || {};
      const ratio = (s) => {
        const m = /^(\d+)\/(\d+)$/.exec(String(s || ''));
        if (!m) return 0;
        const a = Number(m[1]), b = Number(m[2]);
        return b ? a / b : 0;
      };
      const fps = ratio(vs && vs.r_frame_rate);
      const avgFps = ratio(vs && vs.avg_frame_rate);
      const duration = parseFloat(fmt.duration || (vs && vs.duration) || 0) || 0;
      const width = Number((vs && vs.width) || 0) || 0;
      const height = Number((vs && vs.height) || 0) || 0;
      const bitrate = parseInt(fmt.bit_rate || (vs && vs.bit_rate) || 0, 10) || 0;
      const isVfr = !!(fps && avgFps && Math.abs(fps - avgFps) > fps * 0.01);
      resolve({
        probeOk: !!(width && height && duration > 0),
        duration, width, height, fps, avgFps, isVfr, bitrate,
        hasAudio: !!as,
        audioCodec: String((as && as.codec_name) || ''),
        vcodec: String((vs && vs.codec_name) || ''),
        pixFmt: String((vs && vs.pix_fmt) || ''),
      });
    });
  });
}

module.exports = { probe, probeDetail };