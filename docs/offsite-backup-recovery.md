# Off-site encrypted backup recovery

This runbook defines the repository-controlled part of Koaryu backup recovery.
It does not authorize a storage provider, paid service, production-data access,
production artifact upload, key export, or destructive rotation. Those steps
remain approval-gated.

The repository helper can create and verify encrypted generations, copy an
already-downloaded generation into a locked recovery directory, prove wrong-key
rejection, decrypt on a clean machine, and move surplus generations into a
non-deleting quarantine. It deliberately has no provider credentials or upload
adapter.

## Recovery contract

The provisional planning targets remain:

- recovery point objective (RPO): no more than 24 hours;
- recovery time objective (RTO): no more than 4 hours.

They are targets, not current guarantees. Neither target is met until recurring
off-site generations and a timed application-level restore have evidence.

Every complete generation contains these five client-side encrypted artifacts:

- `roles.sql.gpg`;
- `schema.sql.gpg`;
- `data.sql.gpg`;
- `record-classification-manifest.json.gpg`;
- `storage-objects.tar.gpg`.

`generation-manifest.json` is non-secret operational metadata. It records only
the generation ID, creation time, encryption profile, artifact names, sizes,
and ciphertext SHA-256 values. It must not contain database coordinates,
provider credentials, signed URLs, raw PII, or key material. Record the
manifest's own SHA-256 in the release ledger or another independently retained
evidence record; a manifest stored only beside its artifacts is not an
independent trust anchor.

## Trust boundaries

Recovery crosses five boundaries. Approval and evidence must identify each one.

| Boundary | Permitted contents | Required separation and control |
| --- | --- | --- |
| Production source | Live database, Auth, and Storage data | Dump-only access from an explicitly verified production link; never a restore target |
| Backup workstation | Locked transient plaintext and encrypted output | Private temporary directories, no shell tracing, plaintext removed after a verified generation |
| Off-site destination | Koaryu ciphertext plus the non-secret generation manifest | Different failure domain from the source machine and ordinary synced storage; private access, MFA, versioning/deletion recovery, provider-side audit evidence |
| Key custody | High-entropy recovery secret | Never stored with ciphertext, in GitHub, in provider notes, or in a shell argument/environment variable; operational Keychain item plus a separately controlled offline recovery copy |
| Recovery environment | Retrieved ciphertext and temporary decrypted files | Clean host or clean user profile, independently installed GnuPG, locked directories, and a disposable restore target that is neither production nor ordinary staging |

The off-site destination must use a provider account and administrative session
that are not dependent on the production Supabase session or the source
workstation. A second local computer, a mounted synced folder without
provider-side confirmation, or a second path controlled by the same compromised
identity does not satisfy this boundary.

Provider encryption at rest is defense in depth. Koaryu's OpenPGP AES-256/OCB
encryption must happen before upload, and the provider must never receive the
recovery secret or plaintext.

## Ownership

These roles are required even if one person temporarily fills more than one:

| Role | Current assignment | Responsibility |
| --- | --- | --- |
| Data owner and deletion approver | Ronak Chakraborty | Approves provider, cost, retention changes, production upload, and final deletion |
| Primary backup operator | Ronak Chakraborty until delegated | Creates, uploads, retrieves, verifies, and records generations |
| Monitoring owner | Ronak Chakraborty until delegated | Reviews failed or stale generations within one business day |
| Secondary recovery/key custodian | **Unassigned** | Must be named before the off-site gate closes; can locate the runbook and recover the offline key if the primary operator is unavailable |

The secondary custodian does not need routine production access. Their access
must be the minimum required for recovery, documented outside the repository,
and reviewed at least quarterly. The unassigned secondary role is a release
readiness gap, not implicit permission to give another person access.

## Retention and rotation requirements

The proposed minimum policy, subject to provider cost approval, is:

- create one generation after every material production schema change and at
  least once per 24 hours;
- keep seven verified daily generations, four verified weekly generations, and
  three verified monthly generations off-site;
