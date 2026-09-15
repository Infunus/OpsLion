param(
    [string]$Source,
    [string]$Runtime,
    [string]$Python,
    [string]$ImportFrom,
    [ValidateRange(1, 65535)][int]$Port = 8001
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $Source) { $Source = Join-Path $projectRoot 'we-mp-rss' }
if (-not $Runtime) { $Runtime = Join-Path $env:LOCALAPPDATA 'OpsLion\we-mp-rss' }
$Source = [IO.Path]::GetFullPath($Source)
$Runtime = [IO.Path]::GetFullPath($Runtime)
if (-not (Test-Path -LiteralPath (Join-Path $Source 'requirements.txt') -PathType Leaf)) {
    throw '请先取得完整 we-mp-rss 源码，并用 -Source 指定目录。说明见 docs/rss-integration.md。'
}
foreach ($boundary in @($projectRoot, $Source)) {
    $resolvedBoundary = [IO.Path]::GetFullPath($boundary).TrimEnd('\', '/')
    if ($Runtime -eq $resolvedBoundary -or $Runtime.StartsWith($resolvedBoundary + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runtime 必须位于源码目录之外，以免把文章或授权资料带进仓库。'
    }
}
if (-not $Python) { $Python = (Get-Command python -ErrorAction Stop).Source }
& $Python -c 'import sys; assert sys.version_info >= (3, 12), "完整 RSS 需要 Python 3.12 或更新版本"'
if ($LASTEXITCODE -ne 0) { throw 'Python 版本检查失败。请用 -Python 指定所需版本。' }
$runtimePython = Join-Path $Runtime '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
    & $Python -m venv (Join-Path $Runtime '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'RSS 虚拟环境创建失败。' }
}
& $runtimePython -m pip install --disable-pip-version-check -r (Join-Path $Source 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '完整 RSS 依赖安装失败。' }
& $runtimePython -m playwright install firefox chromium
if ($LASTEXITCODE -ne 0) { throw '原版采集浏览器安装失败。' }
& $runtimePython (Join-Path $PSScriptRoot 'patch_we_mp_rss.py') --source $Source
if ($LASTEXITCODE -ne 0) { throw 'RSS 采集进度、微信授权修复或前端构建失败，配置尚未切换。' }
$setupArgs = @((Join-Path $PSScriptRoot 'setup_we_mp_rss.py'), '--source', $Source, '--runtime', $Runtime)
if ($ImportFrom) { $setupArgs += @('--import-from', [IO.Path]::GetFullPath($ImportFrom)) }
& $runtimePython @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'RSS 数据初始化失败，配置尚未切换。' }
$configPath = Join-Path $projectRoot 'config\local.paths.json'
$values = @{}
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $existing.PSObject.Properties) { $values[$property.Name] = $property.Value }
}
$values.Remove('rss_provider')
$values.Remove('rss_token_file')
$values['rss_backend'] = 'we-mp-rss'
$values['rss_root'] = $Source
$values['rss_data_dir'] = $Runtime
$values['rss_python'] = $runtimePython
$values['rss_url'] = "http://127.0.0.1:$Port"
[IO.File]::WriteAllText($configPath, ($values | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Host '完整 RSS 已配置。进入排版台的周报，点击重新连接即可自动启动。'
Write-Host '已有实例沿用原 RSS 管理员账号；全新实例的本机登录信息见运行目录中的 opslion-admin.json。'
