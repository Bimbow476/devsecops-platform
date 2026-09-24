"""Змодельований звіт безпеки для демонстрації DevSecOps.

Дані генеруються випадково і є ДЕМОНСТРАЦІЙНИМИ (не результатом реального
сканування). У інтерфейсі звіт позначається як "змодельовані дані".
Формат відтворює типові звіти Trivy (сканування Docker-образів),
GitHub Dependabot (алерти залежностей) та GitHub Actions (запуски пайплайну).

Генератор детермінований при передачі seed -> легко покривати тестами.
"""

import random
from datetime import datetime, timezone

SERVICES = ["gateway", "metrics", "data", "frontend", "dota"]

# Реальні пакети проєкту, щоб звіт виглядав правдоподібно
ECOSYSTEMS = [
    ("npm", ["react", "vite", "typescript", "express", "better-sqlite3", "zod", "http-proxy-middleware"]),
    ("pip", ["streamlit", "pandas", "requests", "msgpack", "setuptools"]),
    ("docker", ["python", "node"]),
    ("github-actions", ["actions/checkout", "docker/build-push-action", "aquasecurity/trivy-action"]),
]

SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
SEVERITY_WEIGHTS = [10, 25, 35, 30]

WORKFLOWS = ["CI", "CD", "CodeQL"]


def _next_version(rng: random.Random, ecosystem: str) -> str:
    if ecosystem == "github-actions":
        return f"v{rng.randint(4, 8)}"
    return f"{rng.randint(1, 22)}.{rng.randint(0, 9)}.{rng.randint(0, 9)}"


def _cve_id(rng: random.Random) -> str:
    year = rng.choice(["2024", "2025", "2026"])
    return f"CVE-{year}-{rng.randint(1000, 49999)}"


def generate_security_report(seed: int | None = None) -> dict:
    """Генерує рандомний звіт безпеки.

    При однаковому seed звіт ідентичний (крім generated_at) — це дозволяє
    тестувати детермінованість і структуру.
    """
    rng = random.Random(seed)

    services = []
    for svc in SERVICES:
        services.append(
            {
                "service": svc,
                "image_tag": f"sha-{rng.getrandbits(128):032x}"[:18],
                "trivy": {
                    "critical": rng.choices([0, 0, 0, 1])[0],
                    "high": rng.randint(0, 3),
                    "medium": rng.randint(0, 6),
                    "low": rng.randint(0, 12),
                },
                "last_scan_minutes_ago": rng.randint(1, 240),
            }
        )

    alerts = []
    for _ in range(rng.randint(4, 8)):
        ecosystem, packages = rng.choice(ECOSYSTEMS)
        package = rng.choice(packages)
        alerts.append(
            {
                "number": rng.randint(1, 60),
                "ecosystem": ecosystem,
                "package": package,
                "severity": rng.choices(SEVERITIES, weights=SEVERITY_WEIGHTS)[0],
                "advisory": _cve_id(rng),
                "summary": f"Вразливість у {package}",
                "fixed_version": _next_version(rng, ecosystem),
                "status": rng.choices(["open", "auto_fixed"], weights=[35, 65])[0],
            }
        )

    workflows = []
    for name in WORKFLOWS:
        workflows.append(
            {
                "name": name,
                "status": rng.choices(["success", "failure"], weights=[90, 10])[0],
                "duration_sec": rng.randint(60, 300),
                "trigger": "push",
            }
        )

    return {
        "label": "змодельовані дані (демонстрація)",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": seed,
        "services": services,
        "alerts": alerts,
        "workflows": workflows,
    }


def security_score(report: dict) -> int:
    """Оцінка безпеки 0-100 на основі змодельованого звіту (демо)."""
    total_critical = sum(s["trivy"]["critical"] for s in report["services"])
    total_high = sum(s["trivy"]["high"] for s in report["services"])
    open_alerts = sum(1 for a in report["alerts"] if a["status"] == "open")
    failed_workflows = sum(1 for w in report["workflows"] if w["status"] == "failure")
    score = (
        100
        - total_critical * 15
        - total_high * 5
        - open_alerts * 2
        - failed_workflows * 10
    )
    return max(0, min(100, score))