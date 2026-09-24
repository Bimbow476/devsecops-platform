"""Локальний смоук рендерингу app.py через Streamlit AppTest (не входить у CI).

Виконує скрипт app.py так, як це робить Streamlit, і перевіряє, що
публічні таби (Моніторинг / Дані / Безпека) відрендерились без виключень.
Gateway у тестовому середовищі недоступний -> очікуємо деградацію, а не падіння.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

from streamlit.testing.v1 import AppTest

from dota import client as pclient
from dota import security as sec


def main() -> int:
    # Конфігуруємо клієнт до миттєвої відмови (недоступний локальний порт),
    # щоб смоук не залежав від DNS кластерних імен і працював швидко.
    os.environ["DOTA_API_URL"] = "http://127.0.0.1:9"
    os.environ["DOTA_FRONTEND_URL"] = "http://127.0.0.1:9"
    os.environ["DOTA_API_TIMEOUT"] = "1"
    os.environ["DOTA_API_RETRIES"] = "1"
    os.environ["DOTA_API_CACHE_TTL"] = "0"

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    at = AppTest.from_file(os.path.join(root, "app.py"), default_timeout=60)
    at.run()

    # Явних виключень у скрипті не має бути
    assert not at.exception, f"Script raised: {at.exception}"
    print(f"title: {at.title[0].value if at.title else None}")
    print(f"tabs on root: {[t.label for t in at.tabs]}")
    # Публічні таби = 3
    assert len(at.tabs) == 3, f"Expected 3 public tabs, got {len(at.tabs)}"

    # st.error елементи — це очікувані повідомлення деградації (gateway недоступний
    # поза кластером), а не невідловлені виключення скрипта.
    expected_errors = {
        "Шлюз gateway не відповідає. Застосунок має працювати в кластері "
        "(http://gateway:8080) або DOTA_API_URL має вказувати на порт-forward.",
        "Сервіс даних недоступний.",
    }
    got_errors = {e.value for e in at.error}
    for msg in got_errors:
        assert msg in expected_errors, f"Unexpected error element: {msg!r}"
    assert not at.exception, f"Script raised: {at.exception}"

    # Безпека: звіт генерується та score у межах
    report = sec.generate_security_report(seed=1)
    score = sec.security_score(report)
    assert 0 <= score <= 100

    # Клієнт: конструктор + деградація без падіння
    cl = pclient.PlatformClient(timeout=1, max_retries=1, backoff_base=0, jitter_max=0)
    try:
        cl.platform_status()
        ok = True
    except pclient.PlatformUnavailable:
        ok = True  # очікувано поза кластером
    assert ok

    print("AppTest smoke: OK — app.py рендериться без виключень")
    return 0


if __name__ == "__main__":
    sys.exit(main())