"""Стійкий HTTP-клієнт до мікросервісної платформи DevSecOps.

Dota-застосунок виступає клієнтом платформи: gateway агрегує стан усіх
сервісів (/api/status), проксіює метрики (/api/metrics) та керує
проєктами й задачами (/api/data/projects/*).

Стійкість клієнт-серверної взаємодії (resilience):
- таймаут на кожен запит;
- ретраї з експоненційним бек-офом (для GET також на HTTP 5xx);
  POST-мутації не повторюються, щоб не створювати дублікати;
- лічильник відмов -> режим "degraded";
- кеш last-known-good: якщо сервіс недоступний, повертаються
  останні успішно отримані дані (stale-while-revalidate).

Базовий URL налаштовується через DOTA_API_URL (у кластері — http://gateway:8080,
локально — через port-forward). Параметри ретраїв/таймауту/кешу — через
DOTA_API_TIMEOUT, DOTA_API_RETRIES, DOTA_API_CACHE_TTL.
"""

import os
import time
from dataclasses import dataclass, field
from urllib.parse import quote

import requests

API_URL = os.environ.get("DOTA_API_URL", "http://gateway:8080")
FRONTEND_URL = os.environ.get("DOTA_FRONTEND_URL", "http://frontend")
TIMEOUT = float(os.environ.get("DOTA_API_TIMEOUT", "3"))
MAX_RETRIES = int(os.environ.get("DOTA_API_RETRIES", "3"))
BACKOFF_BASE = 0.25  # секунди
JITTER_MAX = 0.1  # секунди (розкид, щоб уникнути "thundering herd")
CACHE_TTL = float(os.environ.get("DOTA_API_CACHE_TTL", "15"))


class PlatformUnavailable(Exception):
    """Сервіси платформи недоступні після вичерпання всіх ретраїв."""


@dataclass
class ServiceSnapshot:
    """Нормалізований стан одного мікросервісу з /api/status."""

    name: str
    healthy: bool
    status: str
    version: str
    latency_ms: float
    details: dict = field(default_factory=dict)


