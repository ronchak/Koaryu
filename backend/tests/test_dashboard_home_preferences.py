"""Home preferences use real routes and membership resolution with local Auth fakes."""

import asyncio
import json
from copy import deepcopy
from dataclasses import fields, replace
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.endpoints import dashboard
from app.services import dashboard_home_preferences as preferences
from app.services import dashboard_home_service as home
from app.services.studio_scope import (
    MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL,
    STAFF_ARCHIVED_DETAIL,
    SUBSCRIPTION_REQUIRED_DETAIL,
)
from tests.test_dashboard_home_sections import STUDIO, TODAY, home_key
from tests.test_dashboard_home_service import HomeSupabase, promotion_load_count

HOME = "/api/v1/dashboard/home"
PUT = f"{HOME}/preferences"
PANELS = ["follow_ups", "ready_to_promote", "recent_students"]


def entry(order=PANELS, hidden=(), size=None, version=1):
    return {
        "version": version,
        "order": list(order),
        "hidden": list(hidden),
        "size": {} if size is None else size,
    }


class FakeAuthAdmin:
    """GoTrue's admin update: shallow top-level merge where null deletes a key."""

    def __init__(self, metadata=None):
        self.metadata = deepcopy(metadata if metadata is not None else {})
        self.calls = []
        self.update_error = None
        # Runs between our read and our write, like another writer.
        self.before_update = None
        self.response_metadata = None

    def get_user_by_id(self, user_id):
        self.calls.append(("get", user_id))
        return SimpleNamespace(
            user=SimpleNamespace(
                id=user_id,
                email=f"{user_id}@example.test",
                user_metadata=deepcopy(self.metadata.get(user_id, {})),
            )
        )

    def update_user_by_id(self, user_id, attributes):
        self.calls.append(("update", user_id, deepcopy(attributes)))
        assert set(attributes) == {"user_metadata"}
        if self.update_error:
            raise self.update_error
        if self.before_update:
            self.before_update(self.metadata.setdefault(user_id, {}))
        current = self.metadata.setdefault(user_id, {})
        for key, value in deepcopy(attributes["user_metadata"]).items():
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
        returned = self.response_metadata if self.response_metadata is not None else current
        return SimpleNamespace(user=SimpleNamespace(id=user_id, user_metadata=deepcopy(returned)))


def provider(metadata=None, *, memberships=None):
    client = HomeSupabase()
    client.auth = SimpleNamespace(admin=FakeAuthAdmin(metadata))
    if memberships is not None:
        client.tables["staff_roles"] = memberships
    return client


def http_for(client, role="admin", studio=STUDIO, *, signed_in=True):
    app = FastAPI()
    app.include_router(dashboard.router, prefix="/api/v1")
    if signed_in:
        app.dependency_overrides[dashboard.get_current_user_id] = lambda: f"user-{role}"
    app.dependency_overrides[dashboard.get_requested_studio_id] = lambda: studio
    app.dependency_overrides[dashboard.get_supabase] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


def get(client, role="admin", studio=STUDIO):
    with http_for(client, role, studio) as http:
        return http.get(HOME)


def put(client, body, role="admin", studio=STUDIO):
    with http_for(client, role, studio) as http:
        return http.put(PUT, json=body)


@pytest.fixture(autouse=True)
def isolated_preferences(monkeypatch):
    # Membership and AuthService stay real; only subscription I/O and the clock are faked.
    for cache in (home.dashboard_home_fact_cache, home.dashboard_home_promotion_cache):
        cache.invalidate(STUDIO, domain="dashboard")
    monkeypatch.setattr(home, "ensure_platform_subscription_access", lambda *_a, **_k: None)
    monkeypatch.setattr(preferences, "ensure_platform_subscription_access", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "app.services.studio_scope.ensure_platform_subscription_access", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        home.DashboardHomeService, "_studio_today", staticmethod(lambda _tz: (TODAY, "UTC"))
    )
    yield
    for cache in (home.dashboard_home_fact_cache, home.dashboard_home_promotion_cache):
        cache.invalidate(STUDIO, domain="dashboard")


@pytest.mark.parametrize(
    "role,expected",
    [
        (
            "admin",
            entry(["recent_students", "ready_to_promote", "follow_ups"], ["ready_to_promote"]),
        ),
        ("front_desk", entry(["recent_students", "follow_ups"])),
        ("instructor", entry(["recent_students", "ready_to_promote"], ["ready_to_promote"])),
    ],
)
def test_get_reconciles_role_without_rewriting_and_reads_auth_once(role, expected):
    saved = entry(["recent_students", "ready_to_promote", "follow_ups"], ["ready_to_promote"])
    metadata = {f"user-{role}": {"koaryu_home": {STUDIO: saved}, "full_name": "Saved Name"}}
    client = provider(metadata)
    response = get(client, role)
    assert response.status_code == 200, response.text
    assert response.json()["preferences"] == expected
    assert client.auth.admin.calls == [("get", f"user-{role}")]
    assert client.auth.admin.metadata == metadata, "GET must not repair stored role preferences"


