// 一次性布局迁移：旧布局（<configDir>\Cache\ + <configDir>\Config\ + config 同级旧设置文件）
//               → 三库同目录（config.json / settings.db / cache.db）
// 四段式：备份（旧物原样保留）→ 迁移 → 读回校验 → 旧物入回收站；校验失败**不动旧物**，下次启动重试。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CacheStore = require('./cache');
const SettingsStore = require('./settings');

// 旧命名的候选清单（源码形态 video_lab_*、连字符变体、更早的快照名）
const ALIASES = {
  scan: ['scan_cache.json', 'video_lab_scan_cache.json', 'scan-cache.json', 'video-lab-scan-cache.json'],
  log: ['log_cache.json', 'video_lab_log_cache.json'],
  video: ['video_cache.json', 'video_lab_video_cache.json'],
  usage: ['usage_cache.json', 'video_lab_usage_cache.json'],
  task: ['task_cache.json', 'video_lab_task_cache.json', 'task_snapshot.json', 'video_lab_task_snapshot.json'],
  maskSession: ['mask_cache.json', 'mask_session.json', 'video_lab_mask_cache.json'],
  batchSettings: ['Batch.json', 'watermark_cache.json', 'video_lab_watermark_cache.json'],
  maskSettings: ['Mask.json', 'mask_default_dir.json'],
  clipDb: ['clip_cache.db'],
  clipJson: ['clip_cache.json'],
};
const STAGING_PREFIX = '.video-lab-legacy-';
const LEGACY_DB_MERGED_KEY = 'legacy_cache_db_merged';
const BATCH_KINDS = ['watermarks', 'enabled', 'groupCounts', 'groupEnabled'];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}
function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}
// 在若干目录中按候选名顺序找第一个存在的文件
function findLegacy(dirs, names) {
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isFile(p)) return p;
    }
  }
  return '';
}
function walkFiles(dir) {
  const out = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walkFiles(p));
      else out.push(p);
    }
  } catch (e) {}
  return out;
}

// ── 各项迁移（全部幂等：UPSERT 到固定主键）──

// 旧 sqlite 库 → 新库：只搬探测数据（usage 的权威在 usage_cache.json，由 A4-7 一并迁入）。
// applyVideoDelta 的 DO UPDATE 不含 usage_count，故不会覆盖已有计数。
// 旧 sqlite 库整体接管：必须在打开新库之前调用 —— 否则空库先被创建，rename 分支永不成立。
function takeoverLegacyDb(oldCacheDir, newCacheDb, counts) {
  const oldDb = path.join(oldCacheDir, 'cache.db');
  if (fs.existsSync(newCacheDb) || !fs.existsSync(oldDb)) return false;
  try {
    fs.renameSync(oldDb, newCacheDb);
    for (const suffix of ['-wal', '-shm']) {
      try { if (fs.existsSync(oldDb + suffix)) fs.unlinkSync(oldDb + suffix); } catch (e) {}
    }
    counts.legacyDb = 'renamed';
    return true;
  } catch (e) {
    return false; // 跨盘等 rename 失败 → 退回逐条合并
  }
}

// 旧库仍在（新库已存在）时逐条合并探测数据。usage 的权威是 usage_cache.json，不在此处搬；
// applyVideoDelta 的 DO UPDATE 不含 usage_count，故不会覆盖已有计数；meta 标记保证只合并一次。
function migrateLegacyDb(cache, oldCacheDir, counts) {
  const oldDb = path.join(oldCacheDir, 'cache.db');
  if (!fs.existsSync(oldDb) || cache.getMeta(LEGACY_DB_MERGED_KEY)) return;
  const src = new CacheStore(oldDb, { root: '' });
  let map = null;
  try {
    src.open({ readOnly: true });
    map = src.loadVideoMap();
  } catch (e) {
    map = null;
  } finally {
    try { src.close(); } catch (e) {}
  }
  if (!map) return;
  const rows = {};
  let n = 0;
  for (const k of Object.keys(map)) { rows[k] = map[k]; n++; }
  if (n) cache.applyVideoDelta(rows, null);
  cache.setMeta(LEGACY_DB_MERGED_KEY, '1');
  counts.legacyDb = n;
}

