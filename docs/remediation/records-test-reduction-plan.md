# Records workspace test reduction

This change advances FT1-11 for `frontend/tests/records-workspace-contract.test.mjs`.
It does not close the umbrella source-test cleanup finding.

PR176 added mounted coverage for the real roster and rank badges but increased its
test and helper scope by 115 lines. This follow-up removes redundant source-shape,
copy, layout, and decorative CSS assertions from the older records contract. Existing
behavioral suites remain the owners for roster interactions, checkbox propagation,
import processing, lead ordering and recovery, belt draft locking, and promotion
history data.

The reduced file keeps five narrow policies that existing behavior suites do not
cover directly: no promotion-history or lead-deletion controls, active-assignee and
inactive-current-assignee presentation, lead inspector focus and Escape handling,
singular loading announcements, belt tab and progress semantics, and shared touch,
focus, motion, and print CSS requirements. It adds no mounted fixture or production
test API.

## Accounting

| Measure | Before | After | Change |
| --- | ---: | ---: | ---: |
| Lines | 261 | 73 | -188 |
| Cases | 12 | 5 | -7 |
| Assertion statements | 136 | 23 | -113 |

Deleted cases covered roster source shape, import stage and copy spelling,
progression and lead layout vocabulary, Belt notice and sticky geometry, folio and
token styling, and shell geometry plus route component spelling. The prior broad lead
cases were collapsed into the retained policy checks. No production behavior or test
harness changed.

## Verification and limits

The reduced file and its existing roster, selection, import, lead, belt, and promotion
history replacement suites pass together: 136 tests across 12 suites. The five cases
left here still inspect source or CSS. They prove only the named forbidden-control and
accessibility policies; they do not claim mounted interaction, geometry, route
readiness, or complete mutation coverage. Later owning UI work may replace a retained
policy with behavior coverage without adding a parallel test framework.
