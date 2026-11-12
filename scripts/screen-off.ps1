# ============================================================
# monitor-off.ps1 - 关闭显示器（真正黑屏），但系统完全不进入待机
#
# 【为什么不用 SC_MONITORPOWER】
#   本机是 S0 现代待机（Modern Standby）机型。实测系统日志
#   Microsoft-Windows-Kernel-Power Id=506 证实：广播
#   SC_MONITORPOWER 会让【整机进入 S0 待机】→ 自动锁屏 →
#   动鼠标要先把整机唤醒，看起来像"被睡眠了"。本方案完全不用它。
#
# 【本方案：纯显示层，零电源副作用】
#   1) 预启动 3 秒：先把亮度降到 30% 作为提示；这期间按解除键可取消
#   2) 倒计时结束：亮度降到 0 + 全屏纯黑遮罩 + 隐藏系统光标
#   3) 解除方式（轮询 GetAsyncKeyState，不依赖消息泵）：
#        Esc / 鼠标右键
#        锁屏+指纹键（检测到会话被锁即解除——这是异常兜底，不算解除键：
#        黑遮罩绝不能挡住锁屏界面）
#      【2026-11-11 主人要求只留 Esc 与右键】PrtSc / Delete / Insert / Home /
#      End / PgUp / PgDn / NumLock 全部从默认解除键里移除（仍可用 -ExitKeys 传回）
#      鼠标移动、左键、空格 都不解除
#   4) 退出时：还原亮度、关遮罩、恢复光标
#
#   全程不调用 SC_MONITORPOWER / SetThreadExecutionState /
#   SetSuspendState / LockWorkStation / shutdown。
#
# 【重要教训】
#   不要用低级钩子(WH_KEYBOARD_LL / WH_MOUSE_LL)来做解除检测：
#   钩子回调必须由安装钩子的线程泵 Windows 消息才会触发，而
#   PowerShell 的 while + Start-Sleep 不泵消息 → 钩子形同虚设，
#   表现就是"黑屏后怎么按都没反应"。轮询虽然土，但绝对可靠。
#
# 【用法】
#   关屏： monitor-off.ps1
#   恢复： monitor-off.ps1 -Restore
#   自检： monitor-off.ps1 -SelfTest
#   识别： monitor-off.ps1 -DetectKey
# ============================================================

