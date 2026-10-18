// 结构化日志 → 兼容行输出：字节级保持 backend.js 已解析的协议行；Node 引擎内部用结构化对象流转业务状态，stdout 仅作展示与兼容层。
'use strict';

// 用户指引映射：把「出错步骤」翻译成 ①怎么修 ②责任归属。
// 前端保持简洁，但用户必须看得懂「为什么错、我该怎么修、是不是程序的问题」——
// 技术细节（ffmpeg 原始输出等）仍只进诊断通道，这里给的是可执行的动作。
const USER_HINTS = [
  { re: /遮罩/, who: '素材或配置', how: '确认遮罩文件/目录存在（具体路径见错误详情），或在素材列表重新添加后重试' },
  { re: /原片|视频文件夹|扫描|素材/, who: '素材或配置', how: '确认对应文件夹存在、且里面有合规的视频文件' },
  { re: /水印/, who: '素材或配置', how: '确认水印图片存在且格式受支持' },
  { re: /参数|配置|未选择|缺失|校验/, who: '配置', how: '按提示补全界面上缺的必填项后重试' },
  { re: /TXT输入|REPLICA_TXT|TXT 文件/, who: '配置', how: '配置 TXT 未找到：确认配置页的素材 TXT 存在、路径有效；若是续跑/软暂停后「继续」失败，可先「停止」再用「继续制作」补做缺失成片' },
  { re: /互斥锁|锁|执行权/, who: '环境', how: '多半是还有其它任务在跑，等它结束后重试' },
  { re: /时长|组合|片段/, who: '素材或配置', how: '可用片段不足：给素材目录补素材，或放宽时长上限 / 允许超出比例后重试' },
  { re: /输出目录|磁盘|空间|权限|占用/, who: '环境', how: '检查输出目录是否可写、磁盘空间是否足够、文件是否被其它程序占用' },
  { re: /编码|ffmpeg|合成|预处理/, who: '程序或素材', how: '这一片已跳过、不影响其它成片；可点「继续制作」补做，若反复失败请把运行日志反馈' },
];
function hintFor(step) {
  const s = String(step == null ? '' : step);
  for (const h of USER_HINTS) if (h.re.test(s)) return h;
  return { who: '程序', how: '若反复出现，请把运行日志（log 目录里的 error-日期.log）反馈以便定位' };
}

// 诊断通道前缀：后端据此把「过程信息」从用户视图里剥离出来（见 backend.js 的 pushLine）
const DIAG_PREFIX = '@@VLDIAG@@';

class Logger {
  constructor({ stream = process.stdout, diagLimit = 3000, taskId = '' } = {}) {
    this._out = stream;
    // taskId 贯穿：backend 经 env 注入 VL_TASK_ID，诊断事件携带同一 id，任务失败随 task.diag 落运行日志 → 跨进程可串出完整链路。
    this._taskId = String(taskId || process.env.VL_TASK_ID || '');
    // 诊断环形缓冲：只驻内存、不进 stdout（用户视图保持简洁）；任务失败时由 dumpDiag() 一次性交给后端，落进运行日志。
    this._diag = [];
    this._diagLimit = diagLimit;
  }

  /** 记录一条「过程」事件（与面向用户的结论分开）。
   *  用于回答「怎么走到这个结论的」：每轮尝试、候选选取、被排除的原因、参数档位等。
   *  @param {string} ev   事件名，如 combo.round / pick / exclude / ladder.switch / fail
   *  @param {*} [data]    结构化数据（保持短小，避免缓冲膨胀） */
  diag(ev, data) {
    try {
      const rec = { t: Date.now(), ev: String(ev) };
      if (this._taskId) rec.taskId = this._taskId;
      if (data !== undefined) rec.d = data;
      this._diag.push(rec);
      if (this._diag.length > this._diagLimit) this._diag.shift();
    } catch (e) { /* 诊断失败绝不影响主流程 */ }
  }

