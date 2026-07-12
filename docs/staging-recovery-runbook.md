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
    --cipher-algo AES256 --pinentry-mode loopback --passphrase-fd 3 \
    --output "$BACKUP_DIR/${name}.sql.gpg" "$DUMP_DIR/${name}.sql" \
    3<<<"$BACKUP_PASSWORD"
done
gpg --batch --yes --symmetric --force-aead --aead-algo OCB \
  --cipher-algo AES256 --pinentry-mode loopback --passphrase-fd 3 \
  --output "$BACKUP_DIR/storage-objects.tar.gpg" \
  "$DUMP_DIR/storage-objects.tar" 3<<<"$BACKUP_PASSWORD"

(cd "$BACKUP_DIR" && shasum -a 256 *.gpg)
BACKUP_COMPLETE=true
cleanup_backup
trap - EXIT HUP INT TERM
```

Do not place the password in a command argument, repository file, shell trace, or release record. The key is held in macOS Keychain under service `com.koaryu.backup.encryption`. GnuPG 2.5+ uses AES-256 with OCB authenticated encryption here, so tampering is rejected during decryption. Record the hashes and backup path in the release ledger, then move the encrypted artifacts to the approved off-site location. No plaintext dump may remain after verification.

The record-classification manifest is a separate inventory artifact, not an output of `supabase db dump`. Generate it with the reviewed conservative classifier, containing identifiers and hashed emails but no raw names or addresses, then encrypt it with the same GPG AEAD command as `record-classification-manifest.json.gpg`. Record its count, policy, and hash in the ledger. Do not treat a record as approved for deletion merely because the classifier labels it test or demo.

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

Before copying, record the approved provider and folder/bucket, Ronak as data owner, the minimum named operator group, encryption-at-rest posture, retention window, rotation cadence, monitoring owner, deletion owner, and whether the destination adds ongoing cost. Keep the existing Koaryu AEAD artifacts encrypted; do not upload plaintext dumps or the Keychain recovery secret. A paid storage upgrade or materially higher operational burden requires the approval boundary in the release ledger.

After the provider destination is approved, upload only the five `.gpg` artifacts, then download them into a new locked temporary directory through an authenticated provider session. Verify all five recorded SHA-256 hashes against that downloaded copy before decrypting. A local source-path checksum does not close the gate. Also verify that an unauthorized identity cannot read the provider object and that a deliberately wrong recovery key fails closed. Record provider object identifiers and access-policy evidence without including signed URLs, access tokens, raw PII, or secrets.

The 2026-07-11 local prerequisite audit reconfirmed all five recorded SHA-256 hashes, mode `0600`, a present Keychain recovery item, successful decryption to `/dev/null` with that item, and rejection of a deliberately wrong key. No off-site artifact was found, no upload occurred, and no plaintext was written. These checks are prerequisites only; they do not close the off-site gate.

## Restore Drill

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
   BACKUP_DIR="$HOME/Koaryu Backups/production-20260710T070020Z"
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
