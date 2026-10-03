# September 13 bounded refactor verification

Scope: four ordered items, 10 weekly percentage points maximum, stop new work at 8. Baseline main was `d016b6d95597c4978805c1956c9c9ba4a6940842`, weekly usage 45. Each item had a fresh Sol implementer, coordinator review and a fresh independent reviewer. Review and CI were bound to the final heads below.

| PR | Final reviewed head | Merge | Exact-head Release candidate run |
| --- | --- | --- | --- |
| 202 | `931af96c1f408c43243ca05ab165caa066c10940` | `11367a94de225ad43032ab2585dc06e56fd7d5eb` | [34787339024](https://github.com/ronchak/Koaryu/actions/runs/34787339024) |
| 203 | `3d0692e91b18feaf6c760d4376bae2cfbbaaa19e` | `308c569a2029f12290d6a61cda87b64788af113f` | [34788065959](https://github.com/ronchak/Koaryu/actions/runs/34788065959) |
| 204 | `dd7d745efaf37dc09d4f9dcba0a4bbeb04ed448d` | `a6cf758c1aa389f284f840764d88818143afc19f` | [34789407630](https://github.com/ronchak/Koaryu/actions/runs/34789407630) |
| 205 | `7b40ca97fa6be6a2c717f7223970bcca05d4d04a` | `4244384fb701d7a2bb9b8fcca581a403e695836b` | [34790320452](https://github.com/ronchak/Koaryu/actions/runs/34790320452) |

All listed runs passed. Guarded merges read production auto-deploy off twice at 22:43:27/28, 22:59:00/01, 23:27:14/15 and 23:45:45/46 UTC respectively. Main's own runs after PR202–204 also passed; the current-main run is recorded in HANDOFF.

## Boundary and test changes

- PR202 normalizes the ISO input at the shared calendar formatter before constructing UTC midnight. It adds one source line and two assertions to the existing date case; date tests remain 6, lines 77→79. Local timestamp formatting is unchanged. Root/reviewer date checks, lint/format and the full 902-case frontend suite passed.
- PR203 controls test clocks and worker completion at their existing seams. Real HTTP/SDK exceptions, capacity ownership and production deadlines remain. The three test files grow 1,443→1,489 lines; no cases added. All 41 affected tests and 94 subtests passed. Under concurrent full-frontend-suite load, the four requested parameterized cases passed in 60.95 pytest seconds; the frontend was still running when they finished and all 902 cases passed. Existing 15.0 acceptance/16.0 rejection stayed unchanged. This is local load evidence, not a throughput benchmark.
- PR204 centralizes the existing compiler/packer and moves the existing Map fixture to one seven-line owner. Stubs and safety scenarios stay local. One real preference lifecycle replaces provider-source checks; existing mounted schedule proofs cover deleted geometry-source assertions. Changed scope 5,717→5,399 lines, 240,216→226,137 bytes, 98→90 declarations, 750→627 assertion calls. Including unchanged settings, recipe scope is 5,773→5,455 lines and 100→92 declarations. Independent review passed 92 scoped tests; full frontend fell 902→894 and passed. Root's private compiled-theme mutation forced the DOM to light while context remained dark; the new test failed on that observable mismatch. Raw readFileSync occurrences fell from 103 in 33 files to 101 in 32; these include loaders, not only assertions. FT1-07/FT1-12 are fixed; FT1-11/FT2-08 remain partial because protected workflow/source-shape claims remain.
- PR205 scopes Auth I/O inside the hydration adapter. Only the selected active staff IDs are read; non-missing provider failures abort before CSV emission. Legal names remain profile-owned. The adapter shrinks 749→735 lines. Tests grow 1,845→1,875 lines with 48 cases unchanged; 999 pagination-only users become one unrelated user, and duplicate archive coverage is consolidated. All 48 scoped tests, 39 related endpoint/contract tests and 1,904 backend tests passed. Root's child-process probe restored only the original adapter and the strengthened archive fixture failed on invitation email versus Auth email. Exact selected trace and shared budget accounting were independently verified. The existing 320-call ceiling remains.

Ruff/Prettier, relevant lint, generated API contracts and diff checks passed. Root rejected impossible duplicate role data and a new fixture response fallback, and required protected test assertions restored before publication. No production-source change was made to satisfy a test. No new fixture framework or verification infrastructure was committed.

## Net scope and remaining work

From the run baseline to `4244384fb701d7a2bb9b8fcca581a403e695836b`, application Python/TypeScript is 13 lines smaller. Frontend/e2e test source falls 316 lines and backend test source grows 76: net 240 fewer. Cases move frontend 902→894, backend 1,904 unchanged. Relative to the formatter baseline, the same application scope is 1,192 lines smaller; recorded frontend/e2e/backend/root-test source and JSON fixtures net 87 fewer lines. No Supabase file changed.

OPS1-09, BT5-05, FT1-07 and FT1-12 are newly fixed. Source-test umbrellas remain pending with concrete residual evidence. No excluded database prerequisite, refund correction, production migration/deployment, live billing, financial backfill, mail or DNS work was started. Production-release gates and dated observations remain in HANDOFF and PRODUCTION-RELEASE.md.
