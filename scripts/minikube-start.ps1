<#
Start/check the local Minikube cluster.
Requirements: Docker Desktop (WSL2), Minikube, kubectl - see SETUP.md.
NOTE: keep this file pure ASCII (no Cyrillic) for PowerShell 5.1 compatibility.
#>
$ErrorActionPreference = 'Stop'

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command 'minikube')) { throw 'Minikube is not installed. See SETUP.md' }
if (-not (Test-Command 'docker'))  { throw 'Docker is not installed. See SETUP.md' }
if (-not (Test-Command 'kubectl')) { throw 'kubectl is not installed. See SETUP.md' }

Write-Host '==> Checking Minikube status...'
& minikube status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '==> Starting Minikube (driver=docker)...'
  & minikube start --driver=docker
} else {
  Write-Host '    Minikube is already running.'
}

Write-Host '==> Enabling ingress addon...'
& minikube addons enable ingress

Write-Host '==> Current context:'
kubectl config current-context
kubectl get nodes -o wide

Write-Host ''
Write-Host 'Cluster ready. Next: .\scripts\deploy.ps1'