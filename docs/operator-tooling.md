# Operator Tooling Inventory

## Studio live billing authorization and reconciliation

`backend/scripts/live_billing_authorizations.py` is the service-role-only status, drift, grant, revoke, account-disposition, and reconciliation-checkpoint tool. Writes are dry-run by default and require exact project plus interactive confirmation. `backend/scripts/stripe_reconciliation_report.py` is a sanitized read-only provider/local reporter. Offline output and the separately labeled staging probe are permanently checkpoint-ineligible; production collection and checkpoint recording each independently pin the exact production `/health/ready` URL and candidate SHA. `scripts/verify-stripe-provider-rehearsal.py` validates exact-candidate test-mode evidence without contacting a provider. See `docs/stripe-live-billing-rollout.md` for the authority split, expiry and candidate binding, the July 20 silence hypotheses, hard six-account/seven-event blockers, secret-rotation gate, and preregistered canary abort/promote criteria.

This inventory records owner-run tools that can inspect or change Koaryu outside the product UI. Add each future tool as a separate entry with its working directory, interpreter, write boundary, and audit destination.

## Database contract verification

Use the repository-local PostgreSQL 17 harness by default when developing or reviewing migration and contract SQL:

```bash
npm run check:supabase-contracts-local
```

The harness needs a complete local PostgreSQL 17 toolchain (`initdb`, `pg_ctl`, and `psql`) with the `pgcrypto` extension files, which some Linux distributions package as PostgreSQL contrib. Run it as an unprivileged operating-system user; PostgreSQL refuses to initialize or run a cluster as root. The harness prefers a working PostgreSQL 17 toolchain on `PATH`, then checks common package locations. Set `KOARYU_PG_BIN_DIR` to an explicit PostgreSQL 17 `bin` directory when multiple versions are installed.

It needs no Docker daemon, Supabase CLI login, cloud project, network access, secrets, or `.env` file. It creates a private-socket cluster under a short `/tmp` path, applies every migration in its own transaction, records the local migration history, and then runs every file in `supabase/verification/`. Concurrent runs use different private socket directories, even though their socket filenames share port number `5432`. It forwards `INT` and `TERM` to an active `initdb`, `pg_ctl`, or `psql` — the long-running commands — then stops and removes the cluster on success, failure, or interrupt. Short probes such as `--version`, `pg_config`, and `mktemp` are not wrapped, so a signal arriving while one of those is running is handled only once it returns. `SIGKILL` is untrappable and can leave a cluster behind.

The compatibility shim supplies only the PostgreSQL roles, schemas, tables, auth claim helpers, and extension needed by this repository's current migrations and SQL contracts. Use staging when verification depends on the behavior of a full Supabase service rather than PostgreSQL alone.

One divergence is worth naming because it can mislead in **both** directions. The shim's default privileges grant the API roles table CRUD and sequence `USAGE, SELECT`. That matches no Supabase project exactly: older projects grant `ALL` on tables, functions, and sequences, while newly provisioned projects can have automatic Data API grants disabled entirely. So a migration that creates a table without explicit `GRANT` statements can pass here and fail on a new project with `permission denied`, and a contract asserting the API roles *lack* a privilege such as `TRUNCATE` can pass here and fail on an older one. Privilege assertions are the one class of contract this harness cannot settle; verify those against the project era you actually deploy to.

The current migration chain is transaction-compatible. The Supabase CLI can run a small class of commands such as `CREATE INDEX CONCURRENTLY` outside its per-file transaction; this harness deliberately fails instead because `psql --single-transaction` cannot reproduce that exception safely. Use the Supabase CLI and the appropriate non-production target if a future migration requires one of those commands.

Use these targets according to their safety boundary:

| Target | Use |
| --- | --- |
| local ephemeral cluster | Default for developing and reviewing contract SQL. |
| `koaryu-staging` (`nxgsektqsgrtyfhawxbc`) | Cloud verification only when Supabase-specific behavior matters; this project is currently inactive. |
| production (`mimguepumzsgmcaycdsh`) | **Read-only inspection only. Never run contract or migration SQL against it.** |

Contract files create functions and triggers on real tables inside a transaction. Even when a file ends with `ROLLBACK`, it must not be pointed at production. The transaction executes the SQL against the target before rolling it back, and an accidental commit, session loss, or non-transactional statement would cross the production write boundary.

Python service-role clients validate both the environment label and the exact
Supabase target before construction. Production and staging accept only their
pinned Koaryu project URLs. Test accepts only the canonical local URL
`http://127.0.0.1:54321` or a shipped placeholder. Development accepts those
same safe forms or one hosted non-production project whose ref exactly matches
`SUPABASE_DEVELOPMENT_PROJECT_REF`; neither Koaryu production nor staging can be
authorized by that setting. Unknown environment labels and non-canonical URLs
fail closed.

