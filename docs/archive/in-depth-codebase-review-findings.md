# In-Depth Codebase Review Findings

Date verified: 2026-05-23

This document records the verified findings from the read-only codebase review. It intentionally does not prescribe solutions. Each item explains what was observed, where it was observed, and why the observation matters.

Snapshot note: this is an archived review snapshot from May 23, 2026. File references, line counts, and test counts describe the worktree observed during that review, not necessarily the current worktree. Use this document as a finding index, then re-inspect current source and rerun relevant checks before treating any item as currently present or currently fixed.

Scope note: references are to the review snapshot worktree. The review excluded secret files, generated/cache folders, virtual environments, `node_modules`, binary assets, and deleted files.

## Verification Summary

- Reviewable manifest: 320 non-secret, non-generated, non-binary files.
- Reviewable line count: 78,494 lines.
- Frontend tests: `npm --prefix frontend run test` passed with 26 tests passing.
- Backend tests: `cd backend && venv/bin/python -m pytest tests -q` passed with 156 tests passing.
- Local runtime note: `backend/venv/bin/python -V` reports Python 3.9.6, while `README.md:82-83` documents Node.js 18+ and Python 3.11+.
- Frontend test baseline note: `frontend/package.json:11` uses `node --experimental-strip-types`; a direct Node 18 check returned `node: bad option: --experimental-strip-types`.

## Overall Finding

The codebase is not random or incoherent. The domain is recognizable, the product surfaces are broad, and many code paths show explicit concern for tenant scoping, billing state, demo state, and deployment readiness. The main finding is that the system has grown by accumulation. Large files now combine responsibilities that are hard to reason about together: UI rendering plus business rules, local preview behavior plus live API behavior, Stripe operations plus local persistence, and tests plus custom fake infrastructure.

The practical consequence is that green tests and a working local app do not fully describe the operational risk. The riskiest areas are money movement, webhook/idempotency, import/conversion workflows, and frontend state consistency.

## Frontend Findings

### F01. Reports utilization can be inflated by mixing capacity-tracked and non-capacity attendance

Verified evidence:

- `frontend/src/app/(dashboard)/reports/page.tsx:498-518` computes `totalAttendance` by adding every `session.attendees`.
- The same block only adds `session.capacity` when capacity is present and positive.
- `utilizationRate` is calculated as `totalAttendance / totalCapacity`.

Explanation:

The numerator includes attendance from all sessions in `sessionRows`. The denominator includes only capacity from sessions that have capacity configured. If any sessions have attendance but no capacity, those attendees still increase the numerator while the corresponding capacity does not increase the denominator. That can make utilization appear higher than the ratio of capacity-tracked attendance to capacity-tracked seats.

Verification boundary:

This finding is about the frontend report calculation shown in the file. I did not verify whether backend dashboard-summary calculations use a different formula.

### F02. Billing page can show a loading state after a failed live billing load

Verified evidence:

- `frontend/src/app/(dashboard)/billing/page.tsx:672` defines `liveDataReady` as `isPreviewMode || paymentAccount !== null || isLoading`.
- `frontend/src/app/(dashboard)/billing/page.tsx:1484-1488` renders `Loading billing...` when `!liveDataReady && !isPreviewMode`.
- The same page renders errors above that loading state at `frontend/src/app/(dashboard)/billing/page.tsx:1478-1481`.

Explanation:

The readiness flag requires either preview mode, a non-null `paymentAccount`, or an active loading state. If a live request fails and leaves `paymentAccount` null while `isLoading` is false, the page can render both an error message and the loading message. The code therefore has a state combination where a failed settled request still satisfies the loading-display condition.

Verification boundary:

This finding is based on the rendered conditions in the page. I did not drive the browser flow to produce the state interactively.

### F03. Student row checkbox can trigger two selection toggles from one click path

Verified evidence:

- `frontend/src/app/(dashboard)/students/page.tsx:1128-1133` puts `toggleSelect(student.id)` on the table cell click handler.
- `frontend/src/app/(dashboard)/students/page.tsx:1135-1139` puts another `toggleSelect(student.id)` on the nested checkbox `onChange`.

Explanation:

The cell and the checkbox both own selection changes for the same visible control area. A click on the actual checkbox can involve the input change handler and also the parent cell click path unless event handling prevents both from applying. The table row itself is also clickable for navigation at `frontend/src/app/(dashboard)/students/page.tsx:1118-1120`, making this a dense interaction area.

Verification boundary:

This is a source-level event-path finding. I did not run a browser click trace.

### F04. Some date logic uses UTC-derived date keys in UI areas that otherwise use local date keys

Verified evidence:

- `frontend/src/app/(dashboard)/reports/page.tsx:149` returns `date.toISOString().split("T")[0]`.
- `frontend/src/app/(dashboard)/reports/page.tsx:153` uses `new Date().toISOString().slice(0, 10)` for export filenames.
- `frontend/src/app/(dashboard)/reports/page.tsx:349` sets `today` from `new Date().toISOString().split("T")[0]`.
- `frontend/src/app/(dashboard)/students/[id]/page.tsx:105` uses the same UTC-derived date key for hold detection.
- `frontend/src/app/(dashboard)/dashboard/page.tsx:731` uses `toLocalDateKey()`.

Explanation:

There are two date-key approaches in nearby dashboard code: UTC-derived ISO dates and local date keys. In time zones behind UTC, UTC-derived dates can move to the next calendar day before local midnight. The code therefore has multiple definitions of "today" depending on page and feature.

Verification boundary:

This finding verifies inconsistent date-key construction. It does not claim a specific user has seen an off-by-one date.

### F05. Dashboard performs a second billing summary fetch when backend summary billing is absent

Verified evidence:

