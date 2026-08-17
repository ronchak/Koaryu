# Koaryu dashboard redesign implementation plan

Status: approved version-one implementation contract
Contract baseline: repository `0b46b823e175e50fa8d5625301925baf121945da`
Evidence owner: WS-1 product and contract inventory
Taste review: Claude Opus 5, used as advisory critique; final product judgment remains Koaryu’s
Pitch artifact: [`dashboard-redesign-pitch.html`](./dashboard-redesign-pitch.html)
Approved delivery: frontend redesign plus bounded backend dashboard-summary enrichment; staging verification followed by frontend/backend production release; no database migration in version one

## Outcome

Replace the authenticated product’s generic page-title, card, and modal grammar with a family of page-native work surfaces. The family shares Koaryu’s warm paper, ink, vermilion, cobalt, ruled bands, typographic restraint, and honest state disclosure, but each page uses the composition that best fits its job.

The decision is **Tatami Home + purpose-built operational sheets**:

- Dashboard is a real, customizable widget home inspired by the calm spatial editing of an iPad home screen. Customers can add, remove, resize, and reorder a bounded catalog of operational widgets.
- Students and Billing use dense ledgers because stable rows, columns, permissions, and exact values are the work.
- Student Detail is a folio with a fixed identity rail and chronological record leaves.
- Schedule is a time canvas; attendance is a register with an explicit commit state.
- Import is a worksheet with persistent mapping and inline row errors, not decorative wizard steps.
- Belt Tracker is a ranked roster with a progression rail, not an infographic.
- Leads is an aging follow-up ledger, with stage as a field and overdue work as the primary sort.
- Reports are print-first analytical sheets. Automations remains an honest future catalog. Settings, Account, Help, and transition routes use indexed or focused sheets.

The shell still supplies stable global navigation, one route slug band, local gutter indexes for deep pages, and a contextual margin rail only where a current selection needs history or related facts. Short forms and confirmations remain focused dialogs. Deep or tabular work becomes a route or URL-addressable sheet.

This is a change in interaction and information architecture, not a recolor. The public language’s tactile, handled-information character transfers into the product while its cinematic scroll and illustrative scenes remain public-facing.

### Version-one persistence boundary

Version one stores one reconciled widget arrangement per authenticated user and role in browser storage. It survives refreshes and normal return visits on that browser/device, but it does not claim cross-device synchronization. Storage keys live under one enumerable namespace and are versioned and scoped by user ID, studio ID, and role so one person’s arrangement cannot leak into another session on a shared device. Logout/account-reset purges the complete namespace. Storage is never an entitlement source: every read drops widgets the current server-derived role cannot use, removes unknown and duplicate IDs, clamps sizes to the legal set, and appends newly entitled default widgets in product order. Unavailable or quota-limited browser storage degrades to in-memory state without breaking Dashboard and surfaces that the arrangement will not survive navigation or reload.

Cross-device persistence is a committed next-phase direction, not an optional idea. The production shape is a new studio-scoped Supabase layout table with a backend-owned read/write API, optimistic versioning, one personal arrangement per user and role, and owner-published studio defaults. The version-one serialized layout is designed to become the request payload for that API without changing the widget catalog or interaction model. That future change requires a new migration, RLS/verification, release-readiness attestation, backend endpoints, and local-to-server adoption logic; none of those database changes are included in this release.

## Concepts considered

### Concept A: Tatami Home, selected for Dashboard only

The home is a user-arranged field of glanceable, source-linked widgets. Its data model is locked as one ordered list in a constrained reflow grid, not x/y coordinates or free placement. It borrows Apple’s small fixed size vocabulary, separation of view/arrange/library modes, magnetic insertion gap, content-first glanceability, and pleasant reflow. It rejects app icons, glass, blur, glossy gradients, jiggle, page dots, algorithmic stacks, and an uncontrolled widget zoo.

