param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "local-process.ps1")
$PidFile = Join-Path $ProjectRoot ".local-studio.pid"
$BridgePidFile = Join-Path $ProjectRoot ".local-bridge.pid"
$LogFile = Join-Path $ProjectRoot ".local-studio.log"
$ErrorLogFile = Join-Path $ProjectRoot ".local-studio-error.log"
$BridgeLogFile = Join-Path $ProjectRoot ".local-bridge.log"
$BridgeErrorLogFile = Join-Path $ProjectRoot ".local-bridge-error.log"
$LocalPort = 3000
$BridgePort = 4319
$LocalUrl = "http://127.0.0.1:$LocalPort"
$BridgeUrl = "http://127.0.0.1:$BridgePort/health"

function Get-HttpStatus([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return [int]$response.StatusCode
  } catch {
    try {
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        return [int]$_.Exception.Response.StatusCode
      }
    } catch {
    }
    return 0
  }
}

function Test-StudioReady {
  $status = Get-HttpStatus $LocalUrl
  return $status -eq 200
}

function Test-BridgeReady {
  try {
    $response = Invoke-WebRequest -Uri $BridgeUrl -UseBasicParsing -TimeoutSec 2
    if ([int]$response.StatusCode -ne 200) { return $false }
    try {
      $payload = $response.Content | ConvertFrom-Json
      if ($null -ne $payload.ok) { return $payload.ok -eq $true }
    } catch {
    }
    return $true
  } catch {
    return $false
  }
}

function Get-PortOwner([int]$Port) {
  try {
    $command = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
    if ($command) {
      $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($connection -and $connection.OwningProcess) {
        return [int]$connection.OwningProcess
      }
    }
  } catch {
  }

  try {
    $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
    $lines = & $netstat -ano -p tcp 2>$null
    foreach ($line in $lines) {
      $parts = @($line -split '\s+' | Where-Object { $_ -ne "" })
      if ($parts.Count -lt 5) { continue }
      if ($parts[0].ToUpperInvariant() -ne "TCP") { continue }
      if ($parts[1] -notmatch ":$Port$") { continue }
      $remote = $parts[2]
      if ($remote -ne "0.0.0.0:0" -and $remote -ne "[::]:0") { continue }
      $candidate = 0
      if ([int]::TryParse($parts[$parts.Count - 1], [ref]$candidate)) {
        return $candidate
      }
    }
  } catch {
  }

  return 0
}

function Get-ProcessNameSafe([int]$ProcessId) {
  if ($ProcessId -le 0) { return "" }
  try {
    return [string](Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName
  } catch {
    return ""
  }
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
  }
}

