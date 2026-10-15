; ═══════════════════════════════════════════════════════════════════════════
;  Video Lab 安装程序自定义脚本
;
;  数据目录约定（本版起）
;    用户数据**恒为 %APPDATA%\Video Lab**（设置页已无「数据目录」选项）。
;    因此卸载、重装、换安装目录都不会碰到它 —— 安装程序也无需为数据搬家操心。
;
;  ── customInstall：写「接管标记」 ──
;    背景：便携版用户升级时会被引导改用安装版。正常路径下应用已在退出前完成搬迁
;    （数据落到 %APPDATA%）+ 写线索，安装程序无需干预。
;    但存在绕过场景：用户未曾运行过新版、直接把便携目录留在原处就手动装了安装包 ——
;    此时应用没机会搬迁，新版启动会看不到旧设置（用户视角＝"设置丢了"）。
;    对策：安装前检查线索文件 %LOCALAPPDATA%\Video Lab\portable-origin.json：
;      · 存在  → 写一份「接管标记」pending-takeover.json（仅作信号，不解析路径、不复制数据）
;      · 不存在 → 什么都不做
;    标记交由应用**首次启动时自行处理**（_adoptDirAsDataRoot 有完整逻辑：复制三库含
;    sqlite -wal/-shm、源侧改名 .migrated 防回滚、核对「appdata 侧尚无数据」才动手 —— 幂等）。
;    刻意不在安装程序里复制数据：两套实现必然漂移，出错时用户数据风险不可控。
;
;    ⚠ 旧安装版用户的遗留（数据留在**安装目录**里）不需要在这里处理：应用的启动期
;      搬迁闸门已改为按「数据在哪」判定（程序目录有数据 + appdata 为空 → 搬迁），
;      与「是否安装形态」无关。装回同一目录时数据就在原地，应用启动即自动搬走。
;
;  ── customUnInstall：询问是否保留用户数据 ──
;    「彻底清干净」与「重装接着用」都是合理诉求，而卸载器无从判断用户意图，故交给用户选。
;    默认（package.json 的 deleteAppDataOnUninstall:false）是**保留**，本宏只提供「删除」出口。
; ═══════════════════════════════════════════════════════════════════════════

!macro customInstall
  ; 线索存在即写接管标记。不做 JSON 解析、不判断 migrated：
  ; 应用侧会核对 appdata 是否已有数据（有则直接跳过并清理标记），因此"多写"无害。
  IfFileExists "$LOCALAPPDATA\Video Lab\portable-origin.json" 0 vl_no_takeover
    CreateDirectory "$LOCALAPPDATA\Video Lab"
    FileOpen $0 "$LOCALAPPDATA\Video Lab\pending-takeover.json" w
    FileWrite $0 '{"from":"installer"}$\r$\n'
    FileClose $0
  vl_no_takeover:
!macroend

!macro customUnInstall
  ; 卸载前询问是否保留个人数据。
  ; ⚠ RMDir 是**永久删除**（NSIS 没有回收站接口），所以提示里必须说清不可恢复 ——
  ;   这与应用内部的清理策略（一律进回收站）形成对比，用户应当知情后再选。
  ; ⚠ 数据目录固定为 %APPDATA%\Video Lab：它不随安装目录走，所以在这里删是安全的、
  ;   不会误删其它位置的东西；而这正是「数据目录写死 appdata」换来的确定性。
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "是否保留个人数据（设置、缓存、任务记录、日志）？$\r$\n$\r$\n选择「是」= 保留，下次安装后自动接着用。$\r$\n选择「否」= 一并删除，且无法恢复（不进入回收站）。" /SD IDYES IDYES vl_uninst_keep_data
    RMDir /r "$APPDATA\Video Lab"
  vl_uninst_keep_data:
!macroend
