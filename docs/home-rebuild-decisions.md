# Koaryu Home rebuild: Phase 0 product decisions

Written by Fable 5.1 at the Phase 0 gate (2026-10-10) and adopted by the orchestrator. Where
this file and [`home-rebuild-brief.md`](home-rebuild-brief.md) differ, this file wins. Status
and dispositions live in [`home-rebuild-plan.md`](home-rebuild-plan.md).

Three rules govern every decision below, so engineers can resolve cases not listed:

1. **Below the header, a fact is a stat, a row, or a list item. Never two of those.** The header
   sentence is the one permitted echo, because it is prose and it is what a screen reader hears
   first.
2. **Stats say how the studio is doing and summarise list panels. Needs attention rows are
   things that need a hand and have no list of their own on Home. List panels carry names.**
3. **Numbers:** words up to ten and digits after in sentences and row titles. Digits in stat
   values, notes, tags and meta. "Spots", never "seats", everywhere on Home.

Everything uses only existing data, existing views, and the two planned URL readers (Schedule
`date`/`session`, Leads `focus`/`lead`). No new SQL.

## D1. Stats strip

**Verdict: the strip never carries an attention kind. Admin gets four stats, front desk and
instructor get three. "Classes today" is dropped from every role because it mirrors the agenda
band on the same page. Follow-ups and promotions leave Needs attention and become stat plus
list panel.**

| Role | Stats, left to right |
| --- | --- |
| admin | Follow-ups due · Ready to promote · Active students · Attendance |
| front_desk | Follow-ups due · Active students · Attendance |
| instructor | Ready to promote · Active students · Attendance |

Kit rule for three stats on phones: inside the existing `@media (max-width: 1023px)` block in
`horizon.module.css`, add `.stat:last-child:nth-child(odd) { grid-column: 1 / -1; }`. Desktop
already sizes columns from `--hz-stat-count`.

**Follow-ups due** (admin, front_desk)

- Value: overdue plus due today, from the same query as the Follow-ups rows.
- Note: overdue > 0 → "Oldest 2 days overdue" (alert). Overdue = 0 and due today > 0 → "All due
  today" (warn). Both zero → "Nothing due" (calm).
- Link: overdue > 0 → `/leads?focus=overdue`; else due today > 0 → `/leads?focus=today`; else
  `/leads`.

**Ready to promote** (admin, instructor)

- Value: every eligible student on the primary ladder, including those who need approval.
- Note: needs approval > 0 → "2 need approval" / "1 needs approval" (warn). Eligible > 0 and
  none need approval → "Ready when you are" (calm). Zero → "Nobody waiting" (neutral).
- Link: `/belt-tracker#belt-ready-title`.

**Active students** (all roles)

- Value: students with status active or trialing.
- Note: non-zero parts joined with " · ": "2 trialing · 1 on hold". Both zero: "Nobody trialing
  or on hold". Tone neutral.
- Link: `/students` (not `?status=active`, which excludes trialing).

**Attendance** (all roles)

- Value: round(seats filled ÷ capacity × 100), unit "%".
- Note: "7 of 74 spots · 30 days". Capacity or sessions zero: value "—", note "No classes
  tracked yet". Tone neutral.
- Link: `/reports`.

Strip accessible label: "At a glance".

## D2. Needs attention rows

**Verdict: four kinds, in a fixed severity order: payments, setup, away students, missing
emergency contact. Follow-ups and promotions are not rows. Setup names the next step and links
to it; recompute-on-read is accepted. Missing contact links to `/students?status=active`, or to
the student's profile when the count is one.**

The first row's action renders as the emphasised (ink) button; the rest are text actions. Keep
the six-row cap for future kinds.

| Kind | Roles | Tone, icon | Title | Meta | Action | Link |
| --- | --- | --- | --- | --- | --- | --- |
| payments | admin, front_desk | alert, CreditCard | "One payment needs a look" / "Three payments need a look" | "Failed, unpaid or past due" | Review | `/billing?tab=invoices` |
| setup | admin | warn, ListChecks | "Four setup steps left" / "One setup step left" | "Next: Add your weekly classes" | Continue | the next incomplete step's page |
| away | all | warn, Clock3 | "11 students away" / "One student away" | "No check-in for two weeks or more" | See who | `/students?inactiveDays=14` |
| contact | admin, front_desk | warn, Phone | "No emergency contact for 18 students" / "No emergency contact for one student" | "Add one on each student's profile" / "Add one on their profile" | Open students / Open profile | `/students?status=active` / `/students/<id>` when the server returns the single student's id |

