$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "local-process.ps1")
$PidFile = Join-Path $ProjectRoot ".local-studio.pid"
$BridgePidFile = Join-Path $ProjectRoot ".local-bridge.pid"

if (-not (Test-Path -LiteralPath $PidFile) -and -not (Test-Path -LiteralPath $BridgePidFile)) {
  Write-Host "The layout studio is not running."
  exit 0
}

foreach ($CurrentPidFile in @($PidFile, $BridgePidFile)) {
  if (-not (Test-Path -LiteralPath $CurrentPidFile)) { continue }
  $ServerPid = 0
  $validPid = [int]::TryParse((Get-Content -LiteralPath $CurrentPidFile -Raw).Trim(), [ref]$ServerPid)
  $role = if ($CurrentPidFile -eq $PidFile) { "studio" } else { "bridge" }
  if ($validPid -and (Test-LocalProcessOwner $ServerPid $role)) {
    & taskkill.exe /PID $ServerPid /T /F | Out-Null
  }
  Remove-Item -LiteralPath $CurrentPidFile -Force -ErrorAction SilentlyContinue
}
Write-Host "The layout studio and local bridge have stopped."
