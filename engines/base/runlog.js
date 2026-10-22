// 运行日志（面向排查）：行格式与级别说明见下。
//
// 文件划分（<存储根>\log\）：
//   app-YYYY-MM-DD.log      **给人看**的事件流（一行一事），保留 7 天
//   error-YYYY-MM-DD.log    lvl>=warn 与失败/异常事件的**索引行**（短正文副本 + ref），保留 30 天
//   engine-YYYY-MM-DD.log   引擎原始 stdout/stderr（[taskId] 前缀 + 任务标记 + ffmpeg 行秒级采样），保留 7 天
//   超 32MB 滚动为 -2/-3 序号；跨天未超保留期的旧文件压缩为 .gz（pruneAsync，空闲期调用）
//
// 行格式：`2026-09-30 15:30:01.123  info  backend  task.artifacts.remove  删 3 个成片 · 共 264.1 MB  · {json}`
//   └ 时间(毫秒)            └ lvl  └ mod     └ ev(点分)            └ msg                     └ 结构化字段
// 级别：fatal/error/warn/info/debug（小写）；默认 info，setLevel 运行时切换。
// 写入：error/warn/fatal 同步追加（事后唯一证据）；info/debug 缓冲 500ms/256 条批量落盘，exit 时冲刷。
// 去重：正文只在 app 落一次；error 只写索引行（短正文副本 + ref:app@<字节偏移>）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const KEEP_DAYS = 7;
const ERROR_KEEP_DAYS = 30;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const FLUSH_MS = 500;
const FLUSH_MAX = 256;

const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 };
let _level = LEVELS.info;

let logDir = '';
let _buf = [];
let _flushTimer = null;

function init(dir) {
  logDir = String(dir || '');
  if (!logDir) return;
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
}

function setLevel(lvl) { if (lvl in LEVELS) _level = LEVELS[lvl]; }
function getLevel() { return Object.keys(LEVELS).find((k) => LEVELS[k] === _level) || 'info'; }

function pad(n, w) { return String(n).padStart(w, '0'); }
function dayOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2); }
function stampOf(d) {
  return dayOf(d) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2)
    + '.' + pad(d.getMilliseconds(), 3);
}
function fileOf(day) { return path.join(logDir, 'app-' + day + '.log'); }
function errFileOf(day) { return path.join(logDir, 'error-' + day + '.log'); }
function engineFileOf(day) { return path.join(logDir, 'engine-' + day + '.log'); }


