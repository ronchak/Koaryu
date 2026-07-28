# Production data classification policy and operating runbook

Status: **implemented for synthetic and secret-safe aggregate inputs; no production snapshot classified by this PR**

This runbook implements the reproducible, read-only portion of Gate #27. It does not inspect raw production records, approve any existing classification artifact, or authorize a production mutation. Unknown records remain preservation targets.

## Safety boundary

The classifier is an offline JSON-to-JSON transformation. It has no database, Supabase, Stripe, HTTP, deletion, anonymization, merge, relink, account-takeover, or contact capability. It accepts only the versioned secret-safe schema in `config/production-data-classification-input.schema.json`.

Never give it names, email addresses, phone numbers, free text, raw identifiers, provider payloads, support content, student data, or unkeyed hashes of any of those values. The schema is closed: an unexpected field or evidence kind fails the run before a manifest is emitted.

Classification is not deletion eligibility. Every resulting label, including `controlled_synthetic` and `historical_setup`, is read-only evidence. Any deletion, anonymization, merge, relink, user contact, Auth change, or Stripe action requires a separate reserved-action PR and approval package.

## Versioned artifacts

- Policy and stable rules: `config/production-data-classification-policy.json`
- Secret-safe input contract: `config/production-data-classification-input.schema.json`
- Manifest contract: `config/production-data-classification-manifest.schema.json`
- Offline classifier: `scripts/classify-production-data.mjs`
- Exact-output verifier: `scripts/verify-production-data-classification.mjs`
- Synthetic fixture: `scripts/fixtures/production-data-classification.synthetic.json`
- Reproducibility and privacy tests: `scripts/classify-production-data.test.mjs`

Run the synthetic audit with:

```bash
npm run audit:production-classification
```

This command uses only the committed synthetic fixture. It never connects to production.

## Small taxonomy

| Classification | Required evidence | Confidence |
| --- | --- | --- |
| `current_customer` | At least one approved aggregate live customer relationship | High |
| `historical_customer` | Historical aggregate customer relationship and no live relationship | High |
| `controlled_synthetic` | Entry in the approved synthetic-marker registry | High |
| `required_system` | Entry in the approved system-dependency registry | High |
| `historical_setup` | Narrow setup-record attestation approved by the data owner | Medium |
| `unknown` | No conclusive evidence, or conflicting conclusive evidence | Low |

`unknown` is the fail-closed default. A live and historical customer signal is one customer claim group and resolves to `current_customer`. Evidence from different claim groups conflicts and resolves to `unknown`; priority never hides a cross-group conflict.

There is no inheritance. A studio classification does not cascade to Auth users, subscriptions, payment accounts, Stripe events, students, guardians, payments, or any other record.

`abandoned` is deliberately not a classification. Inactivity cannot establish abandonment, and an abandonment label could be mistaken for mutation authority.

## Evidence hierarchy

The checked-in policy defines this order:

1. Authoritative aggregate provider or finalized business-relationship evidence.
2. Approved controlled system and synthetic registries.
3. A narrowly scoped data-owner setup attestation.
4. Application relationships and recent activity, which are context only.

Names and email patterns are absent from the schema and cannot be evidence. Inactivity is also not dispositive: `recent_activity` can add a context reason but can never produce a non-unknown classification.

Each output record contains:

- an HMAC-based opaque entity reference;
- its in-scope record type;
- one taxonomy label;
- a stable rule ID;
- stable reason codes;
- `high`, `medium`, or `low` confidence;
- aggregate evidence counts with opaque source references; and
- a SHA-256 evidence fingerprint.

## Exact secret-safe extraction contract

No live extraction is needed to implement or test this PR. Before any future production read, Ronak Chakraborty must approve the exact read-only query package, target, operator, snapshot binding, and private output location.

An approved extractor may emit only the following logical columns before assembling the input JSON:

| Column | Contract |
| --- | --- |
| `backup_set_ref` | `backup_` plus a 64-hex HMAC token for the immutable backup set |
| `source_project_ref` | `project_` plus a 64-hex HMAC token |
| `captured_at` | UTC snapshot timestamp with whole-second precision |
| `application_sha` | Exact 40-hex deployed commit |
| `repository_migration_head` | Exact 14-digit repository migration head |
| `remote_migration_history_digest` | SHA-256 digest of the ordered aggregate migration history |
| `backup_data_ciphertext_digest` | SHA-256 digest of the exact encrypted data artifact |
| `artifact_encryption_key_ref` | Opaque fingerprint/version reference for the artifact-encryption key, never the key |
| `retention_location_ref` | Opaque reference for the exact approved private retention destination |
| `opaque_ref_key_version` | Opaque key-version reference, never the HMAC key |
| `record_type` | One of the five policy-defined source types |
| `opaque_ref` | `entity_` plus HMAC-SHA-256 of a typed raw identifier using the classification-specific key |
| `evidence_kind` | One of the seven policy-defined aggregate evidence kinds |
| `evidence_count` | A bounded non-negative integer |
| `evidence_source_ref` | `evidence_` plus a 64-hex opaque source reference |

