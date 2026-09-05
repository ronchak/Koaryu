# Billing landing read contract

The landing endpoint resolves active staff membership once. Authorization remains fresh on every request and all mutations retain their existing endpoint checks.

| Dataset | Admin | Front desk | Instructor / inactive staff | Core subscription required |
| --- | --- | --- | --- | --- |
| System checks, workflow capabilities, Connect status | Read | Read with role-filtered capabilities | Denied | No |
| Platform subscription details | Read | Never fetched; null | Denied | No |
| Counts, invoice balances, payment cohort | Read | Read | Denied | Yes |
| Existing financial tab datasets | Read | Read | Denied | Yes |

A denied or unavailable subscription check leaves diagnostic status accessible. Financial aggregates are null and `financial_access` says `subscription_required` or `unavailable`; neither becomes zero. Standalone status and recovery endpoints remain supported. Connect status preserves its provider refresh rules and may have side effects during setup.

Counts cover all studio records. Active students means exactly `status = 'active'`. Failed payers means payer billing status `past_due` or `failed`, not invoice count. Invoice balances include draft, open, partially refunded and uncollectible invoices and clamp each remaining balance at zero. Payment totals use the processed-at UTC month and the existing explicit-zero, null, refund and dispute rules.

Deploy the additive database migration and backend before the frontend. There is no fallback to legacy fan-out on endpoint, authentication, subscription or transport errors. Keep standalone endpoints during the rollback window through the next verified release; a frontend rollback may use them while the additive RPCs remain installed.

Tab reads are retained in the mounted Billing controller for 30 seconds, scoped to user, studio, effective role and identity generation. Token renewal preserves that scope. Tab activation loads its own dependencies. Explicit refresh, successful mutations and Connect return invalidate retained tab data and revalidate landing. Leaving Billing releases its retained data. Financial authorization is checked again by each backend mutation.

Invoice and payment history use bounded 50-row pages ordered by creation time and ID. Cursors bind to studio and dataset; each response declares completeness and the next cursor. Invoice and Reports tabs expose older history without using those pages as an aggregate source. Reports activates payer selectors and payment history for external payments and refunds. Existing plan, payer and enrollment selectors retain their current read contracts; student selectors are loaded only on Enrollments and Invoices.

System diagnostics, platform status and financial access fail independently in landing composition. A diagnostic failure cannot hide the administrator's platform subscription recovery. The normal composition reuses the reporter's Connect account; only a failed reporter attempts the standalone Connect status read.

The new schema is V38 at 133 migrations, head `20260905022339`. Backend readiness
uses `koaryu_release_schema_preflight_v19`; the previous V18 entry point retains
the exact V37 response through a checked compatibility bridge. The guarded
rollout independently checks the new RPC bodies, signatures, ownership and
permissions. Production application remains an owner-run interactive operation.

Invoice history loads and advances only the invoice cursor. Reports loads and
advances only the payment cursor. A retained cursor from another tab cannot
advertise older history or trigger invisible page reads.
