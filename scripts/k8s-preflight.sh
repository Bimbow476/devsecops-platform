#!/usr/bin/env bash
# Refuse a destructive emptyDir -> PVC deployment switch. The old pod's
# database is not copied into a newly-created PVC by kubectl apply.
set -euo pipefail

NAMESPACE="${NAMESPACE:-devsecops}"
SERVICES=(data dota)

for svc in "${SERVICES[@]}"; do
  deployment_json="$(kubectl -n "${NAMESPACE}" get deployment "${svc}" -o json 2>/dev/null || true)"
  if [[ -z "${deployment_json}" ]]; then
    # A fresh cluster has no deployment yet; applying the PVC manifest is safe.
    continue
  fi
  if printf '%s' "${deployment_json}" | grep -q '"emptyDir"'; then
    echo "::error::deployment/${svc} still uses emptyDir. Migrate and verify its SQLite database before switching to a PVC." >&2
    echo "See SETUP.md (K8s data migration) and run the migration before this deployment." >&2
    exit 1
  fi
done

echo "Kubernetes data-volume preflight passed."
