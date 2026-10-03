# Formatter baseline verification

Base: `30891b4d0796172ad93f20cd29ff47c90375899e`.

Ruff `0.16.7` and Prettier `3.9.6` are development-only, exactly pinned tools. Both use a 100-column target. Existing candidate CI checks formatting in its backend/frontend jobs. Root and package AGENTS.md name the commands.

The 100-column choice balances existing style and initial reflow. Ruff 88 would change 262 files with 60,889 added/deleted lines; 100 changes 256 with 50,515. Prettier 100 changes fewer files than 80 or 120. These are dry-run comparisons before the exceptions below, not final PR totals.

The mechanical commit contains formatter output only. Root independently compared Python ASTs for all 256 changed Python files, with no differences, and regenerated all 416 changed frontend authored files from the base with pinned Prettier, with no mismatches. Generated readiness metadata, API types, Vercel configuration, migrations and SQL verification files remain byte-identical. The dependency locks add only the two formatter packages.

The first candidate CI run exposed one moved scanner fingerprint: the public browser storage key in `student-roster-location.ts` moved from line 25 to line 34. The current-tree `.gitleaksignore` entry follows that exact line change. Its historical commit entry and the scanner rules remain unchanged.

## Explicit exceptions

The full frontend pass initially failed 16 source-text assertions in ten suites. A targeted rerun exposed two more one-line confirmation-text constraints. All assertions are retained. Fifteen individually listed source files remain byte-identical to the base and are excluded in `frontend/.prettierignore`, each with its owning test named. These are temporary constraints, not claimed formatting coverage. Remove an exception only with the owning test/presentation change and behavioral verification. Do not reflow an excluded file inside an unrelated behavior PR.

Generated files, dependencies, build output, provider metadata/configuration, Markdown, environment files and the npm lock are outside Prettier's authored-code baseline. Ruff retains its default exclusions and additionally excludes generated readiness metadata. Generated files retain their own deterministic checks.

## Verification and test accounting

- Backend: 1,904 tests passed.
- Frontend: 912 tests passed, zero failures or skips. The ten affected source-contract suites also passed all 72 cases after the exceptions.
- Frontend lint and production build passed using synthetic example environment values.
- Both formatter checks passed twice; API type verification passed.
- Release-attestation verification passed eight tests and reproduced 21 SQL statements, ten historical restore scripts and five generated continuations.
- No tests or assertion semantics were added or removed. Authored backend tests, frontend tests/helpers and frontend e2e total 282 files. Physical lines changed from 85,948 to 101,079, an increase of 15,131 from formatting alone. Root independently recomputed those totals. Later test reductions must use the formatted baseline.

The PR still requires fresh independent review and exact-head candidate CI before the guarded merge. Local tests do not replace that gate. No hosted database work, production migration, deployment, backup, billing activation, mail or DNS operation is part of this change.
