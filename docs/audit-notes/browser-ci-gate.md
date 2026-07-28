# Required browser CI gate

## Outcome

The release-candidate workflow now includes a required, secret-free Chromium
smoke against a production Next.js build in controlled preview mode. The
aggregate `Release candidate gate` fails closed unless that browser job
succeeds.

The required subset is intentionally small. It exercises real production
output, preview login and route navigation, a schedule modal, and a
browser-local attendance state transition without contacting a live backend or
mutating shared data.

## Playwright inventory

| Spec | Environment and state | Required CI coverage |
| --- | --- | --- |
| `e2e/preview-smoke.spec.ts` | Checked-in preview identity and data; read-only navigation, reload, responsive, and marketing checks | Desktop preview login and dashboard-to-students navigation only |
| `e2e/schedule-attendance-counters.spec.ts` | Preview data; mutations are confined to a fresh browser context's `localStorage` | One schedule-modal attendance toggle and counter transition |
| `e2e/student-import-idempotency-key.spec.ts` | Preview mode and checked-in demo CSV; exercises an import review flow | Opt-in only |
| `e2e/atomic-belt-ladder.spec.ts` | Live credentials and mutations in a disposable studio | Opt-in only; never part of required CI |

The `@required-browser-smoke` tag selects the two approved tests, and
`playwright.required-smoke.config.ts` limits discovery to the two approved
preview specs. The package command enables only preview test flags. Contract
tests reject adding the live suite, credential variables, parallel workers,
retries, video, or a reusable external server to the required configuration.

## Determinism and data boundaries

- CI sources only placeholder values from `frontend/.env.example`, then forces
  `NEXT_PUBLIC_PREVIEW_MODE=true` before `next build`.
- Playwright launches that exact build with `next start`; it cannot silently
  reuse a development or external server. The required command also pins
  `KOARYU_E2E_FRONTEND_URL=http://127.0.0.1:4000`, overriding any ambient URL.
- Chromium runs with one worker, no retries, a 15-second per-test timeout, a
  two-minute global timeout, and a three-minute workflow-step timeout.
- Each test receives an isolated browser context. The sole state mutation is
  preview attendance data in that context's `localStorage`.
- Traces and screenshots are retained only on failure, video is disabled, and
  the workflow uploads only preview-data artifacts for seven days.

## Fail-closed controls

`scripts/check-release-candidate-workflow.mjs` requires the unfiltered browser
job, its bounded runtime, its unconditional smoke step, failure artifact
handling, and the aggregate dependency and success assertion. The associated
contract tests deliberately remove or condition those controls and verify that
validation fails.

## Deliberate failure proof

Local proof on 2026-07-27 used the same production preview build and command as
CI:

- `npm run build` completed successfully with preview mode forced on.
- `npm run test:e2e:required-smoke -- --list` discovered exactly two tests in
  the two approved specs.
- The unchanged smoke passed both tests with one worker.
- A temporary, uncommitted change expected the attendance counter to advance
  by two instead of one. The smoke exited non-zero with one pass and one
  failure, and produced a screenshot, error context, and trace under the
  configured failure directory.
- The expectation was restored and both tests passed again. The successful run
  left no screenshot or trace in the configured result directory.

The temporary failure is not part of the branch.

## Explicitly uncovered risks

Required CI does not authenticate against Supabase, call a deployed backend,
exercise Stripe, import rows, mutate a live tenant, or run the full responsive
and reload matrix. Those suites remain targeted or manually approved checks;
the required gate is not evidence for live integration correctness.
