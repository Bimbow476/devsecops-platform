<#
Deploy the platform to Minikube:
  - builds Docker images with tag :local
  - applies Kubernetes manifests (namespace devsecops)
  - prints how to open the frontend
NOTE: keep this file pure ASCII (no Cyrillic) for PowerShell 5.1 compatibility.
#>
param(
  [string]$Namespace = 'devsecops'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command 'minikube' -ErrorAction SilentlyContinue)) { throw 'Minikube is not installed' }
if (-not (Get-Command 'docker'  -ErrorAction SilentlyContinue)) { throw 'Docker is not installed' }

Write-Host '==> Attaching to Minikube docker daemon (docker-env)...'
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
if ($LASTEXITCODE -ne 0) {
  Write-Host '==> Minikube is not running. Starting...' -ForegroundColor Yellow
  & minikube start --driver=docker
  & minikube -p minikube docker-env --shell powershell | Invoke-Expression
}

Write-Host '==> Building images (:local)...'
docker build -t devsecops-platform-gateway:local  ./services/gateway
docker build -t devsecops-platform-metrics:local ./services/metrics
docker build -t devsecops-platform-data:local   ./services/data
docker build -t devsecops-platform-frontend:local ./frontend

Write-Host '==> Applying manifests...'
kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f ./k8s/

Write-Host '==> Waiting for rollout status...'
kubectl rollout status deploy/gateway -n $Namespace --timeout=240s
kubectl rollout status deploy/metrics -n $Namespace --timeout=240s
kubectl rollout status deploy/data -n $Namespace --timeout=240s
kubectl rollout status deploy/frontend -n $Namespace --timeout=240s

Write-Host '==> Pods:'
kubectl get pods -n $Namespace -o wide

Write-Host ''
Write-Host 'Open the dashboard:' -ForegroundColor Green
Write-Host "  minikube service frontend -n $Namespace"
Write-Host ''
Write-Host 'Check gateway via tunnel (optional):'
Write-Host "  kubectl port-forward -n $Namespace svc/gateway 8080:8080"