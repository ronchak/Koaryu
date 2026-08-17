# Koaryu dashboard redesign implementation plan

Status: product and engineering proposal, not a production implementation
Contract baseline: repository `0b46b823e175e50fa8d5625301925baf121945da`
Evidence owner: WS-1 product and contract inventory
Pitch artifact: [`dashboard-redesign-pitch.html`](./dashboard-redesign-pitch.html)

## Outcome

Replace the current authenticated dashboard’s page-title, card, and modal grammar with one operational system that remains legible from the morning brief through a dense billing reconciliation.

The decision is **Mat shell posture + Ledger data treatment**, with **Wall behavior limited to pinning blocks onto Today**:

- The indexed spine is stable global navigation.
- Every route starts with one sticky slug band declaring route, scope, freshness, and primary actions.
- A gutter index provides local navigation for deep pages such as Billing, Student Detail, Settings, and Account.
- A contextual margin rail contains only the current selection’s history, notes, related records, and audit facts. It never becomes a second navigation system.
- Ruled rows, registers, bands, and printable sheets replace generic KPI-card grids.
- Focused confirmations and short forms remain dialogs. Deeper or tabular work becomes a route or URL-addressable sheet. Tables never appear in modals.

This is an interaction and information-architecture change, not a beige reskin. It transfers Koaryu’s calm, tactile, handled-record character while leaving the public site’s cinematic scroll, illustrative scenes, and route-scoped marketing texture behind.

## Concepts considered

### Concept A: Dojo Ledger, recommended

Dojo Ledger treats each surface as a handled record. Stable rules and columns support comparison; a left state gutter makes exceptions visible without adding another field; selected records open relevant context in the margin rail. Today is a verb-first queue, Students is a ruled roster, Student Detail is a card file with a chronological History leaf, and Billing is a set of related books held together by a persistent money band.

It survives the two highest-risk surfaces:

- Student Detail keeps identity, contacts, address, emergency and guardian information, lifecycle dates and holds, program and rank state, promotion history, photo, notes, permissions, and archive confirmation in one coherent record.
- Billing keeps exact money, dates, statuses, payer/provider references, provider-mode gates, reconciliation, and read-only/unavailable truth visible without hiding entity relationships inside cards or drawers.

### Concept B: Training Floor, rejected as the universal system

Training Floor is a spatial, time-oriented field. Work sits in fixed lanes; horizontal position communicates time or urgency; active work moves toward a commit line. It is strong for Today, lead follow-up, the week schedule, attendance, and import’s Read → Map → Land sequence.

It fails as the product-wide owner. On Billing, the need to show six domains, precise references, provider/Core/Connect boundaries, and read-only states creates parallel lanes plus drawers plus a second detail system. On Student Detail, current facts, conditional guardian/emergency fields, lifecycle controls, and history compete for the same spatial lane. The user either loses comparison or repeatedly opens overlays.

Training Floor remains an optional page-level treatment for Schedule’s time canvas and Today’s queue. It does not define navigation, data tables, or entity detail.

### Wall constraint

Full Wall composition is rejected because persistent arbitrary panels would create a second product with per-user layout state, conflict resolution, restore semantics, and clutter controls. The only retained Wall behavior is **Pin to Today** for an existing saved report, roster slice, billing exception view, or schedule view. Pinned blocks append below the canonical Today queue, have a clear source link, and can be removed. They never override the canonical morning brief.

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

`TodayPins` stores references to supported saved views, with a hard product-defined cap, stable source URL, owner, ordering, and remove action. The canonical Today content renders even when pins fail.

### Surface primitives

- `LedgerTable`: semantic table for genuinely two-dimensional comparison, sticky headers, state gutter, selection, bulk-action band, and explicit loading/error/empty rows.
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

Desktop uses a narrow indexed spine, a flexible sheet, and an optional contextual rail. Tablet collapses the rail below the current section unless the selected context is essential. Mobile puts navigation and screen choices in reading order, converts label/value comparisons into stacked labeled rows, and raises the batch band above safe-area insets. Tables become labeled rows unless their meaning is inherently two-dimensional. Schedule is the only intentionally horizontally scrollable matrix.

All interactive controls have visible labels, keyboard operation, selected/expanded state, and a target near 44px where feasible. Focus uses a high-contrast two-pixel outline with offset. Landmarks, headings, skip link, live announcements, form labels, status text, and destructive-dialog descriptions are required. Color never carries status or belt rank alone. Unknown/denied states fail closed and state why.

Motion is limited to selection, commit, and position feedback, no longer than 200ms for operational data. There is no autoplay, scroll interception, parallax, reveal-on-scroll, or animated texture. `prefers-reduced-motion` removes non-essential transitions and scripted smooth scrolling.

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

### Phase 2: Today, Students, and Student Detail

