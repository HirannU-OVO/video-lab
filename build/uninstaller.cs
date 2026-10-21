// 卸载启动器 —— 卸载入口统一指向本程序：
//   ① 注册表 UninstallString（Windows「应用和功能」、第三方卸载工具）
//   ② 注册表 QuietUninstallString + /S（无人值守调用：静默直通）
//   ③ 开始菜单「Video Lab\卸载 Video Lab」
//   ④ 安装目录根「卸载 Video Lab」
//
// ⚠ 本程序必须放在安装目录之外（%LOCALAPPDATA%\VideoLab\）：运行中的 exe 无法被删除，
//   放在安装目录里卸载器删不掉它（升级路径会中止安装）。
//
// 调用形态：交互（默认，弹卸载询问窗口）/ 静默（/S、--updated 等参数）。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Threading;
using Microsoft.Win32;

static class Program
{
    // 主程序：安装目录里最大的 exe（排除卸载器与启动器）
    static string FindAppExe(string installDir)
    {
        try
        {
            string best = "";
            long bestSize = -1;
            foreach (string f in Directory.GetFiles(installDir, "*.exe"))
            {
                string n = Path.GetFileName(f);
                if (n.StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(n, LAUNCHER_NAME, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(n, "elevate.exe", StringComparison.OrdinalIgnoreCase)) continue;
                long sz = 0;
                try { sz = new FileInfo(f).Length; } catch { }
                if (sz > bestSize) { bestSize = sz; best = f; }
            }
            return bestSize > 0 ? best : null;
        }
        catch { return null; }
    }
    const string ResultFile = "uninstall-choice.txt";
    const string LAUNCHER_NAME = "uninstaller.exe";

    static int Main(string[] args)
    {
        string installDir = ResolveInstallDir(args);
        if (installDir == null) return 3;              // 找不到安装目录：什么都做不了
        // 静默：显式参数（/S、--updated、/currentuser…）或调用方本身就是无人值守的
        // 升级（--updated）时不清理开始菜单：装完新版还要用
        if (IsSilent(args) || IsHeadlessCaller()) return RunFrameworkUninstaller(installDir, !IsUpdateRun(args));
        return RunInteractive(installDir);
    }

    // 自身 exe 路径
    static string SelfExePath()
    {
        try { return Process.GetCurrentProcess().MainModule.FileName; }
        catch { }
        try { return Assembly.GetEntryAssembly().Location; }
        catch { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'), LAUNCHER_NAME); }
    }

    // 安装器调起旧版卸载时带 --updated：这是覆盖安装，不是卸载
    static bool IsUpdateRun(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = (args[i] ?? "").Trim().Trim('"').ToLowerInvariant();
            if (a == "--updated") return true;
        }
        return false;
    }

    // ── 安装目录：命令行给的 > 注册表 InstallLocation > 自身位置推断 ──
    static string ResolveInstallDir(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = (args[i] ?? "").Trim().Trim('"');
            if (a.Length == 0) continue;
            try
            {
                if (Directory.Exists(a) && FindAppExe(a) != null)
                    return Path.GetFullPath(a);
            }
            catch { }
        }
        string reg = ReadInstallLocation();
        if (reg != null) return reg;
        // 自身位于 <安装目录>\resources\ 时取父目录
        try
        {
            string self = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            if (string.Equals(Path.GetFileName(self), "resources", StringComparison.OrdinalIgnoreCase))
                return Path.GetDirectoryName(self);
        }
        catch { }
        return null;
    }

    // 从卸载注册表里找本应用的安装目录（不依赖具体键名：键名随 appId 变）
    static string ReadInstallLocation()
    {
        // 第一轮：UninstallString 指向自身的项 —— 同机存在多个形态时各自定位自己
        string self = "";
        try { self = SelfExePath(); } catch { }
        if (self.Length > 0)
        {
            RegistryKey[] hivesSelf = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
            string subSelf = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
            for (int h = 0; h < hivesSelf.Length; h++)
            {
                try
                {
                    using (RegistryKey root = hivesSelf[h].OpenSubKey(subSelf))
                    {
                        if (root == null) continue;
                        foreach (string name in root.GetSubKeyNames())
                        {
                            try
                            {
                                using (RegistryKey k = root.OpenSubKey(name))
                                {
                                    if (k == null) continue;
                                    string us = k.GetValue("UninstallString") as string;
                                    string loc = k.GetValue("InstallLocation") as string;
                                    if (us != null && loc != null && loc.Length > 0 &&
                                        us.IndexOf(self, StringComparison.OrdinalIgnoreCase) >= 0)
                                        return loc.Trim().Trim('"');
                                }
                            }
                            catch { }
                        }
                    }
                }
                catch { }
            }
        }
        return ReadInstallLocationByName();
    }

