# Missed-class email automation

This candidate adds one workflow: an Admin chooses an attendance gap, previews the
recipients and message, then enables a studio rule. The default is 14 days. The
repository defaults keep sending and scheduled work disabled. This document does
not record a hosted deployment or activation.

## Mail account and setup status

The owner selected `koaryu@outlook.com` as the current sender and test recipient.
The separate Microsoft app, **Koaryu Automations Mail**, has client ID
`5b4f5762-7807-4aaf-932a-2a458dc88636` and object ID
`569a81de-135c-42d8-93e5-c2765621a052`. It uses consumer Microsoft authorization,
delegated `Mail.Send` and `User.Read`, and `offline_access`. Enrollment uses a
confidential Web client with PKCE and the exact callback
`http://localhost:8400/oauth/callback`. OIDC sign-in uses `openid` and `profile`.
The app secret expires April 2, 2027. This app is separate from Microsoft SSO.

On October 4, 2026, setup verified both the signed OIDC identity and the exact
Graph `/me` mailbox. The root coordinator then sent one synthetic message from
and to `koaryu@outlook.com` using the reviewed transport. A forced refresh through
a private encrypted local compare-and-swap adapter succeeded, and Graph returned
`202`. The setup agent verified the matching message in the Outlook inbox. This
proves the provider send, token refresh, and receipt for that synthetic message;
no student or customer mail was sent. The root coordinator
retains the rotated credentials privately for later hosted import. The hosted
credential store and worker are not yet bootstrapped or deployed.

Enrollment files live outside the repository in
`/Users/openclaw/.config/koaryu/secrets/microsoft-automation-client.json` and
`/Users/openclaw/.config/koaryu/secrets/microsoft-automation-token.json`.
Keep them in private operator storage. Never copy their contents into examples,
command arguments, logs, or frontend variables.

## Configuration and modes

| Setting | Meaning |
| --- | --- |
| `EMAIL_PROVIDER` | `disabled` by default; `microsoft_graph` selects the current transport. |
| `EMAIL_SEND_ENABLED` | Global send switch, default `false`. |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | Default sender `koaryu@outlook.com`, name `Koaryu`. The enrolled mailbox must match the address. |
| `EMAIL_REPLY_TO` | Default `koaryu@outlook.com`; blank falls back to the sender. Studio rules can choose their own valid reply address. |
| `EMAIL_ALLOWED_RECIPIENTS` | Default `koaryu@outlook.com`. Nonempty selects test mode and restricts actual recipients. Explicitly empty selects live mode. |
| `EMAIL_GRAPH_CLIENT_ID`, `EMAIL_GRAPH_CLIENT_SECRET` | Dedicated mail app credentials, held server-side. |
| `EMAIL_GRAPH_TENANT` | Default `consumers`; only `common`, `organizations`, `consumers`, or a tenant UUID is accepted. |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | Private Fernet key for durable token encryption. |
| `AUTOMATION_PUBLIC_API_URL` | Public HTTPS backend base ending in `/api/v1`, required when sending. Production and staging are pinned to their respective Render hosts. |
| `AUTOMATION_WORKER_ENABLED` | Independent backend and frontend server switches, both default `false`. |
| `AUTOMATION_WORKER_SECRET` | Dedicated random secret of at least 32 characters, shared by the frontend cron bridge and backend worker. |

Disabled mode sends nothing. Rules can still be drafted and previewed. Test mode
only allows the approved Outlook mailbox as an actual recipient. It never sends
a student's message to a replacement test address. Use synthetic student details
for the root coordinator's test message. Live mode requires an explicitly empty
recipient allowlist and a ready, enabled sender. Rule enablement also checks
the stored credential's app and mailbox binding.

Configuration validation does not load or refresh tokens at startup. The Graph
transport uses fixed Microsoft OAuth and Graph endpoints; there is no configurable
send endpoint or SMTP fallback.

## Credential storage and renewal

Hosted execution reads encrypted credentials from the private
`automation_email_credentials` table through service-role-only RPCs. Fernet
protects the payload, which binds the app client ID and verified mailbox. Token
refresh uses revision-based compare-and-swap writes so competing workers cannot
silently overwrite a newer credential. A persistence failure prevents sending.
The hosted runtime does not use the enrollment JSON files as its token store.

### Initial credential import

