"""Mocked recipient boundary and pinned SDK parsing; no SQL or provider integration."""

import base64
import json
from copy import deepcopy
from datetime import datetime, timezone
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest import SyncPostgrestClient
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from pydantic import ValidationError

from app.api.v1.endpoints import belt_test_recipients as routes
from app.api.v1.endpoints import belt_tests as event_routes
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.belt_test_recipient import (
    BeltTestRecipientApprovalResponse,
    BeltTestRecipientApprove,
    BeltTestRecipientListResponse,
    BeltTestRecipientResponse,
    BeltTestRecipientRevoke,
    BeltTestRecipientSelection,
)
from app.schemas.trial_appointment import MAX_REVISION
from app.services.belt_test_recipient_service import (
    ADMIN_REQUIRED_DETAIL,
    INVALID_CURSOR_DETAIL,
    UNAVAILABLE_DETAIL,
    BeltTestRecipientApprovalResult,
    BeltTestRecipientMutationResult,
    BeltTestRecipientService,
)
from tests.fakes.supabase import TableBackedSupabase

(
    STUDIO,
    ACTOR,
    EVENT,
    STUDENT,
    MEMBERSHIP,
    RECIPIENT,
    OPERATION,
    CURRENT_RANK,
    TARGET_RANK,
    OTHER,
) = (str(UUID(int=value)) for value in range(1, 11))
LIST = "list_belt_test_recipients_v1"
APPROVE = "approve_belt_test_recipients_v1"
REVOKE = "revoke_belt_test_recipient_v1"
BASE = "/api/v1/belt-tests"
RECIPIENTS_PATH = BASE + f"/{EVENT}/recipients"
APPROVE_PATH = RECIPIENTS_PATH + "/approve"
REVOKE_PATH = RECIPIENTS_PATH + f"/{RECIPIENT}/revoke"
SELECTION = {"student_id": STUDENT, "student_program_membership_id": MEMBERSHIP}
APPROVAL = {
    "operation_id": OPERATION,
    "expected_event_revision": 8,
    "recipients": [SELECTION],
}
REVOCATION = {"operation_id": OPERATION, "expected_revision": 2}
# Old timestamps and retained IDs must remain readable without current-fact lookups.
ROW = {
    "id": RECIPIENT,
    "studio_id": STUDIO,
    "event_id": EVENT,
    "student_id": STUDENT,
    "student_program_membership_id": MEMBERSHIP,
    "approved_schedule_revision": 3,
    "approved_current_rank_id": CURRENT_RANK,
    "approved_target_rank_id": TARGET_RANK,
    "state": "approved",
    "revision": 2,
    "approved_by": ACTOR,
    "approved_at": "2020-10-01T12:00:00Z",
    "revoked_at": None,
    "created_at": "2020-10-01T12:00:00Z",
    "updated_at": "2020-10-02T12:00:00Z",
}
BATCH = {"items": [ROW], "event_revision": 8, "schedule_revision": 3}
APPROVAL_RECEIPT = {"payload": BATCH, "operation_id": OPERATION, "replayed": False}
REVOKED_ROW = {**ROW, "state": "revoked", "revision": 4, "revoked_at": "2020-10-03T12:00:00Z"}
REVOCATION_RECEIPT = {"payload": REVOKED_ROW, "operation_id": OPERATION, "replayed": False}
PAGE = {
    "payload": {
        "items": [ROW, {**REVOKED_ROW, "id": OTHER, "student_id": OTHER}],
        "next_cursor": None,
        "has_more": False,
    }
}
CURSOR = {"created_at": ROW["created_at"], "id": RECIPIENT}
ROUTE_CASES = [
    ("GET", RECIPIENTS_PATH, None, LIST),
    ("POST", APPROVE_PATH, APPROVAL, APPROVE),
    ("POST", REVOKE_PATH, REVOCATION, REVOKE),
]
MALFORMED_ERROR_IDENTITIES = [[], {}, None, 0, True, 1.5]


def encoded(value):
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def malformed_provider_error(field, value):
    return {
        "code": "P0001",
        "message": "AUTOMATION_STATE_CONFLICT",
        "details": "private recipient details",
        "hint": "private SQL",
        field: value,
    }


class Database(TableBackedSupabase):
    def __init__(self):
        super().__init__(
            {
                "staff_roles": [
                    {
                        "user_id": ACTOR,
                        "studio_id": STUDIO,
                        "role": "admin",
                        "archived_at": None,
                    }
                ]
            }
        )
        self.rpc_calls = []
        self.execute_calls = []
        self.handlers = {
            LIST: deepcopy(PAGE),
            APPROVE: deepcopy(APPROVAL_RECEIPT),
            REVOKE: deepcopy(REVOCATION_RECEIPT),
        }

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))

        def execute():
            self.execute_calls.append(name)
            handler = self.handlers[name]
            if isinstance(handler, Exception):
                raise handler
            return SimpleNamespace(data=deepcopy(handler))

        return SimpleNamespace(execute=execute)


