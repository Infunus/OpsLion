param(
    [ValidateSet('Menu', 'Check', 'Browser', 'Prepare', 'Trial', 'Collect', 'Content', 'Quota', 'Results', 'Config')]
    [string]$Action = 'Menu',
    [ValidateRange(1, 3)][int]$Pages = 1,
    [string]$IndexFile,
    [string]$StartDate,
    [string]$EndDate
)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$projectRoot = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node.exe -ErrorAction Stop).Source
$helper = Join-Path $PSScriptRoot 'weread-fetcher.mjs'

function Read-FetcherConfig {
    $script:local = Get-Content -LiteralPath (Join-Path $projectRoot 'config\local.paths.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $local.weread_fetcher_data_dir) { throw '请先运行 scripts/setup-weread-fetcher.ps1 安装采集工具。' }
    $script:configFile = Join-Path $local.weread_fetcher_data_dir 'config.json'
    $script:config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-FetcherBrowser {
    $profile = [IO.Path]::GetFullPath($config.chromeProfileDir).TrimEnd('\').Replace('\', '/')
    $expected = '(?:^|\s)--user-data-dir=(?:"' + [regex]::Escape($profile) + '"|' + [regex]::Escape($profile) + '(?=\s|$))'
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $command = ([string]$_.CommandLine).Replace('\', '/')
        $command -notmatch '(?:^|\s)--type=' -and $command -match $expected
    })
}

function Test-FetcherBrowser {
    $browserProcesses = @(Get-FetcherBrowser)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $config.chromePort -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $false }
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -notin $browserProcesses.ProcessId) {
            throw "端口 $($config.chromePort) 已被其他程序占用。请在配置中更换 chromePort，再重新打开采集浏览器。"
        }
        if ($listener.LocalAddress -notin @('127.0.0.1', '::1')) { throw '浏览器调试端口未限制到本机，请关闭采集浏览器后重新打开。' }
    }
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.chromePort)/json/version" -TimeoutSec 2 -Proxy $null
        return [bool]$version.webSocketDebuggerUrl
    } catch { return $false }
}

function Open-FetcherBrowser {
    if (Test-FetcherBrowser) {
        Write-Host '采集浏览器已经打开，请切换到该 Chrome 窗口完成登录。'
        return
    }
    if (@(Get-FetcherBrowser).Count) { throw '采集浏览器已运行，但调试端口未就绪。请关闭这个独立浏览器窗口，再选 1 打开。' }
    if (-not (Test-Path -LiteralPath $local.weread_fetcher_chrome -PathType Leaf)) { throw 'Chrome 程序不存在，请重新运行安装脚本。' }
    $browserArgs = @(
        '--remote-debugging-address=127.0.0.1',
        "--remote-debugging-port=$($config.chromePort)",
        ('--user-data-dir="' + $config.chromeProfileDir + '"'),
        '--no-first-run', '--no-default-browser-check', 'https://weread.qq.com/'
    )
    # This action is selected by the user to open the interactive login window.
    Start-Process -FilePath $local.weread_fetcher_chrome -ArgumentList $browserArgs -WindowStyle Normal | Out-Null
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-FetcherBrowser) {
            Write-Host '采集浏览器已打开。在新窗口扫码登录微信读书，然后回到这里选 2。'
            return
        }
    }
    throw 'Chrome 调试端口没有启动成功。请检查新窗口是否正常打开，并关闭它后重试。'
}

function Invoke-FetcherAction([string]$Selected) {
    Read-FetcherConfig
    if ($Selected -in @('Prepare', 'Trial', 'Collect') -and -not (Test-FetcherBrowser)) {
        throw '请先选 1 打开采集浏览器，并在该窗口扫码登录。'
    }
    if ($Selected -eq 'Content') { Test-FetcherBrowser | Out-Null }
    switch ($Selected) {
        'Browser' { Open-FetcherBrowser }
        'Results' { Invoke-Item -LiteralPath $config.outDir }
        'Config' { Start-Process -FilePath notepad.exe -ArgumentList ('"' + $configFile + '"') -WindowStyle Normal | Out-Null }
        default {
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $mutexId = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($local.weread_fetcher_data_dir.ToLowerInvariant()))).Replace('-', '') }
            finally { $sha.Dispose() }
            $mutex = [Threading.Mutex]::new($false, ('Local\OpsLionWeRead-' + $mutexId))
            $acquired = $false
            try {
                try { $acquired = $mutex.WaitOne(0) }
                catch [Threading.AbandonedMutexException] { $acquired = $true }
                if (-not $acquired) { throw '另一个窗口正在执行采集操作，请等待它完成。' }
                if ($Selected -eq 'Content') {
                    $today = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'China Standard Time').Date
                    $weekday = ([int]$today.DayOfWeek + 6) % 7
                    $defaultEnd = $today.AddDays(-$weekday - 1)
                    $selectedStart = if ($StartDate) { $StartDate } else { $defaultEnd.AddDays(-6).ToString('yyyy-MM-dd') }
                    $selectedEnd = if ($EndDate) { $EndDate } else { $defaultEnd.ToString('yyyy-MM-dd') }
                    if ($Action -eq 'Menu') {
                        $entered = Read-Host "开始日期（回车使用 $selectedStart）"
                        if ($entered) { $selectedStart = $entered }
                        $entered = Read-Host "结束日期（回车使用 $selectedEnd）"
                        if ($entered) { $selectedEnd = $entered }
                    }
                    $selectedIndex = if ($IndexFile) { $IndexFile } else { 'latest' }
                    & $node (Join-Path $PSScriptRoot 'weread-content.mjs') $selectedIndex $selectedStart $selectedEnd
                } else {
                    & $node $helper $Selected.ToLowerInvariant() $Pages
                }
                if ($LASTEXITCODE -ne 0) { throw '本次操作未全部完成，具体原因见上方提示。' }
            } finally {
                if ($acquired) { $mutex.ReleaseMutex() }
                $mutex.Dispose()
            }
        }
    }
}

if ($Action -ne 'Menu') {
    Invoke-FetcherAction $Action
    exit 0
}
Read-FetcherConfig
Write-Host '公众号文章采集'
Write-Host '首次使用：1 扫码登录 → 2 准备公众号 → 3 试采一个公众号。'
Write-Host '先对照公众号核对最近一周是否齐全，再使用 4 采集全部。'
while ($true) {
    Write-Host ''
    Write-Host '1  打开登录浏览器'
    Write-Host '2  准备已配置的公众号（加入微信读书书架）'
    Write-Host '3  试采第一个公众号的目录'
    Write-Host '4  采集全部已配置公众号的目录'
    Write-Host '5  打开导出文件夹'
    Write-Host '6  编辑公众号配置'
    Write-Host '7  查看今日采集次数'
    Write-Host '8  查看环境与公众号名单'
    Write-Host '9  按日期下载正文并打包（可继续未完成的下载）'
    Write-Host '0  退出'
    $choice = Read-Host '输入数字并回车'
    if ($choice -eq '0' -or $null -eq $choice) { break }
    $actions = @{ '1'='Browser'; '2'='Prepare'; '3'='Trial'; '4'='Collect'; '5'='Results'; '6'='Config'; '7'='Quota'; '8'='Check'; '9'='Content' }
    if (-not $actions.ContainsKey($choice)) { Write-Host '请输入菜单中的数字。'; continue }
    try { Invoke-FetcherAction $actions[$choice] }
    catch { Write-Host $_.Exception.Message -ForegroundColor Red }
}