- Setup steps in order, with their pages: "Name your programs" → `/settings`; "Add your
  students" → `/students/import`; "Set your belt system" → `/belt-tracker`; "Add your weekly
  classes" → `/schedule`; "Add tuition plans" → `/billing`. The server picks the first
  incomplete step as next; the count is the number incomplete. Tuition counts only for roles
  that can see billing (admin), and setup is admin-only.
- Recompute-on-read is acceptable; no latch, no migration.
- Follow-up recorded: a real "missing emergency contact" roster filter in a later release.

Empty: `CalmState`, calm tone, Check icon, "All clear" / "Nothing needs you right now."

## D3. Today's classes

**Verdict: rows show start time, class name, and one count phrase chosen by state. "Take
attendance" on classes that have started, "Open" on classes that have not. The current or next
class gets the emphasised action. Overflow is a "Two more classes" link. Week strip removed.**

- Row: `4:00 PM` (tabular, plain ink, `formatClockTime` on the studio-local start), class name
  (strong), count phrase, action label at the right. Start time only. The whole row links to
  `/schedule?date=<studio today>&session=<id>`.
- Count phrase, evaluated on the studio clock and re-evaluated when the payload refreshes (no
  separate ticker):
  - checked in > 0 → "4 checked in" (meta). Never "of capacity".
  - checked in = 0 and not started → "12 spots" (meta) when capacity exists; nothing otherwise.
  - checked in = 0 and started → `ToneTag` warn "No check-ins".
- Action: started → "Take attendance"; not started → "Open". Emphasis goes to the first row
  that has not ended; none if every class has ended. Rows at least 40px tall; full width on
  phones.
- Overflow: below the rows, "Two more classes" / "One more class" / "12 more classes" →
  `/schedule?date=<today>`. The panel header link stays "Open schedule" → `/schedule`.
- Empty: `CalmState`, calm, Moon icon, "No classes today" / "The mat is quiet. Nothing to check
  in."
- Week strip removed.

## D4. Optional panels

**Verdict: three list panels, no Compact/Expanded in version one.**

**Follow-ups** (admin, front_desk; default on). Up to six rows, oldest due first, from the same
query as the stat. Row: name (strong), `ToneTag` "2 days overdue" (alert) or "Due today"
(warn), then the next step as meta from `getLeadNextAction` in
`components/leads/lead-focus.ts`, so Home and Leads agree. The payload row carries `stage`, not
`next_step` text. Row link `/leads?lead=<id>`. Header link "All leads" → `/leads`. Empty: "No
follow-ups due" / "Nobody to call today."

**Ready to promote** (admin, instructor; default on). Up to six rows. Row: name (strong);
swatch, "White", lucide arrow icon, swatch, "Yellow" (swatches and icon `aria-hidden`; accessible text "White to Yellow"); meta "9 classes
since last belt"; `ToneTag` warn "Needs approval" when it needs approval. Unranked: a hollow
swatch with "No belt yet" then the arrow icon and "White" and meta "9 classes so far". Row link `/students/<id>`. Header
link "Open belt tracker" → `/belt-tracker#belt-ready-title`. Empty: "Nobody ready yet" /
"Students show up here when they qualify for the next belt."

**New students** (all roles; default off; renamed from "Recent students"). Up to five rows. Row:
name (strong), meta "Started Oct 3 · Trialing" (status words Active, Trialing, On hold; omit the
date when it is null). Row link `/students/<id>`. Header link "All students" → `/students`.
Empty: "No new students yet" / "Students you add show up here."

List-panel rows are links with no separate action label. No panel declares sizes; keep `size`
in the data shape and clamp it to the empty declared set. Default order: Follow-ups, Ready to
promote, New students (hidden). Each role sees only the panels it may see.

## D5. Edit Home

**Verdict: approved with amendments.**

- **Trigger:** ghost `Button` with the lucide `SlidersHorizontal` icon and visible text "Edit
  Home", right-aligned in a 40px row directly below Today's classes and above the optional
  panels, on every size. Never in the Header. Visible even when every optional panel is hidden.