@pytest.fixture
def database():
    return Database()


@pytest.fixture
def api(monkeypatch, database):
    def entitled(client, studio_id):
        assert client is database
        assert studio_id == STUDIO
        assert database.query_log
        assert database.rpc_calls == []

    subscription = Mock(side_effect=entitled)
    monkeypatch.setattr(routes, "ensure_platform_subscription_access", subscription)
    lane_calls = []
    original_run = routes.run_supabase_operation

    async def tracked_run(provider, operation, *, lane):
        lane_calls.append(lane)
        return await original_run(provider, operation, lane=lane)

    monkeypatch.setattr(routes, "run_supabase_operation", tracked_run)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield client, database, subscription, lane_calls, app


def call_service(database, rpc):
    service = BeltTestRecipientService(database)
    if rpc == LIST:
        return service.list_recipients(STUDIO, ACTOR, EVENT)
    if rpc == APPROVE:
        return service.approve_recipients(
            STUDIO, ACTOR, EVENT, BeltTestRecipientApprove(**APPROVAL)
        )
    return service.revoke_recipient(
        STUDIO, ACTOR, EVENT, RECIPIENT, BeltTestRecipientRevoke(**REVOCATION)
    )


def assert_unavailable(call):
    with pytest.raises(HTTPException) as error:
        call()
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    return error.value


@pytest.mark.parametrize("count", [1, 100])
def test_selection_bounds_accept_one_and_one_hundred(count):
    recipients = [{"student_id": str(UUID(int=100 + value))} for value in range(count)]
    body = BeltTestRecipientApprove(**{**APPROVAL, "recipients": recipients})
    assert len(body.recipients) == count
    assert all(row.student_program_membership_id is None for row in body.recipients)


@pytest.mark.parametrize(
    "recipients",
    [[], [{"student_id": str(UUID(int=value))} for value in range(101)], (SELECTION,), None, {}],
)
def test_selection_bounds_reject_empty_overlong_or_nonlist(recipients):
    with pytest.raises(ValidationError):
        BeltTestRecipientApprove(**{**APPROVAL, "recipients": recipients})


@pytest.mark.parametrize("explicit_null", [False, True])
def test_duplicate_omitted_and_null_memberships_are_the_same_pair(explicit_null):
    first = {"student_id": STUDENT}
    second = {**first, "student_program_membership_id": None} if explicit_null else first
    with pytest.raises(ValidationError):
        BeltTestRecipientApprove(**{**APPROVAL, "recipients": [first, second]})


@pytest.mark.parametrize("field", ["student_id", "student_program_membership_id"])
def test_duplicate_pair_detection_normalizes_uuid_spelling(field):
    value = UUID("abcdefab-cdef-abcd-efab-cdefabcdefab")
    first = {**SELECTION, field: str(value)}
    second = {**first, field: value.hex.upper()}
    with pytest.raises(ValidationError):
        BeltTestRecipientApprove(**{**APPROVAL, "recipients": [first, second]})


def test_same_student_with_distinct_membership_contexts_is_left_to_sql():
    recipients = [
        SELECTION,
        {"student_id": STUDENT},
        {**SELECTION, "student_program_membership_id": OTHER},
    ]
    body = BeltTestRecipientApprove(**{**APPROVAL, "recipients": recipients})
    assert len(body.recipients) == 3


@pytest.mark.parametrize(
    "field,value",
    [
        ("name", "Spoofed"),
        ("email", "private@example.invalid"),
        ("rank_id", OTHER),
        ("program_id", OTHER),
        ("approved_current_rank_id", OTHER),
        ("approved_target_rank_id", OTHER),
        ("approved_schedule_revision", 1),
        ("approved_by", OTHER),
        ("approved_at", ROW["approved_at"]),
        ("classes_met", True),
        ("time_met", True),
        ("requires_approval", False),
        ("state", "approved"),
        ("studio_id", OTHER),
        ("actor_id", OTHER),
    ],
)
def test_selection_and_approval_reject_spoofed_facts(field, value):
    with pytest.raises(ValidationError):
        BeltTestRecipientSelection(**{**SELECTION, field: value})
    with pytest.raises(ValidationError):
        BeltTestRecipientApprove(**{**APPROVAL, field: value})
    with pytest.raises(ValidationError):
        BeltTestRecipientRevoke(**{**REVOCATION, field: value})


@pytest.mark.parametrize("value", [0, -1, True, 1.0, "1", MAX_REVISION + 1, None])
def test_all_revision_fields_are_strict_positive_bigints(value):
    with pytest.raises(ValidationError):
        BeltTestRecipientApprove(**{**APPROVAL, "expected_event_revision": value})
    with pytest.raises(ValidationError):
        BeltTestRecipientRevoke(**{**REVOCATION, "expected_revision": value})
    for field in ["approved_schedule_revision", "revision"]:
        with pytest.raises(ValidationError):
            BeltTestRecipientResponse(**{**ROW, field: value})
    for field in ["event_revision", "schedule_revision"]:
        with pytest.raises(ValidationError):
            BeltTestRecipientApprovalResponse(**{**BATCH, field: value})


