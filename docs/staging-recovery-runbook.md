# Staging and Recovery Runbook

Use this runbook to rebuild Koaryu staging, prove that it is isolated from production, create an encrypted logical backup, and rehearse a restore. Production changes are out of scope unless they have the explicit approvals listed in [the release ledger](release-ledger.md).

## Environment Boundaries

| Environment | Supabase project ref | Stripe mode | Rule |
| --- | --- | --- | --- |
| Production | `mimguepumzsgmcaycdsh` | Live configuration is production-only | Never use as a staging, replay, or restore target |
| Current staging | `nxgsektqsgrtyfhawxbc` | Test only | May contain sanitized fixtures; must not contain production-derived rows |

The current `koaryu-staging` project is isolated: all 82 repository migrations were replayed, the production backup was **not** restored into it, and it contains only the synthetic `River City Martial Arts` fixture. The dedicated staging backend API is `https://koaryu-staging.onrender.com/api/v1`, and the protected durable staging frontend alias is `https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app`. The temporary hosted restore target used for the July 10 drill was `zmmacdleiaohvxdubrav`; it was deleted after validation.

Staging frontend and backend configuration must point only to `nxgsektqsgrtyfhawxbc`. They must not contain the production Supabase ref, any `sk_live_`/`rk_live_`/`pk_live_` Stripe value, the production frontend origin, or a production backend destination. Never print secret values while checking this.

Run this guard in a private shell before any staging migration, seed, restore, or deploy command:

```bash
set -euo pipefail
set +x
export EXPECTED_STAGING_REF=nxgsektqsgrtyfhawxbc
export PRODUCTION_REF=mimguepumzsgmcaycdsh

test "$SUPABASE_PROJECT_REF" = "$EXPECTED_STAGING_REF"
test "$SUPABASE_PROJECT_REF" != "$PRODUCTION_REF"
test "$SUPABASE_URL" = "https://${EXPECTED_STAGING_REF}.supabase.co"
test "${STRIPE_MODE:-}" = "test"
test "${LIVE_BILLING_ENABLED:-}" = "false"

case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *) echo "Refusing: staging Stripe secret key is absent or not test mode" >&2; exit 1 ;;
esac
case "${STRIPE_RESTRICTED_KEY:-}" in
  ""|rk_test_*) ;;
  *) echo "Refusing: staging restricted key is not test mode" >&2; exit 1 ;;
esac
```

Before a frontend or backend staging deploy, run the automated application guard with a private, non-traced environment assembled from both providers. `STAGING_PLATFORM_WEBHOOK_DESTINATION` and `STAGING_CONNECT_WEBHOOK_DESTINATION` are non-secret audit inputs copied from the Stripe test-mode dashboard; the signing secrets remain secret inputs. The guard prints only a pass/fail summary, enforces exact origins and webhook destinations, and rejects production destinations and live Stripe key prefixes.

The backend independently enforces the same hosted posture at startup when `ENVIRONMENT=staging`: the pinned staging Supabase/frontend identities, test Stripe key shapes, complete webhook and internal-operation secrets, disabled legacy HS256, disabled demo reset, and `/api/v1` prefix are mandatory. A manual shell guard cannot make an unsafe backend boot successfully.

```bash
set -euo pipefail
set +x
export EXPECTED_STAGING_REF=nxgsektqsgrtyfhawxbc
export PRODUCTION_REF=mimguepumzsgmcaycdsh
export EXPECTED_STAGING_FRONTEND_ORIGIN=https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app
export EXPECTED_STAGING_BACKEND_API=https://koaryu-staging.onrender.com/api/v1
export STAGING_PLATFORM_WEBHOOK_DESTINATION=https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/platform
export STAGING_CONNECT_WEBHOOK_DESTINATION=https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/connect

# Load the configured frontend/backend values without tracing them, then run:
npm run verify:staging-isolation
```

The shell assertions below remain a minimal fallback for a private operator shell. They intentionally fail while the expected staging origins are unknown. Assign dedicated staging URLs first; do not substitute production URLs to make the guard pass.

```bash
set -euo pipefail
set +x
: "${EXPECTED_STAGING_REF:?set the expected staging Supabase project ref}"
: "${PRODUCTION_REF:?set the production Supabase project ref}"
: "${EXPECTED_STAGING_FRONTEND_ORIGIN:?set the dedicated staging frontend origin}"
: "${EXPECTED_STAGING_BACKEND_API:?set the dedicated staging backend /api/v1 URL}"
: "${NEXT_PUBLIC_SITE_URL:?set the configured frontend site URL}"
: "${FRONTEND_URL:?set the backend CORS frontend URL}"
: "${NEXT_PUBLIC_API_URL:?set the configured public backend /api/v1 URL}"
: "${BACKEND_API_URL:?set the server-side backend /api/v1 URL}"
: "${NEXT_PUBLIC_SUPABASE_URL:?set the configured public Supabase URL}"

normalize_url() {
  local value="$1"
  while [ "${value%/}" != "$value" ]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

EXPECTED_STAGING_FRONTEND_ORIGIN="$(normalize_url "$EXPECTED_STAGING_FRONTEND_ORIGIN")"
EXPECTED_STAGING_BACKEND_API="$(normalize_url "$EXPECTED_STAGING_BACKEND_API")"
CONFIGURED_STAGING_FRONTEND_ORIGIN="$(normalize_url "$NEXT_PUBLIC_SITE_URL")"
CONFIGURED_BACKEND_FRONTEND_ORIGIN="$(normalize_url "$FRONTEND_URL")"
CONFIGURED_STAGING_PUBLIC_API="$(normalize_url "$NEXT_PUBLIC_API_URL")"
CONFIGURED_STAGING_BACKEND_API="$(normalize_url "$BACKEND_API_URL")"

case "$EXPECTED_STAGING_FRONTEND_ORIGIN" in
  https://koaryu.app|https://www.koaryu.app)
    echo "Refusing: staging frontend origin resolves to production" >&2; exit 1 ;;
esac
case "$EXPECTED_STAGING_BACKEND_API" in
  https://koaryu.onrender.com|https://koaryu.onrender.com/*)
    echo "Refusing: staging backend API resolves to production" >&2; exit 1 ;;
esac
test "$NEXT_PUBLIC_SUPABASE_URL" = "https://${EXPECTED_STAGING_REF}.supabase.co"
test "$NEXT_PUBLIC_SUPABASE_URL" != "https://${PRODUCTION_REF}.supabase.co"
test "$CONFIGURED_STAGING_FRONTEND_ORIGIN" = "$EXPECTED_STAGING_FRONTEND_ORIGIN"
test "$CONFIGURED_BACKEND_FRONTEND_ORIGIN" = "$EXPECTED_STAGING_FRONTEND_ORIGIN"
test "$CONFIGURED_STAGING_PUBLIC_API" = "$EXPECTED_STAGING_BACKEND_API"
test "$CONFIGURED_STAGING_BACKEND_API" = "$EXPECTED_STAGING_BACKEND_API"

case "${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:-}" in
  pk_test_*) ;;
  *) echo "Refusing: staging publishable key is absent or not test mode" >&2; exit 1 ;;
esac
test "${STRIPE_MODE:-}" = "test"
test "${LIVE_BILLING_ENABLED:-}" = "false"
case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *) echo "Refusing: staging secret key is absent or not test mode" >&2; exit 1 ;;
esac
case "${STRIPE_RESTRICTED_KEY:-}" in
  ""|rk_test_*) ;;
  *) echo "Refusing: staging restricted key is not test mode" >&2; exit 1 ;;
esac
```

