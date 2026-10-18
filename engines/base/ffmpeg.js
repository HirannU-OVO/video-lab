// ffmpeg 统一调用：数组参数（免引号转义，中文/空格路径安全）+ GPU 编码硬约束 + 进度/错误分流
'use strict';

const { spawn } = require('node:child_process');

// 硬约束：GPU 编码参数固定注入，禁止回退 libx264。
// 三档编码格式全部走 NVENC，供「转码 / 码率」步骤按格式选用：
// · H.264 —— 最通用（播放器 / 剪辑软件 / 手机全支持），默认档
// · H.265 —— 同画质体积更小；必须带 hvc1 标签（mp4 默认 hev1 时 Windows 照片 / 部分剪辑软件不认）
// · AV1 —— 体积最小（RTX 40 系原生支持编码）
const NVENC_CODECS = {
  h264: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-profile:v', 'high', '-level', '4.1'],
  hevc: ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-tag:v', 'hvc1'],
  av1: ['-c:v', 'av1_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26'],
};
const NVENC_ARGS = NVENC_CODECS.h264;

/**
 * 按 CQ（+ 可选编码格式）生成编码参数（其余参数一律用硬约束值，**不开放调整**）。
 * 工具侧的「转码 / 码率」步骤只改 CQ 与编码格式，其余由本源统一注入 —— 避免各处手写参数写出偏门组合。
 * @param {number|null|undefined} cq 传 null/undefined 时用默认 26（全项目统一值）
 */
function nvencArgs(cq, codec) {
  const q = (cq == null || !isFinite(Number(cq))) ? '26' : String(Math.round(Number(cq)));
  const args = NVENC_CODECS[String(codec || 'h264')] || NVENC_CODECS.h264;
  return args.map((x) => (x === '26' ? q : x));
}

/**
 * @param {string[]} args
 * @param {{onProgress?:Function, signal?:any, cwd?:string, env?:object, binary?:string,
 *          captureStdout?:boolean}} opts
 */
function runFfmpeg(args, { onProgress, signal, cwd, env, binary, captureStdout = false } = {}) {
  // FFmpeg 路径：**只认** backend 注入的 VL_FFMPEG_BIN（启动自动下载到「数据目录\ffmpeg」后的路径）。
  // ⚠ 不得回退裸名 `ffmpeg`：引擎静默借用系统 PATH 会造成「主进程判定缺失并拦下任务、
  //   引擎却照样跑起来」的口径不一致；缺注入即明确失败，由主进程在启动时自动下载补齐。
  binary = binary || process.env.VL_FFMPEG_BIN || '';
  if (!binary) {
    return Promise.resolve({ code: -1, stderr: '', stdout: '', error: 'FFmpeg 组件缺失（未注入 VL_FFMPEG_BIN）' });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        windowsHide: true,
        signal,
        cwd,
        env: Object.assign({}, process.env, env),
      });
    } catch (e) {
      // spawn 的**同步**异常（EFTYPE / ENOENT：路径在但文件不可执行、被杀软替换/隔离）也走 resolve，
      // 与既有约定「错误一律 resolve({code:-1,error})」一致 —— 否则 reject 会冒到调用方，
      // 而引擎模块普遍只判 code/error，未捕获的 reject 会直接崩掉引擎进程。
      return resolve({ code: -1, stderr: '', stdout: '', error: String((e && e.message) || e) });
    }
    let stderr = '';
    let stdout = '';
    // stderr 跨 chunk 缓冲：进程管道按缓冲区分块，stats 行可能被从中间切开
    let _errBuf = '';
    // `-stats` 的进度流是 `frame=...\rframe=...\r...`（**回车分隔、无换行**），普通日志行才是 \n 结尾，
    // 所以 \r 与 \n 都要当作分隔符切段（只按 \n 切会把整个进度流扣在缓冲里不转发）。
    const STATS_RE = /^\s*(frame|fps|q|size|time|bitrate|dup|drop|speed|elapsed)\s*=/;
    function pushErrSegs(flushLast) {
      const segs = _errBuf.split(/\r\n|\r|\n/);
      _errBuf = flushLast ? '' : (segs.pop() || '');   // 尾段不完整，留待下个 chunk；flush 时按完整段处理
      for (const seg of segs) {
        if (!seg) continue;
        // 行首锚定的 stats 段（与 backend 的折叠正则同一口径，残段不再外漏）
        if (STATS_RE.test(seg)) onProgress && onProgress(seg);
      }
    }
    child.stdout && child.stdout.on('data', (buf) => {
      if (!captureStdout) return;
      stdout += buf.toString('utf8');
    });
    child.stderr && child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      _errBuf += text;
      pushErrSegs(false);
    });
    child.on('error', (err) => { pushErrSegs(true); resolve({ code: -1, stderr, stdout, error: err.message }); });
    child.on('close', (code) => { pushErrSegs(true); resolve({ code: code == null ? -1 : code, stderr, stdout, error: null }); });
  });
}

/** 音轨 + 容器收尾参数（编码尾巴）：-c:a aac -b:a 192k 与 -movflags +faststart 统一由本函数注入，避免各模块重复手写。 */
function aacTail(container) {
  const fmt = String(container || 'mp4').toLowerCase() === 'mov' ? 'mov' : 'mp4';
  return ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', fmt];
}

module.exports = { runFfmpeg, NVENC_ARGS, nvencArgs, aacTail };