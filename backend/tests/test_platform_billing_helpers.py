import unittest

from fastapi import HTTPException

from app.services.platform_billing_helpers import (
    MAX_IDEMPOTENCY_KEY_LENGTH,
    build_core_checkout_idempotency_key,
    build_idempotency_key,
    normalize_idempotency_key,
)


class PlatformBillingHelperTest(unittest.TestCase):
    def test_build_idempotency_key_hashes_long_final_stripe_keys(self):
        key = build_idempotency_key("core-checkout", "studio-" + ("s" * 120), "request-" + ("r" * 255))

        self.assertLessEqual(len(key), MAX_IDEMPOTENCY_KEY_LENGTH)
        self.assertRegex(key, r"^koaryu:core-checkout:[0-9a-f]{64}$")

    def test_core_checkout_key_stays_under_stripe_limit_with_max_user_key(self):
        key = build_core_checkout_idempotency_key(
            "studio-" + ("s" * 120),
            "cus_123",
            {
                "success_url": "https://koaryu.test/success",
                "cancel_url": "https://koaryu.test/cancel",
            },
            "r" * MAX_IDEMPOTENCY_KEY_LENGTH,
            "price_core",
        )

        self.assertLessEqual(len(key), MAX_IDEMPOTENCY_KEY_LENGTH)
        self.assertRegex(key, r"^koaryu:core-checkout:[0-9a-f]{64}$")

    def test_normalize_idempotency_key_rejects_over_limit_values(self):
        with self.assertRaises(HTTPException) as context:
            normalize_idempotency_key("x" * (MAX_IDEMPOTENCY_KEY_LENGTH + 1))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn(str(MAX_IDEMPOTENCY_KEY_LENGTH), context.exception.detail)


if __name__ == "__main__":
    unittest.main()