- `frontend/src/app/(dashboard)/dashboard/page.tsx:751-766` starts a `useEffect` that requests `/billing/payers`, `/billing/invoices`, `/billing/plans`, and `/billing/connect/status`.
- The effect exits when `hasDashboardSummaryBilling` is true at `frontend/src/app/(dashboard)/dashboard/page.tsx:754`.
- The Billing page separately orchestrates billing state in `frontend/src/app/(dashboard)/billing/page.tsx`.

Explanation:

The dashboard owns a fallback billing mini-loader even though billing is a separate product area with its own page state. This creates another place where billing readiness, payment attention, and setup state are derived. The existence of both paths means the dashboard can summarize billing from a different data-loading path than the Billing page.

Verification boundary:

This finding is about duplicated frontend orchestration. It does not claim the fallback is always wrong.

### F06. The API proxy target URL is assembled from raw path segments

Verified evidence:

- `frontend/src/app/api/proxy/[...path]/route.ts:8-14` receives `path: string[]`, joins it with `/`, and constructs a `new URL` from `${normalizedBase}/${joinedPath}`.
- No path-segment rejection or encoding appears in `buildTargetUrl`.

Explanation:

The proxy is intended to forward private API requests to `NEXT_PUBLIC_API_URL` or the local backend default. The target path is built from catch-all path segments as a string. Dot segments such as `..` have special meaning in URL path normalization, so raw path composition is a route-boundary concern.

Verification boundary:

This is a static route-construction finding. I did not send crafted proxy requests to a running server.

### F07. Auth callback accepts arbitrary same-origin `next` paths

Verified evidence:

- `frontend/src/app/auth/callback/route.ts:7-10` accepts `next` when it starts with `/` and not `//`.
- `frontend/src/app/auth/callback/route.ts:12` redirects to that path on the current origin.

Explanation:

The callback prevents external redirects by requiring same-origin paths, but it still allows any same-origin path, including paths outside the expected auth flow. That means the code does not distinguish dashboard/onboarding/reset paths from other frontend paths such as API or internal utility routes.

Verification boundary:

This finding is limited to redirect validation behavior in the callback route.

### F08. Sitemap freshness is generated from the current clock for every route

Verified evidence:

- `frontend/src/app/sitemap.ts:7` creates `const now = new Date()`.
- `frontend/src/app/sitemap.ts:13-18` applies `lastModified: now` to every static and marketing route.

Explanation:

Every sitemap request reports the current time as the last modified value for all public routes. That means static pages, legal pages, and generated marketing pages all appear freshly modified whenever the sitemap runs, regardless of actual content changes.

Verification boundary:

This finding is about sitemap metadata generation only. It does not evaluate search-engine behavior.

### F09. Auth pages are not explicitly excluded from indexing in the auth layout or robots file

Verified evidence:

- `frontend/src/app/robots.ts:8-23` disallows `/api`, dashboard/private routes, `/onboarding`, and other app paths.
- The same list does not include `/login`, `/signup`, or `/reset-password`.
- `frontend/src/app/(auth)/layout.tsx:1-24` renders the auth layout and does not export metadata with a `robots` noindex directive in the inspected lines.

Explanation:

The repo has explicit robots handling for many private app areas, but the public auth pages are not included in that robots list, and the shared auth layout does not add noindex metadata. The finding is about omission from the checked files, not about whether search engines currently index those pages.

Verification boundary:

I did not crawl deployed pages or inspect production headers.

### F10. Landing page header/footer markup duplicates public-navigation concepts found elsewhere

Verified evidence:

- `frontend/src/app/page.tsx:807-815` defines a landing-page header and hardcoded desktop links.
- `frontend/src/app/page.tsx:926-935` defines a landing-page footer and hardcoded footer links.
- `frontend/src/components/mobile-nav.tsx:8-13` has its own default navigation links.

Explanation:

Public navigation is represented in multiple places instead of one visible source of truth. The landing page has hardcoded desktop/footer links, while the mobile navigation component has separate defaults. This increases the chance that public pages, mobile links, and footer links drift from each other as routes are added.

Verification boundary:

This finding describes duplication in visible source files. It does not state that any specific link is currently wrong.

### F11. Global CSS is carrying many unrelated application concerns

Verified evidence:

- `frontend/src/app/globals.css:200-210` contains account-menu animation/root rules.
- `frontend/src/app/globals.css:347-356` contains loading-screen rules.
- `frontend/src/app/globals.css:601-610` begins hero product preview rules.

Explanation:

The global stylesheet contains broad app tokens plus specific behavior for account menus, loading screens, marketing visuals, modal motion, and hero previews. The finding is that unrelated UI concerns are accumulating in one global file, making it harder to know which components depend on which global classes.

Verification boundary:

This is a maintainability finding based on inspected selectors and file organization.

### F12. Marketing detail routes repeat the same route structure

Verified evidence:

- `frontend/src/app/features/[slug]/page.tsx:11-79` defines static params, metadata, lookup, structured data, breadcrumb data, and `MarketingDetailPage`.
- `frontend/src/app/use-cases/[slug]/page.tsx:11-80` follows the same shape with different lookup and labels.
- `frontend/src/app/studio-types/[slug]/page.tsx:16-80` follows the same shape with another lookup and labels.

Explanation:

The feature, use-case, and studio-type detail routes are structurally very similar. The repeated pattern is not a behavior bug, but it is a duplication finding: metadata, structured data, not-found behavior, related-page mapping, and render shape are copied across routes.

Verification boundary:

This finding is about route-code repetition. It does not claim the rendered pages are incorrect.

### F13. Modal behavior is implemented separately in several components, with inconsistent accessibility details

Verified evidence:

- `frontend/src/components/students/student-form.tsx:138-146` renders modal root, backdrop, and panel.
- The `StudentForm` panel in `frontend/src/components/students/student-form.tsx:146` does not show `role="dialog"` or `aria-modal` in the inspected block.
- `frontend/src/components/schedule/class-form-modal.tsx:406-416` separately renders modal root, backdrop, and a dialog.
- `frontend/src/components/dashboard/kpi-insight-modal.tsx:90-99` separately renders modal root, backdrop, and a dialog.
- `frontend/src/components/schedule/session-detail-modal.tsx:327-338` separately renders modal root and backdrop.