function migrateVideoAndUsage(cache, dirs, counts) {
  const videoJson = findLegacy(dirs, ALIASES.video);
  const usageJson = findLegacy(dirs, ALIASES.usage);
  if (!videoJson && !usageJson) return;
  const r = cache.migrateFromJson({ videoCacheJson: videoJson || undefined, usageCacheJson: usageJson || undefined });
  counts.video = r.video;
  counts.usage = r.usage;
  // 只在 usage 侧出现（video 侧没有）的条目：没有 last_write 指纹，无法参与后续的计数认领；单独计数以便从迁移日志判断其规模。
  counts.usageOnly = r.usageOnly || 0;
}

function migrateScan(cache, dirs, counts) {
  const p = findLegacy(dirs, ALIASES.scan);
  if (!p) return;
  const data = readJson(p);
  const entries = data && typeof data.entries === 'object' && data.entries ? data.entries : null;
  if (!entries) return;
  let n = 0;
  cache.transaction(() => {
    for (const k of Object.keys(entries)) {
      const v = entries[k];
      if (!v || typeof v.hash !== 'string') continue;
      const payload = Object.assign({}, v);
      delete payload.hash;
      cache.setScan(k, v.hash, JSON.stringify(payload));
      n++;
    }
  });
  counts.scan = n;
}

function migrateLog(cache, dirs, counts) {
  const p = findLegacy(dirs, ALIASES.log);
  if (!p) return;
  const data = readJson(p);
  if (!data || !Array.isArray(data.files)) return;
  cache.setKv('log_index:' + String(data.root || ''), JSON.stringify(data.files));
  counts.log = data.files.length;
}

function migrateMaskSession(cache, dirs, counts) {
  const p = findLegacy(dirs, ALIASES.maskSession);
  if (!p) return;
  const data = readJson(p);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  let n = 0;
  cache.transaction(() => {
    for (const k of Object.keys(data)) { cache.setKv('mask_session:' + k, JSON.stringify(data[k])); n++; }
  });
  counts.maskSession = n;
}

function migrateTasks(cache, dirs, counts) {
  const p = findLegacy(dirs, ALIASES.task);
  if (!p) return;
  const data = readJson(p);
  if (!data || !Array.isArray(data.tasks)) return;
  const db = cache.open();
  let tasks = 0, logs = 0;
  cache.transaction(() => {
    const upTask = db.prepare(`INSERT INTO tasks (id, seq, type, status, title, created_at, updated_at, payload)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET
                                 seq = excluded.seq, type = excluded.type, status = excluded.status,
                                 title = excluded.title, created_at = excluded.created_at,
                                 updated_at = excluded.updated_at, payload = excluded.payload`);
    const delLogs = db.prepare('DELETE FROM task_logs WHERE task_id = ?');
    const insLog = db.prepare('INSERT OR REPLACE INTO task_logs (task_id, line_no, line) VALUES (?, ?, ?)');
    for (const t of data.tasks) {
      if (!t || typeof t.id !== 'string') continue;
      const body = Object.assign({}, t);
      const lines = Array.isArray(body.log) ? body.log.slice(-500) : [];
      delete body.log;
      const seq = parseInt(String(t.id).replace(/\D/g, ''), 10) || 0;
      upTask.run(String(t.id), seq, String(t.type || ''), String(t.status || ''), String(t.title || ''),
        Number(t.createdAt) || 0, Number(t.endedAt) || Number(t.startedAt) || Number(t.createdAt) || 0,
        JSON.stringify(body));
      // 日志按行重写（同一任务重跑迁移时结果一致，保持幂等）
      delLogs.run(String(t.id));
      for (let i = 0; i < lines.length; i++) insLog.run(String(t.id), i, String(lines[i]));
      tasks++; logs += lines.length;
    }
    if (data.planSeq != null) cache.setKv('plan_seq', String(data.planSeq));
  });
  counts.tasks = tasks;
  counts.taskLogs = logs;
}

function migrateMarks(cache, oldCacheDir, counts) {
  const dir = path.join(oldCacheDir, 'task-marks');
  if (!fs.existsSync(dir)) return;
  const db = cache.open();
  let n = 0;
  cache.transaction(() => {
    const up = db.prepare(`INSERT INTO task_marks (task_id, payload, created_at, updated_at)
                           VALUES (?, ?, ?, ?)
                           ON CONFLICT(task_id) DO UPDATE SET
                             payload = excluded.payload, updated_at = excluded.updated_at`);
    for (const f of walkFiles(dir)) {
      const m = /^(?:\.video-lab-)?mark-(.+)\.json$/i.exec(path.basename(f));
      if (!m) continue;
      const data = readJson(f);
      if (!data || typeof data !== 'object') continue;
      up.run(String(m[1]), JSON.stringify(data), Number(data.createdAt) || 0, Date.now());
      n++;
    }
  });
  counts.marks = n;
}