param(
    [switch]$Restore,
    [switch]$SelfTest,
    [switch]$DetectKey,
    [int]$TimeoutSec = 3600,                  # 最长保持秒数，到点自动恢复
    [int]$ArmSeconds = 3,                     # 预启动倒计时（此期间可取消，屏幕先变暗）
    [int[]]$ExitKeys = @(0x1B),
    [switch]$KeepBrightness                # 【已废弃 2026-11-12】仅为兼容老调用保留，不再生效：现在一律把背光降到 0
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $scriptDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile   = Join-Path $logDir ("monitor_off_{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$stateFile = Join-Path $scriptDir '.monitor_off_state'
$pidFile   = Join-Path $scriptDir '.monitor_off_pid'
$lockFile  = Join-Path $scriptDir '.monitor_off_lock'

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}

# ---------------- 亮度控制（WMI） ----------------
function Get-BrightnessValue {
    try {
        $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop
        return [int]$b.CurrentBrightness
    } catch { return -1 }
}

function Set-BrightnessValue {
    param([int]$Value)
    if ($Value -lt 0) { $Value = 0 }
    if ($Value -gt 100) { $Value = 100 }
    try {
        $methods = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
        if (-not $methods) {
            # 【2026-11-12 修】这里原来是"$methods 为空 → foreach 不跑 → 返回 false"，
            # 一声不响地失败。系统忙/并发查询时 Get-CimInstance 确实会返回空集合，
            # 于是「降背光」这一步被悄悄跳过，屏幕只剩黑遮罩 —— 看着黑、其实背光还亮着。
            Write-Log '亮度写入口令枚举为空（WMI 暂无响应），本次未写入' 'WARN'
            return $false
        }
        $ok = $false
        foreach ($m in $methods) {
            try {
                Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness `
                    -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$Value } -ErrorAction Stop | Out-Null
                $ok = $true
            } catch {
                Write-Log "亮度写入失败: $($_.Exception.Message)" 'WARN'
            }
        }
        return $ok
    } catch {
        Write-Log "亮度接口不可用: $($_.Exception.Message)" 'WARN'
        return $false
    }
}

<#
 * 【2026-11-12 新增】把亮度设到目标值，并且**读回确认**。
 *
 * 为什么必须要有这个：原来只调一次 Set-BrightnessValue、只信它的返回值。
 * 实测踩到 —— WMI 偶发不给方法对象时会静默失败，于是「降到 0%」这一步被跳过，
 * 屏幕上只剩一层黑遮罩，遮罩后面背光仍然亮着，主人看到的就是"不是全黑、还发光"。
 *
 * 现在的做法：写 → 读回 → 差得远就重试（最多 Tries 次，每次间隔 250ms）。
 * 只要有一次读回接近目标就算成功。彻底失败会写 WARN，绝不静默。
#>
function Set-BrightnessForced {
    param(
        [int]$Value,
        [int]$Tries = 5,
        [int]$Tolerance = 2
    )
    if ($Value -lt 0) { $Value = 0 }
    if ($Value -gt 100) { $Value = 100 }
    for ($i = 1; $i -le $Tries; $i++) {
        $null = Set-BrightnessValue -Value $Value
        Start-Sleep -Milliseconds 250
        $now = Get-BrightnessValue
        if ($now -ge 0 -and [math]::Abs($now - $Value) -le $Tolerance) {
            if ($i -gt 1) { Write-Log ("[亮度] 第 {0} 次尝试后确认到位：{1}%（目标 {2}%）" -f $i, $now, $Value) }
            return $true
        }
        Write-Log ("[亮度] 第 {0}/{1} 次写入后读回 {2}%，未达目标 {3}%，重试" -f $i, $Tries, $now, $Value) 'WARN'
    }
    $final = Get-BrightnessValue
    Write-Log ("[亮度] 连续 {0} 次都没设到 {1}%（最后一次读回 {2}%）" -f $Tries, $Value, $final) 'ERROR'
    return $false
}

# ---------------- 全屏黑遮罩（独立 STA 线程 + 消息泵 + 纯 Win32） ----------------
$veilCode = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class BlackVeilRunner
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEX
    {
        public uint cbSize; public uint style; public IntPtr lpfnWndProc;
        public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance;
        public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public IntPtr hIconSm;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateWindowEx(uint exStyle, string cls, string name, uint style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int index);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr SetCursor(IntPtr hCursor);
    [DllImport("user32.dll")] public static extern int ShowCursor(bool bShow);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);

    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
    const uint WM_CLOSE = 0x0010;
    const uint WM_SETCURSOR = 0x0020;
    const uint WS_POPUP = 0x80000000;
    const uint WS_VISIBLE = 0x10000000;
    const int BLACK_BRUSH = 4;
    const int SW_SHOW = 5;

    static IntPtr g_hwnd = IntPtr.Zero;
    static Thread g_thread = null;
    static volatile bool g_closing = false;
    public static string LastError = "";

    public static bool Start()
    {
        try
        {
            LastError = "";
            g_closing = false;
            g_thread = new Thread(Run);
            g_thread.IsBackground = true;
            g_thread.SetApartmentState(ApartmentState.STA);
            g_thread.Start();
            for (int i = 0; i < 300 && g_hwnd == IntPtr.Zero && LastError == ""; i++) Thread.Sleep(10);
            if (g_hwnd == IntPtr.Zero && LastError == "") LastError = "超时未创建窗口";
            return g_hwnd != IntPtr.Zero;
        }
        catch (Exception ex) { LastError = "Start异常: " + ex.Message; return false; }
    }

    public static void Raise()
    {
        try { if (g_hwnd != IntPtr.Zero) SetWindowPos(g_hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW); }
        catch { }
    }

    public static void Stop()
    {
        try
        {
            g_closing = true;
            if (g_hwnd != IntPtr.Zero) PostMessage(g_hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            if (g_thread != null) g_thread.Join(1500);
        }
        catch { }
    }

    static WndProcDelegate s_wndProc = null;   // 必须静态持有，否则 GC 回收后窗口过程失效

    static void Run()
    {
        try
        {
            string clsName = "SleepSchedulerBlackVeil_" + Guid.NewGuid().ToString("N");
            s_wndProc = new WndProcDelegate(WndProc);

            WNDCLASSEX wc = new WNDCLASSEX();
            wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
            wc.style = 0;
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(s_wndProc);
            wc.hInstance = GetModuleHandle(null);
            wc.hCursor = IntPtr.Zero;
            wc.hbrBackground = GetStockObject(BLACK_BRUSH);
            wc.lpszClassName = clsName;
            wc.lpszMenuName = null;

            if (RegisterClassEx(ref wc) == 0)
            {
                LastError = "RegisterClassEx失败 code=" + Marshal.GetLastWin32Error();
                return;
            }

            int w = GetSystemMetrics(0);
            int h = GetSystemMetrics(1);
            if (w <= 0) w = 1920;
            if (h <= 0) h = 1080;

            // WS_EX_TOOLWINDOW(0x80) 不进 Alt+Tab；WS_EX_NOACTIVATE(0x08000000) 不抢焦点
            g_hwnd = CreateWindowEx(0x08000080, clsName, "", WS_POPUP | WS_VISIBLE,
                0, 0, w, h, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);

            if (g_hwnd == IntPtr.Zero)
            {
                LastError = "CreateWindowEx失败 code=" + Marshal.GetLastWin32Error();
                return;
            }

            ShowWindow(g_hwnd, SW_SHOW);
            SetWindowPos(g_hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);

            MSG msg;
            while (!g_closing && GetMessage(out msg, IntPtr.Zero, 0, 0))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            if (g_hwnd != IntPtr.Zero) { DestroyWindow(g_hwnd); g_hwnd = IntPtr.Zero; }
        }
        catch (Exception ex) { LastError = "Run异常: " + ex.Message; }
    }

    delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_SETCURSOR) { SetCursor(IntPtr.Zero); return new IntPtr(1); }
        if (msg == WM_CLOSE) { g_closing = true; return IntPtr.Zero; }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    public static void HideSystemCursor(bool hide)
    {
        try
        {
            int cnt = ShowCursor(!hide);
            for (int i = 0; i < 12 && ((hide && cnt >= 0) || (!hide && cnt < 0)); i++) cnt = ShowCursor(!hide);
        }
        catch { }
    }
}
'@

function Initialize-Veil {
    try {
        Add-Type -TypeDefinition $veilCode -ErrorAction Stop
        return $true
    } catch {
        Write-Log "黑遮罩代码加载失败: $($_.Exception.Message)" 'ERROR'
        return $false
    }
}

# ---------------- 输入轮询（不依赖消息泵） ----------------
$inputCode = @'
using System;
using System.Runtime.InteropServices;

public class InputProbe
{
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, System.Text.StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();

    // 0x8000 = 当前是否按下（与"自上次调用以来按下过"的 0x0001 无关，避免误报）
    public static bool IsDownNow(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    public static uint Tick() { return GetTickCount(); }

    // 锁屏检测（三重判定，兼容电源/指纹键的不同行为）：
    //  1) 输入桌面拿不到句柄（锁屏时切到安全桌面）
    //  2) 输入桌面名为 Winlogon（已锁屏）
    //  3) 调用方配合检测"时间跳变"（睡眠/休眠唤醒）
    public static bool IsSessionLocked()
    {
        IntPtr h = OpenInputDesktop(0, false, 0x0100 | 0x0001);
        if (h == IntPtr.Zero) return true;
        try
        {
            uint need = 0;
            var sb = new System.Text.StringBuilder(256);
            // UOI_NAME = 2
            if (GetUserObjectInformation(h, 2, sb, (uint)(sb.Capacity * 2), out need))
            {
                string name = sb.ToString();
                if (!string.IsNullOrEmpty(name) && name.IndexOf("Winlogon", StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
            }
        }
        catch { }
        finally { CloseDesktop(h); }
        return false;
    }

    public static string VkName(int vk)
    {
        switch (vk)
        {
            case 0x02: return "鼠标右键";
            case 0x20: return "空格(Space)";
            case 0x1B: return "Esc";
            case 0x2C: return "PrintScreen(PrtSc)";
            case 0x2D: return "Insert";
            case 0x2E: return "Delete";
            case 0x24: return "Home";
            case 0x23: return "End";
            case 0x21: return "PageUp";
            case 0x22: return "PageDown";
            case 0x90: return "NumLock";
            case 0x91: return "ScrollLock";
            case 0xA3: return "右Ctrl";
            case 0xA5: return "右Alt";
            case 0x0D: return "回车";
            default: return "VK_0x" + vk.ToString("X2");
        }
    }

    // 按键识别模式：返回当前按下的第一个键（含右键），用于确认神秘键的键码
    public static string ScanAnyKey(out int code)
    {
        code = 0;
        if (IsDownNow(0x02)) { code = 0x02; return VkName(0x02); }
        for (int vk = 0x08; vk <= 0xFE; vk++)
        {
            if (vk == 0x0B || vk == 0x0C || vk == 0x01 || vk == 0x02) continue;
            if (IsDownNow(vk)) { code = vk; return VkName(vk); }
        }
        return null;
    }
}
'@

# ---------------- 指纹识别检测 ----------------
# 指纹验证成功后，Windows 会把结果写进生物识别日志
# （Microsoft-Windows-Biometrics/Operational）。轮询该日志即可判断"用户刷了指纹"，
# 不需要任何驱动接口，也不需要屏幕处于锁屏状态。
function Test-FingerprintUsed {
    param([datetime]$Since)
    try {
        $ev = Get-WinEvent -FilterHashtable @{
            LogName   = 'Microsoft-Windows-Biometrics/Operational'
            StartTime = $Since
        } -MaxEvents 20 -ErrorAction Stop
        foreach ($e in $ev) {
            # 1004 = 传感器成功识别用户；1605 = 安全组件成功授权
            if ($e.Id -eq 1004 -or $e.Id -eq 1605) {
                $msg = ''
                try { $msg = $e.Message } catch { }
                if ($msg -match '成功|授权|识别') { return $true }
            }
        }
        return $false
    } catch {
        return $false
    }
}

# ---------------- 自检 ----------------
if ($SelfTest) {
    $br = Get-BrightnessValue
    $hasMethod = $false
    try { $null = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop; $hasMethod = $true } catch { }
    $veilOk = Initialize-Veil
    $veilStart = $false
    $veilErr = ''
    if ($veilOk) {
        $veilStart = [BlackVeilRunner]::Start()
        if (-not $veilStart) { try { $veilErr = [BlackVeilRunner]::LastError } catch { } }
        [BlackVeilRunner]::Stop()
    }
    $inputOk = $true
    try { Add-Type -TypeDefinition $inputCode -ErrorAction Stop } catch { $inputOk = $false }
    Write-Host "=== 环境能力自检 ==="
    Write-Host ("当前亮度读取      : {0}" -f $(if ($br -ge 0) { "$br%" } else { '失败/不支持' }))
    Write-Host ("亮度可调(WMI)     : {0}" -f $hasMethod)
    Write-Host ("黑遮罩可编译      : {0}" -f $veilOk)
    Write-Host ("黑遮罩实测启动    : {0}{1}" -f $veilStart, $(if ($veilErr) { " ($veilErr)" } else { '' }))
    Write-Host ("输入轮询可用      : {0}" -f $inputOk)
    Write-Host ("日志文件          : {0}" -f $logFile)
    if (-not $veilStart) { Write-Host '*** 黑遮罩不可用：关屏会退化为仅变暗，不建议使用 ***' -ForegroundColor Red; exit 9 }
    Write-Host '自检通过' -ForegroundColor Green
    exit 0
}

# ---------------- 按键识别 ----------------
if ($DetectKey) {
    Add-Type -TypeDefinition $inputCode -ErrorAction Stop
    Write-Host '=== 按键识别模式（30 秒）===' -ForegroundColor Cyan
    Write-Host '按下你想用来解除黑屏的键，会打印键名与键码。按 Esc 结束。'
    $seen = @{}
    $swD = [System.Diagnostics.Stopwatch]::StartNew()
    while ($swD.Elapsed.TotalSeconds -lt 30) {
        Start-Sleep -Milliseconds 60
        $code = 0
        $name = [InputProbe]::ScanAnyKey([ref]$code)
        if ($name -and -not $seen.ContainsKey($code)) {
            $seen[$code] = $true
            Write-Host ("  检测到: {0}  VK=0x{1:X2} ({1})" -f $name, $code) -ForegroundColor Green
            if ($code -eq 0x1B) { break }
        }
    }
    if ($seen.Count -eq 0) { Write-Host '没有检测到按键。' -ForegroundColor Yellow }
    Write-Host '如需新增解除键，用 -ExitKeys 传入键码列表。'
    exit 0
}

# ---------------- 手动恢复 ----------------
if ($Restore) {
    Write-Log '[恢复] 手动恢复请求'
    $hasState = $false
    $target = 66
    if (Test-Path $stateFile) {
        $raw = Get-Content $stateFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($raw -match '^\d+\|(\d+)$') { $target = [int]$Matches[1]; $hasState = $true }
    }
    if (Test-Path $pidFile) {
        $praw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($praw -match '^\d+$' -and [int]$praw -ne $PID) {
            $proc = Get-Process -Id ([int]$praw) -ErrorAction SilentlyContinue
            if ($proc) {
                try { Stop-Process -Id ([int]$praw) -Force -ErrorAction Stop; Write-Log "[恢复] 已结束关屏进程 PID=$praw" } catch { }
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    if ($target -lt 40) { $target = 66 }
    # 没有状态文件 = 说明当前没有关屏实例在跑，亮度没被我们改过 → 不要强行改亮度（避免把用户自己的设置改掉）
    if ($hasState) {
        $null = Set-BrightnessValue -Value $target
        Write-Log "[恢复] 亮度已还原为 $target%"
    }
    else {
        Write-Log '[恢复] 未发现关屏状态（可能并未关屏），不改动亮度'
        $target = Get-BrightnessValue
        if ($target -lt 0) { $target = 0 }
    }
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Write-Host ("显示已恢复（当前亮度 $target%）")
    exit 0
}

# ---------------- 单实例判定 ----------------
# 用 Mutex + PID 校验：残留的锁文件不会导致"永远拒绝运行"
$ownsLock = $false
$lockMutex = $null
try {
    $lockMutex = New-Object System.Threading.Mutex($false, 'Global\SleepScheduler_MonitorOff')
    $ownsLock = $lockMutex.WaitOne(0)
} catch { $ownsLock = $false }

if (-not $ownsLock) {
    # 锁文件缺失 = 已有实例还没写文件（启动瞬间的竞态），按"真在跑"处理，避免双实例
    if (-not (Test-Path $lockFile)) {
        Write-Log '[关屏] 已有实例正在启动/运行（锁文件未就绪），忽略本次调用'
        exit 0
    }
    $stale = $true
    $rawPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($rawPid -match '^\d+$') {
        if (Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue) { $stale = $false }
    }
    if (-not $stale) {
        Write-Log '[关屏] 已有实例在运行，忽略本次调用'
        exit 0
    }
    Write-Log '[关屏] 发现残留锁（进程已不存在），接管'
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    try { $null = $lockMutex.WaitOne(1500) } catch { }
    $ownsLock = $true
}
Set-Content -Path $lockFile -Value $PID -Encoding ASCII -Force

try {
    # 原亮度兜底：0 或异常值不可信（可能是上次异常退出留下的黑屏状态），
    # 一律恢复到安全值 66%，绝不把 0 当成"原始亮度"写回（否则屏幕永久黑死）。
    $origBrightness = Get-BrightnessValue

    # 自愈：上次若异常退出把亮度留在 0/极低（进程被强杀时 finally 来不及跑），
    # 先恢复到安全值再开始，避免"越叠越黑"。
    if ($origBrightness -ge 0 -and $origBrightness -lt 40) {
        Write-Log ("[自愈] 检测到亮度残留为 {0}%（疑似上次异常退出），先恢复到 66%" -f $origBrightness) 'WARN'
        $null = Set-BrightnessValue -Value 66
        Start-Sleep -Milliseconds 300
        $origBrightness = Get-BrightnessValue
    }

    $saveB = if ($origBrightness -ge 40) { $origBrightness } else { 66 }
    Set-Content -Path $stateFile -Value ("{0}|{1}" -f $PID, $saveB) -Encoding ASCII -Force
    Set-Content -Path $pidFile   -Value $PID -Encoding ASCII -Force
    Write-Log ("[关屏] 开始，当前亮度=" + $(if ($origBrightness -ge 0) { "$origBrightness%" } else { '不可读' }))

    Add-Type -TypeDefinition $inputCode -ErrorAction Stop

    # ---------- 阶段 1：预启动倒计时（屏幕先变暗，可按解除键取消） ----------
    $armSec = if ($ArmSeconds -gt 0) { $ArmSeconds } else { 0 }
    $dimOk = $false
    if ($armSec -gt 0) {
        Write-Log ("[预启动] $armSec 秒倒计时开始（可按解除键取消）")
        Write-Host ("将在 {0} 秒后关闭显示器；这期间按 Esc 或右键可取消。" -f $armSec) -ForegroundColor Cyan

        $dimTarget = [math]::Max(20, [math]::Min(35, [int]($saveB * 0.45)))
        if ($saveB -gt $dimTarget) {
            $dimOk = Set-BrightnessValue -Value $dimTarget
            if ($dimOk) { Write-Log ("[预启动] 亮度先降到 {0}% 作为提示" -f $dimTarget) }
        }

        # 记录取消键/右键的初始按住状态，避免"启动瞬间已按住"被误判
        $prev = @{}
        foreach ($k in $ExitKeys) { $prev[$k] = [InputProbe]::IsDownNow($k) }
        $prev[0x02] = [InputProbe]::IsDownNow(0x02)

        $cancelled = $false
        $cancelReason = ''
        $armSw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($armSw.Elapsed.TotalSeconds -lt $armSec) {
            Start-Sleep -Milliseconds 40
            foreach ($k in $ExitKeys) {
                $down = [InputProbe]::IsDownNow($k)
                if ($down -and -not $prev[$k]) { $cancelled = $true; $cancelReason = [InputProbe]::VkName($k); break }
                $prev[$k] = $down
            }
            if ($cancelled) { break }
            $rdown = [InputProbe]::IsDownNow(0x02)
            if ($rdown -and -not $prev[0x02]) { $cancelled = $true; $cancelReason = '鼠标右键'; break }
            $prev[0x02] = $rdown
            $lkA = $false
            try { $lkA = [InputProbe]::IsSessionLocked() } catch { }
            if ($lkA) { $cancelled = $true; $cancelReason = '锁屏/指纹键'; break }
        }

        if ($cancelled) {
            Write-Log ("[预启动] 已取消（$cancelReason），还原亮度")
            if ($dimOk) { $null = Set-BrightnessValue -Value $saveB }
            Write-Host ("已取消（检测到{0}），显示器未关闭，亮度已还原。" -f $cancelReason) -ForegroundColor Yellow
            Remove-Item $stateFile, $pidFile -Force -ErrorAction SilentlyContinue
            exit 0
        }
        Write-Log '[预启动] 倒计时结束，开始关屏'
    }

    # ---------- 阶段 2：真正黑屏 ----------
    # 【2026-11-12】不再有"只遮罩不降亮度"的分支了：那是当初怕进程被杀把屏幕卡黑
    # 而留的安全模式，现在已经有启动自愈（残留低亮度自动拉回）兜底，不需要它了。
    # 而且实测证明它正是"看着黑、其实背光还亮着"的元凶 —— 主人要的是真黑，
    # 所以就算上层还传了 -KeepBrightness，这里也一律把背光降到 0。
    $brightnessOk = $false
    if ($origBrightness -ge 0) {
        $brightnessOk = Set-BrightnessForced -Value 0 -Tries 5
        if ($brightnessOk) {
            Write-Log ("[关屏] 背光已降至 0%（读回确认 {0}%）" -f (Get-BrightnessValue))
        }
        else {
            Write-Log '[关屏] 背光没能降到 0%，这次只会盖黑遮罩、背后仍有背光；请把当天日志发给小鱼排查' 'ERROR'
        }
    }

    $veilOk = $false
    if (Initialize-Veil) {
        try {
            $veilOk = [BlackVeilRunner]::Start()
            if ($veilOk) { Write-Log '[关屏] 全屏黑遮罩已铺上' }
            else {
                $err = ''
                try { $err = [BlackVeilRunner]::LastError } catch { }
                Write-Log ("[关屏] 黑遮罩未铺上: " + $(if ($err) { $err } else { '未知' })) 'ERROR'
            }
        } catch { Write-Log ("[关屏] 黑遮罩异常: " + $_.Exception.Message) 'ERROR' }
    }

    if (-not $veilOk) {
        # 没有遮罩 = 只是变暗，内容还看得见 → 视为失败，立即还原，绝不留半黑状态
        Write-Log '[关屏] 遮罩未生效，视为失败，还原亮度' 'ERROR'
        if ($brightnessOk) { $null = Set-BrightnessValue -Value $saveB }
        Remove-Item $stateFile, $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host '关屏失败：无法创建黑遮罩窗口（内容仍可见），已还原亮度。' -ForegroundColor Red
        Write-Host '请把 tools\logs 下当天日志发出来排查。' -ForegroundColor Yellow
        exit 9
    }

    try { [BlackVeilRunner]::HideSystemCursor($true); Write-Log '[关屏] 系统光标已隐藏' } catch { }

    Write-Log '[关屏] 已生效，等待解除（Esc / 鼠标右键；锁屏时遮罩自动让开）'

    # ---------- 阶段 3：等待解除（纯轮询，不依赖消息泵） ----------
    $graceMs = 1200
    Write-Log "[关屏] 宽限期 $graceMs ms（忽略启动瞬间的按键）"
    Start-Sleep -Milliseconds $graceMs

    $prev = @{}
    foreach ($k in $ExitKeys) { $prev[$k] = [InputProbe]::IsDownNow($k) }
    $prev[0x02] = [InputProbe]::IsDownNow(0x02)

    $maxSeconds = if ($TimeoutSec -gt 0) { $TimeoutSec } else { 3600 }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $raiseCount = 0
    $exitReason = ''
    $lockProbe = 0
    $logonUiChecked = 0
    $bioChecked = 0
    $tStart = Get-Date
    $lastTick = [InputProbe]::Tick()

    while ($true) {
        Start-Sleep -Milliseconds 40
        foreach ($k in $ExitKeys) {
            $down = [InputProbe]::IsDownNow($k)
            if ($down -and -not $prev[$k]) { $exitReason = [InputProbe]::VkName($k); break }
            $prev[$k] = $down
        }
        if ($exitReason) { break }

        # 右键解除：单拍按下即生效（宽限期 1.2s + 预启动 3s 已足够防误触，
        # 再加"连续两拍"反而会吞掉快速点击）
        $rdown = [InputProbe]::IsDownNow(0x02)
        if ($rdown -and -not $prev[0x02]) { $exitReason = '鼠标右键'; break }
        $prev[0x02] = $rdown

        # 指纹识别：一刷指纹就给解除（事件 1004 成功识别 / 1605 成功授权）
        # 注意：Get-WinEvent 单次 50~300ms，会阻塞键鼠采样，所以降频到约 3 秒一次
        # （94 拍 × 40ms ≈ 3.76 秒）。指纹本身不着急，慢一点没关系。
        $bioChecked++
        if (($bioChecked % 94) -eq 0) {
            $bio = $false
            try { $bio = Test-FingerprintUsed -Since $tStart } catch { }
            if ($bio) { $exitReason = '指纹识别'; break }
        }

        # 时间跳变检测：长按电源键进入睡眠，唤醒后 GetTickCount 会大幅跳变
        $nowTick = [InputProbe]::Tick()
        $delta = [int64]$nowTick - [int64]$lastTick
        if ($delta -lt 0) { $delta += 4294967296 }   # uint 回绕
        if ($delta -gt 3000) {
            $exitReason = ("系统睡眠/唤醒（时间跳变 {0} ms）" -f $delta)
            break
        }
        $lastTick = $nowTick

        # 锁屏检测：每 400ms 查一次（含 Winlogon 桌面名判定）
        $lockProbe++
        if (($lockProbe % 10) -eq 0) {
            $lk = $false
            try { $lk = [InputProbe]::IsSessionLocked() } catch { }
            if ($lk) { $exitReason = '锁屏（电源/指纹键短按）'; break }
        }
        # LogonUI 进程存在 = 已锁屏/在登录界面（每 1.2 秒查一次，开销可控）
        $logonUiChecked++
        if (($logonUiChecked % 30) -eq 0) {
            if (Get-Process LogonUI -ErrorAction SilentlyContinue) { $exitReason = '锁屏（检测到登录界面）'; break }
        }

        if ($sw.Elapsed.TotalSeconds -ge $maxSeconds) { $exitReason = "超时($maxSeconds 秒)"; break }
        $raiseCount++
        if (($raiseCount % 50) -eq 0) { try { [BlackVeilRunner]::Raise() } catch { } }
    }
    Write-Log ("[恢复] 解除方式: $exitReason")

    # ---------- 阶段 4：还原 ----------
    try { [BlackVeilRunner]::HideSystemCursor($false) } catch { }
    try { [BlackVeilRunner]::Stop() } catch { }
    $null = Set-BrightnessValue -Value $saveB
    Write-Log ("[恢复] 亮度已还原为 $saveB%，显示已恢复")
    Remove-Item $stateFile, $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}
catch {
    Write-Log ("[关屏] 异常: " + $_.Exception.Message) 'ERROR'
    try { [BlackVeilRunner]::HideSystemCursor($false) } catch { }
    try { [BlackVeilRunner]::Stop() } catch { }
    try {
        $rb = 66
        if (Test-Path $stateFile) {
            $raw = Get-Content $stateFile -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($raw -match '^\d+\|(\d+)$') { $rb = [int]$Matches[1] }
        }
        if ($rb -lt 40) { $rb = 66 }    # 同主流程：0/过低值不可信
        $null = Set-BrightnessValue -Value $rb
    } catch { }
    Remove-Item $stateFile, $pidFile -Force -ErrorAction SilentlyContinue
    exit 1
}
finally {
    if ($ownsLock) {
        try { $lockMutex.ReleaseMutex() } catch { }
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    }
}