function Wait-PortFree([int]$Port, [int]$Attempts = 30) {
  for ($i = 0; $i -lt $Attempts; $i += 1) {
    if ((Get-PortOwner $Port) -eq 0) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return (Get-PortOwner $Port) -eq 0
}

function Remove-PidFile([string]$Path) {
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Save-ListenerPid([int]$Port, [string]$Path) {
  $owner = Get-PortOwner $Port
  if ($owner -gt 0) {
    $role = if ($Port -eq $LocalPort) { "studio" } else { "bridge" }
    if (-not (Test-LocalProcessOwner $owner $role)) {
      throw "Port $Port belongs to another program (PID $owner); it will not be reused or stopped."
    }
    Set-Content -LiteralPath $Path -Value $owner -Encoding ascii
  }
}

function Clear-StudioCaches {
  Write-Host "Clearing recoverable Vinext/Vite caches..." -ForegroundColor Yellow
  $cachePaths = @(
    (Join-Path $ProjectRoot ".vinext"),
    (Join-Path $ProjectRoot ".next"),
    (Join-Path $ProjectRoot "node_modules\.vite")
  )

  foreach ($path in $cachePaths) {
    if (Test-Path -LiteralPath $path) {
      try {
        $cacheRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        $cacheTarget = (Resolve-Path -LiteralPath $path -ErrorAction Stop).ProviderPath
        if (-not $cacheTarget.StartsWith($cacheRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Cache path is outside the project: $cacheTarget"
        }
        if ((Get-Item -LiteralPath $cacheTarget).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
          throw "Cache path is a link and will not be removed: $cacheTarget"
        }
        Remove-Item -LiteralPath $cacheTarget -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Host "Could not fully remove cache: $path" -ForegroundColor Yellow
      }
    }
  }
}

function Get-LogSummary([string]$Path, [int]$MaxLines = 180) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  try {
    $lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop)
    if ($lines.Count -eq 0) { return "" }

    # Health probes can generate many identical GET / 500 lines. Remove them so
    # the actual Vinext/React error near the beginning remains visible.
    $filtered = @($lines | Where-Object { $_ -notmatch '^\s*GET\s+/\s+500\b' })
    if ($filtered.Count -eq 0) { $filtered = $lines }

    if ($filtered.Count -le $MaxLines) {
      return ($filtered -join [Environment]::NewLine).Trim()
    }

    $headCount = [Math]::Min(120, $filtered.Count)
    $tailCount = [Math]::Min(40, $filtered.Count - $headCount)
    $result = @($filtered | Select-Object -First $headCount)
    $result += "... log truncated ..."
    if ($tailCount -gt 0) {
      $result += @($filtered | Select-Object -Last $tailCount)
    }
    return ($result -join [Environment]::NewLine).Trim()
  } catch {
    return ""
  }
}

function Stop-ListenerIfAllowed([int]$Port, [string[]]$AllowedProcessNames, [string]$Label) {
  $owner = Get-PortOwner $Port
  if ($owner -le 0) { return }

  $name = (Get-ProcessNameSafe $owner).ToLowerInvariant()
  $role = if ($Port -eq $LocalPort) { "studio" } else { "bridge" }
  if ($AllowedProcessNames -notcontains $name -or -not (Test-LocalProcessOwner $owner $role)) {
    throw "$Label port $Port is occupied by another program.`nPID: $owner`nProcess: $name"
  }

  Write-Host "Cleaning previous $Label process (PID $owner)..." -ForegroundColor Yellow
  Stop-ProcessTree $owner
  if (-not (Wait-PortFree $Port)) {
    $remaining = Get-PortOwner $Port
    throw "Could not release port $Port.`nPID: $remaining`nProcess: $(Get-ProcessNameSafe $remaining)"
  }
}

function Stop-StudioAttempt($LauncherProcess) {
  if ($LauncherProcess) {
    try {
      if (-not $LauncherProcess.HasExited) {
        Stop-ProcessTree $LauncherProcess.Id
      }
    } catch {
    }
  }

  $owner = Get-PortOwner $LocalPort
  if ($owner -gt 0 -and (Test-LocalProcessOwner $owner "studio")) {
    Stop-ProcessTree $owner
  }
  Wait-PortFree $LocalPort | Out-Null
  Remove-PidFile $PidFile
}

function Wait-StudioStart($LauncherProcess, [int]$MaxAttempts = 100) {
  $launcherExitedAt = -1
  $firstHttp500At = -1

  for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt += 1) {
    $status = Get-HttpStatus $LocalUrl

    if ($status -eq 200) {
      return [PSCustomObject]@{ State = "Ready"; Status = $status }
    }

    if ($status -ge 500) {
      if ($firstHttp500At -lt 0) { $firstHttp500At = $attempt }
      # Give the dev server time to finish dependency optimization/compilation.
      # If the root page keeps returning 500 for 15 seconds, treat it as an
      # application/cache failure rather than an unresponsive process.
      if (($attempt - $firstHttp500At) -ge 30) {
        return [PSCustomObject]@{ State = "HttpError"; Status = $status }
      }
    } else {
      $firstHttp500At = -1
    }

    if ($LauncherProcess -and $LauncherProcess.HasExited -and $launcherExitedAt -lt 0) {
      $launcherExitedAt = $attempt
    }

    # npm.cmd may exit before the child Node server binds its port, so allow a
    # short grace period after the launcher exits.
    if ($launcherExitedAt -ge 0 -and ($attempt - $launcherExitedAt) -ge 16 -and (Get-PortOwner $LocalPort) -eq 0) {
      return [PSCustomObject]@{ State = "NoResponse"; Status = 0 }
    }

    Start-Sleep -Milliseconds 500
  }

  $finalStatus = Get-HttpStatus $LocalUrl
  if ($finalStatus -eq 200) {
    return [PSCustomObject]@{ State = "Ready"; Status = $finalStatus }
  }
  if ($finalStatus -ge 500) {
    return [PSCustomObject]@{ State = "HttpError"; Status = $finalStatus }
  }
  return [PSCustomObject]@{ State = "NoResponse"; Status = 0 }
}

function Start-StudioAttempt($NpmCommand) {
  Remove-Item -LiteralPath $LogFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ErrorLogFile -Force -ErrorAction SilentlyContinue

  $server = Start-Process -FilePath $NpmCommand.Source `
    -ArgumentList @("run", "dev") `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrorLogFile

  Set-Content -LiteralPath $PidFile -Value $server.Id -Encoding ascii
  $result = Wait-StudioStart $server

  return [PSCustomObject]@{
    Result = $result
    Process = $server
  }
}

Write-Host "[1/4] Checking local ports..." -ForegroundColor Cyan