// 旧成片名搜索索引 → clip_index 表。两种形态：独立的 clip_cache.db（表结构一致，逐行搬运）、
// 更早的 clip_cache.json（{ root, dirs: { <目录>: { mtime, entries } } }）。
// 索引本身可由日志目录重建，故不做逐条校验；搬运仅为省去首轮重扫。
function migrateClipIndex(cache, dirs, counts) {
  const db = cache.open();
  const up = db.prepare('INSERT OR REPLACE INTO clip_index (dir, mtime, entries) VALUES (?, ?, ?)');
  let n = 0;
  const oldDb = findLegacy(dirs, ALIASES.clipDb);
  if (oldDb) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const sdb = new DatabaseSync(oldDb, { readOnly: true });
      const rows = sdb.prepare('SELECT dir, mtime, entries FROM clip_index').all();
      sdb.close();
      cache.transaction(() => {
        for (const r of rows) { up.run(String(r.dir), Number(r.mtime) || 0, String(r.entries)); n++; }
      });
    } catch (e) { /* 旧库不可读：索引按需重建 */ }
  }
  const oldJson = findLegacy(dirs, ALIASES.clipJson);
  if (oldJson) {
    const data = readJson(oldJson);
    const dirsMap = (data && data.dirs && typeof data.dirs === 'object') ? data.dirs : null;
    if (dirsMap) {
      cache.transaction(() => {
        for (const k of Object.keys(dirsMap)) {
          const v = dirsMap[k];
          if (!v || typeof v.mtime !== 'number' || !Array.isArray(v.entries)) continue;
          up.run(String(k), Number(v.mtime) || 0, JSON.stringify(v.entries));
          n++;
        }
      });
    }
  }
  if (n) counts.clipIndex = n;
}

function migrateSettings(settings, dirs, counts) {
  const bp = findLegacy(dirs, ALIASES.batchSettings);
  if (bp) {
    const data = readJson(bp);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      let n = 0;
      settings.transaction(() => {
        for (const kind of BATCH_KINDS) {
          const v = data[kind];
          if (v && typeof v === 'object' && !Array.isArray(v)) { settings.set('batch', kind, v); n++; }
        }
      });
      counts.batch = n;
    }
  }
  const mp = findLegacy(dirs, ALIASES.maskSettings);
  if (mp) {
    const data = readJson(mp);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      let n = 0;
      settings.transaction(() => {
        for (const k of Object.keys(data)) {
          const v = String(data[k] == null ? '' : data[k]).trim();
          if (v) { settings.set('mask', k, v); n++; }
        }
      });
      counts.mask = n;
    }
  }
}

