// 引擎执行入口：env → 识别模块 → 运行 → 输出协议行。
// ctx 注入底座能力：{ logger, ffmpeg, probe, lock, paths, retry, dedupe, cacheStore }
// 业务模块实现后自动注册；未实现的模块退回占位骨架，保证空跑（--dry）始终可用。
// 用法：node engine-runner.js --module mask [--dry]
'use strict';

// 抑制 node:sqlite 的实验性警告：缓存库是本项目内置驱动的唯一实现（无原生依赖），警告经 stderr 被 backend 收集后会混入任务日志。
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : ((warning && warning.message) || '');
  if (/SQLite is an experimental feature/i.test(String(text))) return;
  return _emitWarning.call(process, warning, ...rest);
};

const Logger = require('./base/logger');
const { registerModule, getModule, listModules } = require('./registry');

// ── 底座能力（模块通过 ctx 使用，不直接 require，便于测试替换） ──
const base = {
  ffmpeg: require('./base/ffmpeg'),
  probe: require('./base/probe'),
  lock: require('./base/lock'),
  paths: require('./base/paths'),
  retry: require('./base/retry'),
  dedupe: require('./base/dedupe'),
  cacheStore: require('./base/cache'),
};

// ── 业务模块注册 ──
// 缓存出口：VL_CACHE_DB 指向数据缓存库（引擎直读），由主进程注入（见 backend 的 _spawnEngine）。
// path：模块目录，缺省为 ./modules/<id>（工具模块不在 modules/ 下，故显式给出）
const MODULE_META = {
  batch: { title: '批量拼接', envs: ['BATCH_*', 'VL_CACHE_DB'] },
  mask: { title: '遮罩叠加', envs: ['MASK_*', 'VL_CACHE_DB'] },
  replica: { title: '复刻', envs: ['REPLICA_*', 'VL_CACHE_DB'] },
  tool: { title: '视频处理', envs: ['TOOL_SPEC', 'VL_STORAGE_DIR'], path: './tools/module' },
};

function loadModules(logger) {
  for (const id of Object.keys(MODULE_META)) {
    const meta = MODULE_META[id];
    let mod = null;
    try {
      mod = require(meta.path || `./modules/${id}`);   // 已迁移：使用真实实现
      if (!mod || typeof mod.run !== 'function') mod = null;
    } catch (e) {
      mod = null;                                 // 模块文件缺失/语法错误 → 退回占位骨架
    }
    if (mod) { registerModule(Object.assign({ envVars: meta.envs }, mod)); continue; }
    registerModule({
      id,
      title: meta.title,
      envVars: meta.envs,
      skeleton: true,
      run: async (ctx) => {
        ctx.logger.info(`[${id}] 占位骨架：模块未加载（文件缺失或加载失败）`);
        ctx.logger.raw('共 1 个');
        ctx.logger.progress('生成', 1, 1);
        return 0;
      },
    });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  }
  const logger = new Logger({ taskId: process.env.VL_TASK_ID || '' });
  loadModules(logger);

  const id = typeof args.module === 'string' ? args.module.trim() : '';
  if (!id) { logger.error('engine-runner', '缺少 --module 参数（batch/mask/replica/tool）'); process.exit(2); }
  let mod;
  try { mod = getModule(id); } catch (e) { logger.error('engine-runner', e.message); process.exit(2); }

  logger.info('================ Video Lab ================');
  logger.info('模块：' + mod.title);

  const ctx = Object.assign({ logger, registry: listModules() }, base);
  if (args.dry || mod.skeleton) {
    // 空跑：只验证分发与协议行骨架
    logger.info('（空跑模式）');
    if (typeof mod.run === 'function' && mod.skeleton) { const code = await mod.run(ctx); logger.done(); process.exit(code === 0 ? 0 : 1); }
    logger.raw('共 1 个');
    logger.progress('生成', 1, 1);
    logger.done();
    process.exit(0);
  }

  let code = 1;
  try {
    code = await mod.run(ctx);
  } catch (e) {
    logger.error('引擎异常', (e && e.message) || String(e));
    // ★ 堆栈必须落日志：只打印 message 时 `xxx is not defined` 这类错误无法定位到行；堆栈随 engineTail 进后端 error-*.log。
    try {
      const st = (e && e.stack) ? String(e.stack) : '';
      if (st) for (const line of st.split('\n').slice(0, 8)) logger.error('引擎异常·堆栈', line.trim());
    } catch (e2) { /* 堆栈输出失败不影响退出码 */ }
    code = 1;
  }
  process.exit(code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('引擎异常：' + ((e && e.stack) || e));
  process.exit(1);
});