`backend/scripts/bootstrap_automation_email.py` prepares an import plan by default.
It reads the latest private, rotated encrypted smoke envelope, not the original
enrollment plaintext. The envelope must have exactly `provider_key`, `revision`,
and `encrypted_credentials`, with provider `microsoft_graph:primary` and revision
at least 2. The source key and envelope must be separate absolute paths, regular
files owned by the current operator with mode `0600`, outside every Koaryu
worktree, Git common directory, and any other repository. Symlinks are refused.
The helper never edits either file or writes decrypted tokens to an artifact.

Install the exact reviewed candidate in the canonical checkout
`/Users/openclaw/Projects/Koaryu-Repo` before running the command. Tracked changes
or unreviewed importable files are refused. Existing Python caches are bypassed
without deleting them. There is no worktree/root override. The helper cannot pass
hosted readiness until both the target schema and backend serving the exact
candidate have been deployed.

The private `with-hosted-env.py` allowlist amendment is **proposed**, not installed
by this candidate. After its separate review and installation, start an operator
session with tracing disabled and explicitly source
`/Users/openclaw/.config/koaryu/operator/release-env.sh`. Inspect with:

```bash
cd /Users/openclaw/Projects/Koaryu-Repo
/usr/bin/python3 /Users/openclaw/.config/koaryu/operator/with-hosted-env.py --environment staging -- backend/venv/bin/python backend/scripts/bootstrap_automation_email.py --environment staging --candidate-sha <reviewed-40-character-sha> --source-state <absolute-private-rotated-envelope.json> --source-key-file <absolute-private-source-key>
```

The plan binds the candidate, environment, pinned Supabase project, current
release declaration, source ciphertext and file identities, source and target key
fingerprints, and verified app/mailbox. Both send and worker switches must remain
false, and the recipient allowlist must be exactly `koaryu@outlook.com`. Settings
come from the selected hosted environment with no `.env` fallback. Inspection
performs no database write and sends no email.

To import after reviewing that plan, use the same arguments with `--execute`:

```bash
/usr/bin/python3 /Users/openclaw/.config/koaryu/operator/with-hosted-env.py --environment staging -- backend/venv/bin/python backend/scripts/bootstrap_automation_email.py --environment staging --candidate-sha <reviewed-40-character-sha> --source-state <absolute-private-rotated-envelope.json> --source-key-file <absolute-private-source-key> --execute
```

All three standard streams must be terminals. Type the exact state-bound phrase
shown by the helper; there is no confirmation argument or piped-input bypass.
The helper repeats the checkout, configuration, source, deployed readiness,
database readiness, and empty-store checks after confirmation. It then performs
one compare-and-swap import with expected revision 0 and reads back revision 1
and the complete decrypted state. It refuses a nonempty store even if the stored
credentials match. There is no overwrite or rotation mode. A timeout or uncertain
write result reports `write_state_unverified` and never retries. Preserve the
safe JSON action, timestamp, candidate, project, fingerprint and outcome in the
root coordinator's private evidence. An `imported` result requires matching
readback and reports `messages_sent: 0`.

