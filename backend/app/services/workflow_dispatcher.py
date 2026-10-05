"""Unmounted bounded consumer of SQL-owned workflow transitions and mail grants."""

from __future__ import annotations

import math
import secrets
import time
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException

from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas import workflow_dispatch as dto
from app.services.automation_email import (
    DeliveryResult,
    EmailMessage,
    _safe_https_url,
    build_email_transport,
    delivery_configuration,
    email_delivery_status,
)
from app.services.automation_service import (
    DATABASE_TIMEOUT_SECONDS,
    SETTLEMENT_RESERVE_SECONDS,
    UNAVAILABLE_DETAIL,
    WORK_BUDGET_SECONDS,
    _BudgetExhausted,
    _delivery_result,
    _dispatch_rpc,
    _prepare_sender,
    _require_dispatch_schema,
    _WorkerBudget,
    _WorkerClient,
)
from app.services.studio_scope import get_platform_subscription_access
from app.services.workflow_email import WorkflowEmailRenderError, render_workflow_email
from app.services.workflow_simulation_service import _decode_facts


class _TransitionLimit(Exception):
    pass


def _no_attempt(run: dto.RunPosition | None) -> str:
    if run is not None and run.state in {"waiting", "completed", "unknown"}:
        return run.state
    return "skipped"


