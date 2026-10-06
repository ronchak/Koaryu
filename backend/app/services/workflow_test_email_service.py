"""One foreground synthetic execution; SQL alone owns scopes and send authority."""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import BeforeValidator, Field, StrictBool, model_validator

from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas import workflow_dispatch as dispatch
from app.schemas.trial_appointment import Revision, UTCInstant
from app.schemas.workflow import WorkflowGraph
from app.schemas.workflow_run import GraphId, TriggerEvent
from app.schemas.workflow_test_email import (
    WorkflowTestEmailAcknowledgment,
    WorkflowTestEmailRequest,
    WorkflowTestEmailResponse,
)
from app.services.automation_email import (
    DeliveryResult,
    SyntheticTestEmailMessage,
    assemble_synthetic_test_email,
    build_email_transport,
    delivery_configuration,
    email_delivery_status,
    sender_identity_binding,
)
from app.services.automation_service import (
    DATABASE_TIMEOUT_SECONDS,
    SETTLEMENT_RESERVE_SECONDS,
    WORK_BUDGET_SECONDS,
    _BudgetExhausted,
    _complete_sender_preparation,
    _delivery_result,
    _require_dispatch_schema,
    _WorkerBudget,
    _WorkerClient,
)
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)
from app.services.workflow_catalog import CATALOG
from app.services.workflow_email import WorkflowEmailRenderError, render_workflow_email
from app.services.workflow_graph import validate_workflow_graph
from app.services.workflow_management_service import (
    _ERRORS,
    ADMIN_REQUIRED_DETAIL,
    UNAVAILABLE_DETAIL,
)
from app.services.workflow_simulation_service import build_synthetic_workflow_facts

CREATE = "create_automation_test_email_v1"
PREPARE = "claim_automation_test_sender_preparation_v1"
FINISH = "finish_automation_test_email_preflight_v1"
BEGIN = "begin_automation_test_email_v1"
SETTLE = "settle_automation_test_email_v1"
CURRENT = "get_automation_test_email_v1"


def _uuid(value: object) -> UUID:
    if type(value) is UUID:
        return value
    if type(value) is not str:
        raise ValueError("invalid_test_identity")
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError("invalid_test_identity")
    return parsed


Identity = Annotated[UUID, BeforeValidator(_uuid)]
Mailboxes = Annotated[list[dispatch.Mailbox], Field(strict=True)]
FailureReason = Literal[
    "invalid_email_template",
    "invalid_email_context",
    "unsupported_currency",
    "invalid_email_url",
    "facts_unavailable",
    "sender_unavailable",
    "subscription_required",
    "recipient_changed",
    "recipient_suppressed",
    "lease_expired",
    "budget_exhausted",
]


class _Result(WorkflowTestEmailResponse):
    operation_id: Identity
    test_delivery_id: Identity

    def __repr_args__(self):
        return iter(())


class _Acknowledgment(WorkflowTestEmailAcknowledgment):
    operation_id: Identity
    test_delivery_id: Identity

    def __repr_args__(self):
        return iter(())


class Runtime(dispatch.DispatchModel):
    sender_binding: dispatch.Hex64
    default_reply_to: dispatch.Mailbox
    allowed_recipients: Mailboxes

    @model_validator(mode="after")
    def normalized_allowlist(self):
        if self.allowed_recipients != sorted(set(self.allowed_recipients)):
            raise ValueError("invalid_test_allowlist")
        return self


class TriggerContext(dispatch.DispatchModel):
    program_id: Identity | None
    offset_minutes: Annotated[int, Field(strict=True, ge=-129600, le=-1)] | None


