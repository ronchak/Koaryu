# Roster presentation plan

Scope: `FC3-02`, `FC3-03`, and `FC3-05` only, against `9b4df618165146ef1f59472aa56e5e9266c27bd0`.

## Current paths and contracts

- `StudentRosterPageContent` is the only caller of both `StudentRosterToolbar` and `StudentRosterTable`. Its `onSort` callback is the existing controller entry point. The controller changes a new key to ascending and toggles the current key's direction.
- The table header owns the three existing sort buttons. CSS hides that header at `max-width: 820px`. The toolbar remains visible, so it can expose the same callback without changing query, pagination, or selection behavior.
- `StudentRankBadge` has five student-detail call sites. `RankBadge` has six belt-tracker call sites. `rank-visuals.tsx` contains the only current luminance rule. `mock-data.ts` only supplies colors.
- `StudentRosterPageContent` owns quick-view state. Rows update it on focus and pointer entry. CSS hides the rail at `max-width: 1399px`. Focus, row clicks, profile buttons, and selection controls must keep their current behavior.

## Changes

1. Add a mobile-only labeled sort field to the toolbar. Its key selector and direction button call the existing `onSort` callback. Do not add sorting logic or change the desktop header.
2. Move the existing luminance calculation into one small shared helper. Both rank badges and `BeltVisual` will consume it. Preserve each component's inputs, tip rendering, and fallback behavior.
3. Track the existing rail media query inside the roster page. Pass pointer hover updates only while the rail is visible. Keep focus updates active and retain the current quick-view value when the breakpoint changes.
4. Delete the obsolete source assertions for these findings. Exercise color decisions as code, then mount the production roster page and both production badge components in Chromium through the existing browser harness. Load the roster CSS into the page so the 820px and 1400px behavior is real.
5. Use black for the luminance rule's dark foreground so middle gray retains readable contrast. At the existing 820px breakpoint, give toolbar groups full rows to prevent filter and sort controls from overlapping at a 521px available toolbar width.

## Baseline and limits

The seven associated source and contract-test files total 2,215 lines before changes. `records-workspace-contract.test.mjs` has 12 `it` cases before changes. The planned helper adds one source file but removes the duplicated color decision from both components. The UI work must not introduce a second sort state, a global responsive observer, or changes to roster filtering, pagination, bulk actions, dates, imports, authorization, billing, tenants, or database code. The bounded browser check does not support a performance claim without profiling.

## Recorded result

The seven baseline files now total 2,247 lines, up 32 lines after removing seven existing assertions, six roster assertions and one badge assertion. The contract file is eight lines shorter and remains at 12 cases. The two badge sources fell from 153 to 131 lines. The 27-line color helper replaces their duplicated decisions, leaving the color implementation five lines larger overall and shared by all existing callers. The focused browser test adds two cases and 110 lines, while the shared browser harness adds 13 lines. Test and harness code therefore increases by 115 net lines. The narrow run covers 27 cases in total. One browser case checks mobile sort key and direction callbacks plus hidden table header and rail at 820px, nonoverlapping interactive controls at a constrained 521px toolbar width in a 601px viewport, hidden mobile sort plus visible table header and rail at 1400px, narrow pointer behavior, keyboard focus, selection, row opening, wide pointer behavior, and both yellow tip badges. It loads the actual roster CSS and a local `box-sizing` and padding rule needed for the counterexample, but it does not load the complete app or global CSS. The separate reviewer reproduced the 521px width with built global CSS. The test does not profile roster rendering or exhaust every browser and input device.

## Verification

- The final focused run passed all 27 cases after the contrast and 601px toolbar fixes. The saved pre-fix counterexample shows the program filter intersecting the sort selector.
- The full frontend suite passed 918 tests in 144 suites before the final contrast and toolbar changes. Treat it as earlier broad regression evidence; the final focused run covers the changed behavior.
- The normal `npm run build` Turbopack pipeline passed after the final changes with `.env.example` explicitly sourced and worktree-local dependencies. No hosted environment or deployment was used.
- Private logs are under `/Users/openclaw/Koaryu Remediation/2026-09-07/roster-presentation/`.
