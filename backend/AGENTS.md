# Backend Agent Guide

This package is the Koaryu FastAPI backend.

Use this file for work under `backend/`. Fall back to the repo root `AGENTS.md` for shared rules.

## Path Guide

- `app/api/v1/endpoints/`: route handlers and HTTP contract entry points
- `app/services/`: business logic, orchestration, and external integrations
- `app/schemas/`: Pydantic models and validation
- `app/core/`: config and core backend wiring
- `app/db/`: database-facing helpers
- `tests/`: backend test coverage

## Stack

- Python `3.11`
- FastAPI
- Uvicorn
- Pydantic `2`
- Supabase Python client
- Stripe Python SDK

## Core Commands

- Install local/dev dependencies: `cd backend && venv/bin/python -m pip install -r requirements-dev.txt`
- Start local API: `cd backend && venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001`
- Run all tests: `cd backend && venv/bin/python -m pytest tests`
- Run targeted tests: `cd backend && venv/bin/python -m pytest tests/test_health_endpoints.py`

The local backend runs on `http://127.0.0.1:8001`.

## Editing Guidance

- Preserve the existing FastAPI app layout under `app/`.
- Prefer narrow service, schema, or route changes over broad rewrites.
- Keep request/response models and validation rules aligned when changing payload shapes.
- Avoid introducing production-only config assumptions into development defaults.
- Do not commit real values from `backend/.env` or other local secret files.
- Prefer keeping HTTP concerns in endpoints and domain logic in services.
- When changing a service contract, update the dependent schema, endpoint, and targeted tests together.

## Production And Deployment Constraints

- Keep `render.yaml`, `backend/Procfile`, `backend/runtime.txt`, and dependency/runtime assumptions aligned when changing startup behavior.
- The production app intentionally fails fast when critical Supabase, Stripe, or frontend configuration is invalid. Do not relax those guards casually.
- Be careful with support-ticket and account-deletion flows; they are internal operational surfaces protected by shared secrets.

## Verification

- Run targeted pytest files for the area you changed.
- Run `cd backend && venv/bin/python -m pytest tests` for broader service or routing changes.
- After changing support or account-deletion behavior, also run:
  - `supabase migration up --local`
  - `supabase db lint --local --fail-on error`
  - `SUPABASE_DB_TARGET=local scripts/verify-supabase-account-support.sh`
  - `PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_account_service.py backend/tests/test_staff_service_account_deletion.py backend/tests/test_support_service.py backend/tests/test_internal_endpoints.py`
- If a changed support/account migration may already be recorded in local history, first confirm the local database is disposable and run `supabase db reset --local` so the checks exercise the current migration contents.
- Run linked Supabase checks only when the task explicitly intends a release inspection and the linked project already has the migrations under review.

## Done Checklist

- Add or update targeted pytest coverage for changed behavior when tests exist nearby.
- Keep endpoint, schema, and service layers aligned for any contract change.
- Recheck deployment/runbook docs when changing operational flows, secrets, startup requirements, or webhooks.

## Important References

- Repo overview: `README.md`
- Render deployment runbook: `docs/render-backend-deployment.md`
- Support triage runbook: `docs/support-triage.md`
