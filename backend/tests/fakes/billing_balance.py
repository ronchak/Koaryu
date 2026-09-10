"""Acknowledge the balance RPC without copying its database calculation.

Unrelated workflow tests use the named acknowledgement only. Balance/order tests
supply a scoped callback; SQL contracts own arithmetic and locking assurance.
"""


class BillingBalanceRpcMixin:
    def _rpc_recompute_billing_payer_balance_v1(self, params):
        assert set(params) == {"p_studio_id", "p_payer_id"}
        callback = getattr(self, "on_payer_balance_recompute", None)
        if callback is not None:
            callback(params)
        return None
