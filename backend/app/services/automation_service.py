"""Admin operations and bounded dispatch of the SQL-owned automation outbox."""

from __future__ import annotations

import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Protocol
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException
from postgrest._sync.request_builder import SyncRPCFilterRequestBuilder
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from pydantic import BaseModel, ValidationError

from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas import workflow_dispatch as dispatch
from app.schemas.automation import (
    MissedClassActivityResponse,
    MissedClassPreviewRequest,
    MissedClassPreviewResponse,
    MissedClassProcessResponse,
    MissedClassRuleResponse,
    MissedClassRuleUpdate,
    MissedClassSettingsResponse,
)
from app.services import workflow_capabilities
from app.services.automation_email import (
    DeliveryResult,
    EmailMessage,
    build_email_transport,
    delivery_configuration,
    email_delivery_status,
    normalize_email_address,
    render_missed_class_email,
    sender_identity_binding,
)
from app.services.automation_email_credentials import PROVIDER_KEY
from app.services.automation_sender_status import observe_email_delivery_status
from app.services.microsoft_graph_email import PreparedEmailSender
from app.services.studio_scope import get_platform_subscription_access

WORK_BUDGET_SECONDS = 25.0
DATABASE_TIMEOUT_SECONDS = 5.0
SETTLEMENT_RESERVE_SECONDS = 5.0
ADMIN_REQUIRED_DETAIL = "Only studio admins can manage automations."
UNAVAILABLE_DETAIL = "Automations are temporarily unavailable. Try again shortly."


def _rpc(client: Any, name: str, params: dict) -> dict:
    data = client.rpc(name, params).execute().data
    if not isinstance(data, dict):
        raise TypeError("invalid_automation_result")
    return data