class Execution(dispatch.DispatchModel):
    execution_token: Identity
    lease_expires_at: UTCInstant
    scope_fingerprint: dispatch.Hex64
    reference_time: UTCInstant
    event_type: TriggerEvent
    trigger_context: TriggerContext
    email_node_id: GraphId
    recipient_policy: dispatch.RecipientPolicy
    subject_template: Annotated[dispatch.Text, Field(max_length=200)]
    body_template: Annotated[dispatch.Text, Field(max_length=5000)]
    recipient_email: dispatch.Mailbox
    reply_to: dispatch.Mailbox

    @model_validator(mode="after")
    def consistent_context(self):
        trigger = CATALOG["triggers"][self.event_type]
        context = self.trigger_context
        if (
            self.recipient_policy not in trigger["recipient_ids"]
            or trigger["supports_offset"] != (context.offset_minutes is not None)
            or (not trigger["supports_program_filter"] and context.program_id is not None)
            or self.lease_expires_at <= self.reference_time
        ):
            raise ValueError("invalid_test_context")
        return self


class Reserved(dispatch.DispatchModel):
    studio_id: Identity
    actor_id: Identity
    workflow_id: Identity
    result: _Acknowledgment
    replayed: StrictBool
    execution: Execution | None

    @model_validator(mode="after")
    def fresh_only(self):
        if self.replayed != (self.execution is None):
            raise ValueError("invalid_test_execution_grant")
        return self


class PreparationClaim(dispatch.PreparationFields):
    studio_id: Identity
    test_delivery_id: Identity
    preparation_id: Identity
    preparation_token: Identity | None
    probe_token: Identity | None
    allowed: StrictBool
    mode: Literal["ready", "cooldown", "auth_blocked"]

    @model_validator(mode="after")
    def test_grant(self):
        self.check_grant(self.allowed)
        if self.allowed and (self.probe_token is not None) != (self.mode != "ready"):
            raise ValueError("invalid_test_preparation_mode")
        return self


class Finished(dispatch.DispatchModel):
    studio_id: Identity
    test_delivery_id: Identity
    updated: StrictBool
    replayed: StrictBool
    result: _Result | None

    @model_validator(mode="after")
    def consistent_finish(self):
        if (
            self.updated != (self.result is not None)
            or (not self.updated and self.replayed)
            or (self.result is not None and self.result.state != "failed")
        ):
            raise ValueError("invalid_test_finish")
        return self


class Rendered(dispatch.DispatchModel):
    subject: Annotated[dispatch.Text, Field(max_length=207)]
    text_body: Annotated[dispatch.Text, Field(max_length=20046)]
    html_body: Annotated[dispatch.Text, Field(max_length=120317)]

    @model_validator(mode="after")
    def exact_synthetic_profile(self):
        if not self.subject.startswith("[Test] ") or not self.text_body.startswith(
            "Synthetic automation test. Sample data only.\n\n"
        ):
            raise ValueError("invalid_test_label")
        content = assemble_synthetic_test_email(self.subject[7:], self.text_body[46:])
        if any(getattr(self, key) != getattr(content, key) for key in Rendered.model_fields):
            raise ValueError("invalid_test_content")
        return self


class Message(Rendered):
    attempt_id: Identity
    to_address: dispatch.Mailbox
    reply_to: dispatch.Mailbox


class Attempt(dispatch.DispatchModel):
    id: Identity
    lease_expires_at: UTCInstant
    credential_revision: Revision
    sender_binding: dispatch.Hex64
    message: Message

    @model_validator(mode="after")
    def same_attempt(self):
        if self.id != self.message.attempt_id:
            raise ValueError("invalid_test_attempt_identity")
        return self


class Begun(dispatch.DispatchModel):
    studio_id: Identity
    test_delivery_id: Identity
    outcome: Literal["begun", "already_begun", "stopped", "lease_lost"]
    result: _Result | None
    attempt: Attempt | None

    @model_validator(mode="after")
    def consistent_begin(self):
        states = {
            "begun": {"sending"},
            "already_begun": {"sending", "accepted", "failed", "unknown"},
            "stopped": {"failed"},
        }
        if (
            (self.outcome == "begun") != (self.attempt is not None)
            or (self.outcome == "lease_lost") != (self.result is None)
            or (
                self.result is not None and self.result.state not in states.get(self.outcome, set())
            )
        ):
            raise ValueError("invalid_test_begin")
        return self