- Migrate Today to the linked sentence, day band, verb-first queue, and bounded pins.
- Migrate Students to the ruled roster, sticky filters, state gutter, bottom bulk band, and page/query notices.
- Migrate Student Detail to card-file leaves with History in the margin rail and focused edit/archive/photo dialogs.

Exit gate: all WS-1 student fields, permissions, validation, partial/full roster states, and destructive confirmations pass automated and keyboard checks.

### Phase 3: Schedule, attendance, import, belts, and leads

- Introduce the Week Sheet with Month/Week/Day support and an addressable session sheet.
- Move attendance to an explicit commit mode with pending/offline disclosure.
- Build Read → Map → Land import stations, including row-addressable errors and every mapping/policy.
- Apply Ledger treatment to rank plan and eligibility while retaining atomic save/discard/conflict semantics.
- Use the pipeline-time treatment for Leads while retaining current add/open/stage/follow-up/activity/convert/lost actions and excluding delete.

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

The migration is route-by-route but the shell and state vocabulary are singular. A route may use the new shell with its old body while its surface is being migrated. Domain owners, APIs, and database contracts remain unchanged.

Rollback is the shell/surface flag plus the preserved old page component during the window. There is no dual-write, data migration, or new persistent layout state before Today pins are separately specified. If a migrated route fails parity, revert that route’s composition while retaining the shared shell only if its own gate remains green. Remove flags and old components only after one stable release window and repository-owned evidence that no fallback path remains in use.

## Tests and acceptance gates

- Contract: all 27 routes; every WS-1 field/action/state/role; negative assertions for lead delete, internal-only tools, and non-live features.
- Unit: view-model provenance, permission resolution, slug-band copy, partial-count suppression, URL state, and dialog/sheet focus restoration.
- Integration: route loaders and failure states; Admin/Front desk/Instructor/unknown; preview/live; Core/Connect gates; import policies; atomic belt conflicts; destructive typed confirmation.
- End to end: attendance → student history/Today queue; CSV import → roster/belt resolution; failed charge → remedy/reconcile → paid invoice.
- Accessibility: automated semantics plus manual keyboard traversal, screen-reader announcements, zoom/reflow, contrast, reduced motion, and focus order.
- Responsive: representative desktop, tablet, 320px mobile, short viewport, coarse pointer, and Schedule-only horizontal scroll.
- Print: student record, attendance sheet, report, and billing register with scope/as-of/context retained.
- Performance: 500-row roster and 800-row invoice fixtures; sticky chrome, selection, and filtering remain responsive without hiding rows behind client-only approximations.
- Release: exact-head build/lint/tests, API-contract check when response shapes change, and visual comparison on the same release candidate.

Acceptance requires zero missing manifest entries, no unsafe partial-data calculations, no protected-data preload on denied routes, no new backend capability implied by presentation, and no essential feedback delivered only by toast or color.

## Risks

- A universal ledger can feel severe to occasional Front desk users. Clear action hierarchy, plain labels, and progressive section indexing must be tested with real workflows.
- The margin rail can decay into a miscellaneous drawer. Its allowed content types and mobile order need component-level constraints.
- URL-addressable sheets change back-button behavior and may expose hidden loader coupling in Schedule and Billing.
- Heavy fixtures can validate layout while missing real provider timing, partial failures, and permission races. Production-like integration tests remain necessary.
- Supporting old and new page bodies during migration can create temporary duplication. Each flag needs an owner and removal release.

## Non-goals

- No backend, database, billing-provider, authentication, or report-catalog expansion.
- No arbitrary Wall/dashboard builder, per-user layout editor, or drag-anything canvas.
- No new lead deletion, billing plan/family creation, billing exports, automation builder, notification delivery API, or language/density setting.
- No exposure of internal provider reconciliation tables, retry workers, support triage, alert delivery, compensation, or release-preflight tooling.
- No public marketing redesign, cinematic navigation, illustration system, or route-scoped marketing CSS inside the authenticated app.

## Product decisions still unresolved

These are deliberately not decided by the pitch:

1. **Unfiltered navigation:** keep the current visible-but-denied model, or filter the spine by role while retaining direct-route denial. Security behavior is settled; navigation behavior is not.
2. **Secondary Account and Help destinations:** keep `/account/*` and `/help/*` as routes, or render some as addressable panels. Their fields, actions, states, and deep links must survive either choice.
3. **Leads load error:** the current page lacks a dedicated load-error surface. The redesign should add one only after its retry/ownership contract is specified.
4. **Lead delete mismatch:** the frontend store has an orphan delete action but the backend and UI do not. Do not add a control; decide whether to remove the orphan or implement a separately authorized product feature.
5. **Read-only billing:** Plans, Families, invoice capabilities, Advanced data, and additional billing exports deliberately expose less than backend schema breadth. Keep them read-only/unavailable until product and provider contracts authorize otherwise.
6. **Future preferences and workflows:** Automations, notification delivery preferences, language, and density remain future/read-only. The prototype’s state switch is a presentation tool, not a proposed production preference.
