# Batch 03: customer copy and first-read docs

IDs: `CTA1-03`, `CTA1-07`, `DOC1-08`, `DOC1-09`, `FR1-05`, `FR1-06`, `FR1-13`, `FC1-08`, `FC2-04`, `FC3-04`, `FSH1-10`, `FSH1-12`

Prerequisites: none. This is copy and unused frontend configuration only. Do not turn copy defects into new product work.

## Change

- After a final reference and dependency search, remove only `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` from `frontend/.env.example`, `frontend/AGENTS.md`, `frontend/README.md`, and `scripts/verify-staging-isolation.mjs`. Preserve every backend Stripe variable and mode check.
- Link `frontend/public/demo-students.csv` from `README.md`. State separately that the repository ships a preview-import sample, not a packaged or hosted demo tenant.
- Align the current section of `docs/performance-rollout.md` with `frontend/src/lib/request-budget.ts`; keep old measurements as dated evidence. In `docs/design-language.md`, document push history for explicit link activation and replace history for gesture, keyboard, and progress changes, matching `frontend/src/components/marketing/journey/journey-controller.tsx`.
- Fix recovery instructions in `frontend/src/app/(auth)/reset-password/page.tsx` to use the existing login magic-link option, then Account Settings reset. Narrow the post-onboarding promise in `frontend/src/app/onboarding/page.tsx`; do not add timezone management.
- Rewrite developer-facing sentences in `frontend/src/app/(dashboard)/account/settings/page.tsx`, `frontend/src/app/(dashboard)/automations/page.tsx`, `frontend/src/app/features/page.tsx`, `frontend/src/app/privacy/page.tsx`, `frontend/src/components/error-status-page.tsx`, `frontend/src/app/error.tsx`, `frontend/src/lib/dashboard-widget-view-models.ts`, and `frontend/src/lib/billing-policy.ts`. Preserve distinct loading, partial, unavailable, unauthorized, and recovery states.
- Remove the unsupported further-guardian promise from `frontend/src/components/students/student-form.tsx`, `frontend/src/components/students/student-form-state.ts`, and `frontend/src/components/students/student-detail-sections.tsx`. Preserve all payloads and read-only guardian display.
- Change the full-list roster notice in `frontend/src/components/students/student-roster-controls.tsx`, `frontend/src/lib/students-page-model.ts`, and `frontend/src/components/students/student-roster-page-content.tsx` so a persistent scope flag is not called an active refresh.
- Remove or mark planned the automations claim in `frontend/src/lib/landing-page-content.ts`; keep live follow-up queues distinct.
- In touched tests, especially `frontend/tests/operations-redesign-contract.test.mjs`, remove stale exact-copy/source-shape checks only. Keep permissions, mutations, data-state distinctions, route history, and recovery behavior. Do not add phrase-locking replacements.

## Verify and deliver

```sh
rg -n "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY|Stripe.js|@stripe/stripe-js" frontend package.json scripts README.md
npm run check:env-examples
node --test scripts/verify-staging-isolation.test.mjs
(cd frontend && node --experimental-strip-types --test tests/marketing-journey-interaction.test.mjs tests/operations-redesign-contract.test.mjs tests/dashboard-widget-view-models.test.mjs)
(cd frontend && npm run lint -- src/app src/components/error-status-page.tsx src/components/students src/lib/landing-page-content.ts src/lib/dashboard-widget-view-models.ts src/lib/billing-policy.ts)
```

Record before/after file lines and touched test cases. Start from current `main` on a short `codex/` branch. Use a fresh reviewer; root coordinates integration. Require the exact-head `Release candidate gate` and `scripts/merge-release-pr.sh`. Do not touch provider state, credentials, mail, DNS, auth behavior, tenant logic, payment behavior, guardian APIs, or timezone features.