Webhook signing secrets do not encode test/live mode in their prefix. Confirm both configured endpoint URLs in the Stripe test-mode dashboard are the dedicated staging backend before installing those secrets.

### 2026-07-11 staging audit

- Supabase `nxgsektqsgrtyfhawxbc` reported `ACTIVE_HEALTHY` on PostgreSQL 17.
- Render `GET /api/v1/health` returned `200` after a cold wake. Unauthenticated `GET /api/v1/auth/me` and `GET /api/v1/students` each returned `401`.
- A CORS preflight from the then-current temporary protected frontend alias returned `200` with that alias as `Access-Control-Allow-Origin`; the same preflight from `https://koaryu.app` returned `400 Disallowed CORS origin` without an allow-origin header. This was historical evidence for the retired alias, not proof for the durable `staging` alias introduced later.
- The Vercel staging deployment `dpl_AXrjgCKzsFr6q3V2AKTU3hJjgYTa` is `READY`, protected by Vercel SSO, and built from `b78cb9863e226d17dc242259cf7099e62c6ccfd5`, not the current release-orchestration head. Its branch-scoped configuration proves the staging Supabase URL, matching public/server backend URL, the non-production site alias, live application mode, and sensitive treatment of public Supabase/Stripe keys without printing their values.
- The gate remains open: Render's deployed Git SHA, backend secret/test-mode classification, both Stripe test-mode webhook destinations and delivery evidence, current application-SHA alignment, proxy smoke behind Vercel SSO, and an authenticated representative application smoke are not yet proven.

Do not infer a provider value from application behavior. Capture Render environment metadata and exact deployed SHA through authenticated provider access, copy the two non-secret Stripe test endpoint URLs into the guard inputs, run the guard, deploy the same current SHA to both services, and then run the protected frontend and authenticated smoke checks.

Use `GET /api/version` on the protected staging frontend and `GET /health/ready` on the staging backend for application-reported SHA evidence. Both endpoints reject malformed provider metadata instead of reflecting it. Reconcile those responses with authenticated Vercel and Render deployment metadata; application responses do not replace provider readback.

### 2026-07-12 17:20 UTC durable-alias recheck

- At this timestamp, the durable staging alias pointed to Vercel preview deployment `dpl_5fW7LGhrUUXv1pDXC71azn4XT6YV`. Authenticated provider metadata reported it `READY`, and its `/api/version` response reported candidate `9cfd5123b3e1e28a274432a1fccdbf446739c89b`.
- The protected frontend proxy reached the staging backend: `/api/proxy/health` returned `200`, while unauthenticated `/api/proxy/auth/me` returned `401`.
- A fresh direct preflight from the durable staging origin returned `400 Disallowed CORS origin`. The retired temporary origin still returned `200`, and the production origin remained rejected. Render staging is therefore deployed with the old frontend-origin value; prior CORS evidence must not be used for the durable alias.
- Before exact-candidate staging deployment, authenticated Render access must replace the stale staging frontend-origin value, preserve all other isolated test-only values, and deploy this candidate. The candidate's staging startup validator is designed to reject the stale value rather than boot with it.
- No Render configuration, production provider state, production data, or billing state was changed during this recheck.

Aliases and deployment heads are mutable after this timestamp. Use the linked PR and Gate #21 provider evidence for the later exact head; do not treat this time-bounded observation as a perpetual statement of current deployment state.

### 2026-07-12 19:48 UTC acceptance recheck

- PR #53 runtime-control head `d687621eec40c50236b7a0d6ef3ec1d0cdcb59d7` passed every required GitHub, CodeQL, secret-analysis, Supabase replay/contract, frontend/backend, API-contract, and Vercel check.
- Render staging deployment `dep-d99unqt7vvec7389u6eg` reported `Live` for that exact SHA. `/health/live` and `/health/ready` returned `200` and the exact SHA. CORS returned `200` for the durable staging alias and `400` for `https://koaryu.app`.
- Vercel staging deployment `dpl_8kgoNDw8erQqzWTHB9sUSxFzdPtK` reported `READY`. The generated branch alias had not advanced automatically, so the alias was explicitly reassigned to this staging deployment. Authenticated `/api/version` then reported the exact SHA; protected proxy health returned `200`, and unauthenticated proxy auth returned `401`.
- The canonical Stripe test account, publishable key, restricted key, secret key, recurring Core Price, and both staging webhook endpoints were verified as one account boundary. The platform endpoint has six selected events and the connected-accounts endpoint has nineteen. Real disposable platform-subscription and connected-account update events were delivered successfully; Stripe reported no pending webhook delivery, and every synthetic provider object was removed afterward.
- A disposable synthetic staging user completed password sign-in, direct and protected-proxy authenticated profile reads, a protected-proxy lead create, and direct lead read/update. The lead, activities, audit record, membership, and Auth user were then verified absent. No production-derived identity or row was used.
- Production Render auto-deploy is `Off` on two authenticated UI readbacks. The guarded merge performs two authenticated API readbacks immediately before merging and refuses a moved PR head/base or any non-green check.