class AutomationService:
    def __init__(self, supabase: Any, settings: Any):
        self.supabase = supabase
        self.settings = settings

    def _call(self, name: str, params: dict) -> dict:
        try:
            return _rpc(self.supabase, name, params)
        except APIError as exc:
            if exc.code == "P0001" and exc.message == "AUTOMATION_RULE_CONFLICT":
                raise HTTPException(
                    409, "This automation changed. Reload it before saving."
                ) from None
            if exc.code == "42501":
                raise HTTPException(403, ADMIN_REQUIRED_DETAIL) from None
            if exc.code == "22023":
                raise HTTPException(422, "Invalid automation settings.") from None
            # Busy/missing RPCs and unexpected database errors disclose no SQL text.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
        except Exception:  # noqa: BLE001 - Keep SQL failures private.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    @staticmethod
    def _response(model: type[BaseModel], data: dict) -> Any:
        try:
            return model.model_validate(data)
        except ValidationError:
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def _settings_response(self, rule: dict | None, delivery_status: dict):
        if rule is None:
            rule = MissedClassRuleResponse(
                reply_to_email=self.settings.EMAIL_REPLY_TO or self.settings.EMAIL_FROM_ADDRESS,
                updated_at=None,
            ).model_dump()
        elif not set(MissedClassRuleResponse.model_fields).issubset(rule):
            raise HTTPException(503, UNAVAILABLE_DETAIL)
        return self._response(
            MissedClassSettingsResponse, {"rule": rule, "delivery_status": delivery_status}
        )

    def get_rule(self, studio_id: str, actor_id: str) -> MissedClassSettingsResponse:
        result = self._call(
            "get_missed_class_automation_rule_v1",
            {"p_studio_id": studio_id, "p_actor_id": actor_id},
        )
        if "rule" not in result or (
            result["rule"] is not None and not isinstance(result["rule"], dict)
        ):
            raise HTTPException(503, UNAVAILABLE_DETAIL)
        return self._settings_response(
            result["rule"],
            observe_email_delivery_status(self.settings, self.supabase).delivery_status,
        )

    def save_rule(
        self, studio_id: str, actor_id: str, data: MissedClassRuleUpdate
    ) -> MissedClassSettingsResponse:
        delivery_status = observe_email_delivery_status(
            self.settings, self.supabase
        ).delivery_status
        if data.enabled and delivery_status.get("can_enable") is not True:
            raise HTTPException(
                409, "Email delivery must be ready before enabling this automation."
            )
        result = self._call(
            "save_missed_class_automation_rule_v1",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                **{"p_" + key: value for key, value in data.model_dump().items()},
            },
        )
        if not isinstance(result.get("rule"), dict):
            raise HTTPException(503, UNAVAILABLE_DETAIL)
        return self._settings_response(result["rule"], delivery_status)

    def preview(
        self, studio_id: str, actor_id: str, data: MissedClassPreviewRequest
    ) -> MissedClassPreviewResponse:
        result = self._call(
            "preview_missed_class_automation_v1",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_inactivity_days": data.inactivity_days,
            },
        )
        rows = result.get("recipients")
        if not isinstance(rows, list):
            raise HTTPException(503, UNAVAILABLE_DETAIL)
        rendered = []
        for row in rows[:100]:
            if not isinstance(row, dict):
                raise HTTPException(503, UNAVAILABLE_DETAIL)
            recipient = {**row, "rendered_subject": None, "rendered_body": None}
            if row.get("skip_reason") is None:
                try:
                    content = render_missed_class_email(
                        data.subject_template, data.body_template, row
                    )
                except ValueError:
                    raise HTTPException(
                        422, "These templates cannot be rendered for the selected recipients."
                    ) from None
                recipient.update(rendered_subject=content.subject, rendered_body=content.text_body)
            rendered.append(recipient)
        return self._response(
            MissedClassPreviewResponse,
            {
                **result,
                "recipients": rendered,
                "truncated": result.get("truncated") or len(rows) > 100,
            },
        )

    def activity(self, studio_id: str, actor_id: str, limit: int) -> MissedClassActivityResponse:
        return self._response(
            MissedClassActivityResponse,
            self._call(
                "get_missed_class_automation_activity_v1",
                {"p_studio_id": studio_id, "p_actor_id": actor_id, "p_limit": limit},
            ),
        )

    def suppress(self, token: str) -> None:
        self._call("suppress_missed_class_automation_v1", {"p_token": token})


class _BudgetExhausted(Exception):
    pass


class _WorkerBudget:
    def __init__(self, deadline: float, clock: Callable[[], float]):
        self.deadline = deadline
        self.clock = clock
        self.reserve = SETTLEMENT_RESERVE_SECONDS

    def check(self, seconds: float = 0.0) -> None:
        now = self.clock()
        if (
            not math.isfinite(now)
            or not math.isfinite(self.deadline)
            or self.deadline - now <= self.reserve + seconds
        ):
            raise _BudgetExhausted


class _BudgetQuery:
    """Guard every execute, including queries inside entitlement/credential owners."""

    def __init__(self, query: Any, budget: _WorkerBudget):
        self.query = query
        self.budget = budget

    def __getattr__(self, name: str):
        method = getattr(self.query, name)

        def chained(*args, **kwargs):
            return _BudgetQuery(method(*args, **kwargs), self.budget)

        return chained

    def execute(self):
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        return self.query.execute()


def _validate_begin_response(data: Any, delivery_id: str) -> dict:
    if (
        not isinstance(data, dict)
        or set(data) != {"ready", "state", "reason", "message"}
        or type(data["ready"]) is not bool
        or (data["state"] is not None and not isinstance(data["state"], str))
        or (data["reason"] is not None and not isinstance(data["reason"], str))
    ):
        raise RuntimeError("invalid_automation_begin_response")
    message = data["message"]
    if data["ready"] is False:
        if message is not None:
            raise RuntimeError("invalid_automation_begin_response")
        return data
    string_fields = {
        "delivery_id",
        "attempt_id",
        "student_first_name",
        "studio_name",
        "recipient_email",
        "subject_template",
        "body_template",
        "reply_to_email",
        "unsubscribe_token",
    }
    if (
        data["state"] != "sending"
        or data["reason"] is not None
        or not isinstance(message, dict)
        or set(message) != string_fields | {"days_absent"}
        or any(not isinstance(message[key], str) for key in string_fields)
        or type(message["days_absent"]) is not int
        or message["delivery_id"] != delivery_id
    ):
        raise RuntimeError("invalid_automation_begin_response")
    return data