// ── 读回校验：任一条不通过即整体判失败（不动旧物）──
function verify(cache, settings, dirs, stats) {
  const problems = [];
  const db = cache.open();
  const num = (sql) => { try { const r = db.prepare(sql).get(); return r ? Number(r.n) : 0; } catch (e) { return -1; } };

  // video_cache：新库条目数不得少于「旧 JSON + 旧库」的并集规模（取旧 JSON 条数为下界）
  const vp = findLegacy(dirs, ALIASES.video);
  if (vp) {
    const d = readJson(vp);
    const n = d && typeof d === 'object' ? Object.keys(d).length : 0;
    const inDb = num('SELECT COUNT(*) AS n FROM video_cache');
    if (n && inDb < n) problems.push('video_cache 条目不足：旧 ' + n + ' / 新 ' + inDb);
  }
  // usage：计数 > 0 的条数相等（旧 JSON 侧为基准）
  const up = findLegacy(dirs, ALIASES.usage);
  if (up) {
    const d = readJson(up);
    if (d && typeof d === 'object') {
      let oldPositive = 0;
      const keys = Object.keys(d);
      for (const k of keys) if (Number((d[k] || {}).UsageCount || 0) > 0) oldPositive++;
      const newPositive = num('SELECT COUNT(*) AS n FROM video_cache WHERE usage_count > 0');
      if (oldPositive !== newPositive) problems.push('usage 计数条数不符：旧 ' + oldPositive + ' / 新 ' + newPositive);
      // 抽样逐条精确比对（首 / 中 / 末）
      for (const i of [0, Math.floor(keys.length / 2), keys.length - 1]) {
        const k = keys[i];
        if (!k) continue;
        const want = Number((d[k] || {}).UsageCount || 0);
        const row = db.prepare('SELECT usage_count FROM video_cache WHERE path = ?').get(String(k));
        const got = row ? Number(row.usage_count) : null;
        if (got !== want && !(want === 0 && got === null)) {
          problems.push('usage 抽样不符：' + k + ' 旧 ' + want + ' / 新 ' + got);
        }
      }
      if (num('SELECT COUNT(*) AS n FROM video_cache WHERE usage_count > 0') === 0 && oldPositive > 0) {
        problems.push('usage 未迁入（新库计数全为 0）');
      }
    }
  }
  const sp = findLegacy(dirs, ALIASES.scan);
  if (sp) {
    const d = readJson(sp);
    const n = d && d.entries ? Object.keys(d.entries).length : 0;
    const inDb = num('SELECT COUNT(*) AS n FROM scan_cache');
    if (n && inDb < n) problems.push('scan_cache 条目不足：旧 ' + n + ' / 新 ' + inDb);
  }
  const tp = findLegacy(dirs, ALIASES.task);
  if (tp) {
    const d = readJson(tp);
    const n = d && Array.isArray(d.tasks) ? d.tasks.length : 0;
    const inDb = num('SELECT COUNT(*) AS n FROM tasks');
    if (n && inDb < n) problems.push('tasks 条目不足：旧 ' + n + ' / 新 ' + inDb);
    // 抽样：首 / 末任务的日志行数一致
    const sample = n ? [d.tasks[0], d.tasks[Math.floor(n / 2)], d.tasks[n - 1]] : [];
    for (const t of sample) {
      if (!t || typeof t.id !== 'string') continue;
      const want = Array.isArray(t.log) ? t.log.slice(-500).length : 0;
      const row = db.prepare('SELECT COUNT(*) AS n FROM task_logs WHERE task_id = ?').get(String(t.id));
      const got = row ? Number(row.n) : 0;
      if (want !== got) problems.push('task_logs 行数不符：' + t.id + ' 旧 ' + want + ' / 新 ' + got);
    }
  }
  const md = path.join(stats.oldCacheDir || '', 'task-marks');
  if (fs.existsSync(md)) {
    let n = 0;
    for (const f of walkFiles(md)) if (/^(?:\.video-lab-)?mark-(.+)\.json$/i.test(path.basename(f))) n++;
    const inDb = num('SELECT COUNT(*) AS n FROM task_marks');
    if (n && inDb < n) problems.push('task_marks 条目不足：旧 ' + n + ' / 新 ' + inDb);
  }
  const bp = findLegacy(dirs, ALIASES.batchSettings);
  if (bp) {
    const d = readJson(bp);
    const all = settings.all('batch');
    for (const kind of BATCH_KINDS) {
      if (d && d[kind] && typeof d[kind] === 'object' && !Array.isArray(d[kind])) {
        const wantN = Object.keys(d[kind]).length;
        const gotN = all[kind] && typeof all[kind] === 'object' ? Object.keys(all[kind]).length : 0;
        if (wantN > gotN) problems.push('batch.' + kind + ' 条目不足：旧 ' + wantN + ' / 新 ' + gotN);
      }
    }
  }
  const mp = findLegacy(dirs, ALIASES.maskSettings);
  if (mp) {
    const d = readJson(mp);
    if (d && typeof d === 'object') {
      const all = settings.all('mask');
      for (const k of Object.keys(d)) {
        const want = String(d[k] == null ? '' : d[k]).trim();
        if (want && String(all[k] || '') !== want) problems.push('mask 设置不符：' + k);
      }
    }
  }
  return problems;
}

/**
 * 旧布局 → 三库一次性迁移（幂等，可重复执行）
 * @param {object} opts
 * @param {string} opts.configDir 引导文件（config.json）所在目录，即数据根目录
 * @param {(msg:string)=>void} [opts.log] 日志回调
 * @returns {{migrated:boolean, skipped:boolean, stagingDir:string, counts:object, errors:string[], verified:boolean}}
 */