This is acceptance evidence for Gate #21. Recheck the exact final PR head in the provider comments because the evidence-only commit that records this section necessarily changes the commit SHA.

## Rebuild Clean Staging

1. Create or select a Supabase project that is separate from production. Set `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, and test-mode Stripe variables, then run the guard above.
2. Link the repository only after the guard passes. Confirm the saved ref before continuing:

   ```bash
   supabase link --project-ref "$SUPABASE_PROJECT_REF"
   test "$(tr -d '\n' < supabase/.temp/project-ref)" = "$EXPECTED_STAGING_REF"
   supabase migration list --linked
   ```

3. Preview the replay, then apply all repository migrations to the clean target:

   ```bash
   supabase db push --linked --include-all --dry-run
   supabase db push --linked --include-all
   supabase migration list --linked
   supabase db lint --linked --fail-on error
   SUPABASE_DB_TARGET=linked scripts/verify-supabase-contracts.sh
   ```

   These linked checks are appropriate only because this procedure deliberately targets staging after its migrations have been applied. Never substitute the production project ref.

4. Load only reviewed, sanitized fixtures. The seed studio should cover authentication, students, guardians, attendance, schedules, ranks, leads, staff roles, and billing-readiness tests without production PII.
5. Before deploying staging applications, rerun the target guard and verify that both application environments reference the staging Supabase URL, test Stripe mode, and staging webhook endpoints.

## Encrypted Logical Backup

### Canonical recovery tooling

The checked-in recovery tooling is the required contract for every new backup
set used to close Gates #22 or #23. The original Wave 0 five-file package below
remains useful historical evidence, but it is not a canonical recovery set and
must not be presented as final off-site or application-recovery proof.

Run the fixture suite before preparing evidence:

```bash
npm run check:recovery-tooling
```

The canonical encrypted set contains exactly these artifacts before the
encrypted outer manifest is added:

- `roles.sql.gpg`
- `schema.sql.gpg`
- `data.sql.gpg`
- `migration-history-schema.sql.gpg`
- `migration-history-data.sql.gpg`
- `project-config-manifest.json.gpg`
- `restore-integrity-manifest.json.gpg`
- `classification-source.json.gpg`
- `record-classification-manifest.json.gpg`
- `storage-objects.tar.gpg`

Supabase migration history is separate from the ordinary schema/data dump.
Capture all columns from `supabase_migrations.schema_migrations` using the
current documented CLI pattern, then encrypt both files with the same AEAD
procedure as the other SQL artifacts:

```bash
supabase db dump --linked \
  --schema supabase_migrations \
  --file "$DUMP_DIR/migration-history-schema.sql"
supabase db dump --linked --data-only --use-copy \
  --schema supabase_migrations \
  --file "$DUMP_DIR/migration-history-data.sql"
```

First derive the snapshot identity from the exact six locked plaintext payloads.
The generator holds each regular file with `O_NOFOLLOW`, rejects hardlinks and
non-private modes, and hashes it once. Its database snapshot digest is canonical
JSON over the ordered artifact names, plaintext sizes, and plaintext SHA-256
values; do not substitute a hand-authored snapshot id:

```bash
scripts/create-snapshot-bindings.py \
  --roles "$DUMP_DIR/roles.sql" \
  --schema "$DUMP_DIR/schema.sql" \
  --data "$DUMP_DIR/data.sql" \
  --migration-history-schema "$DUMP_DIR/migration-history-schema.sql" \
  --migration-history-data "$DUMP_DIR/migration-history-data.sql" \
  --storage-objects "$DUMP_DIR/storage-objects.tar" \
  --output "$LOCKED_CONTRACT_DIR/snapshot-bindings.json"
```

Copy the generated `database_snapshot_digest` into backup metadata, restore
integrity, and classification source, and copy its exact `snapshot_artifacts`
array into restore integrity. Standalone restore-integrity validation recomputes
that digest from all six bindings and refuses a hand-authored or stale value.
Manifest creation decrypts the encrypted payloads to an in-memory hash stream
and refuses any mismatch.

Create the secret-free project-configuration and restore-integrity contracts
from the schemas in `config/recovery/`. These are explicitly
`operator_attested_partial`, not provider-exported complete configuration. The
project contract records Auth core security, API-key posture, Data API grants,
Realtime publications, Storage bucket constraints, Stripe mode, and
email-delivery posture. Its required manual-reconfiguration inventory covers
external Auth/OAuth, SMTP/SMS/templates, Auth hooks, Edge Functions and secrets,
database network/pooler/SSL settings, Vault, custom domains, provider plans and
PITR, Storage S3/transforms, Realtime limits, runtime environments, Stripe
dashboard credentials/webhooks, and logging/alerting. The integrity contract
records per-table counts and primary-key-set digests, migration history,
database catalog digests, and Storage counts/digests, while clearly marking
those semantics as unverified until a restore. Keep both plaintext source files
in a locked private working directory, validate them before encryption, and
remove that working directory after the encrypted set is verified:

```bash
scripts/validate-recovery-contract.py \
  --kind project-config \
  --input "$LOCKED_CONTRACT_DIR/project-config-manifest.json"