    // 第二轮：按显示名 / 卸载串里的产品名匹配
    static string ReadInstallLocationByName()
    {
        RegistryKey[] hives = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
        string sub = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
        for (int h = 0; h < hives.Length; h++)
        {
            try
            {
                using (RegistryKey root = hives[h].OpenSubKey(sub))
                {
                    if (root == null) continue;
                    foreach (string name in root.GetSubKeyNames())
                    {
                        try
                        {
                            using (RegistryKey k = root.OpenSubKey(name))
                            {
                                if (k == null) continue;
                                string dn = k.GetValue("DisplayName") as string;
                                string loc = k.GetValue("InstallLocation") as string;
                                string us = k.GetValue("UninstallString") as string;
                                bool named = dn != null && dn.IndexOf("Video Lab", StringComparison.OrdinalIgnoreCase) >= 0;
                                bool pointed = us != null && us.IndexOf("Video Lab", StringComparison.OrdinalIgnoreCase) >= 0;
                                if (named || pointed)
                                {
                                    if (loc != null && loc.Length > 0) return loc.Trim().Trim('"');
                                    // 兜底：从 DisplayIcon（<安装目录>\Video Lab.exe,0）反推安装目录。
                                    string icon = k.GetValue("DisplayIcon") as string;
                                    if (icon != null && icon.Length > 0)
                                    {
                                        int comma = icon.LastIndexOf(',');
                                        string exe = comma > 0 ? icon.Substring(0, comma) : icon;
                                        exe = exe.Trim().Trim('"');
                                        string d = Path.GetDirectoryName(exe);
                                        if (d != null && File.Exists(exe) && FindAppExe(d) != null)
                                            return d;
                                    }
                                    if (us != null && us.Length > 0)
                                    {
                                        int q = us.IndexOf('"');
                                        int q2 = q >= 0 ? us.IndexOf('"', q + 1) : -1;
                                        if (q2 > q)
                                        {
                                            string exe = us.Substring(q + 1, q2 - q - 1);
                                            string d = Path.GetDirectoryName(exe);
                                            // 必须是安装目录里的主程序：UninstallString 可能指向启动器自身
                                            if (d != null && File.Exists(exe) && FindAppExe(d) != null)
                                                return d;
                                        }
                                    }
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }
        return null;
    }

    // 静默判定：/S 是静默卸载；--updated 是安装器调起旧版卸载；/currentuser、/allusers 是安装器安装模式
    static bool IsSilent(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = (args[i] ?? "").Trim().Trim('"').ToLowerInvariant();
            if (a == "/s" || a == "-s" || a == "--silent") return true;
            if (a == "--updated" || a == "/currentuser" || a == "/allusers") return true;
        }
        return false;
    }

    // ── 无人值守调用方判定 ──
    // 这些调用方无人能应答询问窗口，一律直接静默卸载。
    static bool IsHeadlessCaller()
    {
        string parent = ParentProcessName();
        if (string.IsNullOrEmpty(parent)) return false;
        string p = parent.ToLowerInvariant();
        string[] names = new string[] {
            "winget", "appinstallercli", "msiexec", "wusa", "tiworker",
            "trustedinstaller", "windowspackagemanagerserver", "appinstaller"
        };
        foreach (string n in names) { if (p == n) return true; }
        return false;
    }

    // 取父进程名：ntdll 的 ProcessBasicInformation 里带 InheritedFromUniqueProcessId
    static string ParentProcessName()
    {
        try
        {
            IntPtr h = OpenProcess(0x1000, false, GetCurrentProcessId());   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return "";
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int retLen;
            int st = NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out retLen);
            CloseHandle(h);
            if (st != 0) return "";
            int ppid = pbi.InheritedFromUniqueProcessId.ToInt32();
            if (ppid <= 0) return "";
            using (Process p = Process.GetProcessById(ppid)) return p.ProcessName;
        }
        catch { return ""; }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int retLen);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll")]
    static extern int GetCurrentProcessId();

    // ── 交互流程：询问 → 结束运行中的实例 → 按选择删数据 → 静默卸载 ──
    static int RunInteractive(string installDir)
    {
        string app = FindAppExe(installDir);
        if (app == null) return RunFrameworkUninstaller(installDir, true);   // 主程序没了：只能直接卸载

        string result = Path.Combine(Path.GetTempPath(), ResultFile);
        try { if (File.Exists(result)) File.Delete(result); } catch { }

        Process child = StartProcess(app, "--uninstall-prep-child \"" + result + "\"", installDir);
        if (child == null) return 3;
        try { child.WaitForExit(); } catch { }

        string choice = "cancel", dataDir = "", markerDir = "";
        try
        {
            if (File.Exists(result))
            {
                string[] lines = File.ReadAllLines(result);
                if (lines.Length > 0) choice = lines[0].Trim();
                if (lines.Length > 1) dataDir = lines[1].Trim();
                if (lines.Length > 2) markerDir = lines[2].Trim();
                File.Delete(result);
            }
        }
        catch { }

        if (choice == "cancel") return 2;      // 用户放弃：不动任何东西

        // 正在运行的实例会占住程序文件与数据文件，不结束就卸不干净
        KillRunningApp(app);
        Thread.Sleep(800);

        if (choice == "1")
        {
            DeleteDir(dataDir);
            DeleteDir(markerDir);
        }

        int rc = RunFrameworkUninstaller(installDir, true);
        return rc;
    }

    // 调框架（NSIS）卸载器：静默、无交互、不删数据
    static int RunFrameworkUninstaller(string installDir, bool cleanupStartMenu)
    {
        // 先结束正在运行的实例：卸载器在静默模式下发现程序还在跑会放弃卸载。
        KillRunningApp(FindAppExe(installDir));
        string un = FindFrameworkUninstaller(installDir);
        if (un == null) return 3;
        Process p = StartProcess(un, "/currentuser /S", installDir);
        if (p == null) return 3;
        try { p.WaitForExit(); } catch { }
        // 静默卸载后同样清掉自身
        ScheduleSelfDelete();
        if (cleanupStartMenu) CleanupStartMenu();
        return p.ExitCode;
    }

    // 框架卸载器：<安装目录>\Uninstall <产品名>.exe（NSIS 用自身所在目录推断安装目录，不能挪位置）
    static string FindFrameworkUninstaller(string installDir)
    {
        string guess = Path.Combine(installDir, "Uninstall Video Lab.exe");
        if (File.Exists(guess)) return guess;
        try
        {
            foreach (string f in Directory.GetFiles(installDir, "Uninstall *.exe"))
                return f;
        }
        catch { }
        return null;
    }

    static Process StartProcess(string file, string arguments, string workingDir)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
            psi.WorkingDirectory = workingDir;
            psi.UseShellExecute = false;
            return Process.Start(psi);
        }
        catch { return null; }
    }

    // 卸载后清理开始菜单里的「Video Lab」文件夹
    static void CleanupStartMenu()
    {
        try
        {
            string programs = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Microsoft\Windows\Start Menu\Programs");
            string dir = Path.Combine(programs, "Video Lab");
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch { }
    }

    // 结束正在运行的同名实例（含其渲染/工具子进程），并等它们真正退出
    static void KillRunningApp(string appExe)
    {
        if (string.IsNullOrEmpty(appExe)) return;
        string name = Path.GetFileNameWithoutExtension(appExe);
        try
        {
            Process[] ps = Process.GetProcessesByName(name);
            foreach (Process p in ps)
            {
                try { p.Kill(); } catch { }
                finally { try { p.Dispose(); } catch { } }
            }
        }
        catch { }
        // 等句柄释放：卸载器是在这一刻检查进程是否还在跑
        try
        {
            for (int i = 0; i < 40; i++)
            {
                if (Process.GetProcessesByName(name).Length == 0) return;
                Thread.Sleep(250);
            }
        }
        catch { }
    }

    // 强删目录（个人数据删除是用户明确的选择，不进回收站）
    static void DeleteDir(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return;
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
    }

    // 卸载完成后延迟自删：自身仍在运行，无法直接删除
    // 用 PowerShell 而非 cmd：cmd 的 & / 重定向与引号嵌套在参数传递中不可靠。
    static void ScheduleSelfDelete()
    {
        try
        {
            string self = SelfPath();
            if (string.IsNullOrEmpty(self)) return;
            string dir = Path.GetDirectoryName(self);
            // 目录只在为空时删（不加 -Recurse），避免清掉目录里的其他文件
            string ps =
                "-NoProfile -WindowStyle Hidden -Command \"" +
                "Start-Sleep -Seconds 3; " +
                "Remove-Item -LiteralPath '" + self + "' -Force -ErrorAction SilentlyContinue; " +
                "Remove-Item -LiteralPath '" + dir + "' -Force -ErrorAction SilentlyContinue\"";
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", ps);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }
        catch { }
    }

    // 取自身 exe 路径：命令行首项最可靠，其次进程模块，最后程序集位置
    static string SelfPath()
    {
        try
        {
            string[] a = Environment.GetCommandLineArgs();
            if (a != null && a.Length > 0 && !string.IsNullOrEmpty(a[0])) return a[0];
        }
        catch { }
        try { return Process.GetCurrentProcess().MainModule.FileName; } catch { }
        try { return System.Reflection.Assembly.GetExecutingAssembly().Location; } catch { }
        return "";
    }
}
