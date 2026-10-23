# Local guarded-action prototype

An isolated demonstration of two predefined actions: add one tag to one student, and set or clear one lead's follow-up date. It uses a fresh synthetic SQLite database, the existing MCP SDK and a separate owner review page. Nothing in the deployed Koaryu application imports this directory. V1 remains read-only.

The [contract](CONTRACT.md) defines the approval, authorization, retry and stale-state rules and the production integration still required. The synthetic engine reproduces selected domain effects; it does **not** call the live Student/Lead services or prove a production atomic wrapper.

## Start and try it

Use the repository's existing backend development environment, then run from the repository root:

```sh
backend/venv/bin/python -m experiments.mcp_actions.demo
```

The server binds only to `http://127.0.0.1:8110`, leaving the read demo on8101 alone. It creates a new private temporary directory with mode0700, a SQLite database and `synthetic-credentials.json` with mode0600. The console prints their location without printing passwords or bearer keys. A custom `--state-directory` must be new and outside the worktree. An occupied port is refused; the demo never replaces another process.

The file contains two fully synthetic studios. Pick one array entry and use its own `assistant_token`, `student_id`, `lead_id`, username and password together. Do not use a Koaryu account, a read-connector token, a provider key or customer data. This is fixed-bearer test authentication, not native OAuth or ChatGPT host verification.

1. Connect a local MCP client to `http://127.0.0.1:8110/mcp` with `Authorization: Bearer` followed by the chosen fixture's assistant key. The four tools are preview/execute pairs for student tag addition and lead follow-up date replacement.
2. Call `preview_student_tag_add` with the fixture's student UUID and one tag, such as `competition`. The response includes exact before/after values, an expiry, a digest and an owner `review_url`. Preview changes no student record.
3. Try `execute_student_tag_add` with that proposal UUID and a fresh UUID `idempotency_key` before approval. It must refuse. There is no model-callable approval tool.
4. Open the returned review URL. Sign in with that fixture's synthetic owner credentials, compare the exact target and change, check the review box and choose Approve. The approval changes no student record yet.
5. Call the matching execute tool with the same proposal UUID and retry UUID. It applies the change once and returns an audit receipt. Repeating those exact execution arguments returns the same receipt with `replayed:true`.
6. Try a lead-date preview and its matching execution tool. A date must be an exact ISO calendar date, or explicit null to clear it. A proposal for one action cannot be executed through the other action.
7. Deny a proposal or revoke assistant access on the owner page. Denied proposals cannot execute; revoked keys cannot even list tools. Expired/stale previews show the reason and no Approve button. Request a new preview after a target or grant changes.

Closing the process stops the lab. Its private directory remains for inspection; it contains synthetic state and credentials. Restarting the demo creates a new fixture and new credentials. Do not reuse or publish the old keys. No provider, mail or billing service is contacted.

## Verification

```sh
backend/venv/bin/python -m unittest discover -s experiments/mcp_actions/tests -v
backend/venv/bin/python -m ruff check experiments/mcp_actions
backend/venv/bin/python -m ruff format --check experiments/mcp_actions
```

The tests use actual SQLite transactions and independent connections, including concurrent retries, competing previews, rollback after a business update, stale-state undo/redo, grant/session/role changes, expiry and target conversion/deletion. HTTP cases use the real MCP transport and owner forms, and test bearer/owner separation, CSRF/origin/host checks, escaping, body limits and tool annotations.

Against a **fresh running** lab, run the official SDK and owner HTTP lifecycle check. It deliberately uses only the first fixture and revokes its assistant key at the end:

```sh
backend/venv/bin/python -m experiments.mcp_actions.check_sdk --credentials-file /absolute/private/synthetic-credentials.json
```

It checks actual socket initialization/tool discovery, preview/refusal before approval, owner sign-in and form approval, execution/replay, wrong studio/action, denial and revocation. Automated synthetic-owner approval tests the authorization channel; it is not a claim that a human reviewed a real change. Browser verification is separate. Native form sign-in and approval have been exercised in the browser at390px, followed by MCP execution and receipt replay. The `same-origin` referrer policy is intentional: `no-referrer` makes native form POSTs send a null Origin under the [Fetch Standard](https://fetch.spec.whatwg.org/#append-a-request-origin-header), which would correctly fail the strict origin check.

## Boundaries before a real alpha

SQLite's whole-database write lock and toy owner sessions are local demonstration choices. They are not the production multi-studio capacity or account system. Production requires real native action authorization, current membership/subscription checks, protected owner confirmation, monotonic row/grant authority across all writers, and an atomic approval/business-command/audit/receipt wrapper on Postgres. Existing services cannot be called after an unlocked preview check.

That release also needs actual ACL/race/restore verification, trigger and workflow-effect inspection, owner-facing action consent, audit retention/privacy decisions, capacity checks, independent review and normal release authorization. No flag, migration, hosted setup or deployment for that release is included here. Customer sending, payments/refunds, conversion, stage changes, arbitrary SQL and bulk deletion remain outside this prototype.
