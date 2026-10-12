# Verification by change

Choose checks by what can break. Use existing tools; do not build a new proof or
reporting framework for routine work. This policy applies to local verification
and review. [Required CI](release-candidate-controls.md#current-ci-and-the-transition)
remains enforced by the actual workflow.

| Change | Check | Broaden only when |
| --- | --- | --- |
| Copy or documentation | `git diff --check`, referenced paths and command accuracy | A documented operational rule changes; review that rule |
| UI layout or styling | Lint touched files and inspect the affected screen | Shared state, navigation or accessibility behavior changes |
| Frontend logic | Focused tests and lint | Shared behavior, routing, auth, proxy or environment changes need a build or browser flow |
| Backend logic | Nearby pytest files | Shared services, auth, middleware or runtime affect other callers |
| API schemas | Focused tests and `npm run check:api-types` | Dependent callers change; regenerate types if needed |
| Payments, permissions, tenant boundaries or deletion | Affected success, refusal/recovery and retry tests; relevant races | Shared database rules or callers change |
| SQL contracts or a verifier fixture | Reproduce the issue, check the intended assertion and run the affected group | Shared setup or dependencies invalidate other groups |
| New migration or database behavior | Disposable apply/lint, supported predecessor upgrade, affected contracts/races, current readiness and restore continuation | Changed shared history, restore machinery or runtime requires historical paths |
| Dependencies or runtime/config | Install/check the affected runtime and run its affected tests | Shared dependencies also affect database composition or other packages |
| Release/workflow/merge controls | `npm run check:release-workflow` and focused checks for the changed control | Executable enforcement changes need exact-head CI and a focused independent review |
| Home performance fixture, budget or runner | `npm run check:performance-regression -- --expected-sha <full-sha>` | Workflow changes also use `npm run check:release-workflow`; hosted capture requires exact-SHA verification |
| Release declarations | `npm run check:release-attestation` and relevant readiness tests | Migration or restore behavior also changes |

For local database setup and target restrictions, follow [the database guide](../supabase/AGENTS.md).
Never use production for contract testing. Hosted smoke checks and stateful Stripe
tests need explicit task scope and the approved target.

Run an expensive check once per necessary environment. Use the CI result instead
of duplicating it locally. Reuse an earlier result only when its relevant source,
dependencies, fixtures and database/runtime setup are unchanged; a corrected
verifier cannot reuse its own incorrect result. After a fix, rerun the affected
group and its dependents. If impact cannot be determined, broaden the affected
area once. Report failed or incomplete checks honestly.

Use one focused independent review for material security, financial, data-loss,
migration or verification-acceptance changes. Routine work needs a proportionate
diff review. Further reviews need a concrete unresolved risk or an owner request.

In the PR, briefly state what changed, validation and material gaps. Link an
existing run instead of copying a full command diary. Freeze the candidate once
ready; after required checks pass and material findings are resolved, use the
guarded merge and stop. Deployment is a separate task.
