# Performance measurement

The deterministic summary gate invokes the current endpoint, including fresh profile, membership, subscription and studio-context reads before fact-cache access. Each profile runs an initial miss, a valid hit, three concurrent identical misses, invalidation, and a request after subscription revocation. It requires seven Auth admin reads, three fact RPCs in total, zero RPCs for the hit or denied request, and one RPC shared by the concurrent misses. Bearer-token verification, provider transport and database execution are outside this fake-provider timing. The old Python builder supplies a semantic reference before timing starts; it no longer measures production endpoint performance.

The manifest is `dashboard-summary-performance-v2`, bound to `dashboard-summary-endpoint-fixture-v2`. Supporting dataset sizes now vary independently across attendance history, classes, memberships, leads, invoices, payments and Stripe events. Invoice counts cross 200/201 and payment counts cross 1,000/1,001. The endpoint fixture measures orchestration against aggregate RPC responses. Its in-memory supporting tables do not establish SQL cost. `slow_backend_stage_count` counts slow endpoint invocations, not browser long tasks or INP.

Run the gate only from the clean final candidate with its full SHA:

```bash
npm run check:performance-regression -- --expected-sha <full-sha>
```

Real SQL evidence comes from `npm run check:supabase-contracts-local`. The summary contract verifies formulas, empty and skewed studios, independent large lead and invoice datasets, and existing scoped attendance query plans. It reports one warmup and twenty full fact-RPC repetitions for each student profile. The roster contract executes the full roster RPC under `EXPLAIN (ANALYZE, BUFFERS)` for first, deep-next, deep-previous, common sort, search, program and inactivity requests against 2,500 students. Deep anchors come from traversing 1,000 real rows with the RPC. Existing query-family plans explain internal work separately. These disposable local PostgreSQL results are not hosted latency forecasts.

## Browser capture

`frontend/scripts/capture-dashboard-performance.mjs` retains exact deployed-pair verification before and after capture. It rejects blocked writes, unknown origins and known Billing status GETs that may refresh provider state. Service workers are blocked so they cannot bypass browser request interception. A GET-only capture cannot certify all server-side reads as pure: subscription authorization itself can reconcile provider state. Use a controlled, already settled account for observation and do not describe this workflow as a production mutation guarantee.

The separate functional command supports disposable staging data only:

```bash
node frontend/scripts/capture-functional-performance.mjs \
  --environment staging --expected-sha <full-sha> \
  --frontend-origin <pinned-origin> --backend-api <pinned-api-v1> \
  --storage-state <absolute-private-path> --disposable-data --route schedule
```

Routes are fixed labels: `dashboard`, `students`, `schedule`, `billing`, `settings`, and `leads`. Functional mode permits only the known session-refresh and schedule-materialization POST destinations. Billing status GETs retain their existing provider-refresh behavior. All other writes remain blocked. This command does not create fixture accounts or accept production origins.

Readiness timestamps come from effects after committed UI has had a paint opportunity. Each mark carries a fixed route label, numeric identity generation and navigation generation. No user or studio identifier is recorded. Shell, authoritative identity, first useful content and complete required data remain separate. The old Dashboard complete-data attribute and its separate committed mark remain a read-only capture requirement. Functional capture reports `selected_required_data_ms` separately; `dashboard_ready_ms` is null when the legacy aggregate never becomes ready, such as a custom layout that does not request hidden eligibility. A selected-layout timing never replaces the old aggregate timing. Waiting for an element or a mark does not supply its timestamp. Stale generation callbacks are discarded and cleanup cancels pending frames.

The capture exports fixed labels, numeric request start/end times, status, response bytes and initiator categories. Requests still pending at capture have a null end time and an explicit pending outcome; failed requests are retained. It excludes request URLs, query strings, bodies, cookies, headers and user records. Current `koaryu_summary_context` and `koaryu_summary_facts` timings survive the allowlist. Request navigation generations identify the capture's document navigation; visible UI marks also identify their own identity-scoped navigation generation.

Playwright interception disables browser HTTP caching. Every routed capture says so. A fresh browser context also has a fresh Router Cache. Backend fact-cache state and server warmth remain separately marked as uncontrolled. Do not treat a routed reload as a normal cached revisit. Normal cache measurements require equivalent traffic restrictions outside Playwright routing, which this command does not provision. Scripted interaction timing is lab evidence, not field INP.

## Baseline limits

The implementation-base endpoint baseline uses the corrected fixture against base application code at `f5bd1295b5a574d0e356682f37675a3cda99bc5e`, with one separately reported warmup and twenty measured repetitions per profile on local arm64 Python 3.11.15. The coordinator retains the aggregate results in its run evidence. This establishes a fresh orchestration baseline with synthetic provider I/O. It does not establish browser, network, hosted database or Billing latency, a thirty-percent improvement, or a reliable p95. Those claims require matched authenticated browser runs with recorded data, device/network conditions, server plan, regions and cache states.

