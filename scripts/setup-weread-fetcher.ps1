param([string]$Source, [string]$Runtime, [string]$Chrome)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localFile = Join-Path $projectRoot 'config\local.paths.json'
$local = @{}
if (Test-Path -LiteralPath $localFile) {
    $existing = Get-Content -LiteralPath $localFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $existing.PSObject.Properties) { $local[$property.Name] = $property.Value }
}
if (-not $Source) { $Source = Join-Path $projectRoot 'weread-mp-fetcher' }
if (-not $Runtime) {
    if ($local.weread_fetcher_data_dir) { $Runtime = $local.weread_fetcher_data_dir }
    elseif ($local.rss_data_dir) { $Runtime = Join-Path (Split-Path $local.rss_data_dir -Parent) 'weread-mp-fetcher' }
    else { $Runtime = Join-Path $env:LOCALAPPDATA 'OpsLion\weread-mp-fetcher' }
}
$Source = [IO.Path]::GetFullPath($Source)
$Runtime = [IO.Path]::GetFullPath($Runtime)
foreach ($boundary in @($projectRoot, $Source)) {
    $boundary = [IO.Path]::GetFullPath($boundary).TrimEnd('\', '/')
    if ($Runtime -eq $boundary -or $Runtime.StartsWith($boundary + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '采集运行目录必须位于源码目录之外。'
    }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node -e 'if (parseInt(process.versions.node) < 18) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw '需要 Node.js 18 或更新版本。' }
if (-not $Chrome) { $Chrome = $local.weread_fetcher_chrome }
if (-not $Chrome) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $Chrome = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $Chrome -or -not (Test-Path -LiteralPath $Chrome -PathType Leaf)) { throw '未找到 Chrome，请用 -Chrome 指定 chrome.exe。' }
$revision = '3944db5e6df3dfb7c12d1ac2fddb902361cbc781'
if (-not (Test-Path -LiteralPath $Source)) {
    & git clone --no-checkout --depth 1 https://github.com/Pengyf04/weread-mp-fetcher.git $Source
    if ($LASTEXITCODE -ne 0) { throw '下载采集工具失败。' }
    & git -C $Source fetch --depth 1 origin $revision
    if ($LASTEXITCODE -ne 0) { throw '无法取得已核对的工具版本。' }
    & git -C $Source checkout --detach $revision
    if ($LASTEXITCODE -ne 0) { throw '无法检出已核对的工具版本。' }
}
$actualRevision = & git -C $Source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actualRevision -ne $revision) { throw '源码版本与已核对版本不符，请使用独立的新 Source 目录安装。' }
& $node (Join-Path $Source 'test\offline.test.mjs')
if ($LASTEXITCODE -ne 0) { throw '上游离线检查失败，尚未写入接入配置。' }
$local.weread_fetcher_root = $Source
$local.weread_fetcher_data_dir = $Runtime
$local.weread_fetcher_chrome = [IO.Path]::GetFullPath($Chrome)
[IO.File]::WriteAllText($localFile, ($local | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
& $node (Join-Path $PSScriptRoot 'weread-fetcher.mjs') init
if ($LASTEXITCODE -ne 0) { throw '本机采集配置初始化失败，请查看上方错误。' }
Write-Host '安装完成。双击项目目录中的“启动公众号采集.bat”。'
