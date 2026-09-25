"""Тести стійкого HTTP-клієнта платформи (dota.client)."""

from urllib.parse import parse_qs, urlparse

import pytest
import requests

from dota import client as pl


class FakeResponse:
    def __init__(self, payload=None, status=200):
        self._payload = payload
        self.status_code = status
        self.content = b"" if status == 204 else b"{}"

    def json(self):
        return self._payload


class FakeSession:
    """HTTP-сесія з керованою поведінкою для тестів resilience."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(("GET", url))
        return self.handler(("GET", url), self)

    def request(self, method, url, json=None, timeout=None):
        self.calls.append((method, url))
        return self.handler((method, url), self)


def make_client(handler, **kwargs):
    config = dict(
        api_url="http://test-platform",
        frontend_url="http://front",
        timeout=1,
        max_retries=3,
        backoff_base=0,
        jitter_max=0,
        cache_ttl=0,
    )
    config.update(kwargs)
    return pl.PlatformClient(session=FakeSession(handler), **config)


def test_get_success_returns_payload():
    def ok(_call, _session):
        return FakeResponse({"hello": "world"})

    client = make_client(ok)
    assert client.cached_get("/api/status") == {"hello": "world"}
    assert len(client.session.calls) == 1


def test_zero_retry_budget_still_makes_one_request():
    calls = {"n": 0}

    def ok(_call, _session):
        calls["n"] += 1
        return FakeResponse({"ok": True})

    client = make_client(ok, max_retries=0)
    assert client.cached_get("/api/status") == {"ok": True}
    assert calls["n"] == 1


def test_cached_get_hits_cache():
    def ok(_call, _session):
        return FakeResponse({"n": 42})

    client = make_client(ok, cache_ttl=60)
    assert client.cached_get("/api/metrics") == {"n": 42}
    assert client.cached_get("/api/metrics") == {"n": 42}
    assert len(client.session.calls) == 1  # другий запит віддано з кешу


def test_retry_then_success():
    attempts = {"n": 0}

    def flaky(_call, _session):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise requests.ConnectionError("boom")
        return FakeResponse({"ok": True})

    client = make_client(flaky)
    assert client.cached_get("/api/status") == {"ok": True}
    assert attempts["n"] == 3  # 2 невдалі спроби + успішний повтор


def test_max_retries_exhausted_raises():
    def always_fail(_call, _session):
        raise requests.ConnectionError("down")

    client = make_client(always_fail)
    with pytest.raises(pl.PlatformUnavailable):
        client.cached_get("/api/status")


def test_no_retry_on_http_404():
    calls = {"n": 0}

    def not_found(_call, _session):
        calls["n"] += 1
        return FakeResponse(status=404)

    client = make_client(not_found)
    with pytest.raises(pl.PlatformUnavailable) as exc_info:
        client.cached_get("/api/status")
    assert "404" in str(exc_info.value)
    assert calls["n"] == 1  # 4xx не ретраїться


def test_degraded_after_consecutive_failures():
    def fail(_call, _session):
        raise requests.ConnectionError("x")

    client = make_client(fail)
    with pytest.raises(pl.PlatformUnavailable):
        client.cached_get("/api/status")
    assert client.degraded is False  # одна невдача < порогу 2

    with pytest.raises(pl.PlatformUnavailable):
        client.cached_get("/api/status")
    assert client.degraded is True  # дві послідовні невдачі -> degraded


def test_stale_cache_served_after_failure():
    state = {"fail": False}

    def handler(_call, _session):
        if state["fail"]:
            raise requests.ConnectionError("down")
        return FakeResponse({"val": 1})

    client = make_client(handler)
    assert client.cached_get("/api/status") == {"val": 1}

    state["fail"] = True
    # stale-while-revalidate: повертаємо останні відомі дані замість помилки
    assert client.cached_get("/api/status") == {"val": 1}
    assert client.stale_served is True


def test_platform_status_normalized():
    def status(_call, _session):
        return FakeResponse(
            [
                {"name": "gateway", "healthy": True, "status": "ok",
                 "version": "0.1.0", "latencyMs": 3.5},
                {"name": "data", "healthy": False, "status": "error",
                 "version": "0.1.0", "latencyMs": 0},
            ]
        )

    client = make_client(status)
    snapshots = client.platform_status()
    assert len(snapshots) == 2
    assert snapshots[0].name == "gateway" and snapshots[0].healthy is True
    assert snapshots[0].latency_ms == 3.5
    assert snapshots[1].healthy is False


def test_project_and_task_crud_urls():
    seen = []

    def handler(call, _session):
        seen.append(call)
        method, url = call
        if method == "POST" and url.endswith("/projects"):
            return FakeResponse({"id": 1, "name": "Платформа"})
        if method == "POST" and url.endswith("/tasks"):
            return FakeResponse({"id": 7, "project_id": 1, "title": "Міграція"})
        if method == "PUT" and "/projects/" in url:
            return FakeResponse({"id": 1, "name": "Оновлено"})
        if method == "PUT" and "/tasks/" in url:
            return FakeResponse({"id": 7, "status": "done"})
        if method == "DELETE":
            return FakeResponse(status=404 if url.endswith("/99") else 204)
        return FakeResponse({})

    client = make_client(handler)
    project = client.create_project("Платформа", "опис", "active", 1, "team", "2026-12-31")
    assert project["id"] == 1
    assert client.update_project(1, {"status": "completed"})["name"] == "Оновлено"

    task = client.create_task(1, "Міграція", status="in_progress")
    assert task["id"] == 7
    assert client.update_task(7, {"status": "done"})["status"] == "done"
    assert client.get_task(7) == {}
    assert client.delete_task(7) is True
    assert client.delete_task(99) is False

    assert any(url.endswith("/api/data/projects") for _, url in seen)
    assert any(url.endswith("/api/data/projects/1/tasks") for _, url in seen)
    assert any(url.endswith("/api/data/tasks/7") for _, url in seen)


def test_post_is_not_retried_after_ambiguous_connection_failure():
    calls = {"n": 0}

    def ambiguous(_call, _session):
        calls["n"] += 1
        raise requests.ConnectionError("response lost after commit")

    client = make_client(ambiguous)
    with pytest.raises(pl.PlatformUnavailable):
        client.create_project("Можливо, вже створено")
    assert calls["n"] == 1


def test_idempotent_put_retries_ambiguous_json_response():
    calls = {"n": 0}

    class InvalidJsonResponse(FakeResponse):
        def json(self):
            raise ValueError("truncated response")

    def handler(_call, _session):
        calls["n"] += 1
        if calls["n"] == 1:
            return InvalidJsonResponse({})
        return FakeResponse({"id": 1, "status": "completed"})

    client = make_client(handler)
    assert client.update_project(1, {"status": "completed"})["status"] == "completed"
    assert calls["n"] == 2


def test_list_all_methods_follow_pagination():
    def paginated(call, _session):
        _method, url = call
        query = parse_qs(urlparse(url).query)
        offset = int(query.get("offset", ["0"])[0])
        limit = int(query.get("limit", ["50"])[0])
        if "/tasks" in url:
            all_items = [
                {"id": 1, "title": "one"},
                {"id": 2, "title": "two"},
                {"id": 3, "title": "three"},
            ]
        else:
            all_items = [
                {"id": 10, "name": "ten"},
                {"id": 20, "name": "twenty"},
                {"id": 30, "name": "thirty"},
            ]
        return FakeResponse(
            {
                "items": all_items[offset : offset + limit],
                "total": len(all_items),
                "limit": limit,
                "offset": offset,
            }
        )

    client = make_client(paginated)
    projects = client.list_all_projects(page_size=2)
    tasks = client.list_all_tasks(9, page_size=2)

    assert [project["id"] for project in projects["items"]] == [10, 20, 30]
    assert projects["total"] == 3
    assert [task["id"] for task in tasks] == [1, 2, 3]


def test_pagination_does_not_silently_truncate_on_an_empty_intermediate_page():
    def paginated(call, _session):
        _method, url = call
        query = parse_qs(urlparse(url).query)
        offset = int(query.get("offset", ["0"])[0])
        if offset == 0:
            return FakeResponse(
                {"items": [{"id": 1}], "total": 3, "limit": 1, "offset": 0}
            )
        return FakeResponse({"items": [], "total": 3, "limit": 1, "offset": offset})

    client = make_client(paginated)
    with pytest.raises(pl.PlatformUnavailable, match="empty page"):
        client.list_all_projects(page_size=1)


def test_frontend_reachable():
    def ok(_call, _session):
        return FakeResponse({"x": 1}, status=200)

    assert make_client(ok).frontend_reachable() is True

    def down(_call, _session):
        raise requests.ConnectionError("x")

    assert make_client(down).frontend_reachable() is False