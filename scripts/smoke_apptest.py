"""Локальний смоук рендерингу app.py через Streamlit AppTest (не входить у CI).

app.py — багатосторінковий застосунок (st.navigation / st.Page):
  1. «Аналітика Dota 2» — головна сторінка (за логіном);
  2. «Платформа DevSecOps» — публічні таби (Моніторинг / Дані / Безпека).

AppTest не вміє перемикати функційні сторінки st.navigation публічним API
(switch_page працює лише з файловими), тому робимо два прогони:
  - Run 1: дефолт — аналітика (без входу: інфо-запрошення, табів немає);
  - Run 2: монкіпач st.navigation змушує дефолт = «Платформа DevSecOps»,
    тоді очікуємо 3 публічні таби.
Gateway у тестовому середовищі недоступний -> очікуємо деградацію, а не падіння.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

import streamlit as st
from streamlit.testing.v1 import AppTest

from dota import client as pclient
from dota import security as sec


def _force_platform_default(pages, **kwargs):
    """Обгортка st.navigation: робить дефолтною сторінку «Платформа DevSecOps»."""
    plate = list(pages) if isinstance(pages, (list, tuple)) else [
        p for sec_pages in pages.values() for p in sec_pages
    ]
    for p in plate:
        p._default = p.title == "Платформа DevSecOps"
    return st._orig_navigation(pages, **kwargs)


EXPECTED_DEGRADATION_ERRORS = {
    "Шлюз gateway не відповідає. Застосунок має працювати в кластері "
    "(http://gateway:8080) або DOTA_API_URL має вказувати на порт-forward.",
    "Сервіс даних недоступний.",
}


def main() -> int:
    # Конфігуруємо клієнт до миттєвої відмови (недоступний локальний порт),
    # щоб смоук не залежав від DNS кластерних імен і працював швидко.
    os.environ["DOTA_API_URL"] = "http://127.0.0.1:9"
    os.environ["DOTA_FRONTEND_URL"] = "http://127.0.0.1:9"
    os.environ["DOTA_API_TIMEOUT"] = "1"
    os.environ["DOTA_API_RETRIES"] = "1"
    os.environ["DOTA_API_CACHE_TTL"] = "0"

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app_path = os.path.join(root, "app.py")

    # ---------------- Run 1: головна сторінка «Аналітика Dota 2» (без входу) ----------------
    at = AppTest.from_file(app_path, default_timeout=60)
    at.run()
    assert not at.exception, f"Script raised: {at.exception}"
    print(f"run1 title: {at.title[0].value if at.title else None}")
    print(f"run1 tabs: {[t.label for t in at.tabs]}")
    assert len(at.tabs) == 0, (
        f"Expected no tabs on analytics page (logged out), got {len(at.tabs)}"
    )
    info_msgs = [i.value for i in at.info]
    assert any("Аналітика Dota 2 доступна після входу" in m for m in info_msgs), (
        f"Expected login invitation on analytics page, got info: {info_msgs}"
    )
    assert not at.exception, f"Script raised: {at.exception}"

    # ---------------- Run 2: сторінка «Платформа DevSecOps» (monkeypatch) ----------------
    st._orig_navigation = st.navigation
    st.navigation = _force_platform_default
    try:
        at2 = AppTest.from_file(app_path, default_timeout=60)
        at2.run()
    finally:
        st.navigation = st._orig_navigation

    assert not at2.exception, f"Script raised: {at2.exception}"
    print(f"run2 title: {at2.title[0].value if at2.title else None}")
    print(f"run2 tabs: {[t.label for t in at2.tabs]}")
    assert len(at2.tabs) == 3, f"Expected 3 public tabs, got {len(at2.tabs)}"

    # st.error елементи — це очікувані повідомлення деградації (gateway недоступний
    # поза кластером), а не невідловлені виключення скрипта.
    got_errors = {e.value for e in at2.error}
    for msg in got_errors:
        assert msg in EXPECTED_DEGRADATION_ERRORS, f"Unexpected error element: {msg!r}"
    assert not at2.exception, f"Script raised: {at2.exception}"

    # Безпека: звіт генерується та score у межах
    report = sec.generate_security_report(seed=1)
    score = sec.security_score(report)
    assert 0 <= score <= 100

    # Клієнт: конструктор + деградація без падіння
    cl = pclient.PlatformClient(timeout=1, max_retries=1, backoff_base=0, jitter_max=0)
    try:
        cl.platform_status()
    except pclient.PlatformUnavailable:
        pass  # очікувано поза кластером

    print("AppTest smoke: OK — обидві сторінки рендеряться без виключень")
    return 0


if __name__ == "__main__":
    sys.exit(main())