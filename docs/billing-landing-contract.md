# Billing landing read contract

The landing endpoint resolves active staff membership once. Authorization remains fresh on every request and all mutations retain their existing endpoint checks.

| Dataset | Admin | Front desk | Instructor / inactive staff | Core subscription required |
| --- | --- | --- | --- | --- |
| System checks, workflow capabilities, Connect status | Read | Read with role-filtered capabilities | Denied | No |
| Platform subscription details | Read | Never fetched; null | Denied | No |
| Counts, invoice balances, payment cohort | Read | Read | Denied | Yes |
| Existing financial tab datasets | Read | Read | Denied | Yes |

A denied or unavailable subscription check leaves diagnostic status accessible. Financial aggregates are null and `financial_access` says `subscription_required` or `unavailable`; neither becomes zero. Standalone status and recovery endpoints remain supported. Connect status preserves its provider refresh rules and may have side effects during setup.

Counts cover all studio records. Active students are non-deleted roster records with `status = 'active'`. Failed payers means payer billing status `past_due` or `failed`, not invoice count. Invoice balances include draft, open, partially refunded and uncollectible invoices and clamp each remaining balance at zero. Payment totals use the processed-at UTC month and the existing explicit-zero, null, refund and dispute rules.

Deploy the additive database migration and backend before the frontend. There is no fallback to legacy fan-out on endpoint, authentication, subscription or transport errors. Keep standalone endpoints during the rollback window through the next verified release; a frontend rollback may use them while the additive RPCs remain installed.

Tab reads are retained in the mounted Billing controller for 30 seconds, scoped to user, studio, effective role and identity generation. Token renewal preserves that scope. Tab activation loads its own dependencies. Explicit refresh, successful mutations and Connect return invalidate retained tab data and revalidate landing. Leaving Billing releases its retained data. Financial authorization is checked again by each backend mutation.

Invoice and payment history use bounded 50-row pages ordered by creation time and ID. Cursors bind to studio and dataset; each response declares completeness and the next cursor. Invoice and Reports tabs expose older history without using those pages as an aggregate source. Reports activates payer selectors and payment history for external payments and refunds. Existing plan, payer and enrollment selectors retain their current read contracts; student selectors are loaded only on Enrollments and Invoices.

Both history tables have `(studio_id, created_at DESC, id DESC)` indexes. Cursor
queries keep the original timestamp/ID predicate and add the equivalent
`created_at <= cursor_timestamp` bound. This avoids scanning newer timestamps
while preserving one query and exact page membership. Work within one timestamp
group still grows with the number of greater IDs already passed. Large imports
can produce large tie groups, so this is not a universal constant-cost guarantee.

The September 5 local PostgreSQL 17 comparison used 190,000 rows per table, with
10k and 100k target histories, eight other studios, ten-row timestamp ties and
15 measured queries after two warmups. At 100k, invoice/payment first-page medians
fell from 23.001/14.699 ms to 0.035/0.025 ms. Deep-page medians fell from
13.779/14.276 ms to 0.037/0.037 ms with the indexes and cursor bound. Indexes alone
still filtered 90,000 rows on those deep pages and regressed the 10k cases.
The SQL contract separately verifies exact IDs across a 5,000-row timestamp tie.

Each measured index occupied 10.73 MiB at 190k rows, about 59 bytes per row.
Local 1,000-row insert probes showed roughly 9% invoice and 7% payment overhead,
with about 121/97 additional WAL bytes per row. These synthetic SQL measurements
exclude HTTP/provider latency and durable-write timing because the disposable
verifier disables fsync; update throughput was not measured. V38 and the guarded
rollout attest both index definitions, order and validity. V37 compatibility
rejects a V38 installation whose required history index is missing or invalid.

The portable SQL contract tests missing and wrong-order indexes using owner DDL
and confirms restored indexes are valid, ready and live. Direct corruption of
those catalog flags belongs to `scripts/verify-supabase-contracts-local.sh`, whose
disposable PostgreSQL superuser checks each flag on both indexes against the raw
manifest, V38 readiness and V37 compatibility. Supabase's constrained `postgres`
owner cannot update `pg_catalog.pg_index`; the portable contract needs no such grant.

System diagnostics, platform status and financial access fail independently in landing composition. A diagnostic failure cannot hide the administrator's platform subscription recovery. The normal composition reuses the reporter's Connect account; only a failed reporter attempts the standalone Connect status read.

Landing has one 30-second deadline covering membership resolution and all
projections. After membership succeeds, financial data, administrator-only
platform recovery and diagnostics run independently on the bounded interactive
provider lane. Each operation uses its worker's own client. Completed projections
remain in the single response when another projection exhausts the remaining
deadline; unavailable fields carry their existing errors. There is no shorter
diagnostic cutoff. Membership failure still rejects the request, and financial
totals still require independently verified subscription access. A timed-out or
cancelled caller does not free provider capacity early: the runtime retains the
source operation and its client until the underlying work finishes.
After membership succeeds, even failure of every projection returns HTTP 200
with the structured landing response: unavailable fields are null,
`financial_access` is `unavailable`, and `errors` explains the failed reads.
This differs from a membership failure or timeout, which rejects the request.

The new schema is V38 at 133 migrations, head `20260905022339`. Backend readiness
uses `koaryu_release_schema_preflight_v19`; the previous V18 entry point retains
the exact V37 response through a checked compatibility bridge. The guarded
rollout independently checks the new RPC bodies, signatures, ownership and
permissions. Production application remains an owner-run interactive operation.

Invoice history loads and advances only the invoice cursor. Reports loads and
advances only the payment cursor. A retained cursor from another tab cannot
advertise older history or trigger invisible page reads.

Read errors are retained with their access scope and tab. A cached revisit restores
its own error and the retained landing warnings, rather than inheriting another
tab's failure. Successful retries, refresh and scope changes clear the appropriate
error state alongside the data they replace.
