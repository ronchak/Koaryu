# Contract assurance verification

Base: `46131d470592e735641adff19e3aefd217e64e82`, after PR #155.

The linked SQL runner previously accepted arbitrary database URLs. Its new helper validates the pinned staging host/user/session port before launching psql, rejects routing overrides and unsafe TLS choices, clears inherited libpq settings, and keeps passwords out of process arguments. Local checks still execute inside the identified disposable Supabase container, using a loopback status URL and ignoring an ambient linked URL.

The comp and bulk-archive tests now distinguish the expected application exception from their own failure assertions. The import-worker contract owns its Auth user and studio in the rollback transaction and always runs its behavior checks. Touched nullable results reject missing values. No business migration, release attestation or inventory count changed.

## Verification

- Baseline SQL-runner tests: six passed. Two new tests using fake psql failed against the old runner because direct and pooled production URLs were accepted. No network connection occurred.
- All operator-script tests passed after the fix: `cd backend && venv/bin/python -m pytest tests/test_ops_scripts.py -q`, 55 passed. They cover accepted direct/pooler staging connections, unsafe destinations/options, credential redaction, inherited routing, local loopback variants and container selection. The existing ambiguous-container fixture was corrected to contain actual tabs/newlines, so it tests ambiguity rather than malformed output.
- `bash -n scripts/run-supabase-sql.sh`, `python3 -m py_compile scripts/supabase-sql-target.py` and `git diff --check` passed.
- Baseline and updated `KOARYU_PG_BIN_DIR=/usr/local/opt/postgresql@17/bin npm run check:supabase-contracts-local` each passed all 133 migrations and 50 contracts, plus their existing restore/concurrency checks. The baseline explicitly skipped import-worker behavior; the updated run executed it without a skip.
- Separate disposable PostgreSQL negative probes suppressed the expected comp rejection or forced audit failure in temporary test copies. Both old copies falsely passed. Both repaired copies failed with their specific outside-handler assertion. The current unmodified tests passed on the same schema.
- A separate worker probe began with zero studios, Auth users and import runs. The old test skipped; the repaired test ran. All three counts returned to zero after rollback.
- Environment-example controls passed 52 tests and their validator. The support privacy audit passed.
- Independent review inspected the complete diff and negative-proof results and received `GREEN LIGHT`. Exact-head CI remains required before merge.

The negative probes used the checked-in compatibility shim and immutable 133-file migration chain on a separate private Unix-socket cluster with TCP disabled. Their driver, temporary SQL, logs and source hashes remain in the owner's private remediation evidence directory. Both clusters were stopped and removed. No hosted SQL, production data, provider configuration or migration history was changed.

## Audit disposition and test quality

OS1-06, DC1-01, DC2-01 and DC2-02 are directly addressed. CTA1-02 is addressed by replacing the unsafe database quick-start with local verification and explicit hosted boundaries. These entries remain pending until merge. DC1-02 is only partly addressed through the touched worker assertions; other nullable contracts remain pending. The stale staging-activity sentence was corrected, but DOC1-03's other release-version contradictions remain open.

The change improves existing contracts rather than adding more copies of their business logic. Negative checks require the intended failure, and worker coverage no longer depends on leftover data. The private mutation probes establish the correction without adding a second permanent test runner. New connection cases protect the actual process-launch boundary with fake executables. Existing authorization, tenant, transaction, restore and concurrency checks remain.

The runner is a destination guard, not proof that staging has a particular migration state or authorization to run a hosted check. Linked verification still requires an explicitly intended staging operation after the candidate migrations are present. Production apply remains human-only through the guarded rollout tool. Reverting requires no data rollback but restores the target and test-assurance gaps.
