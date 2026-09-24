#!/usr/bin/env bash
# Оновлює образи всіх deployment'ів на образ із зазначеним SHA (використовується CD workflow).
set -euo pipefail

REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"
REPO="$(basename "${GITHUB_REPOSITORY:-devsecops-platform}")"
SHA="${1:?usage: k8s-update-images.sh <commit-sha>}"
NS="devsecops"

for svc in gateway metrics data frontend; do
  img="${REGISTRY}/${OWNER}/${REPO}-${svc}:sha-${SHA}"
  echo "==> deployment/${svc} -> ${img}"
  kubectl -n "${NS}" set image "deployment/${svc}" "${svc}=${img}"
done

kubectl -n "${NS}" rollout status deployment/gateway deployment/metrics deployment/data deployment/frontend --timeout=240s
kubectl -n "${NS}" get pods -o wide