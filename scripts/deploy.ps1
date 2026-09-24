<#
Скрипт: локальний деплой платформи в Minikube.
  - збирає Docker-образи з тегом :local
  - застосовує Kubernetes-маніфести (namespace devsecops)
  - показує, як відкрити фронтенд
#>
param(
  [string]$Namespace = 'devsecops'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command 'minikube' -ErrorAction SilentlyContinue)) { throw 'Minikube не встановлено' }
if (-not (Get-Command 'docker' -ErrorAction SilentlyContinue)) { throw 'Docker не встановлено' }

Write-Host '==> Додавання docker-демона Minikube (docker-env)...'
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
if ($LASTEXITCODE -ne 0) {
  Write-Host '==> Minikube не запущено. Старт...' -ForegroundColor Yellow
  & minikube start --driver=docker
  & minikube -p minikube docker-env --shell powershell | Invoke-Expression
}

Write-Host '==> Збірка образів (:local)...'
docker build -t devsecops-platform-gateway:local  ./services/gateway
docker build -t devsecops-platform-metrics:local ./services/metrics
docker build -t devsecops-platform-data:local   ./services/data
docker build -t devsecops-platform-frontend:local ./frontend

Write-Host '==> Застосування маніфестів...'
kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f ./k8s/

Write-Host '==> Очікування готовності (rollout status)...'
kubectl rollout status deploy/gateway -n $Namespace --timeout=240s
kubectl rollout status deploy/metrics -n $Namespace --timeout=240s
kubectl rollout status deploy/data -n $Namespace --timeout=240s
kubectl rollout status deploy/frontend -n $Namespace --timeout=240s

Write-Host '==> Поди:'
kubectl get pods -n $Namespace -o wide

Write-Host ''
Write-Host 'Відкрити дашборд:' -ForegroundColor Green
Write-Host "  minikube service frontend -n $Namespace"
Write-Host ''
Write-Host 'Перевірка gateway через тунель (опційно):'
Write-Host "  kubectl port-forward -n $Namespace svc/gateway 8080:8080"