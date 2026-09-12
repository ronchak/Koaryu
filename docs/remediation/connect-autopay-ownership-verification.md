# Connect and autopay ownership verification

Base: `27eddf05c73de829d27fd8ed15eda8e00a066548`. Implementation: `295f393b611c9b6dbc9987988267a2f47bf2be01`.

Connect actions and autopay now receive the database client, account store, settings and Stripe factory directly. The account store owns strict readiness and the existing history check. Connect owns its studio/email lookups and best-effort reports. Redirects use the existing shared implementation. Three copies of the ordinary billing audit insert become one unchanged function in `billing_audit.py`; durable audit repair and consent routines are untouched.

## Change and assurance

The affected production source changes from 5,059 to 5,066 lines, including the new audit module. It loses 1,211 bytes and nine net function/method definitions, from 188 to 179. Explicit dependencies and argument formatting add physical lines; this is a reduction in duplicated rules and opaque ownership, not a claimed line-count reduction. The private facade falls from 24 to 18 methods. Its remaining readiness/audit callers still use temporary forwarding until their own ownership changes.

The two edited test files change from 5,215 to 5,227 lines for explicit constructor dependencies. All 79 test definitions/cases and 508 assertion nodes remain unchanged. No new source-text test, fixture framework or test for moved code. The existing cases protect onboarding recovery, authorization, redirects, consent and audit failures; none was removed to manufacture a smaller count. The cumulative billing test line change since PR183 remains negative.

Coordinator verification matched 165 retained methods after the declared dependency substitutions, five relocated owner bodies, all three original audit inserts against the single relocated function, and both removed redirect bodies against the existing shared functions. Constructor/factory changes and remaining facade forwarding were reviewed directly. All 508 assertions match the base AST. An independent runtime check covered the audit payload, ordinary error propagation, both best-effort reports and propagation of account-read failures; it performed no external I/O.

The coordinator and implementer each passed the 169 affected tests. Full backend: 1,904 passed. Formatter, API types and release-workflow checks passed; the workflow check ran 128 cases. Fresh independent exact-head review and CI remain required before guarded merge.

No provider operation, deployment, migration, SQL contract change, new persisted state, financial backfill or billing activation. BB1-09 stays pending for the remaining invoice, payment, reconciliation and enrollment owner graph. ACS1-07 remains separately pending because the public transition response contract has not changed.
