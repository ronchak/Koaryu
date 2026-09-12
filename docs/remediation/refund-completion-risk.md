# Pending refund completion recovery risk

`PROGRAM-REFUND-01` is a pre-existing integrity risk verified against main `9d99ad53cddcbd03989671ff408e1ac30e47e9e0`. It is pending, not accepted or fixed. Database remediation is excluded from the current application refactor run.

A succeeded refund changes the payment's refunded total during projection. If the following provider-operation completion RPC fails before committing, the receipt remains `projected`. A retry with the original key can then fail the resource-version guard because that fingerprint includes the refunded total changed by this same operation. The refund is not sent twice, but ordinary same-key completion recovery is blocked.

Coordinator evidence on unchanged main used the actual BillingService/projector with the existing in-memory provider/database fakes. A forced completion failure left a `projected` receipt, 500 refunded cents and one provider refund. Restoring the completion handler and advancing the fake clock 31 seconds still produced HTTP 409 on same-key retry, with one provider refund. This is an application reproduction plus static SQL verification, not a database execution or concurrency proof.

The V31 `private.billing_operation_resource_version_v31` definition includes `refunded_amount_cents`. Its resource claim rejects a changed fingerprint for a non-completed receipt. The V33 public wrapper still delegates refund claims to that implementation. No migration or SQL was changed or executed during this investigation.

The test refactor must not bypass that guard by recomputing a fixture fingerprint. A valid pending-refund projection can exercise the separate saved-result validation path because the confirmed refunded total remains unchanged. That narrower coverage does not resolve this succeeded-refund gap.

The next authorized database work should prove the real contract and add a forward correction for the operation's own verified projection, retaining protection against unrelated edits, actor/tenant/account mismatches and destructive retries. Do not reorder completion ahead of projection or bypass claim/lease checks as an application workaround. No financial backfill. Reassess this risk before a future release or live billing activation.
