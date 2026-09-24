<#
Скрипт: запуск/перевірка локального кластера Minikube.
Вимоги: Docker Desktop (WSL2), Minikube, kubectl — див. SETUP.md.
#>
$ErrorActionPreference = 'Stop'

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command 'minikube')) { throw 'Minikube не встановлено. Див. SETUP.md' }
if (-not (Test-Command 'docker')) { throw 'Docker не встановлено. Див. SETUP.md' }
if (-not (Test-Command 'kubectl')) { throw 'kubectl не встановлено. Див. SETUP.md' }

Write-Host '==> Перевірка статусу Minikube...'
& minikube status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '==> Старт Minikube (driver=docker)...'
  & minikube start --driver=docker
} else {
  Write-Host '    Minikube вже запущено.'
}

Write-Host '==> Увімкнення ingress addon...'
& minikube addons enable ingress

Write-Host '==> Поточний контекст:'
kubectl config current-context
kubectl get nodes -o wide

Write-Host ''
Write-Host 'Кластер готовий. Далі виконайте: .\scripts\deploy.ps1'