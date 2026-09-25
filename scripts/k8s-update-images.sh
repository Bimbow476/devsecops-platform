#!/usr/bin/env bash
# Оновлює образи всіх deployment'ів на образ із зазначеним SHA (використовується CD workflow).
# Якщо rollout не вдався, скрипт повертає попередні образи, щоб не залишити
# напіврозгорнутий набір сервісів.
set -euo pipefail

REGISTRY="${REGISTRY:-ghcr.io}"
# GHCR вимагає нижній регістр у назві репозиторію
OWNER="$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}" | tr '[:upper:]' '[:lower:]')"
REPO="$(basename "${GITHUB_REPOSITORY:-devsecops-platform}" | tr '[:upper:]' '[:lower:]')"
SHA="${1:?usage: k8s-update-images.sh <commit-sha> [rollback-images-file]}"
ROLLBACK_IMAGES_FILE="${2:-}"
IMAGE_DIGEST_FILE="${IMAGE_DIGEST_FILE:-}"
NS="${NAMESPACE:-devsecops}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-240s}"
# CD створює секрет для приватного GHCR і передає його ім'я сюди. Локальний
# запуск без секрету залишається сумісним з Minikube та локальними образами.
IMAGE_PULL_SECRET="${IMAGE_PULL_SECRET:-}"
SERVICES=(gateway metrics data frontend dota)

