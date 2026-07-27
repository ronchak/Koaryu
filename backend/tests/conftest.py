from __future__ import annotations

import os

import pytest

# App imports during collection must not inherit a developer's hosted target.
os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"

from app.services import platform_billing_service


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