The HMAC key must be classification-specific, held outside the backup destination, absent from SQL text and shell history, and identified in the artifact only by key version. Entity references use HMAC-SHA-256 over the UTF-8 bytes of `koaryu-production-data-classification/v1`, a NUL byte, `record_type`, a NUL byte, and the canonical raw identifier. PostgreSQL UUIDs use their lowercase canonical text form; provider string IDs use their exact case-sensitive stored form. An unkeyed email hash is prohibited. Prefer raw stable IDs as HMAC input; do not derive opaque references from emails when IDs are available.

The query package must:

- execute in a read-only transaction against an approved immutable restore of the exact encrypted dump, or use one shared exported PostgreSQL snapshot for both dump and extraction;
- return only the allowed columns above;
- produce all five `source_counts`, including explicit zeroes;
- include each in-scope source identifier exactly once;
- aggregate relationship evidence to counts before output;
- never select or return names, emails, phone numbers, dates of birth, free text, raw IDs, provider payloads, or support/student content;
- never include a statement other than `SELECT`, `WITH`, transaction-local read-only controls, or session-local timeout controls; and
- write only to a locked, private temporary location with shell tracing disabled.

If the exact query cannot meet that contract, report the blocked evidence gap. Do not broaden the output or fall back to raw provider/admin endpoints.

## Snapshot binding and partition proof

The input header binds a run to:

- one opaque backup-set reference;
- the exact encrypted data-artifact digest;
- one source-project reference and capture time;
- the exact application SHA;
- repository migration head and remote migration-history digest;
- extractor and opaque-reference scheme versions;
- artifact-encryption and HMAC key-version references, never either key;
- an opaque reference for the exact approved retention destination; and
- the technical creation role.

The generated manifest additionally records the classifier source digest, policy digest, normalized input digest, and manifest digest.

For every in-scope record type, classification fails unless:

```text
source_count == manifest_identifier_count
manifest_identifier_count == distinct_manifest_identifier_count
classified_count == source_count
missing_count == 0
unexpected_count == 0
```

The verifier regenerates the full manifest and requires canonical byte-for-byte semantic equality. It does not merely recalculate the final digest.

## Private run procedure

After the exact read-only extraction package and target are approved:

1. Verify the encrypted backup artifact and classify a disposable restore of that exact artifact, or use the same approved exported snapshot for both operations.
2. Set a restrictive umask, create a locked temporary directory outside the repository, and place only schema-conforming aggregate input there.
3. Run the classifier with output redirected to a mode-`0600` manifest file. Do not print the real manifest in CI, GitHub, Slack, or another broad log.
4. Run the exact-output verifier against the private input and manifest.
5. Independently regenerate or verify from a clean environment.
6. Encrypt the input, manifest, approval record, and verification result at the approved Koaryu backup destination. Remove plaintext temporary artifacts only under the approved evidence-handling procedure.
7. Record only aggregate category counts, unknown counts, policy/classifier SHAs, ciphertext hashes, and pass/fail results in the release ledger. Never record entity or evidence references there.

The repository intentionally contains no production command with a linked project reference and no production input or manifest.

## Named approval and retention boundary

- Data owner: **Ronak Chakraborty**
- Technical operator: **Codex release orchestrator**
- Classification approver: **Ronak Chakraborty**
- Classification approval scope: the exact read-only manifest digest only
- Retention location: **approved encrypted Koaryu backup destination**
- Retention period: **24 months after the manifest is superseded**
- Policy review: **at least annually and whenever scope or evidence rules change**
- Mutation authority conferred by classification: **none**

The generated manifest always says `classification_approval_status: not_recorded`; the classifier cannot approve its own work. Approval must be recorded separately and reference the exact manifest digest.

Any later mutation package must identify the exact opaque records or deterministic rules, the proposed action, user and provider impact, backup and recovery posture, rollback, post-action verification, and Ronak’s explicit approval. Approval of a classification manifest does not approve that package.

## Current evidence gap

This PR proves the process using synthetic fixtures and does not claim Gate #27 closure. The existing encrypted classification manifest has not been decrypted, inspected, regenerated, or approved here. Its integrity, exact backup binding, aggregate reconciliation, and policy compatibility remain separate approval-gated work.