## September 4 implementation evidence

The measurements below describe implementation checkpoint `eef4ebd3f49e95a90d0752850fece9be029d3ee0`. Later review fixes add error and session-recovery paths; these numbers are not a final-head hosted latency claim.

The local PostgreSQL 17 run passed all 133 migrations and 50 contracts, including
restore compatibility, deliberate permission/body drift and concurrent writes.
On the complete Billing fixture with 201 invoices and 1,003 payments, twenty
aggregate-query repetitions after one warmup had a 0.5025 ms median, spanning
0.493–0.602 ms. This excludes authorization, Stripe, HTTP and browser work.

The unchanged summary RPC was measured separately on the expanded fixed data:

| Student profile | Warmup | Samples | Median | Minimum–maximum |
| --- | ---: | ---: | ---: | ---: |
| 25 | 18.440 ms | 20 | 19.345 ms | 17.635–21.708 ms |
| 250 | 24.537 ms | 20 | 24.804 ms | 23.495–27.947 ms |
| 2,500 | 180.094 ms | 20 | 159.339 ms | 150.394–361.749 ms |

Full roster RPC execution on the 2,500-student fixture took 8.528 ms for the
first page, 7.047 ms for a deep next page and 7.724 ms for the corresponding
previous page. Tested sort/search/program/inactivity requests spanned
1.474–14.051 ms with warm shared buffers. These measurements do not justify
query specialization or blanket indexes in this change. Counts, cursor
semantics and existing indexes remain intact.

A separate browser lab compared the base and candidate in alternating pairs,
with twenty measured loads per scenario and a separate warmup. Both used
Chromium 148.0.7778.96, a 1280×900 viewport, 4× CPU throttling, reduced motion,
unthrottled loopback networking and disposable preview data. Browser HTTP
caching was normal, with no Playwright routing; no non-loopback requests were
observed. Completion used the same legacy data attribute and a paint-opportunity
observer on both versions, so the new first-useful marker did not change the
comparison. Other browser tests and builds had stopped before the paired run.

| Preview scenario | Base median | Candidate median | Base range | Candidate range |
| --- | ---: | ---: | ---: | ---: |
| Fresh browser context | 700.00 ms | 713.35 ms | 693.40–713.60 ms | 579.30–725.00 ms |
| Cached reload | 397.65 ms | 399.80 ms | 393.70–428.70 ms | 393.50–429.60 ms |

Cold warmups were 704.40/728.90 ms and reload-scenario warmups were
696.00/725.70 ms for base/candidate. Preview complete-data paint was 13.35 ms
slower cold and 2.15 ms slower on reload in this run. A preliminary unpaired run
that overlapped other verification showed a larger difference; the paired run
controls ordering and background browser/build work more closely. Neither is
field data or a reliable p95. The requested 30% useful-content improvement is
not established by this preview experiment, which contains no live data waits.
Hosted request latency and the dominant remaining dependency still need a
matched authenticated deployment measurement.

Mounted live tests establish the request-count result separately: the original
provider made two bootstraps after role resolution; the candidate makes one in
production React and Strict Mode. They also cover token renewal, identity
changes, delayed responses, schedule/attendance ordering and retry recovery.
Navigation feedback committed within 100 ms in the unthrottled loopback browser
checks, with both normal and reduced motion. Those checks intentionally delay
the RSC response and are lab interaction checks, not INP.

Production bundle analysis used `.env.example` with preview disabled. The table sums Next’s analyzer module-byte contributions to browser chunks, including shared JavaScript, CSS and compatibility code. It is bundle-graph evidence, not source-file sizes, compressed transfer bytes or initial-execution CPU time.

| Route | Base client bytes | Candidate client bytes | Base/candidate chunks |
| --- | ---: | ---: | ---: |
| dashboard | 1,355,732 | 1,345,523 | 21/21 |
| students | 1,338,798 | 1,333,176 | 22/22 |
| schedule | 1,300,448 | 1,295,724 | 20/20 |
| billing | 1,357,045 | 1,355,740 | 20/20 |
| settings | 1,278,598 | 1,273,339 | 20/20 |
| leads | 1,292,948 | 1,287,445 | 21/21 |

No eager dialog split was retained. The measured bundle correction keeps the new Leads loading boundary from pulling in a second copy of the interactive board. Its skeleton now has a shared presentation-only component. Broader bootstrap projections, store partitioning, selective eligibility invalidation and dialog splitting remain conditional on live profiling evidence.

Leads completion includes staff assignments only for admins, matching the existing
staff endpoint's permission boundary. The route starts that read itself; lead
content can become useful first, while a staff failure remains visible and
retryable. Other roles do not wait for or request the admin-only dataset.

Request evidence uses one synchronous observation cutoff. Events accepted before it are either completed, failed, or pending at that cutoff; response-size lookups may finish afterward without removing any request from the inventory. Events after the cutoff do not alter recorded statuses or add new observations.