The same boundary refuses active `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`
configuration, including lowercase variants and operating-system proxy
settings. It also refuses `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
`SSL_CERT_FILE`, and `SSL_CERT_DIR` overrides, including lowercase variants.
`NO_PROXY` is not an exception. The pinned Supabase client creates separate
Auth, PostgREST, Storage, and Functions HTTPX clients and exposes no common
`trust_env=False` option, so rejecting ambient transport configuration is the
smallest maintainable policy until that dependency boundary changes.

These checks cover the API, shared backend scripts, and the Connect smoke
helper. Supabase CLI, direct `SUPABASE_DB_URL`, and `psql` operations remain
outside this Python boundary, so continue resolving their target explicitly.
`backend/scripts/comp_studio.py` additionally requires `--expect-project` for
writes.

## Studio-comp migration rollout

Use [the specialized rollout packet](studio-comp-migration-rollout.md) to
generate and inspect the exact production-baseline-to-candidate migration set.
The runner defaults to read-only inspection, derives an `84 -> N` packet from an
immutable candidate, and refuses partial history/object states or ambient proxy
or TLS trust override variables before credentialed work. It names refused
variables without printing values and does not treat Supabase version/name
history as proof of source-file identity.

Agents may not run its production apply mode. Staging inspection must precede a
dry-run or application, and production application requires a named human,
durable approval, confirmed restore window, restore decision authority, and the
approved staging provider fingerprint.

## Studio platform comp access

### What it does

`scripts/comp_studio.py` lists current platform comps, shows one studio's subscription state, reports known comp drift, and grants or revokes a studio's platform access override. It is an owner-only service-role tool, not a customer or studio-admin surface.

A comp changes Koaryu access only. It does not cancel, pause, discount, or otherwise modify a Stripe subscription. The tool treats billing as live only when `stripe_subscription_id` is nonblank and the projected status is `active`, `trialing`, `past_due`, `unpaid`, or `paused`. It refuses a comp grant in that state unless `--override-live-subscription` is present and prints a continued-billing warning when the override is used. The database function repeats this check under its row lock, so an unlocked preflight read is not the enforcement boundary.

Routine reconciliation, Admin status refresh, checkout repair, and Stripe-customer creation preserve a comp. Starting checkout records intent to pay and is not enough to end the override; an abandoned checkout must not remove access. Accepted `checkout.session.completed` and `customer.subscription.*` events remain authorized to clear it, subject to the ordering rule below.

Use `drift`, not `list`, to find local warning states. Its provenance reasons report `metadata.comp.state='granted'` with `comped=false`, `metadata.comp.state='revoked'` with `comped=true`, and an active granted comp whose timestamp is absent, unparseable, PostgreSQL-incompatible, or non-finite. These checks detect local record/flag or ordering-data problems; they cannot distinguish an authorized event clear from an unexpected write, and the provenance checks cannot identify a manual grant made before this tool existed. The legacy-status reason reports `status='comped'` still granting access while `comped=false`.

The billing reasons cover two different local signals. A comp alongside a nonblank subscription ID and live projected status means Koaryu received enough provider data to show the conflict locally. It does not cover a paid subscription whose checkout and subscription events never arrived. A comp with a Stripe customer but no live local subscription reports the broader at-risk population that needs confirmation against Stripe; it does not mean the studio is definitely paying. Confirming whether any comped studio is actually being billed requires checking Stripe, which this database-only tool does not do. Provider-backed confirmation remains explicit follow-up work; do not treat either local drift reason as a complete billing backstop.

The comp timestamp is a bounded ordering heuristic between two independent clocks: the database records the grant while Stripe supplies a second-precision provider timestamp, so timestamps cannot eliminate the race. Only a strictly older event loses to the operator grant; a same-second event clears the comp. This tie rule prefers a visible, recoverable mistaken clear (reported by `drift` as granted provenance with `comped` false and repairable by re-granting) over a silent, potentially permanent and costly comp on a paying subscription. The two local billing reasons above narrow the review population, but only a Stripe check can confirm the latter state. If a granted comp has an absent, unparseable, PostgreSQL-incompatible, or non-finite timestamp, no billing event clears it automatically because the backend cannot prove even this bounded ordering; the active comp appears in `drift` with a distinct unusable-timestamp reason so an operator can repair its provenance. An event timestamp outside PostgreSQL's usable range likewise preserves the comp and returns without raising. The database decides the comparison under the subscription row lock, so a webhook that read before a grant but waited behind its transaction cannot erase the grant from a stale snapshot unless its event falls in the same-second tie case.

While a comp is active, reconciliation deliberately does not refresh provider-owned status, Stripe identity, period, trial, or cancellation fields. Admin status can therefore be stale, a locally live status can continue to block checkout after Stripe has canceled it, and a lost webhook is not repaired incidentally until the comp is revoked. The comp is the authoritative access override during that interval. It does not override the separately owned expired-trial evaluator rule: a row with `status='trialing'` and an expired `trial_end` is still denied even when `comped` is true.

### Exact commands

Start in the repository root, enter the backend working directory, and use its pinned interpreter:

```bash
cd backend
venv/bin/python scripts/comp_studio.py list
venv/bin/python scripts/comp_studio.py status --slug <studio-slug>
venv/bin/python scripts/comp_studio.py status --studio-id <studio-uuid>
venv/bin/python scripts/comp_studio.py drift
```

Grant and revoke are dry runs unless `--execute` is supplied:

```bash
cd backend
venv/bin/python scripts/comp_studio.py grant \
  --slug <studio-slug> \
  --reason "<bounded operator reason>" \
  --actor <auth-user-uuid-or-email>