def test_bigint_max_is_accepted_with_independent_revisions():
    assert BeltTestRecipientApprove(**{**APPROVAL, "expected_event_revision": MAX_REVISION})
    assert BeltTestRecipientRevoke(**{**REVOCATION, "expected_revision": MAX_REVISION})
    result = BeltTestRecipientApprovalResponse(**{**BATCH, "event_revision": MAX_REVISION})
    assert result.event_revision == MAX_REVISION
    assert result.schedule_revision == 3
    assert result.items[0].revision == 2


@pytest.mark.parametrize("field", list(ROW))
def test_response_requires_every_canonical_key_including_nullable_fields(field):
    with pytest.raises(ValidationError):
        BeltTestRecipientResponse(**{key: value for key, value in ROW.items() if key != field})


def test_response_preserves_nullable_and_historical_context_without_inferring_links():
    row = {
        **ROW,
        "student_program_membership_id": None,
        "approved_current_rank_id": None,
        "approved_by": None,
        "approved_at": "2020-10-01T05:00:00-07:00",
    }
    result = BeltTestRecipientResponse(**row)
    assert result.approved_at == datetime(2020, 10, 1, 12, tzinfo=timezone.utc)
    assert result.model_dump(mode="json") == {**row, "approved_at": ROW["approved_at"]}


@pytest.mark.parametrize(
    "changes",
    [
        {"approved_target_rank_id": None},
        {"state": "scheduled"},
        {"student_id": "invalid"},
        {"approved_at": "2020-10-01T12:00:00"},
        {"created_at": 1601553600},
        {"revoked_at": "2020-10-01"},
        {"email": "private@example.invalid"},
    ],
)
def test_response_rejects_malformed_or_additional_facts(changes):
    with pytest.raises(ValidationError):
        BeltTestRecipientResponse(**{**ROW, **changes})


@pytest.mark.parametrize("items", [[], [ROW] * 101, (ROW,), None, {}])
def test_approval_response_requires_a_bounded_strict_nonempty_list(items):
    with pytest.raises(ValidationError):
        BeltTestRecipientApprovalResponse(**{**BATCH, "items": items})


@pytest.mark.parametrize(
    "changes",
    [
        {"items": [ROW] * 101},
        {"items": (ROW,)},
        {"has_more": 1},
        {"has_more": True},
        {"next_cursor": ""},
        {"next_cursor": "a" * 513},
        {"next_cursor": encoded(CURSOR)},
        {"extra": True},
    ],
)
def test_public_list_response_is_bounded_and_consistent(changes):
    with pytest.raises(ValidationError):
        BeltTestRecipientListResponse(**{**PAGE["payload"], **changes})


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE])
@pytest.mark.parametrize("replayed", [False, True])
def test_mutations_use_exact_arguments_and_preserve_original_payload(database, rpc, replayed):
    database.handlers[rpc]["replayed"] = replayed
    result = call_service(database, rpc)
    assert result.model_dump(mode="json") == database.handlers[rpc]
    args = {
        "p_studio_id": STUDIO,
        "p_actor_id": ACTOR,
        "p_event_id": EVENT,
        "p_operation_id": OPERATION,
    }
    if rpc == APPROVE:
        args.update(p_expected_event_revision=8, p_recipients=[SELECTION])
    else:
        args.update(p_recipient_id=RECIPIENT, p_expected_revision=2)
    assert database.rpc_calls == [(rpc, args)]
    assert database.execute_calls == [rpc]
    assert database.query_log == []


def test_approval_sends_both_pair_keys_and_preserves_legacy_null(database):
    database.handlers[APPROVE]["payload"]["items"][0]["student_program_membership_id"] = None
    body = BeltTestRecipientApprove(**{**APPROVAL, "recipients": [{"student_id": STUDENT}]})
    result = BeltTestRecipientService(database).approve_recipients(STUDIO, ACTOR, EVENT, body)
    assert result.payload.items[0].student_program_membership_id is None
    assert database.rpc_calls[0][1]["p_recipients"] == [
        {"student_id": STUDENT, "student_program_membership_id": None}
    ]
    assert database.query_log == []


@pytest.mark.parametrize("count", [2, 100])
def test_approval_matches_unordered_pairs_and_does_not_guess_revision_relationships(
    database, count
):
    selections = [
        {"student_id": STUDENT, "student_program_membership_id": str(UUID(int=100 + index))}
        for index in range(count)
    ]
    rows = [
        {**ROW, **selection, "id": str(UUID(int=1000 + index))}
        for index, selection in enumerate(selections)
    ][::-1]
    database.handlers[APPROVE]["payload"].update(items=rows, event_revision=MAX_REVISION)
    result = BeltTestRecipientService(database).approve_recipients(
        STUDIO, ACTOR, EVENT, BeltTestRecipientApprove(**{**APPROVAL, "recipients": selections})
    )
    assert result.payload.model_dump(mode="json") == {
        "items": rows,
        "event_revision": MAX_REVISION,
        "schedule_revision": 3,
    }
    assert database.execute_calls == [APPROVE]
    assert database.query_log == []


