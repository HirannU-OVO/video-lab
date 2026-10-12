// .lnk 快捷方式解析（底座能力）：替代 COM（WScript.Shell），纯 Node 读二进制、不起子进程。
// LinkInfo 段按官方偏移字段取路径：LocalBasePathOffset(0x10) 与 CommonPathSuffixOffset(0x18)，
// 完整目标 = 两段拼接（不能按结构长度硬算 —— VolumeID 长度可变会导致错位）。
// 解析不出时扫描文件中的 UTF-16L磁盘符路径兜底。供 backend 与 batch 模块共用，两侧语义必须一致。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// .lnk 的 ANSI 段按系统代码页编码（中文 Windows = GBK/CP936），用 latin1 读出中文会乱码。
// Node 内置 ICU 带 gbk 解码器；万一环境不支持则退回 latin1（非中文路径仍是正确的）。
const ANSI_DECODER = (() => { try { return new TextDecoder('gbk'); } catch (e) { return null; } })();

function parseLnkTarget(lnkPath) {
  let buf = null;
  try { buf = fs.readFileSync(lnkPath); } catch (e) { return ''; }
  if (!buf || buf.length < 76 || buf.readUInt32LE(0) !== 0x0000004C) return '';
  const flags = buf.readUInt32LE(20);
  const hasIdList = (flags & 0x01) !== 0;
  const hasLinkInfo = (flags & 0x02) !== 0;
  let off = 76;
  if (hasIdList && off + 2 <= buf.length) off += 2 + buf.readUInt16LE(off);
  if (hasLinkInfo && off + 0x1C <= buf.length) {
    const liSize = buf.readUInt32LE(off);
    if (liSize > 0 && off + liSize <= buf.length) {
      const startOf = (rel) => {
        const s = off + rel;
        return (rel && rel < liSize && s < off + liSize) ? s : -1;
      };
      // ANSI 段：以 0 字节结尾，按系统代码页（GBK）解码 —— 中文路径依赖这一步
      const atAnsi = (rel) => {
        const s = startOf(rel);
        if (s < 0) return '';
        const z = buf.indexOf(0, s);
        const seg = buf.slice(s, (z === -1 || z > off + liSize) ? off + liSize : z);
        try { return ANSI_DECODER ? ANSI_DECODER.decode(seg) : seg.toString('latin1'); }
        catch (e) { return seg.toString('latin1'); }
      };
      // Unicode 段：UTF-16LE，以 0x0000 结尾 —— 中文路径必须走这里
      const atUni = (rel) => {
        const s = startOf(rel);
        if (s < 0) return '';
        let out = '';
        for (let i = s; i + 1 < off + liSize; i += 2) {
          const ch = buf.readUInt16LE(i);
          if (ch === 0) break;
          out += String.fromCharCode(ch);
        }
        return out;
      };
      const headerSize = buf.readUInt32LE(off + 4);
      if (headerSize >= 0x24) { // Unicode 偏移字段存在（0x1C / 0x20）→ 优先
        const u = atUni(buf.readUInt32LE(off + 0x1C)) + atUni(buf.readUInt32LE(off + 0x20));
        if (u) return u;
      }
      const a = atAnsi(buf.readUInt32LE(off + 0x10)) + atAnsi(buf.readUInt32LE(off + 0x18));
      if (a) return a;
    }
  }
  // 兜底：扫描 UTF-16LE 的 "X:\"
  for (let i = 0; i + 6 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    if (((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) && buf.readUInt16LE(i + 2) === 0x3A && buf.readUInt16LE(i + 4) === 0x5C) {
      let s = '';
      for (let j = i; j + 1 < buf.length; j += 2) {
        const ch = buf.readUInt16LE(j);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
      }
      if (s.length > 3) return s;
    }
  }
  return '';
}

/** 失效目标修复（对齐 PS 的 Resolve-BrokenTarget：逐级向上找同名文件） */
function resolveBrokenTarget(targetPath) {
  if (!targetPath) return null;
  try { if (fs.existsSync(targetPath)) return targetPath; } catch (e) { /* 忽略 */ }
  const leaf = path.basename(targetPath);
  let dir = path.dirname(targetPath);
  while (dir && dir !== path.dirname(dir)) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        const cand = path.join(dir, leaf);
        if (fs.existsSync(cand)) return cand;
      }
    } catch (e) { /* 目录不可读则继续向上 */ }
    dir = path.dirname(dir);
  }
  return null;
}

module.exports = { parseLnkTarget, resolveBrokenTarget };
