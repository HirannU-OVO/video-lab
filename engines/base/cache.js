// sqlite 数据单库（<storageDir>\cache.db）：唯一持久层，承载
// video_cache / clip_index / scan_cache / log_cache / cache_kv / tasks / task_logs / task_marks / meta。
// last_write 用 TEXT 承载 .NET Ticks（0001 基准，18~19 位整数；INTEGER 列会被 node:sqlite 直接抛 RangeError），
// 可无损往返；任务与标记主键（task_id）同样用 TEXT（19 位 ID 经 Number 转换会变成科学计数法）。
// 由 Electron 内置 node:sqlite 提供，零原生依赖；支持旧 JSON 一次性迁移。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 作用域位掩码：标记一条 video_cache 记录「被哪些模式使用过」，可叠加（按位或）。
// 新增模式只加一位，库结构不变；读取时按掩码过滤，未声明的调用方一律只看到默认范围，
// 避免某一模式的素材混进另一模式的候选（mask 素材进复刻候选会把修复指向错误的文件）。
const SCOPES = {
  batch: 1,
  replica: 2,
  mask: 4,
  // 预留：后续模式按 8 / 16 / 32 … 递增
};
// 默认读取范围：批量 + 复刻（mask 必须由调用方显式声明才可见）
const SCOPES_DEFAULT = SCOPES.batch | SCOPES.replica;
// 读取「全部作用域」用的掩码（覆盖已分配与预留的第 0..30 位）
const SCOPES_ALL = 0x7fffffff;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS video_cache (
  path          TEXT PRIMARY KEY,
  last_write    TEXT NOT NULL DEFAULT '',
  duration      REAL NOT NULL DEFAULT 0,
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  valid         INTEGER NOT NULL DEFAULT 0,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  scopes        INTEGER NOT NULL DEFAULT 3,
  file_size     INTEGER NOT NULL DEFAULT 0,
  missing_since INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clip_index (
  dir     TEXT PRIMARY KEY,
  mtime   INTEGER NOT NULL,
  entries TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_cache (
  key         TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS log_cache (
  log_path TEXT PRIMARY KEY,
  mtime    INTEGER NOT NULL,
  entries  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL DEFAULT 0,
  type       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_logs (
  task_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  line    TEXT NOT NULL,
  PRIMARY KEY (task_id, line_no)
);
CREATE TABLE IF NOT EXISTS task_marks (
  task_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 通用校验缓存：任何「需要访问磁盘才能确认的事实」都可以把结论存这里，
-- 启动只读本表（一次查询、零文件 IO），校验交给「用到时」或空闲批处理。
-- 这是把冷启动从「每次重算」改成「复用 + 懒校验」的关键。
CREATE TABLE IF NOT EXISTS verify_cache (
  key         TEXT PRIMARY KEY,          -- 语义键：'hasoutput:<taskId>' / 'env:ffmpeg' / 'path:<abs>'
  fp          TEXT NOT NULL DEFAULT '',  -- 指纹：外部依赖变了（如文件 size/mtime）才失效
  result      TEXT NOT NULL DEFAULT '',  -- 结论（'1' / '0' / JSON）
  verified_at INTEGER NOT NULL DEFAULT 0,-- 上次校验时刻
  ttl_ms      INTEGER NOT NULL DEFAULT 0 -- 有效期；过期后仍可读（标 stale），进入待刷新队列
);

-- 配置 TXT **内容**缓存（「将需要 io 的部分全部缓存化，txt 路径以及里面的全部内容」）。
-- 打开配置 / 版本预览不再读磁盘：整份原文 + 解析结果都在这里；外部改动由空闲队列校验 fp 并自愈。
CREATE TABLE IF NOT EXISTS txt_content (
  path       TEXT PRIMARY KEY,
  fp         TEXT NOT NULL DEFAULT '',   -- 'mtimeMs:size'：校验时比对这个
  raw        TEXT NOT NULL DEFAULT '',   -- 文件原文（已去 BOM）
  parsed     TEXT NOT NULL DEFAULT '',   -- readConfig 的解析结果 JSON（folders/excludes/watermark/name）
  updated_at INTEGER NOT NULL DEFAULT 0
);
`;

const SCHEMA_VERSION = '3';

// 老库补列清单（列名 → 列定义）
const VIDEO_COLUMNS = [
  ['scopes', 'INTEGER NOT NULL DEFAULT 3'],
  ['file_size', 'INTEGER NOT NULL DEFAULT 0'],
  ['missing_since', 'INTEGER NOT NULL DEFAULT 0'],
  ['verified_at', 'INTEGER NOT NULL DEFAULT 0'],   // 上次核验「文件是否还在」的时刻：GC 只挑过期的验
];

// 校验有效期：条目核验过一次后，这段时间内不再重复访问磁盘；冷启动的 IO 总量因此与「启动次数 × 过期条数」成正比。
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 失效条目保留期：文件消失后条目不立即删除，只记 missing_since。
// 保留期的意义是「素材被替换/移动的窗口期内条目还在」，使用计数才有机会被新路径认领；
// 同时覆盖「删掉旧片段 → 导出新片段 → 放回原路径同名」这类需要几分钟到几十分钟的操作。
const MISSING_RETAIN_MS = 3 * 24 * 60 * 60 * 1000;

/** Ticks 字符串近似比较（18~19 位整数超 Number 安全范围，必须走 BigInt） */
function ticksNear(a, b, tolerance) {
  if (a == null || b == null || a === '' || b === '') return false;
  try {
    const x = BigInt(String(a)), y = BigInt(String(b));
    const d = x > y ? x - y : y - x;
    return d <= BigInt(tolerance);
  } catch (e) { return false; }
}

class CacheStore {
  // dbPath: Cache 目录下的库文件（如 cache.db）；root: 当前工作根（root 前缀隔离）
  constructor(dbPath, { root = '' } = {}) {
    this.dbPath = dbPath;
    this.root = String(root || '').replace(/[\\/]+$/, '');
    this._db = null;
    this._inTx = false;
  }

  // readOnly：只读用途（如 replica 仅消费缓存）不得建表 / 写 meta / 改 journal_mode —— 否则一次「读缓存」就会改动调用方并不拥有的库。
  open(opts) {
    const readOnly = !!(opts && opts.readOnly);
    if (this._db && !this._db.closed) return this._db;
    if (readOnly) {
      this._db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this._db;
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this._db = new DatabaseSync(this.dbPath);
    // WAL：backend（主进程）与引擎（子进程）会同时读写同一个库，WAL + busy_timeout 是并发安全的前提；
    // 批量写务必显式事务（node:sqlite 默认每语句自动提交，fsync 放大会让写入慢几个数量级）
    try { this._db.exec('PRAGMA journal_mode=WAL'); } catch (e) {}
    try { this._db.exec('PRAGMA busy_timeout=5000'); } catch (e) {}
    try { this._db.exec('PRAGMA synchronous=NORMAL'); } catch (e) {}
    this._db.exec(SCHEMA);
    this._ensureVideoColumns();
    // 记录 schema 版本供排查与迁移判断；不做版本拒绝 —— schema 变更一律向后兼容，打开更高版本的库不会损坏数据，拒绝打开反而会阻断回退。
    this.setMeta('schema_version', SCHEMA_VERSION);
    return this._db;
  }

  // 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，故按需 ALTER；三列都是带默认值的加列，对旧版本完全向后兼容。
  _ensureVideoColumns() {
    const db = this._db;
    let have;
    try { have = new Set(db.prepare('PRAGMA table_info(video_cache)').all().map((r) => String(r.name))); }
    catch (e) { return; }
    for (const [name, decl] of VIDEO_COLUMNS) {
      if (have.has(name)) continue;
      try { db.exec('ALTER TABLE video_cache ADD COLUMN ' + name + ' ' + decl); } catch (e) {}
    }
  }

  // 显式事务助手：fn 内所有写操作包在同一事务，成功 COMMIT / 异常 ROLLBACK
  transaction(fn) {
    const db = this.open();
    if (this._inTx) return fn();
    db.exec('BEGIN');
    this._inTx = true;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) {}
      throw e;
    } finally {
      this._inTx = false;
    }
  }

  close() {
    if (this._db && !this._db.closed) { try { this._db.close(); } catch (e) {} }
    this._db = null;
  }

  // ── meta ──
  getMeta(k) {
    const row = this.open().prepare('SELECT v FROM meta WHERE k = ?').get(String(k));
    return row ? String(row.v) : '';
  }
  setMeta(k, v) {
    this.open().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(String(k), String(v));
  }

  // ── video_cache ──
  // 读取默认只返回「批量 + 复刻」作用域内的条目；需要其它作用域（如遮罩）必须显式声明
  // （scopesMask 传 SCOPES.mask），需要全部则传 SCOPES_ALL。
  getVideo(vPath, opts) {
    const mask = scopesMaskOf(opts);
    const row = this.open().prepare('SELECT * FROM video_cache WHERE path = ? AND (scopes & ?) != 0')
      .get(String(vPath), mask);
    return row || null;
  }

  countVideos() {
    const row = this.open().prepare('SELECT COUNT(*) AS n FROM video_cache').get();
    return row ? Number(row.n) : 0;
  }

  // 写入探测结果。scopes 按位或累加（同一素材被多个模式使用时保留全部来源标记）；不覆盖 usage_count（使用计数与探测缓存各自独立）。
  upsertVideo(vPath, { lastWrite, duration, width, height, valid, scopes, fileSize } = {}) {
    const db = this.open();
    const sc = Number(scopes) || SCOPES_DEFAULT;
    db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes, file_size, missing_since)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
                ON CONFLICT(path) DO UPDATE SET
                  last_write = excluded.last_write,
                  duration = excluded.duration,
                  width = excluded.width,
                  height = excluded.height,
                  valid = excluded.valid,
                  scopes = scopes | excluded.scopes,
                  file_size = excluded.file_size,
                  missing_since = 0`).run(
      String(vPath),
      String(lastWrite == null ? '' : lastWrite),
      Number(duration) || 0, Number(width) || 0, Number(height) || 0, valid ? 1 : 0,
      sc, Number(fileSize) || 0
    );
  }

  bumpVideoUsage(vPath, inc = 1) {
    const db = this.open();
    db.prepare('UPDATE video_cache SET usage_count = usage_count + ? WHERE path = ?').run(inc, String(vPath));
  }

  // 累加使用计数，行不存在时也能建立计数行。与 bumpVideoUsage 的差别是不要求素材已在缓存表中——
  // 引擎现场探测到的新素材可能尚未入库，用这条能保证计数不丢。
  // 用途：使用计数的唯一写入口。
  addVideoUsage(vPath, inc = 1, opts) {
    const sc = Number(opts && opts.scopes) || SCOPES_DEFAULT;
    this.open().prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes, file_size, missing_since)
                         VALUES (?, '', 0, 0, 0, 0, ?, ?, 0, 0)
                         ON CONFLICT(path) DO UPDATE SET usage_count = usage_count + excluded.usage_count, scopes = scopes | excluded.scopes`)
      .run(String(vPath), Number(inc) || 0, sc);
  }

  // 全量读出为 backend 的缓存结构（键为视频路径）；默认只含「批量 + 复刻」作用域，调用方不显式放宽时遮罩素材不会出现在候选里。
  loadVideoMap(opts) {
    const mask = scopesMaskOf(opts);
    const rows = this.open()
      .prepare('SELECT path, last_write, duration, width, height, valid FROM video_cache WHERE (scopes & ?) != 0')
      .all(mask);
    const map = {};
    for (const r of rows) {
      map[String(r.path)] = {
        LastWriteTime: String(r.last_write == null ? '' : r.last_write),
        Duration: Number(r.duration) || 0,
        Valid: !!r.valid,
        Width: Number(r.width) || 0,
        Height: Number(r.height) || 0,
      };
    }
    return map;
  }

  // 增量写回：upserts 为 { path: info } 或 Map、deletes 为路径数组，单事务提交；写入即视为「文件存在」→ 清空 missing_since。
  applyVideoDelta(upserts, deletes, opts) {
    const up = [];
    if (upserts instanceof Map) { for (const [k, v] of upserts) up.push([k, v]); }
    else if (upserts && typeof upserts === 'object') { for (const k of Object.keys(upserts)) up.push([k, upserts[k]]); }
    const del = Array.isArray(deletes) ? deletes : (deletes ? Array.from(deletes) : []);
    if (!up.length && !del.length) return { upserted: 0, deleted: 0 };
    const sc = Number(opts && opts.scopes) || SCOPES_DEFAULT;
    const db = this.open();
    let upserted = 0, deleted = 0;
    this.transaction(() => {
      const step = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes, file_size, missing_since)
                               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
                               ON CONFLICT(path) DO UPDATE SET
                                 last_write = excluded.last_write,
                                 duration = excluded.duration,
                                 width = excluded.width,
                                 height = excluded.height,
                                 valid = excluded.valid,
                                 scopes = scopes | excluded.scopes,
                                 file_size = excluded.file_size,
                                 missing_since = 0`);
      for (const [k, v] of up) {
        const info = v || {};
        step.run(String(k), String(info.LastWriteTime == null ? '' : info.LastWriteTime),
          Number(info.Duration) || 0, Number(info.Width) || 0, Number(info.Height) || 0, info.Valid ? 1 : 0,
          sc, Number(info.FileSize) || 0);
        upserted++;
      }
      for (const chunk of chunked(del, 400)) {
        const ph = chunk.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM video_cache WHERE path IN (${ph})`).run(...chunk.map(String));
        deleted += Number(r.changes) || 0;
      }
    });
    return { upserted, deleted };
  }

  // 全量替换（重置预检测后一次性写入）：单事务。
  // 只替换「本次掩码范围内」的条目 —— 其它作用域（如遮罩）的探测结果不属于预检测，不得被重置清掉。
  // 使用计数与作用域标记按路径保留；**本次替换范围外但有计数的行，重建为「纯计数行」**
  replaceVideoMap(map, opts) {
    const mask = scopesMaskOf(opts);
    const sc = Number(opts && opts.scopes) || SCOPES_DEFAULT;
    const db = this.open();
    let n = 0, orphans = 0;
    this.transaction(() => {
      const keep = new Map();
      for (const r of db.prepare('SELECT path, usage_count, scopes FROM video_cache').all()) {
        keep.set(String(r.path), { usage: Number(r.usage_count) || 0, scopes: Number(r.scopes) || 0 });
      }
      db.prepare('DELETE FROM video_cache WHERE (scopes & ?) != 0').run(mask);
      const step = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes, file_size, missing_since)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
      const inMap = new Set();
      for (const k of Object.keys(map || {})) {
        const info = map[k] || {};
        const prev = keep.get(String(k));
        step.run(String(k), String(info.LastWriteTime == null ? '' : info.LastWriteTime),
          Number(info.Duration) || 0, Number(info.Width) || 0, Number(info.Height) || 0, info.Valid ? 1 : 0,
          prev ? prev.usage : 0, sc | (prev ? prev.scopes : 0), Number(info.FileSize) || 0);
        inMap.add(String(k));
        n++;
      }
      // 配置外但有计数的行：重建纯计数行（探测数据为空，待 GC/预检测重新核验与探测）
      const orphanStep = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes, file_size, missing_since)
                                     VALUES (?, '', 0, 0, 0, 0, ?, ?, 0, 0)`);
      for (const [k, v] of keep) {
        if (inMap.has(k) || !(v.usage > 0)) continue;
        if ((v.scopes & mask) === 0) continue; // 其它作用域的行未被删除，无需重建
        orphanStep.run(k, v.usage, v.scopes);
        orphans++;
      }
    });
    return { replaced: n, orphaned: orphans };
  }

  // 覆盖式设置使用计数（覆盖而非累加，行不存在则新建）
  setVideoUsage(vPath, count, opts) {
    const n = Math.max(0, Number(count) || 0);
    const sc = Number(opts && opts.scopes) || SCOPES_DEFAULT;
    this.open().prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes, file_size, missing_since)
                         VALUES (?, '', 0, 0, 0, 0, ?, ?, 0, 0)
                         ON CONFLICT(path) DO UPDATE SET usage_count = excluded.usage_count, scopes = scopes | excluded.scopes`)
      .run(String(vPath), n, sc);
    return n;
  }

  // 使用计数全量读出（仅计数 > 0 的行），默认只返回「批量 + 复刻」范围。
  listUsage(opts) {
    const mask = scopesMaskOf(opts);
    const rows = this.open()
      .prepare('SELECT path, usage_count FROM video_cache WHERE usage_count > 0 AND (scopes & ?) != 0')
      .all(mask);
    const out = {};
    for (const r of rows) out[String(r.path)] = Number(r.usage_count) || 0;
    return out;
  }

  // 失效清理「判定分区」（纯内存，无磁盘调用）：
  //   verify  —— 本轮需要核验文件是否仍存在的条目（knownPaths 未覆盖的，以及已置位 missing 的）；
  //   missing —— 已置位（文件判定为不存在）的路径集合；
  //   expired —— 已置位且超过保留期的路径集合，核验仍不存在即可真删；
  //   drop    —— 恒为空（保留该字段以兼容调用方）。
  // ⚠ 已置位条目不得走 knownPaths 快速通道：文件可能被放回原路径，必须重新核验并复活；
  //   也不按工作目录(root)前缀删除 —— 素材位于工作目录之外是常态，否则会误清正常素材条目。
  gcPlan(knownPaths, opts) {
    const now = Number(opts && opts.now) || Date.now();
    const retainMs = (opts && opts.retainMs != null) ? Number(opts.retainMs) : MISSING_RETAIN_MS;
    const verifyTtlMs = (opts && opts.verifyTtlMs != null) ? Number(opts.verifyTtlMs) : VERIFY_TTL_MS;
    const limit = Number(opts && opts.limit) > 0 ? Number(opts.limit) : 0;
    // **关键**：只把「超过校验 TTL 未验」的条目列为待核验，并用 SQL 限量取出。
    // ⚠ 不能无差别地把全表拉进内存逐条核验 —— 冷态在机械盘上要几十秒，会冻住主进程事件循环。
    let rows = [];
    try {
      // missing 的条目**总是**核验（数量少，且「文件被放回 → 复活并保留使用计数」依赖它）；其余条目只在超过校验 TTL 时才核验。
      rows = this.open().prepare('SELECT path, missing_since FROM video_cache WHERE (verified_at < ? OR missing_since > 0)'
        + ' ORDER BY (missing_since > 0) DESC'
        + (limit > 0 ? ' LIMIT ' + limit : '')).all(now - verifyTtlMs);
    } catch (e) { rows = []; }
    const verify = [];
    const missing = new Set();
    const expired = new Set();
    for (const r of rows) {
      const p = String(r.path);
      const ms = Number(r.missing_since) || 0;
      if (ms > 0) {
        missing.add(p);
        if (now - ms > retainMs) expired.add(p);
        verify.push(p);
        continue;
      }
      if (knownPaths && knownPaths.has(p)) continue;   // 免 IO：本会话已枚举到的路径无需核验
      verify.push(p);
    }
    // 「到期回收」的判定必须完整（它决定该删什么），因此不受 limit 影响，单独补全
    try {
      for (const r of this.open().prepare('SELECT path FROM video_cache WHERE missing_since > 0 AND missing_since <= ?').all(now - retainMs)) {
        const p = String(r.path);
        missing.add(p);
        expired.add(p);
      }
    } catch (e) {}
    return { drop: [], verify, missing, expired };
  }

  // 待核验条目数（一次 COUNT 查询、零文件 IO）：用于把清理任务分批排入空闲队列，而不是启动后一次性核验。
  gcPendingCount(now, verifyTtlMs) {
    try {
      const t = Number(now) || Date.now();
      const ttl = Number(verifyTtlMs) > 0 ? Number(verifyTtlMs) : VERIFY_TTL_MS;
      return Number(this.open().prepare('SELECT COUNT(*) n FROM video_cache WHERE verified_at < ? OR missing_since > 0').get(t - ttl).n) || 0;
    } catch (e) { return 0; }
  }

  // 记录「这批路径刚核验过」：此后 VERIFY_TTL_MS 内不再重复访问磁盘，冷启动 IO 总量因此与「过期条数」成正比。
  markVerified(paths, ts) {
    if (!paths || !paths.length) return 0;
    const when = Number(ts) || Date.now();
    let n = 0;
    try {
      const db = this.open();
      this.transaction(() => {
        for (const chunk of chunked(Array.from(paths).map(String), 400)) {
          const ph = chunk.map(() => '?').join(',');
          n += Number(db.prepare('UPDATE video_cache SET verified_at = ? WHERE path IN (' + ph + ')').run(when, ...chunk).changes) || 0;
        }
      });
    } catch (e) { return 0; }
    return n;
  }

  // ── 通用校验缓存（verify_cache）────────────────────────────────────
  // 把校验结论存库、启动只读库（一次查询、零文件 IO），校验挪到「用到时」或空闲批处理，
  // 避免在启动路径上遍历磁盘。
  verifyGetMany(prefix) {
    const out = new Map();
    try {
      const rows = this.open().prepare('SELECT key, fp, result, verified_at, ttl_ms FROM verify_cache WHERE key LIKE ?')
        .all(String(prefix || '') + '%');
      for (const r of rows) {
        out.set(String(r.key), {
          fp: String(r.fp || ''), result: String(r.result || ''),
          verifiedAt: Number(r.verified_at) || 0, ttlMs: Number(r.ttl_ms) || 0,
        });
      }
    } catch (e) { return out; }
    return out;
  }

  verifyPut(key, fp, result, ttlMs, ts) {
    try {
      this.open().prepare(
        'INSERT INTO verify_cache (key, fp, result, verified_at, ttl_ms) VALUES (?,?,?,?,?) '
        + 'ON CONFLICT(key) DO UPDATE SET fp=excluded.fp, result=excluded.result, verified_at=excluded.verified_at, ttl_ms=excluded.ttl_ms'
      ).run(String(key), String(fp || ''), String(result == null ? '' : result), Number(ts) || Date.now(), Number(ttlMs) || 0);
      return true;
    } catch (e) { return false; }
  }

  verifyInvalidate(prefix) {
    try {
      return Number(this.open().prepare('DELETE FROM verify_cache WHERE key LIKE ?').run(String(prefix || '') + '%').changes) || 0;
    } catch (e) { return 0; }
  }

  // ── 配置 TXT 内容缓存（txt_content）───────────────────────────────
  // 打开配置 = 一次主键查询（零文件 IO）；外部改动由空闲队列校验 fp 并自愈。
  txtGet(filePath) {
    try {
      const r = this.open().prepare('SELECT path, fp, raw, parsed, updated_at FROM txt_content WHERE path = ?').get(String(filePath));
      if (!r) return null;
      return { path: String(r.path), fp: String(r.fp || ''), raw: String(r.raw || ''), parsed: String(r.parsed || ''), updatedAt: Number(r.updated_at) || 0 };
    } catch (e) { return null; }
  }

  txtPut(filePath, fp, raw, parsed, ts) {
    try {
      this.open().prepare(
        'INSERT INTO txt_content (path, fp, raw, parsed, updated_at) VALUES (?,?,?,?,?) '
        + 'ON CONFLICT(path) DO UPDATE SET fp=excluded.fp, raw=excluded.raw, parsed=excluded.parsed, updated_at=excluded.updated_at'
      ).run(String(filePath), String(fp || ''), String(raw == null ? '' : raw), String(parsed == null ? '' : parsed), Number(ts) || Date.now());
      return true;
    } catch (e) { return false; }
  }

  txtDelete(filePath) {
    try { return Number(this.open().prepare('DELETE FROM txt_content WHERE path = ?').run(String(filePath)).changes) || 0; }
    catch (e) { return 0; }
  }

  // 已缓存的 TXT 清单（路径 + 指纹）：空闲队列据此逐条校验，一次查询、零文件 IO
  txtList(limit) {
    const out = [];
    try {
      const n = Number(limit) > 0 ? Number(limit) : 0;
      const rows = this.open().prepare('SELECT path, fp, updated_at FROM txt_content ORDER BY updated_at DESC' + (n ? ' LIMIT ' + n : '')).all();
      for (const r of rows) out.push({ path: String(r.path), fp: String(r.fp || ''), updatedAt: Number(r.updated_at) || 0 });
    } catch (e) { return out; }
    return out;
  }

  txtCount() {
    try { return Number(this.open().prepare('SELECT COUNT(*) n FROM txt_content').get().n) || 0; } catch (e) { return 0; }
  }

  // 标记「文件已不存在」：只置位 missing_since、不删行；保留期内条目仍在库中，使用计数才有机会被新路径认领。
  markMissing(paths, ts) {
    const list = Array.isArray(paths) ? paths : (paths ? Array.from(paths) : []);
    if (!list.length) return 0;
    const when = Number(ts) || Date.now();
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const chunk of chunked(list, 400)) {
        const ph = chunk.map(() => '?').join(',');
        n += Number(db.prepare(`UPDATE video_cache SET missing_since = ? WHERE missing_since = 0 AND path IN (${ph})`)
          .run(when, ...chunk.map(String)).changes) || 0;
      }
    });
    return n;
  }

  // 复活：文件重新出现（放回原路径）时清除置位，条目与使用计数一并恢复
  clearMissing(paths) {
    const list = Array.isArray(paths) ? paths : (paths ? Array.from(paths) : []);
    if (!list.length) return 0;
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const chunk of chunked(list, 400)) {
        const ph = chunk.map(() => '?').join(',');
        n += Number(db.prepare(`UPDATE video_cache SET missing_since = 0 WHERE missing_since != 0 AND path IN (${ph})`)
          .run(...chunk.map(String)).changes) || 0;
      }
    });
    return n;
  }

  // 回收到期条目：置位时间早于 cutoff 的条目真删（保留期已过）
  deleteExpired(opts) {
    const cutoff = Number(opts && opts.cutoff);
    const limit = Number(opts && opts.limit) || 0;
    const sql = 'SELECT path FROM video_cache WHERE missing_since > 0 AND missing_since <= ?'
      + (limit > 0 ? ' LIMIT ' + limit : '');
    const rows = this.open().prepare(sql).all(Number.isFinite(cutoff) ? cutoff : 0);
    const paths = rows.map((r) => String(r.path));
    return paths.length ? this.deleteVideos(paths) : 0;
  }

  // 计数认领：素材路径变化（改名 / 移位）后，把原条目的使用计数继承到新路径。
  // 三级降级匹配：精确路径 → last_write 指纹（Ticks 容差）→ file_size 消歧。
  // basename 一级默认关闭（同名文件常见，误继承风险高），需显式开启。
  claimUsage(vPath, fingerprint, opts) {
    const o = opts || {};
    const mask = scopesMaskOf(o);
    const sc = Number(o.scopes) || SCOPES_DEFAULT;
    const size = Number(o.fileSize) || 0;
    const tolerance = Number(o.tolerance) || 10000;
    const target = String(vPath);
    const db = this.open();

    // 1) 精确路径命中：素材仍在原处（含「同名同路径被覆盖」），沿用既有计数
    const direct = db.prepare('SELECT path, usage_count FROM video_cache WHERE path = ?').get(target);
    if (direct) return { adopted: '', usageCount: Number(direct.usage_count) || 0, matchedBy: 'path' };

    if (fingerprint == null || String(fingerprint) === '') return null;
    // 2) 指纹匹配：只扫「有计数且有指纹」的候选行（通常远少于全表）
    const rows = db.prepare(`SELECT path, last_write, file_size, usage_count FROM video_cache
                             WHERE usage_count > 0 AND last_write != '' AND (scopes & ?) != 0`).all(mask);
    const fp = String(fingerprint);
    let cands = rows.filter((r) => ticksNear(r.last_write, fp, tolerance));
    // 3) 多命中 → 文件大小消歧
    let bySize = false;
    if (cands.length > 1 && size > 0) {
      const narrowed = cands.filter((r) => Number(r.file_size) === size);
      if (narrowed.length === 1) { cands = narrowed; bySize = true; }
    }
    // 4) basename 兜底（默认关闭）
    if (!cands.length && o.allowBasename) {
      const leaf = String(o.basename || '').toLowerCase();
      if (leaf) {
        const all = db.prepare(`SELECT path, last_write, file_size, usage_count FROM video_cache
                                WHERE usage_count > 0 AND (scopes & ?) != 0`).all(mask)
          .filter((r) => String(r.path).split(/[\\/]/).pop().toLowerCase() === leaf);
        if (all.length === 1) cands = all;
      }
    }
    if (cands.length !== 1) {
      if (cands.length > 1) {
        console.log('[video_cache] 计数认领存在多个同指纹候选，不继承：' + target + '（候选 ' + cands.length + ' 条）');
      }
      return null;
    }
    const from = String(cands[0].path);
    const usageCount = Number(cands[0].usage_count) || 0;
    try {
      this.open().prepare('UPDATE video_cache SET path = ?, scopes = scopes | ?, missing_since = 0 WHERE path = ?')
        .run(target, sc, from);
    } catch (e) {
      return null; // 目标路径已存在等异常：不认领，交给常规探测
    }
    return { adopted: from, usageCount, matchedBy: bySize ? 'last_write+size' : 'last_write' };
  }

  deleteVideos(paths) {
    const list = Array.isArray(paths) ? paths : (paths ? Array.from(paths) : []);
    if (!list.length) return 0;
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const chunk of chunked(list, 400)) {
        const ph = chunk.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM video_cache WHERE path IN (${ph})`).run(...chunk.map(String));
        n += Number(r.changes) || 0;
      }
    });
    return n;
  }

  // ── scan_cache ──
  getScan(key) { return this.open().prepare('SELECT * FROM scan_cache WHERE key = ?').get(String(key)) || null; }
  setScan(key, fingerprint, payload = '') {
    const db = this.open();
    db.prepare(`INSERT INTO scan_cache (key, fingerprint, payload) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, payload = excluded.payload`)
      .run(String(key), String(fingerprint), String(payload));
  }
  // 键前缀列取（backend 按 root 前缀一次性载入当前工作目录的指纹）
  listScans(prefix) {
    const rows = this.open().prepare('SELECT key, fingerprint, payload FROM scan_cache WHERE key LIKE ?')
      .all(String(prefix || '') + '%');
    return rows.map((r) => ({ key: String(r.key), fingerprint: String(r.fingerprint), payload: String(r.payload || '') }));
  }
  deleteScans(keys) {
    const list = Array.isArray(keys) ? keys : (keys ? Array.from(keys) : []);
    if (!list.length) return 0;
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const chunk of chunked(list, 400)) {
        const ph = chunk.map(() => '?').join(',');
        n += Number(db.prepare(`DELETE FROM scan_cache WHERE key IN (${ph})`).run(...chunk.map(String)).changes) || 0;
      }
    });
    return n;
  }

  // ── 缓存治理（自动/手动清理 · 体积与构成统计）──
  // 库体积大头是 clip_index（每目录一份视频清单）与 txt_content（TXT 全文），二者都没有失效判定与删除接口，
  // 工作路径变化或测试跑过就会永久驻留；以下接口供 backend 的「保守清理」（只删已失效路径）与设置页统计使用。
  listClips(prefix) {
    return this.open().prepare('SELECT dir FROM clip_index WHERE dir LIKE ?').all(String(prefix || '') + '%')
      .map((r) => String(r.dir));
  }
  deleteClips(dirs) {
    const list = Array.isArray(dirs) ? dirs : (dirs ? Array.from(dirs) : []);
    if (!list.length) return 0;
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const ch of chunked(list, 400)) {
        const ph = ch.map(() => '?').join(',');
        n += Number(db.prepare(`DELETE FROM clip_index WHERE dir IN (${ph})`).run(...ch.map(String)).changes) || 0;
      }
    });
    return n;
  }
  listTxtPaths(prefix) {
    return this.open().prepare('SELECT path FROM txt_content WHERE path LIKE ?').all(String(prefix || '') + '%')
      .map((r) => String(r.path));
  }
  deleteTxtPaths(paths) {
    const list = Array.isArray(paths) ? paths : (paths ? Array.from(paths) : []);
    if (!list.length) return 0;
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const ch of chunked(list, 400)) {
        const ph = ch.map(() => '?').join(',');
        n += Number(db.prepare(`DELETE FROM txt_content WHERE path IN (${ph})`).run(...ch.map(String)).changes) || 0;
      }
    });
    return n;
  }
  // 按前缀删 cache_kv（清理「已失效工作路径」的 txt_tree:<root> / log_index:<root>）
  deleteKvPrefix(prefix) {
    if (!prefix) return 0;
    return Number(this.open().prepare('DELETE FROM cache_kv WHERE k LIKE ?').run(String(prefix) + '%').changes) || 0;
  }
  // 库的真实占用（含 WAL/SHM）
  dbSizeBytes() {
    let n = 0;
    for (const suf of ['', '-wal', '-shm']) { try { n += fs.statSync(this.dbPath + suf).size; } catch (e) {} }
    return n;
  }
  // 构成统计：逐表行数 + 内容体积（列名从 PRAGMA 动态取，避免表结构变化后统计失真）
  stats() {
    const db = this.open();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((r) => String(r.name));
    const tables = [];
    for (const t of names) {
      let rows = 0;
      try { rows = Number(db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n) || 0; } catch (e) { continue; }
      let bytes = 0;
      try {
        const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => String(c.name));
        if (cols.length) bytes = Number(db.prepare('SELECT SUM(' + cols.map((c) => 'LENGTH("' + c + '")').join('+') + ') s FROM "' + t + '"').get().s) || 0;
      } catch (e) { bytes = 0; }
      tables.push({ table: t, rows, bytes });
    }
    return { fileBytes: this.dbSizeBytes(), tables: tables.sort((a, b) => b.bytes - a.bytes) };
  }
  // 回收页碎片：只在确有删除后调用；会重写库文件（耗时），务必在空闲期执行，并紧跟 wal_checkpoint(TRUNCATE) 把 WAL 截断归零。
  vacuum() {
    try {
      const db = this.open();
      db.exec('VACUUM');
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }

  // ── log_cache ──
  getLog(lp) { return this.open().prepare('SELECT * FROM log_cache WHERE log_path = ?').get(String(lp)) || null; }
  setLog(lp, mtime, entries) {
    const db = this.open();
    db.prepare(`INSERT INTO log_cache (log_path, mtime, entries) VALUES (?, ?, ?)
                ON CONFLICT(log_path) DO UPDATE SET mtime = excluded.mtime, entries = excluded.entries`)
      .run(String(lp), Number(mtime) || 0, JSON.stringify(entries));
  }

  // ── clip_index ──
  getClip(dir) { return this.open().prepare('SELECT * FROM clip_index WHERE dir = ?').get(String(dir)) || null; }
  setClip(dir, mtime, entries) {
    const db = this.open();
    db.prepare(`INSERT INTO clip_index (dir, mtime, entries) VALUES (?, ?, ?)
                ON CONFLICT(dir) DO UPDATE SET mtime = excluded.mtime, entries = excluded.entries`)
      .run(String(dir), Number(mtime) || 0, JSON.stringify(entries));
  }

  // ── cache_kv（零散小缓存：mask 会话 / 日志索引 / plan_seq / 未来杂项）──
  getKv(k) {
    const row = this.open().prepare('SELECT v FROM cache_kv WHERE k = ?').get(String(k));
    return row ? String(row.v) : '';
  }
  setKv(k, v) {
    this.open().prepare(`INSERT INTO cache_kv (k, v, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`)
      .run(String(k), String(v == null ? '' : v), Date.now());
  }
  removeKv(k) {
    return Number(this.open().prepare('DELETE FROM cache_kv WHERE k = ?').run(String(k)).changes) || 0;
  }
  listKv(prefix) {
    const rows = this.open().prepare('SELECT k, v FROM cache_kv WHERE k LIKE ?').all(String(prefix || '') + '%');
    const out = {};
    for (const r of rows) out[String(r.k)] = String(r.v);
    return out;
  }

  // ── tasks / task_logs（任务列表分表：payload 不含日志，日志按行独立存储）──
  // 7 成以上的 task_cache 体积来自日志；分表后状态变更只重写 payload，日志仅在追加时重写。
  upsertTask(row) {
    const r = row || {};
    this.open().prepare(`INSERT INTO tasks (id, seq, type, status, title, created_at, updated_at, payload)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                           seq = excluded.seq, type = excluded.type, status = excluded.status,
                           title = excluded.title, created_at = excluded.created_at,
                           updated_at = excluded.updated_at, payload = excluded.payload`)
      .run(String(r.id), Number(r.seq) || 0, String(r.type || ''), String(r.status || ''),
        String(r.title || ''), Number(r.createdAt) || 0, Number(r.updatedAt) || 0, String(r.payload || ''));
  }

  listTasks() {
    const rows = this.open().prepare('SELECT id, payload FROM tasks').all();
    return rows.map((r) => ({ id: String(r.id), payload: String(r.payload || '') }));
  }

  // 列出全部任务 id：落盘时据此删除「列表中已不存在」的任务行
  listTaskIds() {
    return this.open().prepare('SELECT id FROM tasks').all().map((r) => String(r.id));
  }

  removeTask(id) {
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      n += Number(db.prepare('DELETE FROM tasks WHERE id = ?').run(String(id)).changes) || 0;
      db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(String(id));
    });
    return n;
  }

  // 日志整体重写（按行号）：同一任务重复调用结果一致，天然幂等
  setTaskLog(id, lines) {
    const db = this.open();
    const list = Array.isArray(lines) ? lines : [];
    this.transaction(() => {
      db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(String(id));
      const ins = db.prepare('INSERT OR REPLACE INTO task_logs (task_id, line_no, line) VALUES (?, ?, ?)');
      for (let i = 0; i < list.length; i++) ins.run(String(id), i, String(list[i]));
    });
    return list.length;
  }

  // 追加日志行（startIdx 为这批行在任务日志中的起始序号）：任务运行中持续追加时的常态路径，避免每来一行就整体重写。
  appendTaskLog(id, startIdx, lines) {
    const list = Array.isArray(lines) ? lines : [];
    if (!list.length) return 0;
    const db = this.open();
    this.transaction(() => {
      const ins = db.prepare('INSERT OR REPLACE INTO task_logs (task_id, line_no, line) VALUES (?, ?, ?)');
      for (let i = 0; i < list.length; i++) ins.run(String(id), Number(startIdx) + i, String(list[i]));
    });
    return list.length;
  }

  getTaskLog(id) {
    const rows = this.open().prepare('SELECT line FROM task_logs WHERE task_id = ? ORDER BY line_no').all(String(id));
    return rows.map((r) => String(r.line));
  }

  // ── task_marks（任务标记：每任务一条记录，存库）──
  getMark(id) {
    const row = this.open().prepare('SELECT payload FROM task_marks WHERE task_id = ?').get(String(id));
    return row ? String(row.payload) : '';
  }
  setMark(id, payload, createdAt) {
    this.open().prepare(`INSERT INTO task_marks (task_id, payload, created_at, updated_at)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(String(id), String(payload || ''), Number(createdAt) || 0, Date.now());
  }
  removeMark(id) {
    return Number(this.open().prepare('DELETE FROM task_marks WHERE task_id = ?').run(String(id)).changes) || 0;
  }
  listMarkIds() {
    return this.open().prepare('SELECT task_id FROM task_marks').all().map((r) => String(r.task_id));
  }

  // ── 旧 JSON 一次性迁移（video_cache.json / usage_cache.json）──
  // 返回 { video, usage, usageOnly } 计数；由调用方负责读回校验与旧文件回收站处理。
  // usageOnly = 只在 usage 侧出现（video 侧没有）的条目：没有 last_write 指纹，无法参与计数认领，故单独计数供迁移日志评估。
  migrateFromJson({ videoCacheJson, usageCacheJson } = {}) {
    const db = this.open();
    const counters = { video: 0, usage: 0, usageOnly: 0 };
    this.transaction(() => {
      const step = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes)
                               VALUES (?, ?, ?, ?, ?, ?, 0, ${SCOPES_DEFAULT})
                               ON CONFLICT(path) DO UPDATE SET
                                 last_write = excluded.last_write,
                                 duration = excluded.duration,
                                 width = excluded.width,
                                 height = excluded.height,
                                 valid = excluded.valid`);
      const usageStep = db.prepare('UPDATE video_cache SET usage_count = ? WHERE path = ?');
      const addRow = db.prepare(`INSERT OR IGNORE INTO video_cache (path, last_write, duration, width, height, valid, usage_count, scopes)
                                 VALUES (?, '', 0, 0, 0, 0, ?, ${SCOPES_DEFAULT})`);
      if (videoCacheJson && fs.existsSync(videoCacheJson)) {
        const data = JSON.parse(fs.readFileSync(videoCacheJson, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          for (const [p, info] of Object.entries(data)) {
            if (!info || !p) continue;
            // 原样以字符串承载 Ticks：这里刻意不 Number() 转换，避免 18~19 位整数丢精度
            step.run(String(p), String(info.LastWriteTime == null ? '' : info.LastWriteTime),
              Number(info.Duration) || 0, Number(info.Width) || 0, Number(info.Height) || 0, info.Valid ? 1 : 0);
            counters.video++;
          }
        }
      }
      if (usageCacheJson && fs.existsSync(usageCacheJson)) {
        let usage = null;
        try { usage = JSON.parse(fs.readFileSync(usageCacheJson, 'utf8')); } catch (e) { usage = null; }
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
          for (const [p, u] of Object.entries(usage)) {
            if (!u || !p) continue;
            const cnt = Number(u.UsageCount || u.usage_count || 0);
            if (cnt > 0) {
              const r = usageStep.run(cnt, String(p));
              if (Number(r.changes) === 0) { addRow.run(String(p), cnt); counters.usageOnly++; }
            }
            counters.usage++;
          }
        }
      }
    });
    return counters;
  }

  // 从库导出为 JSON 结构（供诊断与测试人工核对库内容）
  exportVideoJson(targetPath, map) {
    const data = map || this.loadVideoMap();
    const out = {};
    for (const k of Object.keys(data)) {
      const v = data[k] || {};
      out[k] = {
        LastWriteTime: String(v.LastWriteTime == null ? '' : v.LastWriteTime),
        Duration: Number(v.Duration) || 0,
        Valid: !!v.Valid,
        Width: Number(v.Width) || 0,
        Height: Number(v.Height) || 0,
      };
    }
    const tmp = targetPath + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf-8');
    fs.renameSync(tmp, targetPath);
    return Object.keys(out).length;
  }
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 读取掩码：未声明时用默认收紧值（批量 + 复刻）；需要全部作用域传 SCOPES_ALL */
function scopesMaskOf(opts) {
  const n = Number(opts && opts.scopesMask);
  return (Number.isFinite(n) && n !== 0) ? n : SCOPES_DEFAULT;
}

module.exports = CacheStore;
module.exports.chunked = chunked;
module.exports.SCOPES = SCOPES;
module.exports.SCOPES_DEFAULT = SCOPES_DEFAULT;
module.exports.SCOPES_ALL = SCOPES_ALL;
module.exports.MISSING_RETAIN_MS = MISSING_RETAIN_MS;
