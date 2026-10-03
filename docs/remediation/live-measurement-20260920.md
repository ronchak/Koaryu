# Production measurement, September 20

Read-only observations at 03:45 UTC covered the V47 application pair `a4ef25910e76ed4b4111699f7b61ff02c30a67a0`. The requested window began September 15 at 04:12 UTC. Provider retention limits make this an incomplete measurement, not evidence that performance meets budget.

| Evidence | Observed result | Limit |
| --- | --- | --- |
| Render hourly HTTP totals | 171 requests: 165 HTTP 200, three 401, two 404, one 502 | Includes operational and OPTIONS traffic; not a customer-navigation sample |
| Render 4xx / 5xx proportions | 2.9% / 0.6% of those totals | The isolated 502 is in the September 15 05:00 UTC bucket; retained logs do not establish its route or cause |
| Retained API access logs | Ordinary routes returned 200; three dashboard-summary 401s; no application 5xx found | Different retained log coverage; cannot infer a complete launch-wide error rate |
| Render memory warnings | 12 warnings, 400–415 MiB resident memory | No demonstrated ordinary-flow failure |
| Vercel retained production logs | One request, HTTP 200; zero retained performance/error records | Insufficient coverage for launch-wide claims |
| Navigation latency and requests per navigation | Unmeasured for dashboard, students, billing and schedule | No approved authenticated production browser state was available |
| FCP p75, LCP p75, APIs before dashboard content | Unmeasured | Cannot compare against 1.8 seconds, 2.5 seconds and two requests respectively |
| Slow endpoint timings | Unmeasured | Provider latency query was unavailable on the current plan |

The existing production capture only covers the dashboard. The four-route functional tool is staging-only and permits writes. It was not repurposed for production. No synthetic load, instrumentation, impersonation, account reset or credential hunt was performed.

No ordinary-flow error class or performance breach above the owner's 50% threshold was established. The conditional optimization reserve was left unspent. This does not establish that the earlier 3.1-second / 42-request navigation result has improved. The next measurement needs approved production browser state and a bounded read-only capture plan.

## Billing scope decision

The production read at 03:40:50 UTC grouped the currency values in `billing_invoices`, `billing_payments` and `billing_plans`. Results were seven USD invoices, five USD payments and five USD plans, with no other currencies. Under the owner's rule, PROGRAM-CURRENCY-01 remains deliberately deferred for mixed-currency totals and decimal formatting; PR220 fixes only invented subscription facts, BB2-08. No historical records were converted or backfilled.

A separate read found five active enrollments and zero provider-linked active enrollments. The activation defect is real and reproducible, but this observation does not support a claim that production was already undercharging a provider subscription. PR219 corrects the defect before that condition occurs here.

Raw provider records, query text, timestamps and privacy-safe row hashes are retained outside Git under `/Users/openclaw/Koaryu Releases/20260919-live-corrections`. This document contains no customer identifiers or credentials.
