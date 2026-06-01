# Support Triage Runbook

Koaryu support requests are stored in Supabase as `support_tickets` with an append-only `support_ticket_events` trail. The user-facing contact page creates tickets through the authenticated backend, and the operator-facing triage loop uses internal endpoints protected by `SUPPORT_TRIAGE_SECRET`.

## Data Captured

Each ticket stores:

- studio and creator IDs
- requester email/name from Supabase Auth
- topic, severity, subject, and details
- current page URL, user agent, and bounded browser context
- ticket status and timestamps

Treat ticket data as private operational data. Summaries sent to broad channels should not include full requester email addresses, full details, page URLs with query strings, user agents, browser context, or student-record content.

## Queue

The internal queue endpoint returns open operational tickets, priority-ordered before limiting:

```bash
curl -H "X-Internal-Secret: $SUPPORT_TRIAGE_SECRET" \
  "https://koaryu.onrender.com/api/v1/internal/support/tickets?limit=50"
```

Optional filters can be repeated:

```bash
curl -H "X-Internal-Secret: $SUPPORT_TRIAGE_SECRET" \
  "https://koaryu.onrender.com/api/v1/internal/support/tickets?status=open&severity=urgent&topic=billing&limit=25"
```

Default queue statuses are `open`, `triaging`, and `waiting_on_customer`. Severity priority is `urgent`, `high`, `normal`, then `low`, with older tickets first inside the same severity.

## Actions

Use the internal mutation endpoint to update status and/or add an operator note. The ticket update and event insert happen in one database transaction through `support_triage_update_ticket`.

```bash
curl -X PATCH \
  -H "X-Internal-Secret: $SUPPORT_TRIAGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"status":"triaging","note":"Investigating the report.","metadata":{"source":"operator"}}' \
  https://koaryu.onrender.com/api/v1/internal/support/tickets/<ticket_id>
```

Allowed statuses:

- `open`
- `triaging`
- `waiting_on_customer`
- `resolved`
- `closed`

Setting a ticket to `resolved` or `closed` sets `resolved_at`. Reopening a ticket clears `resolved_at`.

## Daily Automation

The daily Codex automation runs at 8:00 p.m. local time and only summarizes. It should not mutate tickets automatically.

The automation uses the Supabase connector, not browser or local CLI state. It should run this read-only SQL against the Koaryu project:

```sql
SELECT public.support_triage_digest(50) AS digest;
```

`support_triage_digest` returns only sanitized fields. It does not expose user-entered ticket subjects, ticket details, raw requester emails, page URLs, user agents, or browser context. For `student_records` tickets, the digest returns `details withheld` for both subject and summary; for other topics, subject and summary fields are generated from controlled metadata only.

The local helper below is only a manual fallback for developer checks; it calls the same sanitized RPC:

```bash
scripts/support-triage-digest.sh --confirm-sanitized-linked-query
```

The confirmation flag is required because the helper reads from the currently linked Supabase project and prints the sanitized digest locally. Use `--limit N` to request 1-100 entries.

Privacy rules for the automation:

- Include ticket IDs, severity, topic, status, rough age, and the metadata-only summary returned by `support_triage_digest`.
- Redact requester emails to a partial form such as `r***@domain.com`.
- Do not summarize user-entered subject or details. For `student_records` tickets, output metadata only and use `details withheld`.
- Do not include full ticket details, page URLs with query strings, user agents, browser context, or student-record content.
- If the Supabase connector cannot call `support_triage_digest`, report that the queue could not be checked rather than calling raw support-ticket endpoints from automation.

## Verification

Run these after changing support/account database behavior:

```bash
supabase db lint --linked --fail-on error
scripts/verify-supabase-account-support.sh
PYTHONPATH=backend backend/venv/bin/python -m pytest backend/tests/test_support_service.py backend/tests/test_internal_endpoints.py
```
