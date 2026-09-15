function Get-LocalProcessIdentity([string]$Name, [string]$CommandLine) {
  # Match the actual script argument, never a project path mentioned in later arguments.
  $arguments = [regex]::Match($CommandLine.Trim(), '^(?:"[^"]+"|[^\s"]+)\s+(?:"(?<entry>[^"]+)"|(?<entry>[^\s"]+))(?:\s|$)')
  if (-not $arguments.Success) { return $null }
  $entry = $arguments.Groups["entry"].Value
  if (-not [System.IO.Path]::IsPathRooted($entry)) { return $null }
  try { $entry = [System.IO.Path]::GetFullPath($entry).Replace('\', '/') }
  catch { return $null }
  if ($Name -match '^node(?:\.exe)?$' -and $entry -match '^(?<root>.+)/node_modules/vinext/dist/cli\.js$') {
    return [PSCustomObject]@{ Root = $Matches["root"]; Role = "studio" }
  }
  if ($Name -match '^python(?:w|[0-9.]+)?(?:\.exe)?$' -and $entry -match '^(?<root>.+)/scripts/local_bridge\.py$') {
    return [PSCustomObject]@{ Root = $Matches["root"]; Role = "bridge" }
  }
  return $null
}

function Test-OpsLionProject([string]$Root) {
  try {
    $manifest = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw -ErrorAction Stop | ConvertFrom-Json
    return $manifest.name -eq "opslion" -and
      (Test-Path -LiteralPath (Join-Path $Root "app/studio/StudioApp.tsx") -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $Root "scripts/local_bridge.py") -PathType Leaf)
  } catch { return $false }
}

function Get-LocalProcessRole([string]$Root, [string]$Name, [string]$CommandLine, [switch]$AllowOtherProjects) {
  $identity = Get-LocalProcessIdentity $Name $CommandLine
  if (-not $identity) { return "" }
  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).Replace('\', '/').TrimEnd('/')
  if ($identity.Root -eq $normalizedRoot -or ($AllowOtherProjects -and (Test-OpsLionProject $identity.Root))) {
    return $identity.Role
  }
  return ""
}

function Test-LocalProcessOwner([int]$ProcessId, [string]$Role, [switch]$AllowOtherProjects) {
  if ($ProcessId -le 0) { return $false }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $process) { return $false }
    return (Get-LocalProcessRole $ProjectRoot $process.Name ([string]$process.CommandLine) -AllowOtherProjects:$AllowOtherProjects) -eq $Role
  } catch { return $false }
}