The visual compromise is deliberate: widget exteriors use large continuous 20–24px corners and restrained depth to deliver the iPad-like ease requested by product; interiors use sharper ledger bands, ruled lists, warm paper, ink, cobalt edit state, and rationed vermilion to stay recognizably Koaryu. The home is the only user-configurable page.

### Concept B: Dojo Ledger, selected for exact operational pages

Ledger treats records as handled information. Stable rules and columns support comparison; a state gutter surfaces exceptions; selected records can open relevant context in a margin rail. It owns Students, Billing, the attendance register, Lead follow-up, and the table/method portions of Reports.

It remains the stress-test winner for the two highest-risk surfaces:

- Student Detail keeps identity, contacts, address, emergency and guardian information, lifecycle dates and holds, program and rank state, promotion history, photo, notes, permissions, and archive confirmation in one coherent folio.
- Billing keeps exact money, dates, statuses, payer/provider references, provider-mode gates, reconciliation, and read-only/unavailable truth visible without hiding relationships inside widgets, lanes, or drawers.

### Concept C: Training Floor, selected only where position means something

Training Floor is a spatial, time-oriented field. It owns Schedule’s time canvas because horizontal and vertical placement have real meaning. Import borrows its sense of progression but remains one worksheet. Belt Tracker borrows a progression rail, anchored by a ranked roster. It does not own Leads: leads are aging obligations and compare more honestly in a follow-up ledger sorted by days since contact.

### Customization constraint

Dashboard is configurable, but not arbitrary. Widgets come from a product-owned catalog, declare one or two legal sizes, answer one question, show no more than five rows, and offer at most one task action beyond opening the source page. `Needs Attention` is a fixed, non-removable full-width band. Critical conditions may temporarily re-inject a dismiss-for-today panel. A first-run studio receives a sparse setup arrangement. Version one provides reset-to-default and local persistence; named arrangements, owner-published defaults, and automatic Setup retirement wait for cross-device persistence.

## Current route contract and preservation strategy

The redesign covers all 23 routes inside the dashboard group and four authenticated transition surfaces. The pitch contains an anchor-linked manifest with purpose, fields/data, actions, states/roles, and a concrete destination for every row.

### Dashboard-group routes

1. `/dashboard`
2. `/students`
3. `/students/[id]`
4. `/students/import`
5. `/belt-tracker`
6. `/leads`
7. `/schedule`
8. `/billing`
9. `/automations`
10. `/reports`
11. `/settings`
12. `/account`
13. `/account/profile`
14. `/account/settings`
15. `/account/personalization`
16. `/account/notifications`
17. `/account/data`
18. `/help`
19. `/help/get-started`
20. `/help/release-notes`
21. `/help/downloads`
22. `/help/contact`
23. `/subscription-required`

### Authenticated transition surfaces

24. `/onboarding`
25. `/account-archived`
26. `/access-denied`
27. `/billing/connect/refresh`

### Contract-preservation method

Implementation begins by turning the WS-1 inventory into checked route fixtures and acceptance tests, not by restyling existing screens. For each route, record:

- canonical fields and source-owned aggregates;
- actions and the frontend/backend owner that can actually perform them;
- Admin, Front desk, Instructor, unknown-role, and denied behavior;
- preview, live, partial, loading, error, empty, pending, success, and destructive-confirmation states where applicable;
- whether a capability is live, preview-only, read-only, unavailable, or future;
- whether a count is server-authoritative or unsafe to derive from the capped bootstrap roster.

The existing lead-delete store mismatch remains an explicit negative test: no Leads delete control is introduced because there is no backend DELETE route and no current UI affordance. Internal provider/reliability tables remain operational implementation detail, not dashboard CRUD. Billing plan/family creation, billing exports not in the effective report catalog, automations, notification delivery preferences, and language/density controls remain visibly non-live.

## System ownership

### Shell

`DashboardShell` owns the skip target, indexed spine, responsive navigation, account/help entry points, theme affordance, legal-name blocker boundary, sign-out feedback, and the main content outlet. Navigation may continue to display links a role cannot open until the unresolved navigation decision is made, but destination authorization must fail closed before protected data loads.

