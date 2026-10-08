"""Public synthetic test command, current state and immutable acknowledgment."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, model_validator

from app.schemas.workflow import WorkflowGraph
from app.schemas.workflow_run import GraphId
from app.services.automation_email import _BODY_CONTROL, _CONTROL


class _TestEmailModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", revalidate_instances="always", hide_input_in_errors=True
    )


class WorkflowTestEmailRequest(_TestEmailModel):
    operation_id: UUID
    graph: WorkflowGraph
    email_node_id: GraphId

    @model_validator(mode="before")
    @classmethod
    def bound_request(cls, value: object) -> object:
        # Management receipts import the acknowledgment below. Do not import
        # their request guard while that schema module is still initializing.
        from app.schemas.workflow_management import guard_workflow_request

        guard_workflow_request(value)
        return value

    @model_validator(mode="after")
    def safe_template_controls(self):
        for node in self.graph.nodes:
            if node.type == "email" and (
                _CONTROL.search(node.config.subject_template)
                or _BODY_CONTROL.search(node.config.body_template)
                or "\r" in node.config.body_template
            ):
                raise ValueError("Use plain text email templates.")
        return self


class WorkflowTestEmailResponse(_TestEmailModel):
    operation_id: UUID
    test_delivery_id: UUID
    state: Literal["queued", "sending", "accepted", "failed", "unknown"]


class WorkflowTestEmailAcknowledgment(_TestEmailModel):
    operation_id: UUID
    test_delivery_id: UUID
    state: Literal["queued"]
