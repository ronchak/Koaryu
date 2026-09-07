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
collection. A changed collection size or exhausted time budget returns an explicit
error instead of silently accepting the provider row cap. The count verifies row-count completeness, not an atomic database snapshot.
Like ordinary paginated lists, concurrent edits can span pages; authoritative
dashboard totals continue to come from the aggregate fact RPC. This retains the
existing collection API; a larger lead workspace needs a separately
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

## Measurement and deadlines

Navigation measurements start at the primary navigation click or history event,
then record route commit and useful/complete content after a paint opportunity.
They include time waiting for middleware and the route response. Same-path
query/hash history changes do not start a pathname navigation timer. Interrupted and
superseded navigation are separate outcomes. Existing document-relative capture
marks remain available, with bounded mark history for long-lived tabs.

Ten percent of production page lifetimes send small batches to the same-origin
`/api/performance` endpoint. Only fixed route/metric labels, bounded numbers,
outcomes and public build identities are accepted. Raw paths, queries, identities,
credentials and business records are rejected. The endpoint accepts at most 4 KiB
and 10 events per batch, bounds body-read time, and limits logging per instance.
Staging, preview and disposable builds do not collect production samples. The
collector records its authoritative environment and rollups reject non-production
records. Collection failure never blocks navigation and is not retried. These measurements
use existing Vercel runtime logs, subject to the current provider retention; they
are not a new durable analytics database or a paid subscription. Export rollups
before those logs expire when longer comparisons are needed.

Run `npm run summarize:performance < private-vercel-log-export.ndjson` to produce
aggregate p50/p75/p95 measurements grouped by build, route, metric, navigation kind
and outcome. The report excludes unrelated log content and flags samples below
100 as insufficient for tail comparisons. Route timing is not field INP; INP,
LCP and CLS remain separate measurements. Use p75 for Core Web Vitals targets.

The backend now applies one request deadline across auth, provider admission,
multiple operations, and body transfer: 30 seconds for interactive requests and
120 seconds for designated bulk operations. The proxy allows 34/125 seconds and
the browser allows 35/130 seconds for reads. Body-bearing browser requests add
60 seconds for bounded proxy upload/buffering, giving 95/190 seconds; the proxy
rejects an unfinished upload before forwarding it and permits 190 seconds of
function execution. Explicit auth-navigation reads retain their
short fail-fast budget. Confirmed writes are never replayed because a response
was lost; incomplete responses preserve the unknown-command outcome. Backend
logs include only route templates, method, status, timing and release identity.
Cleanup can finish after a complete response body is delivered.

Verification includes an intentionally held route response, fresh-vs-old summary
races, bounded telemetry input, multi-stage deadline exhaustion, stalled response
bodies, completed-response cleanup and workload classifications.

## Auth verification decision

The installed Supabase SDK was tested with a synthetic signed token and a revoked
session response from its authority. `getClaims()` accepted the still-valid token
without consulting the authority; the current `getUser()` check rejected it.
Replacing the page check would therefore change the existing revocation behavior.
We retain authoritative verification and its bounded outage recovery. Faster
navigation comes from route caching, intent prefetch and measured locality without
silently weakening that check. The test uses a generated key and fake transport,
not a production token. Backend membership and subscription checks remain fresh.

## Delivery and bundle improvements

Heavy primary navigation links prefetch after hover or keyboard focus, with a
shared rate limit and a 30-second per-destination cooldown. Data-saving and 2G
connections skip this speculation. The prefetch opportunity expires after three
seconds so a visible link does not keep repeating speculative work. Only route
resources are prefetched; Billing data and provider reconciliation remain owned
by the visited page.

The production bundle inspection identified Schedule dialogs as deferrable.
Class and attendance dialogs now load when opened and have an accessible loading
status. On matched local production builds with preview disabled, Schedule's
initial HTML referenced 1,073,195 JavaScript bytes before and 1,048,876 after,
a reduction of 24,319 bytes. This measures uncompressed referenced assets, not
network transfer, hydration CPU, or a user-latency percentage. Other routes were
within 11 bytes in that comparison. Shared framework and auth code were retained.

Vercel Functions are pinned to `pdx1` alongside the Oregon dependencies. Record
provider readback and routing-probe results with release evidence before claiming
a hosted improvement. There is no Render plan upgrade. Deployment IDs prefer the
provider-assigned ID and otherwise use the Git SHA, allowing Next.js to detect
version mismatches on navigation. This complements the history restoration check;
it does not replace compatibility with the independently deployed backend.

Implementation evidence and completed items must be updated in each follow-up PR.
Existing authorization, command-outcome and subscription protections remain
acceptance criteria throughout.

Resume reconciliation also refreshes dependent selectors, activity feeds and
promotion history. Selected sessions follow the current collection and close when
removed. Independent projection failures do not suppress unrelated refreshes.
Commands begun during access verification queue a fresh pass after settlement;
403 clears prior tenant data, and successful subscription recovery leaves the
blocked state. An older build still revalidates access while awaiting a user
refresh, without requesting potentially incompatible feature payloads.
