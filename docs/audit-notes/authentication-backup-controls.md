# Authentication and backup control inventory

> Read-only assurance record captured at `2026-07-28T03:05:29Z`. This work did
> not change production or staging Auth configuration, revoke a production
> session, upgrade a plan, enable PITR, change retention, initiate a restore, or
> expose user-level Auth data.

The machine-enforced source of record is
[`docs/supabase-control-inventory.json`](../supabase-control-inventory.json).
It covers the pinned production and staging projects, requires a named owner,
review cadence, evidence, current and target state, compensating controls,
next action, and approval state for 17 controls in each environment.

## Current provider-safe snapshot

| Evidence | Production | Staging | Interpretation |
| --- | --- | --- | --- |
| Project | `ACTIVE_HEALTHY`, PostgreSQL 17, `us-west-2` | `ACTIVE_HEALTHY`, PostgreSQL 17, `us-west-1` | Both pinned projects exist and remain distinct |
| Organization plan | Free | Free | Paid Auth session limits, native backup access, and PITR must not be assumed |
| Native backup list | 0 listed | 0 listed | No provider-restorable backup was evidenced |
| PITR | Disabled | Disabled | No point-in-time restore is available from current evidence |
| WAL-G/physical backup plumbing | Enabled | Enabled | This is not a backup entitlement, retention window, or restore point |
| Public Auth settings | Not read back | Sign-up enabled; email enabled; confirmation required; phone, anonymous, social, SAML, and passkeys disabled | Production remains unverified; staging has a bounded public snapshot |
| Auth configuration | Not read back | Public subset only | Password policy, refresh rotation, reuse interval, session limits, MFA, CAPTCHA, and rate limits remain blocked |
| Synthetic session/revocation test | Not run; production is read-only | Passed with two sessions, one-hour JWT, `session_id`, global sign-out, rejection of both refresh tokens, Auth-user endpoint rejection of the issued access token, and confirmed user cleanup | Staging proves the tested provider path only |

The staging access-token result must not be generalized to Koaryu's production
backend. Supabase Auth rejected the tested access token after global sign-out,
but Koaryu production validates JWTs locally and does not query
`auth.sessions` for every request. Supabase's documented general guarantee is
that a revoked access token may remain valid until its `exp` claim. Production
therefore has a residual revocation window equal to the provider JWT lifetime,
which still needs readback.

The current official references are:

