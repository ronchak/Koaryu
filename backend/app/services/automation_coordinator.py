"""One guarded occurrence scan and two processors sharing one client and budget."""

from __future__ import annotations

import logging
import math
import time
from typing import Literal

from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas.automation_batch import (
    AutomationBatchResponse,
    OccurrenceProcessRequest,
    OccurrenceProcessResponse,
)
from app.services.automation_service import (
    DATABASE_TIMEOUT_SECONDS,
    WORK_BUDGET_SECONDS,
    _BudgetExhausted,
    _require_dispatch_schema,
    _WorkerBudget,
    _WorkerClient,
    process_due_missed_class_automations,
)
from app.services.workflow_dispatcher import process_due_workflow_automations

logger = logging.getLogger(__name__)
_OCCURRENCE_LIMIT = 25


class AutomationBatchUnavailable(RuntimeError):
    def __init__(self):
        super().__init__("Automation batch is unavailable.")


def _batch_deadline(clock, deadline_monotonic, limit):
    now = clock()
    if (
        type(limit) is not int
        or not 1 <= limit <= 10
        or type(now) not in {int, float}
        or not math.isfinite(now)
        or type(deadline_monotonic) not in {int, float}
        or not math.isfinite(deadline_monotonic)
    ):
        raise AutomationBatchUnavailable()
    return now, min(deadline_monotonic, now + WORK_BUDGET_SECONDS)


def process_automation_batch(
    settings,
    *,
    first_engine: Literal["attendance", "workflows"],
    deadline_monotonic: float,
    limit: int = 10,
    clock=None,
    client_factory=None,
    client_closer=None,
    transport_factory=None,
    attendance_processor=None,
    workflow_processor=None,
) -> AutomationBatchResponse:
    clock = clock or time.monotonic
    raw_client = None
    try:
        if (
            getattr(settings, "AUTOMATION_WORKER_ENABLED", False) is not True
            or type(first_engine) is not str
            or first_engine not in ("attendance", "workflows")
        ):
            raise AutomationBatchUnavailable()
        _, deadline = _batch_deadline(clock, deadline_monotonic, limit)
        budget = _WorkerBudget(deadline, clock)
        budget.check(DATABASE_TIMEOUT_SECONDS)
        raw_client = (client_factory or create_supabase_client)(
            postgrest_client_timeout=DATABASE_TIMEOUT_SECONDS
        )
        client = _WorkerClient(raw_client, budget)
        _require_dispatch_schema(client, budget)
        request = OccurrenceProcessRequest(p_limit=_OCCURRENCE_LIMIT)
        data = (
            client.rpc("process_automation_workflow_occurrences_v1", request.model_dump())
            .execute()
            .data
        )
        if type(data) is not dict or set(data) != {"payload"}:
            raise AutomationBatchUnavailable()
        occurrences = OccurrenceProcessResponse.model_validate(
            data["payload"], context={"p_limit": request.p_limit}
        )
        results = {"attendance": None, "workflows": None}
        processors = {
            "attendance": attendance_processor or process_due_missed_class_automations,
            "workflows": workflow_processor or process_due_workflow_automations,
        }
        order = (first_engine, "workflows" if first_engine == "attendance" else "attendance")
        for engine in order:
            if engine == "attendance" and (
                getattr(settings, "EMAIL_SEND_ENABLED", False) is not True
                or getattr(settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
            ):
                continue
            try:
                budget.check(DATABASE_TIMEOUT_SECONDS)
            except _BudgetExhausted:
                break
            observed = processors[engine](
                settings,
                limit=limit,
                deadline_monotonic=deadline,
                clock=clock,
                client_factory=lambda **_: raw_client,
                client_closer=lambda _: None,
                transport_factory=transport_factory,
            )
            if observed is None:
                raise AutomationBatchUnavailable()
            results[engine] = observed
            hint = occurrences.has_more or any(
                result is None
                or (result.get("has_more") if type(result) is dict else result.has_more)
                for result in results.values()
            )
            summary = AutomationBatchResponse.model_validate(
                {"occurrences": occurrences, **results, "has_more": hint},
                context={"limit": limit, "p_limit": _OCCURRENCE_LIMIT},
            )
            confirmed = getattr(summary, engine)
            if any(getattr(confirmed, key) for key in ("retry_wait", "failed", "unknown")):
                return summary
        hint = occurrences.has_more or any(
            result is None or (result.get("has_more") if type(result) is dict else result.has_more)
            for result in results.values()
        )
        return AutomationBatchResponse.model_validate(
            {"occurrences": occurrences, **results, "has_more": hint},
            context={"limit": limit, "p_limit": _OCCURRENCE_LIMIT},
        )
    except Exception:  # noqa: BLE001 - Never expose SDK, credential or processor diagnostics.
        raise AutomationBatchUnavailable() from None
    finally:
        if raw_client is not None:
            try:
                (client_closer or close_supabase_client)(raw_client)
            except Exception:  # noqa: BLE001 - Report the category without erasing confirmed work.
                logger.warning("automation_batch_cleanup_failed")