/** 敏感值脱敏：令牌/口令不入日志（JSON 形态与裸键形态两道） */
function scrub(s) {
  return String(s == null ? '' : s)
    .replace(/("(?:[a-z_]*token[a-z_]*|password|passwd|secret)"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/\b((?:[a-z_]*token[a-z_]*|password|passwd|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1***');
}

/** 结构化细节压成单行 + 脱敏；超长不截断：分片多行（↳[i/n]），语义不丢 */
function briefData(data, max = 2000) {
  if (data == null) return '';
  try {
    const s = scrub(typeof data === 'string' ? data : JSON.stringify(data));
    if (s === '{}' || s === 'null' || s === '""') return '';
    if (s.length <= max) return s;
    const chunks = [];
    for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max));
    const padsp = ' '.repeat(24) + '↳ ';
    let out = chunks[0];
    for (let k = 1; k < chunks.length; k++) out += '\n' + padsp + '[' + (k + 1) + '/' + chunks.length + '] ' + chunks[k];
    return out;
  } catch (e) { return ''; }
}

/** 通道入参/结果摘要：脱敏 + 单行 + 截断（IPC 与 HTTP 共用） */
function briefArgs(v, max) {
  try {
    if (v == null) return '';
    const s = scrub(typeof v === 'string' ? v : JSON.stringify(v));
    if (!s || s === '{}' || s === '[]' || s === 'null' || s === '""') return '';
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (e) { return ''; }
}

// 只读/展示类通道不记（轮询防噪音）
// ⚠ report_ui_error 也在此列：它是上报通道，内容已由 kind=action 分支单独落成 UIA/ERR 一条；
//   若再走通用 IPC 访问日志，每次界面动作都会额外产出一条 error 级的 `report_ui_error http · ok`，
//   把 error 文件（保留 30 天、排查首看）冲成噪音。
const SILENT_CHANNEL = /^(list_|get_|read_|open_|window_|check_|resolve_|search_|find_|locate_|precheck|scan_|respond_|ack_|on_|task_replica_outdir|report_ui_error)/;
function isSilentChannel(ch) { return SILENT_CHANNEL.test(String(ch == null ? '' : ch)); }

// 配置保存类通道只记「变更了的键」（IPC 与 HTTP 共用一份快照）
const SETTINGS_DELTA_CHANNEL = /^save_(settings|mask_session)$/;
let _lastSettingsSnap = '';
function deltaArgs(channel, args) {
  if (!SETTINGS_DELTA_CHANNEL.test(String(channel == null ? '' : channel))) return args;
  const cur = args && args[0];
  if (!cur || typeof cur !== 'object') return args;
  let prev = {};
  try { prev = JSON.parse(_lastSettingsSnap || '{}'); } catch (e) { prev = {}; }
  const keys = new Set(Object.keys(prev).concat(Object.keys(cur)));
  const delta = {};
  let n = 0;
  for (const k of keys) {
    if (JSON.stringify(prev[k]) === JSON.stringify(cur[k])) continue;
    delta[k] = cur[k];
    n++;
  }
  try { _lastSettingsSnap = JSON.stringify(cur); } catch (e) {}
  return n ? [delta] : [];
}

/** 通道调用留痕（IPC 与 HTTP 共用）：回答"用户到底点了什么"，只读通道跳过 */
function chEvent(transport, channel, args, result, ms) {
  try {
    if (isSilentChannel(channel)) return;
    const failed = !!(result && typeof result === 'object' && result.ok === false);
    const payload = briefArgs(deltaArgs(channel, args), 700);
    const res = briefArgs(result, 300);
    logEvent('IPC', String(channel),
      String(transport) + ' · ' + (failed ? '失败' : 'ok') + ' · ' + (Number(ms) || 0) + 'ms'
      + (failed && result && result.error ? ' · ' + String(result.error).slice(0, 160) : '')
      + (payload ? ' · 入参 ' + payload : ''),
      res ? { result: res } : null);
  } catch (e) { /* 静默 */ }
}

// ── 核心写入 ──

const VERB_LVL = { ERR: 'error', UI: 'error', UIA: 'info', DIAG: 'info', SYS: 'info', RUN: 'info', ADD: 'info', MOD: 'info', CFG: 'info', DEL: 'info', IPC: 'info' };

/** 单文件 32MB → -2/-3 滚动（先挪已有序号再让位当前文件） */
function rotateIfNeeded(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_FILE_BYTES) return;
    const base = file.replace(/\.log$/, '');
    let n = 2;
    while (fs.existsSync(base + '-' + (n + 1) + '.log')) n++;
    for (; n >= 2; n--) {
      const from = base + (n > 1 ? '-' + n : '') + '.log';
      if (fs.existsSync(from)) fs.renameSync(from, base + '-' + (n + 1) + '.log');
    }
    fs.renameSync(file, base + '-2.log');
  } catch (e) {}
}

function syncAppend(file, line) {
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch (e) { return false; }
}

function flushBuffer() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_buf.length) return;
  const file = fileOf(dayOf(new Date()));
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, _buf.join(''), 'utf8');
  } catch (e) { /* 静默 */ }
  _buf = [];
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(flushBuffer, FLUSH_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}
process.on('exit', () => { try { flushBuffer(); } catch (e) {} });

function firstLine(s) { return String(s || '').split('\n')[0]; }

/** 单行格式化。data 以**原对象**进 meta（JSON 只序列化一次，杜绝双重转义）；
 *  超长（>2000 字符）时主行不带 data，分片以 ↳[i/n] 续行跟随 */