$StudioAlreadyRunning = $false
$existingStatus = Get-HttpStatus $LocalUrl
if ($existingStatus -eq 200) {
  Save-ListenerPid $LocalPort $PidFile
  $StudioAlreadyRunning = $true
  Write-Host "Existing layout studio found; it will be reused." -ForegroundColor Yellow
} else {
  $owner = Get-PortOwner $LocalPort
  if ($owner -gt 0) {
    $ownerName = (Get-ProcessNameSafe $owner).ToLowerInvariant()
    if ($ownerName -ne "node") {
      throw "Layout studio port $LocalPort is occupied by another program.`nPID: $owner`nProcess: $ownerName"
    }

    if ($existingStatus -ge 500) {
      Write-Host "An existing studio is returning HTTP $existingStatus. Recovering it..." -ForegroundColor Yellow
    } else {
      Write-Host "A stale studio process is holding port $LocalPort. Recovering it..." -ForegroundColor Yellow
    }

    Stop-ListenerIfAllowed $LocalPort @("node") "layout studio"
    Clear-StudioCaches
  }
  Remove-PidFile $PidFile
}

$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Npm) {
  throw "Node.js/npm was not found. Install Node.js 22 or later first."
}

$Python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $Python) { $Python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $Python) {
  throw "Python was not found. Install Python 3.10 or later first."
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
  Write-Host "First run: installing local dependencies..." -ForegroundColor Yellow
  & $Npm.Source install --prefix $ProjectRoot
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}

Write-Host "[2/4] Checking the local data bridge..." -ForegroundColor Cyan

if (Test-BridgeReady) {
  Save-ListenerPid $BridgePort $BridgePidFile
  Write-Host "Existing data bridge found; it will be reused." -ForegroundColor Yellow
} else {
  $bridgeOwner = Get-PortOwner $BridgePort
  if ($bridgeOwner -gt 0) {
    Stop-ListenerIfAllowed $BridgePort @("python", "pythonw") "data bridge"
  }
  Remove-PidFile $BridgePidFile

  Remove-Item -LiteralPath $BridgeLogFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $BridgeErrorLogFile -Force -ErrorAction SilentlyContinue

  Write-Host "Starting the local data bridge..." -ForegroundColor Gray
  $Bridge = Start-Process -FilePath $Python.Source `
    -ArgumentList @('"' + (Join-Path $PSScriptRoot "local_bridge.py") + '"') `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $BridgeLogFile `
    -RedirectStandardError $BridgeErrorLogFile

  Set-Content -LiteralPath $BridgePidFile -Value $Bridge.Id -Encoding ascii

  $BridgeReady = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if (Test-BridgeReady) {
      $BridgeReady = $true
      break
    }
    if ($Bridge.HasExited -and $attempt -ge 5) { break }
    Start-Sleep -Milliseconds 300
  }

  if (-not $BridgeReady) {
    Stop-ProcessTree $Bridge.Id
    Remove-PidFile $BridgePidFile
    $bridgeError = Get-LogSummary $BridgeErrorLogFile 100
    $bridgeOutput = Get-LogSummary $BridgeLogFile 100
    $bridgeDetails = @($bridgeError, $bridgeOutput) | Where-Object { $_ -ne "" }
    if ($bridgeDetails.Count -eq 0) { $bridgeDetails = @("No bridge log was generated.") }
    throw "The local integration bridge did not start.`n$($bridgeDetails -join [Environment]::NewLine)"
  }

  Save-ListenerPid $BridgePort $BridgePidFile
}

if ($StudioAlreadyRunning) {
  Write-Host "[3/4] Layout studio is already ready." -ForegroundColor Cyan
  if (-not $NoBrowser) { Start-Process -FilePath $LocalUrl -ErrorAction Stop }
  Write-Host "[4/4] Layout studio ready: $LocalUrl" -ForegroundColor Green
  exit 0
}

Write-Host "[3/4] Starting the layout studio..." -ForegroundColor Cyan

$attempt = Start-StudioAttempt $Npm
$result = $attempt.Result
$server = $attempt.Process

if ($result.State -eq "HttpError") {
  Write-Host "The studio started but the page returned HTTP $($result.Status). Trying cache recovery once..." -ForegroundColor Yellow
  Stop-StudioAttempt $server
  Clear-StudioCaches
  Start-Sleep -Milliseconds 500

  $attempt = Start-StudioAttempt $Npm
  $result = $attempt.Result
  $server = $attempt.Process
}

if ($result.State -eq "Ready") {
  Save-ListenerPid $LocalPort $PidFile
  if (-not $NoBrowser) { Start-Process -FilePath $LocalUrl -ErrorAction Stop }
  Write-Host "[4/4] Layout studio ready: $LocalUrl" -ForegroundColor Green
  exit 0
}

Stop-StudioAttempt $server

$stderr = Get-LogSummary $ErrorLogFile 180
$stdout = Get-LogSummary $LogFile 180
$details = @()
if ($stderr -ne "") { $details += "--- stderr ---`n$stderr" }
if ($stdout -ne "") { $details += "--- stdout ---`n$stdout" }
if ($details.Count -eq 0) { $details += "No startup log was generated." }

if ($result.State -eq "HttpError") {
  throw "The local server started, but the page kept returning HTTP $($result.Status) after automatic cache recovery.`n$($details -join [Environment]::NewLine)"
}

throw "The local service did not start.`n$($details -join [Environment]::NewLine)"
