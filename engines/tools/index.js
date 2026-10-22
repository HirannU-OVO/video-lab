// 视频处理工具 · 步骤注册表
//
// 每个步骤是一个独立模块，自声明 schema（前端据此**自动渲染表单**，无需改前端）与在 pipeline 中的固定位次；
// 新增能力 = 加一个文件 + 在 STEP_FILES 里登记。
'use strict';

const path = require('node:path');

// 顺序即执行位次（order 由数组下标 ×10 生成，留出手工微调空间）
const STEP_FILES = [
  'trim',        // 截取时间段（产出初始保留集）
  'dropframes',  // 删除帧区间
  'deblack',     // 去黑屏（需逐帧分析；必须在 reverse 之前）
  'reverse',     // 倒放（固定在所有时间裁剪之后）
  'resize',      // 转分辨率
  'overlay',     // 叠加图片
  'rotate',      // 旋转 / 镜像
  'speed',       // 变速
  'audio',       // 音频（音量 / 静音）
  'fps',         // 帧率转换
  'encode',      // 码率控制 / 目标体积
];

const GROUP_ORDER = ['内容', '画面', '时长', '音频', '编码'];

const registry = new Map();
let loaded = false;

function registerStep(mod) {
  if (!mod || !mod.id) throw new Error('步骤模块必须提供 id');
  registry.set(mod.id, mod);
  return mod;
}

/** 懒加载：只加载已实现的步骤文件，缺失的静默跳过 */
function load() {
  if (loaded) return;
  loaded = true;
  STEP_FILES.forEach((name, idx) => {
    let mod = null;
    try {
      mod = require(path.join(__dirname, 'steps', name + '.js'));
    } catch (e) {
      return;                      // 尚未实现的步骤：跳过（前端据 stageOne 标灰）
    }
    if (!mod || !mod.id) return;
    if (mod.order == null) mod.order = (idx + 1) * 10;
    registry.set(mod.id, mod);
  });
}

function listSteps() {
  load();
  return Array.from(registry.values()).sort((a, b) => a.order - b.order);
}

function getStep(id) {
  load();
  return registry.get(String(id || '')) || null;
}

/**
 * 前端渲染用：全部步骤（含未实现的占位）+ 各自 schema。
 * @returns {Array<{id,title,group,order,danger,schema,implemented}>}
 */
function stepSchema() {
  load();
  return STEP_FILES.map((id) => {
    const m = registry.get(id);
    if (!m) {
      return { id, title: id, group: '', order: 0, danger: '', schema: [], implemented: false };
    }
    return {
      id: m.id,
      title: m.title || m.id,
      group: m.group || '',
      order: m.order,
      danger: m.danger || '',                 // 'overwrite' 等 → 前端据此加二次确认
      schema: Array.isArray(m.schema) ? m.schema : [],
      implemented: true,
    };
  });
}

/** 按分组聚合（前端折叠面板用） */
function stepSchemaByGroup() {
  const all = stepSchema();
  const groups = [];
  for (const g of GROUP_ORDER) {
    const items = all.filter((s) => s.group === g);
    if (items.length) groups.push({ group: g, steps: items });
  }
  const rest = all.filter((s) => GROUP_ORDER.indexOf(s.group) < 0);
  if (rest.length) groups.push({ group: '其他', steps: rest });
  return groups;
}

module.exports = { registerStep, getStep, listSteps, stepSchema, stepSchemaByGroup, STEP_FILES, GROUP_ORDER };