`SlugBand` owns route name, record count or current entity, scope, freshness/provenance, partial/preview/live truth, and page actions. It accepts structured values rather than prose assembled by each page.

`GutterIndex` owns in-page section links and active-section state. Its entries are URL-addressable anchors. It is used only where there are meaningful local sections.

`MarginRail` accepts a current selection and structured blocks for history, notes, related records, and audit facts. On narrower screens it follows the primary content in reading order. It is not a drawer containing a second version of the page.

`LocalDashboardLayoutStore` owns a versioned ordered list of `{widget_id, size}` plus `updated_at` and an anonymous client instance ID, keyed by authenticated user ID, studio ID, and role under one enumerable browser-storage namespace. It reconciles catalog IDs, role entitlements, duplicates, and legal sizes on every read; falls back to a role-specific compiled default on malformed or stale data; and stores presentation only. All reads and writes handle storage exceptions. Reset restores that compiled default, and the established logout/account-reset boundary removes every key in the namespace. Every widget selects from the same Dashboard summary fetch or the same existing domain query and time window as its owning page; a widget may not create a per-panel duplicate fetch. The canonical fixed attention band renders even if optional widgets fail. The serialized contract must remain directly adoptable by the future server persistence API.

`WidgetCatalog` is product-owned and capability-aware. Entries declare supported roles, legal sizes, source route, empty/loading/error copy, freshness window, and whether the panel may be removed. A role-ineligible widget is absent from that role’s library and rendered layout. Version-one client validation rejects unknown widgets and illegal sizes; the future persistence API repeats that validation server-side.

`WidgetCanvas` renders four columns on wide desktop, two on tablet, and one ordered column on phone. Reordering is available only inside an explicit Customize mode. It supports pointer drag from the band, 500ms touch pickup with edge auto-scroll, explicit keyboard move/resize controls, Escape rollback, a visible insertion gap, focus retention through reflow, at least 44px targets, and live position announcements. Production uses FLIP reflow around 200ms and disables transforms under reduced motion. Mobile arrange mode is a single-column compact reorder list with explicit controls rather than a draggable free canvas.

### Surface primitives

- `LedgerTable`: semantic table for genuinely two-dimensional comparison, sticky headers, state gutter, selection, bulk-action band, and explicit loading/error/empty rows.
- `HomeWidget`: bounded glance surface with ledger band, declared time window, legal sizes, source link, and complete state contract. It cannot introduce a new domain query or mutation owner.
- `WidgetLibrarySheet`: non-modal right-side sheet grouped by Today, People, Money, and Setup; unavailable capabilities are absent, with owner-only default publishing allowed to explain role requirements.
- `LabeledRows`: definition-list or label/value rows that collapse cleanly on mobile.
- `QueueLedger`: verb-first actions ordered by due time and priority.
- `RecordLeaf`: headed field group used by Student Detail, Settings, and Account.
- `MoneyBand`: Billing-only cross-section totals with source, scope, and as-of time.
- `StatusStamp`: text plus shape/pattern; color is supplemental.
- `StatePanel`: in-flow loading, error/retry, empty/setup, preview, partial, denied, and read-only feedback.
- `AddressableSheet`: URL-owned secondary task with a close/back destination. Schedule session detail and invoice detail are candidates.
- `FocusedDialog`: short create/edit forms and explicit destructive confirmation only. Dialogs never contain tables, never open another modal, and restore focus to the invoker.

### Data and state

Domain stores and route loaders remain the owners of operational data. The shell consumes small view models and never recomputes domain truth. Server summary counts stay authoritative; exact retention or full-roster calculations must not use a partial bootstrap list. Every surfaced value carries one of these provenance states: live, preview fixture, partial, unavailable, or stale/error.

Version one enriches the existing authenticated `/dashboard/summary` and bootstrap summary contract without adding a route, table, mutation, provider call, or database migration. New fields are optional and omitted, rather than nulled, for roles that cannot access them. Studio and role restrictions apply at the query boundary before protected values are computed, and client cache identity includes user, studio, and role. The endpoint retains `private, no-store` behavior. The backend may add only role-filtered, source-owned widget facts available from current tables:

- at most five compact Today session rows plus an overflow count, using a half-open day interval in studio time and an explicit field allowlist of stable session ID, studio-time start/end, class/program label, capacity, and attendance/expected counts; no student names, contacts, notes, payer data, or attendee-level payload belongs in the summary;
- an exact active-student count of records with or without a named emergency contact, never derived from the capped bootstrap roster and never selecting contact phone PII into the summary service;
- billing attention amounts and due-this-week totals in integer cents for existing billing-visible roles only, alongside the existing attention count;
- the existing summary generation timestamp/timezone and explicit availability flags for any enrichment that cannot be computed faithfully.

Promotion readiness continues to use the existing eligibility owner in the frontend unless the backend stream proves a bounded reuse of the current eligibility service without duplicating rules or materially regressing summary latency. New aggregate work must use a bounded query count, avoid row-by-row fetches, and pass a production-shaped query-plan check. If a current-table aggregate cannot meet the existing summary latency budget without a new index, it is omitted and marked unavailable; the no-migration boundary wins. Unsupported facts render unavailable or use a source-page link; fixtures never become live values. The response schema, backend service, tests, generated frontend contract, preview fixtures, and widget view models change together.

Mutation feedback belongs next to the affected row or section, with a persistent completion/error message. Toasts may supplement but never carry the only result. Optimistic updates require a rollback value and an idempotent/replay-safe server action; otherwise show pending state until the owner confirms.

### Permissions

Route authorization and backend role enforcement remain the security boundary. Presentation helpers only determine whether an allowed action is visible or disabled. Unknown roles resolve to no capabilities. Instructor billing denial must occur before billing data fetch. Admin-only Core/Connect operations remain unavailable to Front desk even though Front desk can use routine billing enrollment, external payment, and reconciliation actions.

### URL and overlay rules

- Filters, sort, page, view, active entity, local section, and addressable-sheet identity are reflected in URL search parameters or fragments when returning to the same state matters.
- Student Detail, attendance mode, schedule session detail, invoice detail, and other deep/tabular work are routes or addressable sheets.
- Create/edit forms and confirmations may be dialogs when the task is focused and short.
- Closing a sheet restores the prior URL and selection. Closing a dialog restores focus.
- Modal-on-modal is prohibited. A task that needs another deep context exits to the relevant route/sheet.

## Responsive, accessibility, motion, and print strategy

Desktop uses a narrow indexed spine, a flexible sheet, and an optional contextual rail. Dashboard adds a four-column widget grid with a fixed row rhythm and five legal footprints: `1×1`, `2×1`, `2×2`, `4×1`, and `4×2`. Most widgets expose only two of them. Tablet packs into two columns. Mobile renders one ordered column with `band` and `sheet` heights, and uses a compact arrange list so a phone reorder is precise rather than a full-widget wrestling match.

Outside Dashboard, tablet collapses the rail below the current section unless the selected context is essential. Mobile puts navigation and screen choices in reading order, converts label/value comparisons into stacked labeled rows, and raises the batch band above safe-area insets. Tables become labeled rows unless their meaning is inherently two-dimensional. Schedule is the only intentionally horizontally scrollable matrix.

All interactive controls have visible labels, keyboard operation, selected/expanded state, and a target near 44px where feasible. Focus uses a high-contrast two-pixel outline with offset. Landmarks, headings, skip link, live announcements, form labels, status text, and destructive-dialog descriptions are required. Color never carries status or belt rank alone. Unknown/denied states fail closed and state why.

Motion is limited to selection, commit, and position feedback. Widget reflow uses a 200ms ease-out FLIP transition; the picked-up sheet alone receives a small scale and shadow, with no jiggle or visible spring overshoot. Other operational motion stays under 200ms. There is no autoplay, scroll interception, parallax, reveal-on-scroll, animated texture, or algorithmic widget reshuffling. `prefers-reduced-motion` removes transforms and scripted smooth scrolling.

