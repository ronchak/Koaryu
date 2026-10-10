# Dashboard loading verification

The change removes stacked route fallbacks and preserves successful page data between
visits within one signed-in studio. Cold placeholders use the destination layout and reveal
after 220 milliseconds. Returning to a loaded page revalidates its data without replacing the
page with a full loader. Unsaved form edits and errors are not retained.

The resumed implementation starts from `9b65617`, including the four integrated page
workstreams. Its predecessor is `1dc2f4c9c58d67fcfe6906c413ac93c75e5b86b5`.
No backend, database, dependency or deployment configuration changes are included.

## Coverage

| Risk                                                    | Proof                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong page skeleton, layout shifts, cached-page flashes | Loading contract/region tests, route build and local navigation capture                                                                                                                             |
| User, studio or role data crossing identity boundaries  | Retained-store isolation, identity lifecycle and request-ownership mounted tests                                                                                                                    |
| Cached financial data enabling actions                  | Billing remount, capability re-verification and denial mounted tests                                                                                                                                |
| Cached student records enabling stale edits             | Revisit holds the authoritative read, checks visible complete data with editing disabled, then verifies current data; 403/404 clears records and 503 preserves presentation with mutations disabled |
| Cached automation drafts overwriting newer rules        | Untouched revisit picks up current rule; edits overlapping a changed revision require explicit readback; successful pause preserves edits and advances the next save revision                       |
| Wrong reporting window or calendar response             | Existing date/range retention and superseded-read tests                                                                                                                                             |

## Local results

The prior full frontend run completed with 2,197 passing and 10 failing tests, zero skips.
Those failures were retained as failures until their affected owners passed. Unchanged
checks from that run were reused; the database verification inputs are unchanged.

From `frontend/`:

- `node --experimental-strip-types --test --test-concurrency=2 tests/billing-data-mounted.test.mjs tests/dashboard-identity-gate.test.mjs tests/identity-lifetime-mounted.test.mjs tests/roster-presentation.test.mjs tests/workflow-composition-mounted.test.mjs tests/records-workspace-contract.test.mjs tests/missed-class-automation-mounted.test.mjs`: 132 passed, zero failed or skipped. Covers every original failure.
- `node --experimental-strip-types --test --test-concurrency=2 tests/workflow-stabilization-mounted.test.mjs tests/dashboard-loading-contract.test.mjs tests/dashboard-loading-regions.test.mjs`: 101 passed, zero failed or skipped, including the new retained student regressions.
- `node --experimental-strip-types --test tests/missed-class-automation-mounted.test.mjs`: final 20 passed, zero failed or skipped, including revisit, overlapping edits and post-pause revision coverage.
- `npx tsc --noEmit -p .`: passed.
- `npx eslint`: zero errors. Two existing warnings remain in the belt-tracker navigation helper and workflow-tools test.
- `npx prettier --check .`: passed.
- `npm run build`: passed with local fixture configuration. The browser fixture also uses a production build with its local service addresses reachable from the shared browser.
- `git diff --check`: passed.

The independent source review found and resolved the student mutation-readiness and
missed-class draft-revision regressions. Its follow-up also verified the post-pause
revision correction. Reviews reused the coordinator's tests.

## Browser evidence and limits

The shared T3 browser exercised the production build against the existing synthetic local
Supabase and FastAPI fixture. At 1440 by 900, the original Students → record → Students
flow was captured with 150 milliseconds added to browser fetches. The detail route showed
the actual student's heading throughout; no roster skeleton appeared there. Back to Students
rendered all 32 rows without a roster placeholder. Belt-history fields used their own
placeholders while the first history read completed.

The wider tour covered Dashboard, Students, Belt Tracker, Leads, Schedule, Billing,
Automations, Reports and Settings, including revisits. All settled without visible alerts or
horizontal document overflow. At 390 by 844, cold student-detail, Reports and Billing entries
also settled without alerts or document overflow. Mounted workflow tests separately verify
mobile step placeholders and desktop graph placeholders.

A local fixture address initially caused Billing's server-side access check to reach a 503.
The local backend relay corrected the address; Billing and its revisit then passed. This was
not recorded as an application failure or waived as successful verification. Recordings and
screenshots remain outside the repository.

These are local and synthetic proofs. They do not claim production login, delivery, financial
operations, or hosted performance. The exact-head Release candidate gate remains required
before any guarded merge. This PR does not authorize deployment.