- [User sessions](https://supabase.com/docs/guides/auth/sessions)
- [Signing out](https://supabase.com/docs/guides/auth/signout)
- [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Database backups and PITR](https://supabase.com/docs/guides/platform/backups)
- [Platform access control](https://supabase.com/docs/guides/platform/access-control)
- [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)

The 2026-07-28 Supabase changelog review found no hosted Auth/session or backup
breaking change that alters this inventory. The current Management API logging
change and self-hosted Auth URL change are not applicable here.

## Ownership, cadence, and evidence

Ronak Chakraborty is the control owner, evidence custodian, incident recipient,
approval owner, and current restore operator. This concentration is itself an
access/recovery gap until a second recoverable owner path is approved and
verified.

| Control family | Review cadence | Operational cadence | Evidence |
| --- | --- | --- | --- |
| Project identity, health, plan, backup inventory, PITR | Weekly and before release/recovery | Read-only provider check | Sanitized connector/CLI or Management API summary |
| Public Auth and token/session settings | Weekly; monthly after stabilization | After every Auth change | Allowlisted configuration only |
| Password, MFA, attack protection, rate limits | Monthly and before public launch | After every related change | Allowlisted setting values and approval record |
| Session revocation | Monthly | Disposable staging user only | Aggregate result from the bounded two-session test |
| Organization roles, restore access, audit access | Quarterly and after team change | Before every restore drill | Role-level evidence in an approved private location |
| Encrypted logical capture | Weekly control review | Daily capture target | Timestamp, artifact set, size/mode, and hashes; never contents |
| Restore drill | Quarterly and after backup-format change | New disposable target | Target guard, hashes, aggregate counts, authenticated tenant-safe read, elapsed RTO, cleanup |

Provider screenshots or exports belong in an approved private evidence location.
Repository and PR evidence may contain only safe setting values, timestamps,
aggregate counts, status, plan name, role-level conclusions, hashes, and durable
provider object identifiers. Never include access tokens, API keys, database
URLs with credentials, SMTP settings, signed URLs, raw Auth records, user IDs,
emails, factor data, sessions, refresh tokens, access tokens, or backup
contents.

## Reproducible drift checks

The default check is offline and safe for CI:

```bash
npm run check:supabase-controls
```

It fails when a required environment/control disappears, an owner or evidence
field is blank, a blocked/gap control loses its approval gate, secret-shaped
Auth fields escape the allowlist tests, or review evidence exceeds its declared
cadence. It does not call a provider and does not claim that a static record
proves current provider state.

An operator with a current Supabase Management API personal access token can
run a read-only live comparison:

```bash
set -euo pipefail
set +x
read -r -s -p "Supabase access token: " SUPABASE_ACCESS_TOKEN
export SUPABASE_ACCESS_TOKEN
echo
npm run check:supabase-controls:live
unset SUPABASE_ACCESS_TOKEN
```

The live path calls only:

- `GET /v1/projects`
- `GET /v1/projects/{ref}/config/auth`
- `GET /v1/projects/{ref}/database/backups`

It compares pinned project status, region, backup count, PITR, and WAL-G
plumbing state with the recorded baseline. Auth output is restricted to a fixed
safe allowlist that includes the documented rate-limit fields; SMTP, hook
secrets, keys, URLs, future unknown fields, and future unknown rate-limit fields
are dropped. Any drift fails closed and requires an inventory update or incident
decision. Do not pass `--debug`, shell tracing, or a response-dump option.

The CLI backup read is also provider-safe:

```bash
supabase backups list --project-ref mimguepumzsgmcaycdsh --output json
supabase backups list --project-ref nxgsektqsgrtyfhawxbc --output json
```

Record only backup count, earliest/latest timestamps, PITR state, region, and
whether physical backup plumbing is enabled. Do not record provider backup IDs
or download contents in routine evidence.

## Controlled staging revocation exercise

The test refuses production and any unpinned project. It creates one random,
confirmed, synthetic staging identity, establishes two sessions, performs a
global sign-out, checks that both refresh tokens are rejected, records only JWT
lifetime/`session_id` presence and aggregate access-token behavior, hard-deletes
the user, verifies deletion, and prints no identity or credential.

```bash
set -euo pipefail
set +x
export SUPABASE_AUTH_TEST_PROJECT_REF=nxgsektqsgrtyfhawxbc
export SUPABASE_AUTH_TEST_URL=https://nxgsektqsgrtyfhawxbc.supabase.co
export SUPABASE_AUTH_TEST_ACKNOWLEDGE_DISPOSABLE=true

# Load the staging anon/publishable and service-role values from an approved
# private secret store without printing them, then run:
npm run verify:supabase-auth-revocation

unset SUPABASE_AUTH_TEST_PROJECT_REF SUPABASE_AUTH_TEST_URL
unset SUPABASE_AUTH_TEST_ACKNOWLEDGE_DISPOSABLE
unset SUPABASE_AUTH_TEST_ANON_KEY SUPABASE_AUTH_TEST_SERVICE_ROLE_KEY
```

Do not run this against production, use an existing identity, add tenant data,
send email, exercise password reset, disable a user, rotate a signing key, or
remove an MFA factor. Those are separate approval-gated tests.

## Approval packet

No item below is approved by this document. Ronak must record a decision,
date, selected option, expected cost, implementation owner, rollback/abort
condition, and verification plan before provider or production mutation.

### Decision 1: production Auth configuration readback

- Requested action: authorize an authenticated read-only dashboard worksheet or
  provide a current Management API token in a private shell.
- Data boundary: configuration only; no Users page, user export, session rows,
  factors, SMTP credentials, keys, hooks, or audit-log event contents.
- Output: the safe allowlist used by the live checker and a refreshed inventory.
- Cost/provider mutation: none.
- Current blocker: neither available browser session was authenticated and the
  CLI's mediated credential was not a reusable Management API bearer token.

### Decision 2: session and revocation posture

Choose one:

1. Accept JWT-only revocation with production `jwt_exp <= 3600`, enabled refresh
   rotation, documented reuse interval, and the explicit statement that local
   backend authorization can survive sign-out until expiry.
2. Add a separately reviewed active-session check for narrowly defined
   high-risk routes by validating `session_id` against current session state.
3. Approve a paid plan and choose time-box, inactivity timeout, and/or
   single-session settings after staging compatibility testing.

Changing session settings is not an incident shortcut. Supabase applies some
session-limit changes on refresh rather than proactively destroying current
access tokens.

### Decision 3: production backup and PITR path

Reconfirm current pricing before approval. The dated 2026-07-28 documentation
describes:

- Free: no proven downloadable native backup; continue the Koaryu logical path.
- Pro: approximately `$25/month` organization plan with seven days of daily
  backups documented for Pro projects.
- PITR: paid add-on on Pro/Team/Enterprise and at least a Small compute add-on;
  documented estimates are approximately `$100/month` for 7 days,
  `$200/month` for 14 days, or `$400/month` for 28 days, plus compute/plan cost.

Choose one:

1. Remain Free and approve daily encrypted logical capture, provider-independent
   off-site retention, monitored failure alerts, and quarterly full restore
   drills.
2. Approve Pro daily backups while retaining the logical off-site copy for
   provider and Storage-object failure modes.
3. Approve PITR with an explicit retention window and cost ceiling while
   retaining a provider-independent logical copy.

Native database backups do not restore deleted Storage object bytes. The Koaryu
Storage manifest/object archive remains necessary in every option.

### Decision 4: restore access and owner recovery

- Name the minimum production restore operator group.
- Verify, without publishing identities, who can view scheduled/physical
  backups and who can initiate restore.
- Approve a second recoverable organization Owner path protected by MFA, or
  explicitly accept the single-owner recovery risk.
- Require two-person target confirmation for any production restore and a
  measured disposable drill before relying on the four-hour RTO.

### Decision 5: logical off-site custody

- Approve provider/folder or bucket, geographic separation, encryption-at-rest
  posture, named readers, retention window, rotation cadence, monitoring owner,
  deletion owner, and ongoing cost.
- Upload only the five existing encrypted artifacts; never plaintext or the
  Keychain recovery secret.
- Download through an authenticated session, verify all recorded hashes, prove
  unauthorized access fails, and prove a wrong recovery key fails.
- Complete the human-only physical recovery-key copy separately from the
  encrypted artifacts.

## Exit criteria

This control area is clean only when:

- all provider Auth settings have current allowlisted evidence;
- the production residual revocation window is known and accepted or reduced;
- password, MFA, CAPTCHA/attack protection, and rate-limit decisions are
  explicit;
- backup entitlement, current restore points, retention, and PITR are evidenced;
- restore authority and second-owner recovery are verified;
- daily off-site encrypted copies meet the accepted RPO; and
- a full disposable application restore meets the accepted RTO with an
  authenticated tenant-safe read and cleanup evidence.

Until then, the static inventory remains green only as a completeness and
freshness control. It does not convert approval-gated gaps into passing
production controls.
