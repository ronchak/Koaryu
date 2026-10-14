# Koaryu Frontend

Next.js App Router frontend for Koaryu.

The frontend currently targets the Next.js 16 line. Keep `next` and `eslint-config-next` aligned in `package.json`, and keep the checked-in lockfile updated whenever security or framework dependencies change.

Use Node.js 22.13+ for frontend scripts and tests. The Node test runner command uses type stripping for `.ts` imports, so Node 18 is not a supported frontend test baseline.

## Environment

Create `frontend/.env.local` from the checked-in example:

```bash
cp .env.example .env.local
```

Required variables:

- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key for browser and SSR auth
- `NEXT_PUBLIC_API_URL`: backend API base URL, typically `http://127.0.0.1:8001/api/v1`
- `NEXT_PUBLIC_SITE_URL`: frontend origin used for auth callback links, typically `http://localhost:4000` locally and `https://koaryu.app` in production
- `BACKEND_API_URL`: server-only backend API base URL for Next.js API proxy and cron routes; defaults to the public API URL only when this is not set
- `CRON_SECRET`: server-only Vercel Cron secret for scheduled internal maintenance routes
- `ACCOUNT_DELETION_WORKER_SECRET`: server-only secret used by the Vercel Cron route when it calls the protected Render account-deletion worker
- `NEXT_PUBLIC_USE_API_PROXY` (optional): set to `true` only when browser API calls should go through the Next.js proxy route instead of directly using `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_PREVIEW_MODE` (optional): set to `true` for static preview/demo data instead of live auth and backend bootstrapping

Preview fixtures, including Billing, load through one adapter before the preview store initializes. The literal build-time flag guards its dynamic import; live builds omit the adapter and sample records. Home builds its preview payload from that adapter’s fixtures. Mounted tests preserve the asynchronous import boundary in the CommonJS packer; standalone Billing fixtures explicitly await the same adapter before mounting.
- `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER` (optional): defaults to `true`; set to `false` as a rollback switch for the backend-paginated Students roster
- `NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG` (optional): set to `true` temporarily to log Koaryu performance marks and Web Vitals in production

The `NEXT_PUBLIC_` variables are read during `next build`, so they must also be configured on Vercel before production deploys. The server-only backend URL and cron secrets are read by deployed routes at runtime and must not be exposed as `NEXT_PUBLIC_` values.

Production deploys should be verified after every dependency update with `npm run lint`, `npm run build`, and a Vercel deployment check. A local build proves the static/runtime bundle compiles, but it does not prove Vercel has the right environment values baked into the deployed build.

## Social sign-in

Login and signup offer Google, then Microsoft, before email. Google configuration
and required staging checks are in [Google SSO setup](../docs/google-sso-setup.md).
Both providers use the existing PKCE callback and membership routing. Microsoft
configuration and required account-type tests are in
[Microsoft SSO setup](../docs/microsoft-sso-setup.md). Keep production
`NEXT_PUBLIC_PREVIEW_MODE=false`; provider client secrets belong only in Supabase.

## Development

Admins can configure the missed-class email rule at `/automations`. Preview the
current draft before enabling or saving an enabled rule. Paused rules can be
saved before email setup; pausing keeps the saved message and any unsaved draft.
Delivery readiness distinguishes disabled, approved-recipient test, and live
sending. Provider acceptance does not confirm inbox delivery. After a stale or
uncertain save, check the saved rule before writing again; only **Reload saved
rule and discard edits** replaces a local draft. Browser preview mode uses sample
data, makes no automation API calls, and cannot enable or send email.

```bash
npm install
npm run dev
```