venv/bin/python scripts/comp_studio.py revoke \
  --studio-id <studio-uuid> \
  --reason "<bounded operator reason>" \
  --actor <auth-user-uuid-or-email>
```

For an actual write, name the configured Supabase hostname or project ref and complete the interactive hostname confirmation:

```bash
cd backend
venv/bin/python scripts/comp_studio.py grant \
  --slug <studio-slug> \
  --reason "<bounded operator reason>" \
  --actor <auth-user-uuid-or-email> \
  --expect-project <supabase-host-or-project-ref> \
  --execute
```

If the target has a live Stripe subscription and continued provider billing is explicitly intended:

```bash
cd backend
venv/bin/python scripts/comp_studio.py grant \
  --slug <studio-slug> \
  --reason "<bounded operator reason>" \
  --actor <auth-user-uuid-or-email> \
  --expect-project <supabase-host-or-project-ref> \
  --override-live-subscription \
  --execute
```

The execute path refuses an unknown environment, a placeholder or mismatched Supabase project, and non-interactive stdin. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ENVIRONMENT` come from the backend settings used by the application.

Exit codes are:

- `0`: the read, dry run, applied mutation, or true `no_change` outcome completed
- `1`: a validation, project-safety, lookup, or database error prevented completion
- `2`: command-line parsing or usage error
- `3`: a revoke transaction completed, but an entitling status still leaves the studio with access

### What it writes

The `set_studio_comp_atomic` database function locks the existing `studio_subscriptions` row and performs the entitlement update, provenance patch, and audit insert in one transaction. The only explicitly assigned business columns are:

- `comped`
- `metadata.comp`, patched with `jsonb_set` so current unrelated metadata is retained
- `status`, only when revoking a legacy `status='comped'` row whose `stripe_subscription_id` is null, empty, or whitespace-only (the ASCII whitespace set, declared once in SQL and mirrored by the CLI so both agree; Unicode whitespace such as U+00A0 counts as a present identifier, which preserves the status and exits `3` rather than reporting a removal that did not happen); that row becomes `incomplete`, even if `comped` was already false

The existing subscription update trigger also advances `updated_at`. A legacy `status='comped'` row with a nonblank Stripe subscription ID keeps its status because provider projection owns it; the tool prints a warning.

Read that warning literally: **clearing `comped` is only half of the entitlement.** The access evaluator allows a studio when the flag *or* the status grants it, so a revoke that leaves an entitling status (`active`, `trialing`, `comped`) behind can complete its database transaction while the studio keeps working. The tool retains the explicit warning and exits `3`, rather than returning success; the revoke is not finished until `status` shows the studio actually denied.

The provenance block records the requested state, reason, actor UUID, actor email or `null`, database timestamp, `comp_studio_cli` source, and previous flag value. A database trigger preserves an existing `metadata.comp` block if a billing writer later replaces metadata from a snapshot taken before the comp transaction; this keeps both commit orders detectable by `drift`. Idempotence is decided after the row lock. `no_change` is returned without provenance or audit writes only when neither the flag nor legacy-status normalization needs a change.

### What it deliberately does not do

The tool does not:

- create a missing studio or subscription row
- cancel or change provider billing or Stripe identifiers
- change the platform access evaluator or remove the legacy `comped` status
- support bulk changes, expirations, schedules, an HTTP endpoint, or an admin UI

The actor must resolve to a real Supabase Auth user, and an empty `--actor` is rejected rather than matched against users without an email address. `audit_logs.actor_id` has no foreign key to `auth.users`, so this validation is enforced by the CLI. `--actor` is self-asserted by whoever holds the service-role key: it provides attribution, not authentication, and can name any real Auth user.

### Audit trail

Applied changes insert one `audit_logs` row in the same transaction as the subscription update. The action is `platform_comp.granted` or `platform_comp.revoked`, the entity is the studio subscription, and the metadata records the reason, actor email, previous and current flag values, source, status transition, and whether legacy status was normalized or left to Stripe.

A dry run predicts the execute path exactly: a request that would be a true `no_change` shows no provenance block and no audit action, and a revoke that would leave an entitling status prints the same access warning the execute path does.

Dry runs and `no_change` outcomes write no audit row. `list`, `status`, and `drift` are paginated, strictly read-only commands.