Print styles remove interactive chrome and preserve ledger headers, exact values, scope, as-of time, page breaks, and readable black-on-white rules. Billing registers, student records, reports, and attendance sheets receive dedicated print tests.

## Prototype evidence versus production truth

The pitch uses a visibly labeled, reconciled **prototype fixture**. It demonstrates hierarchy, density, responsive composition, keyboard paths, role/state disclosure, and end-to-end storyboards. Fixture records are internally consistent across Today, roster, Student Detail, Schedule, attendance, Leads, Billing, and Reports.

The pitch does not call a backend, mutate data, export a file, navigate to Stripe, send support mail, or prove production permissions. Buttons marked “prototype only” demonstrate placement and state; read-only and future capabilities are labeled. Storyboards model expected transitions but do not claim a live transaction occurred.

Production truth continues to come from authenticated APIs, provider capability responses, server-owned aggregates, database policies/functions, and current route middleware. No fixture value may become a product default.

## Phased implementation

### Phase 0: executable contract

- Convert the WS-1 route, field, action, role, state, and negative-case inventory into versioned acceptance fixtures.
- Add route-level authorization tests for Admin, Front desk, Instructor, unknown role, archived account, subscription gate, and Connect refresh.
- Decide the unresolved items listed below before changing route boundaries.

Exit gate: every current route and transition state maps to an owning test and a proposed destination.

### Phase 1: shell alongside current pages

- Implement the spine, slug band, state/provenance model, gutter index, margin rail, focus system, and responsive breakpoints behind one reversible shell flag.
- Keep current route components intact inside the new shell.
- Verify the legal-name blocker, sign out, unfiltered-nav behavior as currently decided, and fail-closed route denial.

Exit gate: all routes render with parity under the new shell; turning off the flag restores the old shell.

### Phase 2: backend enrichment, Home, Students, and Student Detail

- Enrich the existing Dashboard summary with the approved current-table aggregates, preserve private/no-store headers, enforce role-filtered billing fields, and regenerate the frontend API contract. Do not add a database migration.
- Implement the versioned, user/studio/role-scoped local layout store with malformed-data fallback, role-safe defaults, reset, and logout/account-cleanup coverage. Keep its payload compatible with the future cross-device API.
- Build the Tatami Home with the fixed attention band, role-aware catalog, five legal footprints, source-owned widget queries, arrange/library modes, pointer/touch/keyboard reorder, mobile compact arrange list, resize, remove/undo, and reset-to-default.
- Start with the current fixture catalog: Classes Today, Needs Attention, Student Pulse, Attendance, Lead Follow-ups, Promotions Due, Billing Exceptions, Revenue Due, Setup Progress, Recent Students, Saved Report, Quick Actions, and Emergency Contacts. A stored/default widget whose authoritative fact is unavailable uses an honest unavailable/source-link treatment; the Add Panels library does not advertise a panel until its source is available.
- Migrate Students to the ruled roster, sticky filters, state gutter, bottom bulk band, and page/query notices.
- Migrate Student Detail to card-file leaves with History in the margin rail and focused edit/archive/photo dialogs.

Exit gate: layouts survive refresh, user/studio/role changes, catalog versioning, malformed or unavailable storage, removal/reset, entitlement changes, namespace cleanup, desktop/tablet/mobile packing, keyboard and touch reordering, focus retention, partial widget failures, and reduced motion; backend enrichment is authoritative, role-safe at the query boundary, generated-contract clean, bounded in query count, production-shape query-plan safe, and does not alter the 111-migration database manifest; all WS-1 student fields, permissions, validation, partial/full roster states, and destructive confirmations also pass automated and keyboard checks.

### Phase 3: Schedule, attendance, import, belts, and leads

