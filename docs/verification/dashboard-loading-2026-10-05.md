# Dashboard loading investigation, October 5, 2026

Issues [#262](https://github.com/ronchak/Koaryu/issues/262), [#263](https://github.com/ronchak/Koaryu/issues/263) and [#264](https://github.com/ronchak/Koaryu/issues/264) describe static findings, not measured production regressions. The baseline is `d52bb2fd02839e24645bbcf68a47bf615a001250`.

## What the investigation confirmed

Dashboard downloaded the entire lead collection to display five follow-ups. The reader performs one 500-row query per page, with an exact count included in the first query. At 10,000 leads this is twenty provider calls, not twenty calls plus a separate count call. The displayed five were ordered by creation timestamp descending, then ID descending. They were not the five oldest follow-up dates.

The resume callback refreshed full students, full leads, programs, summary and eligibility, including hidden eligibility. With 2,500 students it traversed thirteen roster pages. Calling its schedule refresh did **not** necessarily produce another schedule request: the existing coordinator reused an authoritative snapshot.

Cold initialization did wait for feature bootstrap before requesting the full schedule window. Current live class cards already use the summary's bounded schedule rows. Live attendance and setup also have authoritative summary fields. Removing that unused Dashboard schedule request is smaller than starting it earlier. The Schedule route retains its own read and materialization rules.

## The change

- A new summary option, `include_follow_ups=true`, returns an optional typed projection containing at most five due rows. It selects only ID, name and follow-up date, preserves the original ordering and uses the verified studio's business date. Counts remain in the authoritative summary.
- The projection stays separate from the complete Leads collection and outside the shared fact cache. Instructors receive no lead details. Failed projection reads are unavailable, never a confirmed empty list. Permission failures remain failures.
- New clients opt into `bounded_dashboard=true` on Dashboard bootstrap. Old clients retain the previous full-lead response and loading semantics during backend-first deployment. Leads and Reports continue to load their complete collections.
- Passive resume revalidates workspace access, then refreshes summary and visible promotions. Same-day successful data stays visible during refresh. Explicit retries and confirmed-command reconciliation retain fresh reads. Business-date changes and identity changes have separate ownership checks.
- Live setup readiness uses summary facts. The legacy complete-data metric still describes the full datasets and may remain unset when those datasets are intentionally deferred. It is not relabelled as selected-widget readiness.

The summary's fact query and follow-up query run concurrently. The response still waits for both, so a slow follow-up query or provider queue can delay summary totals. This is a real tradeoff for avoiding full-collection transport and separate frontend request state. There is no claim of universal first-paint improvement. No database migration, new index or cache service is needed.

## Reproducible application measurements

The mounted Chromium fixture runs the real store and Dashboard controller with synthetic auth and API responses. Both versions use 2,500 students. Bytes below are UTF-8 serialized response JSON, not compressed HTTP transfer, browser cache effects or customer data. Request counts include workspace revalidation on resume.

| Scenario | Baseline | Candidate |
| --- | ---: | ---: |
| Cold requests | 4 | 3 |
| Cold JSON, 25 leads | 65,986 bytes | 53,754 bytes |
| Cold JSON, 5,000 leads | 2,602,186 bytes | 53,764 bytes |
| Resume requests, promotions hidden | 18 | 2 |
| Resume student pages | 13 | 0 |
| Resume hidden eligibility requests | 1 | 0 |
| Resume JSON, 25 leads | 654,832 bytes | 2,082 bytes |
| Resume JSON, 5,000 leads | 3,191,032 bytes | 2,092 bytes |

For the large fixture, cold JSON falls 97.93% and resume JSON falls 99.93%. Different fixture names account for the ten-byte candidate difference between lead cardinalities. This establishes bounded Dashboard transport as unrelated lead history grows.

A separate backend reader fixture includes realistic unused lead fields and 340 characters of notes per lead. At 10,000 leads, it measures twenty calls and 6,780,429 serialized provider bytes for the old reader, versus one call and 528 bytes for the bounded reader. Both choose the same five rows, including due leads beyond the old first page. These bytes describe that fixture, not a typical studio.

Run the mounted regressions with:

```sh
cd frontend
node --experimental-strip-types --test tests/dashboard-performance-mounted.test.mjs
```

The same file can measure the pinned baseline using `KOARYU_DASHBOARD_BASELINE_ROOT` pointing to an isolated source copy with dependencies and the original store-browser helper. It does not require a web server or provider credentials.

## Local database measurements and limits

A private PostgreSQL 17.11 cluster reproduced the leads columns and indexes from the migrations. It omitted unrelated tables, foreign keys, triggers and RLS; the application reads through its authorized service-role provider. Fixtures included a second studio, timestamp ties, enrolled and closed-lost leads, null/future follow-ups, and due rows beyond the old first page. Each profile used three warmups and twenty measured repetitions. The old measurement executes an exact count and all paginated reads; SQL JSON construction is measured separately from scans. These are SQL primitives, not PostgREST's exact generated statement.

| Target studio leads | Due distribution | Old reads with SQL JSON, median | Bounded read with SQL JSON, median |
| --- | --- | ---: | ---: |
| 25 | Sparse | 0.423 ms | 0.072 ms |
| 500 | Sparse | 4.943 ms | 0.240 ms |
| 1,000 | Sparse | 10.068 ms | 0.375 ms |
| 10,000 | Sparse | 91.949 ms | 2.969 ms |
| 10,000 | Dense | 85.979 ms | 5.950 ms |

Dense 10,000-lead **scan-only** work went from 4.819 ms to 5.307 ms. A five-row result does not make database work constant: the query can scan eligible leads and perform a top-N sort. The existing partial follow-up index supports the exclusion predicate, while the planner preferred the studio index for the larger fixtures. The measured few-millisecond plans do not justify adding another index. These warm local SQL timings exclude authorization, provider transport, queueing and the browser.

The retained private evidence directory is `/Users/openclaw/Koaryu Reviews/20261005-dashboard-performance`. It contains the pinned baseline source, `mounted-comparison.json`, TAP logs, `lead-projection-measurements.json`, and the reproducible SQL script with `sql-measurements-final/results.json`. Earlier exploratory SQL directories are superseded by that final result.

## Hosted measurement limits

No matched hosted candidate comparison was performed. The existing production browser account reached onboarding, and staging was signed out. Staging also hosts another agent's preview. This investigation did not replace that deployment or change production data to manufacture a benchmark.

Hosted first-useful paint, selected-widget readiness, provider queue time and actual wire bytes remain unmeasured. A later authorized deployment comparison should use equivalent fixtures and verify each served frontend/backend SHA pair before and after capture. The numeric server-timing allowlist now includes `koaryu_summary_lead_follow_ups` so that added read can be measured separately. Merging this change is not a production deployment.
