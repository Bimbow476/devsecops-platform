<#
Deploy the platform to Minikube:
  - builds Docker images locally (Docker Desktop) with tag :local
  - loads the images into the Minikube cluster (minikube image load)
  - applies Kubernetes manifests (namespace devsecops)
  - waits for rollout and prints how to open the frontend
NOTE: keep this file pure ASCII (no Cyrillic) for PowerShell 5.1 compatibility.
NOTE: minikube 1.39 docker driver runs containerd inside kicbase, so
      `minikube docker-env` is NOT usable; use `minikube image load` instead.
#>
param(
  [string]$Namespace = 'devsecops'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command 'minikube' -ErrorAction SilentlyContinue)) { throw 'Minikube is not installed' }
if (-not (Get-Command 'docker'  -ErrorAction SilentlyContinue)) { throw 'Docker is not installed' }
if (-not (Get-Command 'kubectl' -ErrorAction SilentlyContinue)) { throw 'kubectl is not installed' }

Write-Host '==> Checking Minikube is running...'
& minikube status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '==> Minikube is not running. Starting...' -ForegroundColor Yellow
  & minikube start --driver=docker --container-runtime=containerd
}

Write-Host '==> Refusing unsafe emptyDir-to-PVC switch...'
foreach ($service in @('data', 'dota')) {
  $deploymentJson = & kubectl -n $Namespace get deployment $service -o json 2>$null
  if ($LASTEXITCODE -eq 0 -and (($deploymentJson -join "`n") -match '"emptyDir"')) {
    throw "deployment/$service still uses emptyDir; migrate and verify its SQLite database before applying the PVC manifests. See SETUP.md."
  }
}

Write-Host '==> Building images locally (:local)...'
docker build -t devsecops-platform-gateway:local  ./services/gateway
if ($LASTEXITCODE -ne 0) { throw 'gateway build failed' }
docker build -t devsecops-platform-metrics:local ./services/metrics
if ($LASTEXITCODE -ne 0) { throw 'metrics build failed' }
docker build -t devsecops-platform-data:local   ./services/data
if ($LASTEXITCODE -ne 0) { throw 'data build failed' }
docker build -t devsecops-platform-frontend:local ./frontend
if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
# dota - main service: build context is repo root (app.py + dota/)
docker build -t devsecops-platform-dota:local -f ./dota/Dockerfile .
if ($LASTEXITCODE -ne 0) { throw 'dota build failed' }

Write-Host '==> Loading images into Minikube...'
minikube image load devsecops-platform-gateway:local
minikube image load devsecops-platform-metrics:local
minikube image load devsecops-platform-data:local
minikube image load devsecops-platform-frontend:local
minikube image load devsecops-platform-dota:local

Write-Host '==> Applying manifests...'
kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f ./k8s/

Write-Host '==> Waiting for rollout status...'
kubectl rollout status deploy/gateway -n $Namespace --timeout=240s
kubectl rollout status deploy/metrics -n $Namespace --timeout=240s
kubectl rollout status deploy/data -n $Namespace --timeout=240s
kubectl rollout status deploy/frontend -n $Namespace --timeout=240s
kubectl rollout status deploy/dota -n $Namespace --timeout=240s

Write-Host '==> Pods:'
kubectl get pods -n $Namespace -o wide

Write-Host ''
Write-Host 'Open the dashboard:' -ForegroundColor Green
Write-Host "  minikube service frontend -n $Namespace"
Write-Host 'Open Dota 2 Analytics (main service):'
Write-Host "  kubectl port-forward -n $Namespace svc/dota 8501:8501"
Write-Host ''
Write-Host 'Check gateway via tunnel (optional):'
Write-Host "  kubectl port-forward -n $Namespace svc/gateway 8080:8080"