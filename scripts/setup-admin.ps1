<#
Скрипт: налаштування інфраструктури, що потребує прав адміністратора.
Запускається автоматично з UAC-промптом (не запускай вручну без потреби):
  1. Вмикає компоненти WSL / VirtualMachinePlatform
  2. Встановлює WSL2 (дистрибутив Ubuntu за замовчуванням)
  3. Встановлює Docker Desktop (winget)
  4. Виконує wsl --update
Після завершення потрібне ПЕРЕЗАВАНТАЖЕННЯ машини.
#>
$ErrorActionPreference = 'Stop'

function Log([string]$msg) { Write-Host "[setup] $msg" -ForegroundColor Cyan }

Log 'Перевірка прав адміністратора...'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Потрібен запуск від імені адміністратора!' }

Log 'Вмикання компонентів Windows (WSL + VirtualMachinePlatform)...'
$features = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
foreach ($f in $features) {
  $state = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction SilentlyContinue).State
  if ($state -ne 'Enabled') {
    Log "Вмикаю фічу: $f"
    dism.exe /Online /Enable-Feature /FeatureName:$f /NoRestart /Quiet | Out-Null
  } else {
    Log "Фичу $f вже увімкнено."
  }
}

Log 'Встановлення/оновлення WSL2...'
try {
  wsl.exe --install --no-distribution 2>&1 | ForEach-Object { Log $_ }
} catch { Log "wsl --install попередив: $_" }

try {
  wsl.exe --update 2>&1 | ForEach-Object { Log $_ }
} catch { Log "wsl --update попередив: $_" }

wsl.exe --set-default-version 2 2>&1 | ForEach-Object { Log $_ }

Log 'Встановлення Docker Desktop через winget...'
winget install --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements --silent
if ($LASTEXITCODE -ne 0) { throw 'winget install Docker Desktop завершився з помилкою' }

Log 'DONE. Перезавантажте машину, після чого в Docker Desktop увімкніть WSL2 backend.'