function migrateToFlatLayout({ configDir, log } = {}) {
  const emit = (m) => { try { if (log) log(m); } catch (e) {} };
  const out = { migrated: false, skipped: false, stagingDir: '', counts: {}, errors: [], verified: false };
  const cfgDir = String(configDir || '');
  if (!cfgDir) { out.errors.push('缺少 configDir'); return out; }

  const oldCacheDir = path.join(cfgDir, 'Cache');
  const oldConfigDir = path.join(cfgDir, 'Config');
  const dirs = [oldCacheDir, oldConfigDir, cfgDir];
  const stats = { oldCacheDir };

  const hasLegacy = fs.existsSync(oldCacheDir) || fs.existsSync(oldConfigDir)
    || !!findLegacy([cfgDir], ALIASES.batchSettings) || !!findLegacy([cfgDir], ALIASES.maskSettings);
  if (!hasLegacy) { out.skipped = true; return out; }

  const newCacheDb = path.join(cfgDir, 'cache.db');
  const newSettingsDb = path.join(cfgDir, 'settings.db');
  // 旧 sqlite 库优先整体接管：必须在打开新库之前（否则空库先被创建，接管分支永不成立）
  takeoverLegacyDb(oldCacheDir, newCacheDb, out.counts);

  const cache = new CacheStore(newCacheDb);
  const settings = new SettingsStore(newSettingsDb);
  try {
    cache.open();
    settings.open();

    migrateLegacyDb(cache, oldCacheDir, out.counts);
    migrateVideoAndUsage(cache, dirs, out.counts);
    migrateScan(cache, dirs, out.counts);
    migrateLog(cache, dirs, out.counts);
    migrateMaskSession(cache, dirs, out.counts);
    migrateTasks(cache, dirs, out.counts);
    migrateMarks(cache, oldCacheDir, out.counts);
    migrateClipIndex(cache, dirs, out.counts);
    migrateSettings(settings, dirs, out.counts);

    const problems = verify(cache, settings, dirs, stats);
    if (problems.length) {
      out.errors = problems;
      emit('[migrate] 校验未通过，保持旧布局不动，下次启动重试：' + problems.join('；'));
      return out; // 不动旧物
    }
    out.verified = true;

    // 校验通过：旧物只做同盘 rename 到暂存目录，由主进程在 app ready 后交回收站
    const staging = path.join(cfgDir, STAGING_PREFIX + Date.now());
    try {
      fs.mkdirSync(staging, { recursive: true });
      for (const d of [oldCacheDir, oldConfigDir]) {
        if (fs.existsSync(d)) { fs.renameSync(d, path.join(staging, path.basename(d))); }
      }
      // config 同级的旧设置文件（历史残留位置）一并收走
      for (const names of [ALIASES.batchSettings, ALIASES.maskSettings]) {
        for (const n of names) {
          const p = path.join(cfgDir, n);
          if (isFile(p)) { try { fs.renameSync(p, path.join(staging, n)); } catch (e) {} }
        }
      }
      out.stagingDir = staging;
      out.migrated = true;
      const c = out.counts || {};
      emit('[migrate] 迁移明细：video_cache ' + (c.video || 0) + ' 条'
        + '（usage 独有、无指纹 ' + (c.usageOnly || 0) + ' 条）／usage ' + (c.usage || 0) + ' 条');
      emit('[migrate] 旧布局已迁移至三库，旧物暂存：' + staging);
    } catch (e) {
      out.errors.push('旧物暂存失败：' + ((e && e.message) || e));
      emit('[migrate] 旧物暂存失败，数据已进库但旧目录仍在：' + ((e && e.message) || e));
    }
  } catch (e) {
    out.errors.push('迁移异常：' + ((e && e.message) || e));
    emit('[migrate] 迁移异常：' + ((e && e.message) || e));
  } finally {
    try { cache.close(); } catch (e) {}
    try { settings.close(); } catch (e) {}
  }
  return out;
}

// 回收启动前遗留的暂存目录（上次运行未及入回收站）：返回待回收目录列表
function listStagingDirs(configDir) {
  const out = [];
  try {
    for (const ent of fs.readdirSync(String(configDir || ''))) {
      if (ent.startsWith(STAGING_PREFIX)) out.push(path.join(configDir, ent));
    }
  } catch (e) {}
  return out;
}

module.exports = { migrateToFlatLayout, listStagingDirs, STAGING_PREFIX };
