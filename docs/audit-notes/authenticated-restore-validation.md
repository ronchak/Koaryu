# Authenticated tenant-safe restore validation contract

> Repository-safe implementation only. This contract and its synthetic fixture
> do not prove a live restore, authorize access to a production backup, or
> authorize provider resource creation. Gate
> [#23](https://github.com/ronchak/Koaryu/issues/23) remains open until a
> separately approved production-derived exercise reaches `destroyed` and the
> final evidence passes with `--require-production-derived`.

## What is implemented

The repository now has a fail-closed verifier for the sanitized evidence from
an authenticated restore exercise:

- `scripts/verify-authenticated-restore.mjs`
- `scripts/verify-authenticated-restore.test.mjs`
- `scripts/fixtures/authenticated-restore/synthetic-evidence.json`

Run the self-contained contract fixture with:

```bash
npm run test:authenticated-restore
npm run verify:authenticated-restore -- \
  --evidence "$PWD/scripts/fixtures/authenticated-restore/synthetic-evidence.json"
```

The fixture contains only aliases, invented counts, invented hashes, and
`.invalid` URLs. The command explicitly reports that synthetic evidence is not
live recovery evidence.

A live acceptance run must keep its sanitized evidence outside the repository
and use:

```bash
npm run verify:authenticated-restore -- \
  --evidence "/absolute/private/path/sanitized-restore-evidence.json" \
  --require-production-derived
```

The verifier does not create, restore, deploy, delete, or read any provider
resource. It validates the final sanitized observations collected by the
approved operator workflow.

## Required state machine

The only accepted order is:

```text
prepared -> restored -> verified -> app_tested -> destroyed
```

Every state needs an ISO 8601 UTC timestamp and `outcome: passed`. Timestamps
must be monotonic, the recorded elapsed seconds must exactly equal the start/end
timestamps, and the run must complete inside the recorded RTO. The contract
caps that RTO at four hours.

`destroyed` is not a documentation label. It is accepted only when every
declared provider resource has an absent-state readback, every synthetic
identity and mutation is absent, credentials and sessions are revoked, the
temporary callback is removed, local plaintext/download/work directories are
absent, ordinary staging has gained zero production-derived rows, and the
sanitized log scan has passed.

## Disposable target contract

The target must satisfy all of these conditions before any restore:

1. Classification is `ephemeral_recovery`; `disposable` and
   `named_operator_access_only` are true.
2. Its Supabase ref is a new 20-character ref and is not production
   (`mimguepumzsgmcaycdsh`), ordinary staging
   (`nxgsektqsgrtyfhawxbc`), or the deleted July restore target
   (`zmmacdleiaohvxdubrav`).
3. Frontend, backend, Auth site URL, and the single Auth callback are dedicated
   target identities. Production and ordinary-staging hosts are rejected.
4. The target lifetime is no more than eight hours and covers the exercise.
5. Supabase, frontend, and backend resources are all declared as ephemeral.
   Any callback, alias, or sink created for the exercise must be declared too,
   so cleanup coverage cannot omit it.
6. The target has newly issued keys. Source project credentials are not reused.
7. Restored source sessions are counted for immutable integrity evidence when
   required, then cleared before either disposable application is exposed.
8. Migration history is restored and compared. Auth settings, Realtime
   publications, and Storage security semantics are compared independently of
   secret values.
9. The frontend and backend provider readbacks and their application-reported
   version endpoints all match one exact full 40-character candidate SHA.

The target must never be production, ordinary staging, or a project with data
that must be retained.

## Outbound sink contract

The target is deny-by-default. The evidence must enumerate exactly these
channels:

| Channel | Allowed mode |
| --- | --- |
| Email | `blocked` or target-scoped `sink` |
| SMS | `blocked` or target-scoped `sink` |
| Stripe mutation | `blocked` |
| Platform webhook | `blocked` |
| Connect webhook | `blocked` |
| Telemetry | `blocked` or target-scoped `sink` |

All sink URLs must be dedicated non-production HTTPS destinations without
credentials, queries, or fragments. Stripe remains in test mode,
`LIVE_BILLING_ENABLED=false`, and all outbound Stripe mutation is blocked.
Production webhook destinations, signing secrets, live/test API keys, tokens,
and SMTP credentials never belong in the evidence file.

## Artifact and application identity

The exercise evidence must compare both SHA-256 and byte size for exactly this
encrypted set:

- `roles.sql.gpg`
- `schema.sql.gpg`
- `data.sql.gpg`
- `record-classification-manifest.json.gpg`
- `migration-history.sql.gpg`
- `storage-objects.tar.gpg`
- `backup-manifest.json.gpg`
- `restore-integrity-manifest.json.gpg`

The current historical five-artifact July set is therefore not by itself a
conforming input. Before a production-derived run, an approved new generation
needs the canonical backup manifest, migration history, and detailed integrity
manifest. That work requires the separate artifact-access authority described
below.

Production-derived acceptance also requires a provider-origin download receipt.
The download directory must be fresh and locked, and the original local backup
directory cannot be substituted. The sanitized receipt is represented only by
its digest, backup-set alias, and download time; provider access tokens, signed
URLs, secrets, and local source paths are prohibited.

Application identity has five equal values:

- expected candidate SHA;
- frontend provider Git SHA;
- frontend `/api/version` SHA;
- backend provider Git SHA;
- backend `/health/ready` SHA.

Migration identity separately requires the exact timestamped repository head
and an exact digest of the complete restored
`supabase_migrations.schema_migrations` history.

## Controlled synthetic identities

Production customer identities are never used for application smoke. After the
immutable restored-data comparison and source-session clearing, the target gets
only these disposable aliases:

| Alias | Tenant | Role |
| --- | --- | --- |
| `admin_a` | `tenant_a` | Admin |
| `admin_b` | `tenant_b` | Admin |
| `front_desk_a` | `tenant_a` | Front Desk |
| `instructor_a` | `tenant_a` | Instructor |
| `no_membership` | none | none |
| `revoked_a` | `tenant_a` | Instructor, then revoked |

Emails, user UUIDs, passwords, access tokens, refresh tokens, row bodies, and
names are not evidence. A private operator-only execution log maps aliases to
temporary target records and is deleted during cleanup.

## Required application checks

The verifier fixes the expected status and outcome for every case. Callers
cannot relabel a surprising response as expected.

Authentication:

- unauthenticated direct and proxy `/auth/me`: `401`;
- `admin_a` sign-in: `200`;
- authenticated direct, proxy, and frontend profile paths: `200`;
- a throwaway token minted only by a separate synthetic wrong-project issuer:
  `401`;
- a deliberately invalid synthetic refresh token: `400`;
- the revoked disposable identity attempting sign-in: `400`.

No active production access token, refresh token, or session is obtained or
replayed. Source/target issuer and key separation is compared from secret-safe
provider semantics; the negative HTTP probes use synthetic material only.

Tenant behavior:

- `admin_a` same-tenant direct, proxy, and frontend reads: `200`;
- `admin_a` cross-tenant read and write probes: `404`.

The two `404` checks must return no row content, produce no mutation or audit
row, and not reveal whether the foreign identifier exists.

Role behavior reuses the shipped Gate #25 matrix:

- Admin staff-management read: `200`;
- Front Desk roster read: `200`;
- Front Desk staff-management attempt: `403`;
- Instructor attendance probe: `200`, exactly one synthetic application
  mutation, and exactly one audit row;
- Instructor roster-management attempt: `403`;
- no-membership read: `404`, matching Koaryu's existing no-studio behavior.

Every read and denial carries a before/after digest proving no application-data
mutation. Every denial also carries equal before/after audit counts. Response
bodies and PII are never captured.

## Private Storage proof

The restored `student-photos` bucket must remain private. Its bucket
configuration digest and complete object inventory must match the encrypted
manifest. Object identities use only a path digest, content SHA-256, and byte
size; raw paths and signed URLs are prohibited.

An empty restored inventory is valid but does not exercise the application
Storage path. After immutable comparison, the operator uploads one synthetic
probe to `tenant_a` and verifies:

- same-tenant application retrieval returns `200` and the downloaded bytes
  match the upload SHA-256;
- anonymous application retrieval returns `401`;
- `admin_b` cross-tenant retrieval returns `404`;
- no signed URL or response body is retained;
- the probe is absent before the target project is destroyed.

## Aggregate and structure reconciliation

The integrity manifest must cover the full expected relation inventory, not
only a hand-picked count. Each entry compares row count and an ordered
primary-key-set digest. At minimum it includes:

- `public.studios`, `public.staff_roles`, `public.students`,
  `public.guardians`, `public.attendance`, `public.class_sessions`, and
  `public.leads`;
- `auth.users`, `auth.identities`, and `auth.sessions`;
- `storage.buckets` and `storage.objects`;
- `supabase_migrations.schema_migrations`.

It also compares canonical digests for schema inventory, function definitions
and ACLs, triggers, RLS policies, extensions, Realtime publications, and
migration history. Orphan checks for staff/Auth, student/studio,
attendance/student/session, and Storage object/bucket relationships must all be
zero.

Detailed production-derived manifests remain encrypted. Durable PR/issue
evidence contains only pass/fail, aggregate inventory sizes, encrypted artifact
identity, elapsed time, and provider resource aliases.

## Sensitive-data rejection

The verifier rejects evidence keys or values that look like passwords, secrets,
credentials, token values, raw names/emails/paths/rows/bodies, provider keys,
email addresses, JWTs, or authorization headers. It also requires explicit
false values for response-body, PII, and signed-URL capture.

This is defense in depth. The operator still reviews the sanitized JSON in a
private shell before attaching only its digest and aggregate summary to GitHub.
The evidence JSON itself should not be committed when it describes a real
restore.

## Approval and execution packet for the live exercise

No item in this packet is approved by this PR. The PR must remain draft until
the packet is explicitly approved and a real exercise either completes cleanup
or records a blocker.

### Authority required

Ronak must explicitly authorize all of the following exact scopes:

1. Read access to one named approved off-site encrypted backup generation,
   including use of the separately held recovery key in a private environment.
2. Restoration of that production-derived generation into one new restricted
   disposable Supabase project that is neither production nor ordinary
   staging.
3. Creation and later deletion of one disposable protected frontend deployment
   and one disposable protected backend deployment.
4. Creation and deletion of a target-scoped email/telemetry sink only if
   blocking those channels entirely is not workable.
5. Creation, mutation, revocation, and deletion of the six target-only
   synthetic Auth identities, two synthetic tenants, one attendance probe, and
   one private Storage probe.
6. Provider control-plane deletion and readback for every temporary resource.

If any resource can incur cost, create a paid plan, or allocate a billable
provider object, cost and limit require a separate explicit approval. This
packet does not authorize production provider changes, production sessions,
production webhook changes, real email/SMS, Stripe objects or payments, or
ordinary-staging mutation.

### Inputs to pin before approval

- backup-set alias and encrypted artifact hashes/sizes;
- approved off-site provider object/version aliases and access owner;
- recovery-key version/fingerprint, never the key;
- exact full candidate Git SHA and migration head/history digest;
- new target naming prefix and maximum eight-hour deletion deadline;
- named operator and cleanup owner;
- expected zero-cost or separately approved cost ceiling;
- target frontend/backend origins and single Auth callback;
- provider-resource deletion/readback methods;
- incident contact if cleanup fails.

### Execution order

1. Start the UTC timer and create the private evidence workspace with mode
   `0700`/files `0600`.
2. Create the new target resources and immediately record their opaque IDs,
   owner, creation time, and deletion deadline.
3. Configure named-operator access, target-only keys, the single callback,
   deny-by-default egress, test Stripe mode, blocked Stripe/webhook mutation,
   and sink/blocked email, SMS, and telemetry.
4. Download the approved encrypted generation from the approved off-site
   provider into the new locked directory. Record only the sanitized receipt
   digest and object/version aliases.
5. Verify encrypted filenames, byte sizes, hashes, canonical backup manifest,
   recovery-key success, and deliberate wrong-key failure without producing
   durable plaintext.
6. Restore roles, schema, migration history, data, and Storage to the new
   Supabase target. Do not run migration repair or `db push`.
7. Compare the immutable restored integrity manifest, Auth-session counts,
   Storage inventory/bytes, and security semantics. Stop on any mismatch.
8. Clear restored source-session copies before application exposure. Compare
   target-specific issuer/key semantics, then run only the synthetic
   wrong-project access-token and invalid-refresh-token denials. Do not obtain
   or replay an active production token or session.
9. Create only the controlled synthetic aliases and probes.
10. Deploy the exact candidate SHA to both protected target applications and
    verify provider plus application-reported SHAs.
11. Execute the fixed auth, direct/proxy/frontend, tenant, role, Storage, and
    mutation/no-mutation matrix.
12. Remove the synthetic mutations and prove each is absent.
13. Delete or disable every frontend/backend/callback/sink resource, delete the
    disposable Supabase target, and read each state back through the provider
    API.
14. Delete plaintext, downloaded artifacts, temporary CLI state, private alias
    maps, logs, and credentials; revoke sessions/keys; scan the sanitized
    evidence for PII; prove ordinary staging has a zero production-derived row
    delta.
15. Record `destroyed`, stop the UTC timer, and run the verifier with
    `--require-production-derived`.

### Stop conditions

Stop before application exposure if target identity is ambiguous, any durable
ref/host appears, provider-origin receipt or artifact identity fails, migration
history differs, source sessions cannot be cleared, egress cannot be
deny-by-default, exact provider/application SHA readback fails, or PII-safe
evidence cannot be produced.

After resource creation, a verification failure does not skip cleanup. Move
directly to cleanup, keep the gate open, and identify the remaining opaque
resource alias. Never treat a failed deletion or unverifiable provider state as
`destroyed`.

## Current status

The synthetic fixture and negative tests prove the repository contract fails
closed across target selection, outbound sinks, artifacts, application SHA,
Auth, tenant/role checks, Storage, aggregate integrity, elapsed time, sensitive
data, and cleanup. They do not close Gate #23.

The live exercise is blocked on the authority packet above, a conforming new
encrypted backup generation/provider-origin receipt, and disposable provider
resources. No production artifact was accessed, no provider resource was
created, and no production-derived data was restored by this PR.
