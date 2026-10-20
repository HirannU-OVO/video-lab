; 个人数据默认保留；「是否一并删除」由应用内的卸载询问窗口收集。
; ⚠ 参数名别用 electron-builder 内置的 --delete-app-data：那个由模板自己删数据，同名会两端同时删。
; ⚠ 别加自定义卸载页（customUnWelcomePage）：卸载器静默编译，页面与回调都不执行。
; ⚠ 这里不能拉起询问窗口：升级/重装时安装器会执行本卸载器（/S /KEEP_APP_DATA），
;   任何阻塞式交互都会让安装报「Failed to uninstall old application files」。

!ifndef VL_DATA_DIR
  !define VL_DATA_DIR "$APPDATA\Video Lab"        ; 改产品名时同步这里
!endif
!ifndef VL_MARKER_DIR
  !define VL_MARKER_DIR "$LOCALAPPDATA\Video Lab" ; 便携版搬迁标记，与个人数据同存亡
!endif

; 静默卸载带 --vlab-delete-data 时删除个人数据与接管标记
!macro customUnInstall
  ${GetParameters} $R0
  ${GetOptions} $R0 "--vlab-delete-data" $R1
  ${IfNot} ${Errors}
    Call un.VlDeletePersonalData
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
Function un.VlDeletePersonalData
  DetailPrint "正在删除个人数据：${VL_DATA_DIR}"
  RMDir /r "${VL_DATA_DIR}"
  IfFileExists "${VL_MARKER_DIR}\*.*" 0 nomark
    RMDir /r "${VL_MARKER_DIR}"
  nomark:
FunctionEnd
!endif