Explanation:

The product has several overlay/modal components that each implement backdrop, close behavior, and panel structure. Some include dialog semantics in the inspected block, while `StudentForm` does not. The finding is that modal behavior is duplicated and inconsistent across components.

Verification boundary:

I verified rendered source structure. I did not run keyboard navigation or screen-reader tests.

### F14. Reusable form fields do not consistently connect error/hint text to controls

Verified evidence:

- `frontend/src/components/ui/input.tsx:10-11` derives an input id from the label when no id is passed.
- `frontend/src/components/ui/input.tsx:39-44` renders error and hint text, but the inspected code does not set `aria-invalid` or `aria-describedby`.
- `frontend/src/components/programs/program-picker.tsx:33-35` renders a label-like element for the multi-select area without `htmlFor`.
- `frontend/src/components/schedule/class-form-modal.tsx:195-201` renders label text and a select in a helper component without a visible `htmlFor`/`id` association in the inspected block.
- `frontend/src/components/students/student-form.tsx:267-274` renders a `label` and `textarea` without visible `htmlFor`/`id` association in the inspected block.

Explanation:

The code has a reusable `Input` component and several custom select/textarea sections. Error and hint text are visually present, but the inspected reusable component does not attach those messages through ARIA attributes. Several non-input controls have visual labels without explicit programmatic association in the inspected code.

Verification boundary:

This is a source-level accessibility finding. I did not run an automated accessibility scanner.

### F15. `AccountMenu` combines menu mechanics, billing state, theme controls, and layout logic

Verified evidence:

- `frontend/src/components/account-menu.tsx:128-150` initializes menu state, submenu state, menu position state, billing snapshot state, and refs.
- `frontend/src/components/account-menu.tsx:194-204` calculates viewport-based positioning.
- `frontend/src/components/account-menu.tsx:318-326` fetches platform billing status from `/platform-billing/status`.

Explanation:

The component is not only a visual menu. It owns positioning mechanics, submenu state, billing snapshot fetching, theme access, and menu rendering. That makes the file a cross-cutting UI state container rather than a small display component.

Verification boundary:

This finding is based on component responsibilities present in the file.

### F16. `StudentForm` keeps a large amount of form state in one component

Verified evidence:

- `frontend/src/components/students/student-form.tsx:20-60` initializes separate state variables for tab/error, basic info, contact info, and guardian info.
- Additional form rendering and submission shaping continue later in the same 427-line file.

Explanation:

The form stores many independent fields in individual state hooks. The finding is not that individual `useState` calls are invalid, but that a single component owns the whole student form workflow, validation, tabs, guardian state, and modal shell.

Verification boundary:

This is a maintainability finding from file structure and state ownership.

### F17. Marketing reusable components include page content strategy and faux product visuals

Verified evidence:

- `frontend/src/components/marketing/public-pages.tsx:138-148` defines `ProductScene` with hardcoded dashboard-like rows.
- `frontend/src/components/marketing/public-pages.tsx:203-212` defines `MarketingHero`.
- `frontend/src/components/marketing/public-pages.tsx:357-366` defines `MarketingIndexPage` with default copy.

Explanation:

The marketing component file contains reusable shell components, default marketing copy, and a faux product visualization. The finding is that the "components" layer contains both reusable UI and specific public-page content strategy.

Verification boundary:

This finding is about organization and coupling, not about the accuracy of the marketing copy.

### F18. Some exported UI components appear unused in the searched source tree

Verified evidence:

- `rg -n "ThemeToggle|SmallStatusDot" frontend/src frontend/tests` returned only:
  - `frontend/src/components/theme-toggle.tsx:11`
  - `frontend/src/components/ui/overview.tsx:437`

Explanation:

The search found exports for `ThemeToggle` and `SmallStatusDot`, but no uses outside their defining files in `frontend/src` and `frontend/tests`. That makes them currently unused according to the searched source tree.

Verification boundary:

The search did not include generated files or external consumers outside the repo.

### F19. Frontend tests do not match the documented Node 18 baseline

Verified evidence:

- `README.md:82` documents Node.js 18+.
- `frontend/package.json:11` runs tests with `node --experimental-strip-types --test tests/*.test.mjs`.
- A direct check with `npx node@18 --experimental-strip-types --version` returned `node: bad option: --experimental-strip-types`.

Explanation:

The documented baseline says Node 18+ is acceptable, while the test command uses a Node option that the checked Node 18 binary rejected. That means the documented baseline and the test command are not aligned.

Verification boundary:

The local active Node is v25.9.0, where the frontend tests passed. The Node 18 check was limited to the specific command-line option.

### F20. The Playwright E2E test is live-stateful and logs account identity values

Verified evidence:

- `frontend/e2e/atomic-belt-ladder.spec.ts:36-41` requires `TEST_LOGIN_EMAIL` and `TEST_LOGIN_PASSWORD`.
- `frontend/e2e/atomic-belt-ladder.spec.ts:38` creates a studio name with `Date.now()`.
- `frontend/e2e/atomic-belt-ladder.spec.ts:128-132` logs a JSON object containing `email` and `loginEmail`.

Explanation:

The test uses a real login identity supplied by environment variables, creates a new studio name based on the current time, and logs the email values. This makes the test dependent on live account state and produces identity-bearing output when it runs.

Verification boundary:

I did not run the Playwright test because it requires credentials and mutates application state.

### F21. Preview CSV import maps program and belt names directly into id fields

Verified evidence:

- `frontend/public/demo-students.csv` includes display values such as `Kids Brazilian Jiu-Jitsu`, `White Belt`, and `White Stripe 1` in the Program and Current Belt columns.
- `frontend/src/lib/store.tsx:2310-2311` assigns `program_id: mapped.program_id` and `current_belt_rank_id: mapped.current_belt_rank_id`.

