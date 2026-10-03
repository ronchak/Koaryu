# Schedule rendering and test ownership

PR173 addresses FC2-01, FC2-06, FC2-17, FT2-02 and FT2-03. Month, week and day now share the existing recurring-entry builder. Generated occurrences no longer hide missing ones, and placeholder-only days render rather than showing an empty state. Display uses the controller's studio business date. One memoized per-date layout supplies minimum width, screen rendering and print order. Session wall-clock times, range loading, attendance records, filtering, mutation handlers and tenant boundaries are unchanged.

The tests mount real SchedulePageSection and ProgramsSection, including Button, Input and form handlers. The existing browser packer gains a bounded component mode that is disabled by default; copied hit-routing algorithms, handwritten calendar/program markup are absent from the final change. The Today case fixes browser time at September 6 while studio businessDate is September 8.

## Verification and test reduction

The worker passed 19 focused cases, 914 full frontend tests, ESLint and TypeScript on the original base. A fresh independent Astra reviewer found no material defect and independently passed the 19 focused cases plus six existing program-ownership tests using the shared helper. The fixed-clock refinement passed the 19 focused cases and lint. Root repeated all 19 cases after rebase from the documented frontend working directory.

The recorded scope includes every changed file plus unchanged schedule-calendar.ts and date.test.mjs named in the recipe. Product schedule code falls from 1,463 to 1,451 lines. Tests and the shared browser helper fall from 1,157 to 1,050 lines. Total reduction is 119 lines, including 107 test/helper lines. Focused cases increase from 18 to 19 as real behavior replaces copied implementations. The shared helper grows by 12 lines; no new test framework is introduced.

The original reviewed implementation was `b991c92a81eb4b0d5e0eaa0e6f9a9b887b0592f3`; fixed browser time was added in `0f833750dcea5e08d60d60b086f305047a9dfb29`. Rebased source `8c3fdf0dd0bdf1109f1989c9b5105e8bc065fc38` on main `648e27cfe668ff35b50a1e20ece1487aca78673e` has a byte-identical complete implementation diff, SHA256 `5793a6c30873109184f4ecd725cde6fc64bd1a0a281d9a03c8db45064bfc8414`. Final-head review and release CI remain merge gates.

## Limits

Screen checks use real inline component geometry plus minimal fixture positioning/grid rules. Pointer dispatch exercises the actual handler with browser-measured coordinates; it does not prove natural browser target selection under complete application CSS. The 390px form loads real Operations CSS and actual controls. Week print uses inline CSS from the component. Month print uses real entries and Operations CSS with fixture grid/theme rules. These are scoped component checks, not full dashboard visual or pagination evidence. The existing header print fixture remains an isolated CSS check. Other money, role and mutation source assertions in the mixed operations file remain with their owning changes; FT1-11 is still pending.

No production deployment, database migration or provider operation occurred.
