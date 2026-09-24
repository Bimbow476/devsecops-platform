"""Тести генератора змодельованого звіту безпеки (dota.security)."""

from dota import security as sec


def test_report_structure():
    report = sec.generate_security_report(seed=7)
    assert report["label"].startswith("змодельовані")
    assert {s["service"] for s in report["services"]} == set(sec.SERVICES)
    for s in report["services"]:
        for key in ("critical", "high", "medium", "low"):
            assert s["trivy"][key] >= 0
        assert s["image_tag"].startswith("sha-")
    assert report["alerts"]
    for alert in report["alerts"]:
        assert alert["severity"] in sec.SEVERITIES
        assert alert["status"] in ("open", "auto_fixed")
        assert alert["advisory"].startswith("CVE-")
    assert len(report["workflows"]) == len(sec.WORKFLOWS)


def test_deterministic_with_same_seed():
    r1 = sec.generate_security_report(seed=42)
    r2 = sec.generate_security_report(seed=42)
    r1.pop("generated_at")
    r2.pop("generated_at")
    assert r1 == r2


def test_different_seed_gives_different_report():
    r1 = sec.generate_security_report(seed=1)
    r2 = sec.generate_security_report(seed=2)
    r1.pop("generated_at")
    r2.pop("generated_at")
    assert r1 != r2


def test_security_score_bounds():
    for seed in range(10):
        report = sec.generate_security_report(seed=seed)
        score = sec.security_score(report)
        assert 0 <= score <= 100


def test_no_seed_produces_varying_reports():
    a = sec.generate_security_report()
    b = sec.generate_security_report()
    a.pop("generated_at")
    b.pop("generated_at")
    assert a != b