class _BeginRPCQuery:
    """Bypass only postgrest 0.17.2's erroneous `message` API-error validator."""

    def __init__(self, query: SyncRPCFilterRequestBuilder, budget: _WorkerBudget, delivery_id: str):
        self.query = query
        self.budget = budget
        self.delivery_id = delivery_id

    def execute(self):
        query = self.query
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        response = query.session.request(
            query.http_method,
            query.path,
            json=query.json,
            params=query.params,
            headers=query.headers,
            follow_redirects=False,
        )
        # Do not infer success from an error body or submit again through execute.
        if not 200 <= response.status_code < 300:
            raise RuntimeError("invalid_automation_begin_response")
        try:
            data = response.json()
        except ValueError:
            raise RuntimeError("invalid_automation_begin_response") from None
        return SimpleNamespace(data=_validate_begin_response(data, self.delivery_id))


class _WorkerClient:
    def __init__(self, client: Any, budget: _WorkerBudget):
        self.client = client
        self.budget = budget

    @staticmethod
    def _worker_query(query: Any):
        session = getattr(query, "session", None)
        if isinstance(session, SyncClient):
            # This dedicated worker lane must not replay a mutation or forward
            # its service key to a redirected endpoint. Keep ordinary SDK parsing.
            session.follow_redirects = False
        return query

    def rpc(self, name: str, params: dict):
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        query = self._worker_query(self.client.rpc(name, params))
        if name == "begin_missed_class_automation_v1" and isinstance(
            query, SyncRPCFilterRequestBuilder
        ):
            return _BeginRPCQuery(query, self.budget, params["p_delivery_id"])
        return _BudgetQuery(query, self.budget)

    def table(self, name: str):
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        return _BudgetQuery(self._worker_query(self.client.table(name)), self.budget)


def _message(snapshot: dict, config: Any) -> EmailMessage:
    recipient = normalize_email_address(snapshot["recipient_email"])
    if config.allowed_recipients and recipient not in config.allowed_recipients:
        raise ValueError("recipient_not_allowed")
    content = render_missed_class_email(
        snapshot["subject_template"],
        snapshot["body_template"],
        snapshot,
        config.public_api_url + "/automations/unsubscribe#" + snapshot["unsubscribe_token"],
    )
    return EmailMessage(
        to_address=recipient,
        subject=content.subject,
        text_body=content.text_body,
        html_body=content.html_body,
        reply_to=normalize_email_address(snapshot["reply_to_email"]),
        # Graph requires UUID correlation. This stable mapping is not an idempotency key.
        attempt_id=str(
            uuid5(
                NAMESPACE_URL,
                "urn:koaryu:automations:missed-class:attempt:" + snapshot["attempt_id"],
            )
        ),
    )