- **Sheet:** `role="dialog"`, `aria-modal`, labelled by its title "Edit Home". Desktop: right
  side sheet. Phone: full-height bottom sheet with a sticky footer. No description sentence.
  - Group "Always shown" (label once): three greyed rows with no controls: "At a glance",
    "Needs attention", "Today's classes".
  - Group "Panels": one row per optional panel the role may see, in current order. Row: drag
    handle (lucide `GripVertical`, a button labelled "Move Follow-ups"), title, a real switch
    labelled "Show Follow-ups". Hidden panels keep their row and position, switch off, title in
    soft ink.
  - Footer: "Reset to defaults" (ghost, left, disabled at defaults) and "Done" (primary, right).
    No Cancel. Escape and backdrop click behave as Done.
- **Live preview:** every change applies behind the sheet immediately with the existing
  position-settle animation; reduced motion disables the animation, not the change.
- **Keyboard:** Tab reaches each handle and switch; with a handle focused, ArrowUp/ArrowDown
  move the row; Space toggles the switch; Escape closes. A polite live region announces
  "Follow-ups moved up", "Follow-ups hidden", "Follow-ups shown", "Reset to defaults".
- **Data shape:** `order` lists every entitled panel id, visible or hidden; `hidden` is the
  subset that is off. Reconcile drops unknown ids, appends newly entitled ids (visible unless
  defaults say hidden), and clamps `size` to the declared set.
- **Persistence:** debounce the PUT by about 400ms, and also flush on Done and on
  `visibilitychange`.

## D6. Header

**Verdict: greeting h1 on the studio clock; eyebrow is the studio date (plus " · Preview data");
the description is one sentence built from a fixed grammar. The slot reserves one line while
loading and shows no text.**

- Title: "Good morning, Ronak." or "Good morning." Keep the period boundaries and name rules in
  `dashboard-brief-greetings.ts`; resolve on the studio clock at first client render; never
  change after paint.
- Eyebrow: "Saturday, October 10"; preview: "Saturday, October 10 · Preview data".
- Actions: Add student (secondary), Take attendance (primary), role-filtered as today.

Sentence = **anchor** + up to **two needs clauses**, highest priority first. Two items: "A and
B." Three: "A, B, and C." Anchor: "No classes today" / "One class today" / "Three classes
today" / "12 classes today". Zero visible needs: "{anchor} and nothing else needs you."; with no
classes: "No classes today and nothing needs you."

| # | Input | Roles | Singular | Plural |
| --- | --- | --- | --- | --- |
| 1 | payments | admin, front_desk | one payment to chase | {n} payments to chase |
| 2 | follow-ups overdue | admin, front_desk | one follow-up overdue | {n} follow-ups overdue |
| 3 | setup steps | admin | one setup step left | {n} setup steps left |
| 4 | promotions needing approval | admin | one promotion to approve | {n} promotions to approve |
| 5 | follow-ups due today (only when overdue = 0) | admin, front_desk | one follow-up due today | {n} follow-ups due today |
| 6 | students ready (admin only when none need approval; instructor always) | admin, instructor | one student ready for the next belt | {n} students ready for the next belt |
| 7 | away students | all | one student hasn't been in for two weeks | {n} students haven't been in for two weeks |
| 8 | missing contacts | admin, front_desk | one student has no emergency contact on file | {n} students have no emergency contact on file |

"Nothing (else) needs you" is true exactly when every visible input is zero.

Worked examples:

1. admin, 3 classes, 1 payment, 2 overdue, 1 due today: "Three classes today, one payment to
   chase, and two follow-ups overdue."
2. admin, 0 classes, 2 due today: "No classes today and two follow-ups due today."
3. admin, 2 classes, nothing: "Two classes today and nothing else needs you."
4. admin, 0 classes, nothing: "No classes today and nothing needs you."
5. admin, new studio, 4 setup steps: "No classes today and four setup steps left."
6. admin, 5 classes, 3 payments, 2 to approve: "Five classes today, three payments to chase,
   and two promotions to approve."
7. admin, 1 class, 3 ready (no approval), 11 away: "One class today, three students ready for
   the next belt, and 11 students haven't been in for two weeks."
8. admin, 12 classes, 1 payment, 4 overdue, 1 setup step: "12 classes today, one payment to
   chase, and four follow-ups overdue."
9. admin, 1 class, 1 overdue: "One class today and one follow-up overdue."
10. front_desk, 3 classes, 1 payment, 3 due today: "Three classes today, one payment to chase,
    and three follow-ups due today."