- keep at least two independently verified generations active at all times;
- enable provider version recovery or immutability for at least 30 days;
- preserve a superseded generation until its replacement passes ciphertext
  verification, wrong-key rejection, correct-key decryption, and the scheduled
  restore check;
- quarantine locally rotated generations for at least seven days and through
  the next successful clean-machine drill, whichever is later;
- never let automation permanently delete a generation. Provider lifecycle
  deletion and local quarantine cleanup require a reviewed inventory, the
  retention evidence above, and explicit data-owner approval.

The repository's `rotate` command only moves surplus generations into
`.rotation-quarantine`; it never deletes them. It refuses retention below two,
verifies every active candidate before moving it, verifies every moved and
retained generation afterward, and refuses to overwrite an existing quarantine
entry.

## Key custody and key rotation

The current operational secret is held in macOS Keychain service
`com.koaryu.backup.encryption`. The off-site gate also requires a tested offline
copy in a physically controlled location that is separate from the ciphertext
destination. The offline copy must have a named custodian, sealed recovery
instructions, and a quarterly presence/readability check that does not record
the secret.

Rotate the recovery key at least annually and immediately after suspected
exposure, loss of custody, or a custodian/access change. Rotation is
copy-on-success:

1. create a new generation under the new key without overwriting an existing
   generation;
2. record and independently retain its manifest SHA-256;
3. retrieve it through the approved off-site path;
4. prove the old key fails and the new key succeeds on the replacement;
5. complete the required restore validation;
6. retain the old-key generation and old key until the data owner approves
   retirement after the retention window.

The repository helper intentionally does not automate production key
re-encryption or key deletion. Those actions require a separate, reviewed
procedure because an interruption could strand the only recoverable copy.

## Repository automation

GnuPG 2.4 or newer is required. The helper uses symmetric OpenPGP
AES-256/OCB authenticated encryption and passes the secret to GnuPG on a private
file descriptor. The official GnuPG manual documents `--force-ocb` and OCB
decryption compatibility from GnuPG 2.2.21:
<https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Options.html>.

Check the host before handling any artifact:

```bash
npm run test:backup-recovery
```

The test uses only disposable synthetic fixture data. It creates real encrypted
artifacts, detects ciphertext tampering, verifies an independently supplied
manifest hash, simulates retrieval, rejects a wrong key without leaving a
restore directory, restores under a fresh GnuPG home, and rotates three
generations while proving none was deleted.

### Create an encrypted generation

First use the dump and classification procedure in
[Staging and Recovery Runbook](staging-recovery-runbook.md) to assemble exactly
five mode-`0600` plaintext files in a locked source directory. Keep the encrypted
generation root separate from that plaintext directory.

In a private shell with tracing disabled:

```bash
set -euo pipefail
set +x
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GENERATION_ID="production-${STAMP}"
PLAINTEXT_DIR="<locked temporary directory>"
GENERATIONS_DIR="<approved encrypted generation root>"

security find-generic-password -s com.koaryu.backup.encryption -w |
  node scripts/backup-recovery.mjs create \
    --source-dir "$PLAINTEXT_DIR" \
    --generations-dir "$GENERATIONS_DIR" \
    --generation-id "$GENERATION_ID"
```

The command refuses links, public directory/file modes, incomplete artifact
sets, nested plaintext/ciphertext roots, existing generation IDs, and GnuPG
failure. It creates in a private partial directory, verifies the complete
generation, then atomically publishes it. A failed partial generation is
removed; an existing complete generation is never changed.

Record the returned manifest SHA-256 independently before transport. Removing
the plaintext directory remains part of the caller's failure-safe cleanup
because the dump procedure owns that directory.

### Verify and retrieve

Provider-specific tooling must first download the generation through an
authenticated session. Do not add provider credentials, signed URLs, or a
generic remote-command hook to this repository helper.

To validate a provider-mounted or already-downloaded source and copy it into a
new locked recovery root:

