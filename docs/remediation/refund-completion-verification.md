# Refund completion verification

Base: `f8af4f4a66316e4d254f901cdeaf6571c4b6949c`, after PR #156.

The generic Billing loader catches read failures and resolves after both successful and unsuccessful attempts. Refund completion previously treated that resolution as proof that payment data was fresh and deleted its recovery key. A first-page refresh also could not verify an older payment loaded through pagination.

The existing data controller now owns a dedicated read of the exact refunded payment. The new GET uses the existing billing-reader, tenant, subscription and provider-runtime boundaries. It returns the existing payment response type and performs a single tenant-scoped payment lookup. Older payment pages cannot overwrite the refreshed target or become retained fresh data. The read preserves loaded history and cursor order. Cohort totals refresh separately; their failure does not undo proof of the payment's current balance.

The endpoint sends `Cache-Control: no-store, private` for direct API clients, matching the frontend proxy's existing cache protection. Automated review prompted this explicit header and an HTTP assertion. Its suggested before/after balance formula was declined after source review: remounted receipts may already be reflected in the displayed balance, and releasing an older pending reservation can offset a new refund. Aggregate differences cannot identify an individual operation. Recovery relies on the existing server projection/reservation contract and a fresh exact-target read, not a new client accounting rule.

The refund controller validates the returned refund and target identities before releasing the original request key. An optional confirmed-result marker in the existing scoped receipt permits **Refresh payment** after a failed read, including after remount and at zero remaining balance. Without that marker, recovery replays the original amount, reason and key. A rejection of that replay cannot disprove an earlier uncertain result. Corrupt saved receipts are retained and blocked instead of being deleted. Cleanup checks the captured key before removal.

Pending and requires-action results are described as submitted; failed and canceled results are described as such. These are the provider's documented [refund states](https://docs.stripe.com/api/refunds/object). The change does not alter the provider command, pending-refund reservations or accounting rules. It does not claim that an accepted request is completed money movement.

Same-identity credential renewal remains valid. Changed identity, role/capability or component lifetime invalidates the old operation and its message. A late finally cannot release a newer operation's guard. A current authorization denial invalidates all older financial reads, clears financial data and settles the denied load. An old-bearer 401 may retry only the read once with renewed credentials.

## Evidence

- Baseline refund/data tests passed 26 tests. A new joined test mounted the actual Reports controls, refund hook and data hook. Against the unchanged implementation, an accepted refund followed by a caught read failure deleted its receipt, failing the required one-receipt assertion with zero.
- The corrected focused suite passed 31 tests. It checks exact-target failure and read-only recovery, older pages, frozen delayed snapshots, credential renewal before POST/GET completion, access changes, zero-balance remount, original replay, marker/removal failures, wrong identities and balances, newer receipts, truthful statuses and actual UI gates. API I/O and decorative icons are substituted; the production hooks and controls are mounted.
- An independent review identified an older general loader that could restore financial data after a target-read denial. The correction invalidates general request ownership on access loss. An in-memory negative control removed only that invalidation and reproduced restored financial access and refund capability. No repository source was changed by the probe.
- Focused backend checks passed 67 tests and 81 subtests, including the actual new route and its existing policy helpers, tenant filtering, absent/foreign IDs, one-row lookup, static route selection and existing refund behavior.
- The full backend run passed 1,883 tests and 5,498 subtests. Its sole failure was a fixed endpoint-count assertion after adding the new endpoint. The provider-boundary file then passed all 10 tests after removing that brittle count and redundant counters. It still checks every provider-backed endpoint's boundary and service construction, the exact bulk-lane set and explicit interactive lanes, including the new read.
- The cache-header follow-up passed all 19 payment-read and provider-boundary checks. The broader backend and frontend jobs also passed on the initial PR head; the updated head still requires its own release gate.
- All 922 frontend tests passed. Changed frontend files passed lint, and the production build passed with the checked-in example environment. Generated API contract verification passed without a type change. Independent review cleared the implementation and access-loss follow-up; review is bound to the final commit before publication.

## Test quality and limits

Five implementation-text tests were removed: the throwing refresh substitute, source-order clearance proof, cleanup-message wording check, rendered-UI source check and hydration implementation-shape check. Their useful outcome coverage is supplied by actual recovery, storage, permission, preview, confirmation and rendered-control cases. Independent amount parsing, storage and request-serialization tests remain. The provider-boundary AST test retains its architectural contract without requiring a number edit for every endpoint.

The synthetic frontend server is not proof of provider idempotency or database concurrency. Existing backend refund/replay/reservation checks remain. Browser storage and expected-key comparisons are not a cross-tab transaction guarantee. This PR introduces no new financial capability, hosted execution, historical correction, migration or production deployment.

FSH1-06 and supporting FT1-03 are addressed together and remain pending until merge. External-payment request retention and atomic audit repair, generic billing completion, shared receipt consolidation, other store ownership issues and broader unavailable metrics remain separate findings.