Explanation:

The demo CSV contains human-readable names. The preview import path shown in the store assigns mapped values directly into fields named `program_id` and `current_belt_rank_id`. The code shown does not resolve those display names to existing id values in that object construction.

Verification boundary:

This finding is about the preview import object construction in the frontend store. I did not execute a preview import in the browser.

### F22. Performance marks use shared names for potentially overlapping operations

Verified evidence:

- `frontend/src/lib/performance.ts:46-54` prefixes and records performance marks by name.
- `frontend/src/lib/performance.ts:60-70` measures using prefixed start/end names.
- `frontend/src/lib/store.tsx:2487-2494` records `students.page_started`, fetches a page, records `students.page_finished`, and then measures.

Explanation:

The performance helper uses shared string names for marks. The student page fetch path uses fixed mark names, not request-specific names. If overlapping student page fetches are possible, marks with the same names can represent more than one request timeline.

Verification boundary:

This is a source-level instrumentation finding. I did not capture browser performance entries.

### F23. Import idempotency key generation uses custom hashing and only canonicalizes part of the input

Verified evidence:

- `frontend/src/lib/csv-import.ts:15-35` implements a custom `hashString128` function.
- `frontend/src/lib/csv-import.ts:37-40` defines `sortRecord` for mapping records.
- `frontend/src/lib/csv-import.ts:74-83` builds the fingerprint with sorted `mapping`, but includes `options` as provided.

Explanation:

The fingerprint canonicalizes mapping key order but does not visibly canonicalize arbitrary option-object key order. The string hash itself is a custom JavaScript implementation rather than a platform digest.

Verification boundary:

This finding describes construction. It does not claim a collision or duplicated import has occurred.

### F24. The frontend API wrapper drops falsy request bodies

Verified evidence:

- `frontend/src/lib/api.ts:176-180` passes `body: body ? JSON.stringify(body) : undefined`.

Explanation:

The body is serialized only when it is truthy. Values such as `0`, `false`, an empty string, or `null` are not serialized. Most current API calls appear object-shaped, but the helper itself encodes this behavior.

Verification boundary:

This finding is about the generic helper behavior, not a proven failing call site.

### F25. Frontend state and type definitions have become unusually large central files

Verified evidence:

- `frontend/src/lib/store.tsx` is 3,943 lines.
- `frontend/src/types/index.ts` is 1,008 lines.
- `frontend/src/app/(dashboard)/billing/page.tsx` is 2,297 lines.
- `frontend/src/app/(dashboard)/dashboard/page.tsx` is 2,221 lines.

Explanation:

Several frontend files are large enough to hold multiple conceptual areas. The size itself is not a runtime bug, but it is evidence that application state, domain contracts, and page behavior are concentrated into files that are difficult to review locally.

Verification boundary:

Line counts were verified with `wc -l`.

## Backend Findings

### B01. Disabling autopay only updates Koaryu local payer state in the reviewed method

Verified evidence:

- `backend/app/services/billing_service.py:617-632` defines `disable_autopay`.
- The method reads the payer, updates `billing_payers.autopay_status` and `autopay_disabled_at`, writes an audit event, and returns a `BillingPayerResponse`.
- `backend/app/services/billing_service.py:1348-1355` creates connected subscriptions with `collection_method="charge_automatically"` and a `default_payment_method` when enrollment collection mode is `autopay`.

Explanation:

The reviewed disable method updates local Koaryu payer fields. In the method body, there is no visible Stripe subscription update, subscription cancellation, collection-method change, or default-payment-method removal. Separately, the subscription creation path confirms that autopay enrollments can create automatic-collection Stripe subscriptions with a default payment method.

Verification boundary:

I verified the shown backend method. I did not inspect live Stripe state or database triggers outside this code path.

### B02. Refund and dispute projection updates payment/refund/dispute rows, not invoice or payer balance rows in the inspected block

Verified evidence:

- `backend/app/services/billing_service.py:1771-1811` projects refunds by upserting `billing_refunds` and updating `billing_payments.refunded_amount_cents` and sometimes payment status.
- `backend/app/services/billing_service.py:1813-1849` projects disputes by upserting `billing_disputes` and updating `billing_payments.status` to `disputed`.
- The inspected refund/dispute blocks do not show invoice status updates or payer balance recomputation.

Explanation:

The projection logic records refund/dispute entities and updates the payment row. The reviewed blocks do not visibly propagate that state to invoice-level status or payer balance fields. This can create multiple local truth surfaces for the same payment event.

Verification boundary:

This finding is limited to the inspected projection blocks. I did not prove there is no later reconciliation job elsewhere.

### B03. Webhook claiming reads before updating state and does not use a unique processing token in the inspected path

Verified evidence:

- `backend/app/services/webhook_service.py:55-66` first selects an existing `stripe_events` row.
- `backend/app/services/webhook_service.py:116-123` later updates `processing_status` to `processing`.
- `backend/app/services/webhook_service.py:121` allows updates where status is `pending`, `failed`, or `processing`.
- `backend/app/services/webhook_service.py:129-133` processes the event after the claim step.

Explanation:

The event handler first reads current event state, then later updates the row to processing. The update does not visibly attach a per-processor claim token in the inspected lines. Because `processing` is included in the allowed statuses, the claim condition is broad for stale-processing recovery paths.

Verification boundary:

This is a source-level concurrency/idempotency finding. I did not simulate concurrent Stripe deliveries.

### B04. Account deletion processing selects scheduled rows before deleting users and marking completion

Verified evidence:

- `backend/app/services/account_service.py:132-140` selects scheduled deletion requests due by the current time.
- `backend/app/services/account_service.py:163-166` deletes the Supabase Auth user and then marks the deletion completed.
- The inspected loop does not show a claim or lease state written before deleting the user.

Explanation:

The processor reads scheduled rows and processes them in a loop. The visible sequence does not first mark a row as claimed or in-progress. If two processors read the same scheduled row before either marks it complete, both would have selected the same unit of work.