  /** ffmpeg 报错尾部：stderr 末几行合成一行 —— 让错误详情自带上下文，不必再去翻原始输出 */
  ffmpegTail(stderr, lines = 6) {
    try {
      return String(stderr || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
        .slice(-(lines || 6)).join(' ｜ ').slice(0, 500);
    } catch (e) { return ''; }
  }

  /** 把「上次交出之后新增」的过程事件交给后端（取走即清空，避免重复；环形上限仍生效） */
  dumpDiag() {
    try {
      const slice = this._diag.splice(0, this._diag.length);
      if (!slice.length) return;
      const CHUNK = 200;   // 分批，避免单行过长
      for (let i = 0; i < slice.length; i += CHUNK) {
        this.raw(DIAG_PREFIX + JSON.stringify(slice.slice(i, i + CHUNK)));
      }
    } catch (e) { /* 静默 */ }
  }

  raw(line) { this._out.write(line + '\n'); }

  // 分割线（对齐 PS1 的 ================ 46 宽）
  section() { this.raw('='.repeat(46)); }

  info(text) { this.raw(text); }

  warn(text) { this.raw('⚠️  ' + text); }

  // 成片预计时长：驱动前端单成片进度分母 clipTarget；格式对齐 PS 的 [math]::Round($v,2)（两位小数、去尾随零）。
  clipDuration(sec) {
    const v = Math.round(Number(sec) * 100) / 100;
    this.raw('成片预计时长: ' + String(v) + ' 秒');
  }

  // 任务总进度
  total(n) { this.raw('共 ' + n + ' 个'); }
  progress(kind, cur, total) { this.raw(`${kind}第 ${cur} / ${total} 个成片`); }

  // 视频处理工具：与成片任务共用同一套进度解析（backend 两种措辞都认），但措辞如实描述工具场景（处理的是"视频文件"）。
  toolProgress(cur, total) { this.raw(`处理第 ${cur} / ${total} 个视频`); }

  // 单文件进度分母（字段语义与成片相同：驱动前端单条进度条）
  fileDuration(sec) {
    const v = Math.round(Number(sec) * 100) / 100;
    this.raw('当前文件时长: ' + String(v) + ' 秒');
  }

  // 创建输出目录：标记 batchOutDir（batch 专属，供 marker 记录）
  outDir(p) { this.raw('✅ 创建输出目录：' + p); }

  // 成片完成（带路径）：marker videos 记录依据（replica / mask 用）
  clipDone(p) { this.raw('✅ 成片完成：' + p); }

  // batch 的完成行是「逗号分隔、无路径」（差异表 #4：backend 用冒号行抓 videos，batch 靠创建输出目录记 batchOutDir）
  clipDoneBatch(sec, speedRatio) {
    const r = Number(speedRatio || 1);
    if (r > 1.0001) {
      this.raw('✅ 成片完成，时长：' + sec + ' 秒 (加速倍率 ' + r.toFixed(3) + 'x)');
    } else {
      this.raw('✅ 成片完成，时长：' + sec + ' 秒');
    }
  }

  // mask 的总数行（原文为「开始遮罩叠加，共 N 个成片」，backend 用 /共 (\d+) 个/ 抓取）
  maskTotal(n) { this.raw(''); this.raw('开始遮罩叠加，共 ' + n + ' 个成片'); }

  // 失败成片【序号】协议行：用于「失败发生在成片命名之前」的场景（如批量组合凑不出时长），
  // 那一刻还没有输出文件名可用，只能以序号标识 → 续跑据此按序号补做（BATCH_ONLY_INDEX）。
  failIndex(index, reason) {
    const clean = String(reason == null ? '' : reason).replace(/[|\r\n]+/g, ' ').trim();
    this.raw('❌ 失败成片序号：' + index + '|' + clean);
  }

  // 失败成片协议行：failedVideos + 续跑
  fail(name, reason) {
    const clean = String(reason == null ? '' : reason).replace(/[|\r\n]+/g, ' ').trim();
    this.raw('❌ 失败成片：' + name + '|' + clean);
  }

  // 执行权状态（用户可见文案，不用「互斥锁」等术语）
  // suffix 用于对齐各模块原文（如 batch 的「准备拼接...」）；
  // ⚠ 这三句是**协议行**：backend 与 frontend/task.js 都按文本匹配，改文案必须三处同步
  //   （见 backend.js 的 lockState 判定与 task.js 的日志过滤正则）；行尾「本任务」是避免误伤其它日志行的判别词。
  lockWaiting(suffix) { this.raw('等待前面的任务完成' + (suffix ? '，' + suffix : '')); }
  lockAcquired(msg) { this.raw('▶ 开始处理本任务' + (msg ? '，' + msg : '')); }
  lockReleased() { this.raw('■ 本任务处理结束'); }

  // 错误块（对齐 PS1 Invoke-ErrorAction 输出）
  // ① 出错误块时自动附带过程诊断（后端据此拿到「怎么走到这个错误」）；
  // ② 在「出错步骤 / 错误详情」之外补「如何解决 / 问题归属」—— 让用户看得懂该怎么修、问题出在哪一方
  //   （技术细节仍只在诊断通道）。
  error(step, msg, hint) {
    this.dumpDiag();
    const h = (hint && hint.how) ? hint : hintFor(step);
    this.raw('');
    this.raw('================ 错误信息 ================');
    this.raw('出错步骤: ' + step);
    this.raw('错误详情: ' + msg);
    if (h && h.how) this.raw('如何解决: ' + h.how);
    // 中性表述：只说明问题类型，不做否定式自证；程序侧问题补一句「已记录运行日志，可反馈」。
    if (h && h.who) {
      const isProgramSide = String(h.who).indexOf('程序') === 0;
      this.raw('问题类型: ' + h.who + (isProgramSide ? '（已记录运行日志，可反馈）' : ''));
    }
    this.raw('==========================================');
  }

  done() { this.raw('任务完成'); }
}

module.exports = Logger;
module.exports.DIAG_PREFIX = DIAG_PREFIX;