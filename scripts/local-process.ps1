function Get-LocalProcessRole([string]$Root, [string]$Name, [string]$CommandLine) {
  $normalizedRoot = $Root.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
  $command = $CommandLine.Replace('\', '/').ToLowerInvariant()
  $processName = $Name.ToLowerInvariant()
  if ($processName -match '^node(?:\.exe)?$' -and
      $command.Contains($normalizedRoot + '/node_modules/') -and
      $command -match '/vinext/dist/cli\.js(?:["\s]|$)') { return "studio" }
  if ($processName -match '^pythonw?(?:\.exe)?$' -and
      $command -match ([regex]::Escape($normalizedRoot + '/scripts/local_bridge.py') + '(?:["\s]|$)')) { return "bridge" }
  return ""
}

function Test-LocalProcessOwner([int]$ProcessId, [string]$Role) {
  if ($ProcessId -le 0) { return $false }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $process) { return $false }
    return (Get-LocalProcessRole $ProjectRoot $process.Name ([string]$process.CommandLine)) -eq $Role
  } catch { return $false }
}
