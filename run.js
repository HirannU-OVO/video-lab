// -*- coding: utf-8 -*-
// Electron 启动器：绕过 Windows 下 npm/.cmd 对参数（尤其 "."）的解析问题，
// 直接用 Node 的 child_process 拉起 electron.exe 并传入应用目录。
'use strict';

const { spawn } = require('child_process');
const path = require('path');

// 普通 Node 环境下 require('electron') 返回 electron.exe 的绝对路径字符串
const electron = require('electron');

const child = spawn(electron, [path.resolve(__dirname)], {
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error('启动 Electron 失败：' + err.message);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code == null ? 1 : code);
});