def _dispatch_rpc(client: Any, name: str, request: dispatch.DispatchModel, result_type):
    """Parse payload through the installed SDK and verify every request identity echo."""
    try:
        data = client.rpc(name, request.model_dump(mode="json")).execute().data
        result = dispatch.Envelope[result_type].model_validate(data).payload
        for key in (
            "studio_id",
            "run_id",
            "claim_token",
            "node_id",
            "attempt_id",
            "delivery_id",
            "preparation_id",
        ):
            if (
                hasattr(result, key)
                and hasattr(request, "p_" + key)
                and getattr(result, key) != getattr(request, "p_" + key)
            ):
                raise ValueError("invalid_dispatch_identity")
        if (
            isinstance(request, (dispatch.SettleRequest, dispatch.LegacySettleRequest))
            and result.updated
        ):
            permitted = {
                "accepted": {"accepted", "unknown"},
                "retryable_failure": {"failed", "retry_wait", "unknown"},
                "permanent_failure": {"failed", "retry_wait", "unknown"},
                "unknown": {"unknown"},
            }[request.p_result.outcome]
            if result.state not in permitted:
                raise ValueError("inconsistent_dispatch_settlement_truth")
        if isinstance(result, dispatch.Claims) and len(result.claims) > request.p_limit:
            raise ValueError("invalid_dispatch_claim_count")
        return result
    except _BudgetExhausted:
        raise
    except Exception:  # noqa: BLE001 - No raw SQL/SDK diagnostics escape this boundary.
        raise ValueError("invalid_automation_dispatch_result") from None


def _require_dispatch_schema(client: Any, budget: _WorkerBudget) -> None:
    budget.check(DATABASE_TIMEOUT_SECONDS)
    ready = workflow_capabilities._schema_ready(client)
    # Readiness deliberately swallows database exceptions, including budget exits.
    budget.check(DATABASE_TIMEOUT_SECONDS)
    if not ready:
        raise ValueError("automation_schema_unavailable")


def _delivery_result(result: Any, *, expected_revision: int | None = None) -> dispatch.Delivery:
    """Keep observed truth; malformed or unproved submission metadata is unknown."""
    values = (
        {key: getattr(result, key, None) for key in dispatch.Delivery.model_fields}
        if isinstance(result, DeliveryResult)
        else {}
    )
    revision = values.get("credential_revision")
    safe_revision = revision if type(revision) is int and 0 < revision < 2**63 else None
    request_id = values.get("provider_request_id")
    safe_request_id = (
        request_id
        if type(request_id) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", request_id)
        else None
    )
    values["provider_request_id"] = safe_request_id
    code = values.get("error_code")
    if values.get("outcome") == "accepted":
        values["error_code"] = None
    elif type(code) is not str or code not in dispatch.TRANSPORT_CODES:
        values["error_code"] = "provider_unavailable"
    try:
        parsed = dispatch.Delivery.model_validate(values)
        if (
            safe_revision is not None
            and expected_revision is not None
            and safe_revision != expected_revision
        ):
            raise ValueError("different_used_revision")
        if parsed.outcome != "unknown":
            return parsed
    except (TypeError, ValueError):
        pass
    return dispatch.Delivery(
        outcome="unknown",
        error_code="provider_submission_unknown",
        provider_request_id=safe_request_id,
        retry_after_seconds=None,
        submission_evidence="unknown",
        failure_scope="unclassified",
        credential_revision=safe_revision
        if expected_revision is None or safe_revision == expected_revision
        else None,
    )


class _PreparationGrant(Protocol):
    allowed: bool
    preparation_id: UUID
    preparation_token: UUID | None
    probe_token: UUID | None
    generation: int
    lease_expires_at: datetime | None


@dataclass(frozen=True)
class _PreparedGrant:
    handle: PreparedEmailSender = field(repr=False)
    claim: _PreparationGrant = field(repr=False)

    def params(self) -> dict:
        return {
            "p_preparation_id": self.claim.preparation_id,
            "p_preparation_token": self.claim.preparation_token,
            "p_probe_token": self.claim.probe_token,
        }


def _prepare_sender(
    client: Any, budget: _WorkerBudget, transport: Any, config: Any
) -> _PreparedGrant | None:
    binding = sender_identity_binding(config)
    claim = _dispatch_rpc(
        client,
        "claim_automation_sender_preparation_v1",
        dispatch.PreparationClaimRequest(
            p_provider_key=PROVIDER_KEY,
            p_preparation_id=uuid4(),
            p_sender_binding=binding,
        ),
        dispatch.PreparationClaim,
    )
    return _complete_sender_preparation(client, budget, transport, binding, claim)