function formatLine(lvl, mod, ev, msg, data, taskId, verb) {
  const s = scrub(String(msg || '').replace(/\s*\n\s*/g, ' '));
  const meta = { pid: process.pid };
  if (taskId) meta.taskId = taskId;
  if (verb) meta.verb = verb;
  let dj = '';
  try { dj = data == null ? '' : scrub(JSON.stringify(data)); } catch (e) { dj = ''; }
  if (dj && dj !== '{}' && dj.length <= 2000) meta.data = data;
  const head = stampOf(new Date()) + '  ' + String(lvl).padEnd(5) + '  ' + String(mod || 'backend').padEnd(7) + '  ' + String(ev || '-');
  let line = head + (s ? '  ' + s : '') + '  · ' + scrub(JSON.stringify(meta)) + '\n';
  if (dj.length > 2000) {
    const chunks = [];
    for (let i = 0; i < dj.length; i += 2000) chunks.push(dj.slice(i, i + 2000));
    const padsp = ' '.repeat(24) + '↳ ';
    for (let k = 0; k < chunks.length; k++) line += padsp + '[' + (k + 1) + '/' + chunks.length + '] ' + chunks[k] + '\n';
  }
  return line;
}

/**
 * 结构化写入（唯一真相）。
 * @param {'fatal'|'error'|'warn'|'info'|'debug'} lvl
 * @param {string} mod     backend / engine / ui / ipc / http / cache …
 * @param {string} ev      域.对象.动作（batch.task.start / ui.exception / ipc.continue_replica）
 * @param {string} msg     人读一句
 * @param {object} [data]  结构化细节（脱敏后进 meta）
 * @param {object} [bind]  绑定上下文（taskId / verb）
 */
function log(lvl, mod, ev, msg, data, bind) {
  try {
    if (!logDir) return;
    if ((LEVELS[lvl] == null ? 3 : LEVELS[lvl]) > _level) return;
    const line = formatLine(lvl, mod, ev, msg, data, bind && bind.taskId, bind && bind.verb);
    const day = dayOf(new Date());
    if (lvl === 'error' || lvl === 'fatal' || lvl === 'warn') {
      // 失败/异常：同步写；error 文件只写索引行（短正文副本 + ref:app@<偏移>）
      const ok = syncAppend(fileOf(day), line);
      let offset = 0;
      if (ok) { try { offset = Math.max(0, fs.statSync(fileOf(day)).size - Buffer.byteLength(line, 'utf8')); } catch (e) {} }
      const idxMeta = { ref: 'app@' + offset, pid: process.pid };
      if (bind && bind.taskId) idxMeta.taskId = bind.taskId;
      const idxLine = stampOf(new Date()) + '  ' + String(lvl).padEnd(5) + '  ' + String(mod || 'backend').padEnd(7)
        + '  ' + String(ev || '-') + '  ' + scrub(firstLine(msg)) + '  · ' + scrub(JSON.stringify(idxMeta)) + '\n';
      syncAppend(errFileOf(day), idxLine);
    } else {
      _buf.push(line);
      if (_buf.length >= FLUSH_MAX) flushBuffer();
      else scheduleFlush();
    }
  } catch (e) { /* 写日志永不影响主流程 */ }
}

/** 上下文绑定的 child logger（业界惯例：bindings 自动粘到每条事件） */
function logger(bind) {
  const b = bind || {};
  return {
    fatal: (ev, msg, data) => log('fatal', b.mod, ev, msg, data, b),
    error: (ev, msg, data) => log('error', b.mod, ev, msg, data, b),
    warn: (ev, msg, data) => log('warn', b.mod, ev, msg, data, b),
    info: (ev, msg, data) => log('info', b.mod, ev, msg, data, b),
    debug: (ev, msg, data) => log('debug', b.mod, ev, msg, data, b),
  };
}

/** 兼容垫片：旧调用点 `_lg(verb, action, summary, data)` 零改动。
 *  verb→lvl 映射；taskId 自动从 data.task / data.id / data.taskId 提取（child logger 的等效物）；
 *  旧 isErrorish 语义保留：action 含 error/fail/失败/异常/崩溃 的事件（如 `RUN task.error`）升为
 *  error 级 —— 它们必须进 error 文件（保留 30 天），不能因动词是 RUN 而丢失。 */
