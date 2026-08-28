from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


_TARGETS = {
    "production": "https://koaryu.onrender.com/api/v1",
    "staging": "https://koaryu-staging.onrender.com/api/v1",
}
_MAX_RESPONSE_BYTES = 4096
_BATCH_LIMIT = 25
_REQUEST_TIMEOUT_SECONDS = 130.0


@dataclass(frozen=True)
class BillingTransitionCronConfig:
    environment: str
    backend_api_url: str
    worker_secret: str

    @classmethod
    def from_environment(
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> "BillingTransitionCronConfig":
        values = os.environ if environment is None else environment
        name = values.get("ENVIRONMENT", "").strip()
        backend_api_url = values.get("KOARYU_BACKEND_API_URL", "").strip()
        worker_secret = values.get("BILLING_TRANSITION_WORKER_SECRET", "")
        expected_url = _TARGETS.get(name)
        if expected_url is None or backend_api_url != expected_url:
            raise RuntimeError("Billing transition cron target is not pinned to its environment.")
        if (
            len(worker_secret) < 32
            or worker_secret != worker_secret.strip()
            or any(ord(character) < 32 or ord(character) == 127 for character in worker_secret)
        ):
            raise RuntimeError("Billing transition cron secret is incomplete or unsafe.")
        return cls(
            environment=name,
            backend_api_url=backend_api_url,
            worker_secret=worker_secret,
        )


def process_due_billing_transitions(
    config: BillingTransitionCronConfig,
) -> dict[str, int]:
    request = Request(
        f"{config.backend_api_url}/internal/billing/enrollment-transitions/process-due"
        f"?limit={_BATCH_LIMIT}",
        data=b"",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "koaryu-billing-transition-cron/1",
            "X-Internal-Secret": config.worker_secret,
        },
        method="POST",
    )
    try:
        # Bandit B310 is not applicable: `backend_api_url` must equal one exact
        # HTTPS origin from `_TARGETS`; arbitrary schemes, hosts, paths, and ports
        # are rejected before this Request is constructed.
        # The backend bulk lane waits at most 120 seconds. Keep this client
        # deadline just beyond that boundary so it receives the backend's
        # retry-safe error instead of abandoning a request that is still
        # running. The 130-second bound also finishes before the next
        # five-minute Render Cron invocation.
        with urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:  # nosec B310
            payload_bytes = response.read(_MAX_RESPONSE_BYTES + 1)
            status_code = response.status
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError("Billing transition cron request failed.") from exc
    if status_code != 200 or len(payload_bytes) > _MAX_RESPONSE_BYTES:
        raise RuntimeError("Billing transition cron returned an unsafe response.")
    try:
        payload = json.loads(payload_bytes)
    except (TypeError, ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError("Billing transition cron returned invalid JSON.") from exc
    expected_keys = {"claimed", "completed", "reconciliation_required", "failed"}
    if (
        not isinstance(payload, dict)
        or set(payload) != expected_keys
        or any(
            not isinstance(payload[key], int)
            or isinstance(payload[key], bool)
            or payload[key] < 0
            for key in expected_keys
        )
    ):
        raise RuntimeError("Billing transition cron returned an invalid result shape.")
    if payload["failed"] or payload["reconciliation_required"]:
        raise RuntimeError("Billing transition cron requires operator attention.")
    return {
        "claimed": payload["claimed"],
        "completed": payload["completed"],
        "reconciliation_required": payload["reconciliation_required"],
        "failed": payload["failed"],
    }


def main() -> None:
    config = BillingTransitionCronConfig.from_environment()
    result = process_due_billing_transitions(config)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