def test_reapproval_and_old_receipt_preserve_their_own_rank_and_schedule_snapshots(database):
    service = BeltTestRecipientService(database)
    original = service.approve_recipients(
        STUDIO, ACTOR, EVENT, BeltTestRecipientApprove(**APPROVAL)
    )
    fresh_row = {
        **ROW,
        "approved_current_rank_id": TARGET_RANK,
        "approved_target_rank_id": OTHER,
        "approved_schedule_revision": 7,
        "revision": 10,
    }
    database.handlers[APPROVE] = {
        "payload": {"items": [fresh_row], "event_revision": 20, "schedule_revision": 7},
        "operation_id": OTHER,
        "replayed": False,
    }
    fresh = service.approve_recipients(
        STUDIO,
        ACTOR,
        EVENT,
        BeltTestRecipientApprove(
            **{**APPROVAL, "operation_id": OTHER, "expected_event_revision": 20}
        ),
    )
    database.handlers[APPROVE] = {**deepcopy(APPROVAL_RECEIPT), "replayed": True}
    replay = service.approve_recipients(STUDIO, ACTOR, EVENT, BeltTestRecipientApprove(**APPROVAL))
    assert (
        original.payload.model_dump(mode="json") == replay.payload.model_dump(mode="json") == BATCH
    )
    assert fresh.payload.items[0].id == replay.payload.items[0].id == UUID(RECIPIENT)
    assert fresh.payload.items[0].approved_target_rank_id == UUID(OTHER)
    assert replay.payload.items[0].approved_target_rank_id == UUID(TARGET_RANK)
    assert database.execute_calls == [APPROVE] * 3
    assert database.query_log == []


@pytest.mark.parametrize(
    "change",
    [
        "partial",
        "extra",
        "duplicate_id",
        "duplicate_pair",
        "substitute_membership",
        "membership_to_legacy",
        "substitute_student",
        "studio_id",
        "event_id",
        "state",
        "approved_schedule_revision",
        "schedule_revision",
    ],
)
def test_approval_rejects_incomplete_extra_substituted_or_foreign_batches(database, change):
    second_selection = {"student_id": OTHER, "student_program_membership_id": None}
    selections = [SELECTION, second_selection]
    rows = [deepcopy(ROW), {**ROW, **second_selection, "id": OTHER}]
    payload = {**BATCH, "items": rows}
    if change == "partial":
        payload["items"] = rows[:1]
    elif change == "extra":
        payload["items"].append({**ROW, "id": EVENT, "student_id": EVENT})
    elif change == "duplicate_id":
        rows[1]["id"] = ROW["id"]
    elif change == "duplicate_pair":
        rows[1].update(SELECTION)
    elif change == "substitute_membership":
        rows[0]["student_program_membership_id"] = OTHER
    elif change == "membership_to_legacy":
        rows[0]["student_program_membership_id"] = None
    elif change == "substitute_student":
        rows[0]["student_id"] = OTHER
    elif change in {"studio_id", "event_id"}:
        rows[0][change] = OTHER
    elif change == "state":
        rows[0]["state"] = "revoked"
    elif change == "approved_schedule_revision":
        rows[0][change] = 4
    else:
        payload[change] = 4
    database.handlers[APPROVE]["payload"] = payload
    assert_unavailable(
        lambda: BeltTestRecipientService(database).approve_recipients(
            STUDIO, ACTOR, EVENT, BeltTestRecipientApprove(**{**APPROVAL, "recipients": selections})
        )
    )
    assert database.execute_calls == [APPROVE]
    assert database.query_log == []


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE])
@pytest.mark.parametrize(
    "change",
    [
        "bare_payload",
        "message",
        "extra",
        "list",
        "payload_null",
        "no_operation",
        "no_replayed",
        "wrong_operation",
        "invalid_operation",
        "replayed_int",
        "replayed_string",
        "payload_extra",
    ],
)
def test_mutations_reject_malformed_envelopes(database, rpc, change):
    receipt = database.handlers[rpc]
    if change == "bare_payload":
        receipt = receipt["payload"]
    elif change == "message":
        receipt["message"] = receipt.pop("payload")
    elif change == "extra":
        receipt["extra"] = "private"
    elif change == "list":
        receipt = [receipt]
    elif change == "payload_null":
        receipt["payload"] = None
    elif change == "no_operation":
        del receipt["operation_id"]
    elif change == "no_replayed":
        del receipt["replayed"]
    elif change == "wrong_operation":
        receipt["operation_id"] = OTHER
    elif change == "invalid_operation":
        receipt["operation_id"] = "invalid"
    elif change == "replayed_int":
        receipt["replayed"] = 1
    elif change == "replayed_string":
        receipt["replayed"] = "true"
    else:
        receipt["payload"]["extra"] = "private"
    database.handlers[rpc] = receipt
    assert_unavailable(lambda: call_service(database, rpc))
    assert database.execute_calls == [rpc]
    assert database.query_log == []


