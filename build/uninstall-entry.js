// 卸载入口（由主进程在启动时调用，幂等）
//
// 统一原则：**我们自己添加的卸载入口只有一个目标** —— 卸载启动器 uninstaller.exe。
//   ① 注册表 UninstallString       → "…\uninstaller.exe"（人手动点：弹卸载询问窗口）
//   ② 注册表 QuietUninstallString  → 同上 + /S（无人值守：静默直通）
//   ③ 开始菜单「Video Lab\卸载 Video Lab」→ 指向启动器
//   ④ 安装目录根「卸载 Video Lab」      → 指向启动器
// ⚠ 框架自带的「Uninstall Video Lab.exe」必须留在安装目录根：NSIS 卸载器按自身所在目录
//    推断安装目录，挪到子目录后它只会删那个子目录。
// ⚠ 启动器放在安装目录之外（%LOCALAPPDATA%）：运行中的 exe 无法被删除，放在安装目录里
//    卸载器删不掉它（升级路径会中止安装）。
//
// 每次启动都校正：启动器缺失或版本旧 → 重新复制；注册表被安装器改回 → 改回启动器。
// 任何一步失败都保持原样，不影响既有卸载能力。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_NAME = 'Video Lab';
const LAUNCHER_NAME = 'uninstaller.exe';
const UNINSTALL_LNK = '卸载 Video Lab.lnk';
const LEGACY_VBS = '卸载 Video Lab.vbs';   // 旧版入口文件（vbs），每次启动时清除

// 启动器存放目录：安装目录之外（%LOCALAPPDATA%\<产品名去空格>\）
// 按产品名分目录：同机存在多个形态（正式版 / 隔离测试版）时各自用自己的启动器，
// 卸载其中一个不会误卸载另一个。
function launcherDir(productName) {
  let base = '';
  try { base = process.env.LOCALAPPDATA || ''; } catch (e) {}
  if (!base) { try { base = os.homedir(); } catch (e) {} }
  const name = String(productName || APP_NAME).replace(/\s+/g, '');
  return path.join(base, name);
}

// 把启动器复制到安装目录之外；已存在且大小一致则不重复写
function placeLauncher(installDir, productName) {
  const src = path.join(installDir, 'resources', LAUNCHER_NAME);
  if (!fs.existsSync(src)) return '';
  const dir = launcherDir(productName);
  const dst = path.join(dir, LAUNCHER_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let same = false;
    try {
      same = fs.statSync(dst).size === fs.statSync(src).size;
    } catch (e) { same = false; }
    if (!same) fs.copyFileSync(src, dst);
  } catch (e) {
    return '';   // 复制失败 → 保持原样
  }
  return dst;
}

// 注册表与快捷方式：路径与开关走环境变量，脚本正文保持 ASCII
const PS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
  "$target = $env:VL_INSTALL_DIR",
  "$launcher = $env:VL_LAUNCHER",
  "$exe = $env:VL_EXE",
  "$lnkName = $env:VL_LNK_NAME",
  "Get-ChildItem $root | ForEach-Object {",
  "  $p = Get-ItemProperty $_.PSPath",
  "  $hit = ($p.UninstallString -and $p.UninstallString.Contains($target)) -or ($p.QuietUninstallString -and $p.QuietUninstallString.Contains($target)) -or ($p.InstallLocation -eq $target)",
  "  if (-not $hit) { return }",
  // 补 InstallLocation：electron-builder 只把它写在另一个注册表键上。
  // ⚠ 必须先写：UninstallString 一旦指向启动器，启动器就可能立刻被调用。
  "  if ($p.InstallLocation -ne $target) { Set-ItemProperty -Path $_.PSPath -Name InstallLocation -Value $target }",
  // UninstallString 只放程序路径、不带参数：带参数的引号形式经 cmd 执行会被拆坏。
  // 安装目录由启动器从注册表反查。
  "  $want = '\"' + $launcher + '\"'",
  "  if ($p.UninstallString -ne $want) { Set-ItemProperty -Path $_.PSPath -Name UninstallString -Value $want }",
  "  $wantQuiet = $want + ' /S'",
  "  if ($p.QuietUninstallString -ne $wantQuiet) { Set-ItemProperty -Path $_.PSPath -Name QuietUninstallString -Value $wantQuiet }",
  "  $sh = New-Object -ComObject WScript.Shell",
  // 开始菜单收进「Video Lab」文件夹
  "  $menu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
  "  $menuDir = Join-Path $menu 'Video Lab'",
  "  New-Item -ItemType Directory -Force -Path $menuDir | Out-Null",
  "  $startLnk = Join-Path $menu 'Video Lab.lnk'",
  "  if (Test-Path -LiteralPath $startLnk) { Move-Item -LiteralPath $startLnk -Destination (Join-Path $menuDir 'Video Lab.lnk') -Force }",
  // 清掉开始菜单根目录里散落的卸载快捷方式：卸载入口只保留在「Video Lab」文件夹内
  "  foreach ($old in @((Join-Path $menu '卸载 Video Lab.lnk'), (Join-Path $menu 'Uninstall Video Lab.lnk'))) {",
  "    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }",
  "  }",
  // 清掉文件夹里多余的卸载快捷方式，只留下面新建的那一个
  "  Get-ChildItem -LiteralPath $menuDir -Filter '*.lnk' -File | Where-Object { $_.Name -ne $lnkName -and $_.Name -ne 'Video Lab.lnk' } | Remove-Item -Force",
  "  $unLnk = Join-Path $menuDir $lnkName",
  "  $s = $sh.CreateShortcut($unLnk)",
  "  $s.TargetPath = $launcher",
  "  $s.Arguments = '\"' + $target + '\"'",
  "  $s.WorkingDirectory = $target",
  "  $s.Save()",
  // 安装目录根：只保留一个中文卸载入口
  "  $dirLnk = Join-Path $target $lnkName",
  "  $s2 = $sh.CreateShortcut($dirLnk)",
  "  $s2.TargetPath = $launcher",
  "  $s2.Arguments = '\"' + $target + '\"'",
  "  $s2.WorkingDirectory = $target",
  "  $s2.Save()",
  "  $_.PSChildName",
  "}",
].join('\r\n');

function applyUninstallEntry(installDir, exePath, productName) {
  const launcher = placeLauncher(installDir, productName);
  if (!launcher) return '';
  // 清掉旧版入口文件
  try { fs.unlinkSync(path.join(installDir, LEGACY_VBS)); } catch (e) {}
  const ps1 = path.join(os.tmpdir(), 'uninstall-entry-' + Date.now() + '.ps1');
  try {
    fs.writeFileSync(ps1, '\uFEFF' + PS, 'utf8');
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1],
      { env: Object.assign({}, process.env, {
          VL_INSTALL_DIR: installDir,
          VL_LAUNCHER: launcher,
          VL_EXE: exePath,
          VL_LNK_NAME: UNINSTALL_LNK,
        }),
        windowsHide: true, timeout: 30000, encoding: 'utf8' });
    return String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  } catch (e) {
    return '';
  } finally {
    try { fs.unlinkSync(ps1); } catch (e) {}
  }
}

module.exports = { applyUninstallEntry };