def _complete_sender_preparation(
    client: Any,
    budget: _WorkerBudget,
    transport: Any,
    binding: str,
    claim: _PreparationGrant,
) -> _PreparedGrant | None:
    """Complete an already validated normal or test-owned preparation grant."""
    if (
        claim.allowed is not True
        or claim.preparation_token is None
        or claim.lease_expires_at is None
    ):
        return None
    budget.check(DATABASE_TIMEOUT_SECONDS)
    try:
        prepared = transport.prepare(deadline=budget.deadline - SETTLEMENT_RESERVE_SECONDS)
    except _BudgetExhausted:
        raise
    except Exception:  # noqa: BLE001 - Preparation is never a submission.
        prepared = None
    budget.check(DATABASE_TIMEOUT_SECONDS)
    if isinstance(prepared, PreparedEmailSender):
        evidence = dispatch.PreparationResult(
            outcome="prepared",
            credential_revision=prepared.envelope.revision,
            sender_binding=binding,
            safe_reason=None,
            retry_after_seconds=None,
        )
        if prepared.sender_binding != binding:
            raise ValueError("invalid_prepared_sender_binding")
    else:
        failure = _delivery_result(prepared)
        proven = failure.submission_evidence == "not_submitted" and failure.failure_scope in {
            "sender_auth",
            "sender_transient",
        }
        evidence = dispatch.PreparationResult(
            outcome="sender_auth"
            if proven and failure.failure_scope == "sender_auth"
            else "sender_transient",
            credential_revision=None,
            sender_binding=binding,
            safe_reason=failure.error_code
            if proven and failure.error_code
            else "provider_unavailable",
            retry_after_seconds=failure.retry_after_seconds
            if proven
            and failure.retry_after_seconds is not None
            and failure.retry_after_seconds <= 3600
            else None,
        )
    settled = _dispatch_rpc(
        client,
        "settle_automation_sender_preparation_v1",
        dispatch.PreparationSettleRequest(
            p_preparation_id=claim.preparation_id,
            p_preparation_token=claim.preparation_token,
            p_result=evidence,
        ),
        dispatch.PreparationSettled,
    )
    if settled.outcome != "prepared":
        return None
    if not isinstance(prepared, PreparedEmailSender) or any(
        getattr(settled, key) != getattr(claim, key)
        for key in ("generation", "preparation_token", "probe_token", "lease_expires_at")
    ):
        raise ValueError("invalid_preparation_settlement")
    return _PreparedGrant(prepared, claim)


def _stop_dispatch(result: DeliveryResult) -> bool:
    # Throttling, connectivity and credential outages must not spend a batch of
    # claims. Graph 403 also shares provider_rejected with recipient 4xx.
    return result.outcome != "accepted"


def _has_more(result: dict) -> bool:
    value = result.get("has_more")
    if type(value) is not bool:
        raise ValueError("invalid_automation_actionable_result")
    return value


def _validate_deferral(result: dict) -> None:
    if (
        result.get("updated") is not True
        or result.get("state") not in {"queued", "retry_wait"}
        or not isinstance(result.get("dispatch_deferred_until"), str)
    ):
        raise ValueError("unconfirmed_automation_deferral")
    deferred_until = datetime.fromisoformat(result["dispatch_deferred_until"])
    if deferred_until.utcoffset() is None:
        raise ValueError("invalid_automation_deferral_time")