declare -a TARGET_DIGESTS=()
if [[ -n "${IMAGE_DIGEST_FILE}" ]]; then
  if [[ ! -f "${IMAGE_DIGEST_FILE}" ]]; then
    echo "error: IMAGE_DIGEST_FILE does not exist: ${IMAGE_DIGEST_FILE}" >&2
    exit 2
  fi
  mapfile -t DIGEST_LINES < "${IMAGE_DIGEST_FILE}"
  if [[ "${#DIGEST_LINES[@]}" -ne "${#SERVICES[@]}" ]]; then
    echo "error: IMAGE_DIGEST_FILE must contain one digest per service" >&2
    exit 2
  fi
  for digest_line in "${DIGEST_LINES[@]}"; do
    digest_line="${digest_line//$'\r'/}"
    digest_line="${digest_line,,}"
    if [[ ! "${digest_line}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "error: invalid image digest in IMAGE_DIGEST_FILE: ${digest_line}" >&2
      exit 2
    fi
    TARGET_DIGESTS+=("${digest_line}")
  done
fi

if [[ ! "${SHA}" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  echo "error: commit SHA must be 7-64 hexadecimal characters" >&2
  exit 2
fi

if [[ -n "${IMAGE_PULL_SECRET}" && ! "${IMAGE_PULL_SECRET}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "error: IMAGE_PULL_SECRET must be a valid Kubernetes secret name" >&2
  exit 2
fi

print_diagnostics() {
  local svc="$1"
  echo "::group::Rollout diagnostics for deployment/${svc}"
  kubectl -n "${NS}" get deployment "${svc}" -o wide || true
  kubectl -n "${NS}" get replicasets -l "app=${svc}" -o wide || true
  kubectl -n "${NS}" get pods -l "app=${svc}" -o wide || true
  kubectl -n "${NS}" get events --sort-by=.lastTimestamp | tail -n 50 || true
  kubectl -n "${NS}" describe deployment "${svc}" || true
  kubectl -n "${NS}" logs "deployment/${svc}" --all-containers=true --tail=100 || true
  echo "::endgroup::"
}

# Зберігаємо образи до будь-яких змін. Якщо capture не вдалася, жодна зміна не
# виконується: без rollback-точки продовжувати rollout небезпечно. CD може
# передати файл, знятий до kubectl apply, щоб rollback повертав попередні GHCR-образи,
# а не тимчасові :local-образи з маніфестів.
declare -a ORIGINAL_IMAGES=()
if [[ -n "${ROLLBACK_IMAGES_FILE}" && -f "${ROLLBACK_IMAGES_FILE}" ]]; then
  mapfile -t CANDIDATE_IMAGES < "${ROLLBACK_IMAGES_FILE}"
  if [[ "${#CANDIDATE_IMAGES[@]}" -eq "${#SERVICES[@]}" ]]; then
    valid_candidates=true
    for candidate_image in "${CANDIDATE_IMAGES[@]}"; do
      candidate_image="${candidate_image//$'\r'/}"
      if [[ -z "${candidate_image}" ]]; then
        valid_candidates=false
        break
      fi
    done
    if [[ "${valid_candidates}" == true ]]; then
      ORIGINAL_IMAGES=("${CANDIDATE_IMAGES[@]}")
    fi
  fi
fi

if [[ "${#ORIGINAL_IMAGES[@]}" -ne "${#SERVICES[@]}" ]]; then
  ORIGINAL_IMAGES=()
  for svc in "${SERVICES[@]}"; do
    original_image="$(
      kubectl -n "${NS}" get deployment "${svc}" \
        -o jsonpath="{.spec.template.spec.containers[?(@.name==\"${svc}\")].image}" \
        2>/dev/null || true
    )"
    if [[ -z "${original_image}" ]]; then
      echo "::error::Cannot read the current image for deployment/${svc}; aborting before changes" >&2
      print_diagnostics "${svc}"
      exit 1
    fi
    ORIGINAL_IMAGES+=("${original_image}")
  done
fi

rollback() {
  local trigger="${1:-unknown}"
  local index svc original_image
  echo "::error::Rolling back deployment images (triggered by ${trigger})"

  for index in "${!SERVICES[@]}"; do
    svc="${SERVICES[$index]}"
    original_image="${ORIGINAL_IMAGES[$index]}"
    echo "==> rollback deployment/${svc} -> ${original_image}"
    if ! kubectl -n "${NS}" set image "deployment/${svc}" "${svc}=${original_image}"; then
      echo "::error::Failed to restore deployment/${svc} image" >&2
    fi
  done

  for svc in "${SERVICES[@]}"; do
    if ! kubectl -n "${NS}" rollout status "deployment/${svc}" --timeout="${ROLLOUT_TIMEOUT}"; then
      echo "::error::Rollback rollout failed for deployment/${svc}" >&2
    fi
  done

  for svc in "${SERVICES[@]}"; do
    print_diagnostics "${svc}"
  done
  return 0
}

for index in "${!SERVICES[@]}"; do
  svc="${SERVICES[$index]}"
  image_base="${REGISTRY}/${OWNER}/${REPO}-${svc}"
  if [[ "${#TARGET_DIGESTS[@]}" -gt 0 ]]; then
    img="${image_base}@${TARGET_DIGESTS[$index]}"
  else
    img="${image_base}:sha-${SHA}"
  fi
  echo "==> deployment/${svc} -> ${img}"
  if ! kubectl -n "${NS}" set image "deployment/${svc}" "${svc}=${img}"; then
    echo "::error::Failed to update image for deployment/${svc}"
    print_diagnostics "${svc}"
    rollback "${svc}"
    exit 1
  fi
done

# Додаємо pull-secret після set image, щоб не створювати зайвий rollout перед
# встановленням SHA-образів. Стратегічний merge зберігає інші секрети, якщо їх
# додали вручну.
if [[ -n "${IMAGE_PULL_SECRET}" ]]; then
  pull_secret_patch="{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"${IMAGE_PULL_SECRET}\"}]}}}}"
  for svc in "${SERVICES[@]}"; do
    if ! kubectl -n "${NS}" patch deployment "${svc}" --type=strategic -p "${pull_secret_patch}"; then
      echo "::error::Failed to configure image pull secret on deployment/${svc}"
      print_diagnostics "${svc}"
      rollback "${svc}"
      exit 1
    fi
  done
fi

for svc in "${SERVICES[@]}"; do
  echo "==> Waiting for deployment/${svc} rollout"
  if ! kubectl -n "${NS}" rollout status "deployment/${svc}" --timeout="${ROLLOUT_TIMEOUT}"; then
    echo "::error::Rollout failed for deployment/${svc}"
    print_diagnostics "${svc}"
    rollback "${svc}"
    exit 1
  fi
done

kubectl -n "${NS}" get deployments -o wide
kubectl -n "${NS}" get pods -o wide
