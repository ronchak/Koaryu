from typing import Literal

from pydantic import BaseModel


class OperationalAlertEvaluationResponse(BaseModel):
    environment: Literal["development", "test", "staging", "production"]
    mode: Literal["https"] = "https"
    metrics: dict[str, int]
    lifecycle_events: dict[str, str]
    deliveries_claimed: int = 0
    deliveries_delivered: int = 0
    deliveries_failed: int = 0
    heartbeat_recorded: bool = False
    heartbeat_sequence: int


class OperationalAlertAcknowledgementResponse(BaseModel):
    episode_id: str
    lifecycle_event: Literal["acknowledged", "already_acknowledged", "closed"]
    acknowledged: bool
    acknowledged_by_role: Literal["primary", "backup"] | None = None