scripts/validate-recovery-contract.py \
  --kind restore-integrity \
  --input "$LOCKED_CONTRACT_DIR/restore-integrity-manifest.json"
```

Generate classification only from a privacy-safe inventory of the exact backup
snapshot. Database sources require canonical UUIDs and Stripe records require
canonical `evt_` identifiers. Phone-like values, SHA-1/MD5/SHA-256 identifiers,
raw emails, names, addresses, support text, and arbitrary opaque ids are
rejected. The current trusted capture path does not compute email HMACs, so
`email_strategy` must be `omitted` and `key_id` must be `null`; a self-asserted
HMAC is rejected. Every policy source type must appear, including empty sources:

```bash
scripts/classify-production-records.py \
  --input "$LOCKED_CONTRACT_DIR/classification-source.json" \
  --output "$LOCKED_CONTRACT_DIR/record-classification-manifest.json"
scripts/verify-classification-manifest.py \
  --source "$LOCKED_CONTRACT_DIR/classification-source.json" \
  --manifest "$LOCKED_CONTRACT_DIR/record-classification-manifest.json"
```

The classifier uses the versioned policy at
`config/recovery/production-data-classification-policy.json`, verifies
totality/uniqueness/partition invariants, and fails closed to `unknown` when no
approved source-scoped rule or more than one rule matches. Stable rule IDs and
the policy digest make every decision reproducible. Classification never
authorizes a write, deletion, anonymization, Auth action, or Stripe action.

Encrypt each validated JSON contract with the canonical contract encryptor.
This tool serializes the reviewed value as canonical JSON directly into GPG;
do not encrypt the pretty-printed source file with a separate GPG command. Open
a fresh descriptor for every command because reading the passphrase consumes
that descriptor:

```bash
scripts/encrypt-recovery-contract.py \
  --kind project-config \
  --input "$LOCKED_CONTRACT_DIR/project-config-manifest.json" \
  --output "$BACKUP_DIR/project-config-manifest.json.gpg" \
  --passphrase-fd 3 \
  3< <(security find-generic-password -s com.koaryu.backup.encryption -w)
scripts/encrypt-recovery-contract.py \
  --kind restore-integrity \
  --input "$LOCKED_CONTRACT_DIR/restore-integrity-manifest.json" \
  --output "$BACKUP_DIR/restore-integrity-manifest.json.gpg" \
  --passphrase-fd 3 \
  3< <(security find-generic-password -s com.koaryu.backup.encryption -w)
scripts/encrypt-recovery-contract.py \
  --kind classification-source \
  --input "$LOCKED_CONTRACT_DIR/classification-source.json" \
  --output "$BACKUP_DIR/classification-source.json.gpg" \
  --passphrase-fd 3 \
  3< <(security find-generic-password -s com.koaryu.backup.encryption -w)
scripts/encrypt-recovery-contract.py \
  --kind classification-manifest \
  --input "$LOCKED_CONTRACT_DIR/record-classification-manifest.json" \
  --output "$BACKUP_DIR/record-classification-manifest.json.gpg" \
  --passphrase-fd 3 \
  3< <(security find-generic-password -s com.koaryu.backup.encryption -w)
```

After all ten artifacts are encrypted, create the canonical encrypted manifest
before removing the locked plaintext contract inputs. The metadata and four
reviewed contract inputs must be mode `0600`; the backup directory and
encrypted artifacts must not be group- or world-accessible. Pass the recovery
key only over an already-open descriptor:

```bash
scripts/create-encrypted-backup-manifest.py \
  --backup-dir "$BACKUP_DIR" \
  --metadata "$LOCKED_CONTRACT_DIR/backup-set-metadata.json" \
  --project-config "$LOCKED_CONTRACT_DIR/project-config-manifest.json" \
  --restore-integrity "$LOCKED_CONTRACT_DIR/restore-integrity-manifest.json" \
  --classification-source "$LOCKED_CONTRACT_DIR/classification-source.json" \
  --classification-manifest "$LOCKED_CONTRACT_DIR/record-classification-manifest.json" \
  --passphrase-fd 3 \
  3< <(security find-generic-password -s com.koaryu.backup.encryption -w)