```bash
node scripts/backup-recovery.mjs retrieve \
  --source-generation-dir "<provider-downloaded generation>" \
  --destination-root "<new locked recovery root>" \
  --expected-manifest-sha256 "<independently recorded 64-hex digest>"
```

The source and copied artifact hashes are both checked. To inspect in place
without copying:

```bash
node scripts/backup-recovery.mjs verify \
  --generation-dir "<downloaded generation>" \
  --expected-manifest-sha256 "<independently recorded 64-hex digest>"
```

Provider origin still requires provider-side object IDs, generation/version
IDs, timestamps, access-policy evidence, and a denied unauthorized read. A
successful local `retrieve` command alone is not off-site evidence.

### Prove artifact restore on a clean machine

Install the repository and GnuPG independently, create a locked recovery parent,
retrieve the approved key through its separate custody path, and pipe it to:

```bash
<approved non-echoing secret command> |
  node scripts/backup-recovery.mjs restore \
    --generation-dir "<retrieved generation>" \
    --restore-dir "<new restore directory>" \
    --expected-manifest-sha256 "<independently recorded 64-hex digest>"
```

The helper verifies ciphertext before decrypting and publishes plaintext only
after all five artifacts decrypt successfully. Wrong-key or tamper failure
removes the partial directory and leaves the requested restore path absent. The
resulting files are still production plaintext and must be used only inside the
approved disposable restore procedure, then removed by that procedure.

This proves artifact-level clean-machine recovery. The database, Auth, Storage,
and authenticated tenant-safe application checks in the staging/recovery
runbook are still required for full application recovery.

### Plan non-deleting generation rotation

Review a plan first:

```bash
node scripts/backup-recovery.mjs rotate \
  --generations-dir "<encrypted generation root>" \
  --retain 2
```

After confirming the exact generation IDs, move surplus generations into
quarantine without deleting them:

```bash
node scripts/backup-recovery.mjs rotate \
  --generations-dir "<encrypted generation root>" \
  --retain 2 \
  --apply
```

The operational retention schedule normally retains more than two. `2` is the
hard safety floor and is shown here only to make the invariant explicit.

## Evidence required to close the off-site gate

Evidence must be timestamped and must not include secrets, plaintext, raw PII,
tokens, signed URLs, or database connection strings:

1. approved provider/product, account boundary, region, destination identifier,
   cost, and exit/export procedure;
2. private-access policy, MFA, named identities, audit logging, version
   recovery/immutability, and a denied unauthorized read;
3. generation ID, independently recorded manifest hash, provider object/version
   IDs, upload time, size, and provider receipt;
4. provider-origin download into a new locked path and matching ciphertext
   hashes;
5. correct-key success and deliberately wrong-key rejection;
6. clean-host artifact restoration and cleanup evidence;
7. disposable database/Auth/Storage restore counts plus an authenticated,
   tenant-safe application read;
8. elapsed capture and restore times compared with the provisional RPO/RTO;
9. primary operator, monitoring owner, deletion approver, secondary recovery
   custodian, and last access review;
10. proof that at least two known-good generations survived rotation.

## Approval packet

The following decisions are still required before any external or production
action. Approval should name exact values rather than say only "use cloud
storage":

- provider and product;
- tenant/account owner, region, and exact bucket/folder boundary;
- monthly cost ceiling and whether paid activation is authorized;
- private access identities, primary operator, monitoring owner, and secondary
  recovery/key custodian;
- versioning/immutability and the seven-daily/four-weekly/three-monthly
  retention policy (or an explicit reviewed replacement);
- authorization to create the destination and run a synthetic encrypted upload,
  denied-access test, download, and cleanup;
- separate authorization to upload the named production encrypted generation;
- authorization and physical location class for the offline key copy;
- deletion approval process and provider-exit/export owner.

Until these values are approved and the evidence checklist passes, issue #22
and the off-site gate remain open. The PR implementing repository-only controls
should remain draft because it cannot truthfully claim off-site recoverability.