Verification boundary:

This is a code-path sequencing finding. I did not run concurrent processors.

### B05. Connect onboarding link creation passes caller-supplied redirect URLs without using the local safe-redirect helper

Verified evidence:

- `backend/app/services/billing_service.py:124-129` calls `stripe_service.create_connect_onboarding_link` with `refresh_url` and `return_url` values or defaults.
- `backend/app/services/billing_service.py:2654-2662` defines `_safe_redirect_url`, which validates scheme, host, and allowed origins.
- The inspected `create_connect_onboarding_link` block does not call `_safe_redirect_url`.

Explanation:

Other billing redirect flows use the safe-redirect helper, but the Connect onboarding block shown passes the provided URLs directly to the Stripe service call after applying defaults. That makes this redirect path different from the validated redirect paths elsewhere in the service.

Verification boundary:

This finding is about the inspected onboarding-link method. I did not call the endpoint.

### B06. Billing system status labels a read query as a write-path check

Verified evidence:

- `backend/app/services/billing_service.py:242-244` selects from `studio_payment_accounts`.
- The check label added on success is `"Supabase write path"`.

Explanation:

The status check name says "write path", but the inspected operation is a `select`. The check therefore verifies table reachability for that read, not an insert/update/write behavior.

Verification boundary:

This finding is about wording and operation type in the checked code.

### B07. Report export row fetches do not show pagination in the inspected methods

Verified evidence:

- `backend/app/services/report_export_service.py:248-262` selects report table rows by `studio_id`, applies ordering, executes once, and returns `result.data`.
- `backend/app/services/report_export_service.py:395-407` has a similar helper for analytics datasets.

Explanation:

Both inspected row-fetch helpers execute a single Supabase query and return the data. The code shown does not page through result ranges. For larger datasets, a single-query export path depends on the backend/client default row behavior.

Verification boundary:

This finding verifies lack of visible pagination in these helpers. I did not measure Supabase row limits in the active project.

### B08. Student import claiming and execution are application-level multi-step processes

Verified evidence:

- `backend/app/services/student_service.py:2156-2189` computes an import request hash and handles existing runs.
- `backend/app/services/student_service.py:2182-2189` treats a `processing` run as still active only when its age is less than `IMPORT_RUN_STALE_AFTER_SECONDS`.
- `backend/app/services/student_service.py:3506-3520` begins import execution by preparing rows, creating missing programs, and ensuring program ladders.

Explanation:

The import code claims or reuses work in Python service code and then proceeds through a multi-step import process. The visible execution path calls several service methods sequentially. The reviewed chunks do not show one database-side transaction wrapping the entire import execution.

Verification boundary:

This finding describes visible service-layer sequencing. I did not run a large or concurrent import.

### B09. Lead conversion performs multiple writes and skips membership creation when the deterministic student already exists

Verified evidence:

- `backend/app/services/lead_service.py:200-208` checks whether the deterministic student already exists.
- `backend/app/services/lead_service.py:208-224` creates the student and program membership only inside the `if not existing_student.data` block.
- `backend/app/services/lead_service.py:225-264` separately creates guardian/link records.
- `backend/app/services/lead_service.py:265-272` separately updates the lead.

Explanation:

The conversion path creates or checks a student, optionally inserts membership, optionally creates guardian records, and then updates the lead. The membership insert is nested under the branch where the student did not already exist. If a prior conversion attempt created the student but did not complete later writes, a retry enters the existing-student branch and does not visibly run the membership insert in this block.

Verification boundary:

This is a control-flow finding from the service method. I did not reproduce a failed conversion.

### B10. Promotion recording inserts promotion history before separately updating current rank fields

Verified evidence:

- `backend/app/services/belt_service.py:1056-1058` inserts a `promotions` row and checks that it returned data.
- `backend/app/services/belt_service.py:1060-1067` separately updates `student_program_memberships.current_belt_rank_id`.
- `backend/app/services/belt_service.py:1069-1073` separately updates compatibility fields on `students`.
- `backend/app/services/belt_service.py:1075-1078` begins a separate audit insert.

Explanation:

Promotion history, membership current rank, legacy student rank fields, and audit logging are separate writes in the visible path. The promotion insert is checked; the subsequent updates are executed separately in the inspected lines.

Verification boundary:

This is a sequencing finding. I did not run a promotion failure case.

### B11. Some read-oriented paths perform repair writes

Verified evidence:

- `backend/app/services/program_service.py:50-55` defines `ensure_program_ladders`, which attaches unscoped ladders and creates missing ladders.
- `backend/app/services/program_service.py:70-76` calls `ensure_program_ladders` inside `list_programs_sync`.
- `backend/app/services/belt_service.py:117-119` calls `ProgramService(...).ensure_program_ladders(studio_id)` inside `list_ladders`.

Explanation:

The read/list paths for programs and ladders can trigger ladder repair or creation. That means a request that appears to be reading data can also mutate data.

Verification boundary:

This finding is based on the call graph shown in source. I did not observe a database write during a GET request.

### B12. Recurring schedule materialization reads existing sessions, builds missing rows, and inserts them

Verified evidence:

- `backend/app/services/schedule_service.py:84-96` reads existing sessions for the studio/date range.
- `backend/app/services/schedule_service.py:98-124` builds missing session rows in memory.
- `backend/app/services/schedule_service.py:126-129` inserts `rows_to_create`.

Explanation:

The materialization path derives missing sessions from an initial read and then inserts the computed rows. The inspected block does not show an upsert or conflict-handling branch around the insert.

Verification boundary:

This is a source-level race-window finding. I did not run concurrent schedule materialization.

### B13. Staff invitation creates or invites the auth user before inserting the Koaryu staff role

Verified evidence:

- `backend/app/services/staff_service.py:60-64` calls `invite_user_by_email`.
- `backend/app/services/staff_service.py:83-90` checks for an existing staff role after the invite response.
- `backend/app/services/staff_service.py:97-100` begins inserting the staff role with metadata.

