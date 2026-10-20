# 卸载入口（由应用启动时调用，幂等）
#
# 只做一件事：在开始菜单放一个中文「卸载 Video Lab」快捷方式，直达本程序的卸载询问窗口。
#
# ⚠ 不改注册表 UninstallString：安装器升级/重装旧版时按它找卸载器
#   （installUtil.nsh 里取 UninstallString 的引号内路径，复制成 old-uninstaller.exe 执行）。
#   指向本程序会让安装器把本程序当卸载器跑，弹询问窗口无人应答 →
#   报「Failed to uninstall old application files」；即便直通，卸载与安装还会抢同一目录。
#   因此系统「应用和功能」保持原生卸载（静默、保留数据），询问入口由开始菜单的中文快捷方式承担。
# ⚠ 不改框架卸载器（Uninstall <产品名>.exe）的位置与名字：安装器按固定路径找它。
# ⚠ 不改 QuietUninstallString：自动更新与脚本化路径依赖它指向真正的卸载器。
#
# 环境变量：VL_INSTALL_DIR（安装目录）、VL_EXE（本程序 exe 路径）
# 输出：最后一行 = "<注册表键名>"，供调用方记日志。
$ErrorActionPreference = 'SilentlyContinue'
$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$target = $env:VL_INSTALL_DIR
$exe = $env:VL_EXE

Get-ChildItem $root | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if (-not ($p.UninstallString -and $p.UninstallString.Contains($target))) { return }

  $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\卸载 Video Lab.lnk'
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Arguments = '--uninstall-prep'
  $s.WorkingDirectory = $target
  $s.Save()

  $_.PSChildName
}