@pytest.mark.parametrize("field", ["studio_id", "event_id", "id", "state"])
def test_revocation_rejects_foreign_identity_or_nonrevoked_state(database, field):
    database.handlers[REVOKE]["payload"][field] = "approved" if field == "state" else OTHER
    assert_unavailable(lambda: call_service(database, REVOKE))
    assert database.execute_calls == [REVOKE]
    assert database.query_log == []


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE])
def test_mutation_envelopes_revalidate_nested_model_instances(rpc):
    row = BeltTestRecipientResponse(**ROW)
    row.revision = True
    if rpc == APPROVE:
        result = BeltTestRecipientApprovalResult.model_construct(
            payload=BeltTestRecipientApprovalResponse.model_construct(
                items=[row], event_revision=8, schedule_revision=3
            ),
            operation_id=UUID(OPERATION),
            replayed=False,
        )
        with pytest.raises(ValidationError):
            BeltTestRecipientApprovalResult.model_validate(result)
    else:
        result = BeltTestRecipientMutationResult.model_construct(
            payload=row, operation_id=UUID(OPERATION), replayed=False
        )
        with pytest.raises(ValidationError):
            BeltTestRecipientMutationResult.model_validate(result)


def test_list_uses_parent_scoped_rpc_even_for_empty_page(database):
    database.handlers[LIST] = {"payload": {"items": [], "next_cursor": None, "has_more": False}}
    result = call_service(database, LIST)
    assert result.model_dump() == {"items": [], "next_cursor": None, "has_more": False}
    assert database.rpc_calls == [
        (
            LIST,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_event_id": EVENT,
                "p_limit": 50,
                "p_cursor": None,
            },
        )
    ]
    assert database.execute_calls == [LIST]
    assert database.query_log == []


def test_empty_parent_not_found_is_not_replaced_with_an_empty_page(database):
    database.handlers[LIST] = APIError({"code": "P0002", "message": "AUTOMATION_NOT_FOUND"})
    with pytest.raises(HTTPException) as error:
        call_service(database, LIST)
    assert error.value.status_code == 404
    assert database.execute_calls == [LIST]
    assert database.query_log == []


def test_list_accepts_approved_and_revoked_historical_snapshots_without_pre_reads(database):
    result = call_service(database, LIST)
    assert result.model_dump(mode="json") == PAGE["payload"]
    assert database.query_log == []
    assert database.execute_calls == [LIST]


def test_cursor_roundtrip_is_canonical_and_normalizes_utc(database):
    database.handlers[LIST]["payload"].update(items=[ROW], next_cursor=CURSOR, has_more=True)
    service = BeltTestRecipientService(database)
    page = service.list_recipients(STUDIO, ACTOR, EVENT, limit=1)
    assert page.next_cursor == encoded(
        json.dumps(CURSOR, sort_keys=True, separators=(",", ":")).encode()
    )
    service.list_recipients(STUDIO, ACTOR, EVENT, limit=1, cursor=page.next_cursor)
    assert database.rpc_calls[-1][1]["p_cursor"] == CURSOR
    service.list_recipients(
        STUDIO, ACTOR, EVENT, cursor=encoded({**CURSOR, "created_at": "2020-10-01T05:00:00-07:00"})
    )
    assert database.rpc_calls[-1][1]["p_cursor"] == CURSOR


@pytest.mark.parametrize(
    "token",
    [
        "",
        "a",
        "!@#",
        "Zm9=",
        "x" * 513,
        "Zh",
        1,
        encoded(b"not json"),
        encoded(b"\xff"),
        encoded([]),
        encoded(None),
        encoded({}),
        encoded({"id": RECIPIENT}),
        encoded({"created_at": ROW["created_at"]}),
        encoded({**CURSOR, "extra": True}),
        encoded({**CURSOR, "created_at": "2020-10-01T12:00:00"}),
        encoded({**CURSOR, "created_at": 1601553600}),
        encoded({**CURSOR, "created_at": float("inf")}),
        encoded({**CURSOR, "id": "invalid"}),
        encoded(
            f'{{"created_at":"{ROW["created_at"]}","id":"{RECIPIENT}","id":"{OTHER}"}}'.encode()
        ),
    ],
)
def test_invalid_cursor_rejected_before_rpc(database, token):
    with pytest.raises(HTTPException) as error:
        BeltTestRecipientService(database).list_recipients(STUDIO, ACTOR, EVENT, cursor=token)
    assert (error.value.status_code, error.value.detail) == (422, INVALID_CURSOR_DETAIL)
    assert database.rpc_calls == []