function logEvent(verb, action, summary, data) {
  try {
    const v = String(verb == null ? 'SYS' : verb).toUpperCase();
    let lvl = VERB_LVL[v] || 'info';
    if (v !== 'ERR' && v !== 'UI' && /(error|fail|失败|异常|崩溃)/i.test(String(action || ''))) lvl = 'error';
    let taskId = null;
    let d = data;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      taskId = d.taskId || d.task || d.id || null;
      if (taskId != null) {
        d = Object.assign({}, d);
        if (d.taskId === taskId) delete d.taskId;
      }
    }
    log(lvl, 'backend', String(action || '-'), summary, d, taskId != null ? { taskId: String(taskId), verb: v } : { verb: v });
  } catch (e) { /* 静默 */ }
}
const logEventSync = logEvent;

// 便捷包装（兼容垫片）
const sys = (action, summary, data) => logEvent('SYS', action, summary, data);
const run = (action, summary, data) => logEvent('RUN', action, summary, data);
const del = (action, summary, data) => logEvent('DEL', action, summary, data);
const add = (action, summary, data) => logEvent('ADD', action, summary, data);
const mod = (action, summary, data) => logEvent('MOD', action, summary, data);
const cfg = (action, summary, data) => logEvent('CFG', action, summary, data);
const ipc = (action, summary, data) => logEvent('IPC', action, summary, data);
function err(action, e, data) {
  const msg = (e && (e.message || e.stack)) ? String(e.message || e.stack) : String(e == null ? '' : e);
  logEvent('ERR', action, msg.split('\n')[0].slice(0, 300), data);
}
/** 前端异常上报（垫片：verb UI → lvl error） */
function ui(action, msg, data) { logEvent('UI', String(action || 'ui.exception'), String(msg || ''), data); }

// ── 引擎原始行（engine-<date>.log；唯一落盘方 = 主进程）──
let _engineDay = '';
let _engineFd = null;
let _engineLastTs = 0;
const ENGINE_PROGRESS_RE = /^\s*(frame\s*=|fps\s*=|q\s*=|size\s*=|time\s*=|bitrate\s*=|dup\s*=|drop\s*=|speed\s*=|elapsed\s*=)/;

function engineOpen() {
  const day = dayOf(new Date());
  if (_engineFd !== null && day === _engineDay) return _engineFd;
  try { if (_engineFd !== null) fs.closeSync(_engineFd); } catch (e) {}
  try {
    _engineFd = fs.openSync(engineFileOf(day), 'a');
    _engineDay = day;
  } catch (e) { _engineFd = null; }
  return _engineFd;
}

function engineWrite(tag, line) {
  try {
    const fd = engineOpen();
    if (fd === null) return;
    fs.writeSync(fd, stampOf(new Date()) + '  [' + tag + ']  ' + line + '\n');
    const f = engineFileOf(_engineDay);
    if (fs.existsSync(f) && fs.statSync(f).size >= MAX_FILE_BYTES) {
      try { fs.closeSync(_engineFd); } catch (e2) {}
      _engineFd = null;
      rotateIfNeeded(f);
      _engineFd = fs.openSync(f, 'a');
    }
  } catch (e) { /* 写日志永不影响主流程 */ }
}

/** 引擎原始行落盘（stdout/stderr 同路）。tag = taskId。ffmpeg 进度行秒级采样。 */
function engineLine(tag, line) {
  const s = String(line == null ? '' : line).replace(/\r$/, '');
  if (!s) return;
  if (ENGINE_PROGRESS_RE.test(s)) {
    const now = Date.now();
    if (now - _engineLastTs < 1000) return;
    _engineLastTs = now;
  }
  engineWrite(String(tag || 'engine'), s);
}

/** 任务边界标记（人读分段，不受采样影响） */
function engineTaskMark(tag, what) {
  engineWrite(String(tag || 'engine'), '════ ' + String(what || '') + ' ════');
}