def process_due_missed_class_automations(
    settings: Any,
    *,
    limit: int = 10,
    deadline_monotonic: float | None = None,
    clock: Callable[[], float] | None = None,
    client_factory: Callable[..., Any] | None = None,
    client_closer: Callable[[Any], None] | None = None,
    transport_factory: Callable[..., Any] | None = None,
) -> MissedClassProcessResponse:
    """Admit work for 25s; in-flight I/O may finish later and is never blindly retried.

    The private client's finite timeout bounds each database operation. An earlier
    provider deadline reserves settlement time. Lost sending leases become unknown
    in SQL, including when cancellation or a late I/O completion prevents settling.
    """
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError("invalid_automation_limit")
    counts = MissedClassProcessResponse().model_dump()
    if (
        getattr(settings, "AUTOMATION_WORKER_ENABLED", False) is not True
        or getattr(settings, "EMAIL_SEND_ENABLED", False) is not True
        or getattr(settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
    ):
        return MissedClassProcessResponse(**counts)
    clock = clock or time.monotonic
    started = clock()
    deadline = started + WORK_BUDGET_SECONDS
    if deadline_monotonic is not None:
        if not math.isfinite(deadline_monotonic):
            raise ValueError("invalid_automation_deadline")
        deadline = min(deadline, deadline_monotonic)
    budget = _WorkerBudget(deadline, clock)
    raw_client = None
    try:
        budget.check(DATABASE_TIMEOUT_SECONDS)
        config = delivery_configuration(settings)
        budget.check(DATABASE_TIMEOUT_SECONDS)
        raw_client = (client_factory or create_supabase_client)(
            postgrest_client_timeout=DATABASE_TIMEOUT_SECONDS
        )
        client = _WorkerClient(raw_client, budget)
        _require_dispatch_schema(client, budget)
        budget.check(DATABASE_TIMEOUT_SECONDS)
        if email_delivery_status(settings, client).get("configured") is not True:
            return MissedClassProcessResponse(**counts)
        budget.check()
        transport = (transport_factory or build_email_transport)(settings, client)
        allowed = sorted(config.allowed_recipients)
        enqueued = _rpc(
            client,
            "enqueue_missed_class_automations_v1",
            {"p_limit": limit, "p_allowed_recipients": allowed},
        )
        if type(enqueued.get("enqueued")) is not int or not 0 <= enqueued["enqueued"] <= limit:
            raise ValueError("invalid_automation_result")
        counts["enqueued"] = enqueued["enqueued"]
        counts["has_more"] = _has_more(enqueued)
        deferral_reason_by_studio: dict[str, str | None] = {}
        for _ in range(limit):
            claimed = _rpc(
                client,
                "claim_missed_class_automations_v1",
                {"p_limit": 1, "p_allowed_recipients": allowed},
            )
            counts["has_more"] = _has_more(claimed)
            items = claimed.get("items")
            if not isinstance(items, list) or len(items) > 1:
                raise ValueError("invalid_automation_claim")
            if not items:
                break
            claim = items[0]
            studio_id = claim["studio_id"]
            identity = {"p_delivery_id": claim["id"], "p_claim_token": claim["claim_token"]}
            if studio_id not in deferral_reason_by_studio:
                budget.check(DATABASE_TIMEOUT_SECONDS)
                try:
                    access = get_platform_subscription_access(
                        client, studio_id, allow_provider_repairs=False
                    )
                except HTTPException as exc:
                    # A deadline error can be wrapped by the entitlement owner.
                    budget.check(DATABASE_TIMEOUT_SECONDS)
                    if exc.status_code != 503:
                        raise
                    deferral_reason_by_studio[studio_id] = "unavailable"
                else:
                    deferral_reason_by_studio[studio_id] = (
                        None
                        if access.get("subscription_required") is False
                        else "subscription_required"
                    )
            budget.check(DATABASE_TIMEOUT_SECONDS)
            deferral_reason = deferral_reason_by_studio[studio_id]
            if deferral_reason is not None:
                deferred = _rpc(
                    client,
                    "defer_missed_class_automation_studio_v1",
                    {**identity, "p_reason": deferral_reason, "p_allowed_recipients": allowed},
                )
                # A lost or refused write stops through the existing safe 503
                # boundary. No provider attempt happened and none is invented.
                _validate_deferral(deferred)
                counts["has_more"] = _has_more(deferred)
                counts["processed"] += 1
                counts["skipped"] += 1
                continue
            prepared = _prepare_sender(client, budget, transport, config)
            if prepared is None:
                deferred = _rpc(
                    client,
                    "defer_missed_class_automation_studio_v1",
                    {
                        **identity,
                        "p_reason": "unavailable",
                        "p_allowed_recipients": allowed,
                    },
                )
                _validate_deferral(deferred)
                counts["has_more"] = _has_more(deferred)
                counts["processed"] += 1
                counts["skipped"] += 1
                break
            try:
                begun = _dispatch_rpc(
                    client,
                    "begin_missed_class_automation_v2",
                    dispatch.LegacyBeginRequest(
                        **identity,
                        **prepared.params(),
                        p_allowed_recipients=allowed,
                    ),
                    dispatch.LegacyBegun,
                )
                if begun.ready and (
                    begun.credential_revision != prepared.handle.envelope.revision
                    or begun.sender_binding != prepared.handle.sender_binding
                ):
                    raise ValueError("invalid_legacy_prepared_identity")
            except _BudgetExhausted:
                raise
            except Exception:  # noqa: BLE001 - A lost response can hide a committed begin.
                counts["processed"] += 1
                counts["unknown"] += 1
                break
            if not begun.ready:
                disposition = "unknown" if begun.state in {"unknown", "sending"} else "skipped"
                counts["processed"] += 1
                counts[disposition] += 1
                if disposition == "unknown":
                    break
                continue
            try:
                budget.check()
                message = _message(begun.message.model_dump(mode="json"), config)
                budget.check()
            except _BudgetExhausted:
                result = DeliveryResult(
                    "retryable_failure",
                    "send_budget_exhausted",
                    submission_evidence="not_submitted",
                    failure_scope="sender_transient",
                )
            except (KeyError, TypeError, ValueError):
                result = DeliveryResult(
                    "permanent_failure",
                    "invalid_message",
                    submission_evidence="not_submitted",
                    failure_scope="message",
                )
            else:
                try:
                    result = transport.send_prepared(
                        message, prepared.handle, deadline=deadline - SETTLEMENT_RESERVE_SECONDS
                    )
                except Exception:  # noqa: BLE001 - Submission may already have happened.
                    result = None
            result = _delivery_result(result, expected_revision=prepared.handle.envelope.revision)
            budget.reserve = 0.0
            try:
                settled = _dispatch_rpc(
                    client,
                    "settle_missed_class_automation_v2",
                    dispatch.LegacySettleRequest(
                        **identity,
                        p_attempt_id=begun.attempt_id,
                        p_result=result,
                    ),
                    dispatch.LegacySettled,
                )
                disposition = settled.state if settled.updated else "unknown"
            except Exception:  # noqa: BLE001 - Never resend after uncertain settlement.
                disposition = "unknown"
            finally:
                budget.reserve = SETTLEMENT_RESERVE_SECONDS
            counts["processed"] += 1
            counts[disposition] += 1
            if disposition in {"unknown", "failed"} or _stop_dispatch(result):
                break
    except _BudgetExhausted:
        pass
    except Exception:  # noqa: BLE001 - Sanitize faults at the worker boundary.
        # No retries on database/runtime errors. A safe error stops the cron bridge.
        raise HTTPException(503, UNAVAILABLE_DETAIL) from None
    finally:
        if raw_client is not None:
            try:
                (client_closer or close_supabase_client)(raw_client)
            except Exception:  # noqa: BLE001, S110 - Never log secret-bearing client exceptions.
                # The closer attempts all initialized sessions before raising.
                # Cleanup failure must not erase a recorded provider disposition.
                pass
    return MissedClassProcessResponse(**counts)
