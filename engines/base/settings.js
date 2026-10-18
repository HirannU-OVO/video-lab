// 设置库（<storageDir>\settings.db，与 Global.json / cache.db 同级）：单表 KV。
// scope = 模式 / 窗口名（global / batch / mask / 未来 denoise…）—— 新增模式只加 scope 行，不加文件。
// value 统一以 JSON 文本承载：调用方无需关心类型，也避免布尔被存成字符串这类失真。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

const SCHEMA_VERSION = '1';

class SettingsStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this._db = null;
    this._inTx = false;
  }

  // readOnly：只读用途不得建表 / 写 meta / 改 journal_mode，避免一次「读设置」就改动库
  open(opts) {
    const readOnly = !!(opts && opts.readOnly);
    if (this._db && !this._db.closed) return this._db;
    if (readOnly) {
      this._db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this._db;
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this._db = new DatabaseSync(this.dbPath);
    try { this._db.exec('PRAGMA journal_mode=WAL'); } catch (e) {}
    try { this._db.exec('PRAGMA busy_timeout=5000'); } catch (e) {}
    try { this._db.exec('PRAGMA synchronous=NORMAL'); } catch (e) {}
    this._db.exec(SCHEMA);
    // 记录 schema 版本供排查；与 cache 一致不做版本拒绝（理由见 cache.js 同名处注释）
    this.setMeta('schema_version', SCHEMA_VERSION);
    return this._db;
  }

  setMeta(k, v) {
    this._db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(String(k), String(v));
  }

  getMeta(k) {
    const row = this.open().prepare('SELECT v FROM meta WHERE k = ?').get(String(k));
    return row ? String(row.v) : '';
  }

  // 显式事务助手：fn 内所有写操作包在同一事务，成功 COMMIT / 异常 ROLLBACK（支持嵌套复用）
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

  // ── 设置 KV（key 省略即整段 scope）──
  get(scope, key, fallback) {
    const row = this.open().prepare('SELECT value FROM settings WHERE scope = ? AND key = ?')
      .get(String(scope), String(key));
    if (!row) return fallback;
    try { return JSON.parse(String(row.value)); } catch (e) { return fallback; }
  }

  set(scope, key, value) {
    this.open().prepare(`INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(String(scope), String(key), JSON.stringify(value === undefined ? null : value), Date.now());
  }

  all(scope) {
    const rows = this.open().prepare('SELECT key, value FROM settings WHERE scope = ?').all(String(scope));
    const out = {};
    for (const r of rows) {
      try { out[String(r.key)] = JSON.parse(String(r.value)); } catch (e) { /* 单条脏数据不拖垮整体读取 */ }
    }
    return out;
  }

  remove(scope, key) {
    const db = this.open();
    if (key == null) return Number(db.prepare('DELETE FROM settings WHERE scope = ?').run(String(scope)).changes) || 0;
    return Number(db.prepare('DELETE FROM settings WHERE scope = ? AND key = ?')
      .run(String(scope), String(key)).changes) || 0;
  }
}

module.exports = SettingsStore;
