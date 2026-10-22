// 业务模块注册表：batch / mask / replica 作为模块挂载在底座上
'use strict';

const registry = new Map();

// registerModule({ id, title, envVars, mode, run(ctx) })
function registerModule(mod) {
  if (!mod || !mod.id) throw new Error('模块必须提供 id');
  registry.set(mod.id, mod);
  return mod;
}

function getModule(id) {
  if (!registry.has(id)) throw new Error('未知任务模块：' + id);
  return registry.get(id);
}

function listModules() {
  return Array.from(registry.entries()).map(([id, m]) => ({ id, title: m.title }));
}

module.exports = { registerModule, getModule, listModules, registry };