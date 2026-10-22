// 去重能力：两种身份键模式
//   pathKey —— batch：以完整路径为身份；同名不同目录是两个不同素材
//   nameKey —— replica：以文件名为身份；同名（可能已移动）即同一片段，成片内不得重复
'use strict';

const path = require('node:path');

function keyFor(mode, p) {
  return mode === 'nameKey' ? path.basename(p).toLowerCase() : p;
}

// 已选集合 vs 候选：按身份键过滤排除已用素材
function filterUsed(mode, candidates, used) {
  const usedKeys = new Set((used || []).map((p) => keyFor(mode, p)));
  return (candidates || []).filter((c) => !usedKeys.has(keyFor(mode, c)));
}

// 成片内重复检测（replica 最终校验）：按文件名分组，返回重复组
function findDuplicates(mode, items) {
  const groups = new Map();
  for (const it of items) {
    if (!it) continue;
    const k = keyFor(mode, it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const dup = [];
  for (const [k, arr] of groups) if (arr.length > 1) dup.push(arr);
  return dup;
}

// 等效替换 t5riedSubs 去重：按「原路径|替换路径」键
function triedKey(orig, repl) { return orig + '|' + repl; }

module.exports = { keyFor, filterUsed, findDuplicates, triedKey };