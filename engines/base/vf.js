// 滤镜链构建助手（工具共用）：把各步骤的滤镜片段合并成一条链（统一处理逗号/分号、标签与 format 兜底）。
// 三种片段形态：vf/af —— 单输入顺序滤镜；after —— 需消费视频尾流的复杂片段；raw —— 多输入自定义标签片段。
'use strict';

const FORCE_FORMAT = 'format=yuv420p';   // 送 NVENC 前的像素格式兜底（10bit 源等）

/**
 * @param {{hasAudio?:boolean}} opts
 */
function createChain(opts) {
  const hasAudio = !(opts && opts.hasAudio === false);
  const vParts = [];     // 视频侧的简单滤镜（逗号串联）
  const aParts = [];     // 音频侧的简单滤镜
  const after = [];      // 消费视频尾流的复杂片段：[fn(tail, out) => '...']
  const rawParts = [];   // 需要自定义标签的复杂片段（concat 等）
  const inputs = [];     // 额外输入（叠加图片 / 合成背景等），按顺序追加到 -i 之后
  const outArgs = [];    // 输出级选项（-shortest 等），追加到 -map 之后

  const api = {
    hasAudio,

    /** 追加视频滤镜片段，如 'scale=iw*0.74:ih*0.74' */
    vf(expr) { if (expr) vParts.push(String(expr)); return api; },

    /** 追加音频滤镜片段，如 'atempo=1.25' */
    af(expr) { if (expr) aParts.push(String(expr)); return api; },

    /** 追加「消费视频尾流」的复杂片段；fn(tail, out) 返回 filter_complex 片段 */
    afterVideo(fn) { if (typeof fn === 'function') after.push(fn); return api; },

    /** 追加原始 filter_complex 片段（多输入场景，标签由调用方自管） */
    raw(expr) { if (expr) rawParts.push(String(expr)); return api; },

    /**
     * 追加**输出级**选项（置于 -map 之后）。
     * 目前只有画布合成用：背景是循环流（图片 -loop 1 / 视频 -stream_loop -1），
     * 必须用 -shortest 让输出跟随最短流（内容视频）—— 否则背景会无限延长、编码永不结束。
     */
    outArg() {
      for (let i = 0; i < arguments.length; i++) outArgs.push(String(arguments[i]));
      return api;
    },

    /**
     * 登记一个额外输入（返回其在 ffmpeg 参数里的序号：0 是主输入，故从 1 起）。
     * args 为该输入的**输入级选项** —— 必须排在 `-i` 之前，例如：
     *   · 视频背景：['-stream_loop','-1']（无限循环，**必须配 -shortest**，否则编码永不结束）
     *   · 图片背景：['-loop','1']（单图循环，同样需要 -shortest 收尾）
     *   · 纯色背景：['-f','lavfi']（配 color=...:s=WxH:r=30 源）
     */
    addInput(path, args) {
      inputs.push({ path: String(path), args: Array.isArray(args) ? args.map(String) : [] });
      return inputs.length;
    },

    isEmpty() { return !vParts.length && !aParts.length && !after.length && !rawParts.length; },

    /** 当前视频侧片段（只读，便于日志） */
    videoParts() { return vParts.slice(); },
    audioParts() { return aParts.slice(); },
    extraInputs() { return inputs.slice(); },

    /**
     * 产出 filter_complex 与 map 参数。
     * 约定：视频末流 `[vout]`、音频末流 `[aout]`（无音频时不含音频链）。
     */
    build() {
      const segs = [];
      const vExpr = vParts.concat([FORCE_FORMAT]).join(',');
      if (!after.length) {
        segs.push('[0:v]' + vExpr + '[vout]');
      } else {
        // 先把简单滤镜做成中间流，再逐个交给「尾流消费者」
        segs.push('[0:v]' + vExpr + '[vtail0]');
        let cur = 'vtail0';
        after.forEach((fn, i) => {
          const out = (i === after.length - 1) ? 'vout' : ('vtail' + (i + 1));
          segs.push(fn(cur, out));
          cur = out;
        });
      }
      if (hasAudio) {
        segs.push('[0:a]' + (aParts.length ? aParts.concat(['asetpts=PTS-STARTPTS']).join(',') : 'anull') + '[aout]');
      }
      for (const r of rawParts) segs.push(r);

      const inputArgs = [];
      inputs.forEach((inp) => {
        for (const a of inp.args) inputArgs.push(a);   // 输入级选项必须在 -i 之前
        inputArgs.push('-i', inp.path);
      });

      const args = ['-filter_complex', segs.join(';'), '-map', '[vout]'];
      if (hasAudio) args.push('-map', '[aout]');
      for (const a of outArgs) args.push(a);
      return { fc: segs.join(';'), args, inputArgs };
    },
  };
  return api;
}

/** 拼一条「单输入顺序滤镜」的简单链（多数步骤用这个即可） */
function simpleChain(videoParts, audioParts, hasAudio) {
  const c = createChain({ hasAudio });
  (videoParts || []).forEach((x) => c.vf(x));
  (audioParts || []).forEach((x) => c.af(x));
  return c;
}

module.exports = { createChain, simpleChain, FORCE_FORMAT };