For production, both environment arguments must be `production`. Execution needs
**new, explicit owner authorization for this initial credential bootstrap**.
The existing authorized manual production database operations remain the guarded
migration apply and temporary backup role. A prior migration or deployment
approval does not authorize this import. Follow the existing
[release gates](cutover-gates.md#owner-authorized-release-execution) for migration
and deployment. Subagents have no production authority. The global sending and
worker switches stay off, and studio rules are unchanged. Import neither
refreshes tokens nor contacts Microsoft. A future `notifications@koaryu.app` sender needs a verified new
mailbox/provider identity and consent, plus separate credential-replacement
authorization. It uses the same automation rule schema.

An expired access token can be refreshed before a send. Revoked consent, an
expired app secret, or an unusable refresh token requires operator repair or
reconsent. Microsoft documents refresh-token replacement and revocation in its
[token lifecycle guidance](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).
Check the mailbox identity again during enrollment. Preserve the
current encrypted credential until the replacement is verified and saved with
its expected revision. Keep the encryption key available for the current store;
changing it alone makes existing ciphertext unreadable.

## Recipients, opt-out, and send outcomes

Only active, undeleted students with prior valid attendance qualify. The rule uses
the studio's business date and excludes an effective hold, canceled classes, and
future attendance. Students without recorded attendance are excluded. An adult
uses their own valid email. A minor uses exactly one valid primary guardian, or
exactly one valid guardian when there is no primary; ambiguous routing is skipped.
The worker checks current entitlement, contact, attendance, hold, and opt-out
state again before dispatch.

Preview does not queue or send messages. The subject and plain-text body support
`{{student_first_name}}`, `{{studio_name}}`, and `{{days_absent}}`. The renderer
escapes HTML and adds an unsubscribe link to actual sends.

Unsubscribe links end in `/automations/unsubscribe#<opaque_token>`. The capability
stays in the browser fragment, outside the request path and query. A generic GET
page moves it into a hidden form field; POST confirms the opt-out. GET alone
changes nothing. Suppression applies to the original studio and recipient and
survives later attendance or template changes.

One absence episode permits one accepted send. Only a later valid return to class
can reset it; correcting old attendance does not reopen an attempted episode.
Graph HTTP `202` means accepted by the provider, not received in the inbox. A
request ID is correlation evidence, not a message ID or duplicate-send guarantee.
See the [Graph sendMail contract](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).
Explicit throttling or a proven failure before submission can retry with backoff.
A timeout or lost response after submission, including an ambiguous provider
failure, becomes `unknown` and is never automatically resent. Inspect evidence
before deciding whether any further action is appropriate.

## Scheduled work and pause controls

The candidate schedule is daily at 18:00 UTC, `0 18 * * *`, on
`GET /api/cron/automations/process-due`. It is pending deployment and activation.
The existing Vercel project hosts the bridge; no new service or paid resource is
required by this implementation. Existing scheduled jobs keep their cadence.
Vercel executes the schedule only on production deployments. The fixed UTC time
falls during the day for US studios; there is no per-studio send-time setting in
this version.

The bridge authenticates `CRON_SECRET`, then forwards `AUTOMATION_WORKER_SECRET`
in `X-Internal-Secret` to
`POST /internal/automations/missed-class/process-due` under the pinned backend
`/api/v1` base, with `{"limit":10}`. The route has `maxDuration=60` and a local
55-second budget. It makes at most three sequential calls, each with a 30-second
timeout, and starts another only with at least 30 seconds left. It stops when
`has_more=false`, both `enqueued` and `processed` are zero, or a response is invalid,
failed, or ambiguous. It never blindly retries a lost worker response.
Any returned `failed` or `unknown` count also stops further batches. Counts from
completed batches remain truthful, including provider acceptance, which does not
prove inbox delivery. A `retry_wait` count alone permits another batch when
actionable work and enough time remain.

Each backend call has a 25-second work budget, including credential reads,
refresh, persistence, and provider submission. No new send begins after its
budget expires. A daily invocation processes at most 30 rows and may process
fewer. A larger queue remains visible for later runs. `has_more` describes work
actionable now, not messages waiting for a future retry time.
The daily cap does not promise that every due message will be sent that day.

Pause an individual studio rule in Automations. For a global pause, set
`EMAIL_SEND_ENABLED=false` on the backend and disable
`AUTOMATION_WORKER_ENABLED` on both backend and frontend. A pause cannot recall
an email already submitted to Microsoft. Keep the new switches false in
reusable examples and provider manifests until the reviewed activation change.

## Moving to a domain sender

Switching to `notifications@koaryu.app` requires a configured mailbox or sending
provider, matching provider consent, and verified domain authentication. Changing
`EMAIL_FROM_ADDRESS` alone does not grant Microsoft permission to send as that
address. Sender/provider configuration is independent of studio rule storage.

The current Outlook sender needs no `koaryu.app` DNS changes. The
[email-domain policy](email-domain-authentication.md) records the August 22, 2026
non-sending-domain assessment, not a current DNS inspection. Reinspect actual
records and establish SPF/DKIM/DMARC alignment and any required receiving records
before activating a future domain sender.

## Local verification

Use synthetic data and no enrollment files:

```bash
cd backend
venv/bin/python -m pytest tests/test_automation_email_config.py tests/test_config.py tests/test_automation_email.py tests/test_automation_email_credentials.py tests/test_microsoft_graph_email.py
```

Run `npm run check:env-examples` from the repository root to check declared
settings, placeholder credentials, disabled flags, and provider inventory.
