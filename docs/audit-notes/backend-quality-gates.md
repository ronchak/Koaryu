# Backend engineering quality gate investigation brief

> Planning-only draft. This note does not add tools or change CI. It records a repository-quality finding from static review of `main` at `0dbf7c0`. The future agent should choose tools based on signal, maintenance cost, and the actual codebase rather than treating the examples below as requirements.

## Executive summary

Koaryu’s backend release gate is strong on tests, dependency integrity, vulnerability auditing, database contracts, Bandit, and CodeQL. It does not currently include a general Python formatter check, fast linter, static type check, or measured coverage floor.

The concern is not that the backend lacks quality controls. It has more than most small repositories. The concern is that the controls are concentrated on security and behavior tests, leaving ordinary engineering drift less visible. Mixed async semantics, broad `Any` usage, inconsistent imports, unreachable branches, and untested surfaces can survive even when pytest and security scans are green.

## What the gap is

`backend/requirements-dev.in` includes pytest, Bandit, pip-audit, and pip-tools. The required workflow runs dependency consistency, lock regeneration, vulnerability audit, pytest, API contract generation, Bandit, and CodeQL.

No Ruff, Black check, Pyright, mypy, or coverage tool is visible in the required backend path. There is also no published coverage baseline or ratchet.

This is a process finding rather than a confirmed runtime bug. Any implementation should be justified by defects it can realistically prevent in Koaryu.

## Why this matters

Tests prove only the behavior they exercise. Security analyzers target particular classes of weakness. A lightweight engineering gate can identify different problems earlier:

- unused imports and variables
- accidental shadowing or unreachable code
- inconsistent exception handling and async boundaries
- mismatched optional values and response types
- missing test coverage in high-risk modules
- formatting churn that makes review harder

The goal is not maximum strictness. An aggressive tool rollout that produces thousands of suppressions can lower signal and create maintenance drag.

## Current impact

No defect was proven solely because these tools are absent. The current impact is lower visibility into backend type and coverage quality, plus greater dependence on reviewer attention. The async I/O finding is an example of an architectural issue that existing gates did not flag automatically.

## Root cause hypothesis

The backend evolved quickly around domain correctness, Supabase contracts, billing safety, and production controls. Those areas appropriately received the highest attention. General Python tooling was likely deferred to avoid broad mechanical churn while the architecture was still moving.

## Suggested reproducibility and verification

Run candidate tools in report-only mode against the current tree. Classify findings by usefulness rather than raw count. Identify whether they catch actual defects, questionable async use, dead code, or contract inconsistencies that current tests miss.

Generate a coverage report without enforcing a threshold. Inspect coverage in authentication, tenant scope, billing, imports, schedule, and error handling. Do not mistake line coverage for correctness. The purpose is to locate blind spots.

## Suggested plan of action

The following is a suggested direction, not a required stack.

Choose the smallest combination with high signal. Ruff may cover formatting and common lint rules in one tool. Static typing could begin with selected boundary modules or a permissive baseline, then ratchet rather than requiring repository-wide strictness immediately. Coverage could begin as a reported artifact or module-level floor before becoming a hard global percentage.

Integrate the chosen checks into the existing aggregate release workflow and pin their versions through the normal dependency locks. Keep generated code and migration files out of inappropriate checks.

## Scope guard

Do not reformat or annotate the entire backend merely to satisfy a tool. Do not add blanket ignores that make the check ceremonial. Do not combine this work with domain behavior changes unless a tool uncovers a concrete bug that deserves a separate PR.

## Evidence expected before merge

The eventual PR should show the initial baseline, explain the selected rules, demonstrate at least one useful caught failure, keep CI runtime reasonable, and document how the gate can be tightened later. Full backend and API contract verification should remain green.

## Future-work note

This branch contains only this investigation note. No tooling or source change has been made.