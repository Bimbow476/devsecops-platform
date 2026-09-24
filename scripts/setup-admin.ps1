<#
DevSecOps platform - admin environment setup (WSL2 + Docker Desktop)
Requires: run as Administrator.
Log file: C:\Users\Administrator\setup-admin.log
NOTE: keep this file pure ASCII (no Cyrillic) for PowerShell 5.1 compatibility.
#>

$logFile = 'C:\Users\Administrator\setup-admin.log'
$ErrorActionPreference = 'Continue'

function Log([string]$msg) {
  $line = "[setup] $(Get-Date -Format 'HH:mm:ss') $msg"
  Write-Host $line -ForegroundColor Cyan
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

"--- setup-admin run $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ---" | Set-Content -Path $logFile -Encoding UTF8

try {
  Log 'Checking administrator rights...'
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { Log 'ERROR: Admin rights required. Aborting.'; exit 1 }

  Log 'Enabling Windows features (WSL + VirtualMachinePlatform)...'
  $features = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
  foreach ($f in $features) {
    try { $state = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction Stop).State } catch { $state = 'UNKNOWN' }
    Log "Feature $f state=$state"
    if ($state -ne 'Enabled') {
      Log "Enabling feature: $f (dism, may take a few minutes)"
      dism.exe /Online /Enable-Feature /FeatureName:$f /NoRestart /Quiet | Out-Null
      Log "dism for $f finished with code $LASTEXITCODE"
    }
  }

  Log 'Installing/updating WSL2...'
  $o = wsl.exe --install --no-distribution 2>&1 | Out-String
  Log ("wsl --install --no-distribution: " + $o.Trim())
  Log "wsl exit code: $LASTEXITCODE"

  $o = wsl.exe --update 2>&1 | Out-String
  Log ("wsl --update: " + $o.Trim())

  wsl.exe --set-default-version 2 2>&1 | Out-Null

  Log 'Installing Docker Desktop via winget...'
  $o = winget install --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-String
  Log ("winget Docker Desktop: " + $o.Trim())
  Log "winget exit code: $LASTEXITCODE"

  Log 'DONE. Reboot the machine, then enable WSL2 backend in Docker Desktop.'
} catch {
  Log "CRITICAL ERROR: $($_.Exception.Message)"
  Log $_.ScriptStackTrace
}