class UnreadableNamespace(dict):
    def get(self, key, default=None):
        if key == "koaryu_home":
            raise ValueError("unreadable namespace")
        return super().get(key, default)


@pytest.mark.parametrize(
    "metadata",
    [
        pytest.param({}, id="never-saved"),
        pytest.param({"koaryu_home": {STUDIO: entry(["junk"])}}, id="junk-ids-only"),
        pytest.param({"koaryu_home": {STUDIO: entry(version=True)}}, id="version-true"),
        pytest.param({"koaryu_home": {STUDIO: entry(version=2)}}, id="version-2"),
        pytest.param({"koaryu_home": {STUDIO: entry(version="1")}}, id="version-string"),
        pytest.param({"koaryu_home": {STUDIO: ["follow_ups"]}}, id="entry-list"),
        pytest.param({"koaryu_home": {STUDIO: "junk"}}, id="entry-string"),
        pytest.param({"koaryu_home": {STUDIO: None}}, id="entry-null"),
        pytest.param({"koaryu_home": "junk"}, id="namespace-string"),
        pytest.param(
            {"koaryu_home": {STUDIO: {**entry(), "order": "follow_ups"}}}, id="order-string"
        ),
        pytest.param({"koaryu_home": {STUDIO: {**entry(), "hidden": {}}}}, id="hidden-object"),
        pytest.param({"koaryu_home": {STUDIO: {**entry(), "size": []}}}, id="size-list"),
        pytest.param({"koaryu_home": {STUDIO: {**entry(), "padding": "x" * 1024}}}, id="over-1kb"),
        pytest.param({"koaryu_home": {"other-studio": entry()}}, id="other-studio-only"),
        pytest.param(UnreadableNamespace(full_name="Still readable"), id="unreadable-namespace"),
        pytest.param(None, id="metadata-null"),
        # GoTrue stores user_metadata as a JSON object and the client types it as a dict,
        # so string or list metadata cannot reach the backend; those cases are not tested.
    ],
)
def test_get_omits_invalid_or_unreadable_preferences_without_auth_write(metadata):
    client = provider({"user-admin": metadata})
    response = get(client)
    assert response.status_code == 200, (
        "Unreadable preferences must not fail Home: " + response.text
    )
    assert "preferences" not in response.json(), "Invalid saved preferences must be absent"
    assert client.auth.admin.calls == [("get", "user-admin")]
    assert client.auth.admin.metadata["user-admin"] == metadata


def test_get_without_studio_omits_preferences_and_returns_identity_only():
    metadata = {"user-admin": {"koaryu_home": {STUDIO: entry()}}}
    client = provider(metadata, memberships=[])
    response = get(client, studio=None)
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"generated_at", "viewer"}
    assert client.auth.admin.calls == [("get", "user-admin")]
    assert client.auth.admin.metadata == metadata
    assert client.rpc_calls == []