class _ClaimConsumer:
    def __init__(self, settings, client, budget, transport_factory, counts):
        self.settings = settings
        self.client = client
        self.budget = budget
        self.transport_factory = transport_factory
        self.counts = counts
        self.boundaries = 0

    def _boundary(self):
        if self.boundaries >= 40:
            raise _TransitionLimit
        self.boundaries += 1

    def _defer(self, scope: dict, reason: str) -> str:
        result = _dispatch_rpc(
            self.client,
            "defer_automation_workflow_run_v1",
            dto.DeferRequest(**scope, p_reason=reason),
            dto.Deferred,
        )
        return _no_attempt(result.run)

    def consume(self, claim: dto.Claim) -> str:
        scope = {
            "p_studio_id": claim.studio_id,
            "p_run_id": claim.run_id,
            "p_claim_token": claim.claim_token,
        }
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        try:
            access = get_platform_subscription_access(
                self.client, str(claim.studio_id), allow_provider_repairs=False, read_only=True
            )
        except HTTPException as exc:
            self.budget.check(DATABASE_TIMEOUT_SECONDS)
            if exc.status_code != 503:
                raise
            return self._defer(scope, "facts_unavailable")
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        if access.get("subscription_required") is not False:
            return self._defer(
                scope,
                "subscription_required"
                if access.get("subscription_required") is True
                else "facts_unavailable",
            )
        try:
            while True:
                self._boundary()
                advanced = _dispatch_rpc(
                    self.client,
                    "advance_automation_workflow_run_v1",
                    dto.AdvanceRequest(**scope, p_step_limit=1),
                    dto.Transition,
                )
                if advanced.outcome == "continue":
                    continue
                if advanced.outcome != "email":
                    return _no_attempt(advanced.run)
                result = self._email(scope, advanced.run.current_node_id)
                if result is not None:
                    return result
                # Only a confirmed no-attempt resolver continue retains this claim.
        except _TransitionLimit:
            return self._defer(scope, "facts_unavailable")

    def _resolve(self, parameters: dict, plan: dto.Plan, resolution: dict) -> dto.Resolved:
        self._boundary()
        return _dispatch_rpc(
            self.client,
            "resolve_workflow_email_without_attempt_v1",
            dto.ResolveRequest(
                **parameters,
                p_plan_fingerprint=plan.fingerprint,
                p_unsubscribe_token=plan.unsubscribe_token,
                p_resolution=resolution,
            ),
            dto.Resolved,
        )

    def _email(self, scope: dict, node_id: str) -> str | None:
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        if self.boundaries >= 40:
            raise _TransitionLimit
        if (
            getattr(self.settings, "EMAIL_SEND_ENABLED", False) is not True
            or getattr(self.settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
        ):
            return self._defer(scope, "sender_unavailable")
        try:
            config = delivery_configuration(self.settings)
            _safe_https_url(
                config.public_api_url + "/automations/unsubscribe#" + "0" * 64, allow_fragment=True
            )
        except (TypeError, ValueError):
            return self._defer(scope, "sender_unavailable")
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        status = email_delivery_status(self.settings, self.client)
        self.budget.check(DATABASE_TIMEOUT_SECONDS)
        if status.get("configured") is not True:
            return self._defer(scope, "sender_unavailable")
        parameters = {
            **scope,
            "p_node_id": node_id,
            "p_allowed_recipients": sorted(config.allowed_recipients),
            "p_default_reply_to": config.reply_to,
            "p_public_api_url": config.public_api_url,
        }
        transport = None
        for refresh in range(2):
            planned = _dispatch_rpc(
                self.client,
                "get_workflow_email_plan_v1",
                dto.PlanRequest(
                    **parameters,
                    p_candidate_unsubscribe_token=secrets.token_hex(32),
                ),
                dto.Planned,
            )
            if planned.outcome == "lease_lost":
                return "skipped"
            plan = planned.plan
            expected_url = (
                config.public_api_url + "/automations/unsubscribe#" + plan.unsubscribe_token
            )
            if (
                plan.unsubscribe_url != expected_url
                or _safe_https_url(plan.unsubscribe_url, allow_fragment=True) != expected_url
            ):
                raise ValueError("invalid_dispatch_unsubscribe_binding")
            resolution = None
            if plan.disposition != "send":
                resolution = {"kind": "plan_decision"}
            else:
                facts = _decode_facts(
                    plan.facts, plan.event_type, frozenset({plan.recipient_policy})
                )
                try:
                    content = render_workflow_email(
                        plan.event_type,
                        plan.subject_template,
                        plan.body_template,
                        {
                            **facts.template_facts,
                            **facts.recipients[plan.recipient_policy].template_facts,
                        },
                        unsubscribe_url=plan.unsubscribe_url,
                    )
                except WorkflowEmailRenderError as exc:
                    resolution = (
                        {"kind": "facts_unavailable"}
                        if exc.reason == "facts_unavailable"
                        else {"kind": "sender_unavailable"}
                        if exc.reason == "invalid_email_url"
                        else {"kind": "render_failed", "reason": exc.reason}
                    )
                if resolution is None:
                    self.budget.check(DATABASE_TIMEOUT_SECONDS)
                    if transport is None:
                        transport = self.transport_factory(self.settings, self.client)
                    prepared = _prepare_sender(self.client, self.budget, transport, config)
                    if prepared is None:
                        resolution = {"kind": "sender_unavailable"}
            if resolution is not None:
                resolved = self._resolve(parameters, plan, resolution)
                if resolved.outcome == "continue":
                    return None
                if resolved.outcome != "stale_plan":
                    return _no_attempt(resolved.run)
            else:
                rendered = dto.Rendered(
                    subject=content.subject,
                    text_body=content.text_body,
                    html_body=content.html_body,
                )
                self._boundary()
                try:
                    begun = _dispatch_rpc(
                        self.client,
                        "begin_workflow_email_v1",
                        dto.BeginRequest(
                            **parameters,
                            p_plan_fingerprint=plan.fingerprint,
                            p_unsubscribe_token=plan.unsubscribe_token,
                            p_rendered=rendered,
                            **prepared.params(),
                        ),
                        dto.Begun,
                    )
                    if begun.outcome == "begun":
                        attempt = begun.attempt
                        message = attempt.message
                        if (
                            attempt.credential_revision != prepared.handle.envelope.revision
                            or attempt.sender_binding != prepared.handle.sender_binding
                            or message.to_address != plan.recipient_email
                            or message.reply_to != plan.reply_to
                            or any(
                                getattr(message, key) != getattr(rendered, key)
                                for key in dto.Rendered.model_fields
                            )
                        ):
                            raise ValueError("invalid_dispatch_approved_message")
                except _BudgetExhausted:
                    raise
                except Exception:  # noqa: BLE001 - Unknown begin cannot grant a submission or retry.
                    return "unknown"
                if begun.outcome == "begun":
                    return self._send(scope, attempt, prepared, transport)
                if begun.outcome == "already_begun":
                    return "unknown"
                if begun.outcome != "stale_plan":
                    if begun.outcome == "skipped" and begun.run.state == "queued":
                        self.counts["has_more"] = True
                    return _no_attempt(begun.run)
            if refresh == 1:
                return self._defer(scope, "facts_unavailable")
        raise AssertionError("unreachable_dispatch_refresh")

    def _send(self, scope, attempt, prepared, transport):
        try:
            self.budget.check()
        except _BudgetExhausted:
            result = DeliveryResult(
                "retryable_failure",
                "send_budget_exhausted",
                submission_evidence="not_submitted",
                failure_scope="sender_transient",
            )
        else:
            try:
                result = transport.send_prepared(
                    EmailMessage(**attempt.message.model_dump(mode="json")),
                    prepared.handle,
                    deadline=self.budget.deadline - SETTLEMENT_RESERVE_SECONDS,
                )
            except Exception:  # noqa: BLE001 - Never repeat a possibly submitted request.
                result = None
        delivery = _delivery_result(result, expected_revision=prepared.handle.envelope.revision)
        self.budget.reserve = 0.0
        try:
            settled = _dispatch_rpc(
                self.client,
                "settle_workflow_email_v1",
                dto.SettleRequest(
                    p_studio_id=scope["p_studio_id"],
                    p_claim_token=scope["p_claim_token"],
                    p_attempt_id=attempt.id,
                    p_result=delivery,
                ),
                dto.Settled,
            )
            if not settled.updated:
                return "unknown"
            # Settling releases the old claim. Replay reports original attempt truth
            # alongside current progress, which can already belong to another worker.
            if not settled.replayed and settled.run.state == "queued":
                self.counts["has_more"] = True
            if settled.state == "failed" and settled.run.state == "waiting":
                return "retry_wait"
            return settled.state
        except Exception:  # noqa: BLE001 - Lost settlement is unknown even after observed acceptance.
            return "unknown"
        finally:
            self.budget.reserve = SETTLEMENT_RESERVE_SECONDS


def process_due_workflow_automations(
    settings: Any,
    *,
    limit: int = 10,
    deadline_monotonic: float | None = None,
    clock: Callable[[], float] | None = None,
    client_factory: Callable[..., Any] | None = None,
    client_closer: Callable[[Any], None] | None = None,
    transport_factory: Callable[..., Any] | None = None,
) -> dto.WorkflowProcessResponse:
    """Consume at most one disposition per claim within one shared absolute deadline."""
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError("invalid_automation_limit")
    counts = dto.WorkflowProcessResponse().model_dump()
    if getattr(settings, "AUTOMATION_WORKER_ENABLED", False) is not True:
        return dto.WorkflowProcessResponse(**counts)
    clock = clock or time.monotonic
    deadline = clock() + WORK_BUDGET_SECONDS
    if deadline_monotonic is not None:
        if type(deadline_monotonic) not in {int, float} or not math.isfinite(deadline_monotonic):
            raise ValueError("invalid_automation_deadline")
        deadline = min(deadline, deadline_monotonic)
    budget = _WorkerBudget(deadline, clock)
    raw_client = None
    try:
        budget.check(DATABASE_TIMEOUT_SECONDS)
        raw_client = (client_factory or create_supabase_client)(
            postgrest_client_timeout=DATABASE_TIMEOUT_SECONDS
        )
        client = _WorkerClient(raw_client, budget)
        _require_dispatch_schema(client, budget)
        consumed_tokens = set()
        for _ in range(limit):
            claims = _dispatch_rpc(
                client, "claim_automation_workflow_runs_v1", dto.ClaimRequest(p_limit=1), dto.Claims
            )
            counts["has_more"] = claims.has_more
            if not claims.claims:
                break
            if claims.claims[0].claim_token in consumed_tokens:
                raise ValueError("repeated_dispatch_claim_token")
            consumed_tokens.add(claims.claims[0].claim_token)
            counts["claimed"] += 1
            result = _ClaimConsumer(
                settings, client, budget, transport_factory or build_email_transport, counts
            ).consume(claims.claims[0])
            counts["processed"] += 1
            counts[result] += 1
            if result == "unknown":
                break
    except _BudgetExhausted:
        pass
    except Exception:  # noqa: BLE001 - Never expose provider/SQL/fact contents.
        raise HTTPException(503, UNAVAILABLE_DETAIL) from None
    finally:
        if raw_client is not None:
            try:
                (client_closer or close_supabase_client)(raw_client)
            except Exception:  # noqa: BLE001, S110 - Cleanup cannot erase observed attempt truth.
                pass
    return dto.WorkflowProcessResponse.model_validate(counts, context={"limit": limit})