Explanation:

The visible sequence sends/creates the Supabase Auth invite before confirming that Koaryu membership persistence succeeds. If membership insertion fails after the invite, the identity side and app membership side can diverge.

Verification boundary:

This finding is about operation order in the service. I did not trigger an invite failure.

### B14. Billing payer response aliases payment method type to card brand

Verified evidence:

- `backend/app/schemas/billing.py:241-249` defines `add_frontend_payment_method_aliases`.
- `backend/app/schemas/billing.py:249` sets `stripe_payment_method_type` from `default_payment_method_brand` when a default payment method id exists.

Explanation:

The alias named `stripe_payment_method_type` receives a card brand value such as a brand field, not a method category value in the inspected code. That creates a semantic mismatch between the field name and assigned source.

Verification boundary:

This finding is based on schema preprocessing code. I did not inspect frontend consumers of this alias in depth.

### B15. Schedule schemas compare date/time values as raw strings

Verified evidence:

- `backend/app/schemas/schedule.py:10-13` models start/end time and date fields as strings.
- `backend/app/schemas/schedule.py:18-23` compares `self.end_time <= self.start_time` and `self.end_date < self.start_date`.
- `backend/app/schemas/schedule.py:70-80` models class session date/time as strings and compares end/start time strings.

Explanation:

String comparison only matches chronological comparison when input strings are consistently formatted. The schema comments indicate expected formats, but the fields are still plain strings in the inspected code.

Verification boundary:

This finding is about schema type/validator behavior. I did not send malformed schedule requests.

### B16. Auth token fallback can expose provider/config detail in the response body

Verified evidence:

- `backend/app/core/security.py:33-39` falls back to `get_supabase_client().auth.get_user(token)` on `JWTError`.
- `backend/app/core/security.py:40-43` raises an HTTP 401 with `detail=f"Invalid authentication token: {str(fallback_error or exc)}"`.

Explanation:

The error detail includes the string form of the fallback error or JWT error. Depending on the underlying exception, this can put provider or configuration details in a client-facing response body.

Verification boundary:

This finding is about error construction. I did not generate a failing token request.

### B17. Missing credentials and invalid credentials use different default status paths

Verified evidence:

- `backend/app/core/deps.py:10` initializes `HTTPBearer()` with defaults.
- `backend/app/core/security.py:40-43` explicitly raises 401 for invalid token processing.

Explanation:

FastAPI's default `HTTPBearer()` behavior handles missing credentials before `get_user_id_from_token` runs, while invalid token processing raises the explicit 401 shown in security code. The finding is that missing and invalid auth are handled by different layers.

Verification boundary:

This finding is based on dependency wiring. I did not hit the endpoint unauthenticated.

### B18. Some backend request schemas are broad relative to endpoint-specific needs

Verified evidence:

- `backend/app/schemas/billing.py:25-30` defines `BillingActionRequest` with all URL/entity fields optional.
- `backend/app/schemas/billing.py:289-294` defines `StudentBillingEnrollmentCreate` with optional `student_id` and optional `payer_id`, while requiring `billing_plan_id`.

Explanation:

The schema definitions allow several fields to be absent, even though specific flows require different subsets of those fields at runtime. This moves validation burden out of the schema and into service logic or endpoint-specific behavior.

Verification boundary:

This finding is about schema breadth. It does not claim every endpoint using these schemas accepts invalid input successfully.

### B19. Platform subscription access depends on local projected subscription rows

Verified evidence:

- `backend/app/services/studio_scope.py:81-90` reads `studio_subscriptions` to determine platform subscription access.
- `backend/app/services/webhook_service.py:129-132` projects platform webhook events with `hydrate_subscription=False`.
- `backend/app/services/platform_billing_service.py:548-552` constructs the platform billing status response from a local row.

Explanation:

Access and billing status are read from local Supabase rows. Webhook processing can update those local rows without live Stripe hydration in the inspected platform path. This creates an eventually consistent relationship between Stripe's state and Koaryu's local access decision.

Verification boundary:

This finding is about data-source coupling. I did not compare local rows with live Stripe state.

### B20. Demo reset clears and reseeds many tables through sequential service operations

Verified evidence:

- `backend/app/services/demo_service.py:95-112` starts clearing many tables in `_clear_studio_surface`.
- `backend/app/services/demo_service.py:1796-1803` calls `_clear_demo_surface` and then updates the studio row.
- `backend/app/services/demo_service.py` is 1,866 lines.

Explanation:

Demo reset is a broad multi-table operation implemented in service code. The file also contains a large amount of demo data and reset behavior together. The visible reset sequence clears data, updates studio fields, and continues through seed operations later in the file.

Verification boundary:

This finding describes service breadth and visible sequence. I did not run demo reset.

## Backend Test Findings

### T01. Billing/webhook tests use custom fake Supabase and Stripe layers

Verified evidence:

- `backend/tests/test_billing_payments_lifecycle.py:28-60` defines `_FakeQuery`.
- `backend/tests/test_billing_payments_lifecycle.py:119-124` defines `_FakeSupabase`.
- `backend/tests/test_billing_payments_lifecycle.py:167-170` begins `_FakeStripeService` with class-level mutable fields.
- `backend/tests/test_webhook_service.py` contains `_FakeQuery`, `_FakeSupabase`, `_FakeBillingService`, `_FakeWebhook`, and `_FakeStripeModule` per `rg` output.

Explanation:

The tests have extensive custom fake implementations for the database and Stripe surfaces. These are useful for deterministic unit tests, but they are not the same as real Supabase/PostgREST constraints, RLS behavior, request semantics, or Stripe object behavior.

Verification boundary:

This finding is about test strategy visible in files. It does not say the tests are useless.

### T02. Billing idempotency tests call private helpers directly

Verified evidence:

