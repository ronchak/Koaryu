# Production code drift: `6596cc5` to `da2e02c`

Date: 2026-07-31

This is a source-level classification for release coordination. It makes no provider mutation and does not prove which schema migrations are currently applied in production.

## Observed range

The reported production application SHA is `6596cc5f1612f78dd240cffedbf64ae55f7e3a26`; the exact current-main SHA inspected here is `da2e02c250643d9d39be0bb0c76764ad4ba48605`. The range contains nine commits, 35 changed files, 7,343 added lines, and 402 deleted lines.

| Area | Classification | Deployment implication |
| --- | --- | --- |
| Billing authorization/projection services | Runtime behavior changed: retry neutrality, trial-end repair, durable comp management, and comp preservation | Requires focused billing regression proof at the exact integrated candidate; live outbound billing remains gated off. |
| Owner-run comp CLI and tests | New operator-only tooling | Does not affect old production code unless invoked; follow the operator runbook. |
| Frontend dependency remediation | Dependency/lockfile change | Vercel must build and report the exact candidate SHA; source presence is not deployed evidence. |
| Local Supabase contract runner | CI/developer infrastructure | No runtime impact. |
| Documentation/runbooks | Operational guidance | No runtime impact, but release evidence must use the current commands. |
| July 27 migrations | Two additive/behavioral database migrations | Reported production schema is behind; Owner 2 must reconcile exact migration history before application release. |

## July migration compatibility with old production code

`20260727100000_atomic_studio_comp_management.sql` adds an operator comp RPC plus a metadata-preservation trigger while preserving the existing subscription columns read and written by code at `6596cc5`. Old code does not call the new RPC. Its existing whole-row/metadata update shapes remain valid; when a newer operator comp provenance block exists, the trigger conservatively keeps that block instead of accepting a stale metadata snapshot. `20260727110000_order_billing_events_after_studio_comps.sql` only adds the guarded clear RPC used by newer application code; old code does not call it, so applying that function does not alter the old webhook path. Neither migration removes a column, changes an old RPC signature, or adds a new required request/response field.

That compatibility is source-derived, not authorization to migrate production. The reported production count of 84 versus 86 migrations means Owner 2 must identify the exact missing versions, verify checksums/order, and apply only through the approved migration workflow. The pair should land before deploying application code that depends on atomic comp management.

The operational-alert migration is intentionally named `20260801060000_operational_alert_delivery_state.sql`, strictly after Owner 3's reserved `20260801050957` migration. It is additive and service-role-only; code at `6596cc5` does not reference it. Compatibility of the final combined migration chain cannot be signed off until Owner 3's migration is present in the integration branch and the full chain replays. Owner 2 should rerun the migration inventory and exact-head contract replay on that integrated candidate.

## Release ordering

1. Integrate Owner 3's `20260801050957` migration, then this `20260801060000` migration without renumbering either.
2. Have Owner 2 reconcile the production migration ledger and prove the July pair plus the integrated newer migrations in staging.
3. Run the exact-head release candidate gate.
4. Deploy Render and Vercel from the same approved full SHA.
5. Run `npm run verify:deployed-release -- ...` and stop on any SHA/environment/origin mismatch.
6. Only after exact-SHA verification, capture dashboard performance evidence.

No performance capture from `6596cc5`, a mutable branch alias, or a mismatched Render/Vercel pair is current-release evidence.
