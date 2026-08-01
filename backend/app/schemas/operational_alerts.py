from typing import Literal

from pydantic import BaseModel


class OperationalAlertEvaluationResponse(BaseModel):
    environment: Literal["development", "test", "staging"]
    mode: Literal["recording-only"] = "recording-only"
    metrics: dict[str, int]
    lifecycle_events: dict[str, str]
    deliveries_claimed: int = 0
    deliveries_recorded: int = 0
    deliveries_failed: int = 0
    heartbeat_recorded: bool = False