// ── 清理 / 压缩 / 列表 / 读取 ──

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 批量文件清单（路径+大小+修改时间）：删除类操作必须在删之前调用 */
function describeFiles(paths, { max = 60 } = {}) {
  const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  const out = [];
  let total = 0;
  for (const p of list) {
    if (out.length >= max) break;
    let size = 0, mtime = '';
    try { const st = fs.statSync(p); size = st.size; mtime = stampOf(st.mtime); } catch (e) { /* 不存在也记 */ }
    total += size;
    out.push({ p: String(p), size, mtime: mtime ? mtime.slice(5) : '' });
  }
  return { files: out, count: list.length, bytes: total, truncated: list.length > out.length };
}

// ⚠ 仍匹配 task- 前缀：该文件种类已取消，但历史版本产生过，留着以便正常回收、不留孤儿文件。
const FILE_RE = /^(app|error|engine|task)-(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?\.log(\.gz)?$/;

/** 同日滚动文件限量：单文件 32MB 会滚出 -2/-3…，只按天数清理时当天文件全部保留，高频日志一天能堆几十个 32MB。
 *  无序号 = 正在写的最新文件，-2 = 次新，序号越大越旧 —— 各类型只保留最新的若干个。 */
function limitRotatedFiles() {
  const ROT_KEEP = { app: 3, error: 2, engine: 2, task: 1 };
  let removed = 0;
  try {
    const groups = new Map();
    for (const f of fs.readdirSync(logDir)) {
      const m = FILE_RE.exec(f);
      if (!m || m[6]) continue;
      const key = m[1] + '|' + m[2] + m[3] + m[4];
      if (!groups.has(key)) groups.set(key, { kind: m[1], items: [] });
      groups.get(key).items.push({ f, fresh: m[5] ? Number(m[5]) - 1 : 0 });
    }
    for (const g of groups.values()) {
      const keep = ROT_KEEP[g.kind] || 2;
      if (g.items.length <= keep) continue;
      g.items.sort((a, b) => a.fresh - b.fresh);
      for (const it of g.items.slice(keep)) {
        try { fs.unlinkSync(path.join(logDir, it.f)); removed++; } catch (e) {}
      }
    }
  } catch (e) {}
  return removed;
}

/** 异步清理 + 压缩：超保留期删除；跨天未压缩未超期 → gzip（异步，空闲期调用） */
async function pruneAsync(keepDays = KEEP_DAYS, keepErrorDays = ERROR_KEEP_DAYS) {
  if (!logDir) return { removed: 0, compressed: 0 };
  let removed = 0, compressed = 0;
  try {
    const cutoffApp = Date.now() - keepDays * 86400000;
    const cutoffErr = Date.now() - keepErrorDays * 86400000;
    removed += limitRotatedFiles();
    for (const f of fs.readdirSync(logDir)) {
      const m = FILE_RE.exec(f);
      if (!m) continue;
      const kind = m[1];
      const dayStr = m[2] + '-' + m[3] + '-' + m[4];
      const t = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])).getTime();
      const cutoff = (kind === 'error' || kind === 'task') ? cutoffErr : cutoffApp;
      const full = path.join(logDir, f);
      if (t < cutoff) { try { fs.unlinkSync(full); removed++; } catch (e) {} continue; }
      if (m[6] || m[5]) continue;                        // 已滚动序号 / 已压缩
      if (dayStr === dayOf(new Date())) continue;        // 当天仍在写
      try {
        const gz = full + '.gz';
        if (!fs.existsSync(gz)) {
          // zlib.promises 在新版 Node 已移除 → 回调包装（零依赖）
          const buf = await new Promise((res, rej) => zlib.gzip(fs.readFileSync(full), { level: 6 }, (e, b) => e ? rej(e) : res(b)));
          fs.writeFileSync(gz, buf);
          fs.unlinkSync(full);
          compressed++;
        }
      } catch (e) { /* 单文件失败不影响其它 */ }
      await new Promise((r) => setImmediate(r));         // 让路
    }
  } catch (e) { /* 静默 */ }
  return { removed, compressed };
}