The local dev server runs at [http://localhost:4000](http://localhost:4000).

`next.config.ts` pins both Turbopack and output tracing to the repository root
so a lockfile above the repository cannot change the workspace root. Keeping the
tracing root at the monorepo level also preserves Vercel's frontend asset paths.

If development stalls at `Compiling /` while a production build serves normally,
stop the dev server and move `.next/dev/cache/turbopack` to a temporary directory
outside the frontend. Restart and test `/` before opening a browser. This isolates
persisted compiler state without deleting the production build or changing code.
Keep the old cache until recovery is verified; increasing browser test timeouts
does not repair a stalled compiler.

## Trial appointment command and time checks

`useLeadStore().trialAppointments` owns one pending trial command per lead. Its
metadata-only session journal retains operation and owner IDs; explicit Check
result reads the receipt, exact current appointment, then exact current lead.
Unknown results never replay a mutation. An initially malformed journal blocks new trial
commands without reserving ordinary lead rows; protected history reads still
work. Explicit storage recheck only verifies and adopts metadata.

Shared appointment time helpers preserve untouched saved instants, including
fractions. New local schedules lazy-load Temporal and require an explicit choice
for ambiguous times. A server-named zone unavailable locally remains readable,
recoverable and cancelable; schedule editing requires a supported replacement.
The facade tests use synthetic exact-detail responses. They do not establish
runtime readiness of the backend exact-detail route, whose mounting is tracked separately.

```bash
node --experimental-strip-types --test tests/appointment-time.test.mjs tests/trial-appointment-operation.test.mjs tests/trial-appointment-mounted.test.mjs
```

## Lead creation recovery

Add lead retains one operation ID before submitting. If confirmation is lost,
**Check result** reads the original receipt and the current lead without repeating
the create request. The blocker survives closing the form, navigating away,
provider remounts, and reloads in the same browser session. Only the currently
verified admin or original front desk owner can resume it. Other lead work remains
available.

The session-storage journal contains only operation, owner, studio and confirmed
lead IDs. It never saves contact fields, notes, tokens or form contents. Unavailable
or malformed storage blocks new creates. A missing receipt stays unresolved. If
creation is confirmed but the current lead returns 404, the UI says that the lead
was created but is no longer available. It publishes no historical receipt row.
Clear/reset fences held reads while preserving unresolved operation markers.
Preview keeps local sample creation and never uses this journal or live recovery.

Run the synthetic recovery checks from `frontend/`:

```bash
node --experimental-strip-types --test tests/lead-create-operation.test.mjs tests/lead-create-mounted.test.mjs
```

## Build

```bash
npm run build
```

If the build fails with `@supabase/ssr: Your project's URL and API key are required`, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the current environment.

## E2E Checks

Playwright checks are opt-in because they need a running frontend and some of
them touch state. The full e2e command is:

```bash
npm run test:e2e
```

The landing-page history regression needs only a running local frontend, with no
login or database setup. Run it with one browser worker:

```bash
npx playwright test e2e/marketing-journey-history.spec.ts --workers=1 --max-failures=1
```

It checks explicit chapter links, Back/Forward, duplicate clicks, and replacement
of the current history entry during keyboard chapter navigation.

The preview CSV-import check runs against preview mode and uses the checked-in
demo CSV:

```bash
KOARYU_PREVIEW_E2E=true npm run test:e2e:preview-import
```

For a fast, read-only check of preview login, responsive dashboard navigation,
and the public marketing pages, start the frontend with
`NEXT_PUBLIC_PREVIEW_MODE=true`, then run:

```bash
npm run test:e2e:preview-smoke
```

The mounted belt editor check verifies browser save behavior and repeated rank
payloads without credentials or a database:

```bash
node --experimental-strip-types --test tests/belt-editor-mounted.test.mjs
```

From the repository root, the separate local Supabase contract check verifies
belt-rank persistence:

```bash
npm run check:supabase-contracts-local
```

These are independent browser-payload and database-persistence checks, not a
joined browser-to-database test.

## Bundle Analysis

```bash
npm run analyze
```

This uses Next.js 16's built-in Turbopack analyzer (`next build --experimental-analyze`) so bundle checks do not require an extra dependency.

## Performance Rollout

See [docs/performance-rollout.md](../docs/performance-rollout.md) before enabling the v0.1.1 rendering changes in production. The short version: keep `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER=true`, let Home load `/dashboard/home` after workspace access is verified, and use the documented switches only for rollback or short diagnostic windows.

## Authenticated loading

The store initializes once per identity scope. Committing a role does not restart
bootstrap or the Auth subscription. Token renewal preserves the identity and
reconciles schedule reads; account/profile scope changes discard the old data.
An unavailable workspace read shows a retryable identity error. Feature bootstrap
failures remain scoped to their datasets and do not fan out into legacy reads. Deploy a backend with `/dashboard/bootstrap`
before this frontend; mixed versions without that endpoint are unsupported.

Home uses `/dashboard/workspace` for the shell and makes no bootstrap or
program-list request. It reads one payload from `/dashboard/home`, including
promotions and preferences. Live paged Students uses the metadata-only `home`
bootstrap view; preview and the full-roster fallback keep `view=students`. It has
one loading, error or ready state; panels do not fetch independently. Preview
mode supplies the same payload shape locally. See Dashboard loading below for
retained paint, revalidation and readiness markers.
Settings refreshes usage when opened, shows loading or unavailable usage
explicitly, and retains successful usage while refreshing. Bootstrap rows never
establish paginated roster authority. Mutations preserve an incomplete roster's
partial status; only an explicit complete read clears it. Billing Enrollments
waits for that complete read before using the roster.

Schedule initialization and visible calendar ranges use the same reconciliation
queue. New ranges remain pending until their materialization completes. Refresh
keeps the current range visible, and obsolete range responses cannot replace a
newer window or attendance mutation.

The default frontend test suite includes a mounted StoreProvider test in
Chromium using synthetic external I/O. Install its browser with
`npx playwright install chromium` before running `npm test`. It exercises both
production React and development Strict Mode without a running application,
credentials, or a database.

## Landing Page And Backend Warmup

The `/` landing page is intentionally outside the Supabase auth middleware matcher so it can paint immediately as informational UI. After hydration, `BackendWarmup` calls `/api/proxy/health` in the background. That request wakes the Render backend without blocking the landing page or requiring a logged-in session.

Keep `/login`, `/signup`, `/onboarding`, `/subscription-required`, and dashboard routes in the auth proxy matcher. Those routes still depend on the normal Supabase session and backend profile checks.

## API Proxy And Studio Identity

Studio identity is always derived from the authenticated backend user before data access. Koaryu supports one authoritative `staff_roles` membership. An unexpected historical multi-membership is rejected before any legacy `X-Studio-Id` selector can influence resolution; the rows are preserved for bounded support remediation. For a valid single membership, `X-Studio-Id` is only a matching selector and never grants access by itself.

When `NEXT_PUBLIC_USE_API_PROXY=true`, browser API requests go through `/api/proxy`. In that mode the browser API wrapper does not send `X-Studio-Id`, and the proxy ignores any caller-supplied studio header. The proxy forwards `X-Studio-Id` upstream only from the `koaryu-active-studio` cookie observed by the Next.js server. Direct browser-to-backend mode still attaches the active-studio header because there is no Next.js server boundary to derive it, but the shared browser API helper strips any caller-supplied studio header before it adds the active selector.

## Vercel

The frontend Vercel project should use this `frontend/` directory as the app root and define these Production environment variables:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_API_URL production
vercel env add NEXT_PUBLIC_SITE_URL production
vercel env add BACKEND_API_URL production
vercel env add CRON_SECRET production
vercel env add ACCOUNT_DELETION_WORKER_SECRET production
```

Use the Preview environment too if PR or branch deployments need to boot against Supabase and the backend.

For production, `NEXT_PUBLIC_API_URL` should point to the deployed Render API base, for example `https://koaryu.onrender.com/api/v1`. `BACKEND_API_URL` should point to the same backend base for server-side proxy and cron requests, without exposing that authority as the browser-facing source of truth.

`CRON_SECRET` cannot contain leading or trailing whitespace. Vercel rejects cron requests with an invalid bearer header if the secret was pasted with an accidental newline. `ACCOUNT_DELETION_WORKER_SECRET` must exactly match the Render backend value.

After Vercel deploys, smoke-test at least login, dashboard load, Settings, Billing, and the Koaryu Core subscription status from the production domain. These routes exercise Supabase SSR auth, the baked API URL, and the billing path.

## Admin Demo Utilities

Settings includes admin-only demo/data utilities intended for controlled demos and cleanup:

- Demo reset can replace working demo data when the backend allows it.
- Clear studio data uses the shared confirmation dialog before deleting working studio records.
- Both confirmations explain automation pauses, cancellation, retained sending attempts, and retained original operation history including saved details. Results list each returned automation effect separately and remain until dismissed or a new data action starts. Reset counts describe seeded records; clear counts describe removed records. Preview automation effects are labeled sample numbers. An incomplete success response leaves the outcome unconfirmed and does not apply the store update or trigger a retry.

Both tools are destructive. They are designed to preserve Koaryu Core subscription/platform access rows, but they should still be used only against a disposable demo studio unless data loss is intended.

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

Pending staff, program-usage and Home reads recover from token rotation
through their existing owners, with at most two replays using the current token.
Identity changes, sign-out and subscription revocation invalidate that recovery.
Mutations are not replayed. A confirmed missing session or sign-out clears private
state and replaces the route with `/login`. A transient session error instead hides
protected content and offers Retry workspace while preserving SDK credentials.
Null initial-session notifications are confirmed outside the Auth callback lock.
Subscription denial preserves an already verified identity and legal-name gate so
the recovery page can render after studio data is cleared.

Bootstrap partial projections are opt-in through `allow_partial=true`. Healthy
identity and datasets can render even when an independent projection fails;
missing studio/program/belt metadata remains explicit and retryable. Older
frontends retain strict failure behavior. A same-identity token renewal keeps an
in-flight Schedule range caller attached to the existing reconciliation owner;
it cannot hide the newly reconciled range or replay attendance mutations.

## Workflow resource ownership

Belt Tracker owns each rank-plan draft by ladder ID, including both ranks and the
sub-rank term. Program switching is blocked while a draft or rank editor is open.
Saving disables rank edits until the request settles. A rejected save retains the
draft; a confirmed save with a failed refresh reports that the ranks were saved.
Credential renewal may settle a confirmed write within the same verified identity,
but sign-out or a changed workspace cannot restore the old identity's data.

Run the synthetic rank-editor browser regression without an application server,
credentials or a database:

```bash
node --experimental-strip-types --test tests/belt-editor-mounted.test.mjs
```

`/dashboard/workspace` establishes authoritative membership, subscription access and
studio timezone before feature reads. Student detail always ensures a complete
record independently of the lightweight roster. Studio commands mark dashboard facts
changed; Home reconciles with `/dashboard/home?fresh=true`. A failed refresh keeps
known data and reports a warning. Token renewal preserves confirmed writes
and roster position only within the same validated identity scope.

Roster URLs retain bounded filters/sort. One identity-scoped session return record
retains cursor/scroll/focus for 30 minutes. Unknown write outcomes must not be
replayed automatically. Admins can open Automations from the primary navigation
for operational workflow tooling. See `docs/verification/workflow-stabilization.md`
for evidence and limits.

Run deterministic live-mode workflow checks without any external data plane:

```bash
node --experimental-strip-types --test tests/workflow-stabilization-mounted.test.mjs
```

## Refund recovery

When the server enables `payment.refund` for an administrator, Billing keeps the
original refund receipt until the exact payment's current balance is verified.
An accepted request whose read fails offers **Refresh payment**, which performs
only a read and remains available at zero refundable balance. An unconfirmed
request offers **Retry original refund**, using its original amount and reason.
Changing a form cannot turn that unresolved request into a new refund. Generic
tab refresh and cohort totals are not proof that the refunded payment is fresh.
See [refund completion verification](../docs/remediation/refund-completion-verification.md).

Lead conversion navigates as soon as the command returns the student id. It marks
the roster partial and invalidates eligibility; the student detail, next roster
visit and next Belt Tracker visit read their own current data. Conversion does
not start a full roster refresh in the background. A mounted Belt Tracker
re-verifies through its existing read owner. A full roster read already in flight
may retry its stale snapshot once rather than being cancelled by conversion.

## Navigation authentication recovery

Password sign-in synchronizes redirect cookies before navigating; the destination
verifies workspace access without an extra route refresh. The active studio-state
cookie lasts 12 hours; archived and no-studio states expire after five minutes.
Every workspace response re-syncs this hint. It only chooses redirects and never
grants access: workspace and endpoint checks remain authoritative. If workspace
rejects an active selector with generic 403, initialization clears that selector
and reads the profile once without it. Removed or archived membership corrects
the hint and redirects; an active profile permits one more workspace attempt.
The profile alone never restores access.

Navigation checks `/auth/me` when studio state needs refreshing and for Billing
Connect access checks. Ordinary Billing uses the verified workspace role for its
restricted view; billing endpoints enforce access on every request. Billing tab
changes use native history and do not request a new server route. These reads retry once on network failures or HTTP 502/503/504,
with a four-second deadline per attempt including the response body. A short
`Retry-After` is honored; longer waits return the unavailable page without an
early retry. Invalid credentials, denied access, and malformed membership data
retain their existing handling. Request cancellation stops recovery.

The backend shares an in-progress signing-key refresh across authentication
requests. Followers await completion asynchronously for at most three seconds,
then verify their own tokens. Expired keys are never reused to grant access.

Navigation links use Next's default prefetch. Marked prefetch requests skip the
session proxy; document and ordinary RSC navigations retain it. Automatic link
prefetch stays off on save-data and 2G connections. Login warms Dashboard once
on the first input focus or change; record-route intent prefetch remains in place.

### Navigation recovery

Temporary auth-provider errors retain the session and offer a retry of the original
application destination. Returning to an old build offers a refresh without
replacing drafts, and blocks that refresh while API saves are pending. See
[the navigation follow-up](../docs/verification/navigation-reliability-followup.md)
for lifecycle behavior and the release browser checks.

Home skips mount revalidation when its retained snapshot is less than 15 seconds
old and belongs to the current facts generation. Pending commands or the
60-second facts-freshness window always bypass this shortcut. The snapshot records
the read's freshness and generation; reuse never renews its age or read order, and
never clears access refusals. A pending Home read is still joined so its result
reaches the remounted page. Focus, timed and explicit revalidation still run.
Explicit refresh and post-command reconciliation remain fresh. Commands in
this browser or another same-origin tab bypass cached facts for 60 seconds.
All Billing reads, including invoice and payment pages, mark facts at dispatch
and settlement. Their row readers select data, but manager authorization with
`require_platform_subscription=True` can repair `studio_subscriptions` through
`PlatformBillingService.get_access_status_row`. Home's
`DashboardHomeService.resolve_context_sync` verifies that same subscription
access before assembling its payload. This authorization path is not treated
as a fact-neutral read. Plans can also create an account row; landing/status
verification can reconcile provider state.
Returning to a current build checks its version and workspace access concurrently.
Visible data refreshes once only after both permit it; an unavailable or changed
version does not refresh page data. Access loss is applied immediately, while
resume-triggered feature reinitialization and recovery navigation wait for the
version decision. A newer explicit retry or identity invalidates deferred recovery.
Drafts remain mounted while access remains valid.

Sampled production navigation timings and Web Vitals use the existing Vercel logs
through `/api/performance`. The schema accepts fixed route labels and numeric
measurements only. Use the root `npm run summarize:performance` command with a
private log export to compare releases. Interactive API deadlines are 30 seconds
end to end on the backend, 34 at the proxy, and 35 in the browser. Bulk operations
use 120, 125, and 130 seconds respectively for reads. Requests with a body add
a bounded 60-second proxy upload phase to the browser allowance; CSV import
and photo uploads use a 190-second browser limit. Staging and preview traffic
is excluded from production metric collection.

The authenticated dashboard capture records allowlisted HTTP and browser resource
timings for `/dashboard/workspace`, `/dashboard/bootstrap`, and `/dashboard/home`
without retaining URLs, identifiers, or query values. Workspace does not emit
`Server-Timing`, so its HTTP and resource timings are diagnostics only. Home
requires a successful response, a resource entry, and allowlisted
`Server-Timing` measurements (Home's are the `koaryu_home_*` stages). Saving
the layout through `/dashboard/home/preferences` is not counted as Home's payload.

The synthetic mounted-test startup trace records fixture workspace/controller
readiness. It does not prove deployed route usability or measure deployed backend memory.

## Eligibility and report identity lifetime

Eligibility keeps its selected-ladder request owner during token renewal and may
replay a read at most twice. A changed ladder or access identity invalidates the
old owner. CSV exports may finish across ordinary panel or dashboard navigation
and same-identity token renewal. Observed sign-out, user/studio/role replacement,
USER_UPDATED, or access reset suppresses file handoff. The request releases its
Auth listener when it settles. See [identity lifetime verification](../docs/verification/identity-lifetime.md)
for the mounted regression coverage and its limits.

## Trial appointments

Trial appointments live in the selected lead inspector for current admins. Preview labels all trial records as samples and performs no trial API or recovery-journal I/O. Program choices distinguish loading, failed refresh, and a ready empty list. Scheduling uses the chosen event timezone and requires an explicit occurrence when clocks move backward. Unsupported saved timezones and removed program context remain visible for history, repair, and cancellation.

Trial commands use the shared lead reservation and retained recovery owner. A waiting result can be checked above the lead list even after its lead disappears. Check browser recovery record only rechecks storage; Check result reads the command result and current records. Neither action resubmits the command.

Run `node --experimental-strip-types --test tests/trial-appointment-panel-mounted.test.mjs tests/appointment-time.test.mjs tests/trial-appointment-operation.test.mjs tests/trial-appointment-mounted.test.mjs` from `frontend/` for synthetic trial proof. To prepare a disposable manual fixture, run `node tests/helpers/trial-appointment-fixture.mjs /tmp/koaryu-trial-panel-qa`, then serve that directory on loopback. The fixture uses the actual page, provider, inspector and time controls with synthetic auth/API. Its visible controls exercise lost responses, held reads, removed leads and reference failures. Stop the server and remove the temporary directory after review. Inspect the normal preview Next build separately for production CSS and lazy Temporal chunk loading.

### Belt-test events

Administrators can open `/belt-tests` from Belt Tracker, choose an explicit belt plan,
save a draft with complete times, schedule or cancel an event, and review recorded approvals.
Preview uses sample records with no live requests or journal writes. Approvals and
Reapprove use explicit student/membership pairs; neither promotes students nor guarantees delivery.
Event fields and candidate selections stay local. Owned event/query navigation asks
before discarding changes. Leaving the page or reloading discards unsaved input;
pending command results remain available through Check result without repeating the command.

Run `node --experimental-strip-types --test tests/belt-test-panel-mounted.test.mjs tests/belt-test-mounted.test.mjs tests/belt-test-operation.test.mjs tests/belt-test-contract.test.mjs tests/appointment-time.test.mjs` from `frontend/`.
For manual review, run `node tests/helpers/belt-test-fixture.mjs /tmp/koaryu-belt-test-qa` and serve that disposable directory on loopback. Visible synthetic controls exercise lost responses, held reads, reference failures, missing events, reapproval and invalid recipient observations. Stop the server and remove the directory afterward. Check the normal preview Next build separately for production layout and lazy timezone loading.

## Workflow editor

Admins can open the workflow catalog at `/automations`, choose a template, or start an empty draft. Template and duplicate actions allocate a local draft address before navigation. A backend workflow is created only by Save draft. Unsaved edits and Undo history survive client navigation in the same browser page; reloading the page does not preserve unsaved content. A pending action retains only its recovery marker so Check result can resolve it without repeating the command.

Preview uses the actual pure backend catalog copied into `src/lib/generated/workflow-preview-catalog.json`, with sample workflow and reference records and all live capabilities disabled. Regenerate it with `npm run generate:workflow-preview-catalog` from the repository root after changing `backend/app/services/workflow_catalog.py`, then run `npm run check:workflow-preview-catalog`. These commands use `backend/venv/bin/python`, with Python 3.11 or newer. They need no installed backend dependencies, settings, credentials, or network.

Focused composition proof: `node --experimental-strip-types --test tests/workflow-composition-mounted.test.mjs tests/workflow-preview-catalog.test.mjs` from `frontend/`. For manual local review, `PORT=4325 node --experimental-strip-types tests/helpers/workflow-composition-mounted.mjs --serve` starts a disposable fixture on `127.0.0.1`; add `--preview` for zero-I/O sample mode. The fixture mounts the real catalog, editor, graph, inspector, operation owner, and reference action hooks with synthetic API/auth and store contexts. Its visible fixture controls can complete a pending synthetic action, enable synthetic delivery for Start confirmation, switch to a distinct synthetic studio catalog, renew a token, or select light mode. Pass `--route /automations/30000000-0000-4000-8000-000000000001` for a cold saved-workflow entry, or `--route "/automations/new?draft=40000000-0000-4000-8000-000000000001"` for a cold local draft. Stop it with Ctrl-C. `--write` instead writes a standalone fixture to `/tmp/koaryu-ui04b-fixture/index.html`; remove that temporary directory after review.

Workflow activity contract and transport proof, using checked-in synthetic backend serializer fixtures:

```sh
node --experimental-strip-types --test tests/automation-workflow-activity-contract.test.mjs tests/automation-workflow-activity-api.test.mjs
```

The browser workflow workspace owns activity reads, simulations, and recovery for cancellation and test email. Recovery stores only administrator and target identifiers in session storage. Check result never repeats a send. A verified terminal sample needs explicit dismissal or a new sample intent before another test.

```bash
node --experimental-strip-types --test tests/workflow-activity-state.test.mjs tests/workflow-activity-owner.test.mjs tests/workflow-activity-mounted.test.mjs
```

Workflow tools simulate the current saved workflow's graph with a synthetic sample or an explicitly selected current record. Run history preserves published version context and pending cancellation recovery. Select an email node to request a synthetic sample for your verified account, then use Check result for an uncertain outcome.

Local presentation proof: `node --experimental-strip-types --test tests/workflow-tools-mounted.test.mjs tests/workflow-context-picker-mounted.test.mjs`. Manual synthetic fixture: `PORT=4338 node --experimental-strip-types tests/helpers/workflow-tools-fixture.mjs --serve`; it binds to `127.0.0.1` and closes with Ctrl-C. Add `--preview` to inspect the live-only explanations without activity or record I/O.

These synthetic proofs do not establish operational test email. Actual route mounting, coordinated capability checks, and real SQL/HTTP verification remain final feature acceptance gates.

## Dashboard loading

Dashboard pages own their cold-load placeholders. Keep their headers and layout visible, and
reserve the same columns and rails as the loaded view. The `koaryu-skeleton-reveal` class
holds placeholder space immediately and delays its appearance by 220 milliseconds.

Home at `/dashboard` renders its bands from one `/dashboard/home` payload after
workspace access is verified. Home does not request bootstrap or a program list.
`useHome` retains successful payloads by user, studio, role and business date
for immediate revisit paint.
It revalidates on mount, focus, return to a visible tab, each visible minute,
business-date changes, fact changes after commands and Retry. The server's
`studio.today` supplies the date; date changes keep the last payload on screen.
One loading, error or ready state covers the page. Ordinary refresh errors keep
the last payload with one retry notice; access refusals clear it.

`data-koaryu-dashboard-shell-ready` means identity is ready.
`data-koaryu-dashboard-data-ready` means the payload is rendered, including retained
data during a refresh error. The `koaryu.visible.identity` mark tracks identity;
`koaryu.visible.useful`, `koaryu.visible.complete` and
`koaryu.visible.legacy-complete` fire when the payload is rendered.

Edit Home shows, hides and reorders optional panels; the bands stay fixed.
Preferences arrive in the Home payload and save through a debounced
`PUT /dashboard/home/preferences`, flushed on Done and tab hide. The backend
stores the current studio's preferences under `koaryu_home` in Auth user metadata.
A local-storage copy keyed by user and studio supplies immediate paint; reads
reconcile with the current role. Sign-out purges the namespace, and an account
or studio change purges the previous identity's copy and disposes its sync.
Preview edits stay local.

`RetainedStateProvider` keeps bounded page data in memory for the current user, studio and
identity generation. `useRetainedState` restores successful data on revisits while existing
reads revalidate it. Include resource, filter and date inputs in retained keys; keep errors,
requests and unsaved form edits local. Identity changes discard retained values.
Retained data never grants access or proves a mutation is safe. Billing rechecks capabilities
on remount; student detail edits wait for a fresh record read. A definitive unavailable student
read clears its retained record. Missed-class settings refresh an untouched seeded draft and
require explicit saved-rule readback when a changed revision overlaps local edits.

See [dashboard loading verification](../docs/verification/dashboard-loading-2026-10-09.md)
for regression coverage and local browser evidence.

## Social link previews

Public pages share `/opengraph-image`, a 1200 × 630 PNG. Its absolute production
URL and alt text live in `src/lib/social-preview.ts`. Include the shared image
whenever defining `openGraph` or `twitter`. Next.js replaces these nested
metadata objects instead of deeply merging them. Twitter uses `summary_large_image`.

`src/app/opengraph-image.tsx` renders the existing Koaryu mark and palette
once at build time with `force-static`, using Next.js's bundled font. It needs no
authentication, remote assets, font fetches, or runtime image service.
After editing it, build and visually inspect the generated PNG. Run
`npx playwright test e2e/social-preview-metadata.spec.ts --workers=1` against a
loopback production build. `KOARYU_E2E_FRONTEND_URL` selects the origin. These
checks also run in release-candidate CI and include `/try`. Social platforms may
keep cached previews after deployment.