11. front_desk, 2 classes, 18 missing contacts: "Two classes today and 18 students have no
    emergency contact on file."
12. instructor, 4 classes, 2 ready (one needs approval): "Four classes today and two students
    ready for the next belt."
13. instructor, 0 classes, 1 away: "No classes today and one student hasn't been in for two
    weeks."

Loading: the slot reserves one line and shows no text. Error with retained data: the sentence is
computed from the retained payload and stays. Error with no data: empty.

## D7. Copy

The complete string set is the source for `lib/dashboard/home-copy.ts`. `{n}` and the like are
placeholders; `words(n)` means number words up to ten, digits after; `clock(t)` is
`formatClockTime` from `components/schedule/schedule-display.ts`. The four lead next-step
strings stay in Leads and are reused through `getLeadNextAction`.

```ts
// Header
header.greeting.named = "Good {period}, {firstName}."
header.greeting.anonymous = "Good {period}."
header.eyebrow.date = "{weekday}, {month} {day}"
header.eyebrow.previewSuffix = " · Preview data"
header.actions.addStudent = "Add student"
header.actions.takeAttendance = "Take attendance"

// Sentence (see D6 grammar)
sentence.anchor.none = "No classes today"
sentence.anchor.one = "One class today"
sentence.anchor.many = "{words(n)} classes today"
sentence.quiet.withClasses = "{anchor} and nothing else needs you."
sentence.quiet.noClasses = "No classes today and nothing needs you."
sentence.join.two = "{a} and {b}."
sentence.join.three = "{a}, {b}, and {c}."
sentence.payments = ["one payment to chase", "{words(n)} payments to chase"]
sentence.followUpsOverdue = ["one follow-up overdue", "{words(n)} follow-ups overdue"]
sentence.setup = ["one setup step left", "{words(n)} setup steps left"]
sentence.approvals = ["one promotion to approve", "{words(n)} promotions to approve"]
sentence.followUpsToday = ["one follow-up due today", "{words(n)} follow-ups due today"]
sentence.ready = ["one student ready for the next belt", "{words(n)} students ready for the next belt"]
sentence.away = ["one student hasn't been in for two weeks", "{words(n)} students haven't been in for two weeks"]
sentence.contacts = ["one student has no emergency contact on file", "{words(n)} students have no emergency contact on file"]

// At a glance (stats)
stats.label = "At a glance"
stats.followUps.label = "Follow-ups due"
stats.followUps.note.overdue = ["Oldest 1 day overdue", "Oldest {n} days overdue"]
stats.followUps.note.today = "All due today"
stats.followUps.note.none = "Nothing due"
stats.promotions.label = "Ready to promote"
stats.promotions.note.approval = ["1 needs approval", "{n} need approval"]
stats.promotions.note.ready = "Ready when you are"
stats.promotions.note.none = "Nobody waiting"
stats.activeStudents.label = "Active students"
stats.activeStudents.note.trialing = ["1 trialing", "{n} trialing"]
stats.activeStudents.note.onHold = ["1 on hold", "{n} on hold"]
stats.activeStudents.note.separator = " · "
stats.activeStudents.note.none = "Nobody trialing or on hold"
stats.attendance.label = "Attendance"
stats.attendance.unit = "%"
stats.attendance.note = "{filled} of {capacity} spots · 30 days"
stats.attendance.note.none = "No classes tracked yet"

// Needs attention
attention.title = "Needs attention"
attention.empty.title = "All clear"
attention.empty.detail = "Nothing needs you right now."
attention.payments.title = ["One payment needs a look", "{words(n)} payments need a look"]
attention.payments.meta = "Failed, unpaid or past due"
attention.payments.action = "Review"
attention.setup.title = ["One setup step left", "{words(n)} setup steps left"]
attention.setup.meta = "Next: {stepTitle}"
attention.setup.action = "Continue"
attention.setup.steps.programs = "Name your programs"
attention.setup.steps.students = "Add your students"
attention.setup.steps.belts = "Set your belt system"
attention.setup.steps.classes = "Add your weekly classes"
attention.setup.steps.billing = "Add tuition plans"
attention.away.title = ["One student away", "{words(n)} students away"]
attention.away.meta = "No check-in for two weeks or more"
attention.away.action = "See who"
attention.contact.title = ["No emergency contact for one student", "No emergency contact for {words(n)} students"]
attention.contact.meta = ["Add one on their profile", "Add one on each student's profile"]
attention.contact.action = ["Open profile", "Open students"]

// Today's classes
agenda.title = "Today's classes"
agenda.link = "Open schedule"
agenda.checkedIn = ["1 checked in", "{n} checked in"]
agenda.spots = ["1 spot", "{n} spots"]
agenda.noCheckIns = "No check-ins"
agenda.action.started = "Take attendance"
agenda.action.upcoming = "Open"
agenda.more = ["One more class", "{words(n)} more classes"]
agenda.empty.title = "No classes today"
agenda.empty.detail = "The mat is quiet. Nothing to check in."

// Follow-ups panel
followUps.title = "Follow-ups"
followUps.link = "All leads"
followUps.tag.overdue = ["1 day overdue", "{n} days overdue"]
followUps.tag.today = "Due today"
followUps.empty.title = "No follow-ups due"
followUps.empty.detail = "Nobody to call today."

// Ready to promote panel
promotions.title = "Ready to promote"
promotions.link = "Open belt tracker"
promotions.belts = "{from} to {to}"      // accessible text; the visible arrow is a lucide ArrowRight icon
promotions.noBelt = "No belt yet"
promotions.classes.ranked = ["1 class since last belt", "{n} classes since last belt"]
promotions.classes.unranked = ["1 class so far", "{n} classes so far"]
promotions.tag.approval = "Needs approval"
promotions.empty.title = "Nobody ready yet"
promotions.empty.detail = "Students show up here when they qualify for the next belt."

// New students panel
newStudents.title = "New students"
newStudents.link = "All students"
newStudents.meta.withDate = "Started {month} {day} · {status}"
newStudents.meta.noDate = "{status}"
newStudents.status.active = "Active"
newStudents.status.trialing = "Trialing"
newStudents.status.paused = "On hold"
newStudents.empty.title = "No new students yet"
newStudents.empty.detail = "Students you add show up here."

// Loading (one page-level state; placeholder bands carry their real titles, no body text)
loading.status = "Loading Home"

// Error (one page-level state)
error.refresh.title = "Couldn't refresh"
error.refresh.detail = "Showing what we had as of {clock(t)}."
error.load.title = "Couldn't load Home"
error.load.detail = "Check your connection and try again."
error.retry = "Try again"

// Edit Home
edit.trigger = "Edit Home"
edit.title = "Edit Home"
edit.alwaysShown = "Always shown"
edit.panels = "Panels"
edit.band.glance = "At a glance"
edit.band.attention = "Needs attention"
edit.band.classes = "Today's classes"
edit.panel.followUps = "Follow-ups"
edit.panel.promotions = "Ready to promote"
edit.panel.newStudents = "New students"
edit.move = "Move {panel}"
edit.show = "Show {panel}"
edit.reset = "Reset to defaults"
edit.done = "Done"
edit.announce.shown = "{panel} shown"
edit.announce.hidden = "{panel} hidden"
edit.announce.movedUp = "{panel} moved up"
edit.announce.movedDown = "{panel} moved down"
edit.announce.reset = "Reset to defaults"
```

Orchestrator amendment: the brief's definition of done bans Unicode arrows in dashboard
files, so belt pairs render as swatch, name, lucide `ArrowRight` (`aria-hidden`), swatch, name,
and the accessible text reads "White to Yellow".

Accessible labels: the strip is "At a glance"; row chips, belt swatches and arrows are
`aria-hidden`; the drag handle and switch use `edit.move` and `edit.show`; the dialog is
labelled by its title; the retry button is "Try again".

Brief 4.7 table: approved, except that the per-panel loading and error strings ("Checking
today's classes.", "Couldn't load today's classes.", "Counting students.", "Checking
payments.") are not needed, because the page has one loading and one error state.

## D8. Other changes

1. **Paper grain: drop it.**
2. **Desktop geometry:** strip; then Needs attention and Today's classes side by side with
   `align-items: start` (neither stretches to the other); then the Edit Home row; then optional
   panels in a two-column grid in preference order. One column at and below 1023px. No minimum
   heights.
3. **No bold lead-in in the description.**
4. **First-row emphasis is a `HorizonWorkRow` prop,** set by Home on the first Needs attention
   row and the current-or-next class.
5. **Follow-up rows carry `stage`, not `next_step` text.**
6. **"Spots" replaces "seats".**
