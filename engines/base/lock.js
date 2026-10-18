// 跨进程互斥锁：文件锁 + PID 存活检测 + 超时兜底。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 获取锁：锁文件写 { pid, ts }；持有者消亡或超时则抢占。
// 锁目录可能尚不存在（首次运行、缓存库尚未落盘），缺失会让 openSync 直接抛 ENOENT、
// 任务在「互斥锁」步骤失败，故先确保父目录存在。
async function acquireLock(lockPath, { staleMs = 60 * 1000, retryIntervalMs = 300, timeoutMs = 5 * 60 * 1000 } = {}) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (e) {}
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      // fd 保持占用直至释放（防止释放窗口被第三方误删后重建）
      return {
        release: () => {
          try { fs.closeSync(fd); } catch (e) {}
          try { fs.unlinkSync(lockPath); } catch (e) {}
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 锁已存在：读取持有者，判断是否应抢占
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (e2) { holder = null; }
      const stale = !holder || !isPidAlive(holder.pid) || (Date.now() - (holder.ts || 0) > staleMs);
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch (e3) {}
        continue; // 抢占后重试本循环
      }
      if (timeoutMs && Date.now() - started > timeoutMs) {
        const err = new Error('等待锁超时：' + lockPath);
        err.code = 'LOCK_TIMEOUT';
        throw err;
      }
      await sleep(retryIntervalMs);
    }
  }
}

module.exports = { acquireLock, isPidAlive };