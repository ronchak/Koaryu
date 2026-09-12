# Student presentation correctness verification

Base: `c13b8bfd80a53f08f62017bc8d25a1d13cd1fc67`. Implementation: `3a248412c9a7ee2077c452b20ddf08e73fefa0fd`.

FC1-02: eligibility errors no longer become a successful empty-program claim, including after notice dismissal. Retry uses the existing current-ladder loader with force enabled. Cached rows remain hidden during loading, preserving the previous promotion/demotion action boundary; failed refreshes can retain their prior rows with an unavailable label.

FC2-05: attendance and belt panels distinguish loading, incomplete, unavailable and confirmed-empty facts. Independently known current rank can remain visible; unavailable next-rank/history/count data no longer claims top rank or zero promotions. Attendance writes/counters and other mutation guards are unchanged.

FC2-07: displayed age compares calendar year/month/day against the existing business date. Tests cover the day before/on a birthday, February 29 across a non-leap year and missing DOB. Minor/guardian/business rules are unchanged.

FC2-14: mapping controls use a React instance ID and column index, preserving header mapping keys and label association across colliding slugs and multiple instances. Preview CSV parsing rejects normalized duplicate headers through its FileReader promise. Valid quoted input and blank input remain supported. This aligns the duplicate-header rule with existing backend parsing; it does not claim full parser parity or change live import writes.

## Test quality and size

Three weak presentation source-shape cases were removed. Their regexes could match unreachable markup or unrelated declarations and did not establish rendered behavior. Three named mounted cases now cover data truth, calendar birthdays and mapping identity. The two existing permission/destructive-mutation source cases and their assertions remain unchanged because their safety ownership is outside this presentation batch. Removed lead-announcement, segmented-keyboard, progressbar and CSS-presence assertions are not represented as fully duplicated behavioral coverage.

The eight selected test files retain 44 cases and change from 1,564 to 1,800 lines. The four modified test artifacts, including the existing browser helper, change from 751 to 1,026 lines and 42,048 to 51,600 bytes. New scenario code is readable in named tests; the harness contains only component mounting functions. The existing bundler gained directory-index resolution required by these imports. No new test framework or dependency was introduced.

The eight production files change from 3,452 to 3,522 lines and 125,094 to 128,168 bytes. These are real presentation fixes with stronger behavior coverage, not a claimed physical line reduction. The full frontend suite remains 912 cases.

## Verification

Coordinator review checked the eight source diffs, controller/prop wiring, preserved loading/action boundary, React hook placement, duplicate-header normalization and actual label connections. Its independent nine-file run passed 57 tests. The implementer passed all 912 frontend tests, the synthetic-environment production build, pinned formatting and targeted lint. Lint retains one pre-existing window.location.assign warning. A negative control restored the defective cached-row loading branch and caused the mounted loading test to fail; the corrected source was restored and reverified.

Fresh independent exact-head review and CI remain required before guarded merge. No backend, schema, provider, real authentication/data, email, deployment or financial behavior change occurred.