- Introduce the Week Sheet with Month/Week/Day support and an addressable session sheet.
- Move attendance to an explicit commit mode with pending/offline disclosure.
- Build one persistent import worksheet with source, mapping, preview, and landing results visible in sequence; include row-addressable errors and every mapping/policy without stepper-pill chrome.
- Apply Ledger treatment to rank plan and eligibility while retaining atomic save/discard/conflict semantics.
- Use an aging follow-up ledger for Leads, ordered by obligation age with stage as a field, while retaining current add/open/stage/follow-up/activity/convert/lost actions and excluding delete.

Exit gate: the attendance → history/Today and import → roster/belt resolution flows pass with error and retry coverage.

### Phase 4: Billing density proof

- Land Setup, Plans, Families, Student Billing/Enrollments, Invoices, and Advanced as indexed books with the persistent money band.
- Keep Core and Connect role boundaries, provider-mode gates, external/record-only wording, provider references, reconciliation, and deliberate read-only/unavailable states exact.
- Route invoice detail/remedy through an addressable sheet; keep external payment and focused confirmations bounded.

Exit gate: exact money/date/reference rendering, Admin/Front desk/Instructor boundaries, failed-charge remedy/reconcile flow, provider unavailable/error states, and read-only negative tests pass.

### Phase 5: Reports, Settings, Account, Help, transitions

- Replace chart-wall patterns with one scoped visual plus tables, methods, and the existing 29-export catalog.
- Apply indexed long-form treatment to Settings and Account while retaining all guards and confirmations.
- Preserve every secondary Account and Help contract regardless of the eventual route-versus-panel decision.
- Migrate onboarding, archived account, access denied, subscription required, and Connect refresh as focused transition sheets.

Exit gate: route manifest is complete and preview/live/read-only/future truth is unchanged.

### Phase 6: cutover

- Run both shells against the same domain owners during an internal comparison window; do not duplicate stores or mutation paths.
- Record parity for role, state, responsive, print, accessibility, and end-to-end flows on one exact release candidate.
- Switch the shell flag only after candidate-wide checks. Remove the old shell and obsolete page chrome in a separate, reviewable cleanup after the rollback window.

## Migration, cutover, and rollback

The UI migration is route-by-route but the shell and state vocabulary are singular. A route may use the new shell with its old body while its surface is being migrated. Existing domain mutation owners and database contracts remain unchanged; the only backend contract change is additive Dashboard summary enrichment.

Rollback is the shell/surface flag plus the preserved old page component during the window. Local layout state never duplicates domain state: disabling the new home ignores the versioned browser key and restores the current canonical Dashboard without data rollback. The additive backend fields remain safe for the previous frontend to ignore. If a migrated route fails parity, revert that route’s composition while retaining the shared shell only if its own gate remains green. Remove flags and old components only after one stable release window and repository-owned evidence that no fallback path remains in use.

## Tests and acceptance gates

- Contract: all 27 routes; every WS-1 field/action/state/role; negative assertions for lead delete, internal-only tools, and non-live features.
- Unit: view-model provenance, permission resolution, slug-band copy, partial-count suppression, URL state, widget catalog validation, local layout key isolation/packing/version fallback, and dialog/sheet focus restoration.
- Integration: additive Dashboard response compatibility and role-filtered enrichment; route loaders and failure states; Admin/Front desk/Instructor/unknown; preview/live; Core/Connect gates; import policies; atomic belt conflicts; destructive typed confirmation.
- End to end: arrange/resize/remove/reset a role-safe Dashboard; attendance → student history/Home attention; CSV import → roster/belt resolution; failed charge → remedy/reconcile → paid invoice.
- Accessibility: automated semantics plus manual keyboard traversal, screen-reader announcements, zoom/reflow, contrast, reduced motion, and focus order.
- Responsive: representative desktop, tablet, 320px mobile, short viewport, coarse pointer, and Schedule-only horizontal scroll.
- Print: student record, attendance sheet, report, and billing register with scope/as-of/context retained.
- Performance: 500-row roster and 800-row invoice fixtures; sticky chrome, selection, and filtering remain responsive without hiding rows behind client-only approximations.
- Release: exact-head build/lint/tests, API-contract check when response shapes change, and visual comparison on the same release candidate.
- Design transformation: each migrated surface names the operational decision it accelerates and the old chrome or interaction it replaces. Home must prove customization; ledgers must prove comparison and sticky operational context; Schedule must prove conflict/overlap legibility; Student Detail must prove persistent record context. A surface that changes only color, radius, or typography fails review.