class Settled(dispatch.DispatchModel):
    studio_id: Identity
    test_delivery_id: Identity
    attempt_id: Identity
    updated: StrictBool
    replayed: StrictBool
    state: Literal["accepted", "failed", "unknown"] | None
    result: _Result | None

    @model_validator(mode="after")
    def consistent_settlement(self):
        if (
            self.updated != (self.state is not None)
            or self.updated != (self.result is not None)
            or (not self.updated and self.replayed)
            or (self.result is not None and self.state != self.result.state)
        ):
            raise ValueError("invalid_test_settlement")
        return self


class Current(dispatch.DispatchModel):
    studio_id: Identity
    workflow_id: Identity
    result: _Result


class ActorRequest(dispatch.DispatchModel):
    p_studio_id: Identity
    p_actor_id: Identity


class ReserveRequest(ActorRequest):
    p_workflow_id: Identity
    p_operation_id: Identity
    p_graph: WorkflowGraph
    p_email_node_id: GraphId
    p_runtime: Runtime | None
    p_replay_only: StrictBool

    @model_validator(mode="after")
    def runtime_mode(self):
        if self.p_replay_only != (self.p_runtime is None):
            raise ValueError("invalid_test_runtime")
        return self


class ScopeRequest(dispatch.DispatchModel):
    p_studio_id: Identity
    p_test_delivery_id: Identity
    p_execution_token: Identity


class PreparationRequest(ScopeRequest):
    p_actor_id: Identity
    p_preparation_id: Identity
    p_sender_binding: dispatch.Hex64
    p_allowed_recipients: Mailboxes


class FinishRequest(ScopeRequest):
    p_reason: FailureReason


class BeginRequest(ScopeRequest):
    p_actor_id: Identity
    p_preparation_id: Identity
    p_preparation_token: Identity
    p_probe_token: Identity | None
    p_allowed_recipients: Mailboxes
    p_scope_fingerprint: dispatch.Hex64
    p_rendered: Rendered


class SettleRequest(ScopeRequest):
    p_attempt_id: Identity
    p_result: dispatch.Delivery


class CurrentRequest(ActorRequest):
    p_test_delivery_id: Identity


def _test_rpc(client: Any, name: str, request: dispatch.DispatchModel, result_type):
    """Use ordinary installed SDK parsing, then bind every test identity and truth."""
    try:
        data = client.rpc(name, request.model_dump(mode="json")).execute().data
        result = dispatch.Envelope[result_type].model_validate(data).payload
        for key in (
            "studio_id",
            "actor_id",
            "workflow_id",
            "test_delivery_id",
            "preparation_id",
            "attempt_id",
        ):
            if (
                hasattr(result, key)
                and hasattr(request, "p_" + key)
                and getattr(result, key) != getattr(request, "p_" + key)
            ):
                raise ValueError("invalid_test_identity")
        public = getattr(result, "result", None)
        if public is not None:
            for key in ("operation_id", "test_delivery_id"):
                expected = getattr(request, "p_" + key, getattr(result, key, None))
                if expected is not None and getattr(public, key) != expected:
                    raise ValueError("invalid_test_result_identity")
        if isinstance(request, ReserveRequest) and request.p_replay_only and not result.replayed:
            raise ValueError("invalid_test_replay")
        if isinstance(request, SettleRequest) and result.updated:
            permitted = {
                "accepted": {"accepted", "unknown"},
                "retryable_failure": {"failed", "unknown"},
                "permanent_failure": {"failed", "unknown"},
                "unknown": {"unknown"},
            }[request.p_result.outcome]
            if result.state not in permitted:
                raise ValueError("invalid_test_settlement_truth")
        return result
    except _BudgetExhausted:
        raise
    except APIError as exc:
        code, message = getattr(exc, "code", None), getattr(exc, "message", None)
        error = (503, UNAVAILABLE_DETAIL)
        if isinstance(code, str) and isinstance(message, str):
            error = _ERRORS.get((code, message), error)
        raise HTTPException(*error) from None
    except Exception:  # noqa: BLE001 - Private SQL, message and credential data never escape.
        raise HTTPException(503, UNAVAILABLE_DETAIL) from None


