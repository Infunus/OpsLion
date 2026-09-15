param(
    [ValidateSet('Start', 'Check')][string]$Action = 'Check',
    [Parameter(Mandatory=$true)][string]$ConfigFile,
    [string]$Browser,
    [ValidateSet('Background', 'Visible')][string]$Mode = 'Background',
    [switch]$SwitchMode
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$profile = [IO.Path]::GetFullPath($config.chromeProfileDir).TrimEnd('\').Replace('\', '/')
$expected = '(?:^|\s)--user-data-dir=(?:"' + [regex]::Escape($profile) + '"|' + [regex]::Escape($profile) + '(?=\s|$))'
$script:CurrentMode = ''
function Test-CollectorBrowser {
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='vivaldi.exe' OR Name='chromium.exe'" | Where-Object {
        $command = ([string]$_.CommandLine).Replace('\', '/')
        $command -notmatch '(?:^|\s)--type=' -and $command -match $expected
    })
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $config.chromePort -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $false }
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -notin $owned.ProcessId) { throw '采集浏览器端口被其他程序占用，请关闭冲突程序后重试。' }
        if ($listener.LocalAddress -notin @('127.0.0.1', '::1')) { throw '采集浏览器端口未限制到本机，请关闭这个采集窗口后重新打开。' }
        $owner = $owned | Where-Object ProcessId -eq $listener.OwningProcess | Select-Object -First 1
        if ($Browser -and $owner.ExecutablePath -and -not ([string]$owner.ExecutablePath).Equals($Browser, [StringComparison]::OrdinalIgnoreCase)) { throw '当前采集会话与默认浏览器不一致，请重新获取登录二维码。' }
        $script:CurrentMode = if ($owner.CommandLine -match '(?:^|\s)--headless(?:=|\s|$)') { 'Background' } else { 'Visible' }
    }
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.chromePort)/json/version" -TimeoutSec 2 -Proxy $null
        return [bool]$version.webSocketDebuggerUrl
    } catch { return $false }
}
try {
    $running = Test-CollectorBrowser
    if ($Action -eq 'Start' -and $running -and $SwitchMode -and $script:CurrentMode -ne $Mode) {
        # Ownership was verified above; only close this dedicated collector instance.
        & node (Join-Path $PSScriptRoot 'collector-auth.mjs') close $ConfigFile | Out-Null
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 250
            if (-not (Test-CollectorBrowser)) { $running = $false; break }
        }
        if ($running) { throw '采集浏览器还在结束旧会话，请稍后重试。' }
    }
    if ($Action -eq 'Start' -and -not $running) {
        if (-not $Browser -or -not (Test-Path -LiteralPath $Browser -PathType Leaf)) { throw '未找到受支持的默认浏览器，请检查 Windows 默认应用设置。' }
        $arguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$($config.chromePort)", ('--user-data-dir="' + $config.chromeProfileDir + '"'), '--no-first-run', '--no-default-browser-check', '--window-size=1100,900')
        if ($Mode -eq 'Background') { $arguments += '--headless=new' }
        $arguments += 'https://weread.qq.com/'
        if ($Mode -eq 'Visible') {
            # Show the default browser for user-requested login or detected verification.
            Start-Process -FilePath $Browser -ArgumentList $arguments -WindowStyle Normal | Out-Null
        } else { Start-Process -FilePath $Browser -ArgumentList $arguments -WindowStyle Hidden | Out-Null }
        for ($attempt = 0; $attempt -lt 16; $attempt++) {
            Start-Sleep -Milliseconds 500
            $running = Test-CollectorBrowser
            if ($running) { break }
        }
        if (-not $running) { throw '采集浏览器未启动成功，请关闭独立采集窗口后重试。' }
    }
    @{ running = $running; mode = $script:CurrentMode } | ConvertTo-Json -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
