import types
import unittest.mock as mock

import pytest
import immich


@pytest.fixture(autouse=True)
def reset_owner_id():
    """Reset the module-level cache between tests."""
    immich._owner_id = None
    yield
    immich._owner_id = None


# ---------------------------------------------------------------------------
# get_owner_id
# ---------------------------------------------------------------------------

def _ok_response(user_id: str):
    r = mock.MagicMock()
    r.status_code = 200
    r.json.return_value = {"id": user_id, "email": "a@b.com"}
    return r


def _error_response(status: int = 401):
    r = mock.MagicMock()
    r.status_code = status
    return r


def test_get_owner_id_returns_id(monkeypatch):
    monkeypatch.setattr(immich.requests, "get", lambda *a, **kw: _ok_response("user-123"))
    assert immich.get_owner_id() == "user-123"


def test_get_owner_id_caches(monkeypatch):
    calls = []

    def fake_get(*a, **kw):
        calls.append(1)
        return _ok_response("user-abc")

    monkeypatch.setattr(immich.requests, "get", fake_get)
    immich.get_owner_id()
    immich.get_owner_id()
    assert len(calls) == 1


def test_get_owner_id_returns_none_on_error(monkeypatch):
    monkeypatch.setattr(immich.requests, "get", lambda *a, **kw: _error_response(401))
    assert immich.get_owner_id() is None


def test_get_owner_id_returns_none_on_exception(monkeypatch):
    def boom(*a, **kw):
        raise ConnectionError("unreachable")

    monkeypatch.setattr(immich.requests, "get", boom)
    assert immich.get_owner_id() is None


# ---------------------------------------------------------------------------
# _fetch_assets owner filtering
# ---------------------------------------------------------------------------

def _search_response(items: list[dict]):
    r = mock.MagicMock()
    r.status_code = 200
    r.json.return_value = {"assets": {"items": items}}
    return r


def _make_asset(asset_id: str, owner_id: str, ts: str = "2024-01-01T00:00:00") -> dict:
    return {"id": asset_id, "ownerId": owner_id, "fileCreatedAt": ts, "createdAt": ts}


def test_fetch_assets_filters_out_other_owner(monkeypatch):
    immich._owner_id = "owner-A"
    assets = [
        _make_asset("asset-1", "owner-A"),
        _make_asset("asset-2", "owner-B"),
        _make_asset("asset-3", "owner-A"),
    ]
    monkeypatch.setattr(immich.requests, "post", lambda *a, **kw: _search_response(assets))
    result = immich._fetch_assets({"takenAfter": "2024-01-01"}, ts_field="fileCreatedAt", label="test")
    ids = [r[0] for r in result]
    assert ids == ["asset-1", "asset-3"]
    assert "asset-2" not in ids


def test_fetch_assets_keeps_all_when_owner_id_unknown(monkeypatch):
    immich._owner_id = None
    monkeypatch.setattr(immich.requests, "get", lambda *a, **kw: _error_response())
    assets = [
        _make_asset("asset-1", "owner-A"),
        _make_asset("asset-2", "owner-B"),
    ]
    monkeypatch.setattr(immich.requests, "post", lambda *a, **kw: _search_response(assets))
    result = immich._fetch_assets({"takenAfter": "2024-01-01"}, ts_field="fileCreatedAt", label="test")
    assert len(result) == 2


def test_fetch_assets_taken_after_uses_taken_query(monkeypatch):
    immich._owner_id = "owner-A"
    payloads = []

    def fake_post(url, json, headers, timeout):
        payloads.append(json)
        return _search_response([_make_asset("asset-1", "owner-A")])

    monkeypatch.setattr(immich.requests, "post", fake_post)
    result = immich.fetch_assets_taken_after("2024-01-01T00:00:00.000Z", "2024-01-02T23:59:59.999Z")
    assert result == [("asset-1", "2024-01-01T00:00:00")]
    assert payloads
    assert payloads[0]["takenAfter"] == "2024-01-01T00:00:00.000Z"
    assert payloads[0]["takenBefore"] == "2024-01-02T23:59:59.999Z"
    assert "createdAfter" not in payloads[0]


def test_fetch_assets_does_not_fallback_to_created_at(monkeypatch):
    immich._owner_id = "owner-A"
    assets = [
        {"id": "asset-created-only", "ownerId": "owner-A", "createdAt": "2025-01-01T00:00:00"},
        {"id": "asset-local", "ownerId": "owner-A", "localDateTime": "2021-10-30T03:37:46.000Z"},
    ]
    monkeypatch.setattr(immich.requests, "post", lambda *a, **kw: _search_response(assets))
    result = immich._fetch_assets({"takenAfter": "2020-01-01"}, ts_field="fileCreatedAt", label="test")
    assert result == [("asset-local", "2021-10-30T03:37:46.000Z")]
