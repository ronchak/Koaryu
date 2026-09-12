# Batch 02: operator and release documents

IDs: `DOC1-02`, `DOC1-03`, `DOC1-04`, `DOC1-06`, `DOC1-07`, `DOC1-11`, `DOC1-12`

Prerequisites: the attestation generator landed in PR167. This batch is unblocked; verify current generated declarations and packet commands without changing generator code or schema. Read the private release and authentication runbooks required by root `AGENTS.md`, but never copy credential values, private evidence or dumps into the repository.

## Change

- In `docs/staging-recovery-runbook.md`, `docs/production-postgres-image-patch.md`, and `docs/cutover-gates.md`, retire the competing executable backup recipe. Mark the completed image-patch block historical and non-executable. Point current work to the single guarded operator owner. Keep Storage backup steps and dated evidence.
- Replace copied active version and approval claims in `docs/release-candidate-controls.md`, `docs/render-backend-deployment.md`, `docs/koaryu-payments-staging-and-rollback.md`, `docs/operator-tooling.md`, and `docs/services.md` with packet-driven instructions. Do not edit `backend/app/services/release_schema_readiness.py` or `scripts/studio-comp-migration-rollout.mjs` in this Sol batch.
- In `docs/render-backend-deployment.md`, use a clearly named signed-in studio-user access-token placeholder. Do not reuse the management-token variable or mention unavailable Keychain locations.
- Correct `docs/stripe-live-billing-rollout.md` examples from the existing parser in `backend/scripts/live_billing_authorizations.py`: explicit operation placeholders, a future expiry placeholder, and schema 4. Keep past dates only in marked history. Treat `scripts/verify-stripe-provider-rehearsal.py` as read-only authority.
- Use one absolute private, mode-restricted report path consistently in `docs/stripe-live-billing-reconciliation-v3.md`, `docs/operator-tooling.md`, and `docs/stripe-test-provider-rehearsal-capture.md`.
- In `docs/koaryu-payments-staging-and-rollback.md`, order the future rollout as database, exact backend readiness, suspended worker/manual proof, schedule enablement, then frontend. Preserve all human approvals and pending labels.
- Do not run a provider command, backup, restore, authentication flow, production SQL, migration, rollout tool, or report capture. Do not rewrite historical ledgers.

## Verify and deliver

```sh
rg -n "Keychain|management token|SCHEMA_VERSION|schema 3|pg_dump|backup|frontend|worker|schedule" docs/staging-recovery-runbook.md docs/production-postgres-image-patch.md docs/render-backend-deployment.md docs/stripe-live-billing-rollout.md docs/stripe-live-billing-reconciliation-v3.md docs/stripe-test-provider-rehearsal-capture.md docs/koaryu-payments-staging-and-rollback.md docs/operator-tooling.md docs/services.md
npm run check:release-workflow
```

The command is repository-local only. Do not execute examples from the documents. Record before/after `wc -l` for every touched file and list retained dated-evidence sections. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root coordinate integration. Require the exact-head `Release candidate gate` and guarded merge through `scripts/merge-release-pr.sh`.