@pytest.mark.parametrize("bytes_over_limit", [0, 1], ids=["exactly-1024", "1025"])
def test_get_entry_size_limit_counts_utf8_bytes_and_accepts_boundary(bytes_over_limit):
    saved = {**entry(), "padding": ""}
    base_bytes = len(json.dumps(saved, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    remaining = 1024 + bytes_over_limit - base_bytes
    saved["padding"] = "é" * (remaining // 2) + "x" * (remaining % 2)
    assert (
        len(json.dumps(saved, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        == 1024 + bytes_over_limit
    )
    client = provider({"user-admin": {"koaryu_home": {STUDIO: saved}}})
    response = get(client)
    assert response.status_code == 200, response.text
    if bytes_over_limit:
        assert "preferences" not in response.json()
    else:
        assert response.json()["preferences"] == entry()
    assert client.auth.admin.calls == [("get", "user-admin")]
    assert client.auth.admin.metadata["user-admin"]["koaryu_home"][STUDIO] == saved


@pytest.mark.parametrize("desk_saved", [False, True], ids=["no-preferences", "own-preferences"])
def test_shared_fact_and_promotion_caches_never_retain_preferences(desk_saved):
    admin_entry = entry(["recent_students", "ready_to_promote", "follow_ups"], ["follow_ups"])
    desk_entry = entry(["recent_students", "follow_ups"], ["follow_ups"])
    metadata = {"user-admin": {"koaryu_home": {STUDIO: admin_entry}}}
    if desk_saved:
        metadata["user-front_desk"] = {"koaryu_home": {STUDIO: desk_entry}}
    client = provider(metadata)
    admin = get(client)
    desk = get(client, "front_desk")
    instructor = get(client, "instructor")
    assert all(response.status_code == 200 for response in (admin, desk, instructor))
    assert admin.json()["preferences"] == admin_entry
    if desk_saved:
        assert desk.json()["preferences"] == desk_entry
    else:
        assert "preferences" not in desk.json()
    assert "preferences" not in instructor.json()
    assert sum(name == "dashboard_summary_facts" for name, _ in client.rpc_calls) == 2
    assert promotion_load_count(client) == 1, "Instructor must reuse the admin's promotions"
    # A changed identity value must be visible even while both fact caches stay warm.
    changed = entry(PANELS, ["recent_students"])
    client.auth.admin.metadata["user-admin"]["koaryu_home"][STUDIO] = changed
    assert get(client).json()["preferences"] == changed
    assert sum(name == "dashboard_summary_facts" for name, _ in client.rpc_calls) == 2
    assert promotion_load_count(client) == 1
    assert client.auth.admin.calls == [
        ("get", "user-admin"),
        ("get", "user-front_desk"),
        ("get", "user-instructor"),
        ("get", "user-admin"),
    ]

    async def must_be_cached():
        pytest.fail("Expected the previously populated cache entry")

    for cache, key in (
        (home.dashboard_home_fact_cache, home_key()),
        (
            home.dashboard_home_promotion_cache,
            replace(
                home_key(visibility="billing_hidden"),
                formula_version=home.DASHBOARD_HOME_PROMOTIONS_FORMULA_VERSION,
            ),
        ),
    ):
        value = asyncio.run(cache.get_or_load(key, must_be_cached))
        assert "preferences" not in {field.name for field in fields(value)}
        assert not hasattr(value, "preferences")


@pytest.mark.parametrize("existing_entry", [False, True], ids=["first-save", "replace-entry"])
@pytest.mark.parametrize(
    "role,expected",
    [
        ("admin", entry(["recent_students", "follow_ups", "ready_to_promote"], ["follow_ups"])),
        ("front_desk", entry(["recent_students", "follow_ups"], ["follow_ups"])),
        ("instructor", entry(["recent_students", "ready_to_promote"])),
    ],
)
def test_put_reconciles_saving_role_preserves_metadata_and_replaces_entry(
    existing_entry, role, expected
):
    other_keys = {
        "full_name": "Ronak C",
        "email_verified": True,
        "flag": False,
        "nested": {"items": [1, {"x": None}, False]},
    }
    user_id = f"user-{role}"
    initial = deepcopy(other_keys)
    if existing_entry:
        initial["koaryu_home"] = {STUDIO: entry(["follow_ups"])}
    client = provider({user_id: initial})
    submitted = entry(
        ["recent_students", "follow_ups", "ready_to_promote"],
        ["follow_ups"],
        {"recent_students": "expanded"},
    )
    response = put(client, submitted, role)
    assert response.status_code == 200, response.text
    assert response.json() == expected
    assert client.auth.admin.metadata[user_id] == {**other_keys, "koaryu_home": {STUDIO: expected}}
    assert client.auth.admin.calls == [
        ("get", user_id),
        ("update", user_id, {"user_metadata": {"koaryu_home": {STUDIO: expected}}}),
    ]
    assert response.headers["cache-control"] == "no-store, private"
    assert response.headers["vary"] == "Authorization, X-Studio-Id, Cookie"


def test_put_drops_valid_junk_and_oversize_entries_for_other_studios():
    untouched = {
        "full_name": "Owner",
        "verified": True,
        "nested": {"values": [False, None, {"v": 1}]},
    }
    client = provider(
        {
            "user-admin": {
                **untouched,
                "koaryu_home": {
                    STUDIO: entry(),
                    "old-valid": entry(),
                    "old-junk": "junk",
                    "old-oversize": {**entry(), "padding": "x" * 2000},
                },
            }
        }
    )
    response = put(client, entry(["recent_students"]))
    expected = entry(["recent_students", "follow_ups", "ready_to_promote"])
    assert response.status_code == 200, response.text
    assert response.json() == expected
    assert client.auth.admin.metadata["user-admin"] == {
        **untouched,
        "koaryu_home": {STUDIO: expected},
    }
    assert client.auth.admin.calls == [
        ("get", "user-admin"),
        ("update", "user-admin", {"user_metadata": {"koaryu_home": {STUDIO: expected}}}),
    ]


@pytest.mark.parametrize("stale", [False, True], ids=["clean", "stale-studio"])
def test_identical_resave_only_writes_when_stale_studio_needs_dropping(stale):
    saved = entry(PANELS, ["recent_students"])
    namespace = {STUDIO: saved}
    if stale:
        namespace["old-studio"] = entry()
    client = provider({"user-admin": {"full_name": "Owner", "koaryu_home": namespace}})
    response = put(client, saved)
    assert response.status_code == 200, response.text
    assert response.json() == saved
    assert [call[0] for call in client.auth.admin.calls] == (
        ["get", "update"] if stale else ["get"]
    )
    assert client.auth.admin.metadata["user-admin"] == {
        "full_name": "Owner",
        "koaryu_home": {STUDIO: saved},
    }


def test_put_sends_only_the_namespace_key_and_keeps_null_valued_keys():
    stored = {
        "full_name": "Owner",
        "avatar_url": None,
        "nested": {"x": None},
        "koaryu_home": {STUDIO: entry(), "old-studio": entry()},
    }
    client = provider({"user-admin": stored})
    response = put(client, entry(["recent_students"]))
    expected = entry(["recent_students", "follow_ups", "ready_to_promote"])
    assert response.status_code == 200, response.text
    (_, _, attributes) = client.auth.admin.calls[-1]
    assert list(attributes) == ["user_metadata"]
    assert list(attributes["user_metadata"]) == ["koaryu_home"]
    assert attributes["user_metadata"]["koaryu_home"] == {STUDIO: expected}
    # A null-valued key would be deleted by GoTrue's merge if it were re-sent.
    assert client.auth.admin.metadata["user-admin"] == {
        "full_name": "Owner",
        "avatar_url": None,
        "nested": {"x": None},
        "koaryu_home": {STUDIO: expected},
    }


def test_put_keeps_a_full_name_changed_between_read_and_write():
    client = provider({"user-admin": {"full_name": "Old Name", "koaryu_home": {STUDIO: entry()}}})

    def concurrent_rename(current):
        current["full_name"] = "New Name"

    client.auth.admin.before_update = concurrent_rename
    response = put(client, entry(["recent_students"]))
    assert response.status_code == 200, response.text
    assert [call[0] for call in client.auth.admin.calls] == ["get", "update"]
    assert client.auth.admin.metadata["user-admin"] == {
        "full_name": "New Name",
        "koaryu_home": {STUDIO: entry(["recent_students", "follow_ups", "ready_to_promote"])},
    }


def test_put_logs_lost_metadata_keys_without_values_or_repair(caplog):
    secret = "value-that-must-not-be-logged"
    client = provider({"user-admin": {"full_name": secret, "koaryu_home": {}}})
    client.auth.admin.response_metadata = {"koaryu_home": {STUDIO: entry()}}
    with caplog.at_level("ERROR", logger=preferences.__name__):
        response = put(client, entry())
    assert response.status_code == 200, response.text
    assert [call[0] for call in client.auth.admin.calls] == ["get", "update"]
    records = [r for r in caplog.records if r.name == preferences.__name__]
    assert [r.levelname for r in records] == ["ERROR"]
    assert records[0].lost_key_count == 1 and records[0].lost_keys == ["full_name"]
    assert secret not in caplog.text and all(secret not in str(vars(r)) for r in records)


INVALID_BODIES = [
    *[
        pytest.param(
            {key: value for key, value in entry().items() if key != missing},
            id=f"missing-{missing}",
        )
        for missing in ("version", "order", "hidden", "size")
    ],
    *[
        pytest.param({**entry(), key: "injected"}, id=f"extra-{key}")
        for key in ("user_id", "studio_id", "extra")
    ],
    pytest.param(entry(["unknown"]), id="unknown-order"),
    pytest.param(entry(hidden=["unknown"]), id="unknown-hidden"),
    pytest.param(entry(size={"unknown": "compact"}), id="unknown-size-key"),
    pytest.param(entry(["follow_ups", "follow_ups"]), id="duplicate-order"),
    pytest.param(entry(hidden=["follow_ups", "follow_ups"]), id="duplicate-hidden"),
    pytest.param(entry(["follow_ups"] * 9), id="over-8-order"),
    pytest.param(entry(hidden=["follow_ups"] * 9), id="over-8-hidden"),
    pytest.param(entry(size={f"id-{i}": "compact" for i in range(9)}), id="over-8-size"),
    *[
        pytest.param(entry(size={"follow_ups": value}), id=f"bad-size-{value!r}")
        for value in ("huge", 1, True, None, [], {})
    ],
    *[
        pytest.param(entry(version=value), id=f"version-{value!r}")
        for value in (True, False, 0, 2, "1", 1.0, None)
    ],
    pytest.param({**entry(), "order": "follow_ups"}, id="order-string"),
    pytest.param({**entry(), "hidden": {}}, id="hidden-object"),
    pytest.param({**entry(), "size": []}, id="size-list"),
    *[
        pytest.param({**entry(), key: None}, id=f"null-{key}")
        for key in ("order", "hidden", "size")
    ],
    pytest.param(entry([1]), id="order-number"),
    pytest.param(None, id="null-body"),
    pytest.param([], id="list-body"),
]


@pytest.mark.parametrize("body", INVALID_BODIES)
def test_put_shape_errors_return_422_before_any_auth_call(body):
    client = provider()
    response = put(client, body)
    assert response.status_code == 422, f"Invalid body reached save: {body!r}; {response.text}"
    assert client.auth.admin.calls == [], "Shape validation must happen before Auth reads or writes"
    assert client.query_log == [], "Shape validation must happen before membership reads"


def test_put_serialized_entry_cap_returns_413_before_auth(monkeypatch):
    # The current three ids cannot naturally exceed 1 KB. Lower the cap to exercise the backstop.
    monkeypatch.setattr(preferences, "HOME_PREFERENCES_ENTRY_MAX_BYTES", 10)
    client = provider()
    response = put(client, entry())
    assert response.status_code == 413, response.text
    assert response.json()["detail"] == "Home preferences are too large."
    assert client.auth.admin.calls == []


def memberships(*rows):
    return [
        {
            "id": f"role-{i}",
            "user_id": "user-admin",
            "role": "admin",
            "created_at": "2026-01-01T00:00:00Z",
            "archived_at": None,
            **row,
        }
        for i, row in enumerate(rows)
    ]


@pytest.mark.parametrize(
    "rows,selector,status,detail",
    [
        ([], None, 403, "Home preferences need an active studio membership."),
        ([], STUDIO, 403, "You do not have access to the requested studio."),
        (
            memberships({"studio_id": STUDIO, "archived_at": "2026-02-01T00:00:00Z"}),
            STUDIO,
            403,
            STAFF_ARCHIVED_DETAIL,
        ),
        (
            memberships({"studio_id": STUDIO}),
            "foreign-studio",
            403,
            "You do not have access to the requested studio.",
        ),
        (
            memberships({"studio_id": STUDIO}, {"studio_id": "second-studio"}),
            STUDIO,
            409,
            MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL,
        ),
        (
            memberships({"studio_id": STUDIO}, {"studio_id": "second-studio"}),
            None,
            409,
            MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL,
        ),
    ],
    ids=[
        "no-membership",
        "no-membership-selector",
        "archived",
        "foreign-selector",
        "multiple-selected",
        "multiple-unselected",
    ],
)
def test_put_access_denials_precede_auth_reads_and_writes(rows, selector, status, detail):
    client = provider(memberships=rows)
    response = put(client, entry(), studio=selector)
    assert response.status_code == status, response.text
    assert response.json()["detail"] == detail
    assert client.auth.admin.calls == []


def test_put_signed_out_returns_401_without_auth_calls():
    client = provider()
    with http_for(client, signed_in=False) as http:
        response = http.put(PUT, json=entry())
    assert response.status_code == 401, response.text
    assert client.auth.admin.calls == []
    assert client.query_log == []


def test_put_lapsed_subscription_returns_402_before_auth(monkeypatch):
    def deny(*_args, **_kwargs):
        raise HTTPException(status_code=402, detail=SUBSCRIPTION_REQUIRED_DETAIL)

    monkeypatch.setattr(preferences, "ensure_platform_subscription_access", deny)
    client = provider()
    response = put(client, entry())
    assert response.status_code == 402, response.text
    assert response.json()["detail"] == SUBSCRIPTION_REQUIRED_DETAIL
    assert client.auth.admin.calls == []


def test_put_failed_auth_update_returns_5xx_without_success_or_persistence():
    initial = {"user-admin": {"full_name": "Owner", "koaryu_home": {STUDIO: entry()}}}
    client = provider(initial)
    client.auth.admin.update_error = RuntimeError("fake Auth update unavailable")
    response = put(client, entry(["recent_students"]))
    assert 500 <= response.status_code < 600, response.text
    assert [call[0] for call in client.auth.admin.calls] == ["get", "update"]
    assert client.auth.admin.metadata == initial
    assert "order" not in response.text, (
        "Failed update must not return a successful preferences body"
    )