- `backend/tests/test_billing_payments_lifecycle.py:396-415` calls `service._claim_invoice_create_request`.
- `backend/tests/test_billing_payments_lifecycle.py:994-1000` calls `service._project_subscription`.
- `backend/tests/test_webhook_service.py:93`, `109`, and `131` construct the service through `object.__new__` and call `_store_and_process`.
- `backend/tests/test_platform_billing_service.py:92-94` constructs `PlatformBillingService` with `object.__new__`.

Explanation:

Several tests target internal helpers directly rather than public endpoint or public service flows. That can be appropriate for pure transforms, but it means some tests verify internal implementation details rather than complete user-facing behavior.

Verification boundary:

This finding is about call targets in tests. It does not claim all private-helper tests are bad.

### T03. Class-level fake Stripe state is mutated across tests

Verified evidence:

- `backend/tests/test_billing_payments_lifecycle.py:167-170` defines class-level `_FakeStripeService` fields.
- `backend/tests/test_billing_payments_lifecycle.py:1284-1290`, `1933-1938`, and `2059-2062` mutate class-level fake Stripe response/call fields in individual tests.
- `_FakeStripe.Account` is a singleton at `backend/tests/test_billing_payments_lifecycle.py:146-147`.

Explanation:

Class-level fake state can persist across test methods unless reset consistently. The inspected tests mutate that shared fake state in individual cases. This is a test-isolation risk because execution order or added tests can affect shared values.

Verification boundary:

This finding is based on test definitions. The full backend test suite passed locally during verification.

### T04. Fake Supabase implementations are duplicated across many test files

Verified evidence:

- `rg` found fake Supabase/table/query classes in `test_account_service.py`, `test_staff_service_account_deletion.py`, `test_studio_service.py`, `test_support_service.py`, `test_student_service_list.py`, `test_webhook_service.py`, `test_platform_billing_service.py`, and `test_billing_payments_lifecycle.py`.

Explanation:

The suite has many separate fake database implementations. Each one may model filtering, inserts, updates, RPCs, and errors differently. That makes test behavior depend on the local fake used by a given file.

Verification boundary:

This finding is about duplication and consistency risk in tests. I did not compare every fake method against Supabase behavior.

### T05. CSV fixtures are PII-shaped and only loosely asserted in the broad fixture test

Verified evidence:

- `backend/tests/fixtures/csv_import/stress_family_style.csv` includes child names, guardian names, emails, phone numbers, medical notes, coach comments, addresses, city/state/zip.
- `backend/tests/test_student_import_csv.py:301-323` loops fixture files and asserts minimum valid rows, total row count, and a mapping exclusion.

Explanation:

The fixture data appears synthetic, but it is shaped like real minors/student records. The broad fixture test mainly checks that parsing and validation do not crash and that enough rows validate. It does not assert a detailed expected import plan for each PII-shaped scenario.

Verification boundary:

This finding is about fixture shape and assertion granularity. It does not claim real private data is present.

## Supabase Findings

### S01. Support triage digest emits raw truncated subject/details for non-student-record topics

Verified evidence:

- `supabase/migrations/20260520073000_support_triage_digest.sql:39-45` withholds subject/details only when `topic = 'student_records'`; otherwise it emits truncated `subject` and `details`.
- `docs/support-triage.md:15` says broad summaries should not include full details, page URLs with query strings, user agents, browser context, or student-record content.
- `docs/support-triage.md:67` says `support_triage_digest` returns only sanitized fields and does not expose full ticket details.

Explanation:

The SQL sanitizes whitespace/control characters and truncates length, but for non-`student_records` topics it still emits content from the raw subject and details fields. The runbook language is broader than the SQL behavior: it describes sanitized digest behavior that does not expose full details, while the SQL includes truncated detail text for most topics.

Verification boundary:

This finding is based on SQL and docs. I did not run the RPC against live ticket data.

### S02. Direct-client write RLS is broad on core operational tables

Verified evidence:

- `supabase/migrations/20260421000002_students.sql:125-132` permits insert/update on `students` for users whose `auth.uid()` has a staff role in the studio.
- `supabase/migrations/20260421000002_students.sql:167-171` permits insert/update on `programs` for studio staff.
- `supabase/migrations/20260425000021_program_memberships.sql:85-92` permits insert/update/delete on `student_program_memberships` for studio staff.
- No `GRANT`/`REVOKE` lines were found in those two files by the targeted search.

Explanation:

The RLS policies allow browser-authenticated studio staff to write to important operational tables if the tables are directly accessible to the client role. This sits next to an architecture where the backend service role also performs tenant-scoped CRUD and validation. The finding is that direct-client write policy surface exists in the migration history.

Verification boundary:

I did not inspect live table grants in Supabase. A later grant revocation outside the inspected files could change actual direct-client accessibility.

### S03. Belt-ladder sync function history shows repeated repair churn

Verified evidence:

- Targeted search found `sync_belt_ladder_ranks` created or dropped/recreated across migrations:
  - `20260421000011_atomic_belt_ladder_sync.sql`
  - `20260421000012_sync_belt_ladder_returns_full_state.sql`
  - `20260421000013_fix_atomic_belt_ladder_sync_ambiguity.sql`
  - `20260421000014_fix_atomic_belt_ladder_sync_name_ambiguity.sql`
  - `20260421000015_fix_atomic_belt_ladder_sync_returning_id.sql`
  - `20260520065000_belt_ladder_sync_without_temp_table.sql`
  - `20260520070500_lock_down_belt_ladder_sync_rpc.sql`

Explanation:

The same RPC appears across a series of fix migrations, including several 240-line function replacements. The final state may be sound, and later migration `20260520070500` locks execution down to `service_role`, but the migration history itself is noisy and difficult to audit.

Verification boundary:

This finding is about migration history readability. It does not claim the final RPC currently fails.

### S04. Program-filter RPC returns total count through a left join that can produce a null-student sentinel row

Verified evidence:

