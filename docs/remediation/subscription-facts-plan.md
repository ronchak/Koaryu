# Confirmed subscription facts

Missing subscription records were reconstructed as monthly USD even when the provider supplied different or incomplete terms. The correction records only complete, consistent price evidence. Missing, conflicting or unsupported terms stay null. It never chooses the first of different items or infers a cadence from dates.

The projector owns this interpretation. The database and response model must also represent unknown values, so V49 removes the two subscription-column NOT NULL constraints and defaults. Plans, payments, invoices, amounts and USD-only write boundaries are unchanged. Existing non-null subscription facts are preserved; complete evidence may fill only missing facts. No historical guesses or financial records are rewritten.

Only explicit complete item pages can supply evidence. Currency and cadence are checked independently across every price. Supported recurring pairs are week/1, week/2, month/1 and year/1, matching the current product's weekly, biweekly, monthly and annual terms. Other or missing pairs are unknown.

The existing exact currency/cadence grouping query excludes null terms. The Stripe subscription identity index still prevents duplicate provider records. The frontend currently counts subscription status and does not format these terms, so the planned old-frontend/new-backend window is compatible. The regenerated API type accepts null.

Null fills also require null at write time. A competing fill returns a retriable 503 through the existing durable webhook failure handling. Replay reads the confirmed terms again, preserves them, and applies the remaining facts and status together.

## Verification and release

V49 preserves all previously attested operational manifests. It adds an explicit column contract and independent raw observation, including the old column state for V47/V48 inspections. Missing unknown support or restored invented defaults must fail readiness. All historical migration files remain unchanged.

A new SQL contract verifies omitted and explicit unknowns, separation from a known USD monthly group, provider-identity uniqueness and later confirmed facts. It runs in the full 54-file gate, which includes all 53 earlier files, and on canonical/restored V48 upgrade copies. The restore seed contains a confirmed CAD annual subscription to prove that existing facts survive unchanged.

Source and permission checks, exact-head CI, independent review, guarded merge and production auto-deploy off remain required. Production release will apply V48 and V49 separately under one fresh verified backup/restore, with a 30-second announcement and original-row comparison after each apply. No production apply or deployment is recorded by this implementation plan.

The old backend may serve during the database-first window while records retain their old shape. Once version 2 activation receipts or null subscription facts have been written, older application versions are not an approved rollback: use a reviewed forward correction or an owner-directed restore from the verified backup. The old frontend accepts the new response at runtime because it does not consume the changed fields.

The combined operator patch adds exact backup readiness mappings through V49. It changes no credential, image, backup, restore, cleanup or permission behavior. Its installation and the fresh production restore proof belong to release execution.

Mixed-currency transaction totals and decimal formatting are intentionally deferred under the owner's decision rule. The production query found USD only in 7 invoices, 5 payments and 5 plans. Revisit that read-side work if confirmed non-USD transactions appear. No currency conversion or historical backfill is included.
