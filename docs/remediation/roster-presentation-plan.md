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

## Baseline and limits

The seven associated source and contract-test files total 2,215 lines before changes. `records-workspace-contract.test.mjs` has 12 `it` cases before changes. The planned helper adds one source file but removes the duplicated color decision from both components. The UI work must not introduce a second sort state, a global responsive observer, or changes to roster filtering, pagination, bulk actions, dates, imports, authorization, billing, tenants, or database code. The bounded browser check does not support a performance claim without profiling.

## Recorded result

The seven baseline files now total 2,245 lines, up 30 lines after deleting ten obsolete assertions from the existing contract suite. That suite remains at 12 cases. The two badge sources fell from 153 to 131 lines. The 27-line shared helper replaces their duplicated color decisions, leaving the color implementation five lines larger overall and shared by all existing callers. The focused test file adds two cases and 88 lines. Reusing the browser harness adds 13 lines. The narrow run covers 27 cases in total. One browser case checks mobile sort key and direction callbacks at 820px, hidden-rail pointer behavior, keyboard focus, selection, row opening, wide pointer behavior at 1400px, and both yellow tip badges. It does not profile roster rendering or exhaust every browser and input device.
