# Required browser CI investigation brief

> Planning-only draft. This note does not change CI. It describes a current workflow gap observed on `main` at `0dbf7c0`. The future implementing agent should determine the smallest deterministic browser coverage that materially improves release confidence rather than copying the suggestions mechanically.

## Executive summary

Koaryu has Playwright suites and has recorded browser evidence on important release PRs, but the required `Release candidate` workflow does not run Playwright. The required frontend gate currently runs Node tests, ESLint, a production Next.js build, and `npm audit`.

The suspected weakness is that browser correctness depends on manual or PR-specific execution rather than a stable required check. A regression involving middleware, route transitions, hydration, actual DOM behavior, or production output can pass the required gate if unit and source-contract tests do not cover it.

## What the gap is

`frontend/package.json` defines:

- `test:e2e`
- preview smoke and import suites
- an opt-in live stateful belt-ladder suite

`.github/workflows/release-candidate.yml` does not invoke any of them. Historical PRs include useful browser verification, but that evidence is not automatically reproduced for each relevant candidate.

This is not a claim that every Playwright suite should run on every commit. Some current suites require credentials or deliberately mutate state and should remain opt-in.

## Why this matters

Koaryu’s highest-risk frontend behavior crosses several layers that unit tests cannot fully model:

- Supabase session cookies and middleware redirects
- Next.js route and proxy behavior
- loading and error state transitions
- responsive navigation and modal interactions
- attendance and schedule flows that depend on real browser event ordering
- production-build behavior that differs from source-level imports

A small deterministic browser gate can catch failures that otherwise appear only in staging or production promotion.

## Current impact

The current release gate can pass without executing a browser. No unaddressed production regression was attributed to this gap during the review. The practical impact is uneven evidence. Some high-risk PRs receive strong manual browser verification, while routine candidates rely on maintainers remembering to run the right suite.

## Root cause hypothesis

Koaryu’s Playwright coverage grew around specific incidents and staging workflows. Stateful tests were correctly protected from accidental execution. The required CI workflow was then designed to be deterministic and secret-free, so browser suites were left outside it. The missing step is a clearly separated safe browser subset.

## Suggested reproducibility and verification

Confirm the exact release workflow graph and run a normal candidate to verify that no Playwright job executes. Inventory every existing E2E spec by required environment, mutation behavior, runtime length, and determinism.

As a proof of value, identify one realistic browser regression that existing Node tests and `next build` would not catch, then show that a safe Playwright smoke would catch it. Do not manufacture a permanent code defect solely to satisfy this exercise.

## Suggested plan of action

This is guidance rather than a required design.

Define a required, secret-free browser smoke against a production build or controlled preview mode. Keep it small and focused on route boot, basic navigation, one modal/form interaction, and one representative state transition. Preserve live and stateful suites behind explicit environment flags or separate manually approved jobs.

Consider whether the browser job belongs on every PR or only when frontend/runtime paths change. Be cautious with path filtering because broad release candidates should not accidentally skip the aggregate gate. Record artifacts such as traces or screenshots only on failure and ensure they cannot contain production data.

## Scope guard

Do not make live credentials, production tenants, real Stripe resources, or destructive test data part of required CI. Do not add the entire historical E2E suite without first establishing determinism and cleanup.

## Evidence expected before merge

The eventual implementation should demonstrate a green deterministic run, a deliberate failing probe, bounded runtime, failure artifacts, and preservation of the existing aggregate release gate. The implementing agent should document which browser risks remain outside required CI.

## Future-work note

This branch contains only this planning note. Browser workflow changes will be implemented later.