```

The result is `backup-manifest.json.gpg`. Record its printed SHA-256 in the
release ledger. It authenticates the exact artifact names, roles, ciphertext
sizes/hashes, every decrypted plaintext size/hash, contract plaintext hashes,
the derived source snapshot, application SHA, migration head/history digest,
tool versions, encryption key ID, and retention class. The outer manifest is
streamed directly into GPG; no plaintext manifest tempfile is created. Every
artifact must use AES-256/OCB, iterated-and-salted S2K mode 3, SHA-512, count
`65011712`, and chunk size `22`. The directory must contain exactly the canonical
files—notes, nested directories, symlinks, devices, FIFOs, and hardlinks are all
refused. Before reporting success, the creator snapshots and independently
verifies the completed eleven-file set; a failed post-write verification removes
the outer manifest so an inconsistent set cannot be mistaken for complete. The
manifest intentionally does not contain the encryption secret.

### Historical Wave 0 capture reference

The validated Wave 0 backup is stored at:

`$HOME/Koaryu Backups/production-20260710T070020Z`

It contains encrypted role, schema, data, classification, and Storage artifacts. For a new backup, first confirm that the Supabase CLI is linked to production and that the operation is dump-only. This target check is intentionally the inverse of the staging guard:

```bash
set -euo pipefail
set +x
export EXPECTED_PRODUCTION_REF=mimguepumzsgmcaycdsh
test "$(tr -d '\n' < supabase/.temp/project-ref)" = "$EXPECTED_PRODUCTION_REF"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Koaryu Backups}"
BACKUP_DIR="$BACKUP_ROOT/production-${STAMP}"
DUMP_DIR=""
BACKUP_PASSWORD=""
BACKUP_COMPLETE=false
cleanup_backup() {
  unset BACKUP_PASSWORD
  if [ -n "${DUMP_DIR:-}" ] && [ -d "$DUMP_DIR" ]; then
    rm -rf -- "$DUMP_DIR"
  fi
  if [ "${BACKUP_COMPLETE:-false}" != true ] && [ -n "${BACKUP_DIR:-}" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf -- "$BACKUP_DIR"
  fi
}
trap cleanup_backup EXIT HUP INT TERM

DUMP_DIR="$(mktemp -d)"
test ! -e "$BACKUP_DIR"
mkdir -m 700 "$BACKUP_DIR"

supabase db dump --linked --role-only --file "$DUMP_DIR/roles.sql"
supabase db dump --linked --file "$DUMP_DIR/schema.sql"
supabase db dump --linked --data-only --use-copy \
  --schema auth,private,public,storage \
  --exclude storage.buckets_vectors \
  --exclude storage.vector_indexes \
  --exclude storage.objects \
  --exclude storage.s3_multipart_uploads \
  --exclude storage.s3_multipart_uploads_parts \
  --file "$DUMP_DIR/data.sql"

# Database dumps preserve Storage metadata, not object bytes. Discover every
# bucket, inventory it, and copy its bytes. Empty buckets are valid evidence.
mkdir -p "$DUMP_DIR/storage/inventory" "$DUMP_DIR/storage/objects"
supabase --experimental storage ls ss:/// --linked \
  > "$DUMP_DIR/storage/bucket-list.txt"
jq -n --arg source_ref "$EXPECTED_PRODUCTION_REF" \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{source_project_ref:$source_ref,captured_at:$captured_at,
    buckets:[]}' \
  > "$DUMP_DIR/storage/manifest.json"

BUCKET_COUNT=0
while IFS= read -r bucket_entry; do
  [ -n "$bucket_entry" ] || continue
  case "$bucket_entry" in
    */) bucket="${bucket_entry%/}" ;;
    *) echo "Refusing malformed Storage bucket entry" >&2; exit 1 ;;
  esac
  case "$bucket" in
    ""|.|..|*/*) echo "Refusing unsafe Storage bucket id" >&2; exit 1 ;;
  esac

  BUCKET_COUNT=$((BUCKET_COUNT + 1))
  mkdir -p "$DUMP_DIR/storage/objects/$bucket"
  supabase --experimental storage ls -r "ss:///$bucket" --linked \
    > "$DUMP_DIR/storage/inventory/$bucket.txt"
  OBJECT_COUNT="$(awk -v prefix="/$bucket/" \
    'index($0, prefix) == 1 && substr($0, length($0), 1) != "/" {count++}
     END {print count + 0}' "$DUMP_DIR/storage/inventory/$bucket.txt")"
  if [ "$OBJECT_COUNT" -gt 0 ]; then
    supabase --experimental storage cp -r "ss:///$bucket" \
      "$DUMP_DIR/storage/objects/" --linked
  fi
  DOWNLOADED_COUNT="$(find "$DUMP_DIR/storage/objects/$bucket" \
    -type f | wc -l | tr -d ' ')"
  test "$DOWNLOADED_COUNT" = "$OBJECT_COUNT"

  jq --arg bucket "$bucket" --argjson object_count "$OBJECT_COUNT" \
    '.buckets += [{id:$bucket,object_count:$object_count}]' \
    "$DUMP_DIR/storage/manifest.json" \
    > "$DUMP_DIR/storage/manifest.next.json"
  mv "$DUMP_DIR/storage/manifest.next.json" \
    "$DUMP_DIR/storage/manifest.json"
done < "$DUMP_DIR/storage/bucket-list.txt"

test "$(jq '.buckets | length' "$DUMP_DIR/storage/manifest.json")" \
  = "$BUCKET_COUNT"
(
  cd "$DUMP_DIR/storage/objects"
  while IFS= read -r -d '' object_path; do
    shasum -a 256 "$object_path"
  done < <(find . -type f -print0)
) > "$DUMP_DIR/storage/object-sha256.txt"
tar -C "$DUMP_DIR" -cf "$DUMP_DIR/storage-objects.tar" storage

BACKUP_PASSWORD="$(security find-generic-password \
  -s com.koaryu.backup.encryption -w)"

for name in roles schema data; do
  gpg --batch --yes --symmetric --force-aead --aead-algo OCB \
    --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 \
    --s2k-count 65011712 --chunk-size 22 \
    --pinentry-mode loopback --passphrase-fd 3 \
    --output "$BACKUP_DIR/${name}.sql.gpg" "$DUMP_DIR/${name}.sql" \
    3<<<"$BACKUP_PASSWORD"
done
gpg --batch --yes --symmetric --force-aead --aead-algo OCB \
  --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 \
  --s2k-count 65011712 --chunk-size 22 \
  --pinentry-mode loopback --passphrase-fd 3 \
  --output "$BACKUP_DIR/storage-objects.tar.gpg" \
  "$DUMP_DIR/storage-objects.tar" 3<<<"$BACKUP_PASSWORD"

(cd "$BACKUP_DIR" && shasum -a 256 *.gpg)
BACKUP_COMPLETE=true
cleanup_backup
trap - EXIT HUP INT TERM
```

Do not place the password in a command argument, repository file, shell trace, or release record. The key is held in macOS Keychain under service `com.koaryu.backup.encryption`. Canonical artifacts use GnuPG AES-256/OCB plus iterated-and-salted SHA-512 S2K with count `65011712`; the checked-in packet validator rejects weaker modes even if decryption succeeds. Record the hashes and backup path in the release ledger, then move the encrypted artifacts to the approved off-site location. No plaintext dump may remain after verification.

The historical record-classification manifest is a separate inventory artifact,
not an output of `supabase db dump`. For future backups, use the checked-in
classifier above; do not reproduce the historical unversioned process. Never
treat a record as approved for deletion merely because it is classified as test
or demo.

The July 10 backup used PostgreSQL 17 on the host because the local container runtime could not resolve Supabase's direct IPv6-only database hostname. If the normal CLI command fails for the same reason, use `supabase db dump --dry-run` only inside a private, non-traced shell, capture its generated script without printing it, replace the generated `pg_dump` or `pg_dumpall` executable with the trusted PostgreSQL 17 host binary, and pipe its output directly into the encryption command. The generated script contains a short-lived database password and must never be logged, saved, or pasted into a release record.

Verify the validated artifacts before a restore:

```bash
cd "$HOME/Koaryu Backups/production-20260710T070020Z"
shasum -a 256 -c <<'EOF'
5ab64aaf4b9e3e95c83fe025e15ab8e6638bd6c3e47e86e9dc26cf8bb9e56163  data.sql.gpg
0748bc19b318551cb1db16617d2c7b16a2ab2423e0bdfb5950c243e82fbc4cdc  roles.sql.gpg
22fe1b7612f84dbc40c8c196dedbbf9280adbc55fb1b4e8174ea072d9e9a0f8e  schema.sql.gpg
83854854d34387a73777e8f80c7cddb9940b7ae62c8012d87dc89b1560e0b167  record-classification-manifest.json.gpg
f3d10e37ba2735eec46f7d21399323e6ad7ef3276ba8b580203b568531c9ab7e  storage-objects.tar.gpg
EOF
```

The validated `data.sql.gpg` explicitly contains 61 `auth.users` rows plus
Storage metadata. Production had exactly one bucket, `student-photos`, and it
contained zero objects at capture time, so `storage-objects.tar.gpg` contains
the encrypted complete bucket inventory and empty object directory. Future
backups enumerate every linked bucket from the Storage API and must copy and
encrypt any object bytes present; a SQL dump alone is not a Storage backup.
Future data dumps exclude `storage.objects` and transient multipart rows because
the Storage API recreates them when the archived bytes are uploaded. The restore
fails closed if object rows are already present before that upload.

## Off-site copy gate

The July 10 artifacts have not been found outside `$HOME/Koaryu Backups/production-20260710T070020Z`. A second local path, a synced-folder path without provider-side confirmation, or the ordinary staging project does not count as off-site recovery evidence.

Before copying, record the approved provider and folder/bucket, Ronak as data
owner, the minimum named operator group, encryption-at-rest posture, retention
window, rotation cadence, monitoring owner, deletion owner, target RPO/RTO, and
whether the destination adds ongoing cost. Retain at least two immutable backup
generations, or record a reviewed one-generation bootstrap reason and complete a
rotation test before release. Keep the existing Koaryu AEAD artifacts encrypted;
do not upload plaintext dumps or the Keychain recovery secret. A paid storage
upgrade or materially higher operational burden requires the approval boundary
in the release ledger.

The Keychain item on the source Mac is not independent key recovery. Before this
gate can close, approve one recovery-key copy in a separate trust boundary (for
example, an approved password manager, hardware-backed secondary device, or
sealed offline record), name the primary and backup key owners, and keep that
copy outside the backup provider container. Prove decryption from a clean account
or separate machine where the original Keychain item is unavailable, then test a
wrong key there as well. Evidence may record only the key version/fingerprint,
escrow-location class, named operators, and pass/fail result—never the key.

After the provider destination is approved, upload only the eleven canonical `.gpg`
artifacts, including `backup-manifest.json.gpg`. Upload remains an explicit
provider/operator action; this repository deliberately contains no upload
command. The provider must retain immutable object/version identifiers where
available and must never receive plaintext or the recovery key.

No provider adapter is currently approved:
`config/recovery/approved-provider-adapters.json` intentionally contains an
empty list. The command below therefore fails closed today. Choosing a provider
requires a reviewed repository change that pins the provider id, locator
scheme, exact adapter SHA-256, and minimum environment-variable allow-list.
Provider origin also needs an independent provider-specific control (for
example, a separately authenticated versioned-object inventory or signed
provider assertion); the adapter's own JSON receipt cannot prove where its
bytes came from.

Once that provider-specific review is complete, download into a new locked
directory. The runner snapshots the pinned adapter bytes, passes only fixed
locale/PATH plus the reviewed environment allow-list, closes every unrelated
file descriptor including the recovery-key descriptor, suppresses provider
stdout/stderr, runs from the private adapter snapshot with umask `077`, enforces
a 30-minute limit, terminates same-process-group descendants, and copies a held
exact-file inventory into a durable private snapshot. The
denylist rejects fixed PATH/locale names plus known shell, interpreter,
dynamic-loader, package-manager, Git, agent, and SSH execution-control families.
The profile review must still justify every allowed name and every external
adapter dependency. Receipts require eleven distinct
provider object identifiers with explicit version identifiers. `FILE://` in any
casing, HTTP(S), signed URL-like locators, the original local directory, nested
source paths, symlinks, hardlinks, extra files, and non-regular files are rejected:

```bash
scripts/download-offsite-backup.sh \
  --provider-profile 'reviewed-provider-profile-v1' \
  --provider-command /absolute/path/to/reviewed-provider-adapter \
  --provider-locator 'provider://non-secret-object-set-id' \
  --destination "$FRESH_PROVIDER_DOWNLOAD_DIR" \
  --known-local-source "$KNOWN_LOCAL_BACKUP_DIR" \
  --expected-manifest-sha256 "$RECORDED_BACKUP_MANIFEST_SHA256" \
  --passphrase-fd 3 \
  3< <(security find-generic-password -s com.koaryu.backup.encryption -w)
```

After validating the receipt shape and source-path guards, the verifier copies
the exact inventory through held file descriptors before cryptographic checks.
It authenticates and decrypts the outer manifest in memory, enforces the complete
GPG packet profile, checks ciphertext and plaintext hashes/sizes, validates and
cross-binds the four inner contracts, and checks whether the generic receipt's
object/version claims match the downloaded bytes. It always reports
`provider_origin=no`: matching self-authored receipt data is integrity evidence,
not independent origin evidence. Separately validate the approved provider ACL,
denied access, version retention, and the provider-specific independent origin
control. Also verify a deliberately wrong recovery key fails closed.
Test denied provider read with an unauthorized identity or unauthenticated path
without weakening the approved ACL. Record only the denied result and non-secret
provider identifiers.

The 2026-07-11 local prerequisite audit reconfirmed all five recorded SHA-256 hashes, mode `0600`, a present Keychain recovery item, successful decryption to `/dev/null` with that item, and rejection of a deliberately wrong key. No off-site artifact was found, no upload occurred, and no plaintext was written. These checks are prerequisites only; they do not close the off-site gate.

## Restore Drill

The command block in this section documents the historical Wave 0 drill only.
It is not a restore runner for the new canonical eleven-artifact set and does
not close Gate #23. Current checked-in tooling deliberately stops after
provider-candidate download, cryptographic authentication, generic
receipt-to-byte comparison, contract binding, and integrity-manifest validation;
it does not prove provider origin. A separately reviewed disposable-target restore
runner must consume the canonical manifest and re-check its recorded table,
catalog, Auth/project-configuration, migration-history, and Storage invariants
before this gate can close.

That future runner must also fail closed unless it:

- consumes the fresh provider candidate and matching receipt, never the known
  local source;
- uses target-specific signing/API keys, sink-only outbound messaging, and
  test-only or disabled external integrations without copying production
  secrets or callback destinations;
- proves production access/refresh tokens fail, clears restored live session
  state before exposure, and uses only a designated restore-only synthetic
  identity for the application smoke;
- deploys exact candidate frontend/backend SHAs and runs real authentication,
  same-tenant allow, cross-tenant deny, and final approved staff-capability deny
  cases through the application and direct API without recording row data;
- compares every table, catalog, migration-history, and Storage invariant from
  the encrypted contracts; and
- confirms deletion or disablement of the disposable app, database, Storage,
  credentials, sessions, downloaded artifacts, plaintext, callbacks, and aliases
  through provider readback. Any cleanup failure keeps the gate open.

A restore target is disposable and isolated. Never use current staging, production, or any project containing records that must be retained.

1. Create a temporary hosted Supabase project. Record its new ref as `RESTORE_REF`, then explicitly reject every durable target:

   ```bash
   set -euo pipefail
   test -n "$RESTORE_REF"
   test "$RESTORE_REF" != mimguepumzsgmcaycdsh
   test "$RESTORE_REF" != nxgsektqsgrtyfhawxbc
   test "$RESTORE_REF" != zmmacdleiaohvxdubrav
   export PGHOST="db.${RESTORE_REF}.supabase.co"
   export PGPORT=5432
   export PGSSLMODE=require
   test "$PGHOST" = "db.${RESTORE_REF}.supabase.co"
   ```

   Set `PGUSER`, `PGDATABASE`, and `PGPASSWORD` from the temporary project's transient connection details in a private shell. Do not record them. Initialize a separate disposable Supabase CLI workdir, link only that workdir to `RESTORE_REF`, set it as `RESTORE_WORKDIR`, and verify its saved ref before the restore. This is required even when the current Storage inventory is empty, so the same guarded procedure is exercised every time. Never repoint the repository's ordinary linked workdir for this step.

   ```bash
   RESTORE_WORKDIR="$(mktemp -d)"
   supabase --workdir "$RESTORE_WORKDIR" init --yes
   supabase --workdir "$RESTORE_WORKDIR" link --project-ref "$RESTORE_REF"
   test "$(tr -d '\n' < "$RESTORE_WORKDIR/supabase/.temp/project-ref")" = "$RESTORE_REF"
   ```

2. Verify the encrypted checksums, decrypt into a locked temporary directory, restore, and validate in one failure-safe shell:

   ```bash
   set -euo pipefail
   set +x
   umask 077
   : "${BACKUP_DIR:?set BACKUP_DIR to the fresh verified provider download}"
   : "${KNOWN_LOCAL_BACKUP_DIR:?set the original local source for rejection}"
   test "$(cd "$BACKUP_DIR" && pwd -P)" != \
     "$(cd "$KNOWN_LOCAL_BACKUP_DIR" && pwd -P)"
   RESTORE_DIR=""
   BACKUP_PASSWORD=""
   cleanup_restore() {
     unset BACKUP_PASSWORD PGPASSWORD PGUSER PGDATABASE PGHOST PGPORT PGSSLMODE
     if [ -n "${RESTORE_DIR:-}" ] && [ -d "$RESTORE_DIR" ]; then
       rm -rf -- "$RESTORE_DIR"
     fi
     if [ -n "${RESTORE_WORKDIR:-}" ] && [ -d "$RESTORE_WORKDIR" ]; then
       rm -rf -- "$RESTORE_WORKDIR"
     fi
   }
   trap cleanup_restore EXIT HUP INT TERM

   (cd "$BACKUP_DIR" && shasum -a 256 -c <<'EOF'
   5ab64aaf4b9e3e95c83fe025e15ab8e6638bd6c3e47e86e9dc26cf8bb9e56163  data.sql.gpg
   0748bc19b318551cb1db16617d2c7b16a2ab2423e0bdfb5950c243e82fbc4cdc  roles.sql.gpg
   22fe1b7612f84dbc40c8c196dedbbf9280adbc55fb1b4e8174ea072d9e9a0f8e  schema.sql.gpg
   83854854d34387a73777e8f80c7cddb9940b7ae62c8012d87dc89b1560e0b167  record-classification-manifest.json.gpg
   f3d10e37ba2735eec46f7d21399323e6ad7ef3276ba8b580203b568531c9ab7e  storage-objects.tar.gpg
   EOF
   )

   RESTORE_DIR="$(mktemp -d)"
   BACKUP_PASSWORD="$(security find-generic-password \
     -s com.koaryu.backup.encryption -w)"
   for name in roles schema data; do
     gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-fd 3 \
       --output "$RESTORE_DIR/${name}.sql" "$BACKUP_DIR/${name}.sql.gpg" \
       3<<<"$BACKUP_PASSWORD"
   done
   gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-fd 3 \
     --output "$RESTORE_DIR/storage-objects.tar" \
     "$BACKUP_DIR/storage-objects.tar.gpg" 3<<<"$BACKUP_PASSWORD"
   tar -C "$RESTORE_DIR" -xf "$RESTORE_DIR/storage-objects.tar"
   unset BACKUP_PASSWORD

   psql --no-psqlrc --single-transaction --set ON_ERROR_STOP=1 \
     --file "$RESTORE_DIR/roles.sql" \
     --file "$RESTORE_DIR/schema.sql" \
     --command 'SET session_replication_role = replica' \
     --file "$RESTORE_DIR/data.sql"

   psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align <<'SQL'
   select 'public_tables=' || count(*)
     from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE';
   select 'auth_users=' || count(*) from auth.users;
   select 'studios=' || count(*) from public.studios;
   select 'onboarding_rpc=' || (to_regprocedure('public.create_studio_onboarding(uuid,text,text,text)') is not null);
   SQL

   # Restore every manifest bucket only after linking an isolated CLI workdir
   # to RESTORE_REF and proving it cannot be production or ordinary staging.
   STORAGE_OBJECT_COUNT="$(jq '[.buckets[].object_count] | add // 0' \
     "$RESTORE_DIR/storage/manifest.json")"
   STORAGE_METADATA_OBJECT_ROWS="$(psql --no-psqlrc --set ON_ERROR_STOP=1 \
     --tuples-only --no-align --command 'select count(*) from storage.objects')"
   test "$STORAGE_METADATA_OBJECT_ROWS" = 0
   if [ "$STORAGE_OBJECT_COUNT" -gt 0 ]; then
     (cd "$RESTORE_DIR/storage/objects" && \
       shasum -a 256 -c ../object-sha256.txt)
   fi
   test "$(tr -d '\n' < "$RESTORE_WORKDIR/supabase/.temp/project-ref")" = "$RESTORE_REF"
   test "$RESTORE_REF" != mimguepumzsgmcaycdsh
   test "$RESTORE_REF" != nxgsektqsgrtyfhawxbc

   jq -r '.buckets[].id + "/"' "$RESTORE_DIR/storage/manifest.json" \
     | sort > "$RESTORE_DIR/storage/expected-buckets.txt"
   supabase --experimental --workdir "$RESTORE_WORKDIR" storage ls \
     ss:/// --linked | sort > "$RESTORE_DIR/storage/restored-buckets.txt"
   diff -u "$RESTORE_DIR/storage/expected-buckets.txt" \
     "$RESTORE_DIR/storage/restored-buckets.txt"

   RESTORED_TOTAL=0
   mkdir -p "$RESTORE_DIR/storage/verified-objects"
   while IFS= read -r bucket; do
     case "$bucket" in
       ""|.|..|*/*) echo "Refusing unsafe Storage bucket id" >&2; exit 1 ;;
     esac
     EXPECTED_OBJECT_COUNT="$(jq --arg bucket "$bucket" \
       '.buckets[] | select(.id == $bucket) | .object_count' \
       "$RESTORE_DIR/storage/manifest.json")"
     LOCAL_OBJECT_COUNT="$(find "$RESTORE_DIR/storage/objects/$bucket" \
       -type f | wc -l | tr -d ' ')"
     test "$LOCAL_OBJECT_COUNT" = "$EXPECTED_OBJECT_COUNT"
     if [ "$EXPECTED_OBJECT_COUNT" -gt 0 ]; then
       supabase --experimental --workdir "$RESTORE_WORKDIR" storage cp -r \
         "$RESTORE_DIR/storage/objects/$bucket" ss:/// --linked
       supabase --experimental --workdir "$RESTORE_WORKDIR" storage cp -r \
         "ss:///$bucket" "$RESTORE_DIR/storage/verified-objects/" --linked
     fi
     RESTORED_OBJECT_COUNT="$(
       supabase --experimental --workdir "$RESTORE_WORKDIR" storage ls -r \
         "ss:///$bucket" --linked \
         | awk -v prefix="/$bucket/" \
           'index($0, prefix) == 1 && substr($0, length($0), 1) != "/" {count++}
            END {print count + 0}'
     )"
     test "$RESTORED_OBJECT_COUNT" = "$EXPECTED_OBJECT_COUNT"
     RESTORED_TOTAL=$((RESTORED_TOTAL + RESTORED_OBJECT_COUNT))
   done < <(jq -r '.buckets[].id' "$RESTORE_DIR/storage/manifest.json")
   test "$RESTORED_TOTAL" = "$STORAGE_OBJECT_COUNT"
   if [ "$STORAGE_OBJECT_COUNT" -gt 0 ]; then
     (cd "$RESTORE_DIR/storage/verified-objects" && \
       shasum -a 256 -c ../object-sha256.txt)
   fi

   cleanup_restore
   trap - EXIT HUP INT TERM
   ```

3. Validate only aggregate, non-PII evidence. The July 10 drill produced 37 `public` tables, 61 `auth.users` rows, and 52 `public.studios` rows. A future drill must also run an authenticated tenant-safe application read before it is considered a full application recovery exercise.
4. Delete the temporary hosted target through the Supabase control plane only after the operator reconfirms `RESTORE_REF`. Unset `RESTORE_REF` and `BACKUP_DIR` afterward. Recreate ordinary staging from repository migrations, not from the production backup.

## Recovery Decision

- For application-only regression, redeploy the release ledger's named application rollback SHA; do not change database history.
- For a forward-compatible schema regression, prefer a reviewed forward-only corrective migration.
- Do not use `supabase migration repair`, rewrite old migrations, restore over production, or delete production data without an approved recovery plan and the explicit approval required by the release ledger.
- If credentials, target identity, or approval is uncertain, stop. Record the blocked check instead of treating it as passed.
