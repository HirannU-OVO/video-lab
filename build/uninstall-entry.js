// 卸载入口（由主进程在启动时调用，幂等）
//
// ① 生成「卸载 Video Lab.vbs」：自包含脚本（可被安装器复制到临时目录执行）——
//    用户手动触发 → 拉起卸载询问窗口；被安装器复制到临时目录执行 → 带 --from-installer 标记，
//    本程序结束运行中的实例后立刻退出，让安装器继续覆盖安装。
// ② 注册表 UninstallString 指向该 vbs：「应用和功能」点卸载也先看到我们的询问窗口。
//    ⚠ 不能指向 Electron 主程序：安装器会把它复制到临时目录执行，那里没有 resources → 启动即崩 →
//      重试 5 次后报「Failed to uninstall old application files」。
// ③ 开始菜单收进「Video Lab」文件夹，文件夹内含启动与卸载两个入口。
// ④ 安装目录里也放一个中文「卸载 Video Lab」快捷方式，与英文的 Uninstall <产品名>.exe 并排时一眼能分辨。
//
// ⚠ 不改框架卸载器（Uninstall <产品名>.exe）的位置与名字：自动更新与脚本化路径按它工作。
// ⚠ 不改 QuietUninstallString：自动更新与脚本化路径依赖它指向真正的卸载器。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// 卸载入口脚本：按自身所在位置区分调用来源（临时目录 = 被安装器复制而来）
const VBS = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'tmpDir = fso.GetSpecialFolder(2)',
  'exePath = "@EXE@"',
  'If LCase(Left(WScript.ScriptFullName, Len(tmpDir))) = LCase(tmpDir) Then',
  '  args = "--uninstall-prep --from-installer"',
  'Else',
  '  args = "--uninstall-prep"',
  'End If',
  // ⚠ 窗口样式必须用 1（正常显示）：用 0（隐藏）启动时，Electron 进程虽起来了，窗口却不会显示。
  'sh.Run Chr(34) & exePath & Chr(34) & " " & args, 1, False',
].join('\r\n') + '\r\n';

// 注册表与快捷方式：路径与开关走环境变量，脚本正文保持 ASCII
const PS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
  "$target = $env:VL_INSTALL_DIR",
  "$exe = $env:VL_EXE",
  "$vbs = $env:VL_VBS",
  "Get-ChildItem $root | ForEach-Object {",
  "  $p = Get-ItemProperty $_.PSPath",
  "  if (-not ($p.UninstallString -and $p.UninstallString.Contains($target))) { return }",
  "  $want = '\"' + $vbs + '\"'",
  "  if ($p.UninstallString -ne $want) { Set-ItemProperty -Path $_.PSPath -Name UninstallString -Value $want }",
  "  $sh = New-Object -ComObject WScript.Shell",
  "  $menu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
  "  $menuDir = Join-Path $menu 'Video Lab'",
  "  New-Item -ItemType Directory -Force -Path $menuDir | Out-Null",
  "  $startLnk = Join-Path $menu 'Video Lab.lnk'",
  "  if (Test-Path -LiteralPath $startLnk) { Move-Item -LiteralPath $startLnk -Destination (Join-Path $menuDir 'Video Lab.lnk') -Force }",
  "  $unLnk = Join-Path $menuDir '卸载 Video Lab.lnk'",
  "  $s = $sh.CreateShortcut($unLnk)",
  "  $s.TargetPath = $exe",
  "  $s.Arguments = '--uninstall-prep'",
  "  $s.WorkingDirectory = $target",
  "  $s.Save()",
  "  $dirLnk = Join-Path $target '卸载 Video Lab.lnk'",
  "  $s2 = $sh.CreateShortcut($dirLnk)",
  "  $s2.TargetPath = $exe",
  "  $s2.Arguments = '--uninstall-prep'",
  "  $s2.WorkingDirectory = $target",
  "  $s2.Save()",
  "  $_.PSChildName",
  "}",
].join('\r\n');

function applyUninstallEntry(installDir, exePath) {
  const vbsPath = path.join(installDir, '卸载 Video Lab.vbs');
  try {
    fs.writeFileSync(vbsPath, '\uFEFF' + VBS.replace('@EXE@', exePath), 'utf16le');
  } catch (e) {
    return '';
  }
  const ps1 = path.join(os.tmpdir(), 'vl-uninstall-entry-' + Date.now() + '.ps1');
  try {
    fs.writeFileSync(ps1, '\uFEFF' + PS, 'utf8');
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1],
      { env: Object.assign({}, process.env, { VL_INSTALL_DIR: installDir, VL_EXE: exePath, VL_VBS: vbsPath }),
        windowsHide: true, timeout: 30000, encoding: 'utf8' });
    return String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  } catch (e) {
    return '';
  } finally {
    try { fs.unlinkSync(ps1); } catch (e) {}
  }
}

module.exports = { applyUninstallEntry };