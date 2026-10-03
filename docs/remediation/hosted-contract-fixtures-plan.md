# Contracts on populated staging

Base: `7209e2a18739b6337c7834c64f208494812830ae`. The complete hosted attempt plus explicit continuation attempted all 53 files: 51 passed; the reconciliation and staff-profile fixtures failed. The application rehearsal and production remain blocked until a fresh complete run passes. This change repairs those test inputs, not runtime authorization or business rules.

## Verified causes

`studio_live_billing_authorizations_contract.sql` reports only its own synthetic Connect mapping. Staging already has six mappings. The real writer correctly rejects the incomplete global inventory with SQLSTATE P0B51. It requires fresh generation-bound evidence for each current mapping; that guard stays intact.

`tenant_rls_isolation_smoke.sql` replays historical name normalization over every Auth user. On a populated database it attempts to insert profiles that already exist and raises 23505. The intended normalization cases are the four newly seeded backfill users. Scope the input CTE to those IDs; do not hide duplicates with ON CONFLICT or change the migration.

## Implementation

- Keep existing profiles and Connect mappings unchanged. The reconciliation fixture adds uniquely named, processed mock delivery events for the current mapping inventory and constructs its simulated report from that inventory. The provider side is deliberately mocked. These are not real provider facts or release reconciliation evidence. Everything remains inside the existing rollback transaction; no Stripe call or persistent authorization is created.
- Keep the fixture's own mapping first and explicitly expect its generation 1. Other mappings use the existing canonical generation helper. The database already enforces unique connected-account IDs.
- Add focused failures for omitted mapping evidence and a stale report generation. The omitted inventory keeps its declared counts consistent with its shortened array, so rejection exercises the database inventory comparison. Keep all existing authorization, stale-candidate, pending-event, generation and continuity checks.
- Replace the legacy-date source-text scan with a processed event 30 days old and a check that the actual checkpoint's 29-day count excludes it. Keep the event in the ingest watermark. Thus the test exercises the time-window result rather than literal source spelling.
- Build the rolling report with object updates instead of nested jsonb_set calls. A private SQL comparison checks equality with the old construction under the same variables, adjusting only the intended inventory-dependent counts.

The fix belongs in the test data setup: positive reports need the whole inventory, while profile replay needs only its owned users. No runtime function, migration, policy, grant, application code or planner setting changes. The dashboard fixture from PR212 is unchanged.

## Verification

A disposable PostgreSQL 17 probe replays all 142 unchanged migrations. Both old contracts pass on an empty target. With an existing profile and generation 7 mapping, they reproduce 23505 and P0B51; their failed transactions preserve the background rows. The corrected contracts pass on empty and populated targets, and preserve those rows. The rolling report equals the old construction with the updated event totals.

For the broader populated-target suite, the private background studio uses the real onboarding RPC and the normal Unassigned program row. The initial minimal background omitted that row and correctly failed the existing global program invariant; no contract was weakened to accommodate an invalid probe setup. The final probe runs every contract and compares retained rows in 12 tables after each file.

Source sizes: reconciliation 730→735 lines, staff-profile file 1617→1621; nine net SQL lines added, no new test files. Explicit exception checks are 25→26 and 74→74. Two useful negative checks replace one source-text date check; the existing checkpoint assertion also checks the bounded event count. Catalog permission and attestation assertions remain because they protect real boundaries. Together with PR212, this run removes 278 SQL test lines. The inventory stays 53 contracts.

Independent review, exact-head CI and guarded merge are required. Then repin the merged candidate and rerun all 53 hosted files from the beginning, checking retained rows and catalog afterward. The 51-pass/two-failure attempt is never a release pass. No original audit finding directly names these two fixtures; existing dispositions remain unchanged.
