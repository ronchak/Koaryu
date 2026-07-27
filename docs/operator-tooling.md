# Operator Tooling Inventory

This inventory records owner-run tools that can inspect or change Koaryu outside the product UI. Add each future tool as a separate entry with its working directory, interpreter, write boundary, and audit destination.

## Studio platform comp access

### What it does

`scripts/comp_studio.py` lists current platform comps, shows one studio's subscription state, reports known comp drift, and grants or revokes a studio's platform access override. It is an owner-only service-role tool, not a customer or studio-admin surface.

A comp changes Koaryu access only. It does not cancel, pause, discount, or otherwise modify a Stripe subscription. A studio with an active Stripe subscription continues to be billed after a comp grant. The tool refuses that grant unless `--override-live-subscription` is present and still prints a warning when the override is used.

The open platform-subscription revocation defect can silently erase a comp granted today. This tool does not fix that defect, and a grant should not be treated as durable until the separate P0 repair lands. Use `drift`, not `list`, to find rows where CLI provenance still says `granted` but `comped` is false, or where legacy `status='comped'` still grants access while `comped` is false. `drift` cannot detect a manual grant made before this tool existed because that row has no `metadata.comp` provenance.

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

### What it writes

The `set_studio_comp_atomic` database function locks the existing `studio_subscriptions` row and performs the entitlement update, provenance patch, and audit insert in one transaction. The only explicitly assigned business columns are:

- `comped`
- `metadata.comp`, patched with `jsonb_set` so current unrelated metadata is retained
- `status`, only when revoking a legacy `status='comped'` row that has no `stripe_subscription_id`; that row becomes `incomplete`

The existing subscription update trigger also advances `updated_at`. A legacy `status='comped'` row with a Stripe subscription keeps its status because provider projection owns it; the tool prints a warning.

Read that warning literally: **clearing `comped` is only half of the entitlement.** The access evaluator allows a studio when the flag *or* the status grants it, so a revoke that leaves an entitling status (`active`, `trialing`, `comped`) behind reports `applied` while the studio keeps working. The tool says so explicitly in that case, but the revoke is not finished until `status` shows the studio actually denied.

The provenance block records the requested state, reason, actor UUID, actor email or `null`, database timestamp, `comp_studio_cli` source, and previous flag value. A database trigger preserves an existing `metadata.comp` block if a billing writer later replaces metadata from a snapshot taken before the comp transaction; this keeps both commit orders detectable by `drift`. Idempotence is decided after the row lock. An already-matching flag returns `no_change` without updating provenance or inserting an audit row.

### What it deliberately does not do

The tool does not:

- create a missing studio or subscription row
- cancel or change provider billing or Stripe identifiers
- fix the open comp revocation defect
- change the platform access evaluator or remove the legacy `comped` status
- support bulk changes, expirations, schedules, an HTTP endpoint, or an admin UI

The actor must resolve to a real Supabase Auth user. `audit_logs.actor_id` has no foreign key to `auth.users`, so this validation is enforced by the CLI. `--actor` is self-asserted by whoever holds the service-role key: it provides attribution, not authentication, and can name any real Auth user.

### Audit trail

Applied changes insert one `audit_logs` row in the same transaction as the subscription update. The action is `platform_comp.granted` or `platform_comp.revoked`, the entity is the studio subscription, and the metadata records the reason, actor email, previous and current flag values, source, status transition, and whether legacy status was normalized or left to Stripe.

Dry runs and `no_change` outcomes write no audit row. `list`, `status`, and `drift` are paginated, strictly read-only commands.