/** 同步清理（兼容旧调用点；只删不压，压缩走 pruneAsync） */
function pruneOld(keepDays = KEEP_DAYS, keepErrorDays = ERROR_KEEP_DAYS) {
  if (!logDir) return { removed: 0 };
  try {
    let removed = limitRotatedFiles();
    const cutoffApp = Date.now() - keepDays * 86400000;
    const cutoffErr = Date.now() - keepErrorDays * 86400000;
    for (const f of fs.readdirSync(logDir)) {
      const m = FILE_RE.exec(f);
      if (!m || m[6]) continue;
      const kind = m[1];
      const t = new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])).getTime();
      const cutoff = (kind === 'error' || kind === 'task') ? cutoffErr : cutoffApp;
      if (t < cutoff) { try { fs.unlinkSync(path.join(logDir, f)); removed++; } catch (e) {} }
    }
    return { removed };
  } catch (e) { return { removed: 0 }; }
}

function close() { try { flushBuffer(); } catch (e) {} }

function getDir() { return logDir; }

function listFiles(kind) {
  if (!logDir) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(logDir)) {
      const m = new RegExp('^' + kind + '-(\\d{4}-\\d{2}-\\d{2})(?:-(\\d+))?\\.log$').exec(f);
      if (!m) continue;
      const full = path.join(logDir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
      out.push({ day: m[1], file: f, size, mtime });
    }
  } catch (e) { return []; }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}
const listDays = () => listFiles('app');
const listErrorDays = () => listFiles('error');
const listEngineDays = () => listFiles('engine');

/**
 * 读取日志（排查视图；app/error/engine 三类 + lvl/mod 过滤）。
 * 文件可能很大，只保留末尾窗口。
 * @param {{file?:'app'|'error'|'engine', day?:string, lvl?:string, mod?:string, grep?:string, tail?:number, maxBytes?:number}} opts
 */
function readLog(opts) {
  const o = opts || {};
  const kind = ['app', 'error', 'engine'].includes(String(o.file)) ? String(o.file) : 'app';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(o.day || '')) ? String(o.day) : dayOf(new Date());
  const full = kind === 'app' ? fileOf(d) : (kind === 'error' ? errFileOf(d) : engineFileOf(d));
  const base = { ok: true, file: kind, day: d, path: full, exists: false, size: 0, total: 0, lines: [], text: '' };
  if (!logDir) return Object.assign(base, { ok: false, error: '日志目录不可用' });
  let size = 0;
  try { if (!fs.existsSync(full)) return base; size = fs.statSync(full).size; } catch (e) { return base; }
  const maxRead = Math.max(64 * 1024, Number(o.maxBytes) || 4 * 1024 * 1024);
  let text = '';
  try {
    const fd = fs.openSync(full, 'r');
    const start = size > maxRead ? size - maxRead : 0;
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch (e) { return Object.assign(base, { ok: false, error: String(e && e.message || e) }); }
  let lines = text.split(/\r?\n/).filter(Boolean);
  const total = lines.length;
  const lvl = String(o.lvl || '').trim();
  const mod = String(o.mod || '').trim();
  const grep = String(o.grep || '').trim();
  if (lvl) lines = lines.filter((l) => l.includes('  ' + lvl.padEnd(5) + '  '));
  if (mod) lines = lines.filter((l) => l.includes('  ' + mod + '  '));
  if (grep) lines = lines.filter((l) => l.indexOf(grep) >= 0);
  const tail = parseInt(o.tail, 10);
  if (tail > 0 && lines.length > tail) lines = lines.slice(lines.length - tail);
  return { ok: true, file: kind, day: d, path: full, exists: true, size, total, lines, text: lines.join('\n') };
}

/** 兼容旧调用点（app 日志读取） */
function readDay(day, opts) { return readLog(Object.assign({ file: 'app', day }, opts || {})); }

module.exports = {
  init, getDir, setLevel, getLevel, logger, log,
  listDays, listErrorDays, listEngineDays, readLog, readDay,
  logEvent, logEventSync, sys, run, del, add, mod, cfg, ipc, err, ui,
  engineLine, engineTaskMark, engineFileOf,
  humanSize, describeFiles, pruneOld, pruneAsync, close,
  scrub, briefArgs, chEvent, isSilentChannel, KEEP_DAYS, ERROR_KEEP_DAYS,
};