class PlatformClient:
    """Клієнт платформи з ретраями, режимом деградації та stale-кешем."""

    def __init__(
        self,
        api_url: str = API_URL,
        frontend_url: str = FRONTEND_URL,
        timeout: float = TIMEOUT,
        max_retries: int = MAX_RETRIES,
        backoff_base: float = BACKOFF_BASE,
        jitter_max: float = JITTER_MAX,
        cache_ttl: float = CACHE_TTL,
        session: requests.Session | None = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.frontend_url = frontend_url.rstrip("/")
        self.timeout = timeout
        # Значення 0/від'ємне все одно означає одну спробу: нульовий retry
        # budget не повинен перетворювати навіть перший GET/PUT/DELETE на
        # гарантований виняток без запиту.
        self.max_retries = max(1, int(max_retries))
        self.backoff_base = backoff_base
        self.jitter_max = jitter_max
        self.cache_ttl = cache_ttl
        self.session = session or requests.Session()
        self._cache: dict[str, tuple[float, dict]] = {}
        self._failures: dict[str, int] = {}
        self.degraded = False
        self.stale_served = False

    # ------------------------------------------------------------------
    # Внутрішня логіка: ретраї, кеш, стан деградації
    # ------------------------------------------------------------------
    def _sleep(self, attempt: int) -> None:
        delay = (
            self.backoff_base * (2 ** attempt)
            + (self.jitter_max * (attempt + 1))
        )
        time.sleep(max(0.0, delay))

    def _get(self, url: str) -> dict:
        """GET з ретраями на збої з'єднання та HTTP 5xx (без ретраїв на 4xx)."""
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                resp = self.session.get(url, timeout=self.timeout)
                if resp.status_code >= 500:
                    raise requests.ConnectionError(f"HTTP {resp.status_code}")
                if resp.status_code >= 400:
                    raise PlatformUnavailable(f"HTTP {resp.status_code}")
                return resp.json()
            except PlatformUnavailable:
                raise
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt < self.max_retries - 1:
                    self._sleep(attempt)
        raise PlatformUnavailable(str(last_error))

    def _mutate(self, method: str, url: str, payload: dict | None = None) -> dict:
        """Mutate with safe retry semantics.

        PUT/DELETE are idempotent and may be retried after a connection error.
        POST is deliberately attempted once: the server may have committed the
        write before the response was lost, and an automatic retry could create
        a duplicate project/task. HTTP 4xx/5xx responses are never retried.
        """
        last_error: Exception | None = None
        attempts = 1 if method.upper() == "POST" else self.max_retries
        for attempt in range(attempts):
            try:
                resp = self.session.request(
                    method, url, json=payload, timeout=self.timeout
                )
                if resp.status_code >= 400:
                    raise PlatformUnavailable(f"HTTP {resp.status_code}")
                payload = {} if not resp.content else resp.json()
                # CRUD змінює дані, тому last-known-good кеш більше не дійсний.
                self.invalidate()
                return payload
            except (requests.RequestException, ValueError) as exc:
                # requests.json() може втратити/отримати не-JSON відповідь
                # після успішного TCP-обміну. Для PUT/DELETE це безпечно
                # повторити, адже операції ідемпотентні; POST залишається
                # одноразовим через ризик дубліката.
                last_error = exc
                if attempt < attempts - 1:
                    self._sleep(attempt)
        raise PlatformUnavailable(str(last_error))

    def _set_degraded(self, key: str, ok: bool) -> None:
        self._failures[key] = 0 if ok else self._failures.get(key, 0) + 1
        self.degraded = any(v >= 2 for v in self._failures.values())

    def invalidate(self) -> None:
        """Скидає кеш (кнопка «Оновити» в інтерфейсі)."""
        self._cache.clear()
        self._failures.clear()
        self.degraded = False
        self.stale_served = False

    def cached_get(self, path: str, params: dict | None = None) -> dict:
        """GET з кешем last-known-good і TTL."""
        key = self._build_url(path, params)
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and now - cached[0] < self.cache_ttl:
            self._set_degraded(key, True)
            return cached[1]

        try:
            payload = self._get(key)
            self._cache[key] = (now, payload)
            self._set_degraded(key, True)
            self.stale_served = False
            return payload
        except PlatformUnavailable:
            self._set_degraded(key, False)
            if key in self._cache:
                # stale-while-revalidate: повертаємо останні відомі дані
                self.stale_served = True
                return self._cache[key][1]
            raise

    def _build_url(self, path: str, params: dict | None = None) -> str:
        url = f"{self.api_url}{path}"
        if params:
            qs = "&".join(
                f"{k}={quote(str(v), safe='')}"
                for k, v in params.items()
                if v is not None and v != ""
            )
            if qs:
                url = f"{url}?{qs}"
        return url

    # ------------------------------------------------------------------
    # Публічний API платформи
    # ------------------------------------------------------------------
    def platform_status(self) -> list[ServiceSnapshot]:
        """Агрегований стан gateway/metrics/data з /api/status."""
        data = self.cached_get("/api/status")
        snapshots: list[ServiceSnapshot] = []
        for s in data:
            healthy = bool(
                s.get("healthy", s.get("status") == "ok")
            )
            snapshots.append(
                ServiceSnapshot(
                    name=s.get("name", "?"),
                    healthy=healthy,
                    status=s.get("status", "unknown"),
                    version=s.get("version", "?"),
                    latency_ms=float(s.get("latencyMs", 0) or 0),
                    details=s,
                )
            )
        return snapshots

    def system_metrics(self) -> dict:
        """Системні метрики хоста (CPU/пам'ять/навантаження)."""
        return self.cached_get("/api/metrics")

    def frontend_reachable(self) -> bool:
        """Перевірка фронтенд-дашборда (React)."""
        try:
            resp = self.session.get(self.frontend_url, timeout=self.timeout)
            return resp.status_code == 200
        except requests.RequestException:
            return False

    def list_projects(
        self, search: str = "", status: str = "", limit: int = 100, offset: int = 0
    ) -> dict:
        """Список проєктів із сервісу даних через gateway."""
        return self.cached_get(
            "/api/data/projects",
            {"search": search, "status": status, "limit": limit, "offset": offset},
        )

    def list_all_projects(
        self, search: str = "", status: str = "", page_size: int = 100
    ) -> dict:
        """Завантажити всі сторінки проєктів для Streamlit-огляду.

        API залишає пагінацію для клієнтів, але невеликий UI не повинен
        приховувати старі legacy-записи лише через жорсткий ліміт 100.
        """
        page_size = max(1, min(int(page_size), 100))
        first = self.list_projects(search=search, status=status, limit=page_size)
        if not isinstance(first, dict):
            items = list(first)
            return {"items": items, "total": len(items), "limit": page_size, "offset": 0}
        items = list(first.get("items", []))
        total = int(first.get("total", len(items)) or 0)
        offset = len(items)
        while offset < total:
            page = self.list_projects(
                search=search, status=status, limit=page_size, offset=offset
            )
            page_items = list(page.get("items", [])) if isinstance(page, dict) else []
            if not page_items:
                raise PlatformUnavailable(
                    "pagination returned an empty page before the reported total"
                )
            items.extend(page_items)
            offset += len(page_items)
        return {**first, "items": items, "total": total}

    def create_project(
        self,
        name: str,
        description: str | None = None,
        status: str = "planned",
        priority: int = 3,
        owner: str | None = None,
        due_date: str | None = None,
    ) -> dict:
        """Створює проєкт."""
        return self._mutate(
            "POST",
            f"{self.api_url}/api/data/projects",
            {
                "name": name,
                "description": description,
                "status": status,
                "priority": int(priority),
                "owner": owner,
                "due_date": due_date,
            },
        )

    def update_project(self, project_id: int, changes: dict) -> dict:
        """Оновлює вибрані поля проєкту."""
        return self._mutate(
            "PUT",
            f"{self.api_url}/api/data/projects/{int(project_id)}",
            changes,
        )

    def delete_project(self, project_id: int) -> bool:
        """Видаляє проєкт разом із задачами; False, якщо проєкту немає."""
        return self._delete_resource(f"/api/data/projects/{int(project_id)}")

    def list_tasks(self, project_id: int) -> list[dict]:
        """Список задач конкретного проєкту."""
        result = self.cached_get(f"/api/data/projects/{int(project_id)}/tasks")
        if isinstance(result, dict):
            return list(result.get("items", []))
        return list(result)

    def get_task(self, task_id: int) -> dict:
        """Отримати одну задачу через gateway."""
        return self.cached_get(f"/api/data/tasks/{int(task_id)}")

    def list_all_tasks(self, project_id: int, page_size: int = 200) -> list[dict]:
        """Завантажити всі задачі проєкту, зберігаючи пагінацію API."""
        page_size = max(1, min(int(page_size), 200))
        first = self.cached_get(
            f"/api/data/projects/{int(project_id)}/tasks",
            {"limit": page_size, "offset": 0},
        )
        if not isinstance(first, dict):
            return list(first)
        items = list(first.get("items", []))
        total = int(first.get("total", len(items)) or 0)
        offset = len(items)
        while offset < total:
            page = self.cached_get(
                f"/api/data/projects/{int(project_id)}/tasks",
                {"limit": page_size, "offset": offset},
            )
            page_items = list(page.get("items", [])) if isinstance(page, dict) else []
            if not page_items:
                raise PlatformUnavailable(
                    "pagination returned an empty page before the reported total"
                )
            items.extend(page_items)
            offset += len(page_items)
        return items

    def create_task(
        self,
        project_id: int,
        title: str,
        description: str | None = None,
        status: str = "todo",
        priority: int = 3,
        assignee: str | None = None,
        due_date: str | None = None,
    ) -> dict:
        """Додає задачу до проєкту."""
        return self._mutate(
            "POST",
            f"{self.api_url}/api/data/projects/{int(project_id)}/tasks",
            {
                "title": title,
                "description": description,
                "status": status,
                "priority": int(priority),
                "assignee": assignee,
                "due_date": due_date,
            },
        )

    def update_task(self, task_id: int, changes: dict) -> dict:
        """Оновлює вибрані поля задачі."""
        return self._mutate(
            "PUT",
            f"{self.api_url}/api/data/tasks/{int(task_id)}",
            changes,
        )

    def delete_task(self, task_id: int) -> bool:
        """Видаляє задачу; False, якщо задачі немає."""
        return self._delete_resource(f"/api/data/tasks/{int(task_id)}")

    def _delete_resource(self, path: str) -> bool:
        try:
            self._mutate("DELETE", f"{self.api_url}{path}")
            return True
        except PlatformUnavailable as exc:
            if "404" in str(exc):
                return False
            raise
