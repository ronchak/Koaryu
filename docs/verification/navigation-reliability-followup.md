# Navigation reliability follow-up

This work follows the September 6 production navigation review. Delivery is split
into recovery, data loading and measurement, and measured deployment and bundle
improvements. All candidates require the exact-head Release candidate gate.

## Recovery

Temporary Supabase user-read failures retain session and studio cookies. User
reads have one bounded retry and an eight-second total deadline, including SDK
work. Missing or rejected credentials still require sign-in. Late SDK callbacks
cannot change response cookies after the deadline. Rate limits are not retried
without their Retry-After information.

Unavailable navigation retains a validated application destination in `returnTo`.
Try again makes a fresh document request to that destination. The informational
status route is not itself a health probe; middleware emits a privacy-safe
`auth_unavailable` event for the actual failure.

The root layout embeds its build identity. History restoration, a return after
30 seconds hidden, and reconnecting trigger a bounded, deduplicated version
check. A changed build offers refresh without replacing unsaved work. Refresh
waits for API commands to settle. Unknown versions, another environment, and
network failures do not trigger reload. Existing open builds without this code
need one initial refresh. Same-build restoration emits `koaryu:resume` for workspace revalidation.

Sidebar feedback stays inside its fixed icon slot and appears only after 200 ms.
Reduced-motion mode uses a static indicator. Release CI exercises side, collapsed,
top and mobile navigation, recovery destination, and an update with an open form.
The update test supplies a persisted pageshow event; it verifies lifecycle handling,
not a claim that every browser history navigation uses bfcache.

## Route-owned loading and freshness

Startup bootstrap now selects the route's projection. Schedule and Settings read
studio and program metadata only; Leads and Reports add leads; Belt Tracker adds
belt plans. Students and Dashboard retain their required projections. Billing and
account/help pages do not fetch a dashboard bootstrap. Omitted data stays unloaded,
so later navigation can request it. Changing routes cancels an obsolete bootstrap.

Lead collections now use scoped keyset reads in pages of 500, verify completeness
against an exact count, and refuse more than 10,000 rows before downloading the
collection. A changing collection or exhausted page budget returns an explicit
error instead of presenting partial rows as complete totals. This retains the
existing complete-collection API; a larger lead workspace needs a separately
paginated product flow instead of raising the memory budget.

Same-build resume rechecks the authoritative workspace after in-flight commands
settle. A changed user, studio, role or membership resets the previous scope. A
network failure retains current work with a retry warning. Successful access
verification refreshes the mounted route's data without remounting forms. Schedule
resume reads existing sessions and refreshes open attendance; it does not issue a
new materialization command merely because the tab became visible.

Ordinary dashboard visits can use the existing 15-second fact cache. Explicit
refreshes and command reconciliation still request fresh facts and supersede an
older cached visit read. A local or same-origin-tab command forces fresh reads for
60 seconds, covering a late previous interactive read and its subsequent cache TTL.
Only a timestamp is shared between tabs; no identity or business data is stored.
Billing reads also mark facts changed because some status GETs reconcile provider
state. Access checks still precede backend fact-cache reads.

Verification includes per-route projection counts, provider row-cap boundaries,
a resumed open form, changed access scope, and fresh-versus-old summary races.

## Remaining review items

- Record click-to-content latency and retain privacy-safe production metrics.
- Evaluate cheaper page identity verification against revocation requirements.
- Align operation deadlines and measure function locality.
- Trial intent prefetch and profile initial production bundles before splitting them.

Implementation evidence and completed items must be updated in each follow-up PR.
Existing authorization, command-outcome and subscription protections remain
acceptance criteria throughout.