@pytest.mark.parametrize("limit", [0, 101, True, "1", 1.0])
def test_invalid_service_limit_rejected_before_rpc(database, limit):
    with pytest.raises(HTTPException) as error:
        BeltTestRecipientService(database).list_recipients(STUDIO, ACTOR, EVENT, limit=limit)
    assert error.value.status_code == 422
    assert database.rpc_calls == []


@pytest.mark.parametrize(
    "payload",
    [
        PAGE["payload"],
        {"items": [ROW] * 101, "next_cursor": None, "has_more": False},
        {"items": (ROW,), "next_cursor": None, "has_more": False},
        {"items": [ROW], "next_cursor": CURSOR, "has_more": False},
        {"items": [ROW], "next_cursor": None, "has_more": True},
        {"items": [ROW], "next_cursor": None, "has_more": 0},
        {"items": [ROW], "next_cursor": {**CURSOR, "extra": True}, "has_more": True},
        {"items": [ROW], "next_cursor": {**CURSOR, "id": OTHER}, "has_more": True},
        {
            "items": [ROW],
            "next_cursor": {**CURSOR, "created_at": ROW["updated_at"]},
            "has_more": True,
        },
        {"items": [ROW], "next_cursor": {"id": RECIPIENT}, "has_more": True},
        {"items": [ROW], "next_cursor": encoded(CURSOR), "has_more": True},
        {"items": [], "next_cursor": CURSOR, "has_more": True},
        {"items": [{**ROW, "studio_id": OTHER}], "next_cursor": None, "has_more": False},
        {"items": [{**ROW, "event_id": OTHER}], "next_cursor": None, "has_more": False},
        {"items": [{**ROW, "revision": "3"}], "next_cursor": None, "has_more": False},
        {"items": [ROW], "has_more": False},
        {"items": [ROW], "next_cursor": None},
        {"items": [ROW], "next_cursor": None, "has_more": False, "extra": "private"},
    ],
)
def test_list_rejects_malformed_cursor_rows_or_page_bounds(database, payload):
    database.handlers[LIST] = {"payload": payload}
    assert_unavailable(
        lambda: BeltTestRecipientService(database).list_recipients(STUDIO, ACTOR, EVENT, limit=1)
    )
    assert database.execute_calls == [LIST]


