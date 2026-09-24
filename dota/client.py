"""Стійкий HTTP-клієнт до мікросервісної платформи DevSecOps.

Dota-застосунок виступає клієнтом платформи: gateway агрегує стан усіх
сервісів (/api/status), проксіює метрики (/api/metrics) та CRUD записів
даних (/api/data/*).

Стійкість клієнт-серверної взаємодії (resilience):
- таймаут на кожен запит;
- ретраї з експоненційним бек-офом (для GET також на HTTP 5xx);
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
        self.max_retries = max_retries
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
        """POST/PUT/DELETE: ретраї лише на збої з'єднання (не на 4xx/5xx),
        щоб не дублювати побічні ефекти на боці сервісу."""
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                resp = self.session.request(
                    method, url, json=payload, timeout=self.timeout
                )
                if resp.status_code >= 400:
                    raise PlatformUnavailable(f"HTTP {resp.status_code}")
                if not resp.content:
                    return {}
                return resp.json()
            except requests.RequestException as exc:
                last_error = exc
                if attempt < self.max_retries - 1:
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
                f"{k}={quote(str(v))}"
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

    def list_records(
        self, search: str = "", status: str = "", limit: int = 100, offset: int = 0
    ) -> dict:
        """Список записів платформи (через gateway -> data-сервіс)."""
        return self.cached_get(
            "/api/data/records",
            {"search": search, "status": status, "limit": limit, "offset": offset},
        )

    def create_record(
        self,
        title: str,
        description: str | None = None,
        status: str = "new",
        priority: int = 3,
    ) -> dict:
        """Створення запису в data-сервісі."""
        return self._mutate(
            "POST",
            f"{self.api_url}/api/data/records",
            {
                "title": title,
                "description": description,
                "status": status,
                "priority": int(priority),
            },
        )

    def delete_record(self, record_id: int) -> bool:
        """Видалення запису; True, якщо запис існував і був видалений."""
        try:
            self._mutate("DELETE", f"{self.api_url}/api/data/records/{int(record_id)}")
            return True
        except PlatformUnavailable as exc:
            if "404" in str(exc):
                return False
            raise