Acceptance requires zero missing manifest entries, no unsafe partial-data calculations, no protected-data preload on denied routes, no new backend capability implied by presentation, and no essential feedback delivered only by toast or color.

## Risks

- Dashboard customization can become a miniature product whose layout state, role changes, versioning, and mobile behavior outgrow its value. Keep a bounded catalog, one ordered-list source of truth, few legal sizes, and a reliable studio default.
- Device-local persistence is an acknowledged version-one limitation. Shared devices require identity/studio/role key isolation and logout cleanup; cross-device reliability remains incomplete until the approved follow-up Supabase migration and backend API ship.
- Widget counts can disagree with destination pages because of timezone, rollup window, stale cache, or role scope. Each widget must share the owning page’s query and state its window/freshness.
- Rounded widget surfaces can slide into glossy generic SaaS. Reserve large continuous corners for Dashboard exteriors; interiors and all operational pages retain Koaryu ledger bands, rules, and restrained depth.
- The margin rail can decay into a miscellaneous drawer. Its allowed content types and mobile order need component-level constraints.
- URL-addressable sheets change back-button behavior and may expose hidden loader coupling in Schedule and Billing.
- Heavy fixtures can validate layout while missing real provider timing, partial failures, and permission races. Production-like integration tests remain necessary.
- Supporting old and new page bodies during migration can create temporary duplication. Each flag needs an owner and removal release.

## Non-goals

- No database, billing-provider, authentication, or report-catalog expansion. Backend work is limited to additive, read-only Dashboard summary enrichment from current tables.
- No arbitrary DOM/card builder, freeform overlapping canvas, third-party widget SDK, algorithmic Smart Stack, or widget-authored backend mutations. Customization is limited to the product-owned catalog and legal sizes.
- No new lead deletion, billing plan/family creation, billing exports, automation builder, notification delivery API, or language/density setting.
- No exposure of internal provider reconciliation tables, retry workers, support triage, alert delivery, compensation, or release-preflight tooling.
- No public marketing redesign, cinematic navigation, illustration system, or route-scoped marketing CSS inside the authenticated app.

## Product decisions still unresolved

These are deliberately not decided by the pitch:

1. **Unfiltered navigation:** locked for version one. Preserve the current visible-but-denied model to avoid a separate navigation-product change; direct-route denial remains fail closed before protected data loads.
2. **Secondary Account and Help destinations:** keep `/account/*` and `/help/*` as routes, or render some as addressable panels. Their fields, actions, states, and deep links must survive either choice.
3. **Leads load error:** the current page lacks a dedicated load-error surface. The redesign should add one only after its retry/ownership contract is specified.
4. **Lead delete mismatch:** the frontend store has an orphan delete action but the backend and UI do not. Do not add a control; decide whether to remove the orphan or implement a separately authorized product feature.
5. **Read-only billing:** Plans, Families, invoice capabilities, Advanced data, and additional billing exports deliberately expose less than backend schema breadth. Keep them read-only/unavailable until product and provider contracts authorize otherwise.
6. **Future preferences and workflows:** Automations, notification delivery preferences, language, and density remain future/read-only. The prototype’s state switch is a presentation tool, not a proposed production preference.
7. **Layout persistence scope:** locked. Version one is one ordered constrained-reflow arrangement, stored browser-locally per user, studio, and role. The next phase is server-side cross-device persistence with owner-published role defaults; named arrangements may follow after the single synchronized personal layout, and the version-one payload must not block them.
8. **Critical panel policy:** `Needs Attention` is non-removable in this pitch. Product must define which critical conditions may inject a temporary panel, how long dismissal lasts, and which roles can clear versus merely view it.