@pytest.mark.parametrize(
    "envelope", [PAGE["payload"], {"message": PAGE["payload"]}, {**PAGE, "extra": True}, []]
)
def test_list_rejects_compatibility_envelopes(database, envelope):
    database.handlers[LIST] = envelope
    assert_unavailable(lambda: call_service(database, LIST))


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE, LIST])
@pytest.mark.parametrize(
    "code,message,status,detail",
    [
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403, ADMIN_REQUIRED_DETAIL),
        ("P0002", "AUTOMATION_NOT_FOUND", 404, "Belt-test event or recipient not found."),
        ("22023", "AUTOMATION_INVALID_REQUEST", 422, "Invalid belt-test recipient request."),
        (
            "P0001",
            "AUTOMATION_REVISION_CONFLICT",
            409,
            "The belt-test event or recipient changed. Reload it before saving.",
        ),
        (
            "P0001",
            "AUTOMATION_OPERATION_CONFLICT",
            409,
            "This belt-test recipient operation was already used for a different request.",
        ),
        (
            "P0001",
            "AUTOMATION_STATE_CONFLICT",
            409,
            "These belt-test recipients cannot be changed in their current state.",
        ),
        (
            "P0001",
            "AUTOMATION_STUDIO_BUSY",
            409,
            "The studio is busy. Try the belt-test recipient request again shortly.",
        ),
        ("42883", "missing private RPC", 503, UNAVAILABLE_DETAIL),
        ("PGRST202", "missing private RPC", 503, UNAVAILABLE_DETAIL),
        ("42501", "private permission error", 503, UNAVAILABLE_DETAIL),
        ("P0001", "unknown private error", 503, UNAVAILABLE_DETAIL),
        ("XX000", "AUTOMATION_NOT_FOUND", 503, UNAVAILABLE_DETAIL),
    ],
)
def test_only_exact_owned_error_pairs_have_safe_mapping(
    database, rpc, code, message, status, detail
):
    database.handlers[rpc] = APIError(
        {"code": code, "message": message, "details": "private detail", "hint": "private hint"}
    )
    with pytest.raises(HTTPException) as error:
        call_service(database, rpc)
    assert (error.value.status_code, error.value.detail) == (status, detail)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert database.execute_calls == [rpc]
    assert database.query_log == []


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE, LIST])
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_malformed_error_identity_returns_fixed_503_once(database, rpc, field, identity):
    database.handlers[rpc] = APIError(malformed_provider_error(field, identity))
    assert_unavailable(lambda: call_service(database, rpc))
    assert database.execute_calls == [rpc]
    assert database.query_log == []


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE, LIST])
@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("private timeout"),
        RuntimeError("private provider"),
        HTTPException(400, "private response"),
    ],
)
def test_client_failure_never_retries_or_reads_tables(database, rpc, failure):
    database.handlers[rpc] = failure
    assert_unavailable(lambda: call_service(database, rpc))
    assert database.execute_calls == [rpc]
    assert database.query_log == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_admin_success_checks_membership_then_entitlement_in_interactive_lane(
    api, method, path, body, rpc
):
    client, database, subscription, lane_calls, _ = api
    if rpc != LIST:
        database.handlers[rpc]["replayed"] = True
    response = client.request(method, path, json=body, headers={"X-Studio-Id": f" {STUDIO} "})
    assert response.status_code == 200
    assert response.json() == database.handlers[rpc]["payload"]
    assert lane_calls == ["interactive"]
    subscription.assert_called_once_with(database, STUDIO)
    assert database.execute_calls == [rpc]
    assert database.rpc_calls[0][1]["p_studio_id"] == STUDIO
    assert database.rpc_calls[0][1]["p_actor_id"] == ACTOR
    assert {query["table"] for query in database.query_log} == {"staff_roles"}


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
@pytest.mark.parametrize(
    "denial", ["front_desk", "instructor", "archived", "multiple", "foreign", "none"]
)
def test_http_membership_denial_precedes_entitlement_and_rpc(api, method, path, body, rpc, denial):
    client, database, subscription, _, _ = api
    membership = database.tables["staff_roles"][0]
    headers = {}
    expected = 403
    if denial in {"front_desk", "instructor"}:
        membership["role"] = denial
    elif denial == "archived":
        membership["archived_at"] = "2026-10-01"
    elif denial == "multiple":
        database.tables["staff_roles"].append({**membership, "studio_id": OTHER})
        expected = 409
    elif denial == "foreign":
        headers["X-Studio-Id"] = OTHER
    else:
        database.tables["staff_roles"] = []
        expected = 404
    response = client.request(method, path, json=body, headers=headers)
    assert response.status_code == expected
    if denial in {"front_desk", "instructor"}:
        assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    subscription.assert_not_called()
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
@pytest.mark.parametrize("status", [402, 503])
def test_http_entitlement_failure_precedes_rpc(api, method, path, body, rpc, status):
    client, database, subscription, _, _ = api
    subscription.side_effect = HTTPException(status, "Subscription unavailable")
    assert client.request(method, path, json=body).status_code == status
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_unauthenticated_request_has_no_membership_or_rpc_access(api, method, path, body, rpc):
    client, database, subscription, _, app = api
    app.dependency_overrides.pop(get_current_user_id)
    assert client.request(method, path, json=body).status_code == 401
    subscription.assert_not_called()
    assert database.query_log == []
    assert database.rpc_calls == []


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", BASE + "/bad/recipients", None),
        ("POST", BASE + "/bad/recipients/approve", APPROVAL),
        ("POST", BASE + f"/bad/recipients/{RECIPIENT}/revoke", REVOCATION),
        ("POST", RECIPIENTS_PATH + "/bad/revoke", REVOCATION),
        ("POST", APPROVE_PATH, {**APPROVAL, "recipients": []}),
        ("POST", APPROVE_PATH, {**APPROVAL, "expected_revision": 8}),
        (
            "POST",
            APPROVE_PATH,
            {**APPROVAL, "recipients": [{**SELECTION, "email": "spoof@example.invalid"}]},
        ),
        ("POST", REVOKE_PATH, {**REVOCATION, "expected_event_revision": 8}),
        ("POST", REVOKE_PATH, {**REVOCATION, "expected_revision": True}),
        ("GET", RECIPIENTS_PATH + "?limit=0", None),
        ("GET", RECIPIENTS_PATH + "?limit=101", None),
        ("GET", RECIPIENTS_PATH + "?cursor=" + "a" * 513, None),
        ("GET", RECIPIENTS_PATH + "?cursor=malformed", None),
    ],
)
def test_http_invalid_input_never_calls_rpc(api, method, path, body):
    client, database, _, _, _ = api
    assert client.request(method, path, json=body).status_code == 422
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_mocked_sql_authority_rejection_is_sanitized(api, method, path, body, rpc):
    client, database, _, _, _ = api
    database.handlers[rpc] = APIError(
        {"code": "42501", "message": "AUTOMATION_ADMIN_REQUIRED", "details": "private recipient"}
    )
    response = client.request(method, path, json=body)
    assert response.status_code == 403
    assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    assert database.execute_calls == [rpc]


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_http_malformed_error_identity_is_sanitized(api, method, path, body, rpc, field, identity):
    client, database, _, _, _ = api
    database.handlers[rpc] = APIError(malformed_provider_error(field, identity))
    response = client.request(method, path, json=body)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert database.execute_calls == [rpc]


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES[1:])
def test_http_timeout_after_mutation_keeps_504_and_never_resubmits(
    api, monkeypatch, method, path, body, rpc
):
    client, database, _, _, _ = api

    async def committed_before_lane_timeout(provider, operation, *, lane):
        assert lane == "interactive"
        operation(provider)
        raise HTTPException(504, "Shared provider operation timeout", headers={"Retry-After": "1"})

    monkeypatch.setattr(routes, "run_supabase_operation", committed_before_lane_timeout)
    response = client.request(method, path, json=body)
    assert response.status_code == 504
    assert response.headers["Retry-After"] == "1"
    assert response.json() == {"detail": "Shared provider operation timeout"}
    assert database.execute_calls == [rpc]


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_provider_timeout_is_sanitized(api, method, path, body, rpc):
    client, database, _, _, _ = api
    database.handlers[rpc] = httpx.ReadTimeout("private provider timeout")
    response = client.request(method, path, json=body)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert database.execute_calls == [rpc]


