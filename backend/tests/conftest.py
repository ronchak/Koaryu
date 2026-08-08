from __future__ import annotations

import os

import pytest


# Never let the supported pytest process inherit a privileged target or proxy.
os.environ["ENVIRONMENT"] = "test"
os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
os.environ["SUPABASE_DEVELOPMENT_PROJECT_REF"] = ""

from app.core.config import (  # noqa: E402
    AMBIENT_TRANSPORT_ENVIRONMENT_KEYS,
    Settings,
)

# Do not read backend/.env at all in the supported test process.
Settings.model_config["env_file"] = None
for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS:
    os.environ.pop(key, None)

from app.services import platform_billing_service  # noqa: E402


@pytest.fixture(autouse=True)
def reset_access_repair_throttle():
    """Keep the authorization repair throttle from leaking between tests.

    The throttle is deliberately process-local module state, so without this a
    test that leaves a retry window open silently suppresses the Stripe repair
    in whichever test runs next, and that test fails for a reason that has
    nothing to do with what it is checking.
    """
    platform_billing_service._access_repair_retry_after.clear()
    yield
    platform_billing_service._access_repair_retry_after.clear()