class _PreflightFailed(Exception):
    def __init__(self, reason: FailureReason):
        self.reason = reason


class _CurrentRequired(Exception):
    pass


class _PreparationUnavailable(Exception):
    def __init__(self, error: HTTPException | None = None):
        self.error = (
            error
            if error is not None and error.status_code == 403
            else HTTPException(503, UNAVAILABLE_DETAIL)
        )


class WorkflowTestEmailService:
    def __init__(
        self,
        client: Any,
        settings: Any,
        budget: _WorkerBudget,
        *,
        transport_factory: Callable[..., Any] | None = None,
        utc_clock: Callable[[], datetime] | None = None,
    ):
        self.client = client
        self.settings = settings
        self.budget = budget
        self.transport_factory = transport_factory or build_email_transport
        self.utc_clock = utc_clock or (lambda: datetime.now(UTC))

    def _live(self, expires_at: datetime) -> bool:
        now = self.utc_clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("invalid_test_clock")
        return now < expires_at

    @staticmethod
    def _public(result: _Result, *, operation_id: UUID | None = None):
        if operation_id is not None and result.operation_id != operation_id:
            raise ValueError("invalid_test_operation_identity")
        return WorkflowTestEmailResponse.model_validate(result.model_dump())

    def current(
        self,
        studio_id: UUID,
        actor_id: UUID,
        test_delivery_id: UUID,
        *,
        operation_id: UUID | None = None,
        workflow_id: UUID | None = None,
    ) -> WorkflowTestEmailResponse:
        response = _test_rpc(
            self.client,
            CURRENT,
            CurrentRequest(
                p_studio_id=studio_id, p_actor_id=actor_id, p_test_delivery_id=test_delivery_id
            ),
            Current,
        )
        try:
            if workflow_id is not None and response.workflow_id != workflow_id:
                raise ValueError("invalid_test_workflow_identity")
            return self._public(response.result, operation_id=operation_id)
        except (TypeError, ValueError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def _recover(self, reserved: Reserved) -> WorkflowTestEmailResponse:
        # No preparation, begin or provider submission can follow this point.
        self.budget.reserve = 0.0
        try:
            return self.current(
                reserved.studio_id,
                reserved.actor_id,
                reserved.result.test_delivery_id,
                operation_id=reserved.result.operation_id,
                workflow_id=reserved.workflow_id,
            )
        except Exception:  # noqa: BLE001 - A committed operation with unavailable truth is unresolved.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def _runtime(self):
        if (
            getattr(self.settings, "EMAIL_SEND_ENABLED", False) is not True
            or getattr(self.settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
        ):
            return None, None
        try:
            config = delivery_configuration(self.settings)
        except (TypeError, ValueError):
            return None, None
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        status = email_delivery_status(self.settings, self.client)
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        if status.get("configured") is not True:
            return None, None
        return config, Runtime(
            sender_binding=sender_identity_binding(config),
            default_reply_to=config.reply_to,
            allowed_recipients=sorted(config.allowed_recipients),
        )

    @staticmethod
    def _selection(reserved: Reserved, data: WorkflowTestEmailRequest, runtime: Runtime):
        execution = reserved.execution
        if execution is None:
            raise ValueError("missing_test_execution")
        if not validate_workflow_graph(data.graph, catalog=CATALOG).valid:
            raise ValueError("invalid_test_graph")
        triggers = [node for node in data.graph.nodes if node.type == "trigger"]
        selected = [node for node in data.graph.nodes if node.id == data.email_node_id]
        if len(triggers) != 1 or len(selected) != 1 or selected[0].type != "email":
            raise ValueError("invalid_test_selection")
        trigger, email = triggers[0].config, selected[0].config
        context = TriggerContext(
            program_id=UUID(trigger.program_id) if trigger.program_id is not None else None,
            offset_minutes=trigger.offset_minutes
            if "offset_minutes" in trigger.model_fields_set
            else None,
        )
        if (
            execution.email_node_id != data.email_node_id
            or execution.event_type != trigger.event_type
            or execution.trigger_context != context
            or execution.recipient_policy != email.recipient
            or execution.subject_template != email.subject_template
            or execution.body_template != email.body_template
            or execution.reply_to != (email.reply_to_email or runtime.default_reply_to)
            or (
                runtime.allowed_recipients
                and execution.recipient_email not in runtime.allowed_recipients
            )
        ):
            raise ValueError("invalid_test_selection")
        return execution

    def create(
        self,
        studio_id: UUID,
        actor_id: UUID,
        workflow_id: UUID,
        data: WorkflowTestEmailRequest,
    ) -> WorkflowTestEmailResponse:
        # Repeat the transport guard for direct callers before business RPCs.
        data = WorkflowTestEmailRequest.model_validate(
            data.model_dump(mode="json") if isinstance(data, WorkflowTestEmailRequest) else data
        )
        _config, runtime = self._runtime()
        reserved = _test_rpc(
            self.client,
            CREATE,
            ReserveRequest(
                p_studio_id=studio_id,
                p_actor_id=actor_id,
                p_workflow_id=workflow_id,
                p_operation_id=data.operation_id,
                p_graph=data.graph,
                p_email_node_id=data.email_node_id,
                p_runtime=runtime,
                p_replay_only=runtime is None,
            ),
            Reserved,
        )
        if reserved.replayed:
            return self._recover(reserved)
        try:
            execution = self._selection(reserved, data, runtime)
        except Exception:  # noqa: BLE001 - Contradictory selection is never execution authority.
            return self._recover(reserved)
        scope = {
            "p_studio_id": studio_id,
            "p_test_delivery_id": reserved.result.test_delivery_id,
            "p_execution_token": execution.execution_token,
        }
        possible_begin = False
        try:
            if not self._live(execution.lease_expires_at):
                raise _PreflightFailed("lease_expired")
            self.budget.check(DATABASE_TIMEOUT_SECONDS)
            try:
                facts = build_synthetic_workflow_facts(
                    execution.event_type,
                    execution.reference_time,
                    program_id=execution.trigger_context.program_id,
                    offset_minutes=execution.trigger_context.offset_minutes,
                    recipient_ids=frozenset({execution.recipient_policy}),
                )
                content = render_workflow_email(
                    execution.event_type,
                    execution.subject_template,
                    execution.body_template,
                    {
                        **facts.template_facts,
                        **facts.recipients[execution.recipient_policy].template_facts,
                    },
                    unsubscribe_url=None,
                )
                labeled = assemble_synthetic_test_email(content.subject, content.text_body)
                rendered = Rendered(
                    subject=labeled.subject,
                    text_body=labeled.text_body,
                    html_body=labeled.html_body,
                )
            except WorkflowEmailRenderError as exc:
                raise _PreflightFailed(exc.reason) from None
            except (ValueError, TypeError, OverflowError):
                raise _PreflightFailed("invalid_email_context") from None
            self.budget.check(DATABASE_TIMEOUT_SECONDS)
            try:
                claim = _test_rpc(
                    self.client,
                    PREPARE,
                    PreparationRequest(
                        **scope,
                        p_actor_id=actor_id,
                        p_preparation_id=uuid4(),
                        p_sender_binding=runtime.sender_binding,
                        p_allowed_recipients=runtime.allowed_recipients,
                    ),
                    PreparationClaim,
                )
            except _BudgetExhausted:
                raise
            except HTTPException as exc:
                raise _PreparationUnavailable(exc) from None
            if not claim.allowed:
                raise _PreflightFailed("sender_unavailable")
            if not self._live(claim.lease_expires_at) or not self._live(execution.lease_expires_at):
                raise _PreflightFailed("lease_expired")
            self.budget.check(DATABASE_TIMEOUT_SECONDS)
            transport = self.transport_factory(self.settings, self.client)
            try:
                prepared = _complete_sender_preparation(
                    self.client, self.budget, transport, runtime.sender_binding, claim
                )
            except _BudgetExhausted:
                raise
            except Exception:  # noqa: BLE001 - An unconfirmed preparation may own a live probe.
                raise _PreparationUnavailable from None
            if prepared is None:
                raise _PreflightFailed("sender_unavailable")
            if not self._live(claim.lease_expires_at) or not self._live(execution.lease_expires_at):
                raise _PreflightFailed("lease_expired")
            # A lost response may follow a committed actual begin. Every path
            # after this point can only settle the granted attempt or read truth.
            self.budget.check(DATABASE_TIMEOUT_SECONDS)
            possible_begin = True
            begun = _test_rpc(
                self.client,
                BEGIN,
                BeginRequest(
                    **scope,
                    p_actor_id=actor_id,
                    **prepared.params(),
                    p_allowed_recipients=runtime.allowed_recipients,
                    p_scope_fingerprint=execution.scope_fingerprint,
                    p_rendered=rendered,
                ),
                Begun,
            )
            if begun.result is not None:
                current = self._public(begun.result, operation_id=data.operation_id)
            if begun.outcome in {"already_begun", "stopped"}:
                return current
            if begun.outcome == "lease_lost":
                raise _CurrentRequired
            attempt = begun.attempt
            if (
                attempt.credential_revision != prepared.handle.envelope.revision
                or attempt.sender_binding != prepared.handle.sender_binding
                or attempt.sender_binding != runtime.sender_binding
                or attempt.message.to_address != execution.recipient_email
                or attempt.message.reply_to != execution.reply_to
                or any(
                    getattr(attempt.message, key) != getattr(rendered, key)
                    for key in Rendered.model_fields
                )
                or not self._live(attempt.lease_expires_at)
            ):
                raise _CurrentRequired
        except _PreparationUnavailable as exc:
            raise exc.error from None
        except _PreflightFailed as exc:
            return self._finish(reserved, scope, exc.reason)
        except _BudgetExhausted:
            if not possible_begin:
                return self._finish(reserved, scope, "budget_exhausted")
            return self._recover(reserved)
        except _CurrentRequired:
            return self._recover(reserved)
        except Exception:  # noqa: BLE001 - No retry or no-attempt finish after a possible begin.
            if not possible_begin:
                return self._finish(reserved, scope, "sender_unavailable")
            return self._recover(reserved)
        return self._send(reserved, scope, attempt, transport, prepared)

    def _finish(self, reserved: Reserved, scope: dict, reason: FailureReason):
        self.budget.reserve = 0.0
        try:
            finished = _test_rpc(
                self.client, FINISH, FinishRequest(**scope, p_reason=reason), Finished
            )
            if finished.updated:
                return self._public(finished.result, operation_id=reserved.result.operation_id)
        except Exception:  # noqa: BLE001, S110 - Refused or unconfirmed finish supplies no current truth.
            pass
        return self._recover(reserved)

    def _send(self, reserved: Reserved, scope: dict, attempt: Attempt, transport, prepared):
        try:
            self.budget.check()
        except _BudgetExhausted:
            observed = DeliveryResult(
                "retryable_failure",
                "send_budget_exhausted",
                submission_evidence="not_submitted",
                failure_scope="sender_transient",
            )
        else:
            try:
                observed = transport.send_prepared(
                    SyntheticTestEmailMessage(**attempt.message.model_dump(mode="json")),
                    prepared.handle,
                    deadline=self.budget.deadline - SETTLEMENT_RESERVE_SECONDS,
                )
            except Exception:  # noqa: BLE001 - A possible submission is never retried.
                observed = None
        delivery = _delivery_result(observed, expected_revision=prepared.handle.envelope.revision)
        self.budget.reserve = 0.0
        try:
            settled = _test_rpc(
                self.client,
                SETTLE,
                SettleRequest(**scope, p_attempt_id=attempt.id, p_result=delivery),
                Settled,
            )
            if settled.updated:
                return self._public(settled.result, operation_id=reserved.result.operation_id)
        except Exception:  # noqa: BLE001, S110 - Keep original send truth if settlement is unavailable.
            pass
        return self._recover(reserved)


def _owned_operation(
    settings: Any,
    actor_id: str,
    requested_studio_id: str | None,
    operation: Callable[[WorkflowTestEmailService, UUID, UUID], WorkflowTestEmailResponse],
    *,
    deadline_monotonic: float,
    current_read: bool = False,
    clock: Callable[[], float] | None = None,
    utc_clock: Callable[[], datetime] | None = None,
    client_factory: Callable[..., Any] | None = None,
    client_closer: Callable[[Any], None] | None = None,
    transport_factory: Callable[..., Any] | None = None,
) -> WorkflowTestEmailResponse:
    clock = clock or time.monotonic
    started = clock()
    if not math.isfinite(deadline_monotonic) or not math.isfinite(started):
        raise HTTPException(503, UNAVAILABLE_DETAIL)
    budget = _WorkerBudget(min(deadline_monotonic, started + WORK_BUDGET_SECONDS), clock)
    if current_read:
        budget.reserve = 0.0
    raw_client = None
    try:
        budget.check(DATABASE_TIMEOUT_SECONDS)
        raw_client = (client_factory or create_supabase_client)(
            postgrest_client_timeout=DATABASE_TIMEOUT_SECONDS
        )
        client = _WorkerClient(raw_client, budget)
        membership = resolve_write_staff_role_for_user(client, actor_id, requested_studio_id)
        if membership.get("role") != "admin":
            raise HTTPException(403, ADMIN_REQUIRED_DETAIL)
        budget.check(DATABASE_TIMEOUT_SECONDS)
        ensure_platform_subscription_access(client, membership["studio_id"], read_only=True)
        _require_dispatch_schema(client, budget)
        return operation(
            WorkflowTestEmailService(
                client, settings, budget, transport_factory=transport_factory, utc_clock=utc_clock
            ),
            _uuid(membership["studio_id"]),
            _uuid(actor_id),
        )
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - No configuration, SDK or cleanup diagnostics become public.
        raise HTTPException(503, UNAVAILABLE_DETAIL) from None
    finally:
        if raw_client is not None:
            try:
                (client_closer or close_supabase_client)(raw_client)
            except Exception:  # noqa: BLE001, S110 - Close once, preserving a confirmed command outcome.
                pass


def create_workflow_test_email(
    settings: Any,
    actor_id: str,
    requested_studio_id: str | None,
    workflow_id: UUID,
    data: WorkflowTestEmailRequest,
    *,
    deadline_monotonic: float,
    **dependencies,
) -> WorkflowTestEmailResponse:
    # Shape errors must precede client construction and all business RPCs.
    data = WorkflowTestEmailRequest.model_validate(
        data.model_dump(mode="json") if isinstance(data, WorkflowTestEmailRequest) else data
    )
    return _owned_operation(
        settings,
        actor_id,
        requested_studio_id,
        lambda service, studio, actor: service.create(studio, actor, workflow_id, data),
        deadline_monotonic=deadline_monotonic,
        **dependencies,
    )


def get_workflow_test_email(
    settings: Any,
    actor_id: str,
    requested_studio_id: str | None,
    test_delivery_id: UUID,
    *,
    deadline_monotonic: float,
    **dependencies,
) -> WorkflowTestEmailResponse:
    return _owned_operation(
        settings,
        actor_id,
        requested_studio_id,
        lambda service, studio, actor: service.current(studio, actor, test_delivery_id),
        deadline_monotonic=deadline_monotonic,
        current_read=True,
        **dependencies,
    )