def test_composed_openapi_preserves_four_event_and_three_recipient_methods():
    app = FastAPI()
    app.include_router(event_routes.router, prefix="/api/v1")
    app.include_router(routes.router, prefix="/api/v1")
    schema = app.openapi()
    expected_paths = {
        BASE: {"get", "post"},
        BASE + "/{event_id}": {"get", "patch"},
        BASE + "/{event_id}/recipients": {"get"},
        BASE + "/{event_id}/recipients/approve": {"post"},
        BASE + "/{event_id}/recipients/{recipient_id}/revoke": {"post"},
    }
    assert {path: set(methods) for path, methods in schema["paths"].items()} == expected_paths
    models = schema["components"]["schemas"]
    assert set(models["BeltTestRecipientResponse"]["required"]) == set(ROW)
    for name in [
        "BeltTestRecipientResponse",
        "BeltTestRecipientSelection",
        "BeltTestRecipientApprove",
        "BeltTestRecipientRevoke",
        "BeltTestRecipientApprovalResponse",
        "BeltTestRecipientListResponse",
    ]:
        assert models[name]["additionalProperties"] is False
    assert set(models["BeltTestRecipientSelection"]["properties"]) == set(SELECTION)
    assert set(models["BeltTestRecipientApprove"]["properties"]) == set(APPROVAL)
    assert set(models["BeltTestRecipientRevoke"]["properties"]) == set(REVOCATION)
    assert models["BeltTestRecipientApprove"]["properties"]["recipients"]["minItems"] == 1
    assert models["BeltTestRecipientApprove"]["properties"]["recipients"]["maxItems"] == 100
    for path, response_model in [
        (BASE + "/{event_id}/recipients", "BeltTestRecipientListResponse"),
        (BASE + "/{event_id}/recipients/approve", "BeltTestRecipientApprovalResponse"),
        (BASE + "/{event_id}/recipients/{recipient_id}/revoke", "BeltTestRecipientResponse"),
    ]:
        method = next(iter(schema["paths"][path].values()))
        assert method["responses"]["200"]["content"]["application/json"]["schema"] == {
            "$ref": f"#/components/schemas/{response_model}"
        }
        assert all(
            parameter["schema"]["format"] == "uuid"
            for parameter in method["parameters"]
            if parameter["in"] == "path"
        )


class SyntheticPostgrestClient(SyncPostgrestClient):
    def __init__(self, handler):
        self.handler = handler
        super().__init__("https://synthetic.invalid/rest/v1")

    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            transport=httpx.MockTransport(self.handler),
            trust_env=False,
        )


@pytest.mark.parametrize(
    "rpc,envelope", [(APPROVE, APPROVAL_RECEIPT), (REVOKE, REVOCATION_RECEIPT), (LIST, PAGE)]
)
def test_pinned_postgrest_parses_exact_payload_envelopes_without_network(rpc, envelope):
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=envelope)

    with SyntheticPostgrestClient(handler) as database:
        result = call_service(database, rpc)
    assert result.model_dump(mode="json") == (envelope["payload"] if rpc == LIST else envelope)
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{rpc}"
    request = json.loads(requests[0].content)
    assert request["p_studio_id"] == STUDIO
    assert request["p_actor_id"] == ACTOR
    assert request["p_event_id"] == EVENT
    assert "p_request" not in request
    if rpc == APPROVE:
        assert request["p_recipients"] == [SELECTION]
        assert request["p_expected_event_revision"] == 8
    elif rpc == REVOKE:
        assert request["p_recipient_id"] == RECIPIENT
        assert request["p_expected_revision"] == 2


@pytest.mark.parametrize("rpc", [APPROVE, REVOKE, LIST])
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_pinned_postgrest_malformed_error_identity_is_unavailable(rpc, field, identity):
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(503, json=malformed_provider_error(field, identity))

    with SyntheticPostgrestClient(handler) as database:
        error = assert_unavailable(lambda: call_service(database, rpc))
    assert isinstance(error.__context__, APIError)
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{rpc}"
