# Batch 13: remaining dependency advisories

IDs: `PROGRAM-DEPENDENCIES-02`. This is a program finding outside the original 278.

Prerequisite: start from current main containing PR163. Do not fold this into a financial or schema PR. Recheck current advisories and dependency consumers before editing.

## Change

At normalization, GitHub reported js-yaml below 4.3.2 as high severity in frontend development dependencies, baseline-browser-mapping below 2.11.0 as moderate, and pip below 26.2.0 as moderate in the development lock. These observations do not establish application exploitability.

- Inspect `frontend/package-lock.json` with `npm ls js-yaml baseline-browser-mapping` from `frontend/`. Use the smallest compatible patched transitive update. Keep direct Next, React and Sharp versions unchanged unless a verified dependency constraint requires a separately explained change. Do not use audit-fix force or add overrides mechanically.
- Inspect `backend/requirements-dev.in` and its generated `backend/requirements-dev.txt`. Use the existing Python 3.11 pip-tools workflow to update only the affected pip pin and required solver consequences. Preserve hashes; do not hand-edit generated hashes. Keep `backend/requirements.in` and runtime packages unchanged unless independently necessary.
- Follow package guidance for clean installation and reproducible lock regeneration. No new dependency-management framework or application refactor.

## Verify

From the repo root, use isolated package working directories:

```sh
(cd frontend && npm ci && npm ls js-yaml baseline-browser-mapping)
(cd frontend && npm audit --omit=dev --audit-level=high)
(cd frontend && npm run lint && npm run build)
(cd backend && venv/bin/python -m pip check)
```

For Python, regenerate with the exact pip-tools command in `backend/AGENTS.md`, install the resulting hashed lock in a disposable virtualenv, and repeat generation to prove a clean diff. Follow the lock verification steps in `.github/workflows/release-candidate.yml`. Run affected tool tests and the normal exact-head candidate gate. Report remaining advisories accurately by dependency scope. No new tests are needed merely to pin version strings.

Do not weaken audit thresholds, alter application behavior, migrations, financial logic, authorization, tenant boundaries, provider configuration or production state. Use a short `codex/` branch, fresh independent reviewer and guarded merge under coordinator integration.
