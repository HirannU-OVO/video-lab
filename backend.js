// -*- coding: utf-8 -*-
// Video Lab — 后端逻辑（Node.js 移植，与 main.py 行为一致）
// 负责扫描项目/TXT、解析配置、预检测、调度内置任务引擎。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v']);

// 顶层目录中需要排除的非项目目录
const EXCLUDED_TOP_DIRS = new Set([
  'Video Lab', '_design_draft', '.design', '.git', '__pycache__',
]);

// 日志文件名特征（用于区分配置与日志）
const LOG_NAME_RE = /(拼接日志|复刻日志)/;
// 引擎写在成片目录里的源配置留档（复刻侧）：属产物附件而非可执行配置，配置索引须排除
const BACKUP_NAME_RE = /^配置备份-/;
// 复刻模式名称，按 旧版脚本 的 mode 映射；两种模式在侧栏各作一个配置名，仅含日志无配置
const REPLICA_MODES = ['原片复刻', '去重复刻'];
const REPLICA_PROJECT = '复刻'; // 侧栏中的虚拟项目名（仅含日志，无配置）
const REPLICA_MARK = 'REPLICA:'; // 复刻项目虚拟版本的 path 前缀，用于路由 list_logs / logContent

// 默认配置
// 项目实际依赖的 FFmpeg 滤镜清单（三模块 + 视频处理工具的滤镜调用全量收集）：
// 缺任何一个都视为环境不合格（精简版/第三方便携构建常缺 colorchannelmixer、signalstats 等）
const FFMPEG_REQUIRED_FILTERS = [
  'scale', 'overlay', 'colorchannelmixer', 'rotate', 'transpose', 'atempo',
  'trim', 'setpts', 'select', 'aselect', 'concat', 'fps', 'volume',
  'format', 'signalstats', 'metadata',
];

// 必需编码器（硬件编码硬约束）：三档转码格式都走 NVENC ——
// 只查滤镜查不到编码器能力（老版本 ffmpeg 没有 av1_nvenc，会"检测合格但选 AV1 就失败"）
const FFMPEG_REQUIRED_ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'];

// 环境探测超时（毫秒）：冷启动首次加载 ffmpeg 时（未签名的大型二进制 + 安全软件扫描 +
// 机械盘冷读）单次执行可能远超 20 秒。探测本身是异步的、不阻塞事件循环，
// 所以宁可多等，也不要因为超时把「没探到」误判成「缺滤镜」。
// 可用 VL_ENV_PROBE_TIMEOUT_MS 覆盖（回归用：设为极小值即可稳定复现「探测失败」）。
const ENV_PROBE_TIMEOUT_MS = Math.max(1, Number(process.env.VL_ENV_PROBE_TIMEOUT_MS) || 45000);

// 成片存在性判定的内存缓存有效期（毫秒）：启动预热写入后，期内 snapshotTasks 纯内存判定、
// 不再逐任务碰磁盘；超期回退实时探测（用户在资源管理器手动删掉成片后仍能纠正）。

// 启动保护期：启动后这段时间内空闲队列不消费任务（首屏渲染与首次操作期间零 磁盘竞争）。
// 20 秒足够覆盖「窗口出现 → 项目列表渲染 → 用户第一眼扫过」，之后后台才开始慢慢校验。
const IDLE_BOOT_GRACE_MS = 20000;

// 前台活动让路窗口：最近这段时间内有过前台活动（渲染/读取/任务）就让队列再等一会儿 ——
// 与预检测的「行内优先、后台让路」同一思路。
const IDLE_FOREGROUND_HOLD_MS = 3000;



// 后台全量重扫的最小间隔（**外部更改的兜底通道**）：
// 已知的变更时刻（保存配置 / 任务启停）走「立即失效 + 广播」，不经这里；
// 这里只兜底**外部**对素材盘的改（用户手动增删改文件、别的程序写入）——
// 原始设计就是「外部删改 / 任务迁移 → 低频轮询兜底」（见前端 refreshActiveVersions 的 4 秒轮询，
// 它每次都会重拉项目列表，因此只要这里的重扫把缓存刷新，界面就会在下一轮自动跟上）。
// 取值权衡：一次全量要遍历整个工作根（实测约 3000 次 readdir），机械盘上不能按秒做，
// 但也不能长到让外部改动迟迟不出现 —— 60 秒 + 队列的前台/任务让路（只在真空闲时跑）是可接受的平衡。
const SCAN_FULL_MIN_INTERVAL_MS = 60 * 1000;
// 成片存在性结论的**持久化**有效期（verify_cache）：命中则连热启动也省掉重复核验。
// 取 10 分钟：只用来「合并同一批文件的重复校验」，不做长期真相缓存 ——
// 陈旧信息的窗口必须短，否则用户在资源管理器里删了成片，界面会一直说"还在"。
const HAS_OUTPUT_PERSIST_TTL_MS = 10 * 60 * 1000;

// ── 不判冷热，用后台队列 + 自适应节流 ──────────────
// ⚠ 不要用「开机时长」或启动探针区分冷/热启动：判据脆（开机 3 小时后启动依然是冷盘；
//   探针样本又必须"启动早期没碰过"），且判错代价双向 —— 判成热踩几十秒冻卡、判成冷无谓推迟精度。
// 本模块策略：启动期一律不发起批量文件 IO，校验全部进**空闲队列**，
// 队列串行单发 + 按实测耗时自适应节流（见 _idleKick），慢盘自动放慢、快盘自动加速。
// 精准性由「TTL + 持续自愈」保证：校验发现差异即写回 verify_cache 并增量刷新界面。

// 空闲队列每个批次核验的路径数（见 gcVideoCacheIdle：清理任务按批入队，由队列自适应节流执行）

const DEFAULT_CONFIG = {
  skin: 'white_blue',
  ffmpeg_dir: '',             // FFmpeg 组件目录（启动自动下载落到「数据目录\ffmpeg」）；空 = 尚未就绪，启动时会自动下载
  notify_task_end: true,      // 任务失败 / 本轮跑完的 Windows 系统通知（默认开启，可在 设置-通用设置 关闭）
  show_maintenance: false,    // 设置页「维护」板块是否可见（用户侧默认关闭：重建缓存/日志等属维护用途）
  backup_dir: '',             // 视频处理「处理前备份」的默认目录；留空 = 数据目录下 backup（与缓存库同目录）
  backup_auto_clean: false,   // 视频处理任务完成后自动清理过期备份（默认关闭；删除走回收站可还原）
  backup_keep_days: 7,        // 备份保留天数（3 / 7 / 15 / 30）
  cache_keep_days: 30,        // 缓存保留天数：内容缓存（视频/目录/TXT 条目）超期未更新即清理（缓存可再生）
  auto_check_update: true,    // 启动时自动检查更新
  check_update_daily: false,  // 每日定时检查更新（整点触发，需 app 保持运行）
  check_update_hour: 9,       // 每日定时检查更新时间（24 小时制整点 0-23，默认 9）
  update_source: 'gitcode',   // 更新源：gitcode=GitCode release / github=GitHub release，默认 GitCode
  update_mode: 'notify',      // 更新方式：notify=有新版本仅提醒（默认）/ auto=自动检查并下载
  config_storage: 'program',  // 配置文件保存位置：program=程序所在目录 / appdata=%APPDATA%\Video Lab
  http_port: 9527,            // 浏览器访问端口（0-65535，默认 9527）
  // 旧版脚本 顶部全局参数（文件内同名常量被顶部读环境变量 BATCH_* 覆盖）
  batch: {
    // 工作路径：批量拼接模式自己的工作目录（存放各项目文件夹及 TXT 配置）。
    // 归属放在 batch（与 mask.root 对称）—— 各模式的工作目录由各模式自己承接；
    // 顶层 root 只是旧锚点，由 main 启动时一次性迁移过来。
    root: '',
    max_duration: 179,   // MaxTotalDurationSec 最大成片时长(秒)
    max_retry: 45,       // MaxRetry 重试次数
    speed_limit: 1.2,    // SpeedThreshold 倍速阈值
    txt_prefix: '',      // TxtNamePrefix 提取前缀，可留空
    producer: '',      // 成片名固定品牌名（设置页-批量拼接 配置）
    suffix_mark: '',     // 序号后缀（成片名中的序号标识），可留空 = 无任何后缀
  },
  // 旧版脚本 顶部全局参数（文件内同名常量被顶部读环境变量 REPLICA_* 覆盖）
  replica: {
    max_duration: 179,   // MaxTotalDurationSec
    speed_limit: 1.2,    // SpeedThreshold
    dedup_ratio: 0.4,    // 重复度下限（DedupRatio）：低于它会被判定重复度过高
    dedup_ratio_max: 0.5,    // 重复度上限：超过它会被判定为全新视频（继承不到流量）
    dedup_ratio_on: true,    // 下限是否启用（复刻弹窗默认勾选状态）
    dedup_ratio_max_on: true,// 上限是否启用（复刻弹窗默认勾选状态）
  },
  // 遮罩叠加：独立工作路径 + 固定水印（设置页配置，遮罩模式界面默认使用）
  mask: {
    root: '',            // 遮罩叠加项目工作路径（不允许复用批量拼接工作路径）
    watermark_mov: '',   // 固定水印 mov（模式1/2 默认水印，界面可临时更换）
    watermark_alpha: '', // 水印透明度（0.05-1；留空用脚本默认 0.3）
  },
};

// ── 文本内容缓存后端（由 Api 在缓存库可用后注入）──────────────────────
// 缓存能力**下沉到 readText 本身**，而不是逐处调用点打补丁 ——
// 于是配置、日志、索引等**所有** TXT 读取自动获得「指纹一致即零文件读取」的能力。
const TEXT_CACHE_MAX_BYTES = 1024 * 1024;   // 超过 1MB 的文本不缓存（避免库体积失控）
let _textCacheBackend = null;               // { get(path, fp) -> string|null, put(path, fp, text) }

function readText(filePath, fallback = 'utf-8') {
  const full = filePath == null ? '' : String(filePath);
  const be = _textCacheBackend;
  let fp = '';
  if (be && full) {
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.size <= TEXT_CACHE_MAX_BYTES) fp = String(st.mtimeMs) + ':' + String(st.size);
    } catch (e) { fp = ''; }
    if (fp) {
      try { const hit = be.get(full, fp); if (hit != null) return hit; } catch (e) {}   // ★ 命中：零文件读取
    }
  }
  let buf;
  try { buf = fs.readFileSync(full); } catch (e) { return ''; }
  const encodings = [fallback, 'utf-8', 'gbk', 'utf-16le'];
  for (const enc of encodings) {
    try {
      const s = new TextDecoder(enc, { fatal: true }).decode(buf);
      const text = s.replace(/^\uFEFF/, '');
      if (fp && be) { try { be.put(full, fp, text); } catch (e) {} }                     // 读后写回（含解析结果保留）
      return text;
    } catch (e) { continue; }
  }
  return '';
}

function contentHash(filePath) {
  try { return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (e) { return null; }
}

// 原子写：先写 <p>.tmp 再 rename 覆盖；写入/替换失败时清理临时文件，原文件保持有效可复用。
// 用于任务状态/配置/索引等"坏一次就丢功能"的关键落盘，避免崩溃写坏半截文件。
function atomicWrite(p, content) {
  try {
    fs.writeFileSync(p + '.tmp', content, 'utf-8');
    fs.renameSync(p + '.tmp', p);
    return true;
  } catch (e) {
    try { if (p && fs.existsSync(p + '.tmp')) fs.unlinkSync(p + '.tmp'); } catch (e2) {}
    return false;
  }
}

// 清理残留的未完成临时缓存（上次中断遗留），原文件不受影响；加载关键缓存前调用
function cleanupTmp(p) {
  try { const tmp = p + '.tmp'; if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
}

function stripQuotes(s) {
  // 去除路径/水印/排除字符串首尾成对的双引号或单引号
  s = String(s == null ? '' : s).trim();
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) s = s.slice(1, -1).trim();
  }
  return s;
}

function dateSortKey(label) {
  let m = /^(\d{2})(\d{2})$/.exec(label);
  if (m) return [0, parseInt(m[1], 10), parseInt(m[2], 10)];
  m = /^(\d+)\s*月$/.exec(label);
  if (m) return [1, parseInt(m[1], 10), 0];
  if (label === '模版' || label === '模板' || label.endsWith('模板')) return [2, 0, 0];
  return [3, 0, 0];
}

function compareDateSortKey(a, b) {
  const ka = dateSortKey(a), kb = dateSortKey(b);
  for (let i = 0; i < 3; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
  return 0;
}

function relativeDateLabel(relParts) {
  let label = null;
  for (const p of relParts) { if (/^\d{4}$/.test(p)) label = p; }
  if (label) return label;
  for (const p of relParts) { if (/^\d+\s*月$/.test(p)) return p; }
  for (let i = relParts.length - 1; i >= 0; i--) {
    const p = relParts[i].trim();
    if (p && p !== '月份') return p;
  }
  // 兜底标签：配置/日志直接位于根目录、无任何日期段时用它（前端显示不加括号）
  return '根目录';
}

function isChengpianFile(relParts) { return relParts.some((p) => p.endsWith('成片')); }

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  return out;
}

// 异步遍历（启动路径专用）：用 fs.promises 读目录，每处理 yieldEvery 个条目让出一轮事件循环，
// 使主进程在扫描期间仍能响应 IPC / 重绘（同步版会整段占死，表现为窗口无响应、进度条不动）。
// onTick(processed) 用于上报进度，返回 false 可中断遍历（取消语义）。
async function walkFilesAsync(dir, opts) {
  const yieldEvery = (opts && opts.yieldEvery) || 60;
  const onTick = (opts && opts.onTick) || null;
  const shouldStop = (opts && opts.shouldStop) || null;
  const out = [];
  const stack = [dir];
  let since = 0;
  while (stack.length) {
    if (shouldStop && shouldStop()) return out;
    const cur = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
      if (++since >= yieldEvery) {
        since = 0;
        if (onTick) onTick(out.length);
        await new Promise((r) => setImmediate(r));   // 让位：主进程可处理其他事件
        if (shouldStop && shouldStop()) return out;
      }
    }
  }
  if (onTick) onTick(out.length);
  return out;
}

// 按内容 hash 去重（保留排序后的第一个），用于同类别（成片内/成片外）配置 txt 合并
function dedupeByHash(list) {
  const seen = new Set();
  const out = [];
  for (const it of list.slice().sort((a, b) => a.full.localeCompare(b.full))) {
    if (seen.has(it.hash)) continue;
    seen.add(it.hash);
    out.push(it);
  }
  return out;
}

// 按「成片文件夹」目录去重：每个成片文件夹取一份配置。目录名含时间，升序即旧→新
function dedupeByDir(list) {
  const seen = new Set();
  const out = [];
  for (const it of list.slice().sort((a, b) => a.full.localeCompare(b.full))) {
    const d = path.dirname(it.full);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(it);
  }
  return out;
}

// 任务总用时（秒）：未开始为 0；已结束取 endedAt；运行中取当前时间。
// 暂停期间不计入：暂停开始记 t.pausedAt，继续时并入 t.totalPausedMs，这里一并扣除。
function taskElapsed(t) {
  if (!t || !t.startedAt) return 0;
  const ended = t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted';
  const end = ended ? (t.endedAt || Date.now()) : Date.now();
  let pausedMs = t.totalPausedMs || 0;
  if (t.pausedAt) pausedMs += Date.now() - t.pausedAt;   // 当前正在暂停的这段
  return Math.max(0, Math.round((end - t.startedAt - pausedMs) / 1000));
}
// 时间格式跟随实际用时：几十秒只显秒；1m1s / 10m10s / 1h0m10s（分秒含 0 亦保留）
function zhDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  if (h > 0) return h + 'h' + m + 'm' + x + 's';
  if (m > 0) return m + 'm' + x + 's';
  return x + 's';
}
// ffmpeg 状态行的 elapsed 字段：6.x 后为 HH:MM:SS.mmm，部分版本为纯秒数 float，统一解析成秒
function parseElapsedSec(v) {
  const s = String(v).trim();
  const p = s.split(':');
  if (p.length === 3) {
    const sec = parseFloat(p[2]);
    return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (Number.isNaN(sec) ? 0 : sec);
  }
  const f = parseFloat(s);
  return Number.isNaN(f) ? NaN : f;
}
// ffmpeg 帧进度中文直译（与前端 frontend/task.js 的 liveLineText 保持一致）：
// 顺序：帧(总帧数)/q/大小/时间/码率/丢帧(为 0 不显示)/已用时/速度；体积换算 MB（KiB/1024，1 位小数）；
// elapsed（秒）格式化为时分秒。成片完成时将最后一行帧进度以此形式固化进任务日志
function zhLiveLine(kv) {
  const order = [['frame', '总帧数'], ['q', 'q'], ['size', '大小'], ['time', '时间'], ['bitrate', '码率'], ['drop', '丢帧'], ['elapsed', '已用时'], ['speed', '速度']];
  const parts = [];
  for (const [k, label] of order) {
    let v = kv[k];
    if (k === 'drop') { if (!(parseFloat(v) > 0)) continue; } // 丢帧为 0（或缺省）不显示
    if (v === undefined || v === null || v === '') continue;
    if (k === 'size') {
      const m = String(v).match(/^([\d.]+)\s*kib$/i);
      v = m ? (parseFloat(m[1]) / 1024).toFixed(1) + 'MB' : v;
    }
    if (k === 'elapsed') {
      // 与 time= 保持**同一种格式**（HH:MM:SS.xx）：ffmpeg 原生 elapsed 是 H:MM:SS.xx（小时无前导零），
      // 这里只补齐小时位，不再换成「1分23秒」这类中文 —— 与同行的时间列对齐才便于比对。
      const em = String(v).match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
      v = em
        ? (em[1].padStart(2, '0') + ':' + em[2].padStart(2, '0') + ':' + em[3])
        : v;
    }
    parts.push(label + '=' + v);
  }
  return parts.join(' ');
}

class Api {
  constructor(root, config, enginesDir, storageDir) {
    this.root = root;
    this.config = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.enginesDirFixed = enginesDir || ''; // Node 引擎位置（源码形态 app\engines，分发形态 resources\Engines）
    this.storageDir = storageDir || '';      // 数据目录：引导文件与两个库（config.json / settings.db / cache.db）同目录
    this._persistTimer = null;                          // 任务持久化节流定时器
    this._clipIndex = null;        // Map<baseDir, {mtime, entries}>
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    this._rebuildingClip = false; // 成片索引后台分批重建进行中标志（防并发重复触发）
    this.onScanProgress = null;   // 各扫描/重建环节进度回调（main 注入，推送主窗口渲染实时状态）
    this._precheckToken = 0;      // 预检测取消令牌：token 变化即中断旧探测（重置/换路径/手动取消）
    this._inlineProbing = 0;      // 行内预检测进行中计数：后台大探测遇其让路，保证用户操作优先
    // 过期锁清理移入空闲队列（见 restoreTasks 末尾）：启动期不做同步扫盘。
    // 锁残留只是历史垃圾，不影响功能 —— 晚清理无妨，但绝不该占用启动路径。
    this._loadAppSettings();      // 应用级设置：settings.db 为主（config 只作兼容回退）
    // ffprobe 探测并发上限：保持低值，避免占用过多 CPU/IO 拖慢整机
    this.probeConcurrency = 4;
    this._videoCache = null;
    this._videoInfoCache = new Map();
    // 成片存在性判定的内存结果（taskId → { v, at }）：由 _prewarmHasOutputAsync 分批异步填充，
    // 使 snapshotTasks / _taskHasOutput 在恢复期后是**纯内存判定**，不再逐任务碰磁盘。
    this._hasOutputMemo = new Map();
    // 统一空闲校验队列（见 _idleEnqueue）：启动期不发起批量文件 IO，校验全靠它后台串行完成
    this._idleJobs = [];
    this._idleRunning = false;
    this._idleDelayMs = 50;                                  // 自适应节流间隔（实测反馈驱动）
    this._idleStats = { done: 0, slow: 0, fast: 0, maxMs: 0 };
    // 启动保护期（「不要冻结窗口，前端全部用缓存渲染，预检测都能后台检测释放，
    // 这些地方也可以做到」）——照预检测那套「后台检测不冻前台」的模式：
    // 队列在启动后这段时间内**不消费任何任务**，保证首屏渲染与用户首次操作期间完全不与前台争 磁盘 IO；
    // 到期后按自适应节流开工，并在有任务运行/前台刚有活动时继续让路。
    this._idleStartAt = Date.now() + IDLE_BOOT_GRACE_MS;
    this._lastForegroundAt = 0;
    // 「缓存优先」是**默认行为**，没有"启动快速路径"标志：
    //   读取一律先命中内存/持久化缓存；指纹校验与重建一律排入空闲队列 —— 后者自带启动保护期
    //   （`_idleStartAt`）与前台让路（`_lastForegroundAt`），那才是"启动期"的正确落点，有真实语义；
    //   只有用户主动刷新（force）才绕过缓存真扫。
    //   ⚠ 不要再用"时间窗口"近似启动期（曾用 `_bootFast` + 60 秒窗口，窗口内外行为不同）：
    //   会出现「force 刷新被拦下 → 列表变空」「清内存缓存后被持久化旧值读回 → 新配置不显示」两类缺陷。
    this._videoCacheDirty = false; // 缓存内容是否有未落盘变更：无变更时预检测不再重复写整份缓存
    this._videoCacheDirtyKeys = new Set();   // 待写回的路径（增量 upsert）
    this._videoCacheRemovedKeys = new Set(); // 待删除的路径
    this._cacheStore = null;       // 数据缓存库（<storageDir>\cache.db），惰性打开
    this._cacheBackendMode = '';   // 'db' | 'mem'：首次使用时判定一次（mem = 库不可用，退化纯内存不落盘）
    this._settingsStore = null;    // 设置库（<storageDir>\settings.db），惰性打开
    this._settingsMode = '';       // 'db' | 'mem'
    this._lnkCache = new Map();    // .lnk 解析结果缓存（lnk 路径 → { mtimeMs, target }），lnk 未变则免重复解析
    this._lnkParser = undefined;   // .lnk 解析器（惰性取底座引擎实现）
    this._txtTree = null;
    // ⚠ 这里**不要**排队 video_cache 失效清理：清理是维护性任务，不该占据启动。
    //   构造函数里 setImmediate 全量跑会把冷态事件循环冻住几十秒（窗口已画出但点不动）。
    //   现改为窗口就绪后 15 秒的空闲期增量执行（见 gcVideoCacheIdle：限量 + 细让路 + 批间小睡）。
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._projectsInflight = null;   // 进行中的 listProjectsAsync（并发合并，避免同一份扫描跑多遍）
    this._projectsSeq = 0;           // 刷新代际：force 后令在跑的旧任务结果作废
    this._lastFreshTiming = null;    // isScanCacheFreshAsync 的分段耗时，供启动日志定位瓶颈
    this._versionsCache = new Map();
    this._versionsFp = new Map(); // 各配置版本列表的「目录级指纹」，list_versions 入口核对自动失效
    this._scanCache = new Map();
    this._scanLoadedRoot = '';
    this._scanDirty = false;
    this._scanDirtyKeys = new Set();   // 待写回的指纹键（增量 upsert）
    this._scanRemovedKeys = new Set(); // 待删除的指纹键
    // 日志 txt 缓存：刷新配置时一次性收集全部日志，供日期分支/对应关系直接使用
    this._logCache = null;
    this._logCacheRoot = '';
    // 水印主流水印固化缓存：按 root 隔离加载，换工作目录时重置（_wmCacheLoadedRoot !== root 视为未加载）
    this._wmCache = null;
    this._wmEnabled = null; // 项目是否启用主流水印判定（root+'\u0000'+项目 -> true/false）
    this._wmCacheLoadedRoot = null;
    // 任务管理：实时捕获 ps1 输出并推送，支持多任务与停止排队任务
    this.tasks = new Map();
    this.taskSeq = 0;
    this.onTasksChanged = null; // 由 main 进程注入，用于向渲染进程推送任务快照
    this.onVersionsChanged = null; // 由 main 进程注入：配置文件写操作后广播，供前端即时自愈
    // 排队调度：同一时刻仅运行一个任务，其余按创建顺序排队（由软件安排制作顺序，不再依赖抢锁）
    this._taskQueue = [];
    this._runningTaskId = null;
    // 计划序号：新建任务入队时递增分配，暂停任务保留、启动任务移除、拖拽/置顶重排后重算。
    // UI 显示与「继续」插队位置都以此为准（暂停任务随队列推进自然前移，成为下一个后停住，新任务可越过）
    this._planSeq = 0;
  }

  // ── 库路径：两个库与引导文件同目录（扁平布局），一律由 storageDir 派生，不做重算 ──
  get cacheDbPath() {
    return this.storageDir ? path.join(this.storageDir, 'cache.db') : '';
  }

  get settingsDbPath() {
    return this.storageDir ? path.join(this.storageDir, 'settings.db') : '';
  }

  // Node 引擎根目录：由 main 按形态动态解析传入（源码形态 app\engines，分发形态 resources\Engines）；
  // 未传入时按本文件所在目录同级探测作为兜底
  get enginesDir() {
    if (this.enginesDirFixed) return this.enginesDirFixed;
    const parent = __dirname;
    // 源码形态为 app\engines，分发形态为 resources\Engines：逐一探测并取回真实大小写
    for (const name of ['engines', 'Engines']) {
      const cand = path.join(parent, name);
      try { if (fs.existsSync(cand)) return fs.realpathSync(cand); } catch (e) {}
    }
    return path.join(parent, 'engines');
  }

  // 运行日志出口（懒加载；写日志永不影响主流程）
  _lg(verb, action, summary, data) {
    try { this._ensureRunLog().logEvent(verb, action, summary, data); } catch (e) {}
  }
  // runlog 单例（懒加载）。⚠ 这里**不读设置库**：本方法会在启动关键路径上被调用，
  // 而读 settings.db 需要同步开库（启动期硬约束禁止）→ 级别恢复另走空闲队列（见 _restoreLogLevel）。
  _ensureRunLog() {
    if (!this._runLog) this._runLog = require(path.join(this.enginesDir, 'base', 'runlog.js'));
    return this._runLog;
  }
  // 引擎原始行 → engine-<date>.log（唯一落盘方 = 主进程）。
  // stdout 与 stderr 的每一行都落，任务置为终态后也不丢（内存 500 行窗口之外的后续行、
  // 崩溃前最后输出的唯一去处）；ffmpeg 进度类高频行在 runlog 内按秒采样。
  _engineLine(tag, line) {
    try { this._ensureRunLog().engineLine(tag, line); } catch (e) {}
  }
  _engineMark(tag, what) {
    try { this._ensureRunLog().engineTaskMark(tag, what); } catch (e) {}
  }
  // 任务 env 的业务字段快照 —— 复现「成片命名 / 输出目录 / 续跑范围」的唯一凭据，
  // 任务记录一旦被清除就再也没有别处留存了。
  _envBrief(env) {
    const E = env || {};
    const keys = ['REPLICA_TXT', 'REPLICA_OUTPUT_DIR', 'BATCH_COUNT', 'BATCH_GROUP', 'BATCH_SUBMIT_TS',
      'BATCH_TXT_PREFIX', 'BATCH_SUFFIX_MARK', 'BATCH_PRODUCER', 'BATCH_ONLY_NAMES', 'BATCH_ONLY_INDEX',
      'REPLICA_ONLY_NAMES', 'REPLICA_ONLY_NAME', 'REPLICA_SUBMIT_TS',
      'MASK_ONLY_NAMES', 'MASK_RAW_DIRS', 'MASK_THEMES', 'MASK_OUTPUT_DIR'];
    const out = {};
    for (const k of keys) { const v = E[k]; if (v !== undefined && v !== null && String(v) !== '') out[k] = String(v).slice(0, 240); }
    return out;
  }
  // 被删产物的可复盘清单（路径 + 大小 + 修改时间）—— 必须在删除之前调用
  _describeForLog(paths) {
    try {
      return this._ensureRunLog().describeFiles(paths);
    } catch (e) { return { files: [], count: 0, bytes: 0, truncated: false }; }
  }
  _humanSize(n) {
    try {
      return this._ensureRunLog().humanSize(n);
    } catch (e) { return String(n) + ' B'; }
  }

  // 引擎入口文件；不存在返回空串（调用方据此判定引擎不可用）
  _engineRunnerPath() {
    const d = this.enginesDir;
    if (!d) return '';
    const p = path.join(d, 'engine-runner.js');
    try { return fs.existsSync(p) ? p : ''; } catch (e) { return ''; }
  }

  // 传给任务的缓存环境变量：引擎直读同一个库（<storageDir>\cache.db），无中间文件
  _cacheEnvBase() {
    return { VL_CACHE_DB: this.cacheDbPath || '' };
  }

  // 引擎是否为当前执行路径：引擎入口文件就绪即可用
  _nodeEnginePrimary() {
    return !!this._engineRunnerPath();
  }

  // 任务是否可分发到内置引擎：未知任务类型一律不分发
  shouldUseNodeEngine(type) {
    if (!type) return false;
    return this._nodeEnginePrimary();
  }

  getRoot() { return this.root; }

  setRoot(newRoot) {
    // 相同路径（如启动时 ensureConfig 每次都调用 setRoot(同 root)）：仅同步内存，不清缓存——
    // 否则会清掉已保存的主流水印设置（watermark_cache 被误删，用户需重新设置）
    if (String(newRoot || '') === String(this.root || '')) {
      this.root = newRoot || '';
      return;
    }
    // 更换工作目录（即使重选相同目录）：仅清内存触发重载，不物理删除文件——
    // 水印/默认分组数按 root+项目 隔离保存，属设置数据，不能被换目录/清缓存抹掉
    this._wmCache = null;
    this._wmCacheLoadedRoot = null;
    this.root = newRoot;
    this._videoCache = null;
    this._videoInfoCache.clear();
    this._invalidateCaches();
    // 成片索引随工作目录重置：清内存并取消进行中的后台重建，避免旧目录写入新缓存
    this._clipIndex = new Map();
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    // 预检测缓存库随 root 重建连接：root 前缀隔离在库内以 gcPlan / 载入过滤体现
    if (this._cacheStore) { try { this._cacheStore.close(); } catch (e) {} }
    this._cacheStore = null;
    this._cacheBackendMode = '';
    this._videoCacheDirtyKeys.clear();
    this._videoCacheRemovedKeys.clear();
    this._rebuildingClip = false;
    // 预检测随工作目录取消：旧路径的探测结果不写入新目录缓存
    this._precheckToken++;
  }

  // ── 存储位置与连接管理（切换「配置和数据保存位置」时由 main 调用）──

  // 有任务正在运行或排队 → 禁止迁移存储位置（Windows 下子进程持有库句柄，移动必然失败）
  hasRunningTasks() {
    for (const t of this.tasks.values()) {
      if (t.status === 'running' || t.status === 'queued') return true;
    }
    return false;
  }

  // 关闭全部库连接并落盘（切换保存位置前必须调用）；随后由 onStorageMoved 按新位置重开
  closeStorageConnections() {
    const store = this._cacheStore;
    if (store) {
      // WAL 收尾：TRUNCATE 把 -wal 内容合并回主库并清空，否则移动时 -wal/-shm 会与主库脱节
      try { store.open().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
      try { store.close(); } catch (e) {}
    }
    this._cacheStore = null;
    this._cacheBackendMode = '';
    if (this._settingsStore) { try { this._settingsStore.close(); } catch (e) {} }
    this._settingsStore = null;
    this._settingsMode = '';
  }

  // 保存位置已变更：更新数据目录、清空全部内存缓存，下次访问时按新位置重新打开
  onStorageMoved(dir) {
    this.storageDir = dir || '';
    this._videoCache = null;
    this._videoCacheDirty = false;
    this._videoCacheDirtyKeys.clear();
    this._videoCacheRemovedKeys.clear();
    this._videoInfoCache.clear();
    this._scanCache = new Map();
    this._scanLoadedRoot = '';
    this._scanDirty = false;
    this._logCache = null;
    this._logCacheRoot = '';
    this._wmCache = null;
    this._wmEnabled = null;
    this._wmGroup = null;
    this._wmGroupEnabled = null;
    this._wmCacheLoadedRoot = null;
    this._clipIndex = null;
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    this.persistTasks(); // 新位置先把当前任务列表落一份，避免切换后列表为空
  }

  // 手动取消进行中的预检测（前端"缩到后台"后点击 ✕、或再次重置/换路径时自动取消防重复）
  cancelPrecheck() {
    this._precheckToken++;
    return { ok: true };
  }

  // 清理项目/TXT 相关内存缓存（保存配置、重建列表时调用；不清持久化指纹缓存）
  // 清理项目/TXT 相关内存缓存（保存配置、重建列表时调用；不清持久化指纹缓存）
  // dropPersist=true 时连持久化条目一并删除 —— 供「强制重扫」（force）使用：
  //   否则内存清了、持久化指纹仍在，重扫会直接读回旧缓存，force 语义失效。
  _invalidateCaches(dropPersist = false) {
    this._txtTree = null;
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._projectsInflight = null;
    this._projectsSeq = (this._projectsSeq || 0) + 1;   // 在跑的旧任务结果作废
    this._versionsCache.clear();
    this._versionsFp.clear();
    this._logCache = null;
    this._logCacheRoot = '';
    if (dropPersist && this._useDbCache()) {
      try { this._cacheStore.removeKv('log_index:' + this.root); } catch (e) {}
      try { this._cacheStore.removeKv('txt_tree:' + this.root); } catch (e) {}
    }
  }

  // 配置文件写操作统一收口：清缓存 + 广播，前端据此即时自愈版本/日期分支/侧栏徽章。
  // ⚠ 关键是「刚存的配置前端必须立刻能看到」：
  //   ① 用户已在交互，此后按真实语义读取，不能继续吃启动期读入的缓存；
  //   ② 传入具体文件路径时**就地并入**配置树缓存（新增/修改/删除都能立刻反映，且无需全量重扫）；
  //   ③ 未传路径（删除分支 / 重命名 / 水印批量替换等）→ **清掉持久化配置树**，
  //      下次读取必然重扫，宁可慢一点也不能显示陈旧内容
  //      （注意：这类操作常发生在二级/三级目录，**不会改变一级目录 mtime**，靠指纹发现不了）。
  _markConfigModified(...paths) {
    const list = paths.filter(Boolean);
    let merged = 0;
    for (const p of list) { try { if (this._upsertTxtTreeEntry(p)) merged++; } catch (e) {} }
    if (!list.length || merged < list.length) {
      // 有未并入的变更（或批量变更）→ 丢弃持久化配置树，保证下次读取是真扫结果
      try { if (this._useDbCache()) this._cacheStore.removeKv('txt_tree:' + this.root); } catch (e) {}
      this._invalidateCaches();
    } else {
      // ✅ 并入完整：**保留**更新后的配置树（_upsertTxtTreeEntry 已把它写回持久化）。
      //    ⚠ 这里不要无条件 _invalidateCaches()：会把刚并入并落盘的树清掉 —— 而新增/改动配置
      //    常发生在二级/三级目录、**不改变一级目录 mtime**（见上方注释）→ 指纹不变 →
      //    下次读取命中「旧指纹缓存」→ 新配置**突然消失**，必须点刷新（force 真扫）才回来。
      //    此处只失效「项目列表 / 版本 / 日志」这类派生缓存即可。
      this._projectsCache = null;
      this._projectsInflight = null;
      this._projectsSeq = (this._projectsSeq || 0) + 1;   // 在跑的旧任务结果作废
      this._versionsCache.clear();
      this._versionsFp.clear();
      this._logCache = null;
      this._logCacheRoot = '';
    }
    if (typeof this.onVersionsChanged === 'function') { try { this.onVersionsChanged(); } catch (e) {} }
  }

  // 配置写操作后把该文件**就地并入**配置树缓存（增量刷新）：
  // 列表与版本立刻反映新/改/删的配置，无需等下一次全量扫描。返回是否已并入。
  _upsertTxtTreeEntry(filePath) {
    if (!Array.isArray(this._txtTree) || this._txtTreeRoot !== this.root) return false;
    const full = path.resolve(String(filePath || ''));
    const rel = path.relative(this.root, full);
    if (!rel || rel.startsWith('..')) return false;
    const segs = rel.split(path.sep);
    if (segs.length < 2) return false;                        // 必须位于一级项目目录下才算配置
    const pdir = path.join(this.root, segs[0]);
    const name = path.basename(full, path.extname(full));
    const parts = segs.slice(1, -1);
    const idx = this._txtTree.findIndex((t) => t && t.full === full);
    let st = null;
    try { st = fs.statSync(full); } catch (e) { st = null; }
    if (!st) {                                                // 文件已不在 → 从缓存移除
      if (idx < 0) return false;
      this._txtTree.splice(idx, 1);
    } else {
      const entry = { pdir, name, full, parts, mtimeMs: st.mtimeMs, size: st.size, hash: this._hashFor(full, st.mtimeMs, st.size) };
      if (idx >= 0) this._txtTree[idx] = entry; else this._txtTree.push(entry);
    }
    this._saveTxtTree(this._txtTree, this._txtTreeFp || '');
    this._projectsCache = null;                               // 项目列表缓存作废，下次重建即含新项
    return true;
  }

  // ── 扫描指纹缓存（scan_cache 表）：文件 (mtime,size) 未变则复用已算的 hash，变了才重读 ──
  // 库不可用时退化为纯内存：本次会话内仍可复用，仅跨启动失效（代价只是首次扫描重算指纹）
  _loadScanCache() {
    if (this._scanLoadedRoot === this.root) return;
    this._scanLoadedRoot = this.root;
    this._scanCache = new Map();
    this._scanDirtyKeys.clear();
    this._scanRemovedKeys.clear();
    if (!this._useDbCache()) return;
    try {
      for (const row of this._cacheStore.listScans(this.root + '\n')) {
        let extra = {};
        try { extra = JSON.parse(row.payload || '{}') || {}; } catch (e) { extra = {}; }
        this._scanCache.set(row.key, Object.assign({ mtimeMs: 0, size: 0 }, extra, { hash: row.fingerprint }));
      }
    } catch (e) {}
  }

  // 增量落盘：只写新增/变更的键、删失效键（原实现每次重写整份 JSON）
  _saveScanCache() {
    this._scanDirty = false;
    if (!this._useDbCache()) { this._scanDirtyKeys.clear(); this._scanRemovedKeys.clear(); return; }
    const store = this._cacheStore;
    try {
      store.transaction(() => {
        for (const k of this._scanDirtyKeys) {
          const v = this._scanCache.get(k);
          if (!v) continue;
          store.setScan(k, String(v.hash == null ? '' : v.hash), JSON.stringify({ mtimeMs: v.mtimeMs || 0, size: v.size || 0 }));
        }
        if (this._scanRemovedKeys.size) store.deleteScans(Array.from(this._scanRemovedKeys));
      });
    } catch (e) {}
    this._scanDirtyKeys.clear();
    this._scanRemovedKeys.clear();
  }

  // ── 日志 txt 缓存（cache_kv，键 log_index:<root>）：刷新配置时一并收集 ──
  // 存 { files, fp }：fp = 目录树指纹，用于启动时判断能否直接复用（见 _collectLogFiles）。
  // 兼容旧格式（纯数组）——读到数组时视为无指纹，回退一次全量扫描后自动升级。
  _loadLogCache() {
    if (this._logCacheRoot === this.root) return;
    this._logCacheRoot = this.root;
    this._logCache = { files: [], fp: '' };
    if (!this._useDbCache()) return;
    try {
      const raw = this._cacheStore.getKv('log_index:' + this.root);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) this._logCache.files = data;                       // 旧格式
      else if (data && Array.isArray(data.files)) {                               // 新格式
        this._logCache.files = data.files;
        this._logCache.fp = String(data.fp || '');
      }
    } catch (e) {}
  }

  _saveLogCache() {
    if (!this._useDbCache()) return;
    try {
      const payload = { files: this._logCache.files || [], fp: this._logCache.fp || '' };
      this._cacheStore.setKv('log_index:' + this.root, JSON.stringify(payload));
    } catch (e) {}
  }

  // 一次性收集根目录下所有非复刻日志 txt（刷新时写入日志缓存）
  // 返回 { files:[{ project, name, path, date, config }] }
  // 归属规则：date 取文件路径中「最近的 4 位 MMdd 目录」（日志绝不会存在于别的日期文件夹），
  //           project 取路径第一级目录（即左侧项目名）。配置与日志都按此规则归一后匹配。
  //
  // ⚡ 启动性能（关键）：命中持久化缓存（log_index:<root>）且「根目录树指纹」未变时，
  //    直接复用缓存返回，**跳过 walkFiles 全量遍历 + 每文件 statSync**。
  //    原实现虽然 _loadLogCache() 读回了缓存，但紧接着 `const files = []` 丢弃、无条件重扫，
  //    使持久化缓存形同虚设（冷启动白扫约 6600 个文件、耗时秒级）。
  //    失效判定用「根目录 + 各一级项目目录的 mtimeMs 摘要」：目录 mtime 对增删子项敏感，
  //    新增/删除项目或目录即变化；文件内容变化不改目录 mtime，但日志列表只关心「有哪些文件」，
  //    内容变化不影响本列表（config 归属由路径决定），故无需更细粒度指纹。
  _collectLogFiles(force = false) {
    // **缓存优先（默认行为）**：内存 → 持久化缓存直接用，随后排入空闲队列做后台校验；
    // 只有「缓存缺失（首次运行 / 新机器）」或 force（用户主动刷新）才真扫。
    // 不再有"启动期"专有分支 —— 启动与运行走同一条路，行为不随 60 秒边界变化。
    if (!force) {
      const cached = (this._logCache && this._logCacheRoot === this.root) ? this._logCache : this._cachedLogFiles();
      if (cached && cached.files && cached.files.length) { this._enqueueScanVerify(); return cached; }
    }
    const files = [];
    if (this.root && fs.existsSync(this.root)) {
      const skip = new Set(EXCLUDED_TOP_DIRS);
      for (const full of walkFiles(this.root)) {
        const base = path.basename(full);
        if (!base.toLowerCase().endsWith('.txt')) continue;
        if (!LOG_NAME_RE.test(base)) continue;
        const config = this._configNameFromLog(full);
        if (!config) continue; // 复刻/无归属日志单独处理
        const rel = path.relative(this.root, full).split(path.sep);
        if (skip.has(rel[0])) continue;
        files.push({ project: rel[0], name: base, path: full, date: this._dateBranchOf(full), config });
      }
    }
    this._logCache = { files, fp: this._logTreeFingerprint() };
    this._logCacheRoot = this.root;
    this._saveLogCache();
    return this._logCache;
  }

  // 日志树指纹：根目录 + 各一级目录（排除项除外）的 mtimeMs 摘要。
  // 目录增删子项会更新父目录 mtime —— 够用且只读少量目录（非全量 walkFiles）。
  _logTreeFingerprint() {
    try {
      const parts = [];
      const st = fs.statSync(this.root);
      parts.push(String(st.mtimeMs));
      const skip = new Set(EXCLUDED_TOP_DIRS);
      for (const ent of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_') || skip.has(ent.name)) continue;
        let m = '';
        try { m = String(fs.statSync(path.join(this.root, ent.name)).mtimeMs); } catch (e) { m = '?'; }
        parts.push(ent.name + ':' + m);
      }
      return parts.join('|');
    } catch (e) { return ''; }
  }

  // 日志树指纹（异步版）：语义与 _logTreeFingerprint 完全一致，供异步路径使用。
  // ⚠ 启动路径必须用这个：工作目录在机械盘时，系统重启后首次同步访问该盘可冻结主进程上百秒
  //   （窗口、托盘全都出不来）；异步版只让出等待、不阻塞。
  async _logTreeFingerprintAsync() {
    try {
      const parts = [];
      const st = await fs.promises.stat(this.root);
      parts.push(String(st.mtimeMs));
      const skip = new Set(EXCLUDED_TOP_DIRS);
      let ents = [];
      try { ents = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch (e) { ents = []; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_') || skip.has(ent.name)) continue;
        let m = '';
        try { m = String((await fs.promises.stat(path.join(this.root, ent.name))).mtimeMs); } catch (e) { m = '?'; }
        parts.push(ent.name + ':' + m);
      }
      return parts.join('|');
    } catch (e) { return ''; }
  }

  // 文件所属日期分支：取相对根目录各路径段中「最近的 4 位 MMdd 目录」，否则返回空串
  _dateBranchOf(full) {
    const rel = path.relative(this.root, full).split(path.sep);
    let d = '';
    for (const seg of rel) if (/^\d{4}$/.test(seg)) d = seg;
    return d;
  }

  // 文件所属项目：取相对根目录的第一段目录名
  _projectOf(p) {
    try { return path.relative(this.root, path.resolve(String(p))).split(path.sep)[0]; }
    catch (e) { return ''; }
  }

  // ⚠ 键分隔符禁用 \u0000：SQLite 的 TEXT 在 NUL 处截断，会把所有文件指的纹键
  //   压成同一个「根目录」字符串（既互相覆盖、又读不回来），导致指纹缓存全量失效。
  //   改用 \n —— Windows 路径非法字符，路径中不可能出现，语义等价且可安全持久化。
  _scanKey(full) { return this.root + '\n' + full; }

  _hashFor(full, mtimeMs, size) {
    this._loadScanCache();
    const key = this._scanKey(full);
    const cached = this._scanCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash;
    const h = contentHash(full);
    this._scanCache.set(key, { mtimeMs, size, hash: h });
    this._scanDirty = true;
    this._scanDirtyKeys.add(key);
    return h;
  }

  // 一次性收集根目录下所有项目的配置 TXT（每项目仅递归扫描一次）
  //
  // ⚡ 启动性能（关键）：加「持久化指纹复用」。原实现是纯内存缓存（this._txtTree），
  //    跨启动必然失效 → 每次冷启动都要重新 walkFiles(6600 文件) + 对 1055 个 txt
  //    逐个 statSync + contentHash（readFileSync 读全内容），实测约 31 秒。
  //    现改为把结果按「目录树指纹」持久化（cache_kv 的 txt_tree:<root>）：
  //    指纹未变则直接复用，跳过全部遍历与读文件。
  //    指纹 = 各一级项目目录的 mtimeMs 摘要 —— 目录增删子项会更新其 mtime，
  //    足以发现「新增/删除配置或目录」；文件内容变更不改目录 mtime，但内容只用于
  //    去重（同内容配置保留一份），短暂延后一次不影响列表正确性，且下次任一目录变动即自愈。
  _collectAllTxt(force) {
    // **缓存优先（默认行为）**：内存 → 持久化缓存直接用，并排入空闲队列做后台校验；
    // 仅「缓存缺失」或 force（用户主动刷新）才真扫。
    if (!force) {
      const cached = (this._txtTree && this._txtTreeRoot === this.root) ? this._txtTree : this._cachedTxtTree();
      if (cached) { this._enqueueScanVerify(); return cached; }
    }
    const fp = this._logTreeFingerprint();   // 只有真要扫时才算指纹
    this._loadScanCache();
    const out = [];
    const active = new Set();
    const stopped = false;   // 同步版不中断（保留同名变量，与异步版共用落盘逻辑）
    if (fs.existsSync(this.root) && fs.statSync(this.root).isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(this.root); } catch (e) { entries = []; }
      for (const name of entries) {
        if (name.startsWith('.') || name.startsWith('_')) continue;
        if (EXCLUDED_TOP_DIRS.has(name)) continue;
        const pdir = path.join(this.root, name);
        if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) continue;
        const files = walkFiles(pdir);
        for (const full of files) {
          if (!path.basename(full).toLowerCase().endsWith('.txt')) continue;
          if (LOG_NAME_RE.test(path.basename(full))) continue;
          if (BACKUP_NAME_RE.test(path.basename(full))) continue;
          let st;
          try { st = fs.statSync(full); } catch (e) { continue; }
          const mtimeMs = st.mtimeMs, size = st.size;
          const hash = this._hashFor(full, mtimeMs, size);
          active.add(this._scanKey(full));
          const rel = path.relative(pdir, path.dirname(full));
          const parts = rel === '' ? [] : rel.split(path.sep);
          out.push({ pdir, name: path.basename(full, path.extname(full)), full, parts, mtimeMs, size, hash });
        }
      }
    }
    this._txtTree = out;
    this._txtTreeRoot = this.root;
    if (this._scanDirty) {
      const prefix = this.root + '\n';
      for (const k of [...this._scanCache.keys()]) {
        if (k.startsWith(prefix) && !active.has(k)) { this._scanCache.delete(k); this._scanRemovedKeys.add(k); }
      }
      this._scanDirty = false;
      this._saveScanCache();
    }
    if (!stopped) this._saveTxtTree(out, fp);   // ★ 被中断则不写缓存（避免残缺结果覆盖完整数据）
    return out;
  }

  // 配置 TXT 树缓存原文（items + 指纹）：只读库、零 stat。启动快速路径与指纹校验都用它。
  _txtTreeCacheRaw() {
    if (!this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getKv('txt_tree:' + this.root);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return null;
      return { items: data.items, fp: String(data.fp || '') };
    } catch (e) { return null; }
  }

  // 把「配置树 / 日志索引」的后台校验排入空闲队列（后台检测 + 自愈）。
  // ⚠ 必须**无条件重建**，不能只靠指纹判变：
  //   目录树指纹只看「根 + 一级目录 mtime」，而外部新增/删除几乎都发生在
  //   「项目\月\日」这类**子目录**里 —— 子目录内容变化**不改变父目录 mtime**，
  //   指纹永远认为"没变"，缓存就一直返回旧列表（表现为「文件明明在、前端就是不显示」）。
  //   指纹粒度与操作粒度不匹配时不能靠它兜底。
  //   现行做法：空闲期统一重扫一次（串行、节流、可中断/让路），任何外部变化都会在后台
  //   被发现并刷新前端；用持久化的 last_full_at 控制频率，避免每次启动都全量遍历。
  _enqueueScanVerify() {
    this._verifyEnqueue('scanverify', this.root, async () => {
      // 频率控制：距上次全量重扫不足间隔就跳过
      let lastFull = 0;
      try { if (this._useDbCache()) lastFull = Number(this._cacheStore.getKv('scan_full_at:' + this.root) || 0) || 0; } catch (e) { lastFull = 0; }
      if (lastFull && (Date.now() - lastFull) < SCAN_FULL_MIN_INTERVAL_MS) return;
      // 让路/中断：**只在有任务运行/排队时**中断（执行层）——
      // 前台活动只影响"何时开始"（队列调度层的 _idleKick），不该让已经开始的重扫半途而废。
      const shouldStop = () => {
        try { return !!(this.hasRunningTask() || this.hasQueuedTask()); } catch (e) { return false; }
      };
      const _t = Date.now();
      let rebuilt = false;
      try {
        try { await this._collectAllTxtAsync({ force: true, shouldStop }); rebuilt = true; } catch (e) {}
        try { await this._collectLogFilesAsync({ force: true, shouldStop }); } catch (e) {}
      } catch (e) { /* 重建失败不记时间，留待下次空闲重试 */ }
      if (!rebuilt) return;                                          // 被中断：不记时间，下次继续补
      try { if (this._useDbCache()) this._cacheStore.setKv('scan_full_at:' + this.root, String(Date.now())); } catch (e) {}
      this._projectsCache = null;
      try { this._emitTasks(); } catch (e) {}
      this._notifyTreeChanged();   // 后台重建完成 → 前端重拉列表（外部改动/自愈的最终可见结果）
      try {
        if (this._lg) this._lg('MOD', 'scan.verify',
          '空闲期已重建配置/日志索引（无条件重扫，不依赖目录树指纹）· ' + (Date.now() - _t) + 'ms',
          { ms: Date.now() - _t });
      } catch (e) {}
    });
  }

  // 配置 TXT 树持久化（cache_kv，键 txt_tree:<root>）：存 { fp, items }
  // fp 为"上次扫描时目录长什么样"的记录，仅供排查；读取不再做指纹比对
  // （指纹粒度与写入粒度不匹配，比对反而会命中旧值）——校验统一交给 _enqueueScanVerify。
  // 读取入口：_cachedTxtTree()（连指纹都不算）。

  _saveTxtTree(items, fp) {
    if (!this._useDbCache()) return;
    try {
      this._cacheStore.setKv('txt_tree:' + this.root, JSON.stringify({ fp: fp || '', items: items || [] }));
    } catch (e) {}
  }

  // ── 启动期只读缓存（「直接用缓存里的内容渲染前端，不要动 磁盘，
  //    哪怕 磁盘里的内容全没了，也是之后再自愈/重新检测的事」）──
  // 缓存命中 → 立即返回；**缓存没有 → 返回 null，由调用方按空列表渲染**，绝不回退到扫描。
  // 扫描一律走空闲队列（后台、串行、节流），完成后刷新界面 —— 不引入任何"等待/静默期"冻结。
  _cachedTxtTree() {
    if (this._txtTree && this._txtTreeRoot === this.root) return this._txtTree;
    const raw = this._txtTreeCacheRaw();
    if (raw) {
      this._txtTree = raw.items;
      this._txtTreeRoot = this.root;
      this._enqueueScanVerify();
      return raw.items;
    }
    return null;
  }

  _cachedLogFiles() {
    if (this._logCache && this._logCacheRoot === this.root) return this._logCache;
    this._loadLogCache();
    if (this._logCache && this._logCacheRoot === this.root && this._logCache.files && this._logCache.files.length) {
      this._enqueueScanVerify();
      return this._logCache;
    }
    return null;
  }

  // 缓存缺失（首次运行 / 新机器 / 缓存被清）→ 后台重建（扫描在空闲队列里做，不阻塞渲染）
  _enqueueScanRebuild() {
    this._verifyEnqueue('scanrebuild', this.root, async () => {
      try {
        try { await this._collectAllTxtAsync({ force: true }); } catch (e) {}
        try { await this._collectLogFilesAsync({ force: true }); } catch (e) {}
      } catch (e) { /* 失败留待下次空闲重试 */ }
      this._projectsCache = null;
      try { this._emitTasks(); } catch (e) {}
      this._notifyTreeChanged();   // 通知前端重拉项目/配置列表（否则界面继续吃旧列表）
      try {
        if (this._lg) this._lg('ADD', 'scan.rebuild', '配置树/日志索引缺失 → 已后台重建并刷新界面', { root: this.root });
      } catch (e) {}
    });
  }


  // 配置树/日志索引发生实质变化后通知前端重拉列表（main 注入 onVersionsChanged → versions_changed）
  _notifyTreeChanged() {
    try { if (typeof this.onVersionsChanged === 'function') this.onVersionsChanged(); } catch (e) {}
  }

  // 扫描缓存是否新鲜（毫秒级）：仅比对目录树指纹，不做任何遍历。
  // 供 main 判断「启动是否需要弹扫描小窗」——命中则连小窗都不必出现。
  // 扫描缓存是否新鲜（异步版，启动专用）：判定缓存是否可直接用。
  // 启动期走「快速路径」——只读库、**不算目录树指纹**（指纹要 stat 素材盘，冷态就是那几十秒的来源），
  // 有缓存即视为新鲜，真正的校验排入空闲队列（_enqueueScanVerify）；退出快速路径后才比对指纹。
  // 目录树指纹走 fs.promises —— **绝不阻塞主进程事件循环**（同步版曾冻结 117 秒）。
  // 分段耗时写入 this._lastFreshTiming（{ db, fp, kv, total } 毫秒），由 main 落进 app.timing。
  async isScanCacheFreshAsync() {
    const timing = { db: 0, fp: 0, kv: 0, total: 0 };
    const _all = process.hrtime.bigint();
    const _ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    // 判定结果落进 _lastFreshTiming.reason：缓存命中（hit:idx / hit:tree）或未命中的具体分支。
    // 未命中时把关键量（fp 长度、缓存 fp、kv 长度）一并带上，便于一次冷启动就定位到根因。
    let reason = '';
    try {
      if (!this.root) { reason = 'no-root'; return false; }
      let t0 = process.hrtime.bigint();
      const useDb = this._useDbCache();
      timing.db = _ms(t0);
      if (!useDb) { reason = 'no-db'; return false; }
      // **不算指纹（默认行为）**：指纹要 stat 根 + 各一级目录，冷态机械盘上就是那几十秒的来源。
      // 有持久化缓存即视为新鲜 → 主窗口直接显示、扫描小窗不弹；
      // 真正的校验交给空闲队列（_enqueueScanVerify：无条件重扫 + 频率控制 + 前台让路），
      // 发现变化再重建并刷新界面（自愈）。只有用户主动刷新（force）才真扫。
      t0 = process.hrtime.bigint();
      const rawIdx = this._cacheStore.getKv('log_index:' + this.root);
      const rawTree = this._cacheStore.getKv('txt_tree:' + this.root);
      timing.kv = _ms(t0);
      timing.idxLen = rawIdx ? rawIdx.length : 0;
      timing.treeLen = rawTree ? rawTree.length : 0;
      if (rawIdx || rawTree) { this._enqueueScanVerify(); reason = 'hit:cache'; return true; }
      reason = 'no-cache';
      return false;
    } catch (e) {
      reason = 'throw:' + ((e && e.message) || e);
      return false;
    } finally {
      timing.total = _ms(_all);
      timing.reason = reason;
      this._lastFreshTiming = timing;
    }
  }

  // 是否已有完整的项目列表结果（供 main 判断「唤起时是否还需要扫描」）
  get hasProjectsCache() { return !!this._projectsCache; }

  // ── 异步扫描路径（启动专用）──
  // 与同步版同语义，但全程用 fs.promises + 分片让位，不阻塞主进程事件循环。
  // 缓存未命中（首次启动 / 目录结构变化）时走这里，窗口可先显示、扫描期间 UI 不卡。
  async _collectAllTxtAsync(opts) {
    const force = !!(opts && opts.force);
    // **缓存优先（默认行为）**：内存 → 持久化缓存直接用，并排入空闲队列做后台校验；
    // 仅「缓存缺失」或 force（用户主动刷新配置）才真扫 —— 启动与运行同一条路。
    if (!force) {
      const cached = (this._txtTree && this._txtTreeRoot === this.root) ? this._txtTree : this._cachedTxtTree();
      if (cached) { this._enqueueScanVerify(); return cached; }
    }
    // 只有真要扫时才计算指纹（读取路径不算 —— 那是"启动期零 IO"的前提）：
    // 指纹随扫描结果一起落库，仅作为"上次扫描时目录长什么样"的记录。
    const fp = await this._logTreeFingerprintAsync();
    this._loadScanCache();
    const out = [];
    const active = new Set();
    const onTick = (opts && opts.onTick) || null;
    const shouldStop = (opts && opts.shouldStop) || null;
    let stopped = false;   // 被中断（用户操作/任务抢占）→ 本次结果不落盘，避免残缺覆盖完整缓存
    let rootOk = false;
    try { const st = await fs.promises.stat(this.root); rootOk = st.isDirectory(); } catch (e) { rootOk = false; }
    if (rootOk) {
      let entries = [];
      try { entries = await fs.promises.readdir(this.root); } catch (e) { entries = []; }
      for (const name of entries) {
        if (shouldStop && shouldStop()) { stopped = true; break; }
        if (name.startsWith('.') || name.startsWith('_')) continue;
        if (EXCLUDED_TOP_DIRS.has(name)) continue;
        const pdir = path.join(this.root, name);
        let isDir = false;
        try { isDir = (await fs.promises.stat(pdir)).isDirectory(); } catch (e) { isDir = false; }
        if (!isDir) continue;
        const files = await walkFilesAsync(pdir, { onTick, shouldStop });
        for (const full of files) {
          if (!path.basename(full).toLowerCase().endsWith('.txt')) continue;
          if (LOG_NAME_RE.test(path.basename(full))) continue;
          if (BACKUP_NAME_RE.test(path.basename(full))) continue;
          let st2;
          try { st2 = await fs.promises.stat(full); } catch (e) { continue; }
          const mtimeMs = st2.mtimeMs, size = st2.size;
          const hash = await this._hashForAsync(full, mtimeMs, size);
          active.add(this._scanKey(full));
          const rel = path.relative(pdir, path.dirname(full));
          const parts = rel === '' ? [] : rel.split(path.sep);
          out.push({ pdir, name: path.basename(full, path.extname(full)), full, parts, mtimeMs, size, hash });
        }
      }
    }
    this._txtTree = out;
    this._txtTreeRoot = this.root;
    // ⚠ 被中断（用户操作/任务抢占）时**不落盘**：残缺结果会覆盖掉完整缓存，导致别的项目凭空消失。
    // 下次空闲会自动再补一次（job 未记 last_full_at）。
    this._txtTreeTruncated = stopped;
    if (this._scanDirty) {
      const prefix = this.root + '\n';
      for (const k of [...this._scanCache.keys()]) {
        if (k.startsWith(prefix) && !active.has(k)) { this._scanCache.delete(k); this._scanRemovedKeys.add(k); }
      }
      this._scanDirty = false;
      this._saveScanCache();
    }
    if (!stopped) this._saveTxtTree(out, fp);   // ★ 被中断则不写缓存（避免残缺结果覆盖完整数据）
    return out;
  }

  // 异步指纹：命中 (mtime,size) 直接复用；未命中才读文件内容算 hash，并周期性让位
  async _hashForAsync(full, mtimeMs, size) {
    this._loadScanCache();
    const key = this._scanKey(full);
    const cached = this._scanCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash;
    let h = null;
    try { h = crypto.createHash('md5').update(await fs.promises.readFile(full)).digest('hex'); } catch (e) { h = null; }
    this._scanCache.set(key, { mtimeMs, size, hash: h });
    this._scanDirty = true;
    this._scanDirtyKeys.add(key);
    return h;
  }

  // 异步版 listProjects：缓存命中时与同步版等价（毫秒级）；未命中走异步扫描，不阻塞主进程。
  // 返回值与 listProjects 完全一致（供 IPC / HTTP 路由替换）。
  // 前台活动打点：渲染/读取等前台请求会让空闲队列让路（照预检测的「行内优先、后台让路」）
  _touchForeground() { this._lastForegroundAt = Date.now(); }

  async listProjectsAsync(force = false, opts) {
    this._touchForeground();
    if (force) {
      this._emitScan('clear');
      // force = 用户主动「刷新配置」：读取端天然绕过缓存（force 透传给收集器），此处只做必要清场。
      // 只清内存缓存、**持久化缓存保留**：异步扫描期间旧数据仍可兜底（扫描完成后覆盖写回；
      // 即使扫描中断也不会把列表清空）。
      this._invalidateCaches(false);
      this._rebuildClipIndexAsync();
      try { setImmediate(() => { this._emitScan('mark'); this._warmWatermarkCache(); }); } catch (e) {}
    }
    if (!force && this._projectsCache) return this._projectsCache;
    // 并发合并：启动预热、托盘唤起、前端 IPC / HTTP 首次加载几乎同时调用，
    // 不合并则同一份扫描并发跑多遍（各自遍历工作目录 + 读文件），冷态下代价成倍放大。
    if (!force && this._projectsInflight) return this._projectsInflight;
    const seq = this._projectsSeq || 0;
    // ⚠ force 必须**透传给收集器**：否则它们会「指纹未变 → 命中持久化缓存」，
    //   刷新等于什么都没做（新增配置位于日期子目录，只改变子目录 mtime，一级目录指纹发现不了）。
    const copts = force ? Object.assign({}, opts, { force: true }) : opts;
    const run = (async () => {
      this._emitScan('walk');
      await this._collectLogFilesAsync(copts);
      this._emitScan('log');
      await this._collectAllTxtAsync(copts);
      this._emitScan('list');
      const data = this._buildProjectsData();
      if (seq === (this._projectsSeq || 0)) this._projectsCache = data;   // 期间被 force 刷新过则丢弃本次结果
      return data;
    })();
    if (!force) {
      this._projectsInflight = run;
      const clear = () => { if (this._projectsInflight === run) this._projectsInflight = null; };
      run.then(clear, clear);
    }
    return run;
  }

  // 异步版日志收集：**缓存优先（默认）**；缓存缺失或 force 才异步遍历
  async _collectLogFilesAsync(opts) {
    const forceA = !!(opts && opts.force);
    if (!forceA) {
      const cached = (this._logCache && this._logCacheRoot === this.root) ? this._logCache : this._cachedLogFiles();
      if (cached && cached.files && cached.files.length) { this._enqueueScanVerify(); return cached; }
    }
    const files = [];
    let rootOk = false;
    try { rootOk = (await fs.promises.stat(this.root)).isDirectory(); } catch (e) { rootOk = false; }
    if (rootOk) {
      const skip = new Set(EXCLUDED_TOP_DIRS);
      const all = await walkFilesAsync(this.root, opts);
      for (const full of all) {
        const base = path.basename(full);
        if (!base.toLowerCase().endsWith('.txt')) continue;
        if (!LOG_NAME_RE.test(base)) continue;
        const config = this._configNameFromLog(full);
        if (!config) continue;
        const rel = path.relative(this.root, full).split(path.sep);
        if (skip.has(rel[0])) continue;
        files.push({ project: rel[0], name: base, path: full, date: this._dateBranchOf(full), config });
      }
    }
    this._logCache = { files, fp: await this._logTreeFingerprintAsync() };
    this._logCacheRoot = this.root;
    this._saveLogCache();
    return this._logCache;
  }

  // 扫描/重建环节状态上报：phase ∈ clear/walk/log/clip/mark/list/done，前端按阶段映射中文提示
  _emitScan(phase, done, total) {
    if (typeof this.onScanProgress !== 'function') return;
    try { this.onScanProgress({ phase: String(phase || ''), done: done || 0, total: total || 0 }); } catch (e) {}
  }

  listProjects(force = false) {
    if (force) {
      this._emitScan('clear');
      // 同 listProjectsAsync：force 由读取端绕过缓存，此处只清内存缓存、保留持久化兜底
      this._invalidateCaches(false);
      // 重建成片索引：后台分批重建（解析日志+写大缓存），不阻塞本次列表返回；搜索仍走按目录惰性命中
      this._rebuildClipIndexAsync();
      // 刷新配置时预填充水印缓存：缺失项目归属补算，已有条目不动（后台，不阻塞本次列表返回）
      try { setImmediate(() => { this._emitScan('mark'); this._warmWatermarkCache(); }); } catch (e) {}
    }
    if (!force && this._projectsCache) {
      return this._projectsCache;
    }
    this._emitScan('walk');
    this._collectLogFiles(force); // 刷新配置时一并收集日志 txt 缓存（force 透传：真扫）
    this._emitScan('log');
    const data = this._buildProjectsData(force);
    this._emitScan('list');
    this._projectsCache = data;
    return data;
  }

  // ── 项目登记表：软件内新建、但还没有任何 TXT 配置的项目 ──
  // 为什么需要：项目列表由「扫描到的 TXT」按 pdir 反推（见 _buildProjectsData），
  //   从软件新建的项目在用户放素材前没有任何 TXT，靠扫描永远不出现；而用户点完
  //   「添加新项目」就该立刻看到它 —— 故把这类项目登记进 cache_kv（键 proj_reg:<工作根>）。
  // 自愈：外部把目录删了（手动清理 / 换工作路径 / 盘符变动），下次重建列表时用 existsSync
  //   核验登记项，目录不在即摘除登记（与缓存 GC 里 txt_tree 的处理同一思路）。
  // ⚠ 只登记「名字」，路径一律由对应的根现拼 —— 换工作路径后登记表不会张冠李戴。
  // ⚠ batch 与 mask 是【两套不同的工作根】，登记表必须按 kind 分开存：
  //   键 = proj_reg:<kind>:<工作根>（kind = batch | mask）
  _projRegKey(root, kind) { return root ? ('proj_reg:' + (kind || 'batch') + ':' + root) : ''; }
  _loadProjReg(root, kind) {
    const k = this._projRegKey(root, kind);
    if (!k) return [];
    if (!this._projRegMem) this._projRegMem = {};
    if (!this._useDbCache()) return this._projRegMem[k] || [];
    try {
      const raw = this._cacheStore.getKv(k);
      const o = raw ? JSON.parse(raw) : null;
      return (o && Array.isArray(o.names)) ? o.names.map(String).filter(Boolean) : (this._projRegMem[k] || []);
    } catch (e) { return this._projRegMem[k] || []; }
  }
  _saveProjReg(root, kind, names) {
    const uniq = Array.from(new Set((names || []).map((x) => String(x || '').trim()).filter(Boolean)));
    const k = this._projRegKey(root, kind);
    if (!k) return;
    if (!this._projRegMem) this._projRegMem = {};
    this._projRegMem[k] = uniq;                 // 内存兜底：库缓存不可用时本会话内仍生效
    if (!this._useDbCache()) return;
    try { this._cacheStore.setKv(k, JSON.stringify({ names: uniq })); } catch (e) {}
  }
  _addProjReg(root, kind, name) {
    const n = String(name || '').trim();
    if (!n) return;
    const cur = this._loadProjReg(root, kind);
    if (!cur.includes(n)) { cur.push(n); this._saveProjReg(root, kind, cur); }
  }
  _removeProjReg(root, kind, name) {
    const n = String(name || '').trim();
    if (!n) return;
    const cur = this._loadProjReg(root, kind);
    if (cur.includes(n)) this._saveProjReg(root, kind, cur.filter((x) => x !== n));
  }
  // 核验登记项（批量侧）：目录仍在 → 保留登记（并回报其中「扫描结果里没有的」= 待合并的新建项目）；
  // 目录已消失 → 就地摘除（自愈）。
  _survivingProjReg(scannedNames) {
    const reg = this._loadProjReg(this.root, 'batch');
    if (!reg.length) return [];
    const scanned = scannedNames || new Set();
    const alive = [], keep = [];
    for (const n of reg) {
      let ok = false;
      try { ok = fs.existsSync(path.join(this.root, n)); } catch (e) { ok = false; }
      if (ok) { keep.push(n); if (!scanned.has(n)) alive.push(n); }
    }
    if (keep.length !== reg.length) this._saveProjReg(this.root, 'batch', keep);
    return alive;
  }

  _buildProjectsData(force) {
    // 未配置工作路径：项目列表为空（连"复刻"虚拟项目也不显示），交给前端引导态
    if (!this.root) return [];
    const all = this._collectAllTxt(force);
    const byProject = new Map();
    for (const t of all) {
      if (!byProject.has(t.pdir)) byProject.set(t.pdir, []);
      byProject.get(t.pdir).push(t);
    }
    const dupNames = this._dupNames();
    const projects = [];
    for (const [pdir, txs] of byProject) {
      const names = [...new Set(txs.map((t) => t.name))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const txts = [];
      for (const name of names) {
        const versions = this._buildVersionsFromList(name, txs);
        const latest = versions.length ? versions[0].label : '';
        // 最新版本无素材路径 → 空白配置（侧栏置顶排序依据）；带水印/排除仍视为空白
        let empty = false;
        if (versions.length) {
          try {
            // peek：列表渲染只需知道"是否空配置"，缓存未命中时**不读文件**（渲染路径不该有磁盘读）
            const cfg = this.readConfig(versions[0].path, { peek: true });
            // ⚠ 只有**命中缓存**的 peek 才可信：未命中时 readConfig 返回乐观结构（带 `_peek`），
            //   此时"读不出素材路径"只代表**这份配置还没被读过**，不代表它是空白配置。
            //   不区分就会踩这个坑：任务把配置移入成片文件夹后，正本路径从未被读取过 → 被判成
            //   「空白配置」→ 前端「空白配置恒置顶」生效 → 表现为「刷新后置顶、再刷新才回位」
            //   （且与缓存是否刷新无关，所以前几次修缓存都不见效）。
            if (cfg && !cfg._peek) {
              empty = !(cfg.folders || []).some((f) => String(f && typeof f === 'object' ? f.path : f).trim() !== '');
            }
          } catch (e) {}
        }
        txts.push({ name, latest, count: versions.length, dup: dupNames.has(name), empty });
      }
      let mtime = 0;
      // 项目 mtime：用缓存里各 TXT 的 mtime 聚合（前端只拿它做排序，语义足够），
      // **不 stat 项目目录** —— 列表渲染路径保持零磁盘访问，与是否"启动期"无关。
      for (const t of txs) mtime = Math.max(mtime, Number(t.mtimeMs) || 0);
      projects.push({ name: path.basename(pdir), mtime, txts });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    // 合并「软件内新建、尚无 TXT」的项目（项目登记表）：扫描结果里已有的同名项跳过，
    // 其余作为空项目加入 —— 用户从软件新建后立刻可见（登记表方法见上方说明）
    const _scannedNames = new Set(projects.map((p) => p.name));
    for (const nm of this._survivingProjReg(_scannedNames)) {
      projects.push({ name: nm, mtime: 0, txts: [], isEmptyProject: true });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    // 追加“复刻”虚拟项目：其下两个配置名对应两种复刻模式，仅含日志无配置
    projects.push(this._buildReplicaProject());
    return projects;
  }

  _buildReplicaProject() {
    const txts = REPLICA_MODES.map((mode) => {
      const files = this._replicaLogFiles(mode);
      const latest = files.length ? path.basename(files[files.length - 1]).slice(0, 4) : '';
      return { name: mode, latest, count: files.length, dup: false, replica: true };
    });
    return { name: REPLICA_PROJECT, mtime: 0, txts, replica: true };
  }

  _dupNames() {
    const counter = new Map();
    const seenByProject = new Map();
    for (const t of this._collectAllTxt()) {
      if (!seenByProject.has(t.pdir)) seenByProject.set(t.pdir, new Set());
      seenByProject.get(t.pdir).add(t.name);
    }
    for (const names of seenByProject.values()) {
      for (const n of names) counter.set(n, (counter.get(n) || 0) + 1);
    }
    return new Set([...counter.entries()].filter(([, c]) => c > 1).map(([n]) => n));
  }

  // 从配置树缓存派生版本列表（零磁盘 IO）：项目列表页本来就是这么取版本的，
  // 这里让 listVersions 在启动期也走同一条路。
  _versionsFromTreeCache(project, name) {
    const all = this._cachedTxtTree();
    if (!Array.isArray(all) || !all.length) return null;
    const pdir = path.join(this.root, project);
    const txs = all.filter((t) => t.pdir === pdir && t.name === name);
    if (!txs.length) return null;
    try { return this._buildVersionsFromList(name, txs); } catch (e) { return null; }
  }

  // ⚠ force 的语义（**这条是性能红线，别随手改成恒真**）：
  //   · 默认 false = 走日志索引缓存。**启动/渲染路径必须用它** ——
  //     P0-基线/verify-bootio.js 断言「版本/配置路径对素材盘的访问为 0 次」，
  //     恒真会让启动预热直接打出上千次素材盘 IO（实测 1771 次，断言当场失败）。
  //   · true = 合并前无条件真扫日志索引（约 200ms）。只给**用户主动打开/切换配置**用 ——
  //     那里的 hasLog 会驱动前端「覆盖当前配置」按钮的禁用，必须基于磁盘真相，
  //     否则会出现"日志已经删了、按钮却仍然禁用"的死局。
  listVersions(project, name, force) {
    // **缓存优先**：能从配置树缓存派生就直接返回（零磁盘访问）；
    // 缓存里没有（首次运行 / 刚新建的配置）才落到下面的目录扫描兜底 ——
    // 那是「用户主动打开某配置」的路径，允许读盘；启动渲染路径（项目列表）不经过这里。
    const fromCache = this._versionsFromTreeCache(project, name);
    // 每版本是否有可跳日志（缓存命中路径也必须算，否则前端恒判「配置没有对应日志」）。
    // ⚠ hasLog **只在 force 时计算**，非 force 一律留空（[] → 逐版本判定为 false）：
    //   `_collectLogFiles()` 是「**缓存优先**」而非「缓存必需」—— 日志索引缓存尚未建立时
    //   （启动预热就是这样）它照样真扫。实测：即便不传 force，这一步也会打出 2 次素材盘 IO，
    //   足以让「启动期零素材盘访问」的断言失败（P0-基线/verify-bootio.js）。
    //   消费方只在 force 路径需要 hasLog（打开/切换配置 → 驱动「覆盖当前配置」的禁用），
    //   其余路径拿到 false 无副作用：前端 !!(undefined) 本就是 false，行为等价。
    const logs = force ? this._collectLogFiles(true).files : [];
    if (fromCache) {
      fromCache.forEach((v) => { v.hasLog = this._versionHasLog(v, project, name, logs); });
      return fromCache;
    }
    const pdir = path.join(this.root, project);
    if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) return [];
    const key = this.root + '\u0000' + project + '\u0000' + name;
    if (this._versionsCache.has(key)) {
      // 自动失效：目录级指纹核对——成片夹/日期目录 mtime 变化（新增成片、外部 * 被挪走等）
      // 说明缓存树过期，失效重扫一次让版本列表自愈（排队任务渐进 -1/-2 无需手动刷新）
      if (this._versionsFp.get(key) === this._versionFingerprint(pdir, name)) {
        // 防御：命中缓存仍校验磁盘存在性（指纹秒级竞态等极端情况兜底），已删除/迁移的版本决不返回
        const cached = this._versionsCache.get(key);
        const alive = cached.filter((v) => { try { return fs.existsSync(v.path); } catch (e) { return false; } });
        if (alive.length === cached.length) return alive;
        this._versionsCache.set(key, alive);
        return alive;
      }
      this._invalidateCaches();
    }
    const versions = this._buildVersions(pdir, name);
    // 安全网：磁盘已不存在的版本（删除/迁移）一律过滤，缓存不再返回残留分支
    const alive = versions.filter((v) => { try { return fs.existsSync(v.path); } catch (e) { return false; } });
    // 每版本是否有可跳日志：配对锚点是「成片文件夹」
    //   - 成片内配置：仅当同一成片文件夹内存在对应日志才可跳
    //   - 外部(label含*)配置：当日有任何日志即可跳（多成片跳 -1、单成片跳唯一）
    alive.forEach((v) => { v.hasLog = this._versionHasLog(v, project, name, logs); });
    this._versionsCache.set(key, alive);
    this._versionsFp.set(key, this._versionFingerprint(pdir, name));
    return alive;
  }

  // 该配置所有相关目录（成片夹→日期→月份→项目，逐级上溯）的 mtime 摘要，作为版本列表自愈指纹。
  // mtime 对子目录/文件增减敏感：新增成片夹、外部 * 被挪走都会体现在父目录 mtime 上
  _versionFingerprint(pdir, name) {
    const pdirAbs = path.resolve(pdir);
    const target = name.toLowerCase();
    const dirs = new Set();
    for (const t of this._collectAllTxt()) {
      if (path.resolve(t.pdir) !== pdirAbs || t.name.toLowerCase() !== target) continue;
      let d = path.resolve(path.dirname(t.full));
      dirs.add(d);
      while (true) {
        const up = path.dirname(d);
        dirs.add(up);
        if (up === d || path.resolve(up) === pdirAbs) break;
        d = up;
      }
    }
    const arr = [...dirs].sort();
    const sig = arr.map((d) => { try { return fs.statSync(d).mtimeMs; } catch (e) { return null; } });
    return arr.join('|') + '\u0000' + sig.join(',');
  }

  _versionHasLog(v, project, name, logs) {
    const d = String(v.label || '').slice(0, 4);
    if (!/^\d{4}$/.test(d)) return false;
    const match = (f) => f.project === project && f.config === name && f.date === d;
    // ★ 0 字节日志不算「有日志」—— 与 _configHasEffectiveLog 必须是**同一口径**。
    //   为什么：hasLog 现在同时驱动两个决定 —— 前端据此**禁用「覆盖当前配置」**，
    //   后端 _configHasEffectiveLog 据此**拒绝覆盖请求**。两处不一致就会出现
    //   「按钮看起来禁用了、请求发出去却被放行」的错位。
    //   （实测踩过：16:40 那次紧急停止留下的空日志 → 前端判有日志、后端判无 → 覆盖被放行，
    //     配置内容被清空。两处统一为"非空才算"后，前后端一致。）
    //   空日志没有配对价值（复刻读它同样是空），忽略它不会削弱复刻的配对保护。
    const alive = (f) => { try { return fs.statSync(f.path).size > 0; } catch (e) { return false; } };
    if (v.isExternal) return logs.some((f) => match(f) && alive(f));
    // 成片内：必须与配置位于同一成片文件夹的日志才能跳
    const cfgDir = path.dirname(v.path);
    return logs.some((f) => match(f) && path.dirname(f.path) === cfgDir && alive(f));
  }

  _buildVersions(projectDir, name) {
    const txs = this._collectAllTxt().filter((t) => t.pdir === projectDir);
    return this._buildVersionsFromList(name, txs);
  }

  _buildVersionsFromList(name, txs) {
    const target = name.toLowerCase();
    const sources = [];
    const copies = [];
    for (const t of txs) {
      if (t.name.toLowerCase() !== target) continue;
      if (isChengpianFile(t.parts)) copies.push({ full: t.full, parts: t.parts, hash: t.hash });
      else sources.push({ full: t.full, parts: t.parts, hash: t.hash });
    }
    const groups = new Map();
    // 顺序稳定化：
    // txs 可能来自「增量并入」（新条目追加在末尾）或「全量扫描」（目录遍历序），两者顺序不同，
    // 会让下面 dedupeByDir 的 -1/-2 编号互换 → 同一份配置在两次刷新间位置跳动。
    // 按路径排序即与全量扫描一致，读取路径与刷新结果因此恒定。
    const byFull = (a, b) => String(a.full).localeCompare(String(b.full), 'zh-CN');
    sources.sort(byFull);
    copies.sort(byFull);
    for (const s of sources) {
      const label = relativeDateLabel(s.parts);
      if (!groups.has(label)) groups.set(label, { source: null, copies: [] });
      groups.get(label).source = s;
    }
    for (const c of copies) {
      const label = relativeDateLabel(c.parts);
      if (!groups.has(label)) groups.set(label, { source: null, copies: [] });
      groups.get(label).copies.push(c);
    }
    const versions = [];
    const labels = [...groups.keys()].sort((a, b) => compareDateSortKey(b, a));
    for (const label of labels) {
      const g = groups.get(label);
      // 同一日期分支下，按「成片文件夹」去重（每夹一份配置，目录含时间，升序即旧→新）：
      //   - 多个成片文件夹 → 全部序号化，最旧 = <MMdd>-1，依次 -2…（无无后缀正本）
      //   - 单个成片文件夹 → 无后缀正本 <MMdd>
      //   - 成片文件夹外的单独配置 → <MMdd>*（isExternal）
      const chengpian = dedupeByDir(g.copies);
      // 外部 * 配置若与任一成片文件夹正本内容完全一致，则被正体覆盖，不再显示（不一致时才同时显示）
      const outsideSrc = g.source;
      const outside = outsideSrc && !chengpian.some((c) => c.hash === outsideSrc.hash) ? [outsideSrc] : [];
      if (chengpian.length > 1) {
        chengpian.forEach((c, i) => versions.push({ label: `${label}-${i + 1}`, path: c.full, isExternal: false }));
      } else if (chengpian.length === 1) {
        versions.push({ label, path: chengpian[0].full, isExternal: false });
      }
      outside.forEach((s) => versions.push({ label: `${label}*`, path: s.full, isExternal: true }));
    }
    versions.forEach((v, i) => { v.is_latest = i === 0; });
    return versions;
  }

  // 清理历史遗留的重复外部 * 配置：仅当「同项目+同配置名+同日期分支」有成片文件夹正本，
  // 且正本与外部 * 内容 hash 完全一致时才删除该外部 *。按 label 分组隔离，不影响其他日期分支。
  // commit=false 仅扫描报告；commit=true 物理删除（菜单「刷新配置列表」清理历史残留）
  cleanDuplicateStar(commit) {
    const groups = new Map(); // key = 项目\0配置名\0日期label -> { copies: [], sources: [] }
    for (const t of this._collectAllTxt()) {
      const label = relativeDateLabel(t.parts);
      if (!label) continue;
      const key = t.pdir + '\u0000' + t.name + '\u0000' + label;
      if (!groups.has(key)) groups.set(key, { copies: [], sources: [] });
      const g = groups.get(key);
      (isChengpianFile(t.parts) ? g.copies : g.sources).push(t);
    }
    const pending = [];
    const deleted = [];
    for (const g of groups.values()) {
      if (!g.copies.length) continue;
      for (const s of g.sources) {
        const dup = g.copies.some((c) => c.hash === s.hash);
        if (!dup) continue;
        pending.push(s.full);
        if (commit) {
          this._recycleFile(s.full);
          deleted.push(s.full);
        }
      }
    }
    if (commit && deleted.length) {
      const info = this._describeForLog(deleted);
      this._lg('DEL', 'clean.duplicate.sources',
        '清理重复星标素材 · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes), info);
      this._markConfigModified();
    }
    return { ok: true, pending, deleted };
  }

  // 配置内容缓存（「将需要 io 的部分全部缓存化，txt 路径以及里面的全部内容」）：
  //   打开配置 = 一次主键查询 + **一次 stat 校验**，内容直接取缓存（免读整份文件、免解析）；
  //   指纹不同才回退读文件并更新缓存（否则每次打开都要读全文件 + 解析，IO 为 O(文件大小)）。
  _configFromCacheRow(filePath, row) {
    const raw = row.raw || '';
    let parsed = {};
    try { parsed = JSON.parse(row.parsed || '{}') || {}; } catch (e) { parsed = {}; }
    return {
      path: filePath,
      raw,
      lines: raw.split(/\r?\n/),
      folders: parsed.folders || [],
      excludes: parsed.excludes || [],
      watermark: parsed.watermark || '',
      name: parsed.name || path.basename(filePath, path.extname(filePath)),
      _cached: true,
    };
  }

  // 纯解析（无 IO）：从原文得出 folders / excludes / watermark / name
  _parseConfigText(filePath, text) {
    const lines = String(text || '').split(/\r?\n/);
    const folders = [];
    const excludes = [];
    let watermark = '';
    for (const ln of lines) {
      const s = ln.trim();
      if (!s) continue;
      if (s.startsWith('=')) folders.push({ path: stripQuotes(s.slice(1)), nonround: true });
      else if (s.startsWith('-')) excludes.push(stripQuotes(s.slice(1)));
      else folders.push({ path: stripQuotes(s), nonround: false });
    }
    if (folders.length) {
      const last = folders[folders.length - 1];
      if (last.path.toLowerCase().endsWith('.png') && !last.nonround) watermark = stripQuotes(folders.pop().path);
    }
    return { folders, excludes, watermark, name: path.basename(filePath, path.extname(filePath)) };
  }

  _configFingerprint(filePath) {
    try { const st = fs.statSync(filePath); return String(st.mtimeMs) + ':' + String(st.size); } catch (e) { return ''; }
  }

  _putConfigCache(filePath, text, parsed) {
    const store = this._useDbCache() ? this._cacheStore : null;
    if (!store || typeof store.txtPut !== 'function') return;
    try { store.txtPut(filePath, this._configFingerprint(filePath), text, JSON.stringify(parsed), Date.now()); } catch (e) {}
  }

  readConfig(filePath, opts) {
    this._touchForeground();
    filePath = path.resolve(filePath);
    const peek = !!(opts && opts.peek);
    const store = this._useDbCache() ? this._cacheStore : null;
    const row = (store && typeof store.txtGet === 'function') ? store.txtGet(filePath) : null;
    if (row && row.parsed) {
      // peek（项目列表渲染：只想知道"这份配置是不是空的"）：直接信缓存、**不做 stat** ——
      // 列表渲染路径必须零磁盘访问。免 IO 的依据是**调用方语义**，不是"是否启动期"。
      if (peek) return this._configFromCacheRow(filePath, row);
      // 正常打开配置：缓存 + 一次 stat 校验（指纹一致即免读整份文件、免解析）
      const fp = this._configFingerprint(filePath);
      if (fp && fp === row.fp) return this._configFromCacheRow(filePath, row);
    }
    // peek 且无缓存：给乐观结构（非空），**不读文件** —— 同上，渲染路径不该有磁盘 IO
    if (peek) {
      return { path: filePath, raw: '', lines: [], folders: [{ path: '', nonround: false }], excludes: [], watermark: '', name: path.basename(filePath, path.extname(filePath)), _peek: true };
    }
    const text = readText(filePath);
    const parsed = this._parseConfigText(filePath, text);
    // 文件不存在（stat 失败）时**不落缓存**：否则会把"不存在"缓存成空内容，掩盖之后新建的同名配置
    if (this._configFingerprint(filePath)) this._putConfigCache(filePath, text, parsed);
    return Object.assign({ path: filePath }, parsed, { raw: text, lines: text.split(/\r?\n/) });
  }

  _rewriteText(folders, excludes, watermark) {
    const out = [];
    for (const f of folders) {
      const isDict = f && typeof f === 'object';
      const p = (isDict ? f.path : f).trim();
      if (!p) continue;
      const nonround = isDict ? !!f.nonround : false;
      out.push(nonround ? '=' + p : p);
    }
    for (const e of excludes) { const s = e.trim(); if (s) out.push('-' + s); }
    if (watermark && watermark.trim()) { out.push(''); out.push(watermark.trim()); }
    return out.join('\r\n') + '\r\n';
  }

  // 「该配置是否已有**有效**日志」—— 配置与日志强联动判定的唯一入口（改名、覆盖保存共用）。
  // 为什么必须走真扫、且必须忽略 0 字节日志：
  //   ① **真扫**：这里要拿结论去**拒绝用户**，依据只能是磁盘真相。`_collectLogFiles()` 默认优先
  //      返回内存/持久化缓存（769-776），后台校验又受 60 秒频率控制；持久化缓存的指纹只覆盖
  //      「一级项目目录」的 mtime（_logTreeFingerprint），用户删掉成片子目录里的日志**根本改不动它**。
  //      实测后果：用户照着提示"先处理掉日志"、文件确实删了，判定仍是"有日志"，改不动也覆盖不了。
  //      本判定只出现在用户主动操作（改名/保存）路径上，非渲染路径，真扫代价可接受；
  //      真扫会回写缓存，同一次操作里的后续查询一并受益。
  //   ② **空日志不算**：0 字节日志没有任何配对价值（复刻读它同样是空），却会把两条出口全堵死 ——
  //      而紧急停止/失败留下的恰恰就是这种空日志（引擎建了文件、首片没做完就中断，
  //      一个字都没写进去，见 batch/index.js:938 建空文件、1429 每完成一片才追加）。
  // 配对范围与 _versionHasLog 保持一致：成片内配置只认同目录的日志；外部 * 配置放宽到当天任意位置。
  _configHasEffectiveLog(abs, project, baseName, dir) {
    try {
      this._collectLogFiles(true);                        // ← 无条件真扫：先把缓存刷成磁盘真相
      const logs = (this._collectLogFiles().files) || [];  // 刚真扫过，此处内存缓存即真相
      const v = (this.listVersions(project, baseName) || [])
        .find((x) => x && x.path && path.resolve(x.path).toLowerCase() === path.resolve(abs).toLowerCase());
      const pairing = logs.filter((f) => f.project === project
        && String(f.config || '').trim() === baseName
        && ((v && v.isExternal) ? true : path.dirname(f.path).toLowerCase() === path.resolve(dir).toLowerCase()));
      // 判空只对"配对上的这少数几条"做 stat，代价可忽略
      return pairing.some((f) => { try { return fs.statSync(f.path).size > 0; } catch (e) { return false; } });
    } catch (e) { return false; }
  }

  // 就地改名**当前这一个**配置文件。两条边界：
  //   ① 不做「配置级改名」（把该配置在其它日期分支的历史版本一并改名）—— 那会把"把这个文件改对"
  //      变成"整个配置换名"，与场景不符（用户只是在某个日期分支发现名字不对）。
  //   ② **有对应日志即拒绝**：日志文件名里嵌着配置名（MMdd-HH时MM分-配置名-拼接日志.txt），
  //      两者强联动（复刻要按名字配对读日志）。与其改名时连带搬日志（动到日志风险更大），
  //      不如只允许「本来就没有日志可断」的配置改名 —— 判断依据就是现成的 hasLog。
  _renameConfigFile(filePath, newName) {
    const abs = path.resolve(filePath);
    const ext = path.extname(abs) || '.txt';
    const oldBase = path.basename(abs, ext);
    const bad = this._validProjectName(newName);
    if (bad) return { ok: false, error: bad };
    const dir = path.dirname(abs);
    const dest = path.join(dir, newName + ext);
    try { if (fs.existsSync(dest)) return { ok: false, error: '该目录下已有同名配置：' + newName }; } catch (e) {}
    // 有对应日志 → 拒绝改名：日志与配置按名字配对，改名会让这份日志再也配不上本配置
    const project = this._projectOf(abs);
    const hasLog = this._configHasEffectiveLog(abs, project, oldBase, dir);
    if (hasLog) {
      return { ok: false, error: '该配置已有对应日志（配置与日志按名字配对，复刻依赖它），改名会让日志失去关联；如需改名请先处理掉日志' };
    }
    // 任务占用保护：非终态任务把它记在 env.REPLICA_TXT 上（续跑也直接读这个路径）——
    // 改名会让任务读不到配置，故有引用即拒绝，让用户等任务结束后再改。
    const busyStates = ['running', 'queued', 'paused', 'interrupted', 'stopped'];
    const busy = [...((this.tasks && this.tasks.values) ? this.tasks.values() : [])]
      .filter((t) => t && busyStates.indexOf(t.status) >= 0);
    for (const t of busy) {
      const p = t.env && t.env.REPLICA_TXT;
      if (p && path.resolve(String(p)).toLowerCase() === abs.toLowerCase()) {
        return { ok: false, error: '该配置正被任务「' + (t.title || '') + '」使用，请等任务结束后再改名' };
      }
    }
    // 仅大小写不同时，Windows 上 renameSync 目标被视为已存在 → 经临时名两步走（失败改回）
    const caseOnly = oldBase.toLowerCase() === newName.toLowerCase();
    try {
      if (caseOnly) {
        const tmp = path.join(dir, '.vl-rename-' + Date.now() + ext);
        fs.renameSync(abs, tmp);
        try { fs.renameSync(tmp, dest); } catch (e) { try { fs.renameSync(tmp, abs); } catch (e2) {} throw e; }
      } else {
        fs.renameSync(abs, dest);
      }
    } catch (e) { return { ok: false, error: '改名失败：' + ((e && e.message) || e) }; }
    return { ok: true, path: dest };
  }

  saveConfig(filePath, folders, excludes, watermark, newName) {
    filePath = path.resolve(filePath);
    const ext = path.extname(filePath) || '.txt';
    const oldBase = path.basename(filePath, ext);
    // 配置名改了就地改名（可选）：名字规范化与「保存为当日配置」一致（允许用户带 .txt 输入）
    const want = String(newName == null ? '' : newName).trim().replace(/\.txt$/i, '').trim();
    let target = filePath;
    let renamed = false;
    if (want && want !== oldBase) {
      const rn = this._renameConfigFile(filePath, want);
      if (!rn || !rn.ok) return rn || { ok: false, error: '改名失败' };
      target = rn.path; renamed = true;
    } else {
      // ★ 强联动保护（最后一道防线）：**已有有效日志的配置，禁止就地覆盖**。
      //   为什么：日志记录着那次任务实际用了哪些片段，配置名又嵌在日志名里 —— 两者是一对一的
      //   「任务正本 + 运行记录」。就地覆盖会让配置内容与这份日志脱钩：复刻按
      //   「日志的结构 + 本配置的素材池」生成，池被改过之后产出的片子不再符合"复刻"的定义；
      //   而这种改动**不留任何痕迹**（改名至少还有日志名做锚点），用户很难察觉自己做过。
      //   正确出口是「保存为当日配置」：新名字、新日志，与旧的那份彻底脱钩。
      //   前端会据此禁用「覆盖当前配置」按钮并给出引导，这里兜住键盘/脚本等绕过路径。
      const project = this._projectOf(target);
      const dir = path.dirname(target);
      if (this._configHasEffectiveLog(target, project, oldBase, dir)) {
        return { ok: false, error: '该配置已有对应日志，不能覆盖（复刻按「日志的结构 + 本配置的素材池」生成，覆盖会让两者脱钩）。请改用「保存为当日配置」' };
      }
    }
    const text = this._rewriteText(folders, excludes, watermark);
    fs.writeFileSync(target, text, 'utf-8');
    this._putConfigCache(target, text, this._parseConfigText(target, text));   // 保存即更新内容缓存（下次打开零 IO）
    // 传入路径 → 就地并入配置树，列表/版本立刻可见（无需重扫）；改名时把旧路径一并传入，
    // 旧条目并入失败会触发配置树整体作废（比手工摘条目更稳）
    if (renamed) this._markConfigModified(target, filePath);
    else this._markConfigModified(target);
    if (renamed) {
      // 内容缓存以路径为键：旧路径那行必须删（否则残留一份"旧名"的解析结果）
      try {
        const store = this._useDbCache() ? this._cacheStore : null;
        if (store && typeof store.txtDelete === 'function') store.txtDelete(filePath);
      } catch (e) {}
    }
    return { ok: true, path: target, name: path.basename(target, ext), renamed };
  }

  saveConfigToday(project, name, configName, folders, excludes, watermark) {
    const pdir = path.join(this.root, project);
    const now = new Date();
    const monthDir = String(now.getMonth() + 1) + '月';
    const dayDir = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const targetDir = path.join(pdir, monthDir, dayDir);
    fs.mkdirSync(targetDir, { recursive: true });
    let finalName = (configName || name || 'config').trim();
    if (!finalName.toLowerCase().endsWith('.txt')) finalName += '.txt';
    const filePath = path.join(targetDir, finalName);
    const text = this._rewriteText(folders, excludes, watermark);
    fs.writeFileSync(filePath, text, 'utf-8');
    this._putConfigCache(filePath, text, this._parseConfigText(filePath, text));
    this._markConfigModified(filePath);
    return { ok: true, path: filePath };
  }

  // 新增空白配置：今日目录下创建无素材路径的 TXT（与保存为当日配置同目录规则）；
  // 项目启用主流水印时自动一并写上新配置的水印行
  newEmptyConfig(project) {
    try {
      if (!this.root || !project) return { ok: false, error: '未指定项目' };
      const pdir = path.resolve(path.join(this.root, project));
      if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) return { ok: false, error: '项目目录不存在：' + pdir };
      const now = new Date();
      const monthDir = String(now.getMonth() + 1) + '月';
      const dayDir = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      const targetDir = path.join(pdir, monthDir, dayDir);
      fs.mkdirSync(targetDir, { recursive: true });
      // 默认文件名唯一：新建配置.txt → 新建配置 (1).txt → …
      let name = '新建配置';
      for (let i = 1; fs.existsSync(path.join(targetDir, name + '.txt')); i++) { name = '新建配置 (' + i + ')'; }
      const filePath = path.join(targetDir, name + '.txt');
      const wm = this.getProjectWatermark(project);
      const watermark = (wm && wm.ok && wm.enabled && wm.main) ? wm.main : '';
      const text = this._rewriteText([], [], watermark);
      fs.writeFileSync(filePath, text, 'utf-8');
      this._putConfigCache(filePath, text, this._parseConfigText(filePath, text));
      this._markConfigModified(filePath);
      return { ok: true, path: filePath, name, watermark };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 移除日期分支（配置/日志 TXT）：
  // scope=txt 仅删当前文件；both 删除所在目录下全部 TXT（双模式配置+日志，成片保留）；folder 删除整个日期文件夹（含成片）
  // 删除后若目录为空则逐级向上清理空目录（以工作根为边界）
  removeBranch(filePath, scope) {
    try {
      if (!this.root) return { ok: false, error: '未配置工作路径' };
      filePath = path.resolve(filePath);
      const root = path.resolve(this.root);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) return { ok: false, error: '目标不在工作路径内' };
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { ok: false, error: '文件不存在：' + filePath };
      const dir = path.dirname(filePath);
      const mode = scope === 'folder' ? 'folder' : (scope === 'both' ? 'both' : 'txt');
      // 外部 * 配置：位于成片文件夹之外（路径不含「成片」段），其「成片」不在本分支目录内，
      // 整体删除会连累同目录下其它任务的产物 → 拒绝 folder 整体删除，仅允许 txt/both
      const inChengpian = String(filePath).split(/[\\/]/).some((p) => p.endsWith('成片'));
      if (mode === 'folder' && !inChengpian) return { ok: false, error: '该配置不在成片文件夹内（外部配置），不能整体删除；请选「仅移除该配置」' };
      if (mode === 'folder') {
        if (dir.length <= root.length) return { ok: false, error: '不允许删除工作根目录' };
        // 整个文件夹走回收站（可还原），不再递归永久删除
        if (!this._recycleFile(dir)) return { ok: false, error: '移入回收站失败' };
      } else {
        if (mode === 'both') {
          let entries = [];
          try { entries = fs.readdirSync(dir); } catch (e) {}
          for (const ent of entries) {
            const full = path.join(dir, String(ent));
            let st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.isFile() && String(ent).toLowerCase().endsWith('.txt')) this._recycleFile(full);
          }
        } else {
          if (!filePath.toLowerCase().endsWith('.txt')) return { ok: false, error: '仅支持移除 TXT 分支' };
          this._recycleFile(filePath);
        }
      }
      // 逐级向上删除空目录：任一目录非空即停止；到工作根为止，不会越界
      let cur = mode === 'folder' ? path.dirname(dir) : dir;
      while (cur.length > root.length && cur !== root) {
        let entries = [];
        try { entries = fs.readdirSync(cur); } catch (e) { break; }
        if (entries.length) break;
        try { fs.rmdirSync(cur); } catch (e) { break; }
        cur = path.dirname(cur);
      }
      // ★ 删除 TXT 后必须刷新**日志索引缓存**：配置与日志同属一批被索引的 TXT，
      //   删掉任何一个都会让 log_index 缓存过期。而 _collectLogFiles() 默认吃缓存
      //   （内存 → 持久化；持久化指纹只覆盖「一级项目目录」mtime，删子目录里的文件它察觉不到），
      //   后果是界面继续挂着已经删掉的日志条目、改名前的日志配对判定也继续看得见它。
      //   此处就地真扫一次把缓存刷成磁盘真相 —— 删除是低频用户操作，这点代价可接受。
      try { this._collectLogFiles(true); } catch (e) {}
      this._markConfigModified();
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 判断给定分支的所在目录是否存在「另一模式」的 TXT（配置↔日志；如 * 外部配置无对应日志）
  branchOtherTxt(filePath) {
    try {
      const dir = path.dirname(path.resolve(String(filePath || '')));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: true, hasOther: false };
      const currentIsLog = LOG_NAME_RE.test(path.basename(filePath));
      let txts = [];
      try {
        txts = fs.readdirSync(dir).filter((n) => String(n).toLowerCase().endsWith('.txt'))
          .filter((n) => { let st; try { st = fs.statSync(path.join(dir, n)); } catch (e) { return false; } return st.isFile(); });
      } catch (e) {}
      const logs = txts.filter((n) => LOG_NAME_RE.test(n));
      const confs = txts.filter((n) => !LOG_NAME_RE.test(n));
      const hasOther = currentIsLog ? confs.length > 0 : logs.length > 0;
      return { ok: true, hasOther };
    } catch (e) { return { ok: false, error: String(e), hasOther: false }; }
  }

  // ── 数据缓存持久层（<storageDir>\cache.db）──
  // 唯一持久层：Ticks 以 TEXT 精确承载（INTEGER 列读 Int64 会抛 RangeError）、
  // 支持增量写与 backend↔引擎跨进程并发（WAL）。
  // 旧 JSON 数据由启动期的布局迁移器（engines/base/migrate.js）一次性并入，此处不做 JSON 迁移。
  // 库不可打开时（极端异常）退化为纯内存：本次会话照常出片与预检测，只是不落盘，也不产生任何回退文件。

  // 作用域位掩码：与 engines/base/cache.js 的 SCOPES 同源（惰性取用，避免构造期依赖引擎目录）；
  // 取不到时用等价内联值兜底，行为不随加载失败而改变。
  get _scopes() {
    if (!this._scopesCache) {
      try { this._scopesCache = require(path.join(this.enginesDir, 'base', 'cache.js')).SCOPES; }
      catch (e) { this._scopesCache = { batch: 1, replica: 2, mask: 4 }; }
    }
    return this._scopesCache;
  }

  // 选择数据缓存后端（进程内只判定一次）
  _useDbCache() {
    if (this._cacheBackendMode) return this._cacheBackendMode === 'db';
    const dbPath = this.cacheDbPath;
    if (!dbPath) { this._cacheBackendMode = 'mem'; return false; }
    let store = null;
    try {
      const CacheStore = require(path.join(this.enginesDir, 'base', 'cache.js'));
      store = new CacheStore(dbPath, { root: this.root });
      store.open();
    } catch (e) { store = null; }
    this._cacheStore = store;
    this._cacheBackendMode = store ? 'db' : 'mem';
    if (!store) console.error('[cache] 缓存库不可用，本次会话退化为纯内存（出片不受影响）');
    // 注入文本内容缓存后端：此后所有 readText（配置/日志/索引）命中即零文件读取。
    // 与 readConfig 共用 txt_content 表：写回时**保留已有的解析结果**（指纹一致才保留），互不破坏。
    if (store) {
      _textCacheBackend = {
        get: (p, fp) => {
          const row = store.txtGet(p);
          return (row && row.fp === fp && row.raw) ? row.raw : null;
        },
        put: (p, fp, text) => {
          const prev = store.txtGet(p);
          const parsed = (prev && prev.fp === fp) ? (prev.parsed || '') : '';
          store.txtPut(p, fp, text, parsed, Date.now());
        },
      };
    }
    return !!store;
  }

  // 设置库（<storageDir>\settings.db）：批量 / 遮罩等项目设置的持久层，不可用时同样退化纯内存
  _useSettings() {
    if (this._settingsMode) return this._settingsMode === 'db';
    const dbPath = this.settingsDbPath;
    if (!dbPath) { this._settingsMode = 'mem'; return false; }
    let store = null;
    try {
      const SettingsStore = require(path.join(this.enginesDir, 'base', 'settings.js'));
      store = new SettingsStore(dbPath);
      store.open();
    } catch (e) { store = null; }
    this._settingsStore = store;
    this._settingsMode = store ? 'db' : 'mem';
    if (!store) console.error('[settings] 设置库不可用，本次会话退化为纯内存（出片不受影响）');
    return !!store;
  }

  // 移入系统回收站（可还原）。两步走：① 同步把原路径改名摘除 —— 调用方（如重跑前清旧产物）
  // 需要"旧文件立刻不再冲突"，异步送站做不到这一点；② 再异步送回收站。
  // 送站失败时文件以 .bak 形态保留，绝不静默永久删除。
  _recycleFile(p) {
    if (!p || !fs.existsSync(p)) return false;
    let target = p;
    try {
      const bak = p + '.bak';
      fs.renameSync(p, bak);
      target = bak;
    } catch (e) { /* 改名失败：退回直接送回收站 */ }
    try {
      const { shell } = require('electron');
      if (shell && typeof shell.trashItem === 'function') {
        shell.trashItem(target).catch(() => {});   // 失败则保留 target，数据不丢
        return true;
      }
    } catch (e) {}
    return true;   // 非 Electron 环境：已摘除原路径，以 .bak 形态保留
  }

  // 标记缓存变更：记录具体键，据此做增量写（避免每次全量 upsert）
  _markVideoCacheDirty(vPath) {
    this._videoCacheDirty = true;
    if (vPath) this._videoCacheDirtyKeys.add(String(vPath));
  }

  _markVideoCacheRemoved(vPath) {
    this._videoCacheDirty = true;
    const k = String(vPath);
    this._videoCacheDirtyKeys.delete(k);
    this._videoCacheRemovedKeys.add(k);
  }

  _loadVideoCache() {
    if (this._videoCache !== null) return this._videoCache;
    let cache = {};
    if (this._useDbCache()) {
      // 默认作用域：批量 + 复刻。遮罩素材必须由调用方显式声明掩码才会被读到。
      try { cache = this._cacheStore.loadVideoMap({ scopesMask: this._scopes.batch | this._scopes.replica }); }
      catch (e) { cache = {}; }
    }
    // 库不可用时不落盘：探测结果仅在本会话内复用（重新打开应用后重探一次）
    this._videoCache = cache;
    this._videoCacheDirty = false;
    this._videoCacheDirtyKeys.clear();
    this._videoCacheRemovedKeys.clear();
    return cache;
  }

  // 文件写入时间 → 与 PowerShell 一致的 100ns ticks（自 0001-01-01）。
  // 必须用 bigint(mtimeNs) 精确换算：浮点 mtimeMs*10000 会超过 double 精确整数范围(2^53)丢低位精度，
  // 导致与脚本 Get-Item LastWriteTimeUtc.Ticks 比对永远不等，缓存全部失效重测
  _mtimeToTicks(videoPath) {
    try {
      const st = fs.statSync(videoPath, { bigint: true });
      return (st.mtimeNs / 100n) + 621355968000000000n;
    } catch (e) { return 0n; }
  }
  // 缓存命中/写入统一用字符串承载 ticks：JSON number 无法表达 19 位整数，会再次丢精度；
  // 脚本侧 PowerShell 的 string -eq long 会自动转换比较，仍能正确命中
  _ticksToStr(v) { return String(v == null ? '' : v); }

  // 文件指纹：mtime（Ticks）+ 字节大小。
  // ⚠ 只比 mtime 不足以判断"素材是否被替换"：Windows 的 CopyFile（含资源管理器粘贴）、
  //   解压、同步工具都会保留源文件的修改时间 —— 覆盖同名素材后时间戳可能分毫不变，
  //   指纹不变 → 预检测一直沿用旧结论，表现为"重新覆盖正确文件后仍显示不合格，
  //   刷新配置/切换配置/刷新预缓存都无效，只有重开软件才好"。
  //   大小与 mtime 一起比：一次 statSync 同时取到，且分辨率/内容变过的文件大小几乎必变。
  _fileFingerprint(p) {
    try {
      const st = fs.statSync(p, { bigint: true });
      return { ticks: String((st.mtimeNs / 100n) + 621355968000000000n), size: Number(st.size) || 0 };
    } catch (e) { return null; }
  }
  // 缓存条目是否仍与当前文件一致（size 缺失或为 0 的旧条目退化为只比 mtime）
  _fingerprintMatches(fp, ticks, size) {
    if (!fp) return false;
    if (this._ticksToStr(ticks) !== fp.ticks) return false;
    const sz = Number(size) || 0;
    return sz === 0 || sz === fp.size;
  }

  // ffprobe 异步探测（并发限流使用，不阻塞主线程）
  _probeVideoAsync(videoPath) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      // 与主进程统一口径：必须走 _resolveFfmpegBin（唯一来源 = 自愈目录）。
      // ⚠ 不要用裸名 `ffprobe` 依赖系统 PATH —— 与主进程判定不一致，且 PATH 缺失时会直接失败。
      const ffprobe = this._resolveFfmpegBin().ffprobePath;
      if (!ffprobe) return resolve({ valid: false, duration: 0, width: 0, height: 0 });
      execFile(
        ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve({ valid: false, duration: 0, width: 0, height: 0 });
          const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (lines.length >= 3) {
            const width = parseInt(lines[0], 10);
            const height = parseInt(lines[1], 10);
            const duration = parseFloat(lines[2]);
            const valid = width === 1080 && height === 1920 && isFinite(duration) && duration > 0;
            return resolve({ valid, duration: isFinite(duration) ? duration : 0, width, height });
          }
          resolve({ valid: false, duration: 0, width: 0, height: 0 });
        }
      );
    });
  }

  // 并发限流执行器：同一时刻最多并发 limit 个，全部完成后按输入顺序返回结果数组。
// shouldStop 可选：每轮分发前调用，返回 true 即停止分发新任务（已分发者自然完成），并尽快 resolve 已完成部分
  _runWithLimit(items, worker, limit, shouldStop) {
    return new Promise((resolve) => {
      const n = items.length;
      if (n === 0) return resolve([]);
      const limitN = Math.max(1, limit | 0);
      const results = new Array(n);
      let i = 0, running = 0, done = 0, stopped = false;
      const pump = () => {
        if (!stopped && shouldStop && shouldStop()) stopped = true; // 中断
        while (running < limitN && i < n && !stopped) {
          const idx = i++;
          running++;
          Promise.resolve()
            .then(() => worker(items[idx], idx))
            .catch(() => undefined)
            .then((v) => { results[idx] = v; })
            .then(() => {
              running--; done++;
              if (done === n) resolve(results);
              else if (stopped && running === 0) resolve(results);
              else pump();
            });
        }
        if (stopped && running === 0) resolve(results);
      };
      pump();
    });
  }

  // 读取缓存视频信息：命中且指纹（mtime + 大小）未变则复用，否则返回 null（交由并发探测）
  _fetchCachedVideoInfo(videoPath) {
    const fp = this._fileFingerprint(videoPath);
    if (!fp) return null;
    const hit = this._videoInfoCache.get(videoPath);
    if (hit) {
      // 内存条目不带指纹，必须回缓存核对后才能复用 —— 否则同名覆盖后一直返回旧结论
      const c0 = this._loadVideoCache()[videoPath];
      if (this._fingerprintMatches(fp, c0 && c0.LastWriteTime, c0 && c0.FileSize)) return hit;
      this._videoInfoCache.delete(videoPath);
    }
    const cache = this._loadVideoCache();
    const cached = cache[videoPath];
    if (this._fingerprintMatches(fp, cached && cached.LastWriteTime, cached && cached.FileSize)) {
      const info = { valid: !!cached.Valid, duration: Number(cached.Duration) || 0, width: cached.Width || 0, height: cached.Height || 0 };
      this._videoInfoCache.set(videoPath, info);
      return info;
    }
    if (cached) { delete cache[videoPath]; this._markVideoCacheRemoved(videoPath); } // 指纹变化，丢弃旧缓存交由重新探测
    return null;
  }

  // 按作用域读取探测结果：指纹未变才命中；命中写入内存缓存键（含作用域，避免与其它模式串用）
  _fetchScopedVideoInfo(videoPath, scope) {
    const key = scope + '\u0000' + videoPath;
    const fp = this._fileFingerprint(videoPath);
    if (!fp) return null;
    const hit = this._videoInfoCache.get(key);
    if (hit) {
      // 同 _fetchCachedVideoInfo：内存条目不带指纹，须回库核对后才能复用
      let r0 = null;
      try { r0 = this._useDbCache() ? this._cacheStore.getVideo(videoPath, { scopesMask: scope }) : null; } catch (e) { r0 = null; }
      if (this._fingerprintMatches(fp, r0 && r0.last_write, r0 && r0.file_size)) return hit;
      this._videoInfoCache.delete(key);
    }
    if (!this._useDbCache()) return null;
    let row = null;
    try { row = this._cacheStore.getVideo(videoPath, { scopesMask: scope }); } catch (e) { return null; }
    if (!this._fingerprintMatches(fp, row && row.last_write, row && row.file_size)) return null;
    const info = {
      valid: !!row.valid, duration: Number(row.duration) || 0,
      width: Number(row.width) || 0, height: Number(row.height) || 0,
    };
    this._videoInfoCache.set(key, info);
    return info;
  }

  // 按作用域写入探测结果：scopes 按位或累加，不覆盖其它模式已有的来源标记
  _saveScopedVideoInfo(videoPath, info, scope) {
    if (!this._useDbCache()) return false;
    try {
      this._cacheStore.upsertVideo(videoPath, {
        lastWrite: this._ticksToStr(this._mtimeToTicks(videoPath)),
        duration: info.duration, width: info.width, height: info.height,
        valid: info.valid, scopes: scope, fileSize: this._fileSize(videoPath),
      });
      this._videoInfoCache.set(scope + '\u0000' + videoPath, {
        valid: !!info.valid, duration: Number(info.duration) || 0,
        width: Number(info.width) || 0, height: Number(info.height) || 0,
      });
      return true;
    } catch (e) { return false; }
  }

  // 文件字节大小（计数认领的多命中消歧依据；取不到记 0，不影响其它逻辑）
  _fileSize(p) {
    try { return Number(fs.statSync(p).size) || 0; } catch (e) { return 0; }
  }

  // 遮罩素材信息：先按「遮罩作用域」查缓存，命中直接用时长；未命中才 ffprobe 并写回缓存。
  // 遮罩列表会被反复打开，接缓存后不再每次都启动 ffprobe 全量探测。
  async _maskMediaInfo(videoPath) {
    const cached = this._fetchScopedVideoInfo(videoPath, this._scopes.mask);
    if (cached) return cached;
    const info = await this._probeVideoAsync(videoPath);
    this._saveScopedVideoInfo(videoPath, info, this._scopes.mask);
    return info;
  }

  // 计数认领：缓存未命中的路径（本轮新素材）先尝试从既有条目继承使用计数。
  // 素材改名 / 移位后不再被当作全新素材重新计数；与任务引擎共用持久层的同一实现，
  // 保证「刷新预检测」与「跑任务」两条路径行为一致。
  // 认领成功后原条目的路径整体转到新路径（含计数与作用域标记），旧路径随之消失。
  // 返回真正发生迁移的条数（已在库中的路径不算）。
  // 认领使用计数：新路径（素材被替换/移动后）继承既有同字节条目的使用计数。
  // scopesMask 默认批量|复刻；遮罩素材刷新时传 mask —— 三类归属各自认领，互不干扰。
  _claimUsageForPaths(paths, scopesMask) {
    if (!paths || !paths.length || !this._useDbCache()) return 0;
    const store = this._cacheStore;
    const mask = Number(scopesMask) || (this._scopes.batch | this._scopes.replica);
    let n = 0;
    for (const p of paths) {
      try {
        const r = store.claimUsage(p, this._ticksToStr(this._mtimeToTicks(p)), {
          fileSize: this._fileSize(p), scopesMask: mask, scopes: mask,
        });
        if (r && r.adopted && Number(r.usageCount) > 0) n++;
      } catch (e) { /* 单条认领失败不影响预检测 */ }
    }
    return n;
  }

  // 并发探测缺失缓存的视频并写回缓存；返回 path -> info 映射
  // onProbe(done) 可选：每完成一个视频（含缓存命中）回报累计计数
  async _resolveVideoInfos(videoPaths, onProbe) {
    const result = new Map();
    const needProbe = [];
    let doneCount = 0;
    const tick = () => { doneCount++; if (onProbe) { try { onProbe(doneCount); } catch (e) {} } };
    for (const p of videoPaths) {
      const c = this._fetchCachedVideoInfo(p);
      if (c) { result.set(p, c); tick(); }
      else needProbe.push(p);
    }
    const claimed = this._claimUsageForPaths(needProbe); // 新路径先认领既有条目的使用计数
    if (claimed > 0) console.log('[video_cache] 已识别 ' + claimed + ' 个素材的既有使用计数（路径变化）');
    const infos = await this._runWithLimit(needProbe, (p) => this._probeVideoAsync(p).then((info) => { tick(); return info; }), this.probeConcurrency);
    const cache = this._loadVideoCache();
    for (let i = 0; i < needProbe.length; i++) {
      const p = needProbe[i];
      const info = infos[i] || { valid: false, duration: 0, width: 0, height: 0 };
      cache[p] = {
        LastWriteTime: this._ticksToStr(this._mtimeToTicks(p)), Duration: info.duration,
        Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(p),
      };
      this._videoInfoCache.set(p, info);
      result.set(p, info);
      this._markVideoCacheDirty(p);
    }
    return result;
  }

  // 缓存落盘：只写脏键（增量事务）。
  // 刻意不做同步写：大缓存下序列化 + write 可达数十毫秒，同步执行会推迟同期 IPC 响应，
  // 前端表现为行内徽章长时间停在「检测中…」。
  // full=true 用于「重置后整体替换」——此时内存对象即全量，脏键集合不代表全量。
  async _saveVideoCache(full) {
    const snapshot = this._videoCache;
    // 纯内存态（库不可用）：无需落盘，清脏标记即可
    if (!(this._cacheBackendMode === 'db' && this._cacheStore)) {
      if (this._videoCache === snapshot) {
        this._videoCacheDirty = false;
        this._videoCacheDirtyKeys.clear();
        this._videoCacheRemovedKeys.clear();
      }
      return;
    }
    const upserts = {};
    if (snapshot) for (const k of this._videoCacheDirtyKeys) if (snapshot[k]) upserts[k] = snapshot[k];
    const deletes = Array.from(this._videoCacheRemovedKeys);
    if (!full && !Object.keys(upserts).length && !deletes.length) { this._videoCacheDirty = false; return; }
    try {
      if (full) this._cacheStore.replaceVideoMap(snapshot || {});
      else this._cacheStore.applyVideoDelta(upserts, deletes);
    } catch (e) { return; } // 写入失败保留脏标记，下次再试
    if (this._videoCache === snapshot) {
      this._videoCacheDirty = false;
      this._videoCacheDirtyKeys.clear();
      this._videoCacheRemovedKeys.clear();
    }
  }

  // 失效清理「判定分区」：分出「当场可判」与「需核验文件是否存在」两组。
  // 免 IO 是本函数的意义：本轮刚枚举过的路径（knownPaths）必然存在，无需再 stat；
  // 非当前 root 的残留条目直接判删，同样无需 stat。只有两者都不适用（手动清理、目录已从配置移除）
  // 才落到 verify —— 这正是把「数千次同步 stat」压缩成「通常为零」的关键。
  _videoCacheGcPlan(knownPaths) {
    const c = this._videoCache;
    const verify = [];
    if (!c) return { drop: [], verify, missing: new Set(), expired: new Set() };
    for (const f of Object.keys(c)) {
      if (knownPaths && knownPaths.has(f)) continue; // 刚枚举到 → 文件必然存在
      verify.push(f);
    }
    return { drop: [], verify, missing: new Set(), expired: new Set() };
  }

  // video_cache 失效清理（异步分批）：核验「文件是否仍存在」，不存在只置位、不删除。
  // 保留期内的条目仍留在库中 —— 素材移位后新路径才有机会认领它的使用计数；
  // 到期仍不存在才真删；文件重新出现则清除置位（复活），计数一并保留。
  // 每 YIELD 条让出一次事件循环：主线程始终能响应 IPC，前端不再出现长时间「检测中…」。
  // 判定分区由持久层给出（库走 gcPlan，纯内存态走 _videoCacheGcPlan），语义一致。
  async _gcVideoCache(knownPaths, opts) {
    if (!this.storageDir) return 0;
    const limit = Number(opts && opts.limit) > 0 ? Number(opts.limit) : 0;   // 0 = 不限量（手动入口）
    const store = (this._cacheBackendMode === 'db' && this._cacheStore) ? this._cacheStore : null;
    this._loadVideoCache();
    const c = this._videoCache;
    if (!c) return 0;
    let plan;
    try { plan = store ? store.gcPlan(knownPaths, { now: Date.now(), limit: limit || 0 }) : this._videoCacheGcPlan(knownPaths); }
    catch (e) { if (store) return 0; plan = this._videoCacheGcPlan(knownPaths); }
    const all = plan.verify || [];
    const list = (limit > 0 && all.length > limit) ? all.slice(0, limit) : all;
    const _t = Date.now();
    const gone = [], back = [];
    // ⚠ 让路粒度 24（不要再放大）：冷态下一次让路前最多 24 次随机 IO —— 256 次足以把机械盘队列打满、
    // 连带主线程一起冻住几十秒。
    const YIELD = 24;
    let yields = 0;
    // 阶段 5：接入统一让路查询（_verifyEnqueue 提供的 ctx.shouldYield）——
    // 前台刚有活动/有任务在跑时多喘一口。纯增量：不改变原有让路节奏，只在忙时把间隔从 10ms 提到 30ms。
    const shouldYield = (opts && typeof opts.shouldYield === 'function') ? opts.shouldYield : null;
    for (let i = 0; i < list.length; i++) {
      // 让路期间缓存可能已被重置/重载（取消预检测、切工作目录）→ 放弃本次清理，避免写回陈旧快照
      if (this._videoCache !== c) return 0;
      let missing = false;
      try { await fs.promises.stat(list[i]); } catch (e) { missing = true; }
      if (missing) gone.push(list[i]);
      else back.push(list[i]);
      if ((i + 1) % YIELD === 0) {
        await new Promise((r) => setImmediate(r));
        yields++;
        let busy = false;
        try { busy = shouldYield ? !!shouldYield() : false; } catch (e) { busy = false; }
        if (busy || yields % 4 === 0) await new Promise((r) => setTimeout(r, busy ? 30 : 10));   // 每 4 批让磁盘喘一口
      }
    }
    // 记录「这批刚核验过」→ 有效期内（默认 7 天）不再重复访问磁盘：
    // 冷启动 IO 总量因此与「过期条数」成正比，而不是与库的大小成正比（本机库内 7269 条）。
    if (store && store.markVerified && list.length) { try { store.markVerified(list, Date.now()); } catch (e) {} }
    if (this._lg && (limit > 0 || (opts && opts.idle))) {
      this._lg('SYS', 'cache.gc',
        '数据缓存失效清理（空闲' + (limit > 0 ? '增量' : '全量') + '） · 核验 ' + list.length + ' / ' + all.length + ' 条 · 失效 ' + gone.length
        + ' · ' + (Date.now() - _t) + 'ms · 让路 ' + yields + ' 次'
        + (limit > 0 ? '（冷启动限量）' : '（热启动全量）'),
        { verify: list.length, total: all.length, gone: gone.length, ms: Date.now() - _t, yields, limit });
    }
    if (this._videoCache !== c) return 0;
    if (!store) {
      // 纯内存态没有保留期概念（会话结束即消失）：核验不存在的条目直接丢弃
      for (const f of plan.drop.concat(gone)) delete c[f];
      if (!gone.length) return 0;
      this._videoCacheDirty = true;
      await this._saveVideoCache();
      return gone.length;
    }
    const expired = plan.expired || new Set();
    const stillMissing = gone.filter((p) => !expired.has(p));
    // 到期回收**不依赖本次核验**：missing_since 已经把「文件不在了」记在库里，
    // 到期与否纯看时间，无需再 stat。原实现写成 `gone ∩ expired` 是建立在
    // 「每次都会重验所有 missing 条目」的前提上 —— TTL 免重验后那个前提不成立，
    // 结果就是到期条目永远删不掉（内部回归用例 抓到的正是这个）。
    const remove = Array.from(expired);
    let removed = 0;
    try {
      if (stillMissing.length) store.markMissing(stillMissing, Date.now());
      if (back.length) store.clearMissing(back); // 文件已放回 → 复活并保留计数
      if (remove.length) removed = store.deleteVideos(remove);
    } catch (e) { return 0; }
    for (const f of remove) delete c[f];
    return removed;
  }

  // 触发一次失效清理：启动时与「清理数据缓存」手动入口调用（无定时器，全部为显式触发）
  async _gcVideoCacheNow() {
    if (!this.storageDir) return 0;
    try { return await this._gcVideoCache(); } catch (e) { return 0; }
  }

  // 前台接口：清理 video_cache 失效条目（手动入口，返回删除数）
  async cleanVideoCache() {
    const removed = await this._gcVideoCacheNow();
    return { ok: true, removed: removed || 0 };
  }

  // ── 缓存治理：自动清理（保守 + 保留期）· 构成统计 · 手动清理 ──
  // 口径：
  //   ① 保守规则 —— 只删「指向已不存在目录/文件」的条目：客观失效，绝不误删仍在用的缓存；
  //   ② 保留期   —— 内容缓存（视频/目录/TXT 条目）超过 cache_keep_days 未更新也清理。
  //                 缓存可再生，不影响成片与配置；任务记录与运行日志不属于「内容缓存」，不在此列。
  //   ③ 触发     —— 启动后空闲期（节流 ≥24h）+ 库体积超阈值；
  //   ④ 释放显著 → VACUUM 回收页碎片（会重写库文件，必须留在空闲期执行）。
  _cacheKeepDays() {
    const n = parseInt(this.config && this.config.cache_keep_days, 10);
    return (Number.isFinite(n) && n >= 0) ? n : 30;
  }
  _cacheGcState() {
    try { return JSON.parse(this._cacheStore.getMeta('cache_gc') || '{}') || {}; } catch (e) { return {}; }
  }
  // 概览（设置页显示：体积 / 保留天数 / 上次自动清理）
  cacheInfo() {
    try {
      const st = this._cacheGcState();
      return { ok: true, size: this._cacheStore ? this._cacheStore.dbSizeBytes() : 0,
        keepDays: this._cacheKeepDays(), lastAt: st.at || 0, lastRemoved: st.removed || 0, lastFreed: st.freed || 0 };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  // 构成（设置页「查看构成」）
  cacheStats() {
    try { return { ok: true, stats: this._cacheStore.stats() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  // 清理实现（自动/手动共用）。limit>0 时只处理前 limit 条（空闲期分批，避免冷态机械盘冻住界面）
  async _gcStaleCaches(opts) {
    if (!this._useDbCache() || !this._cacheStore) return { removed: 0, freed: 0, size: 0 };
    const store = this._cacheStore;
    const limit = Number(opts && opts.limit) > 0 ? Number(opts.limit) : 0;
    const keepDays = this._cacheKeepDays();
    const keepMs = keepDays > 0 ? keepDays * 86400000 : 0;
    const now = Date.now();
    const before = store.dbSizeBytes();
    let removed = 0;
    const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
    // ① clip_index：**只删「目录已不存在」的条目**。
    //    ⚠ 这里存的是「成片 → 该成片用过的片段清单」的业务映射，不是可再生缓存 ——
    //      绝不能按保留期清理：目录还在就说明成片还在，映射必须留着。
    try {
      const del = [];
      for (const d of store.listClips('')) {
        if (!exists(d)) del.push(d);
        if (limit && del.length >= limit) break;
      }
      if (del.length) removed += store.deleteClips(del);
    } catch (e) {}
    // ② txt_content：文件不存在 / 超保留期（updated_at）→ 删
    try {
      const rows = store.open().prepare('SELECT path, updated_at FROM txt_content').all();
      const del = [];
      for (const r of rows) {
        const p = String(r.path);
        if (!exists(p)) { del.push(p); continue; }
        if (keepMs && Number(r.updated_at) > 0 && now - Number(r.updated_at) > keepMs) del.push(p);
        if (limit && del.length >= limit) break;
      }
      if (del.length) removed += store.deleteTxtPaths(del);
    } catch (e) {}
    // ③ scan_cache：键（盘符开头的目录/根）不存在 → 删
    try {
      const del = [];
      for (const r of store.listScans('')) {
        const k = String(r.key);
        if (/^[A-Za-z]:[\\/]/.test(k) && !exists(k)) del.push(k);
        if (limit && del.length >= limit) break;
      }
      if (del.length) removed += store.deleteScans(del);
    } catch (e) {}
    // ④ cache_kv：txt_tree:<root> / log_index:<root> 等指向的 root 已不存在 → 删（含历史异写法与错位残留）
    //    proj_reg 同理 —— 工作根消失后，它登记的项目名已无意义（各项目目录的存在性
    //    由 _survivingProjReg / listMaskProjects 在每次重建列表时单独核验）
    try {
      const kv = store.listKv('');
      for (const k of Object.keys(kv)) {
        const m = /^(txt_tree|log_index|replica_logs|scan_index):(.+)$/.exec(k);
        // proj_reg 的键是 proj_reg:<kind>:<工作根>（kind = batch|mask），根路径要从第二个冒号后取
        const mReg = /^proj_reg:(?:batch|mask):(.+)$/.exec(k);
        if ((m && !exists(m[2])) || (mReg && !exists(mReg[1]))) removed += store.deleteKvPrefix(k);
      }
    } catch (e) {}
    // ⑤ video_cache 的失效条目沿用既有 GC（missing_since 超期回收）
    try { removed += (await this._gcVideoCacheNow()) || 0; } catch (e) {}
    // ⚠ VACUUM 的条件**不能**是「删除后文件是否立即变小」—— SQLite 删除只把页释放进 freelist，
    //   文件大小不变（实测移除 3197 条后仍 56.2MB）；只有 VACUUM（并截断 WAL）才真正回收。
    if (removed > 0) { try { store.vacuum(); } catch (e) {} }
    const size = store.dbSizeBytes();
    const out = { at: now, removed, freed: Math.max(0, before - size), size };
    try { store.setMeta('cache_gc', JSON.stringify(out)); } catch (e) {}
    return out;
  }
  // 启动后空闲期触发：节流 ≥24h；库体积超阈值（40MB）时不受节流限制
  async gcCachesIdle() {
    if (!this._useDbCache() || !this._cacheStore) return { ok: true, skipped: 'no-store' };
    const IDLE_MS = 24 * 3600 * 1000, BIG = 40 * 1024 * 1024;
    let size = 0;
    try { size = this._cacheStore.dbSizeBytes(); } catch (e) { return { ok: true, skipped: 'stat-fail' }; }
    const st = this._cacheGcState();
    const due = !st.at || (Date.now() - st.at > IDLE_MS);
    if (!due && size < BIG) return { ok: true, skipped: 'not-due', size };
    const r = await this._gcStaleCaches({ limit: 0 });
    try {
      this._lg('SYS', 'cache.gc.run',
        '缓存自动清理 · 移除 ' + (r.removed || 0) + ' 条 · 释放 ' + this._humanSize(r.freed || 0)
        + ' · 现 ' + this._humanSize(r.size || 0) + '（保留期 ' + this._cacheKeepDays() + ' 天 · 触发 ' + (due ? '到期' : '体积超阈值') + '）',
        { removed: r.removed || 0, freed: r.freed || 0, size: r.size || 0, keepDays: this._cacheKeepDays(), due });
    } catch (e) {}
    return { ok: true, ...r, due };
  }
  // 前台接口：立即清理（设置页按钮）
  async cleanCaches() {
    const r = await this._gcStaleCaches({ limit: 0 });
    try {
      this._lg('SYS', 'cache.gc.manual',
        '手动清理缓存 · 移除 ' + (r.removed || 0) + ' 条 · 释放 ' + this._humanSize(r.freed || 0) + ' · 现 ' + this._humanSize(r.size || 0),
        { removed: r.removed || 0, freed: r.freed || 0, size: r.size || 0 });
    } catch (e) {}
    return { ok: true, removed: r.removed || 0, freed: r.freed || 0, size: r.size || 0 };
  }

  // ── A6（「内置FFmpeg与数据目录自维护·方案」§五）：数据目录清理 ──
  // 口径：**宁少勿多，绝不误伤**。
  //   · 只清「可再生的内部产物」与「历史残留」；成片、备份、日志一律不碰；
  //   · 日志是事后唯一证据→ 只展示体积、永不清理，按各自保留期自清；
  //   · ⚠ **在跑 / 排队 / 暂停 / 失败 / 停止的任务，其 TXT 快照是「启动前还原配置」与「续跑」的
  //     唯一依据 —— 必须保留**。这是本功能最容易踩的坑：一键清理若把排队任务的快照清掉，
  //     那些任务启动时就拿不到自己的配置了。
  //   · ffmpeg\ 仅在「当前正用它」时不可清，换过组件目录的用户可据此回收（本机 310 MB）。
  _ddSize(p) {
    try { const st = fs.statSync(p); return st.isFile() ? st.size : 0; } catch (e) { return 0; }
  }
  // 递归汇总目录内的文件清单与体积
  _ddWalk(d) {
    const files = [];
    const w = (x) => {
      let ns = [];
      try { ns = fs.readdirSync(x, { withFileTypes: true }); } catch (e) { return; }
      for (const e2 of ns) {
        const p = path.join(x, e2.name);
        if (e2.isDirectory()) w(p); else files.push(p);
      }
    };
    w(d);
    return files;
  }
  // 扫描数据目录 → 可清项清单（含体积 / 条数 / 不可清原因）
  dataDirScan() {
    const dir = String(this.storageDir || '');
    const tasks = this.tasks || new Map();
    const items = [];
    const add = (o) => items.push(Object.assign(
      { key: '', label: '', count: 0, bytes: 0, files: [], cleanable: true, reason: '', desc: '' }, o));
    const abs = (n) => path.join(dir, n);

    // ① 画布预览中间产物
    try {
      const pv = abs('preview');
      const files = fs.existsSync(pv)
        ? fs.readdirSync(pv).filter((n) => /\.(png|jpe?g)$/i.test(n)).map((n) => path.join(pv, n)) : [];
      add({ key: 'preview', label: '画布预览中间产物', files,
        desc: '预览图只为在界面上显示一次，用完即无价值（新版本已改为生成后立即删除，这里是历史遗留）' });
    } catch (e) {}

    // ② TXT 提交快照：只清「任务已不存在 / 已完成 / 超 30 天」三类
    try {
      const sd = abs('txt-snap');
      const all = fs.existsSync(sd) ? fs.readdirSync(sd).filter((n) => /\.txt$/i.test(n)) : [];
      const DEAD = 30 * 24 * 3600 * 1000, now = Date.now();
      const dead = [], keep = [];
      for (const n of all) {
        const p = path.join(sd, n);
        const t = tasks.get(n.replace(/\.txt$/i, ''));
        let age = 0;
        try { age = now - fs.statSync(p).mtimeMs; } catch (e) { age = 0; }
        if (!t || t.status === 'done' || age > DEAD) dead.push(p);   // 任务没了 / 已完成 / 早已过期
        else keep.push(n);                                            // 未完成：续跑与启动前还原还要用
      }
      // ⚠ 必须写 files: dead —— 这条曾是 `files` 简写（该作用域无此变量），
      //   ReferenceError 被外层 catch 静默吞掉，导致整项从清单里消失且毫无提示（已被隔离测试抓出）。
      add({ key: 'txtsnap', label: 'TXT 提交快照（已无用）', files: dead,
        desc: '快照只在任务启动前用于还原配置；任务已完成、已不存在或超过 30 天时它再无用途' });
      if (keep.length) {
        add({ key: 'txtsnap-live', label: 'TXT 提交快照（保留中）', cleanable: false, count: keep.length,
          reason: '有 ' + keep.length + ' 个任务在跑 / 排队 / 未完成，它们启动或续跑时要按快照还原配置',
          desc: '这些任务结束后会自动清理，不必手动处理' });
      }
    } catch (e) {}

    // ③ 配置备份残留（如 config.json.bak-rootswitch：切换保存位置时留下的旧副本）
    try {
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((n) => /\.bak(-|$)/i.test(n)).map((n) => abs(n)) : [];
      add({ key: 'cfgbak', label: '配置备份残留', files,
        desc: '切换保存位置 / 迁移时留下的旧副本；确认当前配置正常后即可清理（进回收站，可还原）' });
    } catch (e) {}

    // ④ 数据搬迁残留（*.migrated）：数据搬进 AppData 后，旧位置三个库改名留下的副本
    try {
      const dirs = [dir];
      try {
        const el = require('electron');
        if (el && el.app && el.app.isPackaged) dirs.push(path.dirname(process.execPath));
      } catch (e) { /* 非 Electron 环境：只扫数据目录 */ }
      const files = [];
      for (const d of dirs) {
        let ns = [];
        try { ns = fs.readdirSync(d); } catch (e) { continue; }
        for (const n of ns) if (/\.migrated$/.test(n)) files.push(path.join(d, n));
      }
      add({ key: 'migrated', label: '数据搬迁残留', files,
        desc: '数据搬进 AppData 后，旧位置三个库改名留下的副本（回滚取证用）；新版数据确认正常后即可清理' });
    } catch (e) {}

    // ⑤ FFmpeg 组件目录：**只有当前没在用它**时才可清
    try {
      const ffDir = abs('ffmpeg');
      const files = fs.existsSync(ffDir) ? this._ddWalk(ffDir) : [];
      const active = String(this._resolveFfmpegBin().cfgDir || '');
      let inUse = true;   // 判不出来时按"在用"处理 —— 宁可少清，不能把软件清坏
      try { if (active) inUse = path.resolve(active) === path.resolve(ffDir); } catch (e) { inUse = true; }
      add({ key: 'ffmpeg', label: 'FFmpeg 组件目录', files, cleanable: !inUse,
        reason: inUse ? '当前正在使用这份组件，清理后软件将无法处理视频' : '',
        desc: inUse ? '' : '当前使用的是另一份组件，这份可以回收' });
    } catch (e) {}

    // ⑥⑦ 只展示不清理的两项：让用户知道它们的去向，免得以为"没清干净"
    try {
      const lg = this._ddWalk(abs('log'));
      add({ key: 'log', label: '运行日志', files: [], cleanable: false, count: lg.length,
        bytes: lg.reduce((s, p) => s + this._ddSize(p), 0),
        reason: '日志是排查「某次成片去哪了」的唯一证据，任何清理都不触碰它',
        desc: '按各自保留期自动清理（app 7 天 / error 30 天 / engine 7 天）' });
      const bk = this._ddWalk(abs('backup'));
      add({ key: 'backup', label: '处理前备份', files: [], cleanable: false, count: bk.length,
        bytes: bk.reduce((s, p) => s + this._ddSize(p), 0),
        reason: '属于你的数据，只能由你决定',
        desc: '在「视频处理」设置里开启自动清理并按保留天数处理' });
    } catch (e) {}

    // 体积/条数只在可清项上按文件清单算（不可清项已自行给出）
    for (const it of items) {
      if (!it.files.length) continue;
      it.count = it.files.length;
      it.bytes = it.files.reduce((s, p) => s + this._ddSize(p), 0);
    }
    const cl = items.filter((it) => it.cleanable && it.files.length);
    return {
      ok: true, dir, items,
      cleanableCount: cl.reduce((s, it) => s + it.count, 0),
      cleanableBytes: cl.reduce((s, it) => s + it.bytes, 0),
    };
  }
  // 执行清理：一律进回收站（可还原，遵循项目硬约束）；清完重新扫描，返回最新状态。
  // ⚠ 刻意**不用** `_recycleFile`：它为了"让原路径立刻消失"会先把文件改名成 `*.bak`，而送站是异步的 ——
  //   后果有二：① 紧接的复扫仍会看到那个 `*.bak`（又被当成「配置备份残留」列出来，读数不准）；
  //   ② 送站失败时残渣会永久留在目录里，下次扫描继续列出，形成清不掉的死循环。
  //   这里直接对**原路径**送站并 **await 真实结果**：成功才算移除，失败则保留原文件（下次仍可重试），
  //   既不产生改名残渣，也不静默永久删除。
  async dataDirClean(keys) {
    // 容错：单个键也可以直接传字符串（避免"参数形状不对 → 静默清 0 项"的哑失败）
    const want = (Array.isArray(keys) ? keys : (keys === undefined || keys === null ? [] : [keys])).map(String);
    const scan = this.dataDirScan();
    const picked = scan.items.filter((it) => want.indexOf(it.key) >= 0 && it.cleanable && it.files.length);
    let removed = 0, freed = 0;
    for (const it of picked) {
      for (const f of it.files) {
        if (!fs.existsSync(f)) continue;
        const sz = this._ddSize(f);
        let ok = false;
        try {
          const el = require('electron');
          if (el && el.shell && typeof el.shell.trashItem === 'function') { await el.shell.trashItem(f); ok = true; }
        } catch (e) { ok = false; }   // 送站失败：保留原文件，绝不静默永久删除
        if (ok) { removed++; freed += sz; }
      }
    }
    // 空目录顺手收掉：只收「整目录都是可清项」的那两个（preview / ffmpeg）——
    // 否则清完会留下空文件夹，用户看不出到底清没清。**txt-snap 绝不整目录动**：
    // 里面可能还有在跑/排队任务的快照（它们不在本次可清清单里）。
    try {
      const base = String(this.storageDir || '');
      for (const n of ['preview', 'ffmpeg']) {
        const p = path.join(base, n);
        if (fs.existsSync(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      }
    } catch (e) {}
    try {
      this._lg('SYS', 'datadir.clean',
        '清理数据目录 · 移除 ' + removed + ' 项 · 释放 ' + this._humanSize(freed),
        { keys: picked.map((it) => it.key), removed, freed });
    } catch (e) {}
    // wanted 一并回传：调用方据此区分「没勾选任何项」与「勾了但都被保护/已不存在」——
    // 后者若默不作声，就成了又一次静默失败。
    const after = this.dataDirScan();
    return Object.assign({ ok: true, removed, freed, wanted: want.length }, after);
  }

  // 启动后空闲期的失效清理：**入队**（不分冷热），由空闲队列串行 + 自适应节流执行；
  // 剩下的条目留给后续轮次 —— 清理是维护任务，慢一点没有代价，但绝不能把界面冻住。
  async gcVideoCacheIdle(perJob) {
    // **入队**，不再一次性跑 600/全量：队列串行单发 + 自适应节流，慢盘自动放慢、快盘自动加速，
    // 因此不需要事先判断冷热。剩余条目留给后续轮次（自愈逐步收敛）。
    const N = Number(perJob) > 0 ? Number(perJob) : 4;      // 每条 job 核验的路径数
    const MAX_JOBS = 200;                                    // 每轮最多排入的 job 数（避免队列过长）
    const store = this._useDbCache() ? this._cacheStore : null;
    if (!store || typeof store.gcPendingCount !== 'function') return { queued: 0, pending: 0 };
    let pending = 0;
    try { pending = store.gcPendingCount(Date.now()); } catch (e) { pending = 0; }
    if (!pending) return { queued: 0, pending: 0 };
    const jobs = Math.min(MAX_JOBS, Math.ceil(pending / N));
    let queued = 0;
    for (let i = 0; i < jobs; i++) {
      if (this._verifyEnqueue('cachegc', i, (ctx) => this._gcVideoCache(null, { limit: N, idle: true, shouldYield: ctx.shouldYield }))) queued++;
    }
    try {
      if (this._lg) this._lg('SYS', 'cache.gc.queue',
        '失效清理已排入空闲队列（待核验 ' + pending + ' 条 · 本轮 ' + queued + ' 个批次 × ' + N + ' 条）',
        { pending, queued, perJob: N });
    } catch (e) {}
    return { queued, pending };
  }

  _isExcludedPath(target, excludes) {
    if (!excludes || excludes.length === 0) return false;
    for (const ex of excludes) {
      const clean = stripQuotes(String(ex)).replace(/[\\/]+$/, '');
      if (!clean) continue;
      if (target.toLowerCase().indexOf(clean.toLowerCase()) >= 0) return true;
    }
    return false;
  }

  // .lnk 目标解析：直接读二进制（不再 spawn pwsh —— 预检测剩余的数百毫秒主要来自这里）。
  // 解析器与 batch 模块共用底座实现（engines/base/lnk.js）；失败一律降级为空串，不中断预检测。
  _parseLnkTarget(lnk) {
    if (this._lnkParser === undefined) {
      try { this._lnkParser = require(path.join(this.enginesDir, 'base', 'lnk.js')).parseLnkTarget || null; }
      catch (e) { this._lnkParser = null; }
    }
    if (typeof this._lnkParser !== 'function') return '';
    try { return String(this._lnkParser(lnk) || '').trim(); } catch (e) { return ''; }
  }

  // 解析结果缓存读取：命中且 lnk 文件未变（mtime 相同）直接复用；未缓存返回 null，缓存了「无目标」返回 ''
  _lnkCached(lnk) {
    const c = this._lnkCache.get(lnk);
    if (!c) return null;
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(lnk).mtimeMs; } catch (e) { mtimeMs = null; }
    if (mtimeMs === null || mtimeMs === c.mtimeMs) return c.target;
    this._lnkCache.delete(lnk);
    return null;
  }

  _lnkStore(lnk, target) {
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(lnk).mtimeMs; } catch (e) { mtimeMs = null; }
    this._lnkCache.set(lnk, { mtimeMs, target: String(target || '') });
  }

  // 分流：命中缓存的直接给结果，其余交给解析器
  _lnkSplit(paths) {
    const out = {};
    const todo = [];
    for (const p of paths) {
      const hit = this._lnkCached(p);
      if (hit !== null) { if (hit) out[p] = hit; continue; }
      todo.push(p);
    }
    return { out, todo };
  }

  // 批量解析 .lnk 快捷方式目标（与视频批量脚本语义一致）：返回 { lnkPath: targetPath }；
  // 解析失败/失效返回空对象降级，不影响预检测其余流程。纯内存操作，同步即可（不再有 pwsh 进程开销）。
  _resolveShortcutTargets(paths) {
    if (!paths || !paths.length) return {};
    const { out, todo } = this._lnkSplit(paths);
    for (const p of todo) {
      const target = this._parseLnkTarget(p);
      this._lnkStore(p, target);
      if (target) out[p] = target;
    }
    return out;
  }

  // 保留异步入口：预检测/重置等调用方无需改动；内部已改为纯内存解析，不再阻塞主线程（原 spawnSync 最坏阻塞 10s）
  async _resolveShortcutTargetsAsync(paths) {
    return this._resolveShortcutTargets(paths);
  }

  async _precheckFolder(dir, excludes, nonround) {
    // 第一遍：仅同步收集候选视频，按"根目录 + 各子目录(+快捷方式目标)"分组，暂不探测
    const groups = [];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const rootVideos = [];
      const subDirs = [];
      const lnks = [];
      for (const ent of items) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) subDirs.push(full);
        else if (ent.isFile() && path.extname(ent.name).toLowerCase() === '.lnk') lnks.push(full);
        else if (ent.isFile() && VIDEO_EXTS.has(path.extname(ent.name).toLowerCase())) rootVideos.push(full);
      }
      const rootCands = [];
      for (const v of rootVideos) if (!this._isExcludedPath(v, excludes)) rootCands.push(v);

      // 快捷方式（与批量脚本一致）：解析目标，目录→独立组递归收集；视频文件→并入根组；失效/非视频→跳过
      let rootCandsExtra = null;
      const lnkGroups = [];
      if (lnks.length) {
        const map = await this._resolveShortcutTargetsAsync(lnks);
        if (map) {
          const extra = [];
          for (const l of lnks) {
            const t = map[l];
            if (!t) continue;
            let st;
            try { st = fs.statSync(t); } catch (e) { continue; }
            if (st.isDirectory()) {
              const cands = [];
              for (const f of walkFiles(t)) {
                if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
                if (this._isExcludedPath(f, excludes)) continue;
                cands.push(f);
              }
              lnkGroups.push(cands);
            } else if (st.isFile() && VIDEO_EXTS.has(path.extname(t).toLowerCase())) {
              if (!this._isExcludedPath(t, excludes)) extra.push(t);
            }
          }
          if (extra.length) rootCandsExtra = extra;
        }
      }
      if (rootCandsExtra) rootCands.push.apply(rootCands, rootCandsExtra);
      groups.push(rootCands);
      for (const sub of subDirs) {
        const cands = [];
        for (const f of walkFiles(sub)) {
          if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
          if (this._isExcludedPath(f, excludes)) continue;
          cands.push(f);
        }
        groups.push(cands);
      }
      for (const g of lnkGroups) groups.push(g);
    } catch (e) { return { total: 0, groupCount: 0 }; }

    // 去重后并发探测（未命中缓存的才跑 ffprobe，限流）
    const seen = new Set();
    const all = [];
    for (const g of groups) for (const f of g) if (!seen.has(f)) { seen.add(f); all.push(f); }
    const infos = await this._resolveVideoInfos(all);

    let total = 0, groupCount = 0;
    for (const g of groups) if (g.some((f) => { const i = infos.get(f); return i && i.valid; })) groupCount++;
    for (const f of all) { const i = infos.get(f); if (i && i.valid) total++; }
    if (nonround && total > 0) groupCount = 1;
    return { total, groupCount };
  }

  async precheck(paths, excludes) {
    excludes = (Array.isArray(excludes) ? excludes : []).map((s) => stripQuotes(s)).filter(Boolean);
    const results = [];
    const dedup = new Map();
    for (const item of paths) {
      const isObj = item && typeof item === 'object';
      const key = stripQuotes(isObj ? item.path : item);
      const nonround = isObj ? !!item.nonround : false;
      if (!key) { results.push({ status: 'pending', text: '未检测', total: 0, groupCount: 0, exists: false }); continue; }
      if (dedup.has(key)) { results.push(dedup.get(key)); continue; }
      let r;
      try {
        const st = fs.statSync(key);
        if (st.isDirectory()) {
          const s = await this._precheckFolder(key, excludes, nonround);
          if (s.total === 0) r = { status: 'warn', text: '无合格视频', total: 0, groupCount: 0, exists: true };
          else {
            const grouped = s.groupCount > 1;
            const text = grouped ? `${s.total}个视频，共${s.groupCount}组` : `${s.total} 个视频`;
            r = { status: grouped ? 'group' : 'ok', text, total: s.total, groupCount: s.groupCount, exists: true };
          }
        } else if (st.isFile()) {
          if (VIDEO_EXTS.has(path.extname(key).toLowerCase())) {
            let info = this._fetchCachedVideoInfo(key);
            if (!info) {
              // 行内预检测优先：探测期间后台大探测遇 _inlineProbing>0 会主动让路
              this._inlineProbing++;
              try {
                info = await this._probeVideoAsync(key);
                // 新探测结果写入内存缓存（不落盘，后台下次保存时一并合并；避免两种探测互相覆盖）
                const cc = this._loadVideoCache();
                cc[key] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(key)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(key) };
                this._videoInfoCache.set(key, info);
                this._markVideoCacheDirty(key);
              } finally { this._inlineProbing--; }
            }
            const valid = !this._isExcludedPath(key, excludes) && info.valid;
            r = valid ? { status: 'ok', text: '1 个视频', total: 1, groupCount: 1, exists: true } : { status: 'warn', text: '非合规视频', total: 0, groupCount: 0, exists: true };
          } else r = { status: 'warn', text: '非视频文件', total: 0, groupCount: 0, exists: true };
        } else r = { status: 'warn', text: '路径无效', total: 0, groupCount: 0, exists: false };
      } catch (e) { r = { status: 'warn', text: '路径不存在', total: 0, groupCount: 0, exists: false }; }
      results.push(r);
      dedup.set(key, r);
    }
    // 仅在有实际变更时落盘：常态（全部命中缓存）下预检测完全不写盘，行内徽章立即出结果
    if (this._videoCacheDirty) await this._saveVideoCache();
    return results;
  }

  // 重置预检测：清除物理缓存，收集所有配置指向的路径并全量探测（跨路径去重），可实时回报进度
  // 收集所有配置指向的视频候选：跨配置路径去重、目录递归收集、跳过非视频扩展名
  // 异步：快捷方式解析走非阻塞通道，避免「检测中」期间主线程被 pwsh 启动阻塞
  async _gatherAllVideos() {
    const all = this._collectAllTxt();
    const pathSet = new Set();
    for (const t of all) {
      let cfg;
      try { cfg = this.readConfig(t.full); } catch (e) { continue; }
      for (const f of (cfg.folders || [])) {
        const p = stripQuotes(String((f && typeof f === 'object' ? f.path : f) || '').trim());
        if (p) pathSet.add(p);
      }
    }
    // 遮罩模式登记的素材目录（含手动添加的项目外路径）一并纳入刷新范围 ——
    // 增量探测成本低，用户点一次即可同时刷新批量与遮罩的预缓存，不必分两处各点一次
    for (const p of this._maskSessionDirs()) pathSet.add(p);
    const seen = new Set();
    const allVideos = [];
    for (const p of pathSet) {
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      const cands = [];
      if (st.isDirectory()) {
        for (const f of walkFiles(p)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) cands.push(f);
        // 与单路径预检测一致：跟随根目录下 .lnk 快捷方式（目录→收集目标下视频；视频文件→直接计入）
        let items;
        try { items = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { items = []; }
        const lnks = [];
        for (const ent of items) if (ent.isFile() && path.extname(ent.name).toLowerCase() === '.lnk') lnks.push(path.join(p, ent.name));
        if (lnks.length) {
          const map = await this._resolveShortcutTargetsAsync(lnks);
          if (map) for (const l of lnks) {
            const t = map[l];
            if (!t) continue;
            let ts;
            try { ts = fs.statSync(t); } catch (e) { continue; }
            if (ts.isDirectory()) {
              for (const f of walkFiles(t)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) cands.push(f);
            } else if (ts.isFile() && VIDEO_EXTS.has(path.extname(t).toLowerCase())) cands.push(t);
          }
        }
      } else if (st.isFile() && VIDEO_EXTS.has(path.extname(p).toLowerCase())) cands.push(p);
      for (const f of cands) if (!seen.has(f)) { seen.add(f); allVideos.push(f); }
    }
    return allVideos;
  }

  async resetPrecheck(onProgress) {
    // 使用前校验：环境失效时重建必然把全部素材判无效（白跑一遍），先拦住
    const envG = this._envGuard('reset_precheck');
    if (envG) return envG;
    this._videoCache = {};
    this._videoInfoCache = new Map();
    // 不在开始时删除物理缓存：探测全部完成后才经 _saveVideoCache 原子替换覆盖原缓存；
    // 若中途取消/异常，原缓存文件保持有效可复用，未完成的探测结果不落盘。

    // 收集所有配置指向的素材路径（跨路径去重）
    const allVideos = await this._gatherAllVideos();

    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const total = allVideos.length;
    let probed = 0, valid = 0;
    const cache = this._loadVideoCache();
    const token = ++this._precheckToken; // 本次探测的令牌：作废任何更早的后台探测
    await this._runWithLimit(allVideos, async (f) => {
      // 行内预检测优先：后台探测遇用户操作让路（每批轮询，短暂让出 IO）
      if (this._inlineProbing > 0) await new Promise((r) => setTimeout(r, 80));
      const info = await this._probeVideoAsync(f);
      cache[f] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(f)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(f) };
      this._videoInfoCache.set(f, info);
      probed++;
      if (info.valid) valid++;
      report({ done: probed, total });
    }, this.probeConcurrency, () => token !== this._precheckToken);

    const cancelled = token !== this._precheckToken;
    if (cancelled) { // 取消/中断：丢弃本次内存探测结果，下次从原缓存文件重新加载（不覆盖原文件）
      this._videoCache = null;
      this._videoInfoCache = new Map();
    } else { await this._saveVideoCache(true); } // 全部完成才整体替换缓存；取消/中断时保留原缓存
    report({ done: probed, total, finished: true, cancelled });
    return { ok: true, total, valid, invalid: total - probed, cancelled };
  }

  // 仅刷新预缓存：不删缓存、不重置，只对「缺失或 mtime 已变」的视频重新探测更新；
  // 命中（缓存有效）的路径直接跳过，进度按全量候选回报（起始即跳过数）
  async refreshPrecache(onProgress) {
    const envG = this._envGuard('refresh_precache');
    if (envG) return envG;
    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const allVideos = await this._gatherAllVideos();
    const total = allVideos.length;
    const cache = this._loadVideoCache();
    const toProbe = [];
    for (const f of allVideos) {
      const c = cache[f];
      // 指纹 = mtime + 大小：覆盖同名素材时时间戳可能被保留（CopyFile / 解压 / 同步工具都如此），
      // 只比 mtime 会漏判 —— 表现为「刷新预缓存」跳过了其实已被替换的文件
      const fp = this._fileFingerprint(f);
      if (c && this._fingerprintMatches(fp, c.LastWriteTime, c.FileSize)) continue; // 已缓存且文件未变：跳过
      toProbe.push(f);
    }
    const base = total - toProbe.length; // 进度起点 = 已跳过数
    const token = ++this._precheckToken; // 作废旧探测，保证只跑本次
    let probed = 0, valid = 0;
    await this._runWithLimit(toProbe, async (f) => {
      // 行内预检测优先：与全量重置同一让路策略
      if (this._inlineProbing > 0) await new Promise((r) => setTimeout(r, 80));
      const info = await this._probeVideoAsync(f);
      cache[f] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(f)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(f) };
      this._videoInfoCache.set(f, info);
      this._markVideoCacheDirty(f);
      probed++;
      if (info.valid) valid++;
      report({ done: base + probed, total });
    }, this.probeConcurrency, () => token !== this._precheckToken);

    const cancelled = token !== this._precheckToken;
    if (cancelled) { // 取消/中断：丢弃本次内存增量，下次从原缓存重新加载（不覆盖原缓存）
      this._videoCache = null;
      this._videoInfoCache = new Map();
    } else { await this._saveVideoCache(); } // 已完成的增量结果才写入缓存；取消/中断保留原缓存
    report({ done: base + probed, total, finished: true, cancelled });
    // 失效清理放到后台执行（用户主动点刷新即清，不受后台 1h 节流限制）。
    // 传入本次刚枚举出的路径集合：这些文件必然存在，GC 直接判「保留」，不再逐条 fs.stat
    // （同步 existsSync 会占住主线程数秒～数十秒，把紧随其后的行内预检测 IPC 一起堵住，
    //  前端表现为刷新完成后徽章仍长时间停在「检测中…」）；剩余候选项也已异步分批并让路事件循环。
    // 遮罩素材：单独认领使用计数并落库标注 mask 作用域 ——
    // 作用域位掩码即归属标记（与批量/复刻分开，同一素材多模式共用时按位或累加）；
    // 它们已在 allVideos 中，失效清理不会误判为「非当前 root 的残留」而删除；
    // 素材被暂时删除/替换时，DB 侧只置 missing_since 走软删除，并在保留期内等待新路径认领。
    if (!cancelled) {
      const maskFiles = [];
      for (const d of this._maskSessionDirs()) {
        try {
          const st = fs.statSync(d);
          if (st.isDirectory()) { for (const f of walkFiles(d)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) maskFiles.push(f); }
          else if (VIDEO_EXTS.has(path.extname(d).toLowerCase())) maskFiles.push(d);
        } catch (e) { /* 目录不存在时跳过（软删除留待保留期处理） */ }
      }
      if (maskFiles.length) {
        const claimedMask = this._claimUsageForPaths(maskFiles, this._scopes.mask);
        if (claimedMask > 0) console.log('[video_cache] 遮罩素材认领既有使用计数 ' + claimedMask + ' 条');
        for (const f of maskFiles) {
          const c = cache[f];
          if (c && typeof c.Duration === 'number') {
            this._saveScopedVideoInfo(f, { duration: c.Duration, width: c.Width || 0, height: c.Height || 0, valid: !!c.Valid }, this._scopes.mask);
          }
        }
      }
    }
    if (!cancelled) {
      this._gcVideoCache(new Set(allVideos))
        .then((n) => { if (n > 0) console.log('[video_cache] 后台清理失效条目 ' + n + ' 条'); })
        .catch(() => { /* 后台清理失败不影响刷新结果 */ });
    }
    return { ok: true, total, updated: probed, valid, cancelled, removed: 0 };
  }

  // 收集某配置目录下的日志候选并解析为成片条目（按目录 mtime 缓存）
  _collectLogEntries(baseDir) {
    const candidates = new Set();
    try {
      for (const f of fs.readdirSync(baseDir)) {
        if (!f.toLowerCase().endsWith('.txt')) continue;
        if (LOG_NAME_RE.test(f)) candidates.add(path.join(baseDir, f));
      }
      for (const sub of fs.readdirSync(baseDir)) {
        const d = path.join(baseDir, sub);
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
        if (!sub.endsWith('成片')) continue;
        for (const f of fs.readdirSync(d)) if (f.toLowerCase().endsWith('.txt') && LOG_NAME_RE.test(f)) candidates.add(path.join(d, f));
      }
    } catch (e) {}
    let entries = [];
    for (const lp of [...candidates].sort()) entries = entries.concat(this._parseLog(lp));
    return entries;
  }

  // 从日志文件名提取其所归属的配置名（批量拼接日志形如 MMdd-HH时MM分-配置名-拼接日志.txt）
  _configNameFromLog(logPath) {
    const m = /^\d{4}-\d+时\d+分-(.+)-(?:拼接|复刻)日志\.txt$/i.exec(path.basename(logPath || ''));
    return m ? m[1].trim() : '';
  }

  // 收集根目录下所有属于某复刻模式的日志文件（命名形如 MMdd-模式名日志.txt）
  // 复刻日志清单：**结果缓存化**（不要直接 walkFiles 全量遍历）—— `_buildProjectsData` 会为
  // 两种复刻模式各调一次，未缓存时启动期可达数千次 readdirSync。
  _replicaLogFiles(modeName) {
    const esc = String(modeName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp('^\\d{4}-' + esc + '日志\\.txt$');
    // ① 内存/持久化缓存（零 IO）——缓存优先是默认行为
    const cached = this._replicaLogFilesCached(modeName);
    if (cached) return cached;
    // ② 缓存缺失（首次运行 / 新机器）：不在这里全量遍历，排队后台重建后刷新界面
    this._enqueueReplicaLogRebuild();
    return [];
  }

  // 复刻日志清单缓存：一次遍历把「所有复刻模式的日志」都算出来存库，之后启动零遍历
  _replicaLogFilesCached(modeName) {
    const key = String(modeName || '');
    const mem = this._replicaLogCache;
    if (mem && mem.root === this.root && mem.byMode && mem.byMode[key]) return mem.byMode[key];
    if (!this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getKv('replica_logs:' + this.root);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.byMode) return null;
      this._replicaLogCache = { root: this.root, byMode: data.byMode, fp: String(data.fp || '') };
      this._enqueueScanVerify();
      return Array.isArray(data.byMode[key]) ? data.byMode[key] : null;
    } catch (e) { return null; }
  }

  _saveReplicaLogCache() {
    if (!this._useDbCache() || !this._replicaLogCache) return;
    try {
      this._cacheStore.setKv('replica_logs:' + this.root,
        JSON.stringify({ fp: this._replicaLogCache.fp || '', byMode: this._replicaLogCache.byMode || {} }));
    } catch (e) {}
  }

  // 启动期缓存缺失 → 后台一次性遍历，把所有复刻模式的日志清单都建好并落库
  _enqueueReplicaLogRebuild() {
    this._verifyEnqueue('repbuild', this.root, async () => {
      const byMode = {};
      let modes = [];
      try { modes = REPLICA_MODES.slice(); } catch (e) { modes = []; }
      let fp = '';
      try { fp = await this._logTreeFingerprintAsync(); } catch (e) {}
      if (this.root && fs.existsSync(this.root)) {
        const all = [];
        try { for (const full of walkFiles(this.root)) { if (path.basename(full).toLowerCase().endsWith('.txt')) all.push(full); } } catch (e) {}
        for (const m of modes) {
          const esc = String(m || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pat = new RegExp('^\\d{4}-' + esc + '日志\\.txt$');
          byMode[m] = all.filter((f) => pat.test(path.basename(f))).sort();
        }
      }
      this._replicaLogCache = { root: this.root, byMode, fp };
      this._saveReplicaLogCache();
      this._projectsCache = null;
      try { this._emitTasks(); } catch (e) {}
      try { if (this._lg) this._lg('ADD', 'replica.logs.rebuild', '复刻日志清单已后台重建并落库', { modes: Object.keys(byMode).length }); } catch (e) {}
    });
  }

  _replicaLogs(modeName) {
    let entries = [];
    for (const lp of this._replicaLogFiles(modeName)) entries = entries.concat(this._parseLog(lp));
    return entries;
  }

  // 复刻模式对应的完整日志行内容（与 logContent 同结构，便于右侧继续跳转高亮）
  _replicaLogContent(modeName) {
    const files = []; const entries = []; let running = 1;
    for (const lp of this._replicaLogFiles(modeName)) {
      let text;
      try { text = readText(lp); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      files.push({ path: lp, name: path.basename(lp), lines });
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '使用片段列表：') continue;
        if (i < 1) continue;
        let name = lines[i - 1].trim();
        const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
        if (m) name = m[1].trim().replace(/=+$/, '').trim();
        entries.push({ video: name, logPath: lp, lineStart: running + i });
      }
      running += lines.length;
    }
    return { files, entries };
  }

  listLogs(project, name, versionPath) {
    if (versionPath && String(versionPath).startsWith(REPLICA_MARK)) {
      return this._replicaLogs(String(versionPath).slice(REPLICA_MARK.length));
    }
    const all = this._clipEntriesFor(path.dirname(path.resolve(versionPath)));
    const target = String(name == null ? '' : name).trim();
    if (!target) return all;
    return all.filter((e) => this._configNameFromLog(e.log_path) === target);
  }

  // ── 成片名搜索索引：仅索引日志解析出的成片条目（video/clips/watermark/log_path）。
  //    以「配置目录」为单位按目录 mtime 失效，命中直接读内存，未命中重扫该目录；
  //    与数据缓存同库（cache.db 的 clip_index 表），冷启动直接复用，避免每次搜索全量读盘解析。
  //    旧数据由布局迁移器并入（见 engines/base/migrate.js）。
  // 打开索引所在连接：与数据缓存同库，直接复用其连接；库不可用时返回 null → 索引退化为纯内存模式
  _openClipDb() {
    try {
      if (!this._useDbCache() || !this._cacheStore) return null;
      return this._cacheStore.open();
    } catch (e) { return null; }
  }

  _loadClipIndex() {
    if (this._clipIndex && this._clipIndexRoot === this.root) return;
    this._clipIndexRoot = this.root;
    this._clipIndex = new Map();
    const db = this._openClipDb();
    if (!db) return;
    try {
      const rows = db.prepare('SELECT dir, mtime, entries FROM clip_index').all();
      const prefix = String(this.root || '').replace(/[\\/]+$/, '');
      for (const r of rows) {
        if (!String(r.dir).startsWith(prefix)) continue; // 仅载入当前工作目录下的条目
        try { this._clipIndex.set(r.dir, { mtime: r.mtime, entries: JSON.parse(r.entries) }); } catch (e) {}
      }
    } catch (e) {}
  }

  _saveClipIndex() {
    if (!this._clipIndexDirty) return;
    if (!this._openClipDb()) { this._clipIndexDirty = false; return; } // 纯内存态：无需落盘
    const db = this._cacheStore.open();
    try {
      this._cacheStore.transaction(() => {
        const ins = db.prepare('INSERT INTO clip_index(dir, mtime, entries) VALUES (?, ?, ?) ON CONFLICT(dir) DO UPDATE SET mtime=excluded.mtime, entries=excluded.entries');
        this._clipIndex.forEach((v, k) => { if (Array.isArray(v.entries)) ins.run(k, v.mtime, JSON.stringify(v.entries)); });
      });
      this._clipIndexDirty = false;
    } catch (e) {}
  }

  // 某配置目录的成片条目：目录 mtime 未变直接命中索引，否则重扫该目录并重建索引条目
  _clipEntriesFor(baseDir) {
    this._loadClipIndex();
    let mtime = 0;
    try { mtime = fs.statSync(baseDir).mtimeMs; } catch (e) {}
    const hit = this._clipIndex.get(baseDir);
    if (hit && hit.mtime === mtime) return hit.entries;
    const entries = this._collectLogEntries(baseDir);
    this._clipIndex.set(baseDir, { mtime, entries });
    this._clipIndexDirty = true;
    this._saveClipIndex();
    return entries;
  }

  // 重新检测配置时全量重建索引并落盘（后续搜索/日志列表直接命中，无需再逐目录解析）
  // onStep(done,total)：每批目录解析完回调一次（供实时进度），末批后落盘
  _rebuildClipIndex(onStep) {
    this._loadClipIndex();
    this._clipIndex.clear();
    const dirs = new Set();
    for (const t of this._collectAllTxt()) dirs.add(path.dirname(t.full));
    const list = [...dirs];
    const total = list.length;
    const tick = (done) => { if (typeof onStep === 'function') { try { onStep(done, total); } catch (e) {} } };
    const step = () => {
      if (!this._rebuildingClip) { this._saveClipIndex(); return; } // 换工作目录等取消信号：停止并落盘当前进度
      const batch = list.splice(0, 20);
      for (const d of batch) {
        let entries;
        try { entries = this._collectLogEntries(d); } catch (e) { entries = []; }
        let mtime = 0;
        try { mtime = fs.statSync(d).mtimeMs; } catch (e) {}
        this._clipIndex.set(d, { mtime, entries });
        this._clipIndexDirty = true;
      }
      tick(total - list.length);
      if (list.length > 0) setImmediate(step);
      else {
        this._saveClipIndex();
        this._rebuildingClip = false;
        this._emitScan('done');
      }
    };
    setImmediate(step);
  }

  // 成片索引后台重建入口：防并发重复触发；每 20 目录让出一次事件循环，避免长时间阻塞主线程
  _rebuildClipIndexAsync() {
    if (this._rebuildingClip) return;
    this._rebuildingClip = true;
    this._rebuildClipIndex((done, total) => this._emitScan('clip', done, total));
  }

  _logsForTxt(txtFull) {
    return this._clipEntriesFor(path.dirname(txtFull));
  }

  // 全局成片名搜索：跨越所有项目/TXT/日期分支，返回包含该成片的日志定位信息
  searchLogs(query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const seen = new Set();
    for (const t of this._collectAllTxt()) {
      const entries = this._logsForTxt(t.full);
      for (const e of entries) {
        const v = String(e.video || '');
        if (!v.toLowerCase().includes(q)) continue;
        // 日志条目仅归属其同名配置（同日期目录下多配置并存时互不串扰）
        const cfgName = this._configNameFromLog(e.log_path);
        if (!cfgName) continue;
        let tName = t.name;
        if (tName.charAt(0) === '*') tName = tName.slice(1).trim(); // 当日外部 * 配置：按去前缀名匹配
        if (cfgName !== tName) continue;
        const key = e.log_path + '\u0000' + v;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          project: path.basename(t.pdir),
          txtName: t.name,
          label: relativeDateLabel(t.parts),
          logPath: e.log_path,
          txtPath: t.full,
          video: v,
          clips: e.clips,
          watermark: e.watermark,
        });
      }
    }
    return out;
  }

  // 返回某配置对应的日志文件列表（日志模式下日期分支使用）
  // 与配置同一判定规则：取 fromPath(配置) 路径中最近的 4 位 MMdd 目录作为日期分支，日志按同项目+同日期+同名匹配
  listLogFiles(fromPath, configName) {
    if (fromPath && String(fromPath).startsWith(REPLICA_MARK)) {
      const mode = String(fromPath).slice(REPLICA_MARK.length);
      // 排序与普通项目保持一致：按日期降序（最新在前）。⚠ 不能直接返回未排序列表 ——
      // 那会按「项目名 → 月份目录 → 日期目录」的路径字符串排列，跨月即错乱（如 "10月" < "7月"）。
      // date 取文件名前 4 位「月日」；跨年不区分（届时再想简洁的区分办法）。
      const list = this._replicaLogFiles(mode).map((f) => {
        const name = path.basename(f);
        const date = name.slice(0, 4);
        // 分支标签带项目名（MMDD-项目名）：同一天多个项目都做过复刻时，仅凭 MMDD 分辨不出是哪个项目
        //。项目名取相对根目录的第一段目录。
        const proj = this._projectOf(f);
        return { path: f, name, date, label: proj ? (date + '-' + proj) : date };
      });
      list.sort((a, b) => (b.date.localeCompare(a.date) || a.name.localeCompare(b.name)));
      return list;
    }
    // 使用刷新时写入的日志缓存，按项目 + 配置名过滤（不限定单一日期，展示该配置的全部日志日期分支）
    // 每条日志附加所属配置版本 label（同成片文件夹的序号化 -N/正本优先，否则当日外部 *），
    // 使日志分支序号与配置版本序号一一对应
    const project = this._projectOf(fromPath);
    const target = String(configName == null ? '' : configName).trim();
    const versions = this.listVersions(project, target);
    const files = this._collectLogFiles().files
      .filter((f) => f.project === project && (!target || f.config === target))
      .map((f) => {
        const d = f.date;
        let label = null;
        for (const v of versions) {
          if (v.isExternal) continue;
          if (String(v.label || '').slice(0, 4) === d && path.dirname(v.path) === path.dirname(f.path)) { label = v.label; break; }
        }
        if (!label) {
          for (const v of versions) {
            if (v.isExternal && String(v.label || '').slice(0, 4) === d) { label = v.label; break; }
          }
        }
        return { path: f.path, name: f.name, date: f.date, label: label || f.date };
      });
    files.sort((a, b) => (b.date.localeCompare(a.date) || a.name.localeCompare(b.name)));
    return files;
  }

  // 日志对应的复刻输出目录：取日志路径中首个日期段（月份/MMdd）之前为基址，
  // 拼接 <月份>/<MMdd>/<模式目录>；返回复刻目录及命中的复刻产物（无匹配文件时仍给目录，供"打开文件夹"使用）
  findReplicaOutput(logPath, videoName) {
    const out = { originalDir: '', replicaDir: '', replicaFile: '' };
    if (!logPath) return out;
    const abs = path.resolve(String(logPath));
    out.originalDir = path.dirname(abs);
    const parts = abs.split(path.sep);
    let idx = parts.findIndex((p) => /^\d+月$/.test(p));
    if (idx < 0) idx = parts.findIndex((p) => /^\d{4}$/.test(p));
    if (idx < 0) return out;
    const base = parts.slice(0, idx).join(path.sep);
    const month = parts[idx];
    const day = parts[idx + 1] && /^\d{4}$/.test(parts[idx + 1]) ? parts[idx + 1] : '';
    const root = day ? path.join(base, month, day) : path.join(base, month);
    for (const mode of ['去重复刻', '原片复刻']) {
      const dir = path.join(root, mode);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      out.replicaDir = dir;
      try {
        const baseName = String(videoName || '').replace(/\.mp4$/i, '').toLowerCase();
        if (baseName) {
          const hit = fs.readdirSync(dir).find((n) => /\.mp4$/i.test(n) && (n.toLowerCase().replace(/\.mp4$/i, '') === baseName || n.toLowerCase().replace(/\.mp4$/i, '').replace(/^\d{6}改\d*-/, '') === baseName));
          if (hit) out.replicaFile = path.join(dir, hit);
        }
      } catch (e) {}
      break;
    }
    return out;
  }

  logContent(fromPath, configName) {
    if (fromPath && String(fromPath).startsWith(REPLICA_MARK)) {
      return this._replicaLogContent(String(fromPath).slice(REPLICA_MARK.length));
    }
    const baseDir = path.dirname(path.resolve(fromPath));
    const target = String(configName == null ? '' : configName).trim();
    const candidates = new Set();
    try {
      for (const f of fs.readdirSync(baseDir)) {
        if (!f.toLowerCase().endsWith('.txt')) continue;
        if (LOG_NAME_RE.test(f)) candidates.add(path.join(baseDir, f));
      }
      for (const sub of fs.readdirSync(baseDir)) {
        const d = path.join(baseDir, sub);
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
        if (!sub.endsWith('成片')) continue;
        for (const f of fs.readdirSync(d)) if (f.toLowerCase().endsWith('.txt') && LOG_NAME_RE.test(f)) candidates.add(path.join(d, f));
      }
    } catch (e) {}
    const files = [];
    const entries = [];
    let running = 1;
    for (const lp of [...candidates].sort()) {
      if (target && this._configNameFromLog(lp) !== target) continue;
      let text;
      try { text = readText(lp); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      files.push({ path: lp, name: path.basename(lp), lines });
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '使用片段列表：') continue;
        if (i < 1) continue;
        let name = lines[i - 1].trim();
        const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
        if (m) name = m[1].trim().replace(/=+$/, '').trim();
        entries.push({ video: name, logPath: lp, lineStart: running + i });
      }
      running += lines.length;
    }
    return { files, entries };
  }

  // 批量检查片段路径是否存在，返回 { 原路径: true/false }
  checkExists(paths) {
    const out = {};
    const arr = Array.isArray(paths) ? paths : [];
    for (const p of arr) {
      const s = String(p == null ? '' : p).trim().replace(/^"|"$/g, '');
      if (!s) continue;
      try { out[s] = fs.existsSync(s); } catch (e) { out[s] = false; }
    }
    return out;
  }

  _parseLog(logPath, text) {
    if (text == null) text = readText(logPath);
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const entries = [];
    let current = { video: '', clips: [], watermark: '', log_path: logPath };
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (line === '使用片段列表：') {
        if (current.video || current.clips.length) entries.push(current);
        let name = '';
        if (idx > 0) name = lines[idx - 1];
        const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
        if (m) name = m[1].trim().replace(/=+$/, '').trim();
        current = { video: name, clips: [], watermark: '', log_path: logPath };
        continue;
      }
      if (/^[A-Za-z]:[\\/]/.test(line) || /^\\\\/.test(line)) {
        const p = line.trim().replace(/^['"]|['"]$/g, '');
        if (p.toLowerCase().endsWith('.png')) current.watermark = p;
        else if (VIDEO_EXTS.has(path.extname(p).toLowerCase())) current.clips.push(p);
        else current.clips.push(p);
      }
    }
    if (current.video || current.clips.length) entries.push(current);
    return entries;
  }

  // 任务管理 -------------------------------------------------
  // 任务定位信息：解析任务来源（配置 TXT / 日志 TXT）供主窗口「定位至配置/日志」
  taskLocate(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    const info = { ok: true, project: '', name: '', txtPath: '', logPath: '', mode: t.type === 'replica' ? 'log' : '' };
    const src = String((t.env && t.env.REPLICA_TXT) || '').trim();
    if (src) {
      const abs = path.resolve(src);
      info.name = path.basename(abs, path.extname(abs));
      if (this.root) {
        const rel = path.relative(this.root, abs).split(path.sep);
        if (rel.length && rel[0] !== '..') info.project = rel[0];
      }
      if (t.type === 'replica') {
        info.project = REPLICA_PROJECT; // 主窗口定位目标为虚拟复刻项目
        // 输出目录与复刻日志按提交日期推算（与脚本 Get-TaskDate 一致），模式名来自 REPLICA_MODE
        const outc = this._replicaOutInfo(t);
        if (!outc) return { ok: false, error: '缺少复刻源日志，无法定位' };
        // 复刻输出目录未生成：不允许定位（不得退回源日志日期目录）
        if (!outc.outDir || !fs.existsSync(outc.outDir) || !fs.statSync(outc.outDir).isDirectory()) {
          return { ok: false, error: '复刻成片文件夹未生成，无法定位' };
        }
        info.replicaMode = outc.mode;
        // 定位本次复刻生成的输出日志（<MMdd>-<模式名>日志.txt，取同日最新）；无日志文件同样拒绝定位
        let logFile = '';
        try {
          const pat = new RegExp('^\\d{4}-' + outc.mode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '日志\\.txt$');
          const logs = fs.readdirSync(outc.outDir).filter((n) => pat.test(n)).sort();
          if (logs.length) logFile = path.join(outc.outDir, logs[logs.length - 1]);
        } catch (e) {}
        if (!logFile) return { ok: false, error: '未找到本次复刻的日志文件，无法定位' };
        info.logPath = logFile;
      }
      else info.txtPath = abs;
    }
    // 批量任务：成片目录内优先匹配当前配置的日志 TXT
    if (t.type === 'batch' && t.outDir) {
      try {
        const hit = fs.readdirSync(t.outDir).find((n) => LOG_NAME_RE.test(n));
        if (hit) info.logPath = path.join(t.outDir, hit);
      } catch (e) {}
    }
    return info;
  }

  // 复刻任务的输出目录推算：与 旧版脚本 的 Get-TaskDate + baseDir 规则完全一致——
  // 日期用提交时刻（REPLICA_SUBMIT_TS，续跑亦注入），层级 月份/MMdd/模式名；
  // baseDir 取源日志路径中首个月份/MMdd 段之前，无日期段时回退日志所在目录
  _replicaOutInfo(t) {
    const env = (t && t.env) || {};
    const src = String(env.REPLICA_TXT || '').trim();
    const mode = String(env.REPLICA_MODE || '1') === '2' ? '去重复刻' : '原片复刻';
    if (!src) return null;
    let d = new Date();
    const ts = Number(env.REPLICA_SUBMIT_TS || 0);
    if (ts > 0) d = new Date(ts);
    const month = (d.getMonth() + 1) + '月';
    const day = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const parts = path.resolve(src).split(path.sep);
    let idx = parts.findIndex((p) => /^\d+月$/.test(p));
    if (idx < 0) idx = parts.findIndex((p) => /^\d{4}$/.test(p));
    let base;
    if (idx > 0) base = parts.slice(0, idx).join(path.sep);
    else if (idx === 0) base = parts[0];
    else base = path.dirname(path.resolve(src));
    return { outDir: path.join(base, month, day, mode), mode };
  }

  // 复刻任务的成片输出目录：按提交日期推算复刻产物目录（月份/MMdd/模式目录）；
  // 目录不存在即明确报错「未生成」，绝不退而求其次指向源日志目录（那里是原始日志与素材）
  taskReplicaOutputDir(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.type !== 'replica') return { ok: false, error: '非复刻任务' };
    const outc = this._replicaOutInfo(t);
    if (!outc) return { ok: false, error: '缺少复刻源日志' };
    if (!outc.outDir || !fs.existsSync(outc.outDir) || !fs.statSync(outc.outDir).isDirectory()) {
      return { ok: false, error: '复刻成片文件夹未生成' };
    }
    return { ok: true, dir: outc.outDir };
  }

  // ── 任务 TXT 快照 ──
  // 引擎执行成功后会「把 TXT 移入成片目录作为正本」，而 TXT 路径由「项目/月/MMdd/配置名」决定：
  // 同一配置名在同一天提交多个任务时指向同一个文件，前一个任务把它搬走后，后一个任务就没有 TXT 可用；
  // 排队期间重新生成配置又会覆盖该文件，让先提交的任务用到后改的配置。
  // 故入队时固化一份任务专属副本，启动前按快照还原（原位内容与快照一致则跳过），两个问题一并解决。
  _txtSnapPath(taskId) {
    return this.storageDir ? path.join(this.storageDir, 'txt-snap', String(taskId) + '.txt') : '';
  }
  _snapshotTaskTxt(task) {
    try {
      const src = String((task && task.env && task.env.REPLICA_TXT) || '').trim();
      const dst = this._txtSnapPath(task && task.id);
      if (!src || !dst || !fs.existsSync(src) || !fs.statSync(src).isFile()) return;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch (e) { /* 快照失败不阻断入队，退回原有行为 */ }
  }
  _restoreTaskTxt(task) {
    try {
      const src = String((task && task.env && task.env.REPLICA_TXT) || '').trim();
      const snap = this._txtSnapPath(task && task.id);
      if (!src || !snap || !fs.existsSync(snap)) return; // 无快照（历史任务）保持原行为
      if (fs.existsSync(src)) {
        const a = fs.readFileSync(src);
        const b = fs.readFileSync(snap);
        if (a.length === b.length && a.equals(b)) return;
      }
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.copyFileSync(snap, src);
      // 仅在真正写回时留痕：此时原位配置已被同名其他任务搬走，或被重新生成的配置覆盖
      if (task.log) task.log.push('[已按提交快照还原配置] ' + path.basename(src));
      this._lg('MOD', 'task.txtsnap', '按提交快照还原配置 · ' + String(task.title || '').slice(0, 50),
        { id: task.id, txt: src });
    } catch (e) { /* 还原失败则交由引擎按原样报错 */ }
  }

  _createTask(type, title, env, srcPath) {
    const id = 'task_' + (++this.taskSeq) + '_' + Date.now().toString(36);
    const task = {
      id, type, title, env: Object.assign({}, env),
      pid: null, status: 'queued', lockState: 'unknown', progress: { current: 0, total: 0 },
      failReason: '', log: [],
      createdAt: Date.now(), startedAt: null, endedAt: null, _stopRequested: false,
      planPos: 0,
      outDir: this._taskOutDir(type, srcPath, env),
      groupDate: this._taskGroupDate(type, env, Date.now()), // 业务归属日 MMDD：凌晨0-4点完成/提交归前一天（仅前端排序使用，不展示）
    };
    this.tasks.set(id, task);
    this._snapshotTaskTxt(task);
    this._emitTasks();
    return task;
  }

  // 续跑任务标题：反复续跑时不要把「（续跑）」累加成一串。
  _resumeTitle(base) {
    return String(base || '').replace(/（续跑）\s*$/, '').trim() + '（续跑）';
  }

  // 续跑任务继承原任务的「失败依据」。
  // 为什么必须继承：续跑任务若在早期步骤失败（如续跑过滤），它自身既无失败记录也无进度
  // （total 初始为 0）→ 前端判定「无失败可续」，只给「重新开始」，用户被迫整批重做。
  // 把失败序号 / 失败记录 / 进度总量一并带过去，任何一次续跑失败都不会再把「可继续」的能力弄丢。
  _inheritResumeBasis(task, t, env) {
    try {
      if (Array.isArray(t.failedIndices) && t.failedIndices.length) {
        task.failedIndices = t.failedIndices.filter((n) => Number.isInteger(n) && n > 0).slice();
        task._inheritedFailIndices = task.failedIndices.length;
      }
      if (Array.isArray(t.failedVideos) && t.failedVideos.length) {
        task.failedVideos = t.failedVideos.slice();
        task._inheritedFailVideos = task.failedVideos.length;
      }
      // ── 本批进度视角：续跑任务本次只做 N 片，但卡片要能同时表达「本批」的完成度 ──
      // batchTotal    = 本批总量（整批要出的片数；续跑不改变它）
      // batchBase     = 本次续跑开始前本批已产出的片数（= 本批总量 − 本次待补数）
      // resumeIndices = 本次补做的绝对序号（供卡片标注 #4 #6 #20）
      // total         = 本次视角的分母（本次补做数）
      const batchTotal = Number((env || {}).BATCH_COUNT) || Number((t.progress && t.progress.batchTotal)) || 0;
      const onlyIdx = String((env || {}).BATCH_ONLY_INDEX || '').split(';')
        .map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
      const onlyCnt = onlyIdx.length || (Array.isArray(t.failedIndices) ? t.failedIndices.length : 0);
      const patch = {};
      if (batchTotal > 0) { patch.batchTotal = batchTotal; patch.batchBase = Math.max(0, batchTotal - onlyCnt); }
      if (onlyIdx.length) patch.resumeIndices = onlyIdx.slice(0, 60);
      patch.total = onlyCnt > 0 ? onlyCnt : (Number((t.progress && t.progress.total)) || 0);
      task.progress = Object.assign({}, task.progress, patch);

      // ── 日志续写：把上一次运行的日志（含更早的续跑）保留在新任务日志之前，绝不覆盖 ──
      const carry = Array.isArray(t.log) ? t.log.slice(-500) : [];
      if (carry.length) {
        task.log = carry.concat([
          '[—— 以上为上一次运行（含更早的续跑）的日志 ——]',
          '[—— 本次续跑开始：仅补做 ' + (onlyCnt || '若干') + ' 片'
            + (onlyIdx.length ? '（序号 ' + onlyIdx.join(', ') + '）' : '') + ' ——]',
        ]);
      }
    } catch (e) { /* 继承失败不影响续跑本身 */ }
    return task;
  }

  // 任务成片文件夹：批量任务按提交时刻+配置名精确推算（与脚本实际输出目录一致）；
  // 其余类型取源 TXT 所在目录下以「成片」结尾的子目录。
  // 找不到即返回空串：绝不回退成源目录 —— 源目录放着原始日志与素材，
  // 一旦被当成成片目录用于打开/删除，会直接误伤业务文件。
  _taskOutDir(type, srcPath, env) {
    // 视频处理工具没有「成片目录」概念 —— 必须显式返回空串。
    // 否则会落到下面的「找以成片结尾的子目录」分支，把源目录旁的成片目录当成工具任务的产物目录，
    // 而那正是后续删除类操作的目标。
    if (type === 'tool') return '';
    if (type === 'mask') {
      const out = String((env && env.MASK_OUTPUT_DIR) || '').trim();
      return out ? path.resolve(out) : '';
    }
    if (type === 'batch') {
      const detail = this._batchTaskOutDetail({ env: env || {}, createdAt: Date.now() });
      if (detail && detail.outDir) return detail.outDir;
      return '';
    }
    const d = path.dirname(path.resolve(srcPath));
    try {
      for (const e of fs.readdirSync(d)) {
        if (String(e).endsWith('成片')) {
          const f = path.join(d, e);
          if (fs.statSync(f).isDirectory()) return f;
        }
      }
    } catch (e2) {}
    return '';
  }

  // 业务归属日（MMDD）：按任务提交/创建时刻，凌晨 0-4 点归入前一天（跨日任务视同昨天产出）。
  // 批量/遮罩任务优先取提交时刻（*_SUBMIT_TS），缺失时用创建时刻兜底；仅用于前端排序，不展示。
  _taskGroupDate(type, env, createdAt) {
    if (type !== 'batch' && type !== 'mask') return '';
    const ts = Number(env && env.MASK_SUBMIT_TS) || Number(env && env.BATCH_SUBMIT_TS) || Number(env && env.REPLICA_SUBMIT_TS) || Number(createdAt) || Date.now();
    const d = new Date(ts);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getMonth() + 1) + p(d.getDate());
  }

  // 排队执行：无运行任务则立即启动，否则进入队列（软件安排制作顺序）
  _enqueueTask(task) {
    // 分配计划序号（新建任务/恢复任务都经由此处或 resumeTask 分配）
    if (!task.planPos) task.planPos = ++this._planSeq;
    if (!this._runningTaskId) {
      this._runningTaskId = task.id;
      task.status = 'running';
      // 解除计时冻结：把暂停 / 排队这段并入总暂停时长，之后才继续累计耗时
      if (task.pausedAt) { task.totalPausedMs = (task.totalPausedMs || 0) + (Date.now() - task.pausedAt); task.pausedAt = null; }
      task.log.push('[开始运行]');
      this._emitTasks();
      this._spawnEngine(task.type, task.env, task);
    } else {
      task.status = 'queued';
      // 排队等待不算运行耗时：先冻结计时，真正开始运行（_startNextQueued）时才解除
      if (!task.pausedAt) task.pausedAt = Date.now();
      task.log.push('[已加入执行队列，等待前序任务完成]');
      this._taskQueue.push(task.id);
      this._emitTasks();
    }
    return task;
  }

  // 当前任务结束（正常/失败/停止）后启动队列中的下一个任务
  _startNextQueued() {
    while (this._taskQueue.length) {
      const id = this._taskQueue.shift();
      const t = this.tasks.get(id);
      if (!t || t.status === 'stopped' || t._cancelled) continue;
      this._runningTaskId = id;
      t.status = 'running';
      // 解除计时冻结：排队 / 暂停这段不算运行耗时，并入总暂停时长后再累计
      if (t.pausedAt) { t.totalPausedMs = (t.totalPausedMs || 0) + (Date.now() - t.pausedAt); t.pausedAt = null; }
      t.log.push('[前序任务完成，开始运行本任务]');
      this._emitTasks();
      this._spawnEngine(t.type, t.env, t);
      return;
    }
  }

  // 置顶排队任务：让它成为下一个执行的任务（软件安排顺序）
  pinTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'queued') return { ok: false, error: '仅排队中的任务可置顶' };
    const i = this._taskQueue.indexOf(id);
    if (i > 0) { this._taskQueue.splice(i, 1); this._taskQueue.unshift(id); }
    // 重算队列计划序号，使显示顺序与执行顺序一致
    this._taskQueue.forEach((qid, k) => { this.tasks.get(qid).planPos = k + 1; });
    t.log.push('[已置顶，成为下一个执行的任务]');
    this._emitTasks();
    return { ok: true };
  }

  // 手动重排待运行顺序（拖拽排序）：ids 为「排队+暂停」任务的完整混合序列（不含运行中/已结束）
  //   按 ids 顺序重建执行队列并重算所有待运行任务的计划序号；暂停任务的冻结顺位（resumeIdx）同步刷新
  reorderTasks(ids) {
    if (!Array.isArray(ids)) return { ok: false, error: '参数无效' };
    const waiting = [];
    this.tasks.forEach((t, id) => {
      if (t.status === 'queued' || t.status === 'paused') waiting.push(id);
    });
    const cur = new Set(waiting);
    const given = new Set(ids.filter((id) => cur.has(id)));
    if (cur.size !== given.size || ids.length !== waiting.length) return { ok: false, error: '排序参数与待运行任务不一致' };
    for (const id of ids) if (!cur.has(id)) return { ok: false, error: '排序参数包含不可排序的任务' };
    const queue = [];
    let ord = 0;
    for (const id of ids) {
      const t = this.tasks.get(id);
      t.planPos = ++ord;
      // 暂停任务：前方待运行任务数 = 它在 ids 序列中的位置，作为新的冻结顺位
      if (t.status === 'paused') t.resumeIdx = ord - 1;
      else if (t.status === 'queued') queue.push(id);
    }
    this._taskQueue = queue;
    this._emitTasks();
    return { ok: true };
  }

  // 从任务日志中提取人类可读的失败原因（不展示代码/堆栈）
  _deriveFailReason(task) {
    const lines = task.log || [];
    // 环境是否仍可用：决定「无合格视频」到底是环境问题还是素材问题 ——
    // ⚠ 探测失败与「确实不合规」共用同一句引擎日志，不加区分会把人引向分辨率/时长排查。
    const envBad = !this.quickEnvCheck().ok;
    const rules = [
      [/连续\s*\d+\s*次重试无法找到满足时长的组合/, '多次尝试仍无法找到符合时长要求的视频组合'],
      [/部分输入文件不存在/, '部分输入视频文件不存在'],
      [/无有效视频片段/, '没有可用于拼接的有效视频片段'],
      [/一次性编码失败/, '视频编码失败（请检查源视频与 ffmpeg）'],
      [/无法自动修复/, '存在缺失的视频片段且无法自动修复'],
      [/检测到\s*\d+\s*个片段不存在/, '存在缺失的视频片段'],
      // ⚠ 两个分支都要留：新文案（里没有可用素材）+ 旧文案（过滤后无任何合规视频）——
      //   历史任务的日志里写的是旧句，去掉旧分支会让「重开旧任务」的原因归类失效。
      [/路径\s*.+?\s*(过滤后无任何合规视频|里没有可用素材)/, envBad ? 'FFmpeg / FFprobe 不可用' : '没有可用素材（只认竖版 1080×1920 且有时长的视频）'],
      [/以下路径无法通过索引自动修复/, '存在无法解析的视频路径，请检查 TXT 配置'],
      [/水印必须是有效PNG文件/, '水印文件无效（必须为 PNG 图片）'],
      [/无有效视频文件夹/, '没有可用的视频文件夹'],
      [/不是TXT格式/, '指定的文件不是 TXT 格式'],
      [/检测到重复成片名/, '存在重复的成片名'],
      [/全局异常/, '运行过程中出现异常'],
      [/(脚本|任务)完成（有错误）/, '运行出错'],
      [/ffmpeg|ffprobe/, 'FFmpeg 组件不可用'],
    ];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      for (const [re, msg] of rules) {
        if (re.test(line)) return msg;
      }
    }
    return '运行失败';
  }

  // 任务的成片是否还在磁盘上：仅对「已产出过」的已结束任务判定。
  // 用途是列表提示（成片消失时标题置灰），任务行本身始终保留；
  // 从未产出的任务（未开始即失败等）不参与判定，避免把正常状态显示为异常。
  // 成片「产出证据」探测目标（纯内存解析，无磁盘 IO）：供同步判定与异步预热共用，
  // 保证两处探测的路径完全一致（否则预热读的不是判定要读的，等于白读）。
  // 返回 null 表示该任务无需探测（非终态 / 无任何产出证据）。
  _taskOutputProbes(t) {
    if (!t) return null;
    const st = String(t.status || '');
    if (st !== 'done' && st !== 'stopped' && st !== 'error' && st !== 'interrupted') return null;
    // 产出证据：标记清单 / 日志中的「成片完成」/ 批量任务的真实输出目录记录
    const marker = this._loadMarker(t);
    const marked = (marker && Array.isArray(marker.videos)) ? marker.videos.filter(Boolean) : [];
    const logged = [];
    for (const ln of (t.log || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(ln);
      if (m) logged.push(String(m[1]).trim());
    }
    const outDirAuth = this._taskOutDirFromLog(t);
    const hadOutput = marked.length > 0 || logged.length > 0 || (t.type === 'batch' && !!outDirAuth);
    if (!hadOutput) return null;
    return { files: marked.concat(logged).filter(Boolean), dir: outDirAuth || t.outDir || '' };
  }
  _taskHasOutput(t) {
    if (!t) return true;
    // 纯内存判定（零 IO）：结论来自 verify_cache（启动只读库）+ 空闲队列的后台校验。
    // 无结论 / 已过期 → 乐观返回 true，该任务已在队列里（见 _prewarmHasOutputAsync），
    // 校验完成后写回库并增量刷新界面（自愈）。**任何情况下都不做同步磁盘探测** ——
    // 同步 stat/readdir 是历次冷启动冻结的源头（实测 5.7s ~ 49.5s），已彻底移除。
    const memo = this._hasOutputMemo && this._hasOutputMemo.get(t.id);
    const ttl = (memo && memo.ttl) || HAS_OUTPUT_PERSIST_TTL_MS;
    if (memo && (Date.now() - memo.at) < ttl) return memo.v;
    const probes = this._taskOutputProbes(t);
    if (!probes) return true;
    return true;
  }

  snapshotTasks() {
    const list = [];
    this.tasks.forEach((t) => {
      // 首次进入运行态时打点（惰性：覆盖直接启动/队列轮到/恢复启动所有路径）
      if (t.status === 'running' && !t.startedAt) t.startedAt = Date.now();
      list.push({
        id: t.id, type: t.type, title: t.title, pid: t.pid,
        status: t.status, lockState: t.lockState, paused: !!t.paused,
        progress: t.progress || { current: 0, total: 0 }, failReason: t.failReason || '',
        createdAt: t.createdAt, startedAt: t.startedAt || null, endedAt: t.endedAt, outDir: t.outDir || '',
        groupDate: typeof t.groupDate === 'string' ? t.groupDate : '', // 业务归属日（前端排序用，不展示）
        softPaused: t._softPaused === true,   // 软暂停待续任务（继续时按类型补缺片/接续）
        // 任务总用时（秒）：首次开始至今的墙钟时间；已结束任务取结束时间
        elapsedSec: taskElapsed(t),
        // 计划序号：排队任务=队列第几位；暂停任务=冻结的显示顺位；显示与恢复插队都以此为准
        pos: t.planPos || 0,
        resumeIdx: typeof t.resumeIdx === 'number' ? t.resumeIdx : null,
        queueTotal: this._taskQueue.length,
        // 成片是否仍在磁盘（仅曾产出过的已结束任务会为 false）：前端据此提示，不影响任务行本身
        hasOutput: this._taskHasOutput(t),
        log: t.log.slice(-500),
      });
    });
    // 展示排序：运行中 → 待运行区 → 已结束（按创建时间）。
    // 待运行区显示顺序：按「恢复所有暂停任务后的最终队列顺序」呈现——
    // 排队任务保持执行队列次序，暂停任务按冻结顺位（resumeIdx）插入到对应位置，
    // 与「暂停时几号、继续后几号」的显示顺位完全一致。
    const ordered = [];
    this._taskQueue.forEach((qid) => { if (this.tasks.get(qid)) ordered.push(qid); });
    list.filter((t) => t.status === 'paused')
      .sort((x, y) => (x.resumeIdx ?? 1e9) - (y.resumeIdx ?? 1e9))
      .forEach((p) => { ordered.splice(Math.min(p.resumeIdx ?? ordered.length, ordered.length), 0, p.id); });
    const orderIdx = new Map();
    ordered.forEach((id, k) => orderIdx.set(id, k));
    list.sort((a, b) => {
      const rank = (s) => (s === 'running' ? 0 : s === 'queued' || s === 'paused' ? 1 : 2);
      const ra = rank(a.status), rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const ia = orderIdx.has(a.id) ? orderIdx.get(a.id) : 1e9;
        const ib = orderIdx.has(b.id) ? orderIdx.get(b.id) : 1e9;
        if (ia !== ib) return ia - ib;
        return a.createdAt - b.createdAt;
      }
      return a.createdAt - b.createdAt;
    });
    // 待运行区显示序号：仅排队任务连续编号（暂停任务显示圆点、不占号，不影响队伍正常序号展示）
    let waitN = 0;
    for (const it of list) {
      if (it.status === 'queued') { waitN++; it.displayPos = waitN; }
    }
    return list;
  }

  _emitTasks() {
  if (this.onTasksChanged) this.onTasksChanged(this.snapshotTasks());
  this._schedulePersist();
  }

  // ── 任务列表持久化（tasks + task_logs 分表 + cache_kv.plan_seq）──
  // 状态变化节流落盘，回收/正常退出时保证落盘；重启后保留任务直到手动清空。
  // 日志按行独立存储：状态变更只重写任务主体，日志仅在追加时写新增行（日志是任务数据里体积最大的部分）。
  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.persistTasks(); }, 200);
  }
  persistTasks() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (!this._useDbCache()) return; // 纯内存态：任务列表本次会话不落盘
    const store = this._cacheStore;
    try {
      store.transaction(() => {
        // 列表中已不存在的任务：连同其日志行一并删除
        const keep = new Set(this.tasks.keys());
        for (const id of store.listTaskIds()) { if (!keep.has(id)) store.removeTask(id); }
        for (const t of this.tasks.values()) {
          const body = {
            id: t.id, type: t.type, title: t.title, env: t.env || {},
            status: t.status, lockState: t.lockState, progress: t.progress || { current: 0, total: 0 },
            failReason: t.failReason || '', paused: !!t.paused,
            createdAt: t.createdAt, startedAt: t.startedAt || null, endedAt: t.endedAt, planPos: t.planPos || 0,
            resumeIdx: typeof t.resumeIdx === 'number' ? t.resumeIdx : null,
            outDir: t.outDir || '', _stopRequested: !!t._stopRequested,
            groupDate: typeof t.groupDate === 'string' ? t.groupDate : '',
            failedVideos: Array.isArray(t.failedVideos) ? t.failedVideos.slice(-100) : [],
            // 失败成片【序号】：续跑按序号补做的唯一依据，**必须随任务落盘** ——
            // 否则实例重启后续跑会退化成「按成片名解析」，而 failedVideos 里的「第N个」是占位名，必然解析失败。
            failedIndices: Array.isArray(t.failedIndices)
              ? t.failedIndices.filter((n) => Number.isInteger(n) && n > 0).slice(-500) : [],
          };
          store.upsertTask({
            id: t.id, seq: parseInt(String(t.id).replace(/\D/g, ''), 10) || 0,
            type: t.type || '', status: t.status || '', title: t.title || '',
            createdAt: t.createdAt || 0, updatedAt: t.endedAt || t.startedAt || t.createdAt || Date.now(),
            payload: JSON.stringify(body),
          });
          // 日志：保留末尾 500 行。新增且未溢出窗口时只追加新行；否则整体重写。
          const all = t.log || [];
          const saved = typeof t._savedLogLen === 'number' ? t._savedLogLen : 0;
          if (all.length !== saved) {
            if (all.length > saved && all.length <= 500) store.appendTaskLog(t.id, saved, all.slice(saved));
            else store.setTaskLog(t.id, all.slice(-500));
            t._savedLogLen = all.length;
          }
        }
        store.setKv('plan_seq', String(this._planSeq));
      });
    } catch (e) {
      // 不静默吞错：任务列表写坏会导致整批任务记录丢失，必须能从日志定位
      console.error('[tasks] 任务列表落盘失败（本次变更已丢弃，下次状态变化会重试）：' + ((e && e.message) || e));
    }
  }
  // 启动时恢复上次会话的任务列表（退出前已做 running→interrupted、queued→paused 转换）
  restoreTasks() {
    // 待异步校验输出目录的批量任务（见 _verifyBatchOutDirs）：声明在 try 外，
    // 保证同步段即使异常，已收集的目录校验仍会继续（校验本身失败也被吞掉，不影响任务恢复）
    const pendingOut = [];
    try {
      if (!this._useDbCache()) return;
      const store = this._cacheStore;
      const _t0 = Date.now();
      const rows = store.listTasks();
      const _t1 = Date.now();
      for (const row of rows) {
        let t = null;
        try { t = JSON.parse(row.payload); } catch (e) { continue; }
        if (!t || typeof t.id !== 'string') continue;
        if (this.tasks.has(t.id)) continue;
        if (t.status !== 'paused' && t.status !== 'done' && t.status !== 'stopped' && t.status !== 'error' && t.status !== 'interrupted'
          && t.status !== 'queued' && t.status !== 'running') continue;
        t.log = store.getTaskLog(t.id);
        const restored = Object.assign({}, t, { env: t.env || {}, pid: null, progress: t.progress || { current: 0, total: 0 }, log: Array.isArray(t.log) ? t.log : [], failedVideos: Array.isArray(t.failedVideos) ? t.failedVideos : [],
          failedIndices: Array.isArray(t.failedIndices) ? t.failedIndices.filter((n) => Number.isInteger(n) && n > 0) : [] });
        // 强杀/异常退出恢复兜底：非终态任务转为可继续状态，避免任务从列表凭空消失
        // （正常退出走 shutdownTasks 已完成转换，此处仅兜底）
        if (restored.status === 'queued') {
          restored.status = 'paused'; restored.paused = true;
          if (restored.log[restored.log.length - 1] !== '[上次异常退出，排队任务已转为暂停]') { restored.log.push('[上次异常退出，排队任务已转为暂停]'); }
        } else if (restored.status === 'running') {
          restored.status = 'interrupted'; restored.paused = false;
          restored.endedAt = restored.endedAt || Date.now();
          if (restored.log[restored.log.length - 1] !== '[上次异常退出，任务已中断，可继续制作]') { restored.log.push('[上次异常退出，任务已中断，可继续制作]'); }
        }
        // 批量任务缺归属日时按提交/创建时刻补算（凌晨0-4点归前一天）
        if (restored.type === 'batch' && typeof restored.groupDate !== 'string') restored.groupDate = this._taskGroupDate(restored.type, restored.env, restored.createdAt);
        // 批量任务的成片文件夹：记录指向有效目录（含人工迁移/手工修正后）则保留；
        // 失效时仅按本任务提交时刻+配置名确定性推算规范路径，绝不跨日搜索猜替代品（见 _verifyBatchOutDirs）。
        // ⚠ 校验必须**异步**：此处位于启动关键路径，同步 existsSync 会逐任务冷访问磁盘
        //   （实测 49 个历史任务的输出目录在机械盘上 → 冷启动冻结主进程约 9 秒）。故只登记待校验项。
        if (restored.type === 'batch') pendingOut.push(restored);
        restored._savedLogLen = restored.log.length; // 已与库一致，避免下次持久化重复重写
        this.tasks.set(restored.id, restored);
        // 历史脏 ID 的数字部分曾被推到天文数字（科学计数法形态）：超出安全整数一律不采纳，
        // 否则 taskSeq 永远停在 e 记法大数上，新 ID 的数字部分 ++ 无效且只能靠时间戳后缀保唯一
        const n = parseInt(String(t.id).replace(/\D/g, ''), 10);
        if (Number.isSafeInteger(n) && n > this.taskSeq) this.taskSeq = n;
      }
      const _t2 = Date.now();
      const planSeq = parseInt(store.getKv('plan_seq') || '0', 10) || 0;
      if (planSeq > this._planSeq) this._planSeq = planSeq;
      // 任务快照 emit：_taskHasOutput 为纯内存判定（零 IO，见该方法注释），可安全立即 emit
      if (this.tasks.size) this._emitTasks();
      this._gcOrphanMarkers(); // 任务恢复完成后回收孤儿标记（任务不存在的残留）
      const _t3 = Date.now();
      // 分段留痕：冷启动卡顿定位依据（读库 / 主循环 / GC 三段，另记待异步校验的输出目录数）
      this._lg('SYS', 'task.restore',
        '任务恢复完成（同步段 ' + (_t3 - _t0) + 'ms · 读库 ' + (_t1 - _t0) + ' / 主循环 ' + (_t2 - _t1) + ' / GC ' + (_t3 - _t2) + ' · 任务 ' + rows.length + ' 条 · 待异步校验输出目录 ' + pendingOut.length + ' 条）',
        { dbMs: _t1 - _t0, loopMs: _t2 - _t1, gcMs: _t3 - _t2, tasks: rows.length, pendingOut: pendingOut.length });
    } catch (e) {}
    // 输出目录校验：**一律入队**（异步、串行、节流）—— 不在启动窗口内打素材盘 IO，
    // 由空闲队列的启动保护期与让路机制决定何时真正执行（比"启动期判断"更准确）。
    if (pendingOut.length) {
      this._verifyEnqueue('outdirverify', this.root, () => this._verifyBatchOutDirs(pendingOut));
    }
    // 启动只读库：把已持久化的成片存在性结论载入内存（一次查询、零文件 IO），
    // 其余待校验项**只入队**（空闲队列串行执行，见 _prewarmHasOutputAsync / _idleKick）
    try { this._loadHasOutputFromStore(); } catch (e) {}
    try { this._prewarmHasOutputAsync(); } catch (e) {}
    // 维护性任务统一入队（启动期不做任何同步扫盘）：过期锁清理等
    try { this._verifyEnqueue('cleanlocks', this.root, () => this._cleanupStaleLocks()); } catch (e) {}
    // 日志级别持久化恢复（否则级别只在本会话生效，重启回 info）：
    // 入空闲队列而不是启动路径 —— 读它需要同步打开 settings.db，那正是启动期硬约束禁止的。
    try { this._idleEnqueue('loglevel:' + this.root, () => this._restoreLogLevel()); } catch (e) {}
  }
  // 启动后异步预热「成片是否仍在磁盘」判定所需的目录/文件元数据（restoreTasks 的延后部分）。
  // 为什么需要：_taskHasOutput 是**同步**判定（被 snapshotTasks 逐任务调用），而历史任务的成片
  // 目录多在机械盘 —— 冷启动首次访问每个目录约几十毫秒，几十个任务就是数秒。
  // 本方法用 fs.promises 并发把**同一批路径**（_taskOutputProbes 与判定同源）的元数据读进系统缓存，
  // 之后同步判定即落在缓存上（同一批任务实测 13ms）。判定逻辑与语义**完全不变**，
  // 只是把「冷读」从启动关键路径挪到异步阶段。完成后复位抑制标志并再 emit 一次，
  // 让界面从乐观值切到真实值（缺失成片的提示因此最多晚 1~2 秒出现）。
  // ── 统一空闲校验队列─────────────────────────
  // 用户原话：「不区分冷热写判定，利用后台检测/自愈机制保证效率和精准性」。
  // 这比"判冷热"更稳：判据本身很脆（开机时长被证伪；探针样本也依赖"启动早期没碰过该目录"），
  // 而且判错是双向代价 —— 判成热会踩几十秒冻卡，判成冷会无谓推迟精度。
  // 改为**用反馈代替预判**：
  //   · 启动期一律不发起批量文件 IO（不分冷热），只把待校验项**入队**；
  //   · 队列**串行单发**（一次只飞一个 IO）+ **按实测耗时自适应节流**：
  //     单次校验慢 → 间隔翻倍（保护系统），连续快 → 间隔减半（尽快收敛）；
  //   · **任务运行/排队时自动暂停**，空闲再续（绝不与出片抢 IO）；
  //   · 校验结果写回 verify_cache 并**增量刷新界面**（自愈：发现成片没了/回来了就更新标记）。
  _idleEnqueue(key, run) {
    if (!key || typeof run !== 'function') return false;
    if (!this._idleJobs) this._idleJobs = [];
    if (this._idleJobs.some((j) => j.key === key)) return false;   // 去重：同一项不重复排队
    this._idleJobs.push({ key, run });
    this._idleKick();
    return true;
  }

  // ── 统一空闲校验 worker（冷启动相关的 IO 一律走这里）──
  // 所有后台校验（索引重扫 / 复刻清单 / GC / 成片存在性 / 输出目录 / 锁清理）统一从本入口入队，
  // 换来三件事：① **埋点统一** —— 每次校验一条 `verify.<kind>`（耗时 / 让路次数 / 成败），
  // 排查不必再逐个猜是哪一项在跑；② **让路统一** —— job 内可用 `ctx.shouldYield()` 查询
  // "前台刚有活动或有任务在跑"，据此自行分片让出；③ **命名统一** —— `<kind>:<scope>` 便于去重与观测。
  // ⚠ 本入口只提供外壳，**不改各校验自身的业务逻辑**（避免一次性大改引入回归）。
  _verifyEnqueue(kind, scope, run) {
    const k = String(kind || 'verify');
    const key = k + ':' + String(scope == null ? '' : scope);
    return this._idleEnqueue(key, async () => {
      const t0 = Date.now();
      let yields = 0;
      const ctx = {
        kind: k,
        shouldYield: () => this._shouldYieldToForeground(),
        noteYield: () => { yields++; },
      };
      let ok = true;
      let err = '';
      try { await run(ctx); } catch (e) { ok = false; err = String((e && e.message) || e); }
      try {
        this._lg('SYS', 'verify.' + k,
          '后台校验 · ' + k + ' · ' + (Date.now() - t0) + 'ms'
          + (yields ? ' · 让路 ' + yields + ' 次' : '') + (ok ? '' : ' · 失败'),
          { kind: k, ms: Date.now() - t0, yields, ok, error: err || undefined });
      } catch (e) {}
    });
  }

  /** 前台是否应当被让路：有任务在跑/排队，或最近刚有前台活动（读/点/任务操作）。
   *  注意它是"查询"而非"中断" —— 由各 job 自己在安全点调用并分片让出。 */
  _shouldYieldToForeground() {
    try {
      if (this.hasRunningTask && this.hasRunningTask()) return true;
      if (this.hasQueuedTask && this.hasQueuedTask()) return true;
      const fg = this._lastForegroundAt || 0;
      return !!(fg && (Date.now() - fg) < IDLE_FOREGROUND_HOLD_MS);
    } catch (e) { return false; }
  }

  _idleKick() {
    if (this._idleRunning || !this._idleJobs || !this._idleJobs.length) return;
    // 启动保护期：到点前不消费（首屏渲染期间绝不与前台争 IO）
    const waitBoot = Math.max(0, (this._idleStartAt || 0) - Date.now());
    if (waitBoot > 0) { setTimeout(() => this._idleKick(), Math.min(waitBoot, 5000)); return; }
    this._idleRunning = true;
    const step = async () => {
      if (!this._idleJobs.length) { this._idleRunning = false; return; }
      // 与出片抢 IO 是绝对不能接受的：有任务在跑/排队 → 让路，稍后再续
      let busy = false;
      try { busy = !!(this.hasRunningTask() || this.hasQueuedTask()); } catch (e) { busy = false; }
      // 前台刚有活动（渲染/读取）也让路 —— 照预检测的「行内优先、后台让路」
      const fgRecent = this._lastForegroundAt && (Date.now() - this._lastForegroundAt) < IDLE_FOREGROUND_HOLD_MS;
      if (busy || fgRecent) { this._idleRunning = false; setTimeout(() => this._idleKick(), 5000); return; }
      const job = this._idleJobs.shift();
      const t0 = Date.now();
      try { await job.run(); } catch (e) {}
      const dt = Date.now() - t0;
      this._idleStats.done++;
      this._idleStats.maxMs = Math.max(this._idleStats.maxMs, dt);
      // ★ 自适应节流：这就是"后台检测"的核心 —— 用实测耗时决定节奏，不需要事先知道盘冷不冷
      if (dt > 150) { this._idleDelayMs = Math.min(2000, this._idleDelayMs * 2); this._idleStats.slow++; }
      else if (dt < 20) { this._idleDelayMs = Math.max(10, Math.round(this._idleDelayMs / 2)); this._idleStats.fast++; }
      setTimeout(step, this._idleDelayMs);
    };
    setTimeout(step, this._idleDelayMs);
  }

  // 队列状态（埋点/排查用）
  idleQueueState() {
    return {
      pending: (this._idleJobs || []).length, running: !!this._idleRunning,
      delayMs: this._idleDelayMs, done: this._idleStats.done,
      slow: this._idleStats.slow, fast: this._idleStats.fast, maxMs: this._idleStats.maxMs,
    };
  }

  // 把队列跑空（回归/手动排查用；正常使用不需要）
  // 注意要同时等 `_idleRunning` 结束：job 是**出队后才执行**的，只看队列长度会提前返回。
  async drainIdleQueue(timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 30000);
    while (((this._idleJobs && this._idleJobs.length) || this._idleRunning) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.idleQueueState();
  }

  // ── 成片存在性：结论持久化 + 懒校验────────────────
  // 既然已经 sqlite 化，就用一次查询换掉「每次启动核验 262 项目录」：
  //   启动：只读 verify_cache（零文件 IO）→ 有新鲜结论就直接用；
  //   校验：只对「无结论 / 过期」的任务做，结果写回库；
  //   失效：产物变动时按 key 精确失效，而不是定期全量重算。
  _hasOutputKey(id) { return 'hasoutput:' + String(id || ''); }

  _loadHasOutputFromStore() {
    const store = this._useDbCache() ? this._cacheStore : null;
    if (!store || typeof store.verifyGetMany !== 'function') return 0;
    let map;
    try { map = store.verifyGetMany('hasoutput:'); } catch (e) { return 0; }
    let n = 0;
    for (const [k, v] of map) {
      const id = k.slice('hasoutput:'.length);
      if (!id) continue;
      this._hasOutputMemo.set(id, { v: v.result === '1', at: v.verifiedAt, ttl: v.ttlMs || HAS_OUTPUT_PERSIST_TTL_MS });
      n++;
    }
    return n;
  }

  _putHasOutput(t, ok) {
    if (!t || !t.id) return;
    const at = Date.now();
    this._hasOutputMemo.set(t.id, { v: !!ok, at, ttl: HAS_OUTPUT_PERSIST_TTL_MS });
    const store = this._useDbCache() ? this._cacheStore : null;
    if (store && typeof store.verifyPut === 'function') {
      try { store.verifyPut(this._hasOutputKey(t.id), '', ok ? '1' : '0', HAS_OUTPUT_PERSIST_TTL_MS, at); } catch (e) {}
    }
  }

  // 产物变动 → 精确失效该任务的结论（下次启动或下次空闲校验时才重新探测）
  _invalidateHasOutput(id) {
    if (!id) return;
    if (this._hasOutputMemo) this._hasOutputMemo.delete(id);
    const store = this._useDbCache() ? this._cacheStore : null;
    if (store && typeof store.verifyInvalidate === 'function') {
      try { store.verifyInvalidate(this._hasOutputKey(id)); } catch (e) {}
    }
  }

  _prewarmHasOutputAsync() {
    // 启动期**只入队**，不发起任何批量文件 IO（不分冷热）——建议的
    // 「后台检测 + 自愈」：启动只读 SQLite；校验交给空闲队列（串行 + 自适应节流 + 有任务时让路）。
    const now = Date.now();
    let queued = 0;
    this.tasks.forEach((t) => {
      // 库里已有新鲜结论 → 连队都不排（这是「启动只读 SQLite」的核心收益）
      const memo = this._hasOutputMemo && this._hasOutputMemo.get(t.id);
      const ttl = (memo && memo.ttl) || HAS_OUTPUT_PERSIST_TTL_MS;
      if (memo && (now - memo.at) < ttl) return;
      const p = this._taskOutputProbes(t);
      if (!p) return;
      if (this._verifyEnqueue('hasoutput', t.id, () => this._probeTaskOutput(t, p))) queued++;
    });
    try {
      if (this._lg) this._lg('SYS', 'task.restore.hasoutput',
        '成片存在性核验已排入空闲队列（' + queued + ' 条 · 串行 + 自适应节流 · 有任务运行时自动让路）',
        { queued, pending: (this._idleJobs || []).length });
    } catch (e) {}
  }

  // 单个任务的成片存在性校验（在空闲队列里执行）：**先目录后文件、命中即停**，
  // 结果写回 verify_cache；结论变化时**增量刷新界面**（自愈 —— 不必重启就能看到标记被纠正）。
  async _probeTaskOutput(t, p) {
    const fsp = fs.promises;
    let ok = false;
    const dir = p.dir;
    if (dir) {
      try {
        const st = await fsp.stat(dir);
        if (st.isDirectory()) {
          const names = await fsp.readdir(dir);
          if (names.some((f) => path.extname(f).toLowerCase() === '.mp4')) ok = true;
        }
      } catch (e) { /* 目录不可用：继续看文件清单 */ }
    }
    if (!ok) {
      const FILES_CHUNK = 4;   // 小批并发即可；队列本身已是串行单发 + 间隔，不会再打满磁盘
      for (let i = 0; i < p.files.length && !ok; i += FILES_CHUNK) {
        const slice = p.files.slice(i, i + FILES_CHUNK);
        const hits = await Promise.all(slice.map((f) => fsp.access(f).then(() => true, () => false)));
        if (hits.some(Boolean)) ok = true;
      }
    }
    const prev = this._hasOutputMemo && this._hasOutputMemo.get(t.id);
    this._putHasOutput(t, ok);
    if (!prev || prev.v !== ok) { try { this._emitTasks(); } catch (e) {} }
    return ok;
  }
  // 批量任务输出目录的异步校验（restoreTasks 的延后部分）。
  // 语义：记录指向有效目录则保留；失效时仅按「提交时刻 + 配置名」
  // 确定性推算规范输出路径（脚本本就会创建的目录），绝不跨日/跨盘搜索猜替代品。
  // 与同步版的唯一差异：修正发生在任务恢复之后（首次 emitTasks 用的是记录值），
  // 有修正时会再发一次 emitTasks 让界面刷新 —— 换来的是启动关键路径不再被磁盘 IO 冻住。
  _verifyBatchOutDirs(tasks) {
    const fsp = fs.promises;
    const _t = Date.now();
    let changed = 0;
    return Promise.all(tasks.map((t) => {
      const od = t.outDir;
      const check = od ? fsp.access(od).then(() => true, () => false) : Promise.resolve(false);
      return check.then((live) => {
        if (live) return;
        const detail = t.status === 'done' ? this._batchTaskOutDetail(t, false) : null;
        if (detail && detail.outDir && detail.outDir !== od) { t.outDir = detail.outDir; changed++; }
      }).catch(() => {});
    })).then(() => {
      this._lg('SYS', 'task.restore.outdir',
        '任务输出目录异步校验完成（' + (Date.now() - _t) + 'ms · 校验 ' + tasks.length + ' 条 · 修正 ' + changed + ' 条）',
        { checked: tasks.length, changed: changed });
      if (changed) this._emitTasks();
    }).catch(() => {});
  }
  // 退出前收尾：运行中→已中断，排队→暂停（后由 persistTasks 落盘）
  shutdownTasks() {
    const now = Date.now();
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        t.status = 'interrupted'; t.paused = false; t.endedAt = now;
        t.log.push('[应用退出，任务已中断]'); changed = true;
      } else if (t.status === 'queued') {
        t.status = 'paused'; t.paused = true; t.pausedAt = Date.now();
        t.log.push('[应用退出，排队任务转为暂停]'); changed = true;
      }
    }
    this._taskQueue = [];
    this._runningTaskId = null;
    if (changed) this._emitTasks();
    this.persistTasks();
    return { ok: true };
  }
  hasRunningTask() {
    for (const t of this.tasks.values()) if (t.status === 'running') return true;
    return false;
  }
  hasQueuedTask() {
    for (const t of this.tasks.values()) if (t.status === 'queued') return true;
    return false;
  }
  // 已结束任务单行删除（运行/排队/暂停中的任务不可删；连带删除任务标记文件）
  clearTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') return { ok: false, error: '进行中的任务不能删除' };
    this.tasks.delete(id);
    this._removeMarker(t);
    this._emitTasks();
    return { ok: true };
  }
  // 全部继续：所有暂停任务按冻结顺位依次排入执行队列，无运行任务则立即启动
  resumeAllTasks() {
    const paused = [...this.tasks.values()].filter((t) => t.status === 'paused')
      .sort((a, b) => (a.resumeIdx ?? 1e9) - (b.resumeIdx ?? 1e9));
    if (!paused.length) return { ok: false, error: '没有暂停的任务' };
    for (const t of paused) {
      // 继续只是重新入队，此刻还没跑起来：保留计时冻结，由真正开始运行（_startNextQueued）时并入总暂停时长
      t.status = 'queued'; t.paused = false; delete t.resumeIdx;
      this._taskQueue.push(t.id);
      t.log.push('[全部继续]');
    }
    this._taskQueue.forEach((qid, k) => { this.tasks.get(qid).planPos = k + 1; });
    if (!this._runningTaskId) this._startNextQueued();
    else this._emitTasks();
    return { ok: true, count: paused.length };
  }
  // 全部暂停：所有排队任务移出执行队列并冻结顺位
  pauseAllTasks() {
    const queued = [...this.tasks.values()].filter((t) => t.status === 'queued')
      .sort((a, b) => (a.planPos || 1e9) - (b.planPos || 1e9));
    if (!queued.length) return { ok: false, error: '没有排队中的任务' };
    for (const t of queued) {
      const i = this._taskQueue.indexOf(t.id);
      if (i >= 0) this._taskQueue.splice(i, 1);
      t.status = 'paused'; t.paused = true; t.pausedAt = Date.now();
      const waiting = [...this.tasks.values()].filter((x) => x.status === 'queued' || x.status === 'paused')
        .sort((a, b) => (a.planPos || 1e9) - (b.planPos || 1e9));
      t.resumeIdx = Math.max(0, waiting.indexOf(t));
      t.log.push('[全部暂停]');
    }
    this._emitTasks();
    return { ok: true, count: queued.length };
  }

  // 停止任务：排队/暂停中的任务直接取消（移出执行队列）；运行中的任务终止进程树
  stopTask(id) {
    const { spawnSync } = require('child_process');
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'queued' || t.status === 'paused') {
      const i = this._taskQueue.indexOf(id);
      if (i >= 0) this._taskQueue.splice(i, 1);
      t.status = 'stopped';
      t.paused = false;
      t.planPos = 0;
      t.endedAt = Date.now();
      t.log.push('[已取消任务，不再执行]');
      this._emitTasks();
      return { ok: true };
    }
    if (t.status !== 'running') return { ok: false, error: '任务已结束' };
    if (!t.pid) return { ok: false, error: '任务进程尚未就绪' };
    t._stopRequested = true;
    t.log.push('[已请求停止任务，正在终止进程…]');
    this._emitTasks();
    try {
      const r = spawnSync('taskkill', ['/PID', String(t.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || '').trim() || '停止失败' };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 重开失败/中断/停止的任务：完整复用原任务环境变量（含提交时刻，成片命名/日志/输出目录
  // 与首次开始完全一致）重新制作；重开前删除该任务上次遗留的成片与日志产物。
  rerunTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    // 工具任务必须走 rerunToolTask（重新执行、不删文件）：
    // 本方法会「删除上次失败残留的产物」，而工具任务的产物正是被覆盖的源视频，
    // 且它没有任务标记可依（会回退到「日志解析 + 目录推算」，推算出的产物很可能就是源目录里的视频）
    if (t.type === 'tool') return this.rerunToolTask(id);
    if (t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') return { ok: false, error: '仅失败/中断/停止的任务可重新开始' };
    // 优先使用任务标记：其中保存了完整 env 与逐个成片的产出清单（精确还原、不依赖日志窗口）
    const marker = this._loadMarker(t);
    const env = Object.assign({}, (marker && marker.env) || t.env || {});
    // 遮罩任务 env 为 MASK_* 系列；批量/复刻为 REPLICA_TXT + 其它变量
    const isMask = t.type === 'mask';
    const src = isMask
      ? (env.MASK_RAW_DIRS ? String(env.MASK_RAW_DIRS).split(';')[0] : '')
      : (env.REPLICA_TXT ? String(env.REPLICA_TXT) : '');
    if (!src) {
      this._removeMarker(t);
      return { ok: false, error: isMask ? '原任务缺少遮罩配置，无法重新开始' : '原任务缺少 TXT 配置，无法重新开始' };
    }
    // 删除上次失败残留的成片与日志：有标记按标记精确清单，无标记回退日志解析+目录推算
    this._lg('DEL', 'task.rerun',
      '重新开始 · 将删除上次产物并从第 1 片重做 · ' + t.type + ' · ' + String(t.title || '').slice(0, 50),
      { id: t.id, hasMarker: !!marker,
        markerVideos: (marker && Array.isArray(marker.videos) ? marker.videos.slice(0, 30) : []),
        env: this._envBrief(env) });
    if (marker) this._removeMarkerArtifacts(marker);
    else this._removeTaskArtifacts(t);
    this._removeMarker(t);
    this.tasks.delete(id);
    const task = this._createTask(t.type, t.title || this._taskTitle(src), env, src);
    // 保留预填的进度结构（如批量任务的预计成片数/分组数），其余进度归零
    task.progress = { current: 0, total: 0 };
    if (t.progress && t.progress.groupCount > 0) task.progress.groupCount = t.progress.groupCount;
    if (t.progress && t.progress.total > 0) task.progress.total = t.progress.total;
    this._enqueueTask(task);
    return { ok: true, taskId: task.id };
  }

  // ── 任务标记（task_marks 表）：含完整 env 与逐成片产出清单，不在用户成片文件夹留下文件。
  // 任务正常完成时保留（供「清除成片/日志」精确删除）；失败/中断/停止时同样保留，作为未完成的标志且供重开精确还原。
  _loadMarker(task) {
    if (!task || !this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getMark(task.id);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && typeof d === 'object' ? d : null;
    } catch (e2) { return null; }
  }
  _saveMarker(task, data) {
    if (!task || !this._useDbCache()) return;
    try { this._cacheStore.setMark(task.id, JSON.stringify(data), data && data.createdAt); } catch (e2) {}
  }
  // 删除任务标记（cache.db 的 task_marks 记录）。标记是「产物归属」的判定依据 ——
  // 一旦删除，任务身份/环境快照就再无别处留存，故默认留痕；批量场景传 silent 由调用方汇总。
  _removeMarker(task, opts) {
    if (!task || !this._useDbCache()) return;
    let removed = false;
    try { removed = this._cacheStore.removeMark(task.id) !== false; } catch (e2) {}
    if (removed && !(opts && opts.silent)) {
      this._lg('DEL', 'task.marker.remove',
        '删除任务标记 · ' + String(task.type || '') + ' · ' + String(task.title || '').slice(0, 40),
        { id: task.id, env: this._envBrief(task.env) });
    }
  }
  // 孤儿任务标记回收：标记对应的任务已不存在于列表（清除/历史遗留）时删除；
  // 仍存在的任务（含 done 历史，供「清除成片/日志」精确删除）标记保留。
  _gcOrphanMarkers() {
    if (!this._useDbCache()) return;
    try {
      const known = new Set(this.tasks.keys());
      let removed = 0;
      for (const id of this._cacheStore.listMarkIds()) {
        if (known.has(id)) continue;
        if (this._cacheStore.removeMark(id)) removed++;
      }
      if (removed) console.log('[cache] 已回收孤儿任务标记 ' + removed + ' 个');
    } catch (e) {}
  }
  // 任务真正开始执行时初始化标记（含 env 快照，重开可完整还原环境）
  _touchMarker(task) {
    this._saveMarker(task, {
      taskId: task.id, type: task.type, title: task.title || '',
      env: Object.assign({}, task.env || {}), createdAt: task.createdAt || Date.now(),
      videos: [], batchOutDir: '',
    });
  }
  // 追加产物记录：成片完成路径 / batch 专属输出目录（标记不存在时先创建）
  _appendMarkerOut(task, key, value) {
    if (!value) return;
    let data = this._loadMarker(task);
    if (!data) { this._touchMarker(task); data = this._loadMarker(task); }
    if (!data) return;
    if (key === 'videos') {
      if (!Array.isArray(data.videos)) data.videos = [];
      if (data.videos.indexOf(value) < 0) data.videos.push(value);
    } else if (key === 'batchOutDir') {
      data.batchOutDir = value;
    }
    this._saveMarker(task, data);
  }

  // ── 成片目录收尾（共用，唯一入口）────────────────────────────
  // 为什么必须存在这两个函数：批量引擎在任务开始时把**源配置移入**成片文件夹当正本
  // （batch/index.js:922-925 `renameSync(txtFilePath, txtDest)`），于是任务一旦没能正常收尾
  // （用户紧急停止 / 进程被杀 / 编码失败），磁盘上就同时留下三样东西：
  //   · 配置正本 —— 孤零零躺在成片目录里，源位置已空。用户在界面上看到配置"像是还在"，
  //     但它已被搬走：**改不了名**（同目录有空日志 → hasLog 拦）、一旦清除就可能被整目录带走。
  //   · 0 字节拼接日志 —— 日志是逐片追加的（batch/index.js:938 建空文件、1429 每完成一片追加），
  //     首片没做完时它就是空的：既无信息价值，又会把该配置的改名路径堵死。
  //   · `<随机>.tmp` 半截产物 —— 引擎先写临时名、成功才原子改名（tempNameFor），
  //     被杀时来不及删（batch/index.js:1345 只在 ffmpeg 自行返回非 0 时删）。
  // 引擎被 taskkill /T /F 硬杀（stopTask），**没有机会自理**，所以收尾只能由主进程做。
  //
  // 回迁目标 = 成片目录的**父目录**：引擎的移入规律保证源就是同一 outputRootDir
  // （batch/index.js:913-925，outDir = outputRootDir/<时间戳>-<配置名>-成片，正本来自该 outputRootDir），
  // 所以不必依赖 task.env —— **任务记录已被清除的孤儿目录同样能救回来**。
  // 父目录已有同名配置时一律跳过：绝不覆盖用户的原件（多任务共用同一配置名时会遇到）。
  _rescueConfigFromOutDir(outDir) {
    const out = { restored: [], skipped: [] };
    const abs = String(outDir || '').trim();
    if (!abs) return out;
    // 只处理成片目录：别处的 .txt 不是"被移入的正本"，动了就是误伤
    if (!/成片$/i.test(path.basename(abs))) return out;
    let names = [];
    try { if (!fs.statSync(abs).isDirectory()) return out; names = fs.readdirSync(abs); } catch (e) { return out; }
    const parent = path.dirname(path.resolve(abs));
    for (const f of names) {
      if (!/\.txt$/i.test(f)) continue;
      if (LOG_NAME_RE.test(f)) continue;      // 拼接日志/复刻日志：不是配置
      if (BACKUP_NAME_RE.test(f)) continue;   // 复刻侧的「配置备份-」是**副本**（源还在），不回迁
      const src = path.join(abs, f);
      try { if (!fs.statSync(src).isFile()) continue; } catch (e) { continue; }
      const dest = path.join(parent, f);
      if (fs.existsSync(dest)) { out.skipped.push(f); continue; }
      try { fs.renameSync(src, dest); out.restored.push(f); } catch (e) { /* 占用/权限：留原地，不阻断 */ }
    }
    return out;
  }

  // 清扫成片目录里**确定无价值**的残渣：0 字节拼接日志 + 引擎临时产物。
  // 保守边界（宁可留，不可误删）：
  //   · 日志只在**0 字节**时删 —— 有内容的日志是复刻配对与事后复盘的唯一凭据，一个字都不能动；
  //   · 临时产物只认严格形态 `^[0-9a-z]{6,}\.tmp$`（tempNameFor 生成：base36 时间戳 + 8 位随机），
  //     与续跑清理（见 _verifyAndCleanTaskOutputs）同一形态判定；其它 `.tmp` 一律不动；
  //   · 目录只在不剩任何文件时收回 —— 有残留就保留，交给用户判断。
  //   · **删除一律走回收站**：本项目红线是「业务文件不做永久删除」（永久删除仅限中间文件与锁文件，
  //     由 P0-基线/verify-runlog.js 的断言守着）。0 字节日志对用户仍可能是"那次任务"的唯一痕迹，
  //     静默抹掉不合适；进回收站可随时还原，代价只是一个 API 调用。
  //
  // 删文件统一走这里。**不要**用 fs.unlinkSync 删业务文件 —— 既违红线，也会让上述断言的
  // 「unlinkSync ≤ 8 处且实参须为中间文件」超限（本项目实测踩过）。
  async _trash(p) {
    try {
      const { shell } = require('electron');
      await shell.trashItem(p);
    } catch (e) {
      if (fs.existsSync(p)) throw e;   // 原路径已不存在视为成功（幂等，重复清理不报错）
    }
  }

  async _sweepOutDirResidue(outDir) {
    const out = { logs: [], temps: [], dirRemoved: false };
    const abs = String(outDir || '').trim();
    if (!abs) return out;
    let names = [];
    try { if (!fs.statSync(abs).isDirectory()) return out; names = fs.readdirSync(abs); } catch (e) { return out; }
    for (const f of names) {
      const fp = path.join(abs, f);
      let st = null; try { st = fs.statSync(fp); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (LOG_NAME_RE.test(f) && st.size === 0) {
        try { await this._trash(fp); out.logs.push(f); } catch (e) {}
        continue;
      }
      if (/^[0-9a-z]{6,}\.tmp$/i.test(f)) {
        try { await this._trash(fp); out.temps.push(f); } catch (e) {}
      }
    }
    // 目录已空（连日志/临时产物都没了）→ 收回空壳，不留「成片文件夹空壳」；
    // 父目录若也因此变空，逐级向上收（到项目根为界）——任一层非空即停
    try {
      if (fs.readdirSync(abs).length === 0) {
        fs.rmdirSync(abs);
        out.dirRemoved = true;
        let cur = path.dirname(abs);
        const stopAt = path.resolve(this.root || process.cwd());
        while (cur.length > stopAt.length && cur !== stopAt) {
          let entries = [];
          try { entries = fs.readdirSync(cur); } catch (e) { break; }
          if (entries.length) break;
          try { fs.rmdirSync(cur); } catch (e) { break; }
          cur = path.dirname(cur);
        }
      }
    } catch (e) {}
    return out;
  }

  // 任务终态收尾（stopped / error / interrupted）：回迁正本 + 清扫残渣，一次做完并留痕。
  // 只在**没能正常出片收尾**的终态调用：done 不动（正本留在成片目录是正常形态），
  // paused 不动（软暂停后用户会「继续任务」，此时搬走正本反而添乱）。
  // 顺序不可颠倒：**先回迁、再清扫** —— 反了会把还没搬走的正本连同空日志一起判断成"杂乱目录"。
  async _settleTaskLeftovers(task, status) {
    try {
      if (!task) return;
      if (status !== 'stopped' && status !== 'error' && status !== 'interrupted') return;
      const dir = String(task.outDir || (task.env && task.env.REPLICA_OUTPUT_DIR) || '').trim();
      if (!dir) return;
      const rescued = this._rescueConfigFromOutDir(dir);
      const swept = await this._sweepOutDirResidue(dir);
      if (rescued.restored.length || rescued.skipped.length || swept.logs.length || swept.temps.length || swept.dirRemoved) {
        this._lg('DEL', 'task.settle',
          '任务未正常结束的收尾 · ' + status + ' · ' + String(task.title || '').slice(0, 40)
          + ' · 配置正本回迁 ' + rescued.restored.length + ' 个'
          + (rescued.skipped.length ? '（' + rescued.skipped.length + ' 个因原位置已有同名而保留）' : '')
          + ' · 清空日志 ' + swept.logs.length + ' 个 · 清临时产物 ' + swept.temps.length + ' 个'
          + (swept.dirRemoved ? ' · 空目录已收回' : ''),
          { id: task.id, outDir: dir,
            restored: rescued.restored, skipped: rescued.skipped, logs: swept.logs, temps: swept.temps });
      }
    } catch (e) { /* 收尾失败绝不阻断任务结束流程 */ }
  }

  // 清除任务**记录之前**的"孤儿残渣"收尾：只对**没有任何正式成片**的成片目录动手。
  // 为什么必须有：任务记录一旦删除，其输出目录就再也无法被「清除任务产物」定位
  //   （那条路径按当前任务列表遍历）—— 目录里的半截 `.tmp` 与 0 字节日志变成永久垃圾，
  //   而其中的配置正本还被锁在里面（源位置已空：用户既改不了名，也用不上这份配置）。
  //   实测路径正是如此：用户紧急停止 → 先清任务记录 → 再点「清除产物」→ 目录已无人认领。
  // 保守边界：只要目录里有**一个 mp4 就完全不动** —— 那可能是用户还要用的产物。
  async _settleOrphanOutDir(task) {
    try {
      const dir = String((task && task.outDir) || '').trim();
      if (!dir || !/成片$/i.test(path.basename(dir))) return false;
      let names = [];
      try {
        if (!fs.statSync(dir).isDirectory()) return false;
        names = fs.readdirSync(dir);
      } catch (e) { return false; }
      if (names.some((f) => path.extname(f).toLowerCase() === '.mp4')) return false;
      const rescued = this._rescueConfigFromOutDir(dir);
      const swept = await this._sweepOutDirResidue(dir);
      if (rescued.restored.length || rescued.skipped.length || swept.logs.length || swept.temps.length || swept.dirRemoved) {
        this._lg('DEL', 'task.orphanClean',
          '清除任务记录前收走遗留残渣 · ' + String(task.title || '').slice(0, 40)
          + ' · 配置正本回迁 ' + rescued.restored.length + ' 个'
          + (rescued.skipped.length ? '（' + rescued.skipped.length + ' 个因原位置已有同名而保留）' : '')
          + ' · 空日志 ' + swept.logs.length + ' 个 · 临时产物 ' + swept.temps.length + ' 个'
          + (swept.dirRemoved ? ' · 空目录已收回' : ''),
          { id: task.id, outDir: dir, restored: rescued.restored, skipped: rescued.skipped, logs: swept.logs, temps: swept.temps });
        return true;
      }
    } catch (e) { /* 收尾失败不阻断清除流程 */ }
    return false;
  }

  // 按任务标记精确删除失败任务遗留产物：
  // 1) 标记中逐成片记录的输出文件（复刻/批量共用）；
  // 2) batch 专属输出目录内的成片 mp4 与拼接日志（与重制结果同名冲突）；
  //    源 TXT 正本若已被脚本移入输出目录且原位置不存在，先移回原处保证重开可读取。
  _removeMarkerArtifacts(marker) {
    // 先留痕再删：产物一旦删除，这里是唯一还能还原「删了什么、多大、原修改时间」的地方
    const targets = (marker.videos || []).slice();
    if (marker.type === 'batch' && marker.batchOutDir) {
      try {
        if (fs.existsSync(marker.batchOutDir)) {
          for (const f of fs.readdirSync(marker.batchOutDir)) {
            if (path.extname(f).toLowerCase() === '.mp4' || /拼接日志/.test(f)) targets.push(path.join(marker.batchOutDir, f));
          }
        }
      } catch (e2) {}
    }
    const info = this._describeForLog(targets);
    this._lg('DEL', 'task.artifacts.remove',
      '清除任务产物 · ' + String(marker.type || '') + ' · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes),
      Object.assign({ outDir: marker.batchOutDir || '' }, info));

    // 一律移入回收站（可还原），不做永久删除
    const rm = (p) => { try { if (p && fs.existsSync(p)) this._recycleFile(p); } catch (e2) {} };
    for (const v of (marker.videos || [])) rm(v);
    if (marker.type === 'batch' && marker.batchOutDir) {
      // 正本回迁收敛到共用函数：原实现依赖 marker.env.REPLICA_TXT（任务标记缺失的孤儿目录就救不回来），
      // 且只认 env 里那一个文件名；新实现按「成片目录里的 .txt 即被移入的正本」判定，父目录有同名则跳过。
      this._rescueConfigFromOutDir(marker.batchOutDir);
      try {
        if (fs.existsSync(marker.batchOutDir) && fs.statSync(marker.batchOutDir).isDirectory()) {
          for (const f of fs.readdirSync(marker.batchOutDir)) {
            const fp = path.join(marker.batchOutDir, f);
            if (fs.existsSync(fp) && fs.statSync(fp).isFile() && (path.extname(f).toLowerCase() === '.mp4' || LOG_NAME_RE.test(f))) rm(fp);
          }
        }
      } catch (e2) {}
    }
  }

  // 从任务日志行中解析该任务产出的成片路径（清除/续跑对账用，与标记互为补充）
  collectDoneFromLog(task) {
    const out = [];
    for (const line of ((task && task.log) || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(String(line));
      if (m) out.push(String(m[1]).trim());
    }
    return out;
  }

  // 从复刻日志文件中移除指定成片的日志块（按成片文件路径的 basename 精确匹配）
  // 复刻日志格式：各成片块以「成片文件名.mp4」单行开头，块间以「=×46」分隔，以 EOF 结尾
  _removeLogEntries(videoPaths) {
    if (!Array.isArray(videoPaths) || !videoPaths.length) return;
    // 按目录分组成片路径：日志文件与成片同目录（脚本把日志写在复刻输出目录）
    const byDir = new Map();
    for (const v of videoPaths) {
      let p = v;
      try { p = path.resolve(String(v)); } catch (e) { continue; }
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(path.basename(p));
    }
    for (const [dir, bases] of byDir) {
      try {
        const files = fs.readdirSync(dir);
        const logFile = files.find((f) => /^\d{4}-(原片复刻|去重复刻)日志\.txt$/.test(f));
        if (!logFile) continue;
        const logPath = path.join(dir, logFile);
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        // 收集所有块起点：以成片文件名（不含路径分隔符、.mp4 结尾）开始的行
        const starts = [];
        for (let i = 0; i < lines.length; i++) {
          const ln = (lines[i] || '').trimEnd();
          if (ln.endsWith('.mp4') && !ln.includes('\\') && !ln.includes('/')) starts.push(i);
        }
        // 确定要删除的块起点
        const delSet = new Set(bases);
        const delStarts = new Set();
        for (const si of starts) {
          if (delSet.has((lines[si] || '').trimEnd())) delStarts.add(si);
        }
        if (!delStarts.size) continue;
        // 标记删除行：被删块内容（起点到下一块起点/EOF）+ 每块紧邻前方的分隔线
        const delIdx = new Set();
        for (let k = 0; k < starts.length; k++) {
          const si = starts[k];
          if (!delStarts.has(si)) continue;
          const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
          for (let i = si; i < end; i++) delIdx.add(i);
          let p = si - 1;
          while (p >= 0 && !(lines[p] || '').trim()) p--;
          if (p >= 0 && /^=+$/.test((lines[p] || '').trimEnd())) delIdx.add(p);
        }
        const out = [];
        for (let i = 0; i < lines.length; i++) if (!delIdx.has(i)) out.push(lines[i]);
        while (out.length && !(out[out.length - 1] || '').trim()) out.pop();
        // 仅剩分隔线/空行视为已空 → 移除日志文件（走回收站），否则重写
        if (!out.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()))) this._recycleFile(logPath);
        else fs.writeFileSync(logPath, out.join('\n'), 'utf-8');
      } catch (e) {}
    }
  }

  // 遮罩任务清除：从项目「遮罩日志」目录（MASK_LOG_DIR）的 *.txt 中移除目标成片的条目块。
  // 遮罩日志块结构与复刻日志一致：成片名（.mp4）行开头，块含使用片段列表/原片/遮罩/@out/分隔线
  _removeMaskLogBlocks(task, videoPaths) {
    const logDir = String((task && task.env && task.env.MASK_LOG_DIR) || '').trim();
    if (!logDir || !fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) return;
    if (!Array.isArray(videoPaths) || !videoPaths.length) return;
    const bases = new Set();
    for (const v of videoPaths) {
      try { const b = path.basename(String(v)); if (b) bases.add(b); } catch (e) {}
    }
    if (!bases.size) return;
    let files = [];
    try {
      files = fs.readdirSync(logDir).filter((f) => /遮罩日志\.txt$/.test(String(f)) && fs.statSync(path.join(logDir, f)).isFile());
    } catch (e) { return; }
    for (const f of files) {
      const lp = path.join(logDir, f);
      try {
        const lines = fs.readFileSync(lp, 'utf-8').split('\n');
        const starts = [];
        for (let i = 0; i < lines.length; i++) {
          const ln = (lines[i] || '').trimEnd();
          if (ln.endsWith('.mp4') && !ln.includes('\\') && !ln.includes('/')) starts.push(i);
        }
        const delStarts = new Set();
        for (const si of starts) if (bases.has((lines[si] || '').trimEnd())) delStarts.add(si);
        if (!delStarts.size) continue;
        const delIdx = new Set();
        for (let k = 0; k < starts.length; k++) {
          const si = starts[k];
          if (!delStarts.has(si)) continue;
          const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
          for (let i = si; i < end; i++) delIdx.add(i);
          let p = si - 1;
          while (p >= 0 && !(lines[p] || '').trim()) p--;
          if (p >= 0 && /^=+$/.test((lines[p] || '').trimEnd())) delIdx.add(p);
        }
        const out = [];
        for (let i = 0; i < lines.length; i++) if (!delIdx.has(i)) out.push(lines[i]);
        while (out.length && !(out[out.length - 1] || '').trim()) out.pop();
        // 仅剩分隔线/空行视为已空 → 移除遮罩日志文件（走回收站），否则重写
        if (!out.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()))) this._recycleFile(lp);
        else fs.writeFileSync(lp, out.join('\n'), 'utf-8');
      } catch (e) {}
    }
  }

  // 删除失败任务在磁盘上遗留的产物（无任务标记时的清理）：
  // 1) 任务日志中「✅ 成片完成：」明确列出的成片文件 —— 精确清单，始终执行；
  // 2) 批量输出目录内的残留 mp4 与拼接日志 —— 仅在能确认该目录确属本任务时执行
  //    （目录内确有日志列出的成片文件）。推算目录在同日同名任务间会撞车，
  //    无归属证据时一律不动：找不到就是找不到，不猜。
  _removeTaskArtifacts(task) {
    // 产物即将被移除 → 让成片存在性结论立即失效（内存 + verify_cache；否则界面仍按旧结论显示）
    this._invalidateHasOutput(task && task.id);
    // 快照是「任务专属 TXT 副本」，只在任务启动前用于还原配置。
    // 产物既已移除、任务记录即将消失，快照即成孤儿 → 直接删除（无用户价值，不必进回收站）。
    try { fs.unlinkSync(this._txtSnapPath(task && task.id)); } catch (e2) { /* 无快照或已清都无妨 */ }
    // 一律移入回收站（可还原），不做永久删除
    const rm = (p) => { try { if (p && fs.existsSync(p)) this._recycleFile(p); } catch (e2) {} };
    // 1) 日志中列出的成片
    const listed = [];
    for (const line of (task.log || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(line);
      if (m) { const p = String(m[1]).trim(); if (p) { listed.push(p); rm(p); } }
    }
    // 2) batch 专属输出目录：先确认归属，再做残留清理与配置 TXT 归位
    if (task.type === 'batch') {
      const detail = this._batchTaskOutDetail(task);
      if (detail && detail.outDir) {
        const dir = path.resolve(detail.outDir);
        const belongs = listed.some((p) => path.dirname(path.resolve(p)) === dir);
        if (belongs) {
          const src = (task.env && task.env.REPLICA_TXT) ? String(task.env.REPLICA_TXT) : '';
          if (src && !fs.existsSync(src)) {
            const dest = path.join(dir, path.basename(src));
            try { if (fs.existsSync(dest) && fs.statSync(dest).isFile()) fs.renameSync(dest, src); } catch (e2) {}
          }
          try {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
              for (const f of fs.readdirSync(dir)) {
                const fp = path.join(dir, f);
                if (fs.existsSync(fp) && fs.statSync(fp).isFile() && (path.extname(f).toLowerCase() === '.mp4' || /拼接日志/.test(f))) rm(fp);
              }
            }
          } catch (e2) {}
        }
      }
    }
  }

  // 任务在磁盘上的真实输出目录：取日志中脚本明确创建的目录（权威记录）。
  // 推算目录（提交时刻+配置名）在同日同名任务之间会撞车，不能作为删除依据。
  _taskOutDirFromLog(task) {
    for (const ln of (task.log || [])) {
      const m = /✅ 创建输出目录：(.+)$/.exec(ln);
      if (m) {
        const d = String(m[1]).trim();
        if (d) return d;
      }
    }
    return '';
  }

  // 校验某目录确属该任务：目录内存在任务产出清单（标记/日志解析）中的文件。
  // ⚠ 只适用于**有清单**的任务（复刻/遮罩：完成行带路径）。批量任务的清单恒为空
  // （batch 完成行不携带路径）→ 传本函数必得 false；批量的目录归属请用「引擎记录的
  // batchOutDir + 运行时间窗」判定（见 clearDoneTasks 的 batch 分支）。
  _dirOwnsVideos(dir, videos) {
    if (!dir || !Array.isArray(videos) || !videos.length) return false;
    const target = path.resolve(dir);
    for (const p of videos) {
      if (!p) continue;
      if (path.dirname(path.resolve(p)) === target) return true;
    }
    return false;
  }

  // batch 专属输出目录推算：目录名规则 MMdd-HH时mm分-配置名-成片（与 旧版脚本 一致）
  _batchTaskOutDetail(task, allowFallback) {
    const src = (task.env && task.env.REPLICA_TXT) ? String(task.env.REPLICA_TXT) : '';
    if (!src) return null;
    const submit = Number(task.env && task.env.BATCH_SUBMIT_TS) || Number(task.env && task.env.REPLICA_SUBMIT_TS) || task.createdAt || Date.now();
    const d = new Date(submit);
    const p = (n) => (n < 10 ? '0' : '') + n;
    const mmdd = p(d.getMonth() + 1) + p(d.getDate());
    const hhmm = p(d.getHours()) + '时' + p(d.getMinutes()) + '分';
    // 基目录：与脚本一致，从路径最外层起取首个「N月」/「4位数字」段之前的路径
    const abs = path.resolve(src);
    const parts = path.dirname(abs).split(path.sep).filter((s) => s && s !== '.');
    let baseIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^\d+月$/.test(parts[i]) || /^\d{4}$/.test(parts[i])) { baseIdx = i; break; }
    }
    const baseDir = baseIdx >= 0 ? (parts.slice(0, baseIdx).join(path.sep) || path.parse(abs).root) : path.dirname(abs);
    const outputRoot = path.join(baseDir, (d.getMonth() + 1) + '月', mmdd);
    const txtName = path.basename(abs).replace(/\.txt$/i, '');
    const planned = path.join(outputRoot, mmdd + '-' + hhmm + '-' + txtName + '-成片');
    if (fs.existsSync(planned)) return { outDir: planned };
    // 规划目录不存在：可能是"凌晨内容归入前一天"被人工迁移（如 0831 凌晨任务移至 0830）。
    // 回退查找当天与前一天「8月」目录下实际存在的同名成片目录（HH时mm分-配置名-成片）
    if (allowFallback) {
      const yday = new Date(d); yday.setDate(d.getDate() - 1);
      const ymdd = p(yday.getMonth() + 1) + p(yday.getDate());
      const monthDir = path.join(baseDir, (d.getMonth() + 1) + '月');
      const key = hhmm + '-' + txtName + '-成片';
      for (const day of [mmdd, ymdd]) {
        const dd = path.join(monthDir, day);
        try {
          if (!fs.existsSync(dd) || !fs.statSync(dd).isDirectory()) continue;
          for (const e of fs.readdirSync(dd)) {
            if (!String(e).endsWith('成片') || !e.startsWith(day + '-')) continue;
            if (!e.includes(key)) continue;
            const f = path.join(dd, e);
            if (fs.existsSync(f) && fs.statSync(f).isDirectory()) return { outDir: f };
          }
        } catch (e2) {}
      }
    }
    return { outDir: planned };
  }

  clearFinishedTasks(statuses) {
    // 仅清理指定的已结束状态任务（缺省：完成/停止/失败）；运行中、排队中、暂停中的任务保留
    const allow = new Set(Array.isArray(statuses) && statuses.length ? statuses : ['done', 'stopped', 'error']);
    const removed = [];
    for (const [id, t] of this.tasks) {
      if (allow.has(t.status)) { this.tasks.delete(id); this._removeMarker(t, { silent: true }); removed.push(t); }
    }
    if (removed.length) {
      this._lg('DEL', 'task.marker.remove.batch',
        '批量清除任务标记 · ' + removed.length + ' 个 · 状态 ' + [...allow].join('/'),
        { ids: removed.slice(0, 50).map((t) => t.id) });
    }
    this._emitTasks();
    return { ok: true };
  }

  // 清除已完成/已停止任务：支持按日期分组 / 指定任务列表 / 三种作用域（仅列表 / 列表+mp4 / 全部清除）。
  // 先删任务列表（连带删除任务标记文件）；文件删除均移动至系统回收站。
  async clearDoneTasks(opts) {
    const { day, scope, statuses, ids } = opts || {};
    const allow = new Set(Array.isArray(statuses) && statuses.length ? statuses : ['done']);
    const dayOf = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      const p = (n) => (n < 10 ? '0' : '') + n;
      return String(d.getFullYear()).slice(2) + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
    };
    // 指定任务列表时精确按 id 清除（单任务条），否则按状态+日期筛选
    const inIds = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const targets = [...this.tasks.values()].filter((t) => (inIds ? inIds.has(t.id) : (allow.has(t.status) && (!day || dayOf(t.endedAt) === day))));
    // 先缓存每个任务的标记（文件删除用精确产物清单，删除前读取；任务记录清掉后再删标记文件）
    const marked = targets.map((t) => ({ t, marker: this._loadMarker(t) }));
    // 清除动作留痕：范围 + 任务清单。任务记录与标记随后都会消失，这里是唯一的凭据。
    if (marked.length) {
      this._lg('DEL', 'task.clearDone',
        '清除已完成任务 · ' + marked.length + ' 个 · 范围 ' + String(scope || 'list') + (day ? ' · 日期 ' + day : ''),
        { scope: scope || 'list', day: day || '',
          tasks: marked.slice(0, 50).map(({ t }) => ({
            id: t.id, type: t.type, title: String(t.title || '').slice(0, 40),
            outDir: t.outDir || '', clips: (t.progress && t.progress.current) || 0,
          })) });
    }
    // 先清任务列表（连带任务标记）
    for (const { t } of marked) { this.tasks.delete(t.id); this._invalidateHasOutput(t.id); this._removeMarker(t, { silent: true }); }
    const errors = [];
    if (scope && scope !== 'list') {
      const { shell } = require('electron');
      const trash = async (p) => {
        try { await shell.trashItem(p); }
        catch (e) { if (fs.existsSync(p)) throw e; } // 原路径已不存在视为成功
      };
      for (const { t, marker } of marked) {
        // ★ 记录马上被删除 → 顺手收走"只剩残渣"的输出目录（回迁配置正本 + 清 0 字节日志与半截
        //   临时产物，目录清空后自动收回）。不做这一步，这些残渣会随记录一起失去归属、永久留存。
        //   ⚠ 范围「仅列表」（scope==='list'）不会走到这里 —— 那个语义就是只清列表、不动磁盘。
        await this._settleOrphanOutDir(t);
        // 该任务精确产出的成片清单：优先任务标记（复刻/遮罩逐条记录 `✅ 成片完成：<路径>`），
        // 缺失时回退任务日志行解析。⚠ **batch 的完成行不带路径**（只报时长/加速倍率，见
        // engines/base/logger.js 的 clipDoneBatch）→ 批量任务的清单恒为空，必须走下方时间窗兜底。
        const exactVideos = (marker && Array.isArray(marker.videos) ? marker.videos.slice() : [])
          .concat(this.collectDoneFromLog(t));
        const titleBrief = String(t.title || '').slice(0, 40);
        if (t.type === 'batch') {
          // 目录归属（**只用权威来源，不做推算**）：任务标记记录的真实输出目录（引擎
          // 「✅ 创建输出目录：」行写入的 batchOutDir）→ 任务日志中的同一行 → 任务对象上的 outDir。
          // ⚠ 绝不可用「按提交时间推算目录名」（_batchTaskOutDetail）作为删除依据：
          //   同分钟同配置的多个任务会推出同一个目录，那是重跑/续跑的常态，据此整删会误伤他人产物。
          const cand = (marker && marker.batchOutDir ? path.resolve(String(marker.batchOutDir)) : '')
            || this._taskOutDirFromLog(t)
            || (t.outDir ? path.resolve(t.outDir) : '');
          if (!cand) {
            errors.push(`未找到「${titleBrief}」的输出目录记录，未删除任何产物`);
            continue;
          }
          const abs = cand;
          let isDir = false;
          try { isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory(); } catch (e2) { isDir = false; }
          // 目录不存在 = 已无产物（先前已清理 / 用户手动删除）→ 无需报错，视为已达成
          if (!isDir) continue;
          // 目录内产物归属判定（**保守优先：确认不了就不动**）。三类内容各有归属依据：
          //  · mp4（正式产物）：优先任务标记的精确清单；缺失时（batch 常态）以**任务运行时间窗**界定 ——
          //    引擎先写临时名、编码成功才原子改名，故正式名成片的 mtime 必然落在 [startedAt, endedAt] 内。
          //  · `<随机>.tmp`（引擎临时产物）：只有唯一的硬依据 —— 名字里的 base36 时间戳/patch mtime，
          //    同样按时间窗界定；**时间窗外的一律视为他人产物**。
          //  · 拼接日志：命名即含「<时间戳>-<配置名>」，与成片目录同源，不会混入他人日志。
          // 容差仅取 ±2 秒（时钟/边界抖动），**不可放大** —— 容差一大，相邻同目录任务的时间窗就会重叠，
          // 「删 17:50 不误删后续任务」的保证随之失效。
          // 同目录串行执行由引擎的执行权控制保证：任一时刻只有一个任务在产出，故时间窗天然互斥。
          let names = [];
          try { names = fs.readdirSync(abs); }
          catch (e) { errors.push('读取成片目录失败：' + abs); continue; }
          const mp4s = names.filter((f) => path.extname(f).toLowerCase() === '.mp4');
          const logFiles = names.filter((f) => LOG_NAME_RE.test(f));
          const tempFiles = names.filter((f) => /^[0-9a-z]{6,}\.tmp$/i.test(f));
          const winFrom = Number(t.startedAt || 0);
          const winTo = Number(t.endedAt || 0);
          const inWindow = (fp) => {
            if (!(winFrom > 0 && winTo > 0)) return false;
            try { const m = fs.statSync(fp).mtimeMs; return m >= winFrom - 2000 && m <= winTo + 2000; }
            catch (e) { return false; }
          };
          const owned = new Set(exactVideos.filter(Boolean).map((p) => path.resolve(p)));
          if (owned.size === 0 && mp4s.length) {
            for (const f of mp4s) {
              const fp = path.join(abs, f);
              if (inWindow(fp)) owned.add(path.resolve(fp));
            }
          }
          // 归属确认不了就不动 —— 但必须把原因说清楚（旧实现静默 continue，用户以为软件没反应）
          if (owned.size === 0 && mp4s.length) {
            const why = (winFrom > 0 && winTo > 0)
              ? `目录内 ${mp4s.length} 个成片均不在该任务运行时间窗内`
              : '该任务缺少运行时间记录';
            errors.push(`未能确认「${titleBrief}」的产物归属（${why}），已保留未删除`);
            continue;
          }
          // 残渣 = 时间窗内的临时产物（半成品）。日志天然归本任务，不参与时间窗筛选。
          const ownedTemps = tempFiles.filter((f) => inWindow(path.join(abs, f)));
          // 目录里有没有"既不认识、也不属于本任务"的文件？有 → 不判独占，绝不整目录删。
          // 待回迁的正本 txt 不算未知（它只是还没搬回去），会在下面被回迁。
          const unknown = names.filter((f) => {
            if (mp4s.indexOf(f) >= 0) return false;
            if (LOG_NAME_RE.test(f)) return false;
            if (tempFiles.indexOf(f) >= 0) return false;
            if (/\.txt$/i.test(f) && !BACKUP_NAME_RE.test(f)) return false;
            try { return fs.statSync(path.join(abs, f)).isFile(); } catch (e) { return true; }
          });
          // 独占 = 目录内一切都能确认属于本任务：
          //   mp4 全在清单内 + 临时产物全在时间窗内 + 没有未知文件。
          // ★ 与旧实现的关键差别：**不再要求目录里有 mp4** ——
          //   紧急停止/失败的任务目录常常只有 `.tmp` + 0 字节日志 + 被移入的正本，
          //   旧判定下 exclusive 恒为 false，用户点「清除产物·全部」也永远清不掉（空壳残留的病根）。
          const exclusive = (mp4s.length + tempFiles.length + logFiles.length) > 0
            && mp4s.every((f) => owned.has(path.resolve(path.join(abs, f))))
            && ownedTemps.length === tempFiles.length
            && unknown.length === 0;
          // 范围「仅视频」时清理对象也只有正式产物（语义即"只清成片文件"，不碰日志与正本）
          const trashOwned = async () => {
            for (const f of mp4s) {
              const fp = path.join(abs, f);
              if (!owned.has(path.resolve(fp))) continue;
              try { await trash(fp); }
              catch (e) { errors.push('清除成片失败：' + fp); }
            }
          };
          // 删除前留痕：产物进回收站后，「删了什么、多大、原修改时间」就只剩这一行了
          const toRemove = (scope === 'all' && path.basename(abs).endsWith('成片') && exclusive)
            ? [abs]
            : mp4s.map((f) => path.join(abs, f)).filter((fp) => owned.has(path.resolve(fp)));
          if (toRemove.length) {
            const info = this._describeForLog(toRemove);
            this._lg('DEL', 'task.artifacts.clear',
              '清除任务产物 · ' + t.type + ' · ' + info.count + ' 个 · 共 ' + this._humanSize(info.bytes)
              + ' · 范围 ' + String(scope),
              Object.assign({ id: t.id, title: String(t.title || '').slice(0, 40) }, info));
          }
          if (scope === 'video') {
            await trashOwned();
          } else if (scope === 'all') {
            if (path.basename(abs).endsWith('成片') && exclusive) {
              // ★ 整目录进回收站之前，先把配置正本**移回原处**（成片目录的父目录）——
              //   正本是被引擎搬进来的"用户原件的唯一一份"，跟着目录一起进回收站，
              //   用户的配置就凭空消失了（源位置已空）；虽然回收站可还原，但那不是用户能预期的操作。
              const rescued = this._rescueConfigFromOutDir(abs);
              if (rescued.restored.length) {
                this._lg('CFG', 'task.artifacts.clear.restore',
                  '清除成片目录前，配置正本已移回原处 · ' + rescued.restored.join('、')
                  + (rescued.skipped.length ? '（另有 ' + rescued.skipped.length + ' 个因原位置已有同名而保留在目录内）' : ''),
                  { id: t.id, outDir: abs, restored: rescued.restored, skipped: rescued.skipped });
              }
              try { await trash(abs); }
              catch (e) { errors.push('清除成片文件夹失败：' + abs); continue; }
              const parent = path.dirname(abs);
              if (parent && parent !== abs) {
                try { if (fs.readdirSync(parent).length === 0) await trash(parent); }
                catch (e) { errors.push('清除空上级文件夹失败：' + parent); }
              }
            } else {
              await trashOwned();
            }
          }
          continue;
        }
        // 复刻等非批量任务：只精确删除该任务自己的成片与日志块——
        // outDir 可能指向源日志目录（复刻历史日志时产物在提交日目录），按目录整删会误伤原始日志旁的产物
        if (!exactVideos.length) continue;
        const rootRes = path.resolve(this.root || process.cwd());
        const uniq = [...new Set(exactVideos)];
        // 删除前留痕（同上）
        {
          const info = this._describeForLog(uniq);
          this._lg('DEL', 'task.artifacts.clear',
            '清除任务产物 · ' + t.type + ' · ' + info.count + ' 个 · 共 ' + this._humanSize(info.bytes)
            + ' · 范围 ' + String(scope),
            Object.assign({ id: t.id, title: String(t.title || '').slice(0, 40) }, info));
        }
        for (const p of uniq) {
          try { if (p && fs.existsSync(p)) await trash(p); }
          catch (e) { errors.push('清除成片失败：' + p); }
          // 成片删除后，所在输出目录若已空则逐级向上清理（到工作根为界）——不留「复刻成片文件夹空壳」；
          // 任一目录非空即停止（重建/并行任务产物、日志文件等都会让它保留）
          if (p) {
            let cur = path.dirname(path.resolve(p));
            while (cur.length > rootRes.length && cur !== rootRes) {
              let entries = [];
              try { entries = fs.readdirSync(cur); } catch (e) { break; }
              if (entries.length) break;
              try { fs.rmdirSync(cur); } catch (e) { break; }
              cur = path.dirname(cur);
            }
          }
        }
        if (scope === 'all' || scope === 'video') {
          this._removeLogEntries(uniq);
          this._removeMaskLogBlocks(t, uniq); // 遮罩任务：从项目遮罩日志中移除该批成片的条目块
        }
      }
    }
    this._emitTasks();
    return { ok: true, removed: targets.length, errors };
  }

  // 已完成批量任务重分组：修复分组数错误 / 忘记分组。规则与 旧版脚本 完全一致——
  // 按日志记录顺序（即生成顺序）1..N 均匀分成 n 组（前 remainder 组各多 1 个），组后缀依次大写字母 A/B/C…；
  // 已有旧分组后缀（末尾单个大写字母）会先剥除再补新后缀；同时把拼接日志中每个成片名行同步改为新名。
  regroupTask(id, groupCount) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'done') return { ok: false, error: '仅已完成的任务可重分组' };
    if (t.type !== 'batch') return { ok: false, error: '仅批量拼接任务支持重分组' };
    const n = parseInt(String(groupCount), 10);
    if (!(n > 0)) return { ok: false, error: '分组数必须是大于 0 的正整数' };
    // 输出目录：优先任务日志中记录的「创建输出目录」（脚本实际输出目录），回退任务 outDir
    let outDir = '';
    for (const ln of (t.log || [])) {
      const m = /✅ 创建输出目录：(.+)$/.exec(ln);
      if (m) { outDir = String(m[1]).trim(); break; }
    }
    if (!outDir || !fs.existsSync(outDir)) outDir = t.outDir || '';
    try {
      if (!outDir || !fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) return { ok: false, error: '找不到成片输出目录' };
    } catch (e) { return { ok: false, error: '找不到成片输出目录' }; }
    // 本批次专属的拼接日志（文件名含时间戳+配置名），同目录可能同时存在其他批次日志
    let logPath = '';
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (/拼接日志\.txt$/i.test(f) && fs.statSync(path.join(outDir, f)).isFile()) { logPath = path.join(outDir, f); break; }
      }
    } catch (e) {}
    if (!logPath) return { ok: false, error: '输出目录中未找到拼接日志文件' };
    // 按生成顺序解析成片名（批量日志每块首行 = 成片文件名，与 _parseLog 同规则）
    let entries = [];
    try { entries = this._parseLog(logPath).map((en) => String(en.video || '').trim()).filter(Boolean); }
    catch (e) { return { ok: false, error: '拼接日志解析失败' }; }
    const total = entries.length;
    if (!total) return { ok: false, error: '日志中没有成片记录' };
    // 分组后缀计算：与脚本一致
    const groupSize = Math.floor(total / n);
    const remainder = total % n;
    const letterFor = (idx) => {
      if (n <= 1) return '';
      let start = 1;
      for (let g = 0; g < n; g++) {
        const size = groupSize + (g < remainder ? 1 : 0);
        if (idx >= start && idx < start + size) return String.fromCharCode(65 + g);
        start += size;
      }
      return '';
    };
    const renamed = [];   // [旧名, 新名]
    const errors = [];
    for (let i = 0; i < total; i++) {
      const oldName = entries[i];
      const src = path.join(outDir, oldName);
      try {
        if (!fs.existsSync(src)) { errors.push('缺失文件：' + oldName); continue; }
        const ext = path.extname(oldName);
        let base = path.basename(oldName, ext);
        base = base.replace(/[A-Z]$/, ''); // 剥除旧分组后缀
        const newName = base + letterFor(i + 1) + ext;
        if (newName === oldName) continue;
        const dst = path.join(outDir, newName);
        if (fs.existsSync(dst)) { errors.push('目标重名已跳过：' + newName); continue; }
        fs.renameSync(src, dst);
        renamed.push([oldName, newName]);
      } catch (e) { errors.push('重命名失败：' + oldName + '（' + e.message + '）'); }
    }
    // 同步改写拼接日志中的成片名行（严格匹配旧名，避免误伤片段/水印行）
    if (renamed.length) {
      const map = new Map(renamed);
      try {
        const text = fs.readFileSync(logPath, 'utf-8');
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        let ch = false;
        for (let i = 0; i < lines.length; i++) {
          const s = lines[i].trim();
          if (map.has(s)) { lines[i] = map.get(s); ch = true; }
        }
        if (ch) fs.writeFileSync(logPath, lines.join(eol), 'utf-8');
      } catch (e) { errors.push('日志同步失败：' + e.message); }
      // 成片索引缓存失效：重命名后搜索/日志定位需重建
      this._clipIndex = new Map();
      this._clipIndexDirty = false;
      this._clipIndexRoot = '';
    }
    if (renamed.length) {
    // 同步刷新任务记录的分组数，任务列表卡片随之更新（分组数=输入值；1 表示取消分组置 0 不显示）
    t.progress = Object.assign({}, t.progress || {}, { groupCount: n > 1 ? n : 0 });
    this.persistTasks();
    this._emitTasks();
    }
    if (renamed.length) this._markConfigModified();
    return { ok: true, total, regrouped: renamed.length, errors };
    return { ok: true, total, regrouped: renamed.length, errors };
  }

  // 实际备份根目录：与「备份落盘 / 过期清理 / 目录迁移」使用的一致
  //（自定义目录时备份落在其下的「Video Lab 备份」层，未设置时用数据目录下的 backup）
  getBackupRoot() {
    const c = String(this.config.backup_dir || '').trim();
    return c ? path.join(c, 'Video Lab 备份') : path.join(this.storageDir || process.cwd(), 'backup');
  }

  // 更新日志（CHANGELOG.md 位于应用目录内，随 app.asar 打包）
  getChangelog() {
    try {
      const p = path.join(__dirname, 'CHANGELOG.md');
      return { ok: true, content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /**
   * 关于页 · 运行环境与组件信息（版本号 / 来源 / 目录 / 校验结果）。
   * 为什么要这一块：组件是**自动下载**的，用户无从得知实际跑的是哪一份、什么版本、从哪来；
   * 出问题时（如旧版 6.1.1 的进度行缺 elapsed）也只能靠翻日志。这里把它显式摆出来，
   * 同时给出「复制信息」所需的原始字段。
   */
  async getAboutInfo() {
    const readVer = (bin) => new Promise((resolve) => {
      try {
        const { execFile } = require('child_process');
        execFile(bin, ['-version'], { windowsHide: true, timeout: 8000 }, (e, so) => {
          const m = String(so || '').match(/version\s+([\w.\-]+)/i);
          resolve(m ? m[1] : '');
        });
      } catch (e) { resolve(''); }
    });
    const bin = this._resolveFfmpegBin();
    const out = {
      ok: true,
      app: { version: '', storageDir: String(this.storageDir || ''), enginesDir: String(this.enginesDirFixed || this.enginesDir || '') },
      runtime: {
        platform: process.platform + '-' + process.arch,
        electron: (process.versions && process.versions.electron) || '',
        chrome: (process.versions && process.versions.chrome) || '',
        node: (process.versions && process.versions.node) || '',
      },
      component: {
        dir: String(bin.cfgDir || ''),
        ffmpeg: String(bin.ffmpegPath || ''),
        ffprobe: String(bin.ffprobePath || ''),
        version: '', source: '', downloadedAt: '',   // 来自 _meta.json（自动下载时写入）
        ffmpegVersion: '', ffprobeVersion: '',       // 来自实际可执行文件（更可信）
      },
      env: { missing: [], missingEncoders: [], probeFailed: false, probeReason: '' },
    };
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      out.app.version = String(pj.version || '');
    } catch (e) {}
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(String(bin.cfgDir || ''), '_meta.json'), 'utf8'));
      out.component.version = String(meta.version || '');
      out.component.source = String(meta.source || '');
      out.component.downloadedAt = String(meta.downloadedAt || '');
    } catch (e) {}
    if (out.component.ffmpeg) out.component.ffmpegVersion = await readVer(out.component.ffmpeg);
    if (out.component.ffprobe) out.component.ffprobeVersion = await readVer(out.component.ffprobe);
    try {
      const e = await this.checkEnvAsync();
      out.env.missing = (e.missing || []).slice(0, 12);
      out.env.missingEncoders = (e.missingEncoders || []).slice(0, 8);
      out.env.probeFailed = !!e.probeFailed;
      out.env.probeReason = String(e.probeReason || '');
    } catch (e) {}
    return out;
  }

  // 关于页（README.md 位于应用目录内，随 app.asar 打包）
  getReadme() {
    try {
      const p = path.join(__dirname, 'README.md');
      return { ok: true, content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 暂停：排队中的任务移出执行队列并冻结当前显示顺位；**运行中的任务 = 软暂停**——
  // 不打断当前成片，当前成片完成后终止引擎（本片已完整落盘），恢复顺位提到 1 号，
  // 下一个任务先跑，剩余部分靠「继续任务」断点续传
  pauseTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'running') {
      // 视频处理任务按文件粒度重跑语义不匹配，暂不支持软暂停
      if (t.type === 'tool') return { ok: false, error: '视频处理任务不支持暂停，请使用「停止」后重新提交' };
      t._softPause = true;
      this._lg('RUN', 'task.softPause',
        '软暂停 · 当前成片完成后生效 · ' + t.type + ' · ' + String(t.title || '').slice(0, 50),
        { id: t.id });
      t.log.push('[软暂停] 当前成片完成后暂停，让下一个任务先执行；剩余部分可「继续任务」续跑]');
      this._emitTasks();
      return { ok: true, soft: true, message: '将在当前成片完成后暂停' };
    }
    if (t.status !== 'queued') {
      return { ok: false, error: '任务已结束' };
    }
    const i = this._taskQueue.indexOf(id);
    t.status = 'paused';
    t.paused = true;
    if (i >= 0) this._taskQueue.splice(i, 1);
    // 冻结显示顺位：记录该任务在当前「待运行显示序列」（排队+暂停按计划序号排序）中的位置，
    // 即它前方还有几个待运行任务。继续时据此插队，保证「暂停时几号，继续后还是几号」。
    const waiting = [];
    this.tasks.forEach((t2) => { if (t2.status === 'queued' || t2.status === 'paused') waiting.push(t2); });
    waiting.sort((x, y) => (x.planPos || 1e9) - (y.planPos || 1e9));
    t.resumeIdx = Math.max(0, waiting.indexOf(t));
    t.log.push('[已暂停，移出执行队列；点击继续将保持当前顺位插回]');
    this._emitTasks();
    return { ok: true };
  }

  // 继续：暂停的任务按冻结的显示顺位插回执行队列；无运行任务时立即启动
  async resumeTask(id, opts) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'paused') return { ok: false, error: '任务未处于暂停状态' };
    // ★ 软暂停恢复按类型分流（参数/分组/去重/计数必须原样保留）：
    //   batch / replica → 走 continueReplica 的「补缺片」构造（已完成片从任务标记反推，
    //     以 ONLY_NAMES 只补剩余，env 全量复用 —— 分组/提交时刻/命名与首次一致）；
    //   mask → 直接重新入队（引擎对已存在成片有 skip 幂等检测，天然续跑）；
    //   恢复后必须清软暂停标志，否则下一个成片完成时会被再次终止（暂停死循环）。
    if (t._softPaused && (t.type === 'batch' || t.type === 'replica')) {
      return this.continueReplica(id, opts);
    }
    delete t._softPause;
    delete t._softPaused;
    // 按暂停时的显示顺位插队（0-based）：前方任务数 + 1 位置；
    // 队列已不足（前方任务陆续完成后缩短）时排在队尾，即成为下一个执行任务
    const idx = typeof t.resumeIdx === 'number' ? t.resumeIdx : Math.max(0, (t.planPos || 1) - 1);
    const pos = Math.min(idx, this._taskQueue.length);
    t.status = 'queued';
    t.paused = false;
    this._taskQueue.splice(pos, 0, id);
    // 重算队列计划序号，使显示顺序与插队位置一致（继续后刷新队伍序号）
    this._taskQueue.forEach((qid, k) => { this.tasks.get(qid).planPos = k + 1; });
    delete t.resumeIdx;
    t.log.push('[已恢复，插入队列第 ' + (pos + 1) + ' 位]');
    if (!this._runningTaskId) this._startNextQueued();
    else this._emitTasks();
    return { ok: true };
  }

  // Node 引擎子进程：以 Electron 自带 Node（ELECTRON_RUN_AS_NODE）运行引擎，
  // 既不依赖系统安装 Node，也不依赖 pwsh；stdio 形态与 pwsh 分支完全一致，协议行解析无需改动。
  _spawnNodeEngineChild(task, env) {
    const { spawn } = require('child_process');
    return spawn(process.execPath, [this._engineRunnerPath(), '--module', task.type], {
      env: Object.assign({}, process.env, this._ffmpegBinEnv(), env, { ELECTRON_RUN_AS_NODE: '1' }),
      cwd: this.enginesDir,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  _spawnEngine(type, env, task) {
    this._restoreTaskTxt(task); // 启动前按快照还原 TXT：前序任务可能已把它移入成片目录，或排队期间被重新生成的配置覆盖
    // 以内置 Node 引擎执行任务；stdout/stderr 实时捕获与协议行解析供任务窗口显示。
    const { spawn } = require('child_process');
    const childEnv = Object.assign({}, env);
    childEnv.VL_CACHE_DB = this.cacheDbPath || '';
    // taskId 贯穿：引擎侧诊断事件（@@VLDIAG@@）携带同一 id，跨进程可串链
    childEnv.VL_TASK_ID = task ? String(task.id || '') : '';
    return new Promise((resolve) => {
      const child = this._spawnNodeEngineChild(task, childEnv);
      if (task) {
        task.pid = child.pid;
        this._lg('RUN', 'task.start',
          '任务开始 · ' + task.type + ' · ' + String(task.title || '').slice(0, 60) + ' · pid=' + child.pid,
          { id: task.id, type: task.type, pid: child.pid, env: this._envBrief(task.env) });
        this._engineMark(task.id, '任务开始 ' + task.type + ' · ' + String(task.title || '').slice(0, 60));
        this._emitTasks();
        // 任务真正开始：创建任务标记（含 env 快照，供失败重开精确还原）
        this._touchMarker(task);
        // ★ 任务开始即失效配置树缓存（含持久化），并排后台重建 ——
        //   批量任务会把配置 TXT **移进成片目录**作为正本，原路径随即失效，界面若继续吃缓存
        //   就会显示已失效的旧配置（点进去还是空的），而"等后台自愈"要受 30 分钟频率控制约束 → 不及时。
        //   这里必须连**持久化**一起清：只清内存的话，下一次读取又会从库里读回同一份旧数据。
        try { this._invalidateCaches(true); } catch (e) {}
        this._notifyTreeChanged();     // 立即通知前端重拉（缓存已失效 → 读到真值）
        this._enqueueScanRebuild();
        const decodeLine = (buf) => {
          try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
          catch (e) { try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('latin1'); } }
        };
        const pushLine = (buf) => {
          const s = decodeLine(buf).replace(/\r$/, '').trim();
          if (!s) return;
          // 引擎原始行全量落 engine-<date>.log（stdout/stderr 同路；必须在 status 检查之前 ——
          // 任务终态后的收尾/崩溃行也要留档（app 与 engine 双份并存））
          this._engineLine(task.id, s);
          // ★ 引擎诊断通道（过程信息）：不进任务窗口日志（用户视图保持简洁），
          //   只收集到任务对象；任务失败时随 task.diag 落运行日志（保留 30 天）。
          //   这样「结论给用户、过程给排查」各得其所。
          if (s.indexOf('@@VLDIAG@@') === 0) {
            try {
              const arr = JSON.parse(s.slice(10));
              if (Array.isArray(arr)) task._diag = (task._diag || []).concat(arr).slice(-4000);
            } catch (e) { /* 诊断解析失败不影响任务 */ }
            return;
          }
          if (task.status !== 'running') return;
    // ★ 引擎把配置 TXT 移入成片文件夹作为正本 → 配置的**归属位置**变了，必须立刻失效缓存并广播。
    //   这件事只发生在引擎进程内（后端 spawn 时文件还在原处），所以由引擎输出协议行、后端在此接收；
    //   否则「开始任务后列表仍显示旧的 0927*、点进去却是空的」会一直存在到低频轮询或手动刷新。
    if (s.indexOf('配置正本就位：') === 0) {
      try { this._invalidateCaches(true); } catch (e) {}
      this._notifyTreeChanged();
      this._enqueueScanRebuild();
      return;
    }
          // 单成片实时进度：目标时长（分母）+ ffmpeg time（分子）。
          // 必须放在进度行拦截前，否则 ffmpeg 进度行被折叠后 clip/clipTarget 不再更新（进度条失效）
          const durM = s.match(/(?:成片预计时长|当前文件时长):\s*([\d.]+)\s*秒/);
          if (durM) {
            const d = parseFloat(durM[1]);
            if (d > 0) { task._clipDur = d; task.progress.clipTarget = d; task.progress.clip = 0; }
          }
          const outM = s.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
            || s.match(/\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (outM) {
            task.progress.clip = parseInt(outM[1], 10) * 3600 + parseInt(outM[2], 10) * 60 + parseFloat(outM[3]);
          }
          const usM = s.match(/out_time_us=(\d+)/);
          if (usM) task.progress.clip = parseInt(usM[1], 10) / 1e6;
          // ffmpeg 进度行（frame=/fps=/q=/size=/time=/bitrate=/dup=/drop=/speed=/elapsed=）：
          // 不进日志栈，折叠为单行实时进度（结构化字段，前端按规则直译成中文）；
          // 记录该成片当前最新帧进度，成片完成时固化进日志
          if (/^\s*(frame\s*=|fps\s*=|q\s*=|size\s*=|time\s*=|bitrate\s*=|dup\s*=|drop\s*=|speed\s*=|elapsed\s*=)/.test(s)) {
            const kv = {};
            for (const mm of s.matchAll(/(frame|fps|q|size|time|bitrate|dup|drop|speed|elapsed)\s*=\s*([^\s]+)/g)) kv[mm[1]] = mm[2];
            task.progress.liveLine = kv;
            task._lastFrameLine = kv;
            this._emitTasks();
            return;
          }
          task.log.push(s);
          // 进度解析：匹配 "共 N 个" 与 "生成第 X / Y 个成片" / "复刻第 X / Y 个成片" /
          // 视频处理工具的 "处理第 X / Y 个视频"（同一套进度字段，措辞按模块区分）
          const totalMatch = s.match(/共\s*(\d+)\s*个/);
          if (totalMatch) {
            const n = parseInt(totalMatch[1], 10);
            if (n > 0) task.progress.total = n;
          }
          const curMatch = s.match(/(?:生成|复刻)第\s*(\d+)\s*\/\s*(\d+)\s*个成片/)
            || s.match(/处理第\s*(\d+)\s*\/\s*(\d+)\s*个视频/);
          if (curMatch) {
            const c = parseInt(curMatch[1], 10), t = parseInt(curMatch[2], 10);
            if (t > 0) task.progress.total = t;
            task.progress.current = c;
            // 新成片开始：重置单成片进度与帧进度记录
            task._clipDur = 0;
            task.progress.clip = 0;
            task.progress.clipTarget = 0;
            task._lastFrameLine = null;
          }
          if (/成片完成/.test(s) && task._clipDur > 0) task.progress.clip = task._clipDur;
          // 成片完成：把该成片最后一行帧进度固化进日志（每个成片保留最终进度）
          if (/成片完成/.test(s) && task._lastFrameLine) {
            const finalLine = zhLiveLine(task._lastFrameLine);
            if (finalLine) task.log.push(finalLine);
            task._lastFrameLine = null;
            task.progress.liveLine = null; // 清除实时行，避免与固化行重复显示
          }
          // 新旧文案都要认：历史任务的日志里写的是旧句（「互斥锁」），去掉旧分支会让「重开旧任务」
          // 的状态显示失效。引擎现行文案见 engines/base/logger.js 的三行协议。
          if (/等待前面的任务完成|等待获取互斥锁/.test(s)) task.lockState = 'waiting';
          else if (/开始处理本任务|已获取互斥锁/.test(s)) task.lockState = 'locked';
          else if (/本任务处理结束|互斥锁已释放|任务完成/.test(s)) { task.lockState = 'released'; task.progress.liveLine = null; }
          // 产物记录进任务标记：成片完成路径 / batch 专属输出目录（重开时据此精确删除）
          const outpM = s.match(/✅ 成片完成：(.+)$/);
          if (outpM) {
            const outp = String(outpM[1]).trim();
            this._appendMarkerOut(task, 'videos', outp);
            this._lg('RUN', 'clip.done',
              '成片产出 · ' + String(task.title || '').slice(0, 40) + ' · ' + path.basename(outp),
              { task: task.id, path: outp });
          }
          const outdM = s.match(/✅ 创建输出目录：(.+)$/);
          if (outdM) this._appendMarkerOut(task, 'batchOutDir', String(outdM[1]).trim());
          // 失败成片记录：脚本输出 `❌ 失败成片：<成片名>|<原因>`，供续跑/对账/前端展示
          // ★ 软暂停触发点：当前成片已完成（该行即当前片的完成标志）——
          //   此刻终止引擎进程，本片已完整落盘，剩余部分靠「继续任务」断点续传
          if (task._softPause && !task._softPaused && /成片完成/.test(s)) {
            task._softPaused = true;
            task.resumeIdx = 1;   // 恢复队列第 1 号：让被让位的任务优先接续
            try { if (child.pid) process.kill(child.pid); } catch (e2) {}
            this._lg('RUN', 'task.softPause.fire',
              '软暂停生效 · 当前成片已完成，终止引擎让位下一个任务',
              { id: task.id });
          }
          // 用户指引：引擎错误块里的「如何解决 / 问题归属」—— 供任务窗口直接展示
          // （前端保持简洁，但要让用户知道怎么修、以及是不是程序的问题）
          const howM = s.match(/^如何解决[:：]\s*(.+)$/);
          if (howM) task.solution = howM[1].trim().slice(0, 300);
          const whoM = s.match(/^问题归属[:：]\s*(.+)$/);
          if (whoM) task.blame = whoM[1].trim().slice(0, 120);

          // 失败成片【序号】（命名前失败，如批量组合凑不出时长）：记入 failedIndices 供续跑按序号补做，
          // 同时以「第 N 个」形式进 failedVideos，让任务窗口能显示失败项
          const failIdxM = s.match(/❌ 失败成片序号：(\d+)(?:\|(.*))?$/);
          if (failIdxM) {
            const idx = parseInt(failIdxM[1], 10);
            if (Number.isInteger(idx) && idx > 0) {
              task.failedIndices = task.failedIndices || [];
              if (task.failedIndices.indexOf(idx) < 0) task.failedIndices.push(idx);
              task.failedVideos = task.failedVideos || [];
              task.failedVideos.push({ name: '第' + idx + '个', reason: String(failIdxM[2] || '').trim() });
              task.failReason = '存在失败成片，可点击「继续制作」续跑';
            }
          }
          const failM = s.match(/❌ 失败成片：(.+)$/);
          if (failM) {
            const parts = String(failM[1]).split('|');
            task.failedVideos = task.failedVideos || [];
            task.failedVideos.push({ name: (parts[0] || '').trim(), reason: (parts.slice(1).join('|') || '').trim() });
            task.failReason = '存在失败成片，可点击「继续制作」续跑';
          }
          this._emitTasks();
        };
        const attach = (stream, ref) => stream.on('data', (chunk) => {
          ref.data = Buffer.concat([ref.data, chunk]);
          let idx;
          while ((idx = ref.data.indexOf(0x0a)) >= 0) { pushLine(ref.data.slice(0, idx)); ref.data = ref.data.slice(idx + 1); }
        });
        const out = { data: Buffer.alloc(0) }, err = { data: Buffer.alloc(0) };
        attach(child.stdout, out);
        attach(child.stderr, err);
        // ⚠ 回调必须是 async：下面 _settleTaskLeftovers 要走回收站（shell.trashItem 是异步 API），
        //   而收尾**必须在该回调内、且在缓存失效与前端广播之前完成**（见下方注释），
        //   所以只能在这里 await —— 不能把它挪到回调外做成"稍后处理"，否则界面会先渲染出
        //   "配置还锁在成片目录里"的中间态。
        child.on('close', async (code) => {
          if (out.data.length) pushLine(out.data);
          if (err.data.length) pushLine(err.data);
          task.endedAt = Date.now();
          this._engineMark(task.id, '任务结束 code=' + code);
          // 结算对账（复刻）：脚本内单条失败会 continue 并置 HasError → 退出码 1；
          // 若 exit 0 但存在失败记录（异常场景），也归为 error 并提示续跑，避免误判为全部成功
          // 软暂停：当前成片已完成、引擎被主动终止 —— 状态归为 paused（非停止/失败），
          // 恢复顺位提到 1 号（resumeIdx=1），用户点「继续任务」即从剩余部分接续
          let status = task._softPaused ? 'paused' : (task._stopRequested ? 'stopped' : (code === 0 ? 'done' : 'error'));
          if (task._softPaused) {
            task.endedAt = null;
            task.failReason = '';
            task.resumeIdx = 1;
            task.log.push('[软暂停生效] 当前成片已完成并保留，任务转入暂停队列第 1 位；点击「继续任务」接续]');
          }
          // 续跑补做成功：摘掉继承来的失败记录（引擎本次新报的失败保留）——
          // 那些记录的是上一次的缺口，本次已补回；留着会让任务被判成 error 并提示「继续制作」，
          // 把用户引向无意义的反复续跑
          if (code === 0 && task._inheritedFailVideos > 0) {
            task.failedVideos = (task.failedVideos || []).slice(task._inheritedFailVideos);
            task.failedIndices = (task.failedIndices || []).slice(task._inheritedFailIndices || 0);
            task._inheritedFailVideos = 0;
            task._inheritedFailIndices = 0;
            if (!task.failedVideos.length) task.failReason = '';
          }
          if (code === 0 && Array.isArray(task.failedVideos) && task.failedVideos.length && (task.type === 'replica' || task.type === 'mask' || task.type === 'batch')) {
            status = 'error';
            task.failReason = '存在失败成片，可点击「继续制作」续跑';
          }
          task.status = status;
          task.paused = false;
          // 任务到终态且**全部成功**时，提交快照已无用 ——
          // 它只在任务「启动前」用于还原 TXT（解决排队期配置被覆盖/被同目录任务搬走）。
          // 失败 / 停止 / 暂停 / 中断一律保留：它们还要「继续制作」，届时仍需按快照还原配置。
          if (status === 'done') {
            try { fs.unlinkSync(this._txtSnapPath(task.id)); } catch (e) { /* 无快照或已清都无妨 */ }
          }
          // 终态进度补满（仅成功）：进度条在「clip / clipTarget」分支显示的是**最后一个成片的编码进度**，
          // 而编码收尾帧的 time 几乎必然略小于时长（实测停在 89% / 95%）——任务已全部完成，
          // 这个半截进度只会让人误会"没做完"。error / stopped / paused 保留真实进度（供续跑判断）。
          if (status === 'done' && task.progress && task.progress.clipTarget > 0 && task.progress.clip < task.progress.clipTarget) {
            task.progress.clip = task.progress.clipTarget;
            task.progress.liveLine = null;
          }
          // ★ 未正常结束的任务先做收尾（回迁配置正本 + 清 0 字节日志与半截临时产物）——
          //   必须排在下面所有「缓存失效 / 前端广播」**之前**：收尾本身改变了磁盘结构，
          //   界面要按收尾后的真相重整，否则会先渲染出一个"配置还锁在成片目录里"的中间态。
          //   场景：用户跑到一半发现配置名写错，紧急停止后要改名 —— 但正本躺在成片目录里
          //   （源位置已空）+ 同目录有个 0 字节拼接日志（hasLog 判定为真）→ 改名会被两层拦住。
          //   收尾后配置回到原位、空日志消失，用户点「清除已完成任务」即可顺利改名。
          await this._settleTaskLeftovers(task, status);
          // 任务结束 → 成片存在性结论失效：本次可能刚产出成片（旧结论是"无"），
          // 精确失效后由下次启动/空闲校验重新判定，避免界面显示"成片已删除"却其实还在
          try { this._invalidateHasOutput(task.id); } catch (e) {}
          // ★ 任务结束同样失效配置树缓存 + 排重建：出片会把配置正本搬进成片文件夹、并新增成片目录，
          //   目录结构与配置归属都变了，界面必须立刻按真实情况重整（不能等 30 分钟频率控制的空闲自愈）。
          try { this._invalidateCaches(true); } catch (e) {}
          this._notifyTreeChanged();   // 立即通知前端重拉（任务已改动配置归属与目录结构）
          this._enqueueScanRebuild();
          if (task.status === 'error' && !task.failReason) task.failReason = this._deriveFailReason(task);
          this._lg('RUN', 'task.end',
            '任务结束 · ' + status + ' · ' + task.type + ' · 退出码 ' + code
            + ' · 成片 ' + ((task.progress && task.progress.current) || 0) + '/' + ((task.progress && task.progress.total) || 0)
            + ' · 失败记录 ' + ((task.failedVideos || []).length) + ' 条'
            + (task.failReason ? ' · ' + String(task.failReason).slice(0, 80) : ''),
            { id: task.id, status: status, code: code,
              failed: (task.failedVideos || []).slice(0, 20).map((f) => f && f.name) });
          // ★ 失败诊断留痕：引擎输出（task.log）与 stderr 尾部一并落盘 ——
          //   任务窗口的日志会随任务记录被清除，运行日志是事后唯一凭据。
          //   引擎自己会打印「错误信息 / 出错步骤 / 错误详情」块，这里原样带上，
          //   排查时只看 error-YYYY-MM-DD.log 即可定位，不必反推代码。
          if (status === 'error') {
            try {
              const tailLog = (task.log || []).slice(-40);
              const stderrTail = String((err && err.data && err.data.length) ? err.data.toString('utf8') : '').slice(-1500);
              // 引擎报错块优先：先把「错误信息」那几行提到摘要里，肉眼扫读即可见
              // 摘要优先取「错误详情」（信息量最大：含具体路径/原因），其次「出错步骤」等，
              // 目标是扫一眼错误日志就知道为什么失败，不必展开 JSON
              let why = '';
              for (const l of (task.log || [])) {
                const t = String(l || '').trim();
                if (/^错误详情[:：]/.test(t)) { why = t.slice(0, 200); break; }
              }
              if (!why) {
                for (const l of (task.log || [])) {
                  const t = String(l || '').trim();
                  if (/出错步骤[:：]|未找到|不存在|失败[:：]|ERROR|Error/.test(t) && !/^=+$/.test(t)) { why = t.slice(0, 200); break; }
                }
              }
              this._lg('RUN', 'task.error',
                '任务失败诊断 · ' + task.type + ' · 退出码 ' + code
                + (why ? ' · ' + why : (task.failReason ? ' · ' + String(task.failReason).slice(0, 160) : ' · 无引擎报错信息')),
                { id: task.id, title: task.title, code: code,
                  failReason: task.failReason, why: why,
                  solution: task.solution || '', blame: task.blame || '',
                  stderrTail: stderrTail, engineTail: tailLog,
                  env: this._envBrief(task.env) });
              // 过程诊断（引擎 diag 通道）：完整记录每次尝试/候选/排除/档位，
              // 单独一条落盘（量大，只在失败时写）—— 回答「怎么走到这个结论」
              if (Array.isArray(task._diag) && task._diag.length) {
                this._lg('DIAG', 'task.diag',
                  '任务过程诊断 · ' + task.type + ' · ' + task._diag.length + ' 条（每次尝试 / 候选 / 排除原因 / 参数档位）',
                  { id: task.id, events: task._diag });
              }
            } catch (e3) { /* 日志失败不影响主流程 */ }
          }
          // 任务标记统一保留：done 也保留供「清除成片/日志」精确删除（不误伤同目录其他任务的产物）
          this._emitTasks();
          // 运行任务结束：清空运行位并启动执行队列中的下一个任务（暂停/继续不影响插入后的推进）
          this._runningTaskId = null;
          this._startNextQueued();
          // ★ 系统通知：任务失败必报；队列彻底空闲（无运行中、无排队）
          //   时报「全部任务完成」并区分最后一次是否带失败项
          // 视频处理任务结束后按设置清理过期备份（仅开启时执行）
          if (task.type === 'tool') this._cleanupBackups();
          if (status === 'error') {
            this._notify('任务失败：' + String(task.title || '').slice(0, 50),
              task.failReason || '存在失败项，可在任务列表中查看详情或继续制作');
          }
          // 队列已无待运行任务（queued 空）即视为「本轮跑完」——此时可能还有**暂停待续**的任务
          // （用户主动暂停 / 软暂停让位），这类不在执行队列里，需在通知里明确提醒，避免误以为全做完
          if (!this._runningTaskId && this._taskQueue.length === 0 && (status === 'done' || status === 'error')) {
            var pendingPaused = 0;
            this.tasks.forEach((t2) => { if (t2.status === 'paused') pendingPaused++; });
            const head = status === 'error' ? '任务已跑完（存在失败项）' : '任务已跑完';
            const tail = pendingPaused > 0
              ? '另有 ' + pendingPaused + ' 个任务处于暂停待续，点「继续任务」可接着制作'
              : '任务队列已清空，全部成功';
            this._notify(head, tail);
          }
        });
        child.on('error', (err2) => {
          task.log.push('[启动失败] ' + String(err2));
          task.status = 'error';
          task.failReason = '程序运行组件启动失败，请重新安装或校验程序文件';
          task.endedAt = Date.now();
          this._lg('ERR', 'engine.spawn',
            '运行组件启动失败 · ' + task.type + ' · ' + String(task.title || '').slice(0, 40),
            { id: task.id, enginesDir: this.enginesDir, error: String(err2) });
          this._emitTasks();
        });
      }
      child.on('error', (err2) => {
        this._lg('ERR', 'engine.spawn', '引擎子进程异常 · ' + String(err2));
        resolve({ ok: false, error: String(err2) });
      });
      child.unref();
      resolve({ ok: true });
    });
  }

  // 任务显示标题：优先"项目名 / txt 文件名"（txt 去掉 .txt 后缀），取不到项目名则回退文件名
  _taskTitle(filePath) {
    const abs = path.resolve(filePath);
    const rel = path.relative(this.root, abs);
    const parts = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).filter(Boolean) : [];
    const base = path.basename(abs);
    const txtName = base.replace(/\.txt$/i, '') || base;
    if (parts.length > 0) return parts[0] + ' / ' + txtName;
    return txtName;
  }

  // 复刻任务简化标题：项目名/MMdd-名字/模式——
  // 将批量拼接日志名 MMdd-<HH时MM分>-<名字>-拼接日志 压缩为 MMdd-<名字>，
  // 模式（原片/去重）以斜杠后缀标识；非拼接日志命名形态则保留原文件名
  _replicaTaskTitle(logPath, modeLabel) {
    const abs = path.resolve(logPath);
    const rel = path.relative(this.root, abs);
    const parts = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).filter(Boolean) : [];
    let name = path.basename(abs).replace(/\.txt$/i, '');
    name = name.replace(/^(\d{4})-(\d{1,2}时\d{1,2}分)-(.*)$/, '$1-$3')
               .replace(/[-–—_]\s*拼接日志$/i, '');
    const project = parts.length > 0 ? parts[0] : '';
    return (project ? project + '/' : '') + name + (modeLabel ? '/' + modeLabel : '');
  }

  // 校验 批量/复刻 配置参数是否已设置：数字须>0，字符串须非空（txt_prefix 允许空）。返回缺失项标签，空数组=齐全
  // ⚠ 复刻**不再校验** max_duration / speed_limit —— 这两项与批量拼接共用同一套（见 runReplica 内注释与
  //    BATCH_MAX_DURATION 等取值来源都是 config.batch），复刻配置里根本没有这两个字段；
  //   若仍按复刻必填校验，前端一保存就会把空值写进 replica 并导致所有复刻任务启动被拒。
  _settingsError(group) {
    const cfg = this.config[group] || {};
    const nums = group === 'batch'
      ? [['max_duration', '最大时长(秒)'], ['max_retry', '重试次数'], ['speed_limit', '倍速阈值']]
      : [['dedup_ratio', '去重阈值']];
    const missing = [];
    for (const [k, label] of nums) if (!(parseFloat(cfg[k]) > 0)) missing.push(label);
    if (group === 'batch') {
      if (!String(cfg.producer || '').trim()) missing.push('创作者');
    }
    return missing;
  }

  // 设置页保存后同步 Api 持有的配置副本；批量工作目录（batch.root）变化时重设根目录
  updateSettings(s) {
    const cfg = s || {};
    // 工作路径读 batch.root（顶层 root 只是旧锚点）
    const br = (cfg.batch && typeof cfg.batch === 'object' && typeof cfg.batch.root === 'string')
      ? cfg.batch.root.trim() : '';
    if (br && br !== this.root) this.setRoot(br);
    if (cfg.batch && typeof cfg.batch === 'object') this.config.batch = Object.assign({}, this.config.batch, cfg.batch);
    if (cfg.replica && typeof cfg.replica === 'object') this.config.replica = Object.assign({}, this.config.replica, cfg.replica);
    if (cfg.mask && typeof cfg.mask === 'object') this.config.mask = Object.assign({}, this.config.mask, cfg.mask);
    // 应用级设置（通知开关 / 备份项等）：backend 侧 _notify 等直接读 this.config，
    // 运行时改动必须同步，否则「关了通知仍在弹」直到下次重启。
    for (const k of Api.APP_SETTING_KEYS) {
      if (cfg[k] !== undefined) this.config[k] = cfg[k];
    }
    if (cfg.ffmpeg_dir !== undefined) this.config.ffmpeg_dir = cfg.ffmpeg_dir;
  }

  // 水印归属校验：以本项目「主流水印」为基准做一致性判定；仅在用户启用判定时参与判断。
// 未启用判定的项目一律放行（默认不启用，勾选后才判定）。只返回布尔值（不暴露真实路径/文件名）。
  checkWatermarkProject(project, watermarkPath) {
    const wm = String(watermarkPath || '').trim();
    try {
      if (!wm) return { inProject: true, fileMissing: false };
      const pdir = path.resolve(path.join(this.root, project));
      const wmAbs = path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm);
      // 水印文件本身不存在 → 返回 fileMissing，前端据此阻断启动（与归属判定分离，两种错误分别提示）
      if (!fs.existsSync(wmAbs) || !fs.statSync(wmAbs).isFile()) return { inProject: false, fileMissing: true };
      const wmKey = wmAbs.toLowerCase();
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      // 未启用判定：直接放行
      if (!this._wmEnabled[cacheKey]) return { inProject: true, fileMissing: false };
      if (!Object.prototype.hasOwnProperty.call(this._wmCache, cacheKey)) {
        // 本项目主流水印未固化：现场统计一次并落盘（保存前默认取配置主流作为初始值）
        this._wmCache[cacheKey] = this._computeMajorityWatermark(pdir);
        this._saveWatermarkCache();
      }
      const majority = this._wmCache[cacheKey] || '';
      // 无主流水印(项目无任何水印)放行；有则当前水印必须与其一致（路径比较大小写不敏感）
      return { inProject: !majority || wmKey === String(majority).toLowerCase(), fileMissing: false };
    } catch (e) { return { inProject: true, fileMissing: false }; }
  }

  // 读取项目主流水印设置（弹窗初始化）：main=已保存的设置（无则现场统计主流作为初始默认值）；enabled=是否启用判定
  getProjectWatermark(project) {
    try {
      if (!this.root || !project) return { ok: true, main: '', enabled: false, group: 0, groupEnabled: false };
      const pdir = path.resolve(path.join(this.root, project));
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      let main = this._wmCache[cacheKey] || '';
      if (!main) main = this._computeMajorityWatermark(pdir); // 保留统计主流作初始默认值
      // 缓存里可能存的是全小写路径：磁盘上真实存在同名文件时，纠正为原始大小写并回写缓存
      if (main && main === main.toLowerCase() && fs.existsSync(main)) {
        const real = this._realCasePath(main);
        if (real) {
          main = real;
          this._wmCache[cacheKey] = real;
          this._saveWatermarkCache();
        }
      }
      return { ok: true, main, enabled: !!this._wmEnabled[cacheKey], group: parseInt(this._wmGroup[cacheKey], 10) || 0, groupEnabled: !!this._wmGroupEnabled[cacheKey] };
    } catch (e) { return { ok: false, error: String(e), main: '', enabled: false, group: 0, groupEnabled: false }; }
  }

  // 将路径各段替换为磁盘上的真实大小写（逐级向上查找同名目录/文件）
  _realCasePath(p) {
    try {
      const abs = path.resolve(p);
      const parts = abs.split(path.sep);
      let cur = parts[0] + path.sep; // 盘符保持原样
      for (let i = 1; i < parts.length; i++) {
        const seg = parts[i];
        if (!seg) continue;
        let found = '';
        try {
          const entries = fs.readdirSync(cur, { withFileTypes: true });
          const lower = seg.toLowerCase();
          for (const ent of entries) {
            if (ent.name.toLowerCase() === lower) { found = ent.name; break; }
          }
        } catch (e) {}
        cur = path.join(cur, found || seg);
      }
      return cur;
    } catch (e) { return ''; }
  }

  // 保存项目设置：更新主流水印（判定参照文件与启用标记）与默认分组数；applyToAll=true 时把本项目全部 txt（含日志）的水印行改为新水印
  setProjectWatermark(project, watermark, enabled, applyToAll, group, groupEnabled) {
    try {
      const wm = String(watermark || '').trim();
      const pdir = path.resolve(path.join(this.root, project));
      // 存储保留原始大小写的绝对路径（Windows 显示友好）；比较时另做大小写不敏感归一
      const wmStore = wm ? (path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm)) : '';
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      if (wmStore) { this._wmCache[cacheKey] = wmStore; this._wmEnabled[cacheKey] = !!enabled; }
      else {
        delete this._wmCache[cacheKey];
        delete this._wmEnabled[cacheKey]; // 未设置水印时视同不启用
      }
      // 默认分组数：启用状态 + 数值（0/非数字视为未启用）
      const g = parseInt(group, 10) || 0;
      const ge = !!groupEnabled && g > 0;
      if (ge) { this._wmGroup[cacheKey] = g; this._wmGroupEnabled[cacheKey] = true; }
      else { delete this._wmGroup[cacheKey]; delete this._wmGroupEnabled[cacheKey]; }
      this._saveWatermarkCache();
      if (applyToAll && wm && fs.existsSync(pdir) && fs.statSync(pdir).isDirectory()) {
        const replaced = this._replaceProjectWatermarks(pdir, wm);
        this._markConfigModified(); // 改动配置：清内存缓存并触发前端即时刷新
        return { ok: true, replaced };
      }
      return { ok: true, replaced: 0 };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 递归改写本项目目录下全部 txt 的水印行：配置 txt 替换末尾水印行（保留其余行原样），日志 txt 替换全部 .png 行
  _replaceProjectWatermarks(pdir, newWm) {
    let replaced = 0;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const en of entries) {
        const fp = path.join(dir, en.name);
        if (en.isDirectory()) { walk(fp); continue; }
        if (!en.isFile() || path.extname(en.name).toLowerCase() !== '.txt') continue;
        if (this._replaceWmLine(fp, newWm)) replaced++;
      }
    };
    walk(pdir);
    return replaced;
  }
  _replaceWmLine(fp, newWm) {
    let text;
    try { text = fs.readFileSync(fp, 'utf-8'); } catch (e) { return false; }
    const eol = (text.replace(/\r?\n/g, '\n').length === text.length) ? '\n' : (text.includes('\r\n') ? '\r\n' : '\n');
    const lines = text.split(/\r?\n/);
    const isLog = LOG_NAME_RE.test(path.basename(fp));
    let changed = false;
    if (isLog) {
      // 日志 txt：水印行是成片块末尾的 .png 路径行，全部替换为新水印
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim();
        if (!s || !/\.png$/i.test(s)) continue;
        if (lines[i] !== newWm) { lines[i] = newWm; changed = true; }
      }
    } else {
      // 配置 txt：水印行 = 最后一个 PNG 路径行（非排除/非注释）；无则追加
      let idx = -1;
      for (let i = lines.length - 1; i >= 0 && idx < 0; i--) {
        const s = lines[i].trim();
        if (!s || s.startsWith('=') || s.startsWith('-')) continue;
        if (/\.png$/i.test(s)) idx = i;
      }
      if (idx >= 0) {
        if (lines[idx] !== newWm) { lines[idx] = newWm; changed = true; }
      } else {
        if (lines.length && lines[lines.length - 1].trim()) lines.push('');
        lines.push(newWm);
        changed = true;
      }
    }
    if (!changed) return false;
    try { fs.writeFileSync(fp, lines.join(eol), 'utf-8'); } catch (e) { return false; }
    return true;
  }

  // 查找主流水印与指定水印一致的项目（归属判定升级：供保存/启动时选择目标项目）
  // 复用 watermark_cache 缓存，缺失项目才现场统计并落盘；返回项目名数组（不含复刻）
  // 若当前项目本身就以该水印为主流（共用或多个项目同时使用），归属明确、不触发弹窗
  findWatermarkProject(project, watermarkPath) {
    try {
      const wm = String(watermarkPath || '').trim();
      if (!wm || !this.root) return { hits: [] };
      const pdir = path.resolve(path.join(this.root, project));
      const wmAbs = path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm);
      const wmKey = wmAbs.toLowerCase();
      this._loadWatermarkCache();
      const seen = new Map(); // 项目目录 -> 项目名（去重）
      for (const t of this._collectAllTxt()) {
        const pd = path.resolve(t.pdir);
        if (!seen.has(pd)) seen.set(pd, path.basename(t.pdir));
      }
      let dirty = false;
      const majorityOf = (pd, proj) => {
        const ck = this.root + '\u0000' + proj;
        if (!Object.prototype.hasOwnProperty.call(this._wmCache, ck)) {
          this._wmCache[ck] = this._computeMajorityWatermark(pd);
          dirty = true;
        }
        return this._wmCache[ck] || '';
      };
      // 当前项目自己就在用该水印：共用场景归属明确，直接放行不弹窗
      const curMk = majorityOf(pdir, project);
      if (curMk !== '' && wmKey === String(curMk).toLowerCase()) {
        if (dirty) this._saveWatermarkCache();
        return { hits: [], inOwn: true };
      }
      const hits = [];
      for (const [pd, proj] of seen) {
        if (proj === REPLICA_PROJECT) continue; // 复刻虚拟项目无配置水印
        const mk = majorityOf(pd, proj);
        if (mk !== '' && wmKey === String(mk).toLowerCase()) hits.push(proj);
      }
      if (dirty) this._saveWatermarkCache();
      return { hits };
    } catch (e) { return { hits: [] }; }
  }

  // 统计本项目主流水印：所有配置使用频次最高的水印
  // 计数用大小写不敏感 key（Windows 路径不区分大小写），但返回保留原始大小写的路径（供前端显示与落盘）
  _computeMajorityWatermark(pdir) {
    const counts = new Map(); // key(lower) -> { n, first 原始路径 }
    for (const t of this._collectAllTxt()) {
      if (path.resolve(t.pdir) !== pdir) continue;
      let cfg;
      try { cfg = this.readConfig(t.full); } catch (e) { continue; }
      const w = String(cfg && cfg.watermark || '').trim();
      if (!w) continue;
      const absPath = path.isAbsolute(w) ? path.resolve(w) : path.resolve(pdir, w);
      const k = absPath.toLowerCase();
      const rec = counts.get(k) || { n: 0, first: absPath };
      rec.n++;
      counts.set(k, rec);
    }
    let majorityKey = '', majorityN = 0;
    for (const [k, rec] of counts) { if (rec.n > majorityN) { majorityN = rec.n; majorityKey = rec.first; } }
    return majorityKey;
  }

  // 刷新配置时预填充水印缓存：扫描当前工作目录下所有项目，缺失归属的项目补算主流，已有条目保持不动
  _warmWatermarkCache() {
    if (!this.root) return;
    try {
      this._loadWatermarkCache();
      const seen = new Map(); // 项目目录 -> 项目名（去重）
      for (const t of this._collectAllTxt()) {
        const pdir = path.resolve(t.pdir);
        if (!seen.has(pdir)) seen.set(pdir, path.basename(t.pdir));
      }
      let dirty = false;
      for (const [pdir, project] of seen) {
        const cacheKey = this.root + '\u0000' + project;
        if (Object.prototype.hasOwnProperty.call(this._wmCache, cacheKey)) continue; // 已有条目不动
        this._wmCache[cacheKey] = this._computeMajorityWatermark(pdir);
        dirty = true;
      }
      if (dirty) this._saveWatermarkCache();
    } catch (e) {}
  }

  // ── 批量项目设置（settings.db scope='batch'）：水印主流 / 启用标记 / 默认分组数 / 分组启用 ──
  // 按 root+项目 隔离，保存时只覆盖当前 root 的条目。
  _loadWatermarkCache() {
    if (!this._wmCache) this._wmCache = {};
    if (!this._wmEnabled) this._wmEnabled = {};
    if (!this._wmGroup) this._wmGroup = {};
    if (!this._wmGroupEnabled) this._wmGroupEnabled = {};
    if (this._wmCacheLoadedRoot === this.root) return;
    this._wmCacheLoadedRoot = this.root;
    this._wmCache = {};
    this._wmEnabled = {};
    this._wmGroup = {};
    this._wmGroupEnabled = {};
    if (!this._useSettings()) return;
    const prefix = this.root + '\u0000';
    const want = { watermarks: this._wmCache, enabled: this._wmEnabled, groupCounts: this._wmGroup, groupEnabled: this._wmGroupEnabled };
    try {
      const all = this._settingsStore.all('batch');
      for (const kind of ['watermarks', 'enabled', 'groupCounts', 'groupEnabled']) {
        const src = all[kind];
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
        // 只加载当前工作目录下的条目：换 root 后旧条目不再参与，保存时自然被清理
        for (const k in src) {
          if (!Object.prototype.hasOwnProperty.call(src, k) || !k.startsWith(prefix)) continue;
          if (kind === 'groupCounts') want[kind][k] = parseInt(src[k], 10) || 0;
          else if (kind === 'enabled' || kind === 'groupEnabled') want[kind][k] = !!src[k];
          else want[kind][k] = src[k];
        }
      }
    } catch (e) {}
  }

  _saveWatermarkCache() {
    if (!this._useSettings()) return;
    // 合并保存：保留其它工作目录（root）的条目，仅覆盖当前 root 的条目，
    // 避免切换工作目录后旧 root 的设置被覆盖丢失
    const prefix = this.root + '\u0000';
    const mine = {
      watermarks: this._wmCache || {}, enabled: this._wmEnabled || {},
      groupCounts: this._wmGroup || {}, groupEnabled: this._wmGroupEnabled || {},
    };
    const store = this._settingsStore;
    try {
      const all = store.all('batch');
      store.transaction(() => {
        for (const kind of ['watermarks', 'enabled', 'groupCounts', 'groupEnabled']) {
          const merged = {};
          const src = all[kind];
          if (src && typeof src === 'object' && !Array.isArray(src)) {
            for (const k in src) {
              if (Object.prototype.hasOwnProperty.call(src, k) && !k.startsWith(prefix)) merged[k] = src[k];
            }
          }
          Object.assign(merged, mine[kind]);
          store.set('batch', kind, merged);
        }
      });
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════════════════
  // 项目增删改（软件侧新建 / 改名）
  // ══════════════════════════════════════════════════════════════════════
  // 项目名合法性：Windows 文件名约束。前端 validateProjectName 用同一套规则先校验一次，
  // 这里再做一次 —— 接口也可能被 HTTP 侧直接调用，不能只靠前端把关。
  _validProjectName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return '名称不能为空';
    if (n === '.' || n === '..') return '名称不能是「.」或「..」';
    if (n.length > 64) return '名称过长（最多 64 个字符）';
    if (/[\\/:*?"<>|]/.test(n)) return '名称不能包含 \\ / : * ? " < > | 这些字符';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(n)) return '名称不能包含控制字符';
    if (/[. ]$/.test(n)) return '名称不能以点或空格结尾';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(n)) return '「' + n + '」是系统保留名，请换一个';
    return '';
  }
  _projectRootOf(kind) {
    return (kind === 'mask')
      ? String((this.config && this.config.mask && this.config.mask.root) || '').trim()
      : String(this.root || '').trim();
  }
  // 从软件新建项目：在工作根下建目录 + 登记（登记后无需先放素材/TXT 即可在列表里看到）
  createProject(name, kind) {
    const k = (kind === 'mask') ? 'mask' : 'batch';
    const root = this._projectRootOf(k);
    if (!root) return { ok: false, error: (k === 'mask' ? '尚未设置遮罩工作路径' : '尚未设置工作路径') };
    const bad = this._validProjectName(name);
    if (bad) return { ok: false, error: bad };
    const n = String(name).trim();
    const dir = path.join(root, n);
    // 越权双保险：拼接后必须仍在工作根下（名字里的路径分隔符已被 _validProjectName 拦掉）
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '名称非法' };
    let exists = false;
    try { exists = fs.existsSync(dir); } catch (e) { exists = false; }
    if (exists) return { ok: false, error: '同名项目已存在' };
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return { ok: false, error: '创建目录失败：' + ((e && e.message) || e) }; }
    this._addProjReg(root, k, n);
    this._invalidateCaches();   // 列表缓存作废，下次读取即含新项目
    try { console.log('[project] 新建项目 ' + n + ' @ ' + root); } catch (e) {}
    return { ok: true, name: n, path: dir };
  }
  // 项目改名：改目录名 + 迁移一切以「项目名」为键的设置/缓存（否则设置会凭空丢失）
  renameProject(oldName, newName, kind) {
    const k = (kind === 'mask') ? 'mask' : 'batch';
    const root = this._projectRootOf(k);
    if (!root) return { ok: false, error: (k === 'mask' ? '尚未设置遮罩工作路径' : '尚未设置工作路径') };
    const oldN = String(oldName == null ? '' : oldName).trim();
    const newN = String(newName == null ? '' : newName).trim();
    if (!oldN) return { ok: false, error: '原项目名缺失' };
    if (oldN === newN) return { ok: true, name: newN, unchanged: true };
    const bad = this._validProjectName(newN);
    if (bad) return { ok: false, error: bad };
    const oldDir = path.join(root, oldN);
    const newDir = path.join(root, newN);
    const rel = path.relative(root, newDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '名称非法' };
    let oldOk = false, newExists = false;
    try { oldOk = fs.existsSync(oldDir); } catch (e) { oldOk = false; }
    if (!oldOk) return { ok: false, error: '原项目目录不存在（可能已被外部删除）' };
    try { newExists = fs.existsSync(newDir); } catch (e) { newExists = false; }
    if (newExists) return { ok: false, error: '同名项目已存在' };
    // 有任务在跑/排队时拒绝改目录名：任务持有路径，改完会写错位置
    try {
      const busy = [...(this.tasks || new Map()).values()]
        .filter((t) => t && (t.status === 'running' || t.status === 'queued' || t.status === 'paused'));
      if (busy.length) return { ok: false, error: '有任务正在运行或排队，请等结束后再改名' };
    } catch (e) {}
    try { fs.renameSync(oldDir, newDir); }
    catch (e) { return { ok: false, error: '重命名目录失败：' + ((e && e.message) || e) }; }
    // ① 设置键迁移
    try {
      if (k === 'batch') {
        const oldKey = root + '\u0000' + oldN;
        const newKey = root + '\u0000' + newN;
        if (this._useSettings()) {
          const all = this._settingsStore.all('batch');
          this._settingsStore.transaction(() => {
            for (const kind2 of ['watermarks', 'enabled', 'groupCounts', 'groupEnabled']) {
              const src = all[kind2];
              if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
              if (!Object.prototype.hasOwnProperty.call(src, oldKey)) continue;
              const obj = Object.assign({}, src);
              obj[newKey] = obj[oldKey];
              delete obj[oldKey];
              this._settingsStore.set('batch', kind2, obj);
            }
          });
        }
      } else if (this._useSettings()) {
        const cur = String(this._settingsStore.get('mask', oldN, '') || '');
        if (cur) {
          this._settingsStore.set('mask', newN, cur);
          this._settingsStore.remove('mask', oldN);
        }
      }
    } catch (e) {}
    // ② 遮罩会话缓存键（cache_kv: mask_session:<项目名>）
    if (k === 'mask' && this._useDbCache()) {
      try {
        const raw = this._cacheStore.getKv('mask_session:' + oldN);
        if (raw) {
          this._cacheStore.setKv('mask_session:' + newN, raw);
          this._cacheStore.removeKv('mask_session:' + oldN);
        }
      } catch (e) {}
    }
    // ③ 项目登记表：把登记项从旧名换成新名（新建后改名的情况）
    try {
      const reg = this._loadProjReg(root, k);
      if (reg.includes(oldN)) this._saveProjReg(root, k, reg.map((x) => (x === oldN ? newN : x)));
    } catch (e) {}
    // ④ 项目设置的内存缓存按 root 一次性重载（键已变，简单可靠）
    try {
      this._wmCacheLoadedRoot = null;
      this._loadWatermarkCache();
    } catch (e) {}
    this._invalidateCaches();   // 列表/版本/日志缓存全部作废 → 前端刷新即见新名
    try { console.log('[project] 改名 ' + oldN + ' → ' + newN + ' @ ' + root); } catch (e) {}
    return { ok: true, name: newN, oldName: oldN, path: newDir };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 视频处理工具（第 4 个模块）
  //
  // 与三个成片模块同构：建任务 → 入同一队列 → 引擎子进程（module=tool）
  // 参数经 TOOL_SPEC（JSON）传入；步骤清单与参数 schema 由引擎侧注册表提供，
  // 前端据此**自动渲染表单**（加能力 = 加一个步骤文件，前端不用改）
  // ══════════════════════════════════════════════════════════════════════
  // ── 画布合成（竖转横）：单帧预览 / 背景候选 / 参数预设 ────────────────────────
  // 预览与批量执行共用 engines/tools/canvas-plan.js 的 buildCanvasPlan()：参数同源、表达式同源，
  // 「预览所见即所得」由结构保证。预览帧输出 PNG（软件编码），不占用编码硬件的会话，
  // 因此不会与正在运行的批量任务互斥；产物落 <数据目录>\preview\（扫描阶段已排除该目录）。
  _toolSteps() {
    try { return require(path.join(this.enginesDir, 'tools', 'index.js')); } catch (e) { return null; }
  }

  /**
   * 画布合成的**方案构造模块**（纯逻辑：参数模型 + buildCanvasPlan）——
   * 与引擎侧执行器 engines/tools/canvas-run.js 分开：主进程只该拿到这份纯逻辑（无 IO / 无子进程），
   * 预览与批量执行共用同一份表达式构造，"预览所见即所得"由结构保证。
   */
  _canvasModule() {
    try { return require(path.join(this.enginesDir, 'tools', 'canvas-plan.js')); } catch (e) { return null; }
  }

  /** 素材尺寸探测（路径 + 大小/mtime 作指纹，结果驻留内存避免反复起进程） */
  _canvasProbeSize(file) {
    return new Promise((resolve) => {
      const p = String(file || '');
      if (!p) return resolve(null);
      let stamp = '';
      try { const st = fs.statSync(p); stamp = st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return resolve(null); }
      if (!this._canvasSizeCache) this._canvasSizeCache = new Map();
      const hit = this._canvasSizeCache.get(p);
      if (hit && hit.stamp === stamp) return resolve(hit);
      const ffprobe = this._resolveFfmpegBin().ffprobePath;
      if (!ffprobe) return resolve(null);
      try {
        const { execFile } = require('child_process');
        execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', p],
        { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve(null);
          let w = 0, h = 0, dur = 0;
          try {
            const j = JSON.parse(String(stdout || '{}'));
            const s = (j.streams || [])[0] || {};
            w = Number(s.width) || 0; h = Number(s.height) || 0;
            dur = Number((j.format || {}).duration) || 0;
          } catch (e2) {}
          const info = { path: p, width: w, height: h, duration: dur, stamp: stamp };
          this._canvasSizeCache.set(p, info);
          resolve(info);
        });
      } catch (e) { resolve(null); }
    });
  }

  /**
   * 背景候选枚举：扫描目录（两层内）。**不再限制背景尺寸** —— 适配方式（填充 / 适应 / 拉伸）能处理任意尺寸，
   * 尺寸只用于界面展示与「小于画布会被放大」的提醒（既然尺寸可调，背景就不该锁尺寸）。
   * 返回稳定排序（按路径）的清单，保证「同索引 = 同背景」，前端上一个/下一个切换才有确定性。
   */
  async canvasListBackgrounds(dir) {
    const envG = this._envGuard('canvas_bg_list');
    if (envG) return envG;
    const root = String(dir || '').trim();
    if (!root) return { ok: false, error: '请先选择背景目录' };
    let isDir = false;
    try { isDir = fs.statSync(root).isDirectory(); } catch (e) {}
    if (!isDir) return { ok: false, error: '背景目录不存在：' + root };
    // 结果缓存：预览路径每次都会列背景候选（拖动/调参高频调用），而目录遍历 + 500 次 stat 属纯浪费。
    // 指纹 = 目录 mtime + 根目录条目数（新增/删除文件会变，命中即复用），并留 30s 兜底上限。
    if (!this._bgListCache) this._bgListCache = new Map();
    let bgStamp = '';
    try {
      const st = fs.statSync(root);
      let n = 0;
      try { n = fs.readdirSync(root).length; } catch (e) {}
      bgStamp = Math.round(st.mtimeMs) + ':' + n;
    } catch (e) {}
    const bgHit = this._bgListCache.get(root);
    if (bgStamp && bgHit && bgHit.stamp === bgStamp && (Date.now() - bgHit.at) < 30000) return bgHit.result;
    const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.mp4', '.mov', '.mkv', '.avi']);
    const files = [];
    const walk = (d, depth) => {
      if (files.length >= 500 || depth > 2) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p2 = path.join(d, e.name);
        if (e.isDirectory()) { walk(p2, depth + 1); continue; }
        if (exts.has(path.extname(e.name).toLowerCase())) files.push(p2);
      }
    };
    walk(root, 0);
    const infos = await this._runWithLimit(files, (f) => this._canvasProbeSize(f), Math.min(4, this.probeConcurrency || 4), null);
    const list = (infos || []).filter((x) => x && x.width > 0 && x.height > 0)   // 探测失败的剔除（无法参与合成）
      .map((x) => ({
        path: x.path, name: path.basename(x.path),
        kind: /\.(mp4|mov|mkv|avi)$/i.test(x.path) ? 'video' : 'image',
        width: x.width || 0, height: x.height || 0,   // 供界面显示与「小于画布会被放大」提醒
        duration: x.duration || 0,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const result = { ok: true, dir: root, scanned: files.length, matched: list.length, list: list };
    if (bgStamp) this._bgListCache.set(root, { at: Date.now(), stamp: bgStamp, result: result });
    return result;
  }

  /**
   * 预览样本清单：文件夹输入时枚举待处理视频，供预览挑一个样本。
   * 复用引擎的 scanVideos —— 与正式处理**同一套扫描规则**（递归开关、跳过应用自管目录），
   * 否则会出现「预览看到的清单 ≠ 真正会被处理的文件」（如把输出/备份目录里的成片也当样本）。
   * 只返回路径与文件名；尺寸/时长由 canvasPreviewFrame 探测并缓存，此处不做探测（避免为预览全量起进程）。
   */
  canvasListSources(root, recursive) {
    const envG = this._envGuard('canvas_src_list');
    if (envG) return envG;
    const r = String(root || '').trim();
    if (!r) return { ok: false, error: '请先选择要处理的文件夹' };
    let isDir = false;
    try { isDir = fs.statSync(r).isDirectory(); } catch (e) {}
    if (!isDir) return { ok: false, error: '文件夹不存在：' + r };
    let pl = null;
    try { pl = require(path.join(this.enginesDir, 'tools', 'pipeline.js')); } catch (e) {}
    if (!pl || typeof pl.scanVideos !== 'function') return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验' };
    let files = [];
    try {
      files = pl.scanVideos(r, { recursive: recursive !== false, storageDir: this.storageDir }) || [];
    } catch (e) { return { ok: false, error: '扫描失败：' + ((e && e.message) || e) }; }
    files = files.slice().sort((a, b) => String(a).localeCompare(String(b)));
    const total = files.length;
    const cap = 800;   // 样本切换只需清单，不必把上万条路径全传到界面
    const list = files.slice(0, cap).map((f) => ({ path: f, name: path.basename(f) }));
    return { ok: true, root: r, total: total, truncated: total > cap, limit: cap, list: list };
  }

  /** 素材指纹（大小 + mtime）：素材被替换但路径不变时，必须让预览缓存失效 */
  _canvasStamp(file) {
    try { const st = fs.statSync(String(file || '')); return st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return '-'; }
  }

  /** 预览图缓存键：参数 + 表达式 + 时间点 + 素材指纹，任一项变化即重新渲染 */
  _canvasPreviewKey(plan, at, src, scale) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha1');
    h.update(JSON.stringify(plan.meta || {}));
    h.update('|' + plan.filterComplex);
    h.update('|' + String(Math.round((Number(at) || 0) * 1000)));
    h.update('|' + String(scale));
    h.update('|' + [src.contentPath, src.bgPath, src.watermarkPath].join('\u0001'));
    h.update('|' + [this._canvasStamp(src.contentPath), this._canvasStamp(src.bgPath), this._canvasStamp(src.watermarkPath)].join('\u0001'));
    return h.digest('hex');
  }

  /** 预览磁盘产物的最旧淘汰（超出上限时按 mtime 删除，避免长期堆积） */
  _canvasPreviewTrimAsync(outDir, keep) {
    fs.promises.readdir(outDir).then((names) => {
      const list = names.filter((n) => /^canvas-.*\.png$/.test(n));
      if (list.length <= keep) return null;
      const withTime = list.map((n) => {
        const f = path.join(outDir, n);
        try { return { f: f, t: fs.statSync(f).mtimeMs }; } catch (e) { return { f: f, t: 0 }; }
      }).sort((a, b) => a.t - b.t);
      const drop = withTime.slice(0, withTime.length - keep);
      return Promise.all(drop.map((x) => fs.promises.unlink(x.f).catch(() => null)));
    }).catch(() => null);
  }

  /**
   * 单帧预览：一次 ffmpeg 调用同时产出三张 PNG（合成图 / 纯背景层 / 内容原帧），
   * 供前端「底图 + 前景」分层拖动；返回值同时带内存/磁盘缓存与几何元数据。
   */
  async canvasPreviewFrame(payload) {
    const p = payload || {};
    const mod = this._canvasModule();
    if (!mod) return { ok: false, error: '程序文件不完整（缺少画布合成组件），请重新安装或校验程序文件' };
    const envG = this._envGuard('canvas_preview');
    if (envG) return envG;
    const contentPath = String(p.contentPath || '').trim();
    let contentOk = false;
    try { contentOk = fs.statSync(contentPath).isFile(); } catch (e) {}
    if (!contentOk) return { ok: false, error: '请先选择要预览的视频文件' };
    const ffmpeg = this._resolveFfmpegBin().ffmpegPath;
    if (!ffmpeg) return { ok: false, error: 'FFmpeg 不可用，请重新下载组件' };

    const params = Object.assign({}, p.params || {});
    // 背景解析（目录模式按索引取候选，索引归一化到候选范围内）
    let bgPath = String(p.bgPath || params.bgPath || '').trim();
    let bgTotal = 0, bgIndexUsed = 0, bgKind = '';
    let bgW = 0, bgH = 0;                 // 背景尺寸（供「小于画布会被放大」提醒；探测失败则为 0）
    if (params.bgMode === 'dir') {
      const lst = await this.canvasListBackgrounds(params.bgDir);
      if (!lst.ok) return lst;
      if (!lst.list.length) return { ok: false, error: '背景目录里没有可用的图片或视频（已扫描 ' + lst.scanned + ' 个文件）' };
      bgTotal = lst.list.length;
      bgIndexUsed = ((Math.trunc(Number(p.bgIndex) || 0) % bgTotal) + bgTotal) % bgTotal;
      bgPath = lst.list[bgIndexUsed].path;
      bgKind = lst.list[bgIndexUsed].kind;
      bgW = Number(lst.list[bgIndexUsed].width) || 0;
      bgH = Number(lst.list[bgIndexUsed].height) || 0;
    } else if (params.bgMode === 'image' || params.bgMode === 'video') {
      let ok = false;
      try { ok = fs.statSync(bgPath).isFile(); } catch (e) {}
      if (!ok) return { ok: false, error: '背景文件不存在' };
      bgKind = /\.(mp4|mov|mkv|avi)$/i.test(bgPath) ? 'video' : 'image';
      const bInfo = await this._canvasProbeSize(bgPath);   // 指定文件模式现测一次尺寸（用于放大提醒）
      if (bInfo) { bgW = Number(bInfo.width) || 0; bgH = Number(bInfo.height) || 0; }
    }

    // 素材尺寸（内容必测；背景与水印可选）
    const cInfo = await this._canvasProbeSize(contentPath);
    if (!cInfo || !cInfo.width || !cInfo.height) return { ok: false, error: '无法读取视频尺寸（ffprobe 未返回有效信息）' };
    let wmPath = String(p.watermarkPath || params.watermark || '').trim();
    let wmOk = false;
    try { wmOk = fs.statSync(wmPath).isFile(); } catch (e) { wmOk = false; }
    const src = {
      contentW: cInfo.width, contentH: cInfo.height, contentPath: contentPath,
      bgPath: bgPath, bgKind: bgKind, watermarkPath: wmOk ? wmPath : '',
      bgColorValue: params.bgColor,
      duration: cInfo.duration || 0,
      bgW: bgW, bgH: bgH,              // 背景尺寸 → 小于画布时给出「会被放大（可能模糊）」提醒
    };
    if (wmPath && !wmOk) src._wmMissing = true;

    const at = Math.max(0, Number(p.at) || 0);
    if (cInfo.duration > 0 && at >= cInfo.duration) {
      return { ok: false, error: '时间点超出视频时长（' + cInfo.duration.toFixed(1) + 's）', duration: cInfo.duration };
    }

    const plan = mod.buildCanvasPlan(params, src);
    if (src._wmMissing) plan.meta.warnings.push('水印文件不存在，本次预览未叠加水印');

    const scale = (() => {
      const v = Number(p.previewScale);
      if (!isFinite(v) || v <= 0) return 0.5;
      return Math.min(1, Math.max(0.25, v));
    })();
    const key = this._canvasPreviewKey(plan, at, src, scale);

    if (!this._canvasPreviewCache) this._canvasPreviewCache = new Map();
    const cached = this._canvasPreviewCache.get(key);
    if (cached) return Object.assign({ ok: true, fromCache: true, ms: 0 }, cached);

    // 并发上限定为 2：拖动过程中旧请求尚未结束时，前端会收到 BUSY 并稍后用最新参数重试
    if ((this._canvasPreviewRunning || 0) >= 2) return { ok: false, error: 'BUSY' };
    this._canvasPreviewRunning = (this._canvasPreviewRunning || 0) + 1;
    const startedAt = Date.now();
    let previewFiles = [];   // A4：本轮生成的 PNG，finally 统一删除（成功与失败都不留残留）
    try {
      const outDir = path.join(this.storageDir || '', 'preview');
      await fs.promises.mkdir(outDir, { recursive: true });
      const stamp = key.slice(0, 12);
      const outC = path.join(outDir, 'canvas-' + stamp + '-composed.png');
      const outB = path.join(outDir, 'canvas-' + stamp + '-bg.png');
      const outR = path.join(outDir, 'canvas-' + stamp + '-raw.png');
      const pvW = Math.max(2, Math.round(plan.meta.canvasW * scale / 2) * 2);
      const pvH = Math.max(2, Math.round(plan.meta.canvasH * scale / 2) * 2);
      const rawW = Math.max(2, Math.round(plan.meta.contentBox.w * scale / 2) * 2);
      const args = ['-hide_banner', '-loglevel', 'error', '-y'];
      for (let i = 0; i < plan.ffmpegInputs.length; i++) {
        const inp = plan.ffmpegInputs[i];
        // -ss 只作用于紧随其后的输入：内容与背景视频取同一时间点（图片背景不受影响）
        if (i === 0 || /\.(mp4|mov|mkv|avi)$/i.test(String(inp.path || ''))) args.push('-ss', String(at));
        for (const a of (inp.args || [])) args.push(a);
        args.push('-i', inp.lavfi || inp.path);
      }
      args.push('-filter_complex', plan.filterComplex);
      // 预览缩放用输出尺寸选项（-s）：输出流已由 filter_complex 提供，不能再挂 -vf（简单/复杂滤镜不可同时作用于同一流）
      const rawH = Math.max(2, Math.round(rawW * (plan.meta.contentBox.h / Math.max(1, plan.meta.contentBox.w)) / 2) * 2);
      args.push('-map', plan.maps.composed, '-frames:v', '1', '-s', pvW + 'x' + pvH, '-c:v', 'png', outC);
      args.push('-map', plan.maps.bg, '-frames:v', '1', '-s', pvW + 'x' + pvH, '-c:v', 'png', outB);
      args.push('-map', plan.maps.raw, '-frames:v', '1', '-s', rawW + 'x' + rawH, '-c:v', 'png', outR);

      const { execFile } = require('child_process');
      await new Promise((resolve, reject) => {
        execFile(ffmpeg, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            const tail = String(stderr || err.message || '').split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 300);
            return reject(new Error(tail || 'ffmpeg 执行失败'));
          }
          resolve();
        });
      });

      const toData = (f) => {
        try { return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'); } catch (e) { return ''; }
      };
      // 三张 PNG 是「生成 base64 的中间产物」，不是需要留存的缓存 ——
      // 前端拿 base64 渲染（tool.js 用它赋 img.src），从不读文件路径（原 files 字段前端零使用）；
      // 唯一的“缓存”是下方内存 Map（重启即空、存的是 base64 而非路径）。
      // 故**读完即删**（finally 统一清理，成功与失败路径都不留残留），目录永不增长。
      // 同参数再次请求会命中内存缓存、不重跑 ffmpeg；缓存被淘汰则重跑并再次即删。
      previewFiles = [outC, outB, outR];
      const result = {
        composed: toData(outC),
        bgOnly: toData(outB),
        raw: toData(outR),
        previewScale: scale,
        previewW: pvW, previewH: pvH,
        meta: Object.assign({}, plan.meta, {
          at: at, duration: cInfo.duration || 0,
          bgTotal: bgTotal, bgIndex: bgIndexUsed,
          bgPath: plan.meta.bgModeUsed === 'color' ? '' : bgPath,
          ms: Date.now() - startedAt, fromCache: false,
        }),
      };
      // 内存缓存（上限 60 组，Map 保持插入序 → 淘汰最旧）
      this._canvasPreviewCache.set(key, result);
      if (this._canvasPreviewCache.size > 60) {
        const first = this._canvasPreviewCache.keys().next();
        if (!first.done) this._canvasPreviewCache.delete(first.value);
      }
      // 磁盘兜底：新产物已即删，此目录**不应有任何文件**，故上限取 0 ——
      // 既清掉旧版本遗留的 canvas-*.png（本机曾达 150 个 / 74 MB），清空后也无需再管（开销可忽略）。
      this._canvasPreviewTrimAsync(outDir, 0);
      // ⚠ verb 用 RUN（info）：VERB_LVL 把 UI 映射为 error 级，而预览是**正常**操作 ——
      //   用 UI 会让每次预览都进 error 日志与 30 天 error 索引
      this._lg('RUN', 'canvas.preview', '画布合成预览 · ' + pvW + '×' + pvH + ' · ' + (Date.now() - startedAt) + 'ms'
        + ' · 内容盒 ' + result.meta.contentBox.w + '×' + result.meta.contentBox.h
        + ' @' + result.meta.contentBox.x + ',' + result.meta.contentBox.y
        + (result.meta.warnings.length ? ' · ' + result.meta.warnings.join('；') : ''),
      { at: at, bgIndex: bgIndexUsed, bgTotal: bgTotal, warnings: result.meta.warnings.length });
      return Object.assign({ ok: true, fromCache: false, ms: result.meta.ms }, result);
    } catch (e) {
      const msg = String((e && e.message) || e);
      this._lg('ERR', 'canvas.preview', '画布合成预览失败 · ' + msg, { at: at });
      return { ok: false, error: '预览渲染失败：' + msg };
    } finally {
      this._canvasPreviewRunning = Math.max(0, (this._canvasPreviewRunning || 1) - 1);
      // 读完 base64 即删（成功与失败路径都不留残留；文件不存在/已被清也无妨）
      for (const previewFile of previewFiles) { try { fs.unlinkSync(previewFile); } catch (e) { /* 忽略 */ } }
    }
  }

  /** 画布参数预设：存设置库 app scope（键 canvas_presets，JSON） */
  canvasPresetList() {
    try {
      const raw = String(this.getAppSetting('canvas_presets', '') || '');
      const obj = raw ? JSON.parse(raw) : {};
      const list = Object.keys(obj).map((k) => ({ name: k, params: obj[k] }));
      return { ok: true, list: list };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  canvasPresetSave(name, params) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return { ok: false, error: '预设名称不能为空' };
    if (!this._useSettings() || !this._settingsStore) return { ok: false, error: '设置库不可用，无法保存预设' };
    try {
      const cur = this.canvasPresetList();
      const obj = {};
      (cur.list || []).forEach((x) => { obj[x.name] = x.params; });
      if (!obj[n] && Object.keys(obj).length >= 50) return { ok: false, error: '预设数量已达上限（50）' };
      obj[n] = params || {};
      this._settingsStore.set('app', 'canvas_presets', JSON.stringify(obj));
      this._lg('CFG', 'canvas.preset', '画布合成参数预设 · 保存 ' + n, { name: n });
      return { ok: true, name: n, total: Object.keys(obj).length };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  canvasPresetDelete(name) {
    const n = String(name || '').trim();
    if (!n) return { ok: false, error: '预设名称不能为空' };
    if (!this._useSettings() || !this._settingsStore) return { ok: false, error: '设置库不可用，无法删除预设' };
    try {
      const cur = this.canvasPresetList();
      const obj = {};
      (cur.list || []).forEach((x) => { if (x.name !== n) obj[x.name] = x.params; });
      this._settingsStore.set('app', 'canvas_presets', JSON.stringify(obj));
      this._lg('CFG', 'canvas.preset', '画布合成参数预设 · 删除 ' + n, { name: n });
      return { ok: true, name: n, total: Object.keys(obj).length };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  /** 步骤清单 + 参数 schema + 输出策略可选项（供前端渲染表单） */
  listTools() {
    const mod = this._toolSteps();
    if (!mod) return { ok: false, error: '程序文件不完整（缺少处理组件），请重新安装或校验程序文件' };
    const steps = mod.stepSchema ? mod.stepSchema() : [];
    return {
      ok: true,
      steps,
      groups: mod.stepSchemaByGroup ? mod.stepSchemaByGroup() : [],
      stepCount: steps.length,
      engine: !!this._engineRunnerPath(),
      root: this.root || '',
      output: {
        modes: [{ v: 'overwrite', t: '覆盖原视频' }, { v: 'directory', t: '输出到指定目录' }],
        nameModes: [{ v: 'keep', t: '原名' }, { v: 'suffix', t: '原名 + 后缀' }],
        conflicts: [{ v: 'index', t: '追加序号' }, { v: 'overwrite', t: '覆盖' }, { v: 'skip', t: '跳过' }],
        // 实际默认备份地址：设置里的默认备份目录 > 数据目录下 backup。
        // 返回前确保存在（应用自己管理的目录，可直接创建）—— 浏览器端「打开/选择」才能直接定位
        defaultBackupDir: (() => {
          const customRoot = String(this.config.backup_dir || '').trim();
          const root = customRoot ? path.join(customRoot, 'Video Lab 备份')
            : path.join(this.storageDir || '', 'backup');
          try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
          return root;
        })(),
      },
    };
  }

  /**
   * 浏览器端的目录浏览：列出某目录下的子目录与文件名。
   * 供工具窗口的 Web 路径选择器使用 —— 浏览器侧没有本机文件对话框，
   * 系统对话框又依赖本体窗口的前台状态（焦点在浏览器时会被压在后面）。
   * 只读目录名与文件名，不读文件内容。
   */
  listDir(dir) {
    const target = String(dir || '').trim() ? path.resolve(String(dir).trim()) : path.resolve(this.root || '');
    if (!target) return { ok: false, error: '缺少路径' };
    let st = null;
    try { st = fs.statSync(target); } catch (e) { return { ok: false, error: '路径不存在：' + target }; }
    if (!st.isDirectory()) return { ok: false, error: '不是目录：' + target };
    const dirs = [], files = [];
    try {
      for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirs.push(e.name);
        else if (e.isFile()) files.push(e.name);
      }
    } catch (e) {
      return { ok: false, error: '无法读取目录：' + ((e && e.message) || e) };
    }
    const zh = (a, b) => a.localeCompare(b, 'zh-Hans-CN');
    const up = path.dirname(target);
    return {
      ok: true,
      path: target,
      parent: up === target ? '' : up,      // 盘符根没有上级
      dirs: dirs.sort(zh),
      files: files.sort(zh).slice(0, 200),  // 只读名字辅助定位，大目录截断
    };
  }

  /**
   * 创建工具任务。两种模式**各自独立、互不干扰**（参数与输出都只对自己负责）：
   *   · steps（默认）—— 后处理：步骤链，参数 `params[stepId]`
   *   · canvas       —— 画布合成（竖转横批量）：独立执行器，参数 `params.canvas`
   * 两者共享任务队列（type:'tool' 串行不抢 GPU）与输出策略实现，但**互不读取对方的参数**。
   * @param {{mode?:'steps'|'canvas', root?:string, recursive?:boolean, files?:string[], stepIds?:string[],
   *   params?:Object, output?:Object}} spec
   * @returns {{ok:boolean, taskId?:string, error?:string}}
   */
  runTool(spec) {
    const envG = this._envGuard('run_tool');
    if (envG) return envG;
    if (!this.shouldUseNodeEngine('tool')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const mod = this._toolSteps();
    if (!mod) return { ok: false, error: '程序文件不完整（缺少处理组件），请重新安装或校验程序文件' };
    const s = spec || {};
    const isCanvas = String(s.mode || 'steps') === 'canvas';

    // ① 步骤：仅后处理需要（画布合成自带一套参数，不走步骤清单）
    let stepIds = [];
    if (!isCanvas) {
      const raw = Array.isArray(s.stepIds) ? s.stepIds.map(String).filter(Boolean) : [];
      const unknown = raw.filter((id) => !mod.getStep(id));
      if (unknown.length) return { ok: false, error: '未知的处理步骤：' + unknown.join('、') };
      stepIds = mod.listSteps().map((x) => x.id).filter((id) => raw.indexOf(id) >= 0);  // 固定位次
      if (!stepIds.length) return { ok: false, error: '请至少勾选一个处理步骤' };
    }

    // ② 输入：显式文件清单优先，否则扫描目录
    const files = (Array.isArray(s.files) ? s.files : [])
      .map(String)
      .filter((p) => { try { return p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; } });
    const root = String(s.root || '').trim();
    let rootOk = false;
    try { rootOk = !!root && fs.existsSync(root) && fs.statSync(root).isDirectory(); } catch (e) { rootOk = false; }
    if (!files.length && !rootOk) return { ok: false, error: '请选择要处理的目录或视频文件' };

    // ③ 输出策略
    const out = s.output || {};
    const mode = out.mode === 'directory' ? 'directory' : 'overwrite';
    const dir = String(out.dir || '').trim();
    if (mode === 'directory' && !dir) return { ok: false, error: '请选择输出目录' };
    if (mode === 'directory' && rootOk && path.resolve(dir) === path.resolve(root)) {
      // 允许（outplan 会自动新建子目录，不会静默覆盖），仅此处不做拦截
    }
    const output = {
      mode,
      dir: mode === 'directory' ? path.resolve(dir) : '',
      nameMode: out.nameMode === 'suffix' ? 'suffix' : 'keep',
      suffix: String(out.suffix == null ? '_处理' : out.suffix),
      onConflict: ['overwrite', 'skip'].indexOf(out.onConflict) >= 0 ? out.onConflict : 'index',
      backup: out.backup === true,
      backupDir: String(out.backupDir || '').trim() ? path.resolve(String(out.backupDir).trim()) : '',
      // 设置里的「默认备份目录」：任务未单独指定备份目录时，引擎用它作为备份根
      defaultBackupDir: String(this.config.backup_dir || '').trim() ? path.resolve(String(this.config.backup_dir).trim()) : '',
    };

    // ④ 建任务（env 传参，与三个成片模块同一机制）
    const scope = files.length ? (files.length + ' 个文件') : path.basename(root);
    const toolName = isCanvas ? '画布合成' : '视频处理';
    const title = isCanvas
      ? ('画布合成 · ' + scope)
      : ('视频处理 · ' + stepIds.map((id) => (mod.getStep(id) || {}).title || id).join(' + ') + ' · ' + scope);
    const toolSpec = isCanvas
      ? {
        mode: 'canvas',
        params: { canvas: (s.params && s.params.canvas) || {} },
        root, recursive: s.recursive !== false, files, output, toolName,
      }
      : { stepIds, params: s.params || {}, root, recursive: s.recursive !== false, files, output, toolName };
    const env = {
      TOOL_SPEC: JSON.stringify(toolSpec),
      VL_STORAGE_DIR: this.storageDir || '',
    };
    const task = this._createTask('tool', title, env, files.length ? files[0] : root);
    task.progress.total = files.length || 0;
    this._enqueueTask(task);
    this._lg('RUN', 'tool.start', toolName + '任务 · ' + title, { id: task.id, mode: isCanvas ? 'canvas' : 'steps', stepIds, files: files.length, output });
    return { ok: true, taskId: task.id };
  }

  /**
   * 工具任务「重新执行」：按同样参数重跑一遍 —— **不删除任何文件**。
   * 与 rerunTask 的本质区别：工具任务的产物就是被覆盖的源视频，没有第二份副本，
   * 任何"先删旧产物"的动作都可能删掉唯一的那份视频。
   */
  rerunToolTask(id) {
    const envG = this._envGuard('rerun_tool');
    if (envG) return envG;
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.type !== 'tool') return { ok: false, error: '该任务不是视频处理任务' };
    if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') {
      return { ok: false, error: '进行中的任务不能重新执行' };
    }
    const marker = this._loadMarker(t);
    const env = Object.assign({}, (marker && marker.env) || t.env || {});
    if (!env.TOOL_SPEC) return { ok: false, error: '原任务缺少处理参数，无法重新执行' };
    const nt = this._createTask('tool', String(t.title || '视频处理'), env, '');
    nt.progress.total = (t.progress && t.progress.total) || 0;
    this._enqueueTask(nt);
    this._lg('RUN', 'tool.rerun', '视频处理 · 重新执行（不删除任何文件）· ' + String(t.title || '').slice(0, 50),
      { from: id, to: nt.id });
    return { ok: true, taskId: nt.id };
  }

  runBatch(filePath, count, group) {
    const envG = this._envGuard('run_batch');
    if (envG) return envG;
    if (!this.shouldUseNodeEngine('batch')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const notSet = this._settingsError('batch');
    if (notSet.length) return { ok: false, error: '批量拼接参数未设置：' + notSet.join('、') + '，请到 设置-批量拼接 中配置后再启动' };
    const b = this.config.batch || {};
    const env = Object.assign({ REPLICA_TXT: path.resolve(filePath) }, this._cacheEnvBase());
    Object.assign(env, {
      BATCH_MAX_DURATION: String(b.max_duration),
      BATCH_MAX_RETRY: String(b.max_retry),
      BATCH_SPEED_LIMIT: String(b.speed_limit),
      BATCH_TXT_PREFIX: (Array.isArray(b.txt_prefix) ? b.txt_prefix : String(b.txt_prefix == null ? '' : b.txt_prefix)).map(String).filter((x) => String(x).trim() !== '').join(';'),
      BATCH_PRODUCER: String(b.producer).trim(),
      BATCH_SUFFIX_MARK: String(b.suffix_mark == null ? '' : b.suffix_mark).trim(),
    });
    const countStr = String(count).trim();
    if (/^\d+$/.test(countStr) && parseInt(countStr, 10) > 0) env.BATCH_COUNT = countStr;
    const groupStr = String(group).trim();
    env.BATCH_GROUP = /^\d+$/.test(groupStr) && parseInt(groupStr, 10) > 0 ? groupStr : '0';
    // 任务提交时刻：排队跨天运行时，成片命名/日志/输出目录按提交日期而非运行日期
    env.BATCH_SUBMIT_TS = String(Date.now());
    env.REPLICA_NO_WAIT = '1';
    const task = this._enqueueTask(this._createTask('batch', this._taskTitle(filePath), env, filePath));
    // 排队即预填预计成片数/分组数（配置底部输入），运行后由输出解析覆写 total
    const preTotal = parseInt(String(count), 10) || 0;
    const preGroup = parseInt(String(group), 10) || 0;
    if (preTotal > 0) task.progress.total = preTotal;
    if (preGroup > 0) task.progress.groupCount = preGroup;
    return { ok: true, taskId: task.id };
  }

  runReplica(logPath, mode = 1, entryVideo, opts) {
    const envG = this._envGuard('run_replica');
    if (envG) return envG;
    if (!this.shouldUseNodeEngine('replica')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const notSet = this._settingsError('replica');
    if (notSet.length) return { ok: false, error: '视频复刻参数未设置：' + notSet.join('、') + '，请到 设置-视频复刻 中配置后再启动' };
    const r = this.config.replica || {};
    // 全局参数（成片时长上限 / 加速阈值 / 每档轮数）与批量拼接共用同一套 —— 复刻不再单独设置
    const b = this.config.batch || {};
    const o = opts || {};
    const num = (v, dft) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : dft; };
    const boolOn = (v, dft) => (v === undefined || v === null) ? (dft !== false) : (v === true);
    const env = Object.assign({
      REPLICA_TXT: path.resolve(logPath),
      REPLICA_MODE: String(mode) === '2' ? '2' : '1',
      REPLICA_NO_WAIT: '1',
      // 全局参数（与批量拼接共用同一套，复刻不单独设置）：成片时长上限 / 加速阈值 / 每档轮数
      BATCH_MAX_DURATION: String(b.max_duration),
      BATCH_SPEED_LIMIT: String(b.speed_limit),
      BATCH_MAX_RETRY: String(b.max_retry),
      // 重复度区间：本次任务弹窗传入优先，未传则用设置里的默认值与默认启用状态
      // （下限=至少替换到的占比；上限=尽量避免超过，超过会被平台判为全新视频）
      REPLICA_DEDUP_RATIO: String(num(o.dedupRatio, r.dedup_ratio)),
      REPLICA_DEDUP_MIN: String(num(o.dedupRatio, r.dedup_ratio)),
      REPLICA_DEDUP_MAX: String(num(o.dedupRatioMax, r.dedup_ratio_max)),
      REPLICA_DEDUP_MIN_ON: boolOn(o.dedupRatioOn, r.dedup_ratio_on) ? '1' : '0',
      REPLICA_DEDUP_MAX_ON: boolOn(o.dedupRatioMaxOn, r.dedup_ratio_max_on) ? '1' : '0',
    }, this._cacheEnvBase());
    // 任务提交时刻：排队跨天运行时，复刻命名/日志/输出目录按提交日期而非运行日期
    env.REPLICA_SUBMIT_TS = String(Date.now());
    // 仅复刻日志中的单个指定成片（右侧「复刻」按钮/批量选择传入成片名）
    if (entryVideo) env.REPLICA_ONLY_NAME = String(entryVideo).trim();
    const modeLabel = String(mode) === '2' ? '去重' : '原片';
    const task = this._enqueueTask(this._createTask('replica', this._replicaTaskTitle(logPath, modeLabel), env, logPath));
    return { ok: true, taskId: task.id };
  }

  // 断点续跑：失败/中断/停止的复刻任务，仅续跑失败/未完成的成片，不删除已成功产物。
  // 从 failedVideos 或日志中提取失败成片名，构造 REPLICA_ONLY_NAMES 新任务。
  async continueReplica(id, opts) {
    const envG = this._envGuard('continue_task');
    if (envG) return envG;
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    const softPaused = t._softPaused === true && t.status === 'paused';
    if (!softPaused && t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') {
      return { ok: false, error: '仅失败/中断/停止的任务可继续制作' };
    }
    // 续跑入口（replica / batch 共用；mask 走 continueMask）：
    // batch 的成片名含日期前缀、输出目录含提交时刻，故续跑必须复用原环境变量（尤其 BATCH_SUBMIT_TS），
    // 否则续跑产物会落到新日期目录、名字前缀也变，无法与首次归为同一批
    if (t.type !== 'replica' && t.type !== 'batch') return { ok: false, error: '仅复刻/批量任务支持继续制作' };
    // 收集失败成片名：优先 failedVideos（运行时逐条记录），回退日志行解析
    const failNames = new Set();
    if (Array.isArray(t.failedVideos)) {
      for (const f of t.failedVideos) {
        const nm = (f && f.name) ? String(f.name).trim() : '';
        if (!nm) continue;
        // 「第N个」是「命名前失败」的【序号占位】（由失败成片序号协议行写入 failedVideos），
        // 不是真实成片名 —— 必须归入 failedIndices 走序号补做，**绝不能进「按成片名解析序号」通道**：
        // 否则引擎会拿「第4个;第6个;…」去反解序号、必然失败（且提示自相矛盾）。
        const pm = /^第(\d+)个$/.exec(nm);
        if (pm) {
          const n = parseInt(pm[1], 10);
          if (Number.isInteger(n) && n > 0) {
            t.failedIndices = t.failedIndices || [];
            if (t.failedIndices.indexOf(n) < 0) t.failedIndices.push(n);
          }
          continue;
        }
        failNames.add(nm);
      }
    }
    if (!failNames.size) {
      for (const ln of (t.log || [])) {
        const m = /❌ 失败成片：([^|]+)/.exec(String(ln));
        if (m) failNames.add(String(m[1]).trim());
      }
    }
    // 如果没有失败记录，但已完成条目 < 总数，则尝试从 marker 推断未完成的条目
    if (!failNames.size) {
      const marker = this._loadMarker(t);
      const doneVideos = (marker && Array.isArray(marker.videos) ? marker.videos : []);
      if (doneVideos.length) {
        // 路由 A（复刻）：源 TXT 本身就是成片名清单，减去已完成的即为未完成项
        const srcEnv = t.env || {};
        const srcPath = srcEnv.REPLICA_TXT ? String(srcEnv.REPLICA_TXT).trim() : '';
        if (srcPath && fs.existsSync(srcPath)) {
          try {
            const srcLines = fs.readFileSync(srcPath, 'utf-8').split('\n').filter((l) => (l || '').trim());
            const doneBases = new Set(doneVideos.map((v) => path.basename(v)));
            for (const line of srcLines) {
              const ln = line.trim();
              if (ln.endsWith('.mp4') && !ln.includes('\\') && !ln.includes('/') && !doneBases.has(ln)) failNames.add(ln);
            }
          } catch (e) {}
        }
        // 路由 B（批量）：源 TXT 是素材配置而非成片名清单，路由 A 必然一无所获。
        // 改为「应有 total 片 − 已产出序号」反推缺失序号，再用已产出成片名作模板构造名字 ——
        // 引擎只从名字里反解序号（parseOnlyNameIndex），不比对完整名，故模板 + 目标序号即足够。
        if (!failNames.size && t.type === 'batch') {
          const plannedTotal = (t.progress && t.progress.total) || 0;
          // 序号反解与名字构造须与引擎的 parseOnlyNameIndex 同口径：末段 = 可选后缀标识
          // （不含短横与数字）+ 序号 + 可选组后缀。既兼容「配置了后缀标识」的名字
          // （...-A2A.mp4），也兼容漏掉分隔符产出的名字（...-resume2A.mp4）。
          const idxOf = (n) => { const m = /-([^-\d]*)(\d+)([A-Z]?)\.mp4$/i.exec(String(n)); return m ? parseInt(m[2], 10) : 0; };
          const doneIdx = new Set();
          for (const v of doneVideos) { const i = idxOf(path.basename(String(v))); if (i > 0) doneIdx.add(i); }
          // 成片目录里实际存在的文件也算已完成（标记可能未含最后一刻的产出）
          const markerOutDir = marker && marker.batchOutDir ? String(marker.batchOutDir) : '';
          if (markerOutDir && fs.existsSync(markerOutDir)) {
            try { for (const f of fs.readdirSync(markerOutDir)) { const i = idxOf(f); if (i > 0) doneIdx.add(i); } } catch (e) {}
          }
          if (plannedTotal > 0 && doneIdx.size > 0) {
            const sample = path.basename(String(doneVideos[0]));
            // 捕获组顺序：$1 后缀标识 / $2 原序号 / $3 组后缀 —— 替换串只能用 $1 与 $3，
            // 用 $2 会把「原序号」当成组后缀拼进去（...-21.mp4）
            const mkName = (i) => sample.replace(/-([^-\d]*)(\d+)([A-Z]?)\.mp4$/i, '-$1' + i + '$3.mp4');
            for (let i = 1; i <= plannedTotal; i++) if (!doneIdx.has(i)) failNames.add(mkName(i));
          }
        }
      }
    }
    // ③ 兜底：从**磁盘实际产物**反推待补序号。
    //   中断/停止的任务本来就没有失败记录；失败序号也可能因引擎异常未落盘
    //   （引擎在 thrStep 作用域崩溃 → failIndex 未执行 → 任务标为 error、失败记录为空
    //    → 续跑报「没有发现需要续跑的成片」，只能整批重做）。
    //   与路由 B 的区别：这里不依赖任务标记（marker），而是按提交时刻直接算出输出目录，
    //   标记缺失/不完整时仍能得出「还缺哪些」——成片名携带序号，这是客观事实。
    //   ⚠ 此处不得引用 `src`：它在本函数后面才声明（TDZ），会抛
    //   「Cannot access 'src' before initialization」，导致点「继续制作」直接失败。
    if (!failNames.size && t.type === 'batch') {
      // 先清理**不可播放**的产物：半截文件留在磁盘上会被当作"已完成"，导致该序号被永久跳过。
      try { await this._pruneBrokenOutputs(t); } catch (e) {}
      const missing = this._batchMissingIndices(t, '');
      if (missing.length) {
        t.failedIndices = missing.slice();                        // 走序号补做（最精确）
        for (const n of missing) failNames.add('第' + n + '个');   // 兼容既有"按名收集"通道
        try {
          this._lg('RUN', 'resume.infer',
            '续跑范围由磁盘产物反推 · 待补 ' + missing.length + ' 片 · ' + missing.slice(0, 12).join(',')
            + (missing.length > 12 ? '…' : ''),
            { id: t.id, total: Number((t.env || {}).BATCH_COUNT) || 0, missing: missing.slice(0, 40) });
        } catch (e) {}
      }
    }
    if (!failNames.size) {
      this._lg('RUN', 'resume.fail',
        '续跑中止 · 既无失败记录也无从标记反推 · ' + t.type + ' · ' + String(t.title || '').slice(0, 50),
        { id: t.id, failedVideos: (t.failedVideos || []).length, logLines: (t.log || []).length });
      return { ok: false, error: '没有发现需要续跑的成片，请检查任务日志' };
    }
    const namesArr = [...failNames].filter(Boolean);
    // 构造续跑环境：复用原任务环境变量，仅追加过滤变量
    const env = Object.assign({}, t.env || {});
    let src = env.REPLICA_TXT ? String(env.REPLICA_TXT) : '';
    if (!src) return { ok: false, error: '原任务缺少 TXT 配置，无法继续制作' };
    // ⚠ 演练模式（opts.dryRun）：只算出「会补做哪些」，**不删原任务、不建任务、不入队**。
    //   验证/诊断脚本一律用它 —— 本方法默认行为会真正启动引擎与 ffmpeg
    //   （验证脚本直接调用曾真的编码了 30 个成片，落在真实输出目录、消耗大量 GPU 时间；
    //    只读核对必须走 dryRun）。
    if (opts && opts.dryRun) {
      const idxDry = Array.isArray(t.failedIndices) ? t.failedIndices.filter((n) => Number.isInteger(n) && n > 0) : [];
      const missDry = (!failNames.size && t.type === 'batch') ? this._batchMissingIndices(t, '') : [];
      const willDo = (t.type === 'batch' && (idxDry.length || missDry.length))
        ? (idxDry.length ? idxDry : missDry)
        : null;
      return {
        ok: true, dryRun: true, type: t.type,
        count: willDo ? willDo.length : [...failNames].filter(Boolean).length,
        indices: willDo || undefined,
        names: [...failNames].filter(Boolean).slice(0, 40),
        env: this._envBrief(env),
      };
    }
    this.tasks.delete(id);
    this._removeMarker(t);
    let task;
    if (t.type === 'batch') {
      // 配置 TXT 在首次运行时已被移入成片目录作为正本（引擎与 PS1 同语义），
      // 续跑必须按成片目录重定位，否则旧路径已失效 → 引擎报「配置文件不可用（可能已被移动、重命名或删除）」
      const relocated = this._locateBatchConfig(src, t);
      if (relocated) { src = relocated; env.REPLICA_TXT = relocated; }
      // batch：只重做失败成片对应的「序号」，其余逻辑（命名/分组）仍按原始 BATCH_COUNT/BATCH_GROUP 计算；
      // 提交时刻刻意不刷新 → 成片命名前缀、输出目录、拼接日志均与首次一致（续跑即补做同一批的缺片）
      // 命名前的失败只能按序号补做：优先用 failedIndices（BATCH_ONLY_INDEX），
      // 没有序号时才退回按成片名过滤（BATCH_ONLY_NAMES）
      const idxArr = Array.isArray(t.failedIndices) ? t.failedIndices.filter((n) => Number.isInteger(n) && n > 0) : [];
      if (idxArr.length) {
        env.BATCH_ONLY_INDEX = idxArr.join(';');
        delete env.BATCH_ONLY_NAMES;
      } else {
        env.BATCH_ONLY_NAMES = namesArr.join(';');
      }
      task = this._inheritResumeBasis(this._createTask('batch', this._resumeTitle(t.title), env, src), t, env);
    } else {
      env.REPLICA_ONLY_NAMES = namesArr.join(';');
      env.REPLICA_SUBMIT_TS = String(Date.now()); // 刷新提交时刻，续跑产物按当前日期输出
      task = this._inheritResumeBasis(this._createTask('replica', this._resumeTitle(t.title), env, src), t, env);
    }
    this._enqueueTask(task);
    this._lg('RUN', 'resume.create',
      '续跑已创建 · ' + t.type + ' · 补做 ' + namesArr.length + ' 片'
      + (t.type === 'batch' ? ' · 沿用原提交时刻（命名与输出目录同首次）' : ' · 刷新提交时刻（按当前日期输出）'),
      { from: t.id, to: task.id,
        onlyVar: t.type === 'batch' ? (env.BATCH_ONLY_INDEX ? 'BATCH_ONLY_INDEX' : 'BATCH_ONLY_NAMES') : 'REPLICA_ONLY_NAMES',
        only: namesArr.slice(0, 40),
        env: this._envBrief(env) });
    // 返回"实际补做片数"：batch 走序号补做时以序号数为准（按名收集可能多算一项，
    // 例如标记推断与产物反推同时命中同一条），否则按名字数。
    const realCount = (t.type === 'batch' && env.BATCH_ONLY_INDEX)
      ? String(env.BATCH_ONLY_INDEX).split(';').filter(Boolean).length
      : namesArr.length;
    return { ok: true, taskId: task.id, count: realCount };
  }

  // 批量任务续跑的配置重定位。
  // 背景：配置正本在首次运行时被移入成片目录归档（引擎与 PS1 同语义），续跑沿用旧路径必然失效。
  // 关键约束：成片名里含「配置所在目录名」（引擎以 baseDir 名作命名基准），若直接改用归档路径，
  // 续跑产物名会多出一段目录名而与首次不一致 → 必须先复制回原路径，再以原路径运行。
  // 复制是幂等的：引擎读到该副本后会再次把它移回归档位置（覆盖同名）。
  // 从成片目录的实际产物反推「还缺哪些序号」（续跑兜底，见 resumeTask ③ 段）。
  // 反解规则与引擎 parseOnlyNameIndex 完全一致：末段 = 可选后缀标识 + 序号 + 可选组后缀
  // （如 `...-示例A-10C.mp4` → 10）。目录定位复用 _batchTaskOutDetail（含凌晨迁移回退）。
  _batchMissingIndices(t, src) {
    try {
      const total = Number((t.env || {}).BATCH_COUNT) || 0;
      if (!total) return [];
      const detail = this._batchTaskOutDetail(t, true);
      const dir = (detail && detail.outDir) || path.dirname(String(src || ''));
      if (!dir) return [];
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return []; }
      const done = new Set();
      for (const f of names) {
        // 临时产物不算完成（引擎先写 `*.mp4.tmp`、成功后原子改名，见 batch/index.js）：
        // 否则编码中途留下的半截文件会被当成"已完成"，该序号被永久跳过。
        if (/\.tmp\.mp4$|\.mp4\.tmp$/i.test(f) || /\.bak$/i.test(f)) continue;
        if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
        const m = /-([^-\d]*)(\d+)([A-Z]?)$/.exec(path.basename(f, path.extname(f)));
        if (m) { const n = parseInt(m[2], 10); if (n > 0) done.add(n); }
      }
      // 目录里一个**正式产物**都没有（首次运行 / 损坏产物刚被清理掉）→ 整批都要做。
      // ⚠ 这里必须返回全集而不是空数组：否则「清理损坏产物之后反推为空」会让续跑彻底没有目标
      //   （清了 3 个损坏文件后反推变成空，比不清理还糟）。
      if (!done.size) {
        const all = [];
        for (let i = 1; i <= total; i++) all.push(i);
        return all;
      }
      const missing = [];
      for (let i = 1; i <= total; i++) if (!done.has(i)) missing.push(i);
      return missing;
    } catch (e) { return []; }
  }

  // 续跑前的产物校验与清理：
  // 「需要清除可能存在的失败成片，即损坏的无法正常播放的成片（例如编码到一半意外停止）」
  // 为什么必须先做：反推「还缺哪些序号」依据的是"文件在不在"，而**半截文件也在**——
  // 不清理就会把损坏成片当成已完成、永久跳过该序号（用户拿不到片子，且不会报错）。
  // ⚠ 安全原则（务必保守）：**只在能明确判定损坏时才动文件**。
  //   · `*.mp4.tmp`（引擎临时产物）→ 直接删（100% 安全：正式名才是交付物）；
  //   · ffprobe **明确报出损坏特征**（moov atom not found / Invalid data 等）→ 改名留证；
  //   · ffprobe 超时 / 启动失败 / 权限错误 → **一律不动**（工具自身不可信时，不能替用户下结论）。
  //   教训：清理比不清理更糟的情形真实存在 —— 误判会把好成片改名，等于让用户丢片子。
  // ⚠ 演练模式（opts.dryRun）：只**报告**会怎么处理，绝不改文件。
  //   验证/诊断脚本一律用它 —— 真实素材目录只应被"用户点继续制作"这一条路径写入
  //   （验证脚本曾直接对真实目录调用本方法：虽未造成改动，但那是本不该有的写权限）。
  async _pruneBrokenOutputs(task, opts) {
    const dryRun = !!(opts && opts.dryRun);
    const out = { dir: '', checked: 0, broken: [], temps: [], skipped: 0 };
    try {
      const detail = this._batchTaskOutDetail(task, true);
      const dir = detail && detail.outDir;
      if (!dir) return out;
      out.dir = dir;
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return out; }
      // ① 临时/残缺命名：引擎的临时产物（`*.mp4.tmp`）**直接删除**（无保留价值）；其它可疑残留改名留证
      const tempRe = /(\.tmp\.mp4$|\.tmp$|\.part$|\.ytdl$|\.temp$|^\d+-temp|temp-\d+)/i;
      for (const f of names) {
        if (!tempRe.test(f)) continue;
        const p = path.join(dir, f);
        // 仅引擎临时产物可永久删除：现行 `<随机>.tmp`（纯字母数字单段，tempNameFor 生成）
        // + 历史形态 `*.tmp.mp4` / `*.mp4.tmp`；其它 .tmp（含点/横杠等非引擎命名）保守走改名留证
        const tmpPath = (/(\.tmp\.mp4$|\.mp4\.tmp$)/i.test(f) || /^[0-9a-z]{6,}\.tmp$/i.test(f)) ? p : '';
        try {
          if (tmpPath) {
            if (dryRun) out.temps.push(f + '(演练：将删除)');
            else { fs.unlinkSync(tmpPath); out.temps.push(f + '(已删)'); }
          } else { fs.renameSync(p, p + '.broken-' + Date.now() + '.bak'); out.temps.push(f); }
        } catch (e) {}
      }
      // ② ffprobe 逐个校验（能读出正时长才算可播放）
      const bin = this._resolveFfmpegBin();
      const ffprobe = bin && bin.ffprobePath;
      const vids = names.filter((f) => !/\.tmp\.mp4$|\.mp4\.tmp$/i.test(f) && !/\.bak$/i.test(f) && VIDEO_EXTS.has(path.extname(f).toLowerCase()));
      if (!ffprobe || !vids.length) { out.checked = 0; return out; }
      const probeOne = (file) => new Promise((resolve) => {
        try {
          require('child_process').execFile(ffprobe,
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, file)],
            { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
              const dur = parseFloat(String(stdout || '').trim());
              if (!err && isFinite(dur) && dur > 0) return resolve({ state: 'ok' });
              // 只有 ffprobe **确实跑起来并明确报错**时 stderr 才可信；超时/启动失败一律不下结论
              const msg = String(stderr || (err && err.message) || '');
              const conclusive = /moov atom not found|Invalid data found|could not find codec parameters/i.test(msg);
              resolve({ state: conclusive ? 'broken' : 'unknown', msg: msg.slice(0, 200) });
            });
        } catch (e) { resolve({ state: 'unknown', msg: String((e && e.message) || e) }); }
      });
      for (const f of vids) {
        out.checked++;
        const fsp = fs.promises;
        const p = path.join(dir, f);
        let size = 0;
        try { size = (await fsp.stat(p)).size; } catch (e) { continue; }
        const r = await probeOne(f);
        if (r.state === 'ok') continue;
        if (r.state === 'unknown') { out.skipped++; continue; }   // 无法判定 → 绝不替用户下结论
        // 明确损坏：**移出成片目录**，该序号回到未完成。
        // 优先移入回收站（项目红线：删除一律可还原）；回收站不可用时才退化为改名 ——
        // 但绝不把 .bak 留在正式产出目录里（留在目录里等于没清，
        // 而且会被误当成本批产物）。
        let recycled = false;
        if (dryRun) {
          out.broken.push({ name: f, size, recycled: false, dryRun: true });
        } else {
          try { recycled = !!this._recycleFile(p); } catch (e) { recycled = false; }
          if (!recycled) {
            const trashDir = path.join(dir, '..', '_损坏产物');
            try {
              fs.mkdirSync(trashDir, { recursive: true });
              await fsp.rename(p, path.join(trashDir, path.basename(p) + '.broken-' + Date.now() + '.bak'));
            } catch (e2) {}
          }
          out.broken.push({ name: f, size, recycled });
        }
        // 让路：逐个校验本身就慢，期间把事件循环交还出去
        await new Promise((r2) => setImmediate(r2));
      }
      if (out.broken.length || out.temps.length || out.skipped) {
        try {
          this._lg('DEL', 'resume.prune',
            '续跑前产物校验 · 损坏 ' + out.broken.length + ' 个（已移出成片目录·回收站可还原）/ 临时 ' + out.temps.length + ' 个（已删）'
            + ' / 无法判定 ' + out.skipped + ' 个（未改动）· 共校验 ' + out.checked,
            { dir, broken: out.broken.slice(0, 10), temps: out.temps.slice(0, 10), skipped: out.skipped, checked: out.checked });
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  _locateBatchConfig(oldPath, t) {
    const cur = String(oldPath || '');
    try { if (cur && fs.existsSync(cur)) return cur; } catch (e) {}
    const found = this._findArchivedConfig(cur, t);
    if (!found) return '';
    if (cur) {
      try {
        fs.mkdirSync(path.dirname(cur), { recursive: true });
        fs.copyFileSync(found, cur);
        return cur; // 命名基准保持不变
      } catch (e) { /* 原位置不可写 → 退回归档路径（名字可能带上目录名，但任务能跑通） */ }
    }
    return found;
  }

  // 归档配置查找（按优先级叠加多个查找源，任一命中即返回）：
  //   ① 任务自身记录的目录（done 任务经 _verifyBatchOutDirs 重算过，最可靠）；
  //   ② 运行时写入标记的权威输出目录 marker.batchOutDir —— 软暂停/停止/中断等非 done 任务
  //      也一定有（引擎启动即上报输出目录），但此时 t.outDir 尚未被重算，必须用标记兜底；
  //   ③ 按「提交时刻 + 配置名」确定性推算目录（覆盖标记缺失/被清理的极端情形）；
  //   ④ 原 TXT 所在目录（配置未被移走的常规路径）。
  // ⚠ 四个来源都要查：只查 ①④ 时，非 done 任务 t.outDir 缺失 → 找不到被引擎移入输出目录的
  //   TXT 正本 → 软暂停「继续」续跑会报「配置文件不可用（可能已被移动、重命名或删除）」，
  //   而「先停止再续跑」却正常（停止态能命中 ④ 或恰好还留有 t.outDir）。补齐后两条路径行为一致。
  _findArchivedConfig(oldPath, t) {
    const cur = String(oldPath || '');
    const base = cur ? path.basename(cur) : '';
    const dirs = [];
    if (t && t.outDir) dirs.push(t.outDir);
    try {
      const marker = this._loadMarker(t);
      if (marker && marker.batchOutDir) dirs.push(marker.batchOutDir);
    } catch (e) {}
    try {
      const detail = this._batchTaskOutDetail(t, true);
      if (detail && detail.outDir) dirs.push(detail.outDir);
    } catch (e) {}
    if (cur) dirs.push(path.dirname(cur));
    for (const d of dirs) {
      if (!d) continue;
      if (base) {
        const p = path.join(d, base);
        try { if (fs.existsSync(p)) return p; } catch (e) {}
      }
      try {
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
        for (const n of fs.readdirSync(d)) {
          if (!n.toLowerCase().endsWith('.txt') || /日志/.test(n)) continue;
          return path.join(d, n);
        }
      } catch (e) {}
    }
    return '';
  }

  // 遮罩叠加任务：payload 来自主窗口遮罩叠加模式（mode/rawDirs/videos/maskDirs/watermark/outputDir），
  // 经环境变量 MASK_* 驱动内置引擎的 mask 模块；无设置页配置组，参数随任务提交
  runMask(p) {
    const envG = this._envGuard('run_mask');
    if (envG) return envG;
    if (!this.shouldUseNodeEngine('mask')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const errs = [];
    const dirs = Array.isArray(p && p.rawDirs) ? p.rawDirs.filter((d) => String(d).trim()) : [];
    if (!dirs.length) errs.push('原片文件夹');
    if (!String((p && p.outputDir) || '').trim()) errs.push('输出目录');
    const mode = parseInt(p && p.mode, 10);
    const needMask = mode === 1 || mode === 3;
    const needWm = mode === 1 || mode === 2;
    // 遮罩项可能是目录（扫描其下 .mov），也可能是用户添加的单个 .mov 文件（路径即文件本身）——
    // 文件项必须归入 MASK_MASKS（遮罩清单），若混进 MASK_MASK_DIRS 会被引擎当目录判「不存在」
    const maskDirs = [], maskFiles = [];
    if (needMask && Array.isArray(p && p.maskDirs)) {
      for (const d of p.maskDirs) {
        const v = String(d || '').trim();
        if (!v) continue;
        const rp = path.resolve(v);
        let isFile = false;
        try { isFile = fs.statSync(rp).isFile(); } catch (e) {}
        (isFile ? maskFiles : maskDirs).push(rp);
      }
    }
    if (needMask && !maskDirs.length && !maskFiles.length) errs.push('遮罩');
    if (needWm && !String((p && p.watermark) || '').trim()) errs.push('水印文件');
    if (errs.length) return { ok: false, error: '遮罩叠加配置缺失：' + errs.join('、') };
    // 勾选视频序列化：完整路径分号分隔（空=该文件夹全部）
    const pickVids = [];
    const vids = (p && p.videos) || {};
    for (const dir of Object.keys(vids)) {
      // 原片项可能是目录（名称+相对路径）或用户添加的单个视频文件（路径即文件本身）
      let dirIsFile = false;
      try { dirIsFile = fs.statSync(dir).isFile(); } catch (e) {}
      for (const name of (vids[dir] || [])) {
        if (String(name).trim()) pickVids.push(dirIsFile ? path.resolve(dir) : path.resolve(dir, name));
      }
    }
    // 任务列表标题：项目名 / 遮罩名（遮罩名按 mov 前缀去重，与遮罩主题分组口径一致）
    const maskPfx = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/[-_ ]+\d+$/, '').replace(/\d+$/, '');
    const projName = String((p && p.projectName) || '').trim() || (dirs[0] ? path.basename(dirs[0]) : '');
    const themeNames = [];
    const themeSeen = new Set();
    String((p && p.masks) || '').split(';').forEach((s) => {
      const fp = String(s).trim();
      if (!fp) return;
      const pfx = maskPfx(path.basename(fp));
      if (!themeSeen.has(pfx)) { themeSeen.add(pfx); themeNames.push(pfx); }
    });
    const title = projName + (themeNames.length ? ' / ' + themeNames.join('+') : '');
    const env = {
      MASK_MODE: String(mode || 1),
      MASK_RAW_DIRS: dirs.map((d) => path.resolve(d)).join(';'),
      MASK_VIDEOS: pickVids.join(';'),
      MASK_MASK_DIRS: maskDirs.join(';'),
      MASK_MASKS: [String((p && p.masks) || '').trim(), maskFiles.join(';')].filter((x) => x).join(';'),
      MASK_WATERMARK: needWm ? path.resolve(p.watermark) : '',
      MASK_OUTPUT_DIR: path.resolve(p.outputDir),
      MASK_PROJECT_NAME: String((p && p.projectName) || '').trim(),
      MASK_SUFFIX_MARK: String((p && p.suffix) || '').trim(),
      MASK_LOG_DIR: String((p && p.logDir) || '').trim(),
      MASK_WATERMARK_ALPHA: this._maskWmAlphaString(p && p.watermarkAlpha),
      MASK_SUBMIT_TS: String(Date.now()),
    };
    Object.assign(env, this._cacheEnvBase());
    const task = this._enqueueTask(this._createTask('mask', title, env, dirs[0]));
    return { ok: true, taskId: task.id };
  }

  // 前端异常上报：界面报错若不落盘，事后无从回溯 —— 统一落进错误日志（与引擎失败同一份）。
  // payload: { kind, msg, stack, where, href }
  reportUiError(p) {
    try {
      const o = (p && typeof p === 'object') ? p : {};
      const kind = String(o.kind || 'exception');
      // 不截断：stack 全文入 data，超长由 briefData 分片多行承载；
      // 摘要取首行（formatLine 会折叠换行，此处显式取首行保扫读）
      const msg = String(o.msg || o.message || '');
      const stack = String(o.stack || '');
      const where = String(o.where || '').slice(0, 80);
      const href = String(o.href || '').slice(0, 240);
      // 前端可带当前任务 id（logbootstrap 的 vlSetTaskId）：排查时前端异常能与任务日志串起来
      const taskId = String(o.taskId || '').slice(0, 80);
      this._lg('UI', kind === 'rejection' ? 'ui.rejection' : 'ui.exception',
        (msg || '前端异常（无错误消息）').split('\n')[0] + (where ? ' @ ' + where : ''),
        { where, href, stack, taskId: taskId || undefined, ctx: (o.ctx && typeof o.ctx === 'object') ? o.ctx : undefined });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // ── 日志体系 ──
  /** 运行日志读取（排查视图）：app/error/engine 三类 + lvl/mod 过滤（透传 runlog.readLog） */
  readLog(o) {
    try {
      return this._ensureRunLog().readLog(o || {});
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  getLogLevel() {
    try {
      const log = this._ensureRunLog();
      return { ok: true, level: log.getLevel(), persisted: this.getAppSetting('log_level', '') || '' };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  /** 级别运行时切换（排查临时切 debug）。**同时持久化**（settings.db scope='app'），
   *  重启后由 _restoreLogLevel 恢复 —— 否则只在本会话生效，排查一次就要重切一次。 */
  setLogLevel(lvl) {
    try {
      const log = this._ensureRunLog();
      log.setLevel(String(lvl));
      const level = log.getLevel();
      try { if (this._useSettings() && this._settingsStore) this._settingsStore.set('app', 'log_level', level); } catch (e) {}
      this._lg('CFG', 'log.level', '日志级别切换 · ' + level, { level });
      return { ok: true, level };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  /** 启动后台恢复持久化级别（由空闲队列调用，不在启动关键路径上）：
   *  设置库里存过就恢复，让「切到 debug 排查」在重启后依然生效。 */
  _restoreLogLevel() {
    try {
      const saved = String(this.getAppSetting('log_level', '') || '').trim();
      if (!saved) return;
      const log = this._ensureRunLog();
      if (log.getLevel() === saved) return;
      log.setLevel(saved);
      this._lg('CFG', 'log.level', '日志级别已按持久化设置恢复 · ' + log.getLevel(), { level: log.getLevel() });
    } catch (e) {}
  }
  /** 一键诊断包：该任务相关的 app/error/engine 行 + env 快照 + 任务标记 + 产物清单 → 单个 txt。
   *  包内含本机路径 → 文件头附提示（外发前自行打码）。 */
  // 诊断包路径打码（外发前用）：只保留**文件名**，盘符与各级目录一律折叠 ——
  // 目录名、盘符、任务名都可能含业务信息，而排查只需知道"是哪个文件"。
  // 例：`E:\项目名\9月\0927\配置.txt` → `<路径>\配置.txt`。
  // 兼容 JSON 里的反斜杠转义（`E:\\a\\b.txt`）—— 故按「一个或多个反斜杠」切分。
  _maskDiagPaths(text) {
    const s = String(text == null ? '' : text);
    return s
      .replace(/[A-Za-z]:\\+(?:[^\\/:*?"<>|\r\n]+\\+)*[^\\/:*?"<>|\r\n]*/g, (m) => {
        const segs = m.split(/\\+/).filter(Boolean);
        const base = segs.length ? segs[segs.length - 1] : '';
        return base ? '<路径>\\' + base : '<路径>';
      })
      .replace(/\\\\[^\\/\s"',]+\\[^\\/\s"',\\]+/g, (m) => {
        const segs = m.split(/\\+/).filter(Boolean);
        const base = segs.length ? segs[segs.length - 1] : '';
        return base ? '<路径>\\' + base : '<路径>';
      });
  }

  exportDiagPack(id, opts) {
    try {
      let t = id ? this.tasks.get(id) : null;
      if (!t && !id) {
        // 留空 = 最近一个失败/中断/停止任务（按结束时间降序）
        for (const t2 of this.tasks.values()) {
          if (!['error', 'interrupted', 'stopped'].includes(t2.status)) continue;
          if (!t || (t2.endedAt || 0) > (t.endedAt || 0)) t = t2;
        }
        if (!t) return { ok: false, error: '最近没有失败任务，请填写任务 id' };
      }
      if (!t) return { ok: false, error: '任务不存在' };
      id = t.id;
      const opts = { grep: id, tail: 20000, maxBytes: 16 * 1024 * 1024 };
      const app = this._ensureRunLog().readLog(Object.assign({ file: 'app' }, opts));
      const error = this._ensureRunLog().readLog(Object.assign({ file: 'error' }, opts));
      const engine = this._ensureRunLog().readLog(Object.assign({ file: 'engine' }, opts));
      const marker = this._loadMarker(t);
      const outs = Array.isArray(marker && marker.videos) ? marker.videos : [];
      const parts = [];
      parts.push('Video Lab 诊断包');
      parts.push('生成时间: ' + new Date().toLocaleString());
      parts.push('任务: ' + id + ' · ' + t.type + ' · ' + String(t.title || '').slice(0, 80) + ' · 状态 ' + t.status);
      parts.push('⚠ 包内含本机路径与任务信息，请勿随意分享；外发前可自行将路径打码。');
      parts.push('');
      parts.push('════ 任务 env 快照（已脱敏）════');
      parts.push(this._ensureRunLog().scrub(JSON.stringify(this._envBrief(t.env), null, 1)));
      parts.push('');
      parts.push('════ 任务标记（产物归属）════');
      parts.push(marker ? this._ensureRunLog().scrub(JSON.stringify(marker, null, 1).slice(0, 20000)) : '(无)');
      parts.push('');
      parts.push('════ 产物清单（' + outs.length + ' 个文件）════');
      parts.push(JSON.stringify(this._describeForLog(outs), null, 1));
      parts.push('');
      for (const [name, r] of [['app', app], ['error', error], ['engine', engine]]) {
        parts.push('════ ' + name + '-*.log 中与该任务相关的行（' + (r.lines ? r.lines.length : 0) + ' 行，窗口内）════');
        parts.push(r.lines && r.lines.length ? r.lines.join('\n') : '(无匹配行)');
        parts.push('');
      }
      const dir = path.join(this._ensureRunLog().getDir(), '..', 'diag');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e2) {}
      const file = path.join(dir, 'diag-' + String(id).replace(/[^\w-]/g, '') + '-' + Date.now().toString(36) + (opts && opts.maskPaths ? '-masked' : '') + '.txt');
      // 路径打码：整包统一处理一次（日志行 / env 快照 / 产物清单都含路径）
      const body = (opts && opts.maskPaths) ? this._maskDiagPaths(parts.join('\n')) : parts.join('\n');
      fs.writeFileSync(file, body, 'utf8');
      this._lg('SYS', 'diag.export', '导出诊断包 · ' + t.type + (opts && opts.maskPaths ? ' · 路径已打码' : '') + ' · ' + path.basename(file), { id, path: file, masked: !!(opts && opts.maskPaths) });
      return { ok: true, path: file, masked: !!(opts && opts.maskPaths) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // 遮罩水印透明度解析：任务传入值优先，其次设置页配置；留空/非法回退脚本默认 0.3
  _maskWmAlphaString(v) {
    let raw = (v == null || String(v).trim() === '') ? this.config.mask.watermark_alpha : v;
    const n = parseFloat(String(raw == null ? '' : raw));
    if (!(n >= 0.05 && n <= 1)) return '0.3';
    return String(n);
  }

  // 断点续跑：失败/中断/停止的遮罩叠加任务，仅续跑失败成片（MASK_ONLY_NAMES 过滤），不删已成功产物
  continueMask(id) {
    const envG = this._envGuard('continue_mask');
    if (envG) return envG;
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') return { ok: false, error: '仅失败/中断/停止的任务可继续制作' };
    if (t.type !== 'mask') return { ok: false, error: '仅遮罩叠加任务支持继续制作' };
    const failNames = new Set();
    if (Array.isArray(t.failedVideos)) {
      for (const f of t.failedVideos) if (f && f.name) failNames.add(f.name);
    }
    if (!failNames.size) {
      for (const ln of (t.log || [])) {
        const m = /❌ 失败成片：([^|]+)/.exec(String(ln));
        if (m) failNames.add(String(m[1]).trim());
      }
    }
    if (!failNames.size) return { ok: false, error: '没有发现需要续跑的成片，请检查任务日志' };
    const namesArr = [...failNames].filter(Boolean);
    const env = Object.assign({}, t.env || {});
    env.MASK_ONLY_NAMES = namesArr.join(';');
    env.MASK_SUBMIT_TS = String(Date.now());
    if (!env.MASK_RAW_DIRS) return { ok: false, error: '原任务缺少原片文件夹信息，无法继续制作' };
    this.tasks.delete(id);
    this._removeMarker(t);
    const task = this._createTask('mask', (t.title || '') + '（续跑）', env, t.srcPath || '');
    this._enqueueTask(task);
    return { ok: true, taskId: task.id, count: namesArr.length };
  }

  // 遮罩叠加项目素材只读扫描：仅扫描遮罩叠加独立工作路径（设置-遮罩叠加 配置）。
  listMaskProjects() {
    // 遮罩主题组前缀：与前端 maskGroupPrefix 一致（去扩展名、去尾部序号），徽章与右栏分组口径统一
    const _maskPrefix = (name) => {
      let s = String(name || '').replace(/\.[^.]+$/, '');
      s = s.replace(/[-_ ]+\d+$/, '').replace(/\d+$/, '');
      return s;
    };
    // 仅使用遮罩叠加独立工作路径（不允许复用批量项目管理路径）
    const root = (this.config && this.config.mask && String(this.config.mask.root || '').trim());
    if (!root) return [];
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return []; }
    // 一级目录名集合（含空目录）—— 供核验项目登记表：遮罩列表本来就遍历了目录，
    // 所以「登记项是否还存在」的核验在这里是零额外 IO 的（外部删除 → 下次即摘除）
    const dirNames = new Set();
    for (const en of entries) if (en.isDirectory()) dirNames.add(en.name);
    // 遮罩侧的项目登记表：软件内新建、暂无素材的项目（详见 _projRegKey 上方说明）
    const regNames = this._loadProjReg(root, 'mask');
    const regAlive = regNames.filter((n) => dirNames.has(n));
    if (regAlive.length !== regNames.length) this._saveProjReg(root, 'mask', regAlive);
    const regSet = new Set(regAlive);
    for (const en of entries) {
      if (!en.isDirectory()) continue;
      const pdir = path.join(root, en.name);
      // 遮罩主题：项目下直接子文件夹中任一含 mov 视频（遮罩素材仅认 .mov，mp4 不算遮罩主题）
      let themes = [];
      try {
        themes = fs.readdirSync(pdir, { withFileTypes: true })
          .filter((s) => s.isDirectory())
          .map((s) => s.name)
          .filter((n) => {
            try {
              return fs.readdirSync(path.join(pdir, n)).some((f) => /\.mov$/i.test(f));
            } catch (e) { return false; }
          })
          .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      } catch (e) {}
      // 主题组数：项目内全部 mov（根目录+任意子文件夹）按名称前缀去重，与右栏真实分组一致
      let themeCount = 0;
      const seenPrefix = new Set();
      const walkMasks = (d) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const s2 of ents) {
          if (s2.name === '已完成') continue; // 与右栏主题列表同口径：旧脚本产物目录不参与计数
          const full = path.join(d, s2.name);
          if (s2.isDirectory()) walkMasks(full);
          else if (/\.mov$/i.test(s2.name)) seenPrefix.add(_maskPrefix(s2.name));
        }
      };
      walkMasks(pdir);
      themeCount = seenPrefix.size;
      // 纳入条件：项目内有遮罩主题子文件夹，或任意位置（含根目录）存在 .mov 主题素材；
      // 或者它是软件内新建并登记过的空项目（保证「添加新项目」后立刻可见）
      const isEmptyProject = !themes.length && themeCount === 0;
      if (!isEmptyProject || regSet.has(en.name)) out.push({ name: en.name, path: pdir, themes, themeCount, isEmptyProject });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return out;
  }

  // 扫描目录下视频/遮罩素材（含子文件夹），返回 { name, sub, dur }；时长异步探测
  _listMaskMedia(dir, exts) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) return Promise.resolve([]);
    // 单文件（用户通过「添加文件或文件夹」添加的单个视频文件）：扩展名匹配则返回该文件
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        if (!exts.has(path.extname(abs).toLowerCase())) return Promise.resolve([]);
        return this._maskMediaInfo(abs).then((r) => [{ name: path.basename(abs), sub: '', dur: r && r.duration > 0 ? r.duration : 0 }]);
      }
    } catch (e) { return Promise.resolve([]); }
    const items = [];
    const walk = (d, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.name === '已完成') continue; // 旧脚本妥协产物目录不参与展示
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full, rel ? rel + '/' + en.name : en.name);
        else if (exts.has(path.extname(en.name).toLowerCase())) items.push({ full, name: en.name, sub: rel || '' });
      }
    };
    walk(abs, '');
    items.sort((a, b) => (a.sub === b.sub ? a.name.localeCompare(b.name, 'zh-CN') : a.sub.localeCompare(b.sub, 'zh-CN')));
    return this._runWithLimit(items, (it) => this._maskMediaInfo(it.full).then((r) => ({ name: it.name, sub: it.sub, dur: r && r.duration > 0 ? r.duration : 0 })), 6);
  }

  listMaskVideos(dir) { return this._listMaskMedia(dir, new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv'])); }

  listMaskMasks(dir) { return this._listMaskMedia(dir, new Set(['.mov'])); }

  // 解析 .lnk 快捷方式目标（单个）；非快捷方式/解析失败返回空串
  resolveShortcut(p) {
    if (!p || !/\.lnk$/i.test(p)) return '';
    const m = this._resolveShortcutTargets([p]);
    return (m && m[p]) ? String(m[p]) : '';
  }

  // 统一添加入口（原片/遮罩侧「添加文件或文件夹」）：接受 快捷方式 / 视频文件 / 文件夹，
  // 快捷方式先解析目标，再按类型返回；原片=mp4 等视频，遮罩=mov。返回 { type: 'dir'|'file', path } 或 { error }
  maskAddSource(side, p) {
    if (!p) return { error: '空路径' };
    let target = String(p);
    if (/\.lnk$/i.test(target)) {
      target = this.resolveShortcut(target);
      if (!target) return { error: '快捷方式无效（无法解析目标）' };
    }
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) return { type: 'dir', path: target };
      if (st.isFile()) {
        const ext = path.extname(target).toLowerCase();
        const okExt = side === 'theme' ? ['.mov'] : ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv'];
        if (okExt.indexOf(ext) < 0) return { error: side === 'theme' ? '遮罩仅支持 .mov 文件' : '不支持的文件类型' };
        return { type: 'file', path: target };
      }
      return { error: '无法识别该路径' };
    } catch (e) { return { error: '路径不存在' }; }
  }

  // 原片默认扫描：递归收集项目下所有含 mp4 的文件夹（以 mp4 所在文件夹为单位分组，不跳过任何目录；根目录含 mp4 也计入）
  scanMaskRawDirs(dir) {
    const abs = path.resolve(dir);
    const hitDirs = [];
    const hitKeys = {};
    const addHit = (d) => { const k = String(d).replace(/[\\/]+$/, '').toLowerCase(); if (!hitKeys[k]) { hitKeys[k] = 1; hitDirs.push(d); } };
    const hasMp4 = (d) => {
      try { return fs.readdirSync(d).some((f) => /\.mp4$/i.test(f)); } catch (e) { return false; }
    };
    const lnks = [];
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) {
          if (hasMp4(full)) addHit(full);
          walk(full);
        } else if (en.isFile() && path.extname(en.name).toLowerCase() === '.lnk') {
          lnks.push(full);
        }
      }
    };
    if (!fs.existsSync(abs)) return [];
    if (hasMp4(abs)) addHit(abs);
    walk(abs);
    // .lnk 快捷方式：解析目标目录并递归扫描其内容；目标路径/文件夹已存在则跳过
    if (lnks.length) {
      const map = this._resolveShortcutTargets(lnks);
      for (const l of lnks) {
        const t = map[l];
        if (!t) continue;
        const target = String(t).trim();
        if (!target) continue;
        try { if (!fs.statSync(target).isDirectory()) continue; } catch (e) { continue; }
        if (hitKeys[String(target).replace(/[\\/]+$/, '').toLowerCase()]) continue; // 目标已存在 → 跳过
        addHit(target);
        walk(target);
      }
    }
    return hitDirs
      .map((d) => ({ path: d, name: path.basename(d) || String(d) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  // 遮罩主题文件指纹（轻量自愈检测用：仅 readdir 收集 .mov 相对路径集，不探测，不落盘）
  maskThemeSig(dir) {
    try {
      if (!dir || !fs.existsSync(dir)) return { count: 0, sig: '' };
      const names = [];
      const walk = (d, rel) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const en of ents) {
          if (en.name === '已完成') continue;
          const full = path.join(d, en.name);
          if (en.isDirectory()) walk(full, rel ? rel + '/' + en.name : en.name);
          else if (/\.mov$/i.test(en.name)) names.push(rel ? rel + '/' + en.name : en.name);
        }
      };
      walk(dir, '');
      names.sort();
      return { count: names.length, sig: names.join('|') };
    } catch (e) { return { count: 0, sig: '' }; }
  }

  // 遮罩叠加日志目录约定：项目\遮罩日志
  _maskLogDir(projectPath) { return path.join(projectPath, '遮罩日志'); }

  // 按成片名从视频缓存反查实际文件（用户手动迁移后仍可定位；日志 @out 缺失时兜底）。
  // 查全部作用域：待查成片可能来自任意模式，此处不做来源过滤。
  _findMaskOut(videoName) {
    const target = String(videoName == null ? '' : videoName).toLowerCase();
    if (!target) return '';
    if (this._useDbCache()) {
      try {
        const mask = this._scopes.batch | this._scopes.replica | this._scopes.mask;
        const map = this._cacheStore.loadVideoMap({ scopesMask: mask });
        for (const p of Object.keys(map)) {
          if (!p || path.basename(p).toLowerCase() !== target) continue;
          try { if (fs.existsSync(p)) return p; } catch (e) {}
        }
        return '';
      } catch (e) { /* 库读取失败 → 退回内存缓存 */ }
    }
    try {
      const cache = this._loadVideoCache();
      for (const p of Object.keys(cache)) {
        if (!p || path.basename(p).toLowerCase() !== target) continue;
        try { if (fs.existsSync(p)) return p; } catch (e) {}
      }
    } catch (e) {}
    return '';
  }

  // 从遮罩日志读取成片块中的 @out 路径行（返回候选路径，不要求文件仍存在；
  // 前端据此打开文件夹，并用 check_exists 判定「打开成片」是否可点）
  _maskOutFromLog(logPath, videoName) {
    const text = readText(logPath);
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== videoName) continue;
      // 成片名行向下 8 行内找 @out（块内顺序：成片名/使用片段列表：/素材/@out），
      // 遇 === 分隔线即止；不能因紧邻的「使用片段列表：」提前退出，否则 @out 永远读不到
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const m = /^@out:\s*(.+)$/.exec(lines[j]);
        if (m) { const p = String(m[1]).trim().replace(/^"|"$/g, ''); return p ? p : ''; }
        if (lines[j].startsWith('===')) break;
      }
      break;
    }
    return '';
  }

  // 列出项目的遮罩叠加日志：每个日志文件只读一次，同步解析成片块与 @out 实际路径；
  // 按日志目录内文件 名称+mtime 签名缓存，未变化直接复用（切换项目/进出日志视图不再重复解析）
  listMaskLogs(projectPath) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    if (!pdir || !fs.existsSync(logDir)) return [];
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')).sort(); } catch (e) { return []; }
    const sig = logDir + '|' + files.map((n) => { let m = 0; try { m = fs.statSync(path.join(logDir, n)).mtimeMs; } catch (e) {} return n + ':' + m; }).join('|');
    if (this._maskLogCache && this._maskLogCache.key === sig) return JSON.parse(JSON.stringify(this._maskLogCache.logs));
    const logs = [];
    for (const f of files) {
      const fp = path.join(logDir, f);
      let text;
      try { text = readText(fp); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      // 一次扫描构建 成片名 → @out 映射：成片名行（其下一行为「使用片段列表：」）块内取 @out
      const outMap = {};
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '使用片段列表：' || i < 1) continue;
        const name = lines[i - 1].trim();
        if (!name || /^[A-Za-z]:[\\/]/.test(name)) continue;
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const tm = /^@out:\s*(.+)$/.exec(lines[j]);
          if (tm) { const p = String(tm[1]).trim().replace(/^"|"$/g, ''); if (p) outMap[name] = p; break; }
          if (lines[j].trim() === '使用片段列表：' || lines[j].trim().startsWith('===')) break;
        }
      }
      const entries = this._parseLog(fp, text).map((e) => Object.assign({}, e, { outPath: outMap[e.video] || this._findMaskOut(e.video) }));
      logs.push({ file: f, path: fp, name: path.basename(f, '.txt'), entries, mtime: fs.existsSync(fp) ? fs.statSync(fp).mtimeMs : 0 });
    }
    logs.sort((a, b) => b.mtime - a.mtime);
    this._maskLogCache = { key: sig, logs };
    return JSON.parse(JSON.stringify(logs));
  }

  // 删除与指定素材（原片/遮罩路径）相关的所有遮罩叠加成片：按日志块片段精确匹配，
  // 删除成片文件并同步从日志移除对应块；返回删除列表

  // 原片/遮罩会话状态（缓存，非设置）：存于 cache_kv（键 mask_session:<项目名>）
  // 不手动清除/移除就会一直在列表里；重建缓存菜单项清空后回退自动扫描
  // 遮罩会话登记的全部素材目录（含手动添加的项目外路径）：统一刷新、作用域落库与认领共用
  _maskSessionDirs() {
    const out = [];
    try {
      const projects = (this.listProjects() || []).map((x) => (x && x.name) || x).filter(Boolean);
      for (const name of projects) {
        let sess = null;
        try { sess = this.getMaskSession(name); } catch (e) { sess = null; }
        if (!sess) continue;
        for (const d of [].concat(sess.rawDirs || [], sess.themes || [])) {
          const p = stripQuotes(String((d && d.path) || '').trim());
          if (p) out.push(p);
        }
      }
    } catch (e) { /* 会话不可读时返回已收集部分 */ }
    return out;
  }
  getMaskSession(projectName) {
    if (!this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getKv('mask_session:' + String(projectName || ''));
      if (!raw) return null;
      const d = JSON.parse(raw);
      return (d && typeof d === 'object') ? d : null;
    } catch (e) { return null; }
  }
  saveMaskSession(projectName, data) {
    if (!this._useDbCache()) return { ok: false, error: '缓存库不可用' };
    try {
      this._cacheStore.setKv('mask_session:' + String(projectName || ''), JSON.stringify(data || {}));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  // projectName 为空 = 清空全部项目会话缓存
  clearMaskSession(projectName) {
    if (!this._useDbCache()) return { ok: true };
    try {
      if (!projectName) {
        const store = this._cacheStore;
        store.transaction(() => {
          for (const k of Object.keys(store.listKv('mask_session:'))) store.removeKv(k);
        });
        return { ok: true };
      }
      this._cacheStore.removeKv('mask_session:' + String(projectName || ''));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // —— 项目默认输出目录（项目级设置，独立于会话缓存；供底栏输出目录占位符与选择初始路径）——
  // 存于设置库 scope='mask'，键为项目名
  getMaskDefaultDir(projectName) {
    if (!this._useSettings()) return '';
    try { return String(this._settingsStore.get('mask', String(projectName || ''), '') || '').trim(); } catch (e) { return ''; }
  }
  setMaskDefaultDir(projectName, dir) {
    if (!this._useSettings()) return { ok: false };
    try {
      this._settingsStore.set('mask', String(projectName || ''), String(dir || '').trim());
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // 删除指定遮罩叠加成片（按成片名）：删除文件并同步从日志移除对应块
  deleteMaskVideos(projectPath, videoNames) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    const names = Array.isArray(videoNames) ? videoNames.map((n) => String(n).trim()).filter(Boolean) : [];
    if (!pdir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    if (!names.length) return { ok: false, error: '未指定成片名' };
    const nset = new Set(names.map((n) => n.toLowerCase()));
    const deleted = [];
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')); } catch (e) { return { ok: false, error: '读取日志失败' }; }
    for (const f of files) {
      const fp = path.join(logDir, f);
      const text = readText(fp);
      const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
      const keep = [];
      let i = 0;
      let changed = false;
      while (i < lines.length) {
        const line = lines[i];
        const isBlockHead = i + 1 < lines.length && lines[i + 1].trim() === '使用片段列表：';
        if (isBlockHead) {
          let j = i + 2;
          while (j < lines.length) {
            const t = lines[j].trim();
            if (t === '使用片段列表：' || t.startsWith('===')) break;
            j++;
          }
          const block = lines.slice(i, j);
          const vname = (block[0] || '').trim();
          if (vname && nset.has(vname.toLowerCase())) { changed = true; i = j; continue; }
          // 未命中：整块保留（成片名/使用片段列表/素材/@out 原样）
          for (let k = i; k < j; k++) keep.push(lines[k]);
          i = j;
          continue;
        }
        keep.push(line);
        i++;
      }
      if (changed) {
        // 先采集清单留痕，再一律移入回收站
        const outs = [];
        for (const vn of names) {
          const op = this._maskOutFromLog(fp, vn) || this._findMaskOut(vn);
          if (op && fs.existsSync(op)) outs.push(op);
        }
        if (outs.length) {
          const info = this._describeForLog(outs);
          this._lg('DEL', 'mask.videos.remove',
            '删除遮罩成片 · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes)
            + ' · 日志 ' + path.basename(fp), Object.assign({ project: pdir }, info));
        }
        for (const op of outs) { this._recycleFile(op); deleted.push(op); }
        // 仅剩分隔线/空行时视为已空，移除日志文件（走回收站）；否则原子写回
        const outText = keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
        const hasContent = keep.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()));
        if (hasContent) atomicWrite(fp, outText);
        else this._recycleFile(fp);
      }
    }
    return { ok: true, deleted };
  }

  // 删除指定遮罩日志文件（整份 TXT，非单块）：限定在「项目遮罩日志目录」内，
  // 不依赖批量工作路径（遮罩项目可位于任意路径，removeBranch 的 this.root 校验会误拒）；
  // 删除后若该日志目录为空则一并清理（以遮罩日志目录为边界，不越界）
  deleteMaskLog(projectPath, logPath) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    if (!pdir || !logDir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    const lp = String(logPath || '').trim();
    if (!lp) return { ok: false, error: '未指定日志文件' };
    const rl = path.resolve(lp);
    const rdir = path.resolve(logDir);
    if (rl !== rdir && !rl.startsWith(rdir + path.sep)) return { ok: false, error: '日志不在项目遮罩日志目录内' };
    if (!rl.toLowerCase().endsWith('.txt')) return { ok: false, error: '仅支持移除遮罩日志 TXT' };
    try {
      if (!fs.existsSync(rl)) return { ok: false, error: '日志文件不存在：' + lp };
      // 先留痕（路径/大小/原修改时间），再移入回收站
      const info = this._describeForLog([rl]);
      this._lg('DEL', 'mask.log.remove',
        '删除遮罩日志 · ' + path.basename(rl) + ' · ' + this._humanSize(info.bytes),
        Object.assign({ project: pdir }, info));
      this._recycleFile(rl);
      try {
        const rest = fs.readdirSync(rdir);
        if (!rest.length) { try { fs.rmdirSync(rdir); } catch (e) {} }
      } catch (e) {}
    } catch (e) { return { ok: false, error: String(e) }; }
    this._maskLogCache = null; // 日志缓存失效，下次 listMaskLogs 重读
    return { ok: true };
  }

  // 重新定位遮罩成片：成片可能被外部移走（@out 路径失效/不在原输出目录），
  // 用户在列表/分支右键选择新目录后，在本目录（含子目录）按「文件名完全一致」查找同名成片；
  // 找到则把该成片所在日志块 @out 行改写成新路径并返回，前端据此刷新视图
  relocateMaskOut(projectPath, videoName, newDir) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    const vn = String(videoName || '').trim().replace(/^"|"$/g, '');
    const nd = String(newDir || '').trim().replace(/^"|"$/g, '');
    if (!pdir || !logDir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    if (!vn) return { ok: false, error: '未指定成片名' };
    if (!nd || !fs.existsSync(nd) || !fs.statSync(nd).isDirectory()) return { ok: false, error: '所选目录无效' };
    if (!/\.mp4$/i.test(vn)) vn += '.mp4';
    // 目录递归查找同名文件（与外部手动迁移的「文件名=同一成片」语义一致）
    const found = this._findVideoByName(nd, vn);
    if (!found) return { ok: false, error: '所选目录中未找到同名成片：' + path.basename(vn) };
    // 改写日志块 @out：遍历日志文件，命中该成片名行后在其块内替换 @out
    let written = false;
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')); } catch (e) { return { ok: false, error: '读取日志失败' }; }
    for (const f of files) {
      const fp = path.join(logDir, f);
      const text = readText(fp);
      const lines = text.split(/\r?\n/);
      let changed = false;
      const vnLow = vn.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const nameLine = lines[i].replace(/\r$/, '').trim();
        if (nameLine.toLowerCase() !== vnLow) continue;
        // 块内 8 行内找 @out（遇 === 止；「使用片段列表：」允许越过，与 _maskOutFromLog 同口径）
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const t = lines[j].replace(/\r$/, '');
          if (t.startsWith('===')) break;
          const m = /^@out:\s*(.+)$/.exec(t);
          if (m) { if (String(m[1]).trim().replace(/^"|"$/g, '') !== found) { lines[j] = '@out: ' + found; changed = true; } break; }
        }
        break; // 同名成片只对应一个块
      }
      if (changed) { atomicWrite(fp, lines.join('\n')); written = true; }
    }
    if (!written) {
      // 日志中无该成片记录：仍返回 ok，前端提示已定位但未改写日志
      return { ok: true, path: found, noLog: true };
    }
    this._maskLogCache = null;
    return { ok: true, path: found };
  }

  // 目录内（含子目录）按文件名（含扩展名，大小写不敏感）查找视频；找到返回完整路径，否则空串
  _findVideoByName(dir, fileName) {
    const target = String(fileName || '').toLowerCase();
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return ''; }
      for (const en of ents) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) { const r = walk(full); if (r) return r; }
        else if (en.isFile() && en.name.toLowerCase() === target && /\.(mp4|mov|avi|mkv|m4v)$/i.test(en.name)) return full;
      }
      return '';
    };
    return walk(dir);
  }

  // 迁移指定遮罩叠加成片到新文件夹：移动文件并同步更新遮罩日志块的 @out 路径
  moveMaskOut(projectPath, videoName, newDir) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    const vn = String(videoName || '').trim();
    const nd = String(newDir || '').trim();
    if (!pdir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    if (!vn || !nd) return { ok: false, error: '缺少成片名或目标目录' };
    if (!fs.existsSync(nd)) { try { fs.mkdirSync(nd, { recursive: true }); } catch (e) { return { ok: false, error: '创建目标目录失败' }; } }
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')); } catch (e) { return { ok: false, error: '读取日志失败' }; }
    for (const f of files) {
      const fp = path.join(logDir, f);
      const src = this._maskOutFromLog(fp, vn) || this._findMaskOut(vn);
      if (!src || !fs.existsSync(src)) continue;
      const ext = path.extname(vn) || '.mp4';
      let dest = path.join(nd, vn);
      let k = 1;
      while (fs.existsSync(dest)) { dest = path.join(nd, path.basename(vn, ext) + '_' + k + ext); k++; }
      try { fs.renameSync(src, dest); } catch (e) { return { ok: false, error: '移动文件失败：' + String(e) }; }
      // 更新日志块 @out 行
      const text = readText(fp);
      const lines = text.split(/\r?\n/);
      const updated = lines.map((l) => {
        const m = /^@out:\s*(.+)$/.exec(l.replace(/\r$/, ''));
        if (m && path.basename(String(m[1]).trim().replace(/^"|"$/g, '')) === vn) return '@out: ' + dest;
        return l;
      });
      atomicWrite(fp, updated.join('\n'));
      return { ok: true, from: src, to: dest };
    }
    return { ok: false, error: '未找到成片：' + vn };
  }

  // 删除二次拼接产物：扫描项目下所有拼接日志/复刻日志，找出片段引用遮罩叠加成片的成片块，
  // 删除对应二次成片文件并同步从日志移除块（成片与日志同目录）
  deleteSecondaryProducts(projectPath, maskOutPaths) {
    const pdir = String(projectPath || '').trim();
    const refs = new Set((Array.isArray(maskOutPaths) ? maskOutPaths : []).map((p) => path.basename(String(p)).toLowerCase()));
    if (!pdir || !refs.size) return { ok: false, error: '未指定引用成片' };
    const deleted = [];
    const removedVideos = [];
    const logFiles = [];
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.name === '遮罩日志') continue;
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full);
        else if (en.isFile() && en.name.endsWith('.txt') && /(拼接日志|复刻日志)/.test(en.name)) logFiles.push(full);
      }
    };
    walk(pdir);
    for (const fp of logFiles) {
      const text = readText(fp);
      const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
      const keep = [];
      const fileVideos = [];   // 本文件命中的成片（不跨文件累积，避免同一成片被重复定位）
      let i = 0;
      let changed = false;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '使用片段列表：') {
          const block = [];
          let j = Math.max(0, i - 1);
          while (j < lines.length) {
            const l = lines[j];
            if (l.trim() === '使用片段列表：' && j !== i) break;
            if (l.trim().startsWith('===')) break;
            block.push(l);
            j++;
            if (j < lines.length && lines[j].trim() === '使用片段列表：') break;
            if (j < lines.length && lines[j].trim().startsWith('===')) { block.push(lines[j]); j++; break; }
          }
          const clips = block.slice(2).filter((l) => l.trim() && /^[A-Za-z]:[\\/]|^\\\\/.test(l.trim()));
          const hit = clips.some((c) => refs.has(path.basename(c.trim()).toLowerCase()));
          if (hit) {
            changed = true;
            const vname = (block[0] || '').trim();
            if (vname) { fileVideos.push(vname); removedVideos.push(vname); }
            i = j;
            continue;
          }
          for (let k = Math.max(0, i - 1); k < j; k++) keep.push(lines[k]);
          i = j;
          continue;
        }
        keep.push(line);
        i++;
      }
      if (changed) {
        const logDir = path.dirname(fp);
        // 先采集清单留痕，再一律移入回收站
        const outs = [];
        for (const vn of fileVideos) {
          const op = path.join(logDir, vn);
          if (fs.existsSync(op)) outs.push(op);
        }
        if (outs.length) {
          const info = this._describeForLog(outs);
          this._lg('DEL', 'secondary.products.remove',
            '删除二次拼接产物 · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes)
            + ' · 日志 ' + path.basename(fp), Object.assign({ project: pdir }, info));
        }
        for (const op of outs) { this._recycleFile(op); deleted.push(op); }
        // 仅剩分隔线/空行时视为已空，移除日志文件（走回收站）；否则原子写回
        const outText = keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
        const hasContent = keep.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()));
        if (hasContent) atomicWrite(fp, outText);
        else this._recycleFile(fp);
      }
    }
    return { ok: true, deleted, videos: removedVideos };
  }

  // 检测应用运行所需的外部环境是否可用（ffmpeg / ffprobe / 内置引擎）
  // 项目实际依赖的滤镜清单（三模块 + 视频处理工具的 -filter_complex 全量收集）
  // 精简版/第三方便携构建常缺 colorchannelmixer、signalstats 等 —— 只查存在性拦不住
  // 内置组件目录：打包形态 = `<程序目录>\resources\ffmpeg`。
  // 由打包配置的 extraResources 随包落入 —— 放 resources 而非 asar，因为引擎要 spawn 真实文件
  //（与 `resources\Engines` 同一套路）。
  // ⚠ 未打包（开发形态）时返回空：`process.resourcesPath` 指向的是 Electron 自己的 resources，
  //   不是本应用，照用会解析到一份不相干的目录。开发形态继续走「数据目录\ffmpeg」。
  _ffmpegBuiltinDir() {
    try {
      const el = require('electron');
      if (!el || !el.app || !el.app.isPackaged) return '';
      const rp = process.resourcesPath || '';
      return rp ? path.join(rp, 'ffmpeg') : '';
    } catch (e) { return ''; }
  }
  /** 内置组件是否就位（两个 exe 都在）—— 供启动探测据此**不再自动下载/升级** */
  ffmpegBuiltinReady() {
    const d = this._ffmpegBuiltinDir();
    if (!d) return false;
    try { return fs.existsSync(path.join(d, 'ffmpeg.exe')) && fs.existsSync(path.join(d, 'ffprobe.exe')); } catch (e) { return false; }
  }
  // 解析 ffmpeg / ffprobe 实际路径。**优先级**：
  //   ① 内置 `resources\ffmpeg\`（随程序发布，首启离线可用）
  //   ② 配置字段 `ffmpeg_dir`（⚠ 配置文件字段，**设置页没有对应 UI**：平时由自动下载/自愈回写，
  //      供手工改 config.json 指定自备的完整版）
  //   ③ 数据目录\ffmpeg（历史下载遗留 —— 仅为兼容旧装机保留，不再是默认）
  // 逐级取**实际存在两个 exe** 的目录，取到即用；这一处即全部真相（环境校验 / 引擎注入 / 产物校验都读它）。
  // ⚠ 仍不得回退系统 PATH：PATH 依赖会造成「主进程判定正常而引擎实际跑不起来」「PATH 项指向不存在的目录」
  //   「机内多份 ffmpeg 副本导致行为不可预期」等一连串意外。
  // 纯同步、极快（几次 existsSync），可安全用于启动路径。
  _resolveFfmpegBin() {
    const cands = [];
    const bi = this._ffmpegBuiltinDir();
    if (bi) cands.push(bi);
    const cfgDir = String((this.config && this.config.ffmpeg_dir) || '').trim();
    if (cfgDir) cands.push(cfgDir);
    const legacy = this._ffmpegTargetDir();
    if (legacy) cands.push(legacy);
    for (const d of cands) {
      const f = path.join(d, 'ffmpeg.exe'), p = path.join(d, 'ffprobe.exe');
      let ok = false;
      try { ok = fs.existsSync(f) && fs.existsSync(p); } catch (e) { ok = false; }
      if (ok) return { cfgDir: d, ffmpegPath: f, ffprobePath: p };
    }
    // 一处都没有：保持旧语义 —— cfgDir 指向「数据目录\ffmpeg」（历史自愈位置），
    // 路径留空由调用方走「组件缺失」提示与（已就位的）自动下载兜底。
    return { cfgDir: legacy || (cands[0] || ''), ffmpegPath: '', ffprobePath: '' };
  }

  // ── 使用前的轻量环境校验（毫秒级：只做 existsSync + where，不启动 ffmpeg 进程）──
  // 启动时的完整探测（checkEnvAsync）只代表「启动那一刻」；环境在运行期间失效
  // （PATH 被改动、组件被移走、安全软件清理入口）时不会重查，只能在使用时兜住 ——
  // 否则要到素材探测失败才暴露，且错误文案会把「探测失败」说成「分辨率/时长不符」。
  quickEnvCheck() {
    const r = this._resolveFfmpegBin();
    return {
      ok: !!r.ffmpegPath && !!r.ffprobePath,
      ffmpeg: !!r.ffmpegPath,
      ffprobe: !!r.ffprobePath,
      ffmpegPath: r.ffmpegPath,
      ffprobePath: r.ffprobePath,
    };
  }
  /** 环境不可用 → 记日志 + 首次提示（横幅/吐司，见 main.js onEnvLost）+ 返回简短拦截文案；可用返回 null */
  _envGuard(where) {
    const q = this.quickEnvCheck();
    if (q.ok) { this._envLostNotified = false; return null; }
    const miss = [!q.ffmpeg && 'FFmpeg', !q.ffprobe && 'FFprobe'].filter(Boolean).join(' / ');
    const brief = miss + ' 不可用';
    try { this._lg('ERR', 'env.lost', brief + ' · ' + String(where || ''), { ffmpeg: q.ffmpeg, ffprobe: q.ffprobe, where: where || '' }); } catch (e) {}
    // 去重：同一次失效只提示一次（任务连发时不刷屏）；恢复可用后自动复位
    if (!this._envLostNotified) {
      this._envLostNotified = true;
      try { if (typeof this.onEnvLost === 'function') this.onEnvLost({ missing: miss, ffmpeg: q.ffmpeg, ffprobe: q.ffprobe, where: where || '' }); } catch (e) {}
    }
    return { ok: false, error: brief + '，请重新下载组件' };
  }

  // 探测缓存：ffmpeg 路径 + 文件 大小/mtime 作指纹，命中即复用，避免每次启动重跑两个 ffmpeg 进程。
  // ⚠ 指纹必须含文件本身的 stat —— 仅用路径会让「重装/升级 ffmpeg 后仍用旧结论」。
  _envProbeFingerprint(ffmpegPath) {
    if (!ffmpegPath) return '';
    try { const st = fs.statSync(ffmpegPath, { bigint: true }); return ffmpegPath + '|' + String(st.size) + '|' + String(st.mtimeMs); }
    catch (e) { return ffmpegPath + '|?'; }
  }

  // 环境检测（**唯一入口**）：滤镜/编码器探测走异步 execFile，不阻塞主进程事件循环。
  // ⚠ 不得改回同步实现 —— 冷启动首次加载 ffmpeg（安全软件扫描未签名二进制）会阻塞
  //   十几秒到数十秒，把窗口显示推迟到分钟级。
  //
  // ⚠ 「探测失败」必须与「确实缺滤镜」分开表达：
  //   探测失败（冷态超时、被杀软拦下、spawn 失败）只说明**这次没探到**，不代表环境不合格。
  //   两者混在一起会这样：超时 → 输出为空 → 把所有必需滤镜都记成 missing → downloadNeeded=true
  //   → 冷启动**必然**误报「FFmpeg 组件不完整」，而热态重跑却一切正常。
  checkEnvAsync() {
    const { cfgDir, ffmpegPath, ffprobePath } = this._resolveFfmpegBin();
    const finish = (missing, missingEncoders, probeFailed, probeReason) => {
      const realMissing = missing.length > 0 || missingEncoders.length > 0;
      return {
        ffmpeg: !!ffmpegPath,
        ffprobe: !!ffprobePath,
        engine: !!this._engineRunnerPath(),
        ffmpegPath, ffprobePath,
        filtersOk: !!ffmpegPath && !probeFailed && missing.length === 0,
        encodersOk: !!ffmpegPath && !probeFailed && missingEncoders.length === 0,
        missing, missingEncoders,
        probeFailed: !!probeFailed,
        probeReason: probeReason || '',
        // 只有「确证缺失」才建议下载：路径不存在，或探测**成功**却确实缺项
        downloadNeeded: !ffmpegPath || !ffprobePath || realMissing,
        ffmpegDir: cfgDir,
      };
    };
    if (!ffmpegPath) return Promise.resolve(finish([], [], false, ''));
    const fp = this._envProbeFingerprint(ffmpegPath);
    if (this._envProbeCache && this._envProbeCache.fp === fp) {
      const c = this._envProbeCache;
      return Promise.resolve(finish(c.missing.slice(), c.missingEncoders.slice(), false, ''));
    }
    // 持久化命中（verify_cache 的 env:ffmpeg，按 ffmpeg 路径 + size/mtime 指纹）：
    // 启动期直接复用上次结论 —— **不再起 ffmpeg 进程**（实测省 347ms，且彻底消除冷态超时误报）。
    if (fp && this._useDbCache() && this._cacheStore && typeof this._cacheStore.verifyGetMany === 'function') {
      try {
        const row = this._cacheStore.verifyGetMany('env:ffmpeg').get('env:ffmpeg');
        if (row && row.fp === fp && row.result) {
          const c = JSON.parse(row.result) || {};
          const missing = Array.isArray(c.missing) ? c.missing : [];
          const missingEncoders = Array.isArray(c.missingEncoders) ? c.missingEncoders : [];
          this._envProbeCache = { fp, missing: missing.slice(), missingEncoders: missingEncoders.slice(), at: Date.now() };
          const r = finish(missing, missingEncoders, false, '');
          try {
            if (this._lg) this._lg('SYS', 'env.probe', 'FFmpeg 环境探测 · 命中缓存（未启动 ffmpeg 进程）· 缺滤镜 ' + missing.length + ' 项 / 缺编码器 ' + missingEncoders.length + ' 项', { cached: true });
          } catch (e) {}
          return Promise.resolve(r);
        }
      } catch (e) {}
    }
    if (this._envProbeInflight) return this._envProbeInflight;   // 并发合并：同时多处调用只跑一轮
    const startedAt = Date.now();
    const run = (args) => new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const p = require('child_process').execFile(ffmpegPath, args,
          { windowsHide: true, timeout: ENV_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => {
            if (err) settle({ ok: false, reason: err.killed ? 'timeout' : 'error' });
            else settle({ ok: true, out: String(stdout || '') });
          });
        p.on('error', () => settle({ ok: false, reason: 'spawn' }));
      } catch (e) { settle({ ok: false, reason: 'spawn' }); }
    });
    this._envProbeInflight = (async () => {
      // 两个探测可并行：互不依赖，串行只会让耗时翻倍
      const [rf, re] = await Promise.all([run(['-hide_banner', '-filters']), run(['-hide_banner', '-encoders'])]);
      const missing = [];
      const missingEncoders = [];
      // 探测成功才逐项比对；失败时不塞 missing（那是"没探到"，不是"缺失"）
      if (rf.ok) for (const f of FFMPEG_REQUIRED_FILTERS) if (!rf.out.includes(' ' + f + ' ')) missing.push(f);
      if (re.ok) for (const e3 of FFMPEG_REQUIRED_ENCODERS) if (!re.out.includes(' ' + e3 + ' ')) missingEncoders.push(e3);
      const probeFailed = !rf.ok || !re.ok;
      const probeReason = !rf.ok ? rf.reason : (!re.ok ? re.reason : '');
      // 失败结果**不写缓存**：下次调用（前端 check_env / 启动期延迟重试）会再探一次 ——
      // 冷态超时通常几秒后就转热，缓存失败结论等于把误判钉死到进程重启。
      this._envProbeCache = probeFailed
        ? null
        : { fp, missing: missing.slice(), missingEncoders: missingEncoders.slice(), at: Date.now() };
      // 成功结论**持久化**（按 ffmpeg 路径 + size/mtime 指纹）：下次启动直接复用，不再起 ffmpeg 进程。
      // 失败仍不写（见上），避免把冷态误判钉死。
      if (!probeFailed && fp && this._useDbCache() && this._cacheStore && typeof this._cacheStore.verifyPut === 'function') {
        try {
          this._cacheStore.verifyPut('env:ffmpeg', fp, JSON.stringify({ missing: missing.slice(), missingEncoders: missingEncoders.slice() }), 0, Date.now());
        } catch (e) {}
      }
      this._envProbeInflight = null;
      const r = finish(missing, missingEncoders, probeFailed, probeReason);
      this._logEnvProbe(r, Date.now() - startedAt);
      return r;
    })();
    return this._envProbeInflight;
  }

  // 环境探测留痕：冷启动是否超时、超时多久、路径是什么 —— 事后唯一可回溯的证据
  // （进程重启后内存缓存即失效，只靠"弹窗出现过"无法判断是缺组件还是冷态没探到）
  _logEnvProbe(r, ms) {
    try {
      this._lg(r.probeFailed ? 'ERR' : 'SYS', 'env.probe',
        'FFmpeg 环境探测 · ' + (r.probeFailed ? '失败（' + r.probeReason + '）' : '完成')
        + ' · ' + ms + 'ms · ffmpeg=' + (r.ffmpeg ? '有' : '无') + ' ffprobe=' + (r.ffprobe ? '有' : '无')
        + ' · 缺滤镜 ' + r.missing.length + ' 项 / 缺编码器 ' + r.missingEncoders.length + ' 项'
        + ' · 需下载=' + (r.downloadNeeded ? '是' : '否'),
        { ms, probeFailed: r.probeFailed, probeReason: r.probeReason, path: r.ffmpegPath || '',
          missing: r.missing.slice(0, 12), missingEncoders: r.missingEncoders.slice(0, 6),
          downloadNeeded: r.downloadNeeded });
    } catch (e) {}
  }

  // 注：环境检测唯一入口 = checkEnvAsync()；不要引入同步实现 —— 同步 spawn 会阻塞启动关键路径。

  // 备份自动清理：删除超过保留天数的处理前备份（走回收站，可还原）；
  // 目录取设置里的「默认备份目录」，未设置时用数据目录下的 backup
  _cleanupBackups() {
    try {
      if (this.config.backup_auto_clean !== true) return;
      const days = parseInt(this.config.backup_keep_days, 10) || 7;
      // 与实际备份根一致：用户自选目录时同样落在其下的「Video Lab 备份」层（清理才清得到）
      const root = this.getBackupRoot();
      if (!fs.existsSync(root)) return;
      // ⚠ 必须在此取 shell：本文件没有模块级引入 electron，直接用 `shell` 会得到 undefined，
      //   条件恒假 → 只计数不删除（实测：保留 3 天，6 天前的备份一个都没清掉）。
      const { shell } = require('electron');
      const expire = Date.now() - days * 24 * 60 * 60 * 1000;
      let n = 0;
      const walk = (d) => {
        for (const name of fs.readdirSync(d)) {
          const p2 = path.join(d, name);
          let st = null;
          try { st = fs.statSync(p2); } catch (e) { continue; }
          if (st.isDirectory()) { walk(p2); continue; }
          if (st.mtimeMs < expire) {
            if (shell && typeof shell.trashItem === 'function') shell.trashItem(p2).catch(() => {});
            n++;
          }
        }
      };
      walk(root);
      if (n) this._lg('DEL', 'backup.cleanup', '清理过期备份 · ' + n + ' 个文件 · 保留 ' + days + ' 天');
    } catch (e) {}
  }

  // 备份自动清理（异步版）：供**启动后台**调用。
  // 为什么需要：同步版只在「视频处理任务结束后」触发（见 _cleanupBackups 调用点）——
  //   若用户此后不再跑视频处理任务，过期备份永远不会被清理（实测：设为保留 3 天，
  //   6 天前的备份仍原样留在目录里）。启动路径也不能同步遍历（备份目录可能在机械盘），
  //   故用 fs.promises 后台跑，与成片存在性预热同一模式。
  async _cleanupBackupsAsync() {
    try {
      if (this.config.backup_auto_clean !== true) return 0;
      const days = parseInt(this.config.backup_keep_days, 10) || 7;
      const root = this.getBackupRoot();
      let exists = false;
      try { exists = (await fs.promises.stat(root)).isDirectory(); } catch (e) { exists = false; }
      if (!exists) return 0;
      // ⚠ 同上：本文件无模块级 electron 引入，必须在此取 shell，否则只是空转计数。
      const { shell } = require('electron');
      const expire = Date.now() - days * 24 * 60 * 60 * 1000;
      let n = 0;
      const walk = async (d) => {
        let names = [];
        try { names = await fs.promises.readdir(d); } catch (e) { return; }
        for (const name of names) {
          const p2 = path.join(d, name);
          let st = null;
          try { st = await fs.promises.stat(p2); } catch (e) { continue; }
          if (st.isDirectory()) { await walk(p2); continue; }
          if (st.mtimeMs < expire) {
            if (shell && typeof shell.trashItem === 'function') { try { await shell.trashItem(p2); n++; } catch (e) {} }
          }
        }
      };
      await walk(root);
      if (n) this._lg('DEL', 'backup.cleanup', '清理过期备份 · ' + n + ' 个文件 · 保留 ' + days + ' 天');
      return n;
    } catch (e) { return 0; }
  }

  // 启动后台：把「数据目录 backup\ 里的存量备份」迁到用户当前设置的备份根。
  // 为什么需要单独这一步：`migrateBackups` 只在**保存设置时值发生变化**才触发，
  //   而用户早就设好了自定义根 —— 于是老版本写进数据目录的那批备份（画布合成路径当年不读设置，
  //   一律落数据目录）在升级后**永远不会被搬走**，一直占着数据目录，用户也看不出该去哪找。
  // 条件：仅在用户设了自定义根时迁移（没设时数据目录就是正确位置，动它反而错）。
  // 幂等：源目录不存在时 migrateBackups 直接返回 0；迁移后只删已空目录。
  async migrateLegacyBackupsAsync() {
    try {
      const custom = String(this.config.backup_dir || '').trim();
      if (!custom) return 0;
      const n = await this.migrateBackups('', custom);   // rootOf('') = 数据目录 backup
      if (n > 0) {
        try {
          this._lg('SYS', 'backup.migrate.legacy',
            '已把数据目录下的存量备份迁至当前备份根（' + n + ' 个文件）', { to: this.getBackupRoot(), files: n });
        } catch (e) {}
      }
      return n;
    } catch (e) { return 0; }
  }

  // 备份目录变更时迁移旧备份：把旧备份根下的内容搬到新根（改了路径，里面的备份一起迁移）。
  // 逐文件移动（rename 优先，跨盘失败退回「复制 + 删源」）；同名文件保留新目录已有内容（不覆盖）。
  // ⚠ 迁移完成后只删除**已空**的旧目录（绝不 rm -rf 有内容的目录），避免中途失败时丢备份。
  // 异步执行（备份可能很多且跨盘），调用方不等待、不阻塞保存设置。
  async migrateBackups(oldDir, newDir) {
    try {
      const rootOf = (d) => {
        const c = String(d || '').trim();
        return c ? path.join(c, 'Video Lab 备份')
          : path.join(this.storageDir || process.cwd(), 'backup');
      };
      const from = rootOf(oldDir), to = rootOf(newDir);
      if (path.resolve(from) === path.resolve(to)) return 0;   // 同一位置：无需迁移
      let ok = false;
      try { ok = (await fs.promises.stat(from)).isDirectory(); } catch (e) { ok = false; }
      if (!ok) return 0;                                       // 旧目录不存在：无内容可迁
      await fs.promises.mkdir(to, { recursive: true });
      let n = 0;
      const walk = async (rel) => {
        const srcDir = path.join(from, rel);
        let names = [];
        try { names = await fs.promises.readdir(srcDir); } catch (e) { return; }
        for (const name of names) {
          const r = rel ? path.join(rel, name) : name;
          const s = path.join(from, r), t = path.join(to, r);
          let st = null;
          try { st = await fs.promises.stat(s); } catch (e) { continue; }
          if (st.isDirectory()) {
            try { await fs.promises.mkdir(t, { recursive: true }); } catch (e) {}
            await walk(r);
            continue;
          }
          let exists = false;
          try { exists = (await fs.promises.stat(t)).isFile(); } catch (e) { exists = false; }
          if (exists) continue;                                // 目标已存在同名文件：保留目标的
          try { await fs.promises.rename(s, t); n++; }
          catch (e) {
            try { await fs.promises.copyFile(s, t); await fs.promises.unlink(s); n++; } catch (e2) {}
          }
        }
      };
      await walk('');
      // 只清理已空的旧目录壳（逐层判断，非空一律保留）
      const pruneEmpty = async (d) => {
        let names = [];
        try { names = await fs.promises.readdir(d); } catch (e) { return; }
        for (const nm of names) {
          const p2 = path.join(d, nm);
          let st = null;
          try { st = await fs.promises.stat(p2); } catch (e) { continue; }
          if (st.isDirectory()) await pruneEmpty(p2);
        }
        try { if (!(await fs.promises.readdir(d)).length) await fs.promises.rmdir(d); } catch (e) {}
      };
      await pruneEmpty(from);
      if (n) this._lg('SYS', 'backup.migrate', '备份目录迁移 · ' + n + ' 个文件', { from, to });
      return n;
    } catch (e) { return 0; }
  }

  // 过期锁清理：进程被强杀（崩溃 / 任务管理器结束）时 finally 不执行，锁文件会残留下来；
  // 而 .locks 目录只建不删 —— 残留会一直累积，用户也无从清理。
  // 判定与 acquireLock 的过期规则一致：pid 不存活 或 写入时间超过 60 秒
  _cleanupStaleLocks() {
    try {
      const dir = path.join(this.storageDir || process.cwd(), '.locks');
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (!/\.lock$/i.test(name)) continue;
        const lockFile = path.join(dir, name);        // 锁文件是进程间同步用的临时控制文件，非业务数据
        let st = null;
        try { st = fs.statSync(lockFile); } catch (e) { continue; }
        if (!st || !st.isFile()) continue;
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (e) { holder = null; }
        let alive = false;
        if (holder && holder.pid) {
          try { process.kill(holder.pid, 0); alive = true; } catch (e) { alive = (e && e.code === 'EPERM'); }
        }
        const stale = !alive || (Date.now() - (st.mtimeMs || 0) > 60 * 1000);
        if (stale) { try { fs.unlinkSync(lockFile); } catch (e) {} }
      }
    } catch (e) {}
  }

  // ── 应用级设置（settings.db scope='app'）──
  // 设置项能进 settings 就进 settings —— config.json 只留「定位数据目录」的锚点，
  // 其余业务键一律存 settings.db，读取只认 settings、**不回退读 config.json**。
  // ⚠ 不要引入「回退读 config」：config 一旦被裁掉某键，回退路径就取到 undefined，
  // 表现为设置莫名丢失或软件报错；保持单一真相源，未来简化 config 也不会波及设置项。
  // 白名单仅供 main 端 get_settings 组装默认值时参考；读写本身不限键（任意键均可存取）。
  static APP_SETTING_KEYS = ['notify_task_end',
    'backup_dir', 'backup_auto_clean', 'backup_keep_days', 'cache_keep_days'];

  // 启动时把 settings.db 的 app scope 全量载入内存 config（覆盖 DEFAULT_CONFIG 的默认值）。
  // 未落过库的键保持默认值 —— 这就是「不回退 config」后的取值语义：
  // 库里有就用库里的，库里没有就用默认值，绝不回头读 config.json。
  _loadAppSettings() {
    if (!this._useSettings()) return;
    let all = {};
    try { all = this._settingsStore.all('app') || {}; } catch (e) { all = {}; }
    for (const k of Object.keys(all)) {
      if (all[k] === undefined || all[k] === null) continue;
      this.config[k] = all[k];
    }
  }

  // 单个应用级设置的读取 —— 供 main 的 get_settings / 通知开关等使用。
  // fallback 只在「设置库不可用」这一极端情形下使用（此时内存 config 也仅有默认值）。
  getAppSetting(key, fallback) {
    if (this._useSettings()) {
      const v = this._settingsStore.get('app', key);
      if (v !== undefined && v !== null) return v;
    }
    return (this.config && this.config[key] !== undefined) ? this.config[key] : fallback;
  }

  // 全量读取 app scope（供 main 端组装完整配置：settings.db 是唯一来源）
  getAppSettings() {
    if (!this._useSettings()) return {};
    try { return this._settingsStore.all('app') || {}; } catch (e) { return {}; }
  }

  // 写入任意应用级设置（不限键）：main 端保存配置时逐键落库。
  // 显式传对象而非默认取 this.config —— main.config 与 backend.config 是两个对象，
  // 保存时必须由调用方给出要写的键值，避免两边不同步。
  _saveAppSettings(values) {
    if (!this._useSettings()) return;
    const vals = (values && typeof values === 'object') ? values : {};
    for (const k of Object.keys(vals)) {
      if (vals[k] === undefined) continue;
      try { this._settingsStore.set('app', k, vals[k]); } catch (e) {}
    }
  }

  // 删除应用级设置键（供一次性迁移用：旧键搬走后不留残留，保持「单一真相」）
  _removeAppSetting(key) {
    if (!this._useSettings()) return false;
    try { return Number(this._settingsStore.remove('app', String(key))) > 0; } catch (e) { return false; }
  }

  // Windows 系统通知（任务失败 / 本轮跑完）：
  // 走主进程 Notification（app.setAppUserModelId 已在 main 设置，通知才能正常显示）。
  // 通知不可用时静默 —— 提示失败绝不能影响任务流本身
  _notify(title, body) {
    try {
      // 开关：设置的 notify_task_end —— **默认开启**（设置页「通用设置」里可关）
      if (!(this.config && this.config.notify_task_end === true)) return;
      const { Notification } = require('electron');
      if (!Notification || (Notification.isSupported && !Notification.isSupported())) return;
      new Notification({ title: String(title || ''), body: String(body || '') }).show();
      this._lg('RUN', 'notify', '系统通知 · ' + title + ' · ' + String(body || '').slice(0, 60));
    } catch (e) {}
  }

  _ffmpegTargetDir() {
    return path.join(this.storageDir || process.cwd(), 'ffmpeg');
  }

  // 引擎子进程的 FFmpeg 路径注入：**唯一来源**（引擎侧已无 PATH 回退 —— 缺注入即明确报「组件缺失」，
  // 不会静默借用系统 PATH，避免出现「主进程判定与引擎实际使用不一致」）
  _ffmpegBinEnv() {
    // 与 _resolveFfmpegBin 同源（含「默认自愈目录」兜底）：主进程判定与引擎实际使用的必须是同一份
    const { ffmpegPath, ffprobePath } = this._resolveFfmpegBin();
    const out = {};
    if (ffmpegPath) out.VL_FFMPEG_BIN = ffmpegPath;
    if (ffprobePath) out.VL_FFPROBE_BIN = ffprobePath;
    return out;
  }

  // 环境自愈：下载 FFmpeg / FFprobe（npmmirror 国内镜像，gzip 单文件用内置 zlib 解压）
  // 到数据目录 ffmpeg\ 并写回 ffmpeg_dir 配置；失败回滚配置，不留半成品路径
  async ensureFfmpeg(opts) {
    const force = !!(opts && opts.force);
    if (this._ffmpegBusy) return { ok: false, error: '已有 FFmpeg 修复在进行中' };
    const env0 = await this.checkEnvAsync();
    // force：用户显式点「自动下载」——跳过合格检查强制走完整下载（演示/重装数据目录组件）
    if (!force && !env0.downloadNeeded) return { ok: true, skipped: true, env: env0 };
    this._ffmpegBusy = true;
    const emit = (p) => { try { if (typeof this.onFfmpegProgress === 'function') this.onFfmpegProgress(p); } catch (e) {} };
    // A3'：**下载落点改为内置目录 `resources\ffmpeg`**。
    //   内置组件是唯一权威，缺了就地修复即可 —— 不该在数据目录再养一份副本（那正是刚被清掉的 310MB 的来源）。
    //   仅当内置目录**不可写**（装到受保护位置 / 盘只读）才退回数据目录。
    // 可写性必须实测：`existsSync` 判不出"目录只读"，要真写一个探测文件再删。
    const biDir = this._ffmpegBuiltinDir();
    let dir = this._ffmpegTargetDir();
    let toBuiltin = false;
    if (biDir) {
      try {
        fs.mkdirSync(biDir, { recursive: true });
        const probe = path.join(biDir, '.write-probe');
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        dir = biDir; toBuiltin = true;
      } catch (e) { toBuiltin = false; }
    }
    const prevDir = String(this.config.ffmpeg_dir || '');
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 落内置目录时**不写** ffmpeg_dir：解析本来就优先内置（见 _resolveFfmpegBin），
      // 写了反而留下一条指向"数据目录那份"的旧配置；只有退回数据目录时才需要写。
      if (!toBuiltin) this.config.ffmpeg_dir = dir;
      emit({ phase: 'check' });
      // ── 主源：npmmirror 的 FFmpeg-Builds 镜像（BtbN 构建，国内可直连，版本可达 8.x）──
      // 旧的 ffmpeg-static 镜像**最高只有 6.1.1**，而 6.1.1 的进度行**不含 elapsed（实际耗时）**，
      // 界面那一行「已用时」会永远为空 → 故换此源。
      // 组件仍然**自带**在数据目录 ffmpeg\，**不依赖系统 PATH**（系统 PATH 可能中途异常/被清除，
      // 这正是当初做自动下载的原因 —— 不要改成"优先用系统上的那份"）。
      let ver = '';
      let src = 'npmmirror:ffmpeg-static';   // 实际使用的源，写入 _meta.json 供事后核对
      try {
        const pick = await this._pickFfmpegBuilds();
        if (pick) {
          const url = 'https://registry.npmmirror.com/-/binary/ffmpeg-builds/' + pick.ver + '/' + pick.file;
          await this._downloadFile(url, path.join(dir, '_ffmpeg.tar.xz'), (pct) => {
            emit({ phase: 'download', file: 'ffmpeg-builds', percent: Math.min(80, Math.round(pct * 0.8)) });
          });
          await this._extractFfmpegBuild(path.join(dir, '_ffmpeg.tar.xz'), dir);
          ver = String(pick.ver).replace(/^v/, '');
          src = 'npmmirror:ffmpeg-builds';
        }
      } catch (e) {
        this._lg('ENV', 'ffmpeg.ensure', 'FFmpeg-Builds 源失败，回退 ffmpeg-static · ' + String((e && e.message) || e));
      }
      try { fs.rmSync(path.join(dir, '_ffmpeg.tar.xz'), { force: true }); } catch (e) {}
      // 回退：ffmpeg-static（gzip 单文件，内置 zlib 解压）—— 最高 6.1.1，但一定能用
      if (!ver) {
        let v = 'b6.1.1';
        try {
          const list = await this._httpGetJson('https://registry.npmmirror.com/-/binary/ffmpeg-static/');
          const vers = (list || []).map((x) => String(x.name || ''))
            .filter((n) => /^b[\d.]+\/$/.test(n)).map((n) => n.replace(/\/$/, ''))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          if (vers.length) v = vers[vers.length - 1];
        } catch (e) {}
        const base = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/' + v + '/';
        let pctBase = 0;
        for (const pair of [['ffmpeg-win32-x64.gz', 'ffmpeg.exe'], ['ffprobe-win32-x64.gz', 'ffprobe.exe']]) {
          await this._downloadGunzip(base + pair[0], path.join(dir, pair[1]), (pct) => {
            emit({ phase: 'download', file: pair[1], percent: Math.min(99, Math.round(pctBase + pct / 2)) });
          });
          pctBase += 50;
        }
        ver = v;
      }
      const env1 = await this.checkEnvAsync();
      if (env1.downloadNeeded) throw new Error('下载完成但校验未通过：' + (env1.missing || []).join('、'));
      // 落地元信息（_meta.json）：事后可核对「两个版本用的是不是同一份组件 / 何时下载的 / 版本号」，
      // 双版本共用数据目录时，这份记录是「用的是不是同一份组件」的唯一凭据
      try {
        const meta = { version: ver, downloadedAt: new Date().toISOString(), source: src, files: {} };
        for (const n of ['ffmpeg.exe', 'ffprobe.exe']) {
          const st = fs.statSync(path.join(dir, n));
          meta.files[n] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
        }
        atomicWrite(path.join(dir, '_meta.json'), JSON.stringify(meta, null, 2) + '\n');
      } catch (e) {}
      emit({ phase: 'done', ok: true, dir: dir, version: ver });
      this._lg('ENV', 'ffmpeg.ensure', 'FFmpeg 环境就绪 · ' + ver + ' · ' + dir, { dir: dir, version: ver });
      return { ok: true, dir: dir, version: ver, env: env1 };
    } catch (e) {
      if (!toBuiltin) this.config.ffmpeg_dir = prevDir;   // 没改过它就不回滚（落内置目录时压根没写）
      emit({ phase: 'error', error: String((e && e.message) || e) });
      this._lg('ERR', 'ffmpeg.ensure', 'FFmpeg 自动下载失败 · ' + String((e && e.message) || e), { dir: dir, toBuiltin: toBuiltin });
      return { ok: false, error: String((e && e.message) || e) };
    } finally { this._ffmpegBusy = false; }
  }

  /**
   * 从 npmmirror 的 FFmpeg-Builds 镜像挑最新的 Windows x64 构建（BtbN 出品，国内可直连）。
   * 目录形如 v6.1.3/ v7.1.5/ v8.1.3/（含 v8.1/ 这类聚合项，跳过）。
   */
  async _pickFfmpegBuilds() {
    const list = await this._httpGetJson('https://registry.npmmirror.com/-/binary/ffmpeg-builds/');
    const vers = (list || []).map((x) => String(x.name || '').replace(/\/$/, ''))
      .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => {
        const pa = a.replace(/^v/, '').split('.').map(Number);
        const pb = b.replace(/^v/, '').split('.').map(Number);
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
        return 0;
      });
    if (!vers.length) return null;
    for (let i = vers.length - 1; i >= 0; i--) {
      const ver = vers[i];
      const n = String(ver).replace(/^v/, '');
      // 全功能（gpl）版：编码要用 libx264 等；只用静态包（非 shared，免带 dll）
      const file = 'ffmpeg-' + n + '-win32-x64-gpl.tar.xz';
      try {
        const items = await this._httpGetJson('https://registry.npmmirror.com/-/binary/ffmpeg-builds/' + ver + '/');
        if ((items || []).some((x) => String(x.name || '') === file)) return { ver: ver, file: file };
      } catch (e) {}
    }
    return null;
  }

  /** 下载到文件（一次性缓冲；仅在组件自愈时用，140MB 级一次性操作可接受） */
  _downloadFile(url, dest, onPct) {
    return new Promise((resolve, reject) => {
      this._httpGet(url, (buf) => {
        try { fs.writeFileSync(dest, buf); resolve(dest); } catch (e) { reject(e); }
      }, reject);
    }).then((r) => { if (typeof onPct === 'function') onPct(100); return r; });
  }

  /**
   * 解压 FFmpeg-Builds 的 tar.xz 并取出 ffmpeg.exe / ffprobe.exe 到目标目录。
   * 用 Windows 自带的 tar.exe（bsdtar，支持 xz）—— 不引入新依赖，也不依赖系统 PATH 上的 7z。
   * 压缩包内结构：<name>/bin/ffmpeg.exe
   */
  _extractFfmpegBuild(archive, destDir) {
    return new Promise((resolve, reject) => {
      const tmp = path.join(destDir, '_xtmp');
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      fs.mkdirSync(tmp, { recursive: true });
      const { execFile } = require('child_process');
      execFile('tar', ['-xf', archive, '-C', tmp], { windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, (err) => {
        if (err) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {} return reject(new Error('解压失败：' + String(err.message || err))); }
        try {
          const find = (name) => {
            const stack = [tmp];
            while (stack.length) {
              const d = stack.pop();
              let ents = [];
              try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
              for (const e of ents) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) stack.push(p);
                else if (String(e.name).toLowerCase() === name) return p;
              }
            }
            return '';
          };
          const f1 = find('ffmpeg.exe'), f2 = find('ffprobe.exe');
          if (!f1 || !f2) throw new Error('包内缺少 ffmpeg.exe / ffprobe.exe');
          fs.copyFileSync(f1, path.join(destDir, 'ffmpeg.exe'));
          fs.copyFileSync(f2, path.join(destDir, 'ffprobe.exe'));
          fs.rmSync(tmp, { recursive: true, force: true });
          resolve(true);
        } catch (e2) {
          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e3) {}
          reject(e2);
        }
      });
    });
  }

  _httpGetJson(url) {
    return new Promise((resolve, reject) => {
      this._httpGet(url, (buf) => {
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); }
      }, reject);
    });
  }

  _httpGet(url, onOk, onErr) {
    const mod = url.indexOf('https:') === 0 ? require('node:https') : require('node:http');
    const req = mod.get(url, { headers: { 'User-Agent': 'VideoLab' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); this._httpGet(res.headers.location, onOk, onErr); return;
      }
      if (res.statusCode !== 200) { res.resume(); onErr(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => onOk(Buffer.concat(chunks)));
      res.on('error', onErr);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', onErr);
  }

  // 下载 gz → 流式解压写盘；进度按 5% 步进回调
  _downloadGunzip(url, dest, onPct) {
    return new Promise((resolve, reject) => {
      const get = (u, n) => {
        const mod = u.indexOf('https:') === 0 ? require('node:https') : require('node:http');
        const req = mod.get(u, { headers: { 'User-Agent': 'VideoLab' }, timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 5) {
            res.resume(); get(res.headers.location, n + 1); return;
          }
          if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
          const zlib = require('node:zlib');
          const total = parseInt(res.headers['content-length'], 10) || 0;
          const chunks = []; let got = 0, last = 0;
          res.on('data', (c) => {
            got += c.length; chunks.push(c);
            const pct = total ? Math.floor((got / total) * 100) : 0;
            if (pct - last >= 5) { last = pct; if (onPct) onPct(pct); }
          });
          res.on('end', () => {
            try { fs.writeFileSync(dest, zlib.gunzipSync(Buffer.concat(chunks))); resolve(); }
            catch (e) { reject(e); }
          });
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('下载超时')));
        req.on('error', reject);
      };
      get(url, 0);
    });
  }
}

module.exports = { Api, DEFAULT_CONFIG };