- `supabase/migrations/20260520080000_student_program_filter_rpc.sql:92-94` selects `page_rows.id AS student_id, total.total_count` from `total LEFT JOIN page_rows ON TRUE`.
- `supabase/verification/` contains verification files for program memberships, account support controls, belt ladder sync, program ladder unification, studio onboarding, and support triage, but no verification file named for the student program filter RPC.

Explanation:

The SQL structure preserves a total count even when no page rows exist by left joining page rows onto total. In empty-page/no-match cases, that shape can return a row with `student_id` null and a total count. That may be intentional, but it is a special contract and no owned verification SQL file was found for it.

Verification boundary:

I did not execute the RPC. The finding is based on SQL shape and verification-file inventory.

## Docs, Scripts, and Repo Hygiene Findings

### D01. Stripe Connect smoke script can operate against whichever environment variables are loaded

Verified evidence:

- `scripts/verify-connect-webhook-smoke.py:32-34` loads `backend/.env` and root `.env`.
- `scripts/verify-connect-webhook-smoke.py:44-47` creates a Supabase client from `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- `scripts/verify-connect-webhook-smoke.py:130-136` loads the webhook secret, selects a connected account, builds a payload, and posts it twice.
- `docs/render-backend-deployment.md:248-252` describes the smoke test as proving route, signature validation, projector entrypoint, and `stripe_events` dedupe behavior.

Explanation:

The script is a local smoke test, but its actual target depends on loaded environment values and its endpoint argument. It uses service-role-backed Supabase access to choose a connected account and sends synthetic webhook events. That makes it a state-mutating verification script whose safety depends on the environment values loaded at runtime.

Verification boundary:

I did not run the smoke script.

### D02. Dev scripts kill processes occupying ports 4000 and 8001

Verified evidence:

- `scripts/dev-up.sh:10-17` finds PIDs on a port and sends `kill`.
- `scripts/dev-up.sh:22-26` escalates to `kill -9`.
- `scripts/dev-down.sh:8-16` finds PIDs on a port and sends `kill`.
- `scripts/dev-down.sh:22-25` escalates to `kill -9`.

Explanation:

The scripts reclaim ports by killing whatever processes are listening on the configured ports. They do not verify that those PIDs belong to this repo's frontend/backend processes in the inspected lines.

Verification boundary:

I did not run the dev scripts.

### D03. README verification snapshot is broad and undated

Verified evidence:

- `README.md:236-250` lists a "current dev verification pass" with health checks, onboarding checks, tenant isolation checks, frontend lint/audit/build, full backend pytest, and live Stripe verification.
- The inspected section does not include a date, commit SHA, environment identifier, or command transcript.

Explanation:

The README contains an ambitious verification history. Without a date or commit, the text reads as current project evidence even though it can become stale as the working tree changes.

Verification boundary:

This finding is about documentation evidence quality. I did not verify the historical checks.

### D04. Pricing/commercial positioning differs across docs

Verified evidence:

- `README.md:9` says the cheapest comparable purpose-built software found was still `$49 a month`.
- `docs/outreach-style-notes.md:34-36` says the paid version will be `$27/month`.
- `Original Martial Arts Studio CRM SaaS PRD.md:255-260` begins a pricing recommendation table for tiered pricing, while the surrounding text references launch structure.

Explanation:

Different docs present different pricing contexts: a market comparison, an outreach promise, and a PRD recommendation. They may be historical or intentional, but the repo does not make that distinction explicit in the inspected lines.

Verification boundary:

This finding is about internal document consistency. I did not research external competitor pricing.

### D05. Root `tmp_import_tests/` contains PII-shaped CSV fixtures and is untracked/unignored

Verified evidence:

- `tmp_import_tests/stress_family_style.csv` includes child names, guardian names, emails, phone numbers, medical notes, coach comments, and addresses.
- `.gitignore:47-53` misc rules do not list `tmp_import_tests/`.
- `.vercelignore:1-18` does not list `tmp_import_tests/`.
- `git ls-files --others --exclude-standard -- tmp_import_tests` lists the CSV files as untracked and not ignored.

Explanation:

The folder contains synthetic-looking but PII-shaped test import data. It is not ignored by git or Vercel ignore rules in the inspected files, so it appears as ordinary untracked repo content rather than clearly local scratch state.

Verification boundary:

This finding does not claim the fixture values are real private data.

### D06. PRD citation quality has visible provenance issues

Verified evidence:

- `Original Martial Arts Studio CRM SaaS PRD.md:257` cites references for pricing strategy.
- `Original Martial Arts Studio CRM SaaS PRD.md:360` shows reference 24 is a purchase-order system article, not a martial-arts CRM or billing-specific source.

Explanation:

The PRD includes citations that do not always match the surrounding product/business claims. The visible mismatch makes the PRD less reliable as a verified research artifact.

Verification boundary:

I did not open external citation links. This finding is based on the source titles and local PRD text.

### D07. Render plan language differs between config and runbook

Verified evidence:

- `render.yaml:5` sets `plan: starter`.
- `docs/render-backend-deployment.md:22` says "The free Render service runs a single lightweight Uvicorn process intentionally."
- `docs/render-backend-deployment.md:24` separately says a live demo should use a paid/warm Render instance.

Explanation:

The config names the Render plan as `starter`, while the runbook still refers to the free Render service in the local deployment guidance. That creates cost/plan wording drift in the docs.

Verification boundary:

I did not inspect the live Render dashboard.

## Severity and Confidence Notes

High-confidence findings are those directly visible in a single source block or repeated across a small number of linked files. Medium-confidence findings are those where source code shows a risk shape, but runtime behavior might also be affected by database grants, live infrastructure settings, external service state, or code outside the inspected path.

Findings intentionally not made:

- No claim that secrets are committed. Secret files were intentionally not read.
- No claim that production currently has the same state as local files. Live infrastructure was not inspected.
- No claim that every broad or large file is broken. Size and responsibility concentration are maintainability findings, not automatic correctness findings.
