# Release attestation generation

Proposed next Astra PR after normalized ledger PR164. No new migration, production operation or business-policy change. The candidate continues to describe V41.

## Outcome

A new schema release should declare its history boundary, required objects, reviewed pins and compatibility consumers once. Reusable emitters produce its complete preflight/manifest SQL and restore-check orchestration. Authors must not copy the preceding release's function and edit count/hash/name strings by hand.

Historical migrations remain immutable. Reproduction must render old attestation statements and all ten restore scripts byte-for-byte from declarations and shared emitters, then compare them with committed artifacts. Moving whole scripts or preflights into opaque templates is not a solution. Explicit business fixtures remain readable SQL/code because schema alone cannot specify their expected behavior.

The statement inventory found 105 directly authored definitions and nine distinct manifest families. The generator will cover the current full-preflight/compatibility and rank-manifest authoring families, with historical V39/V40/V41 and earlier matching examples as byte proofs. Older definitions remain frozen inputs checked against their committed bytes; they are not claimed as newly generated coverage. Building emitters for every obsolete catalog formatting variant would add machinery that future releases do not need. All ten existing restore scripts still require declared-case reproduction, and the report must identify every generated statement and unchanged historical input separately.

## Boundaries

- One offline repository-local generation command. Use the standard library and existing releaseManifestSql/local_postgres_verification helpers where their contracts fit. No new service, plugin registry, general SQL compiler or release packet system.
- Finite declared release states include predecessor, history head, preflight identity, manifest version, ordered check groups, compatibility consumers, restore ancestry and reviewed expectation profiles. Separate schedule-v25 from payments-v25. Derive counts and pending prefixes from the chosen immutable migration inventory.
- Shared object declarations describe required signatures, return shapes, owner/ACL/search-path/volatility rules, required columns, indexes/constraints/FKs, and ordered manifest inputs. Use named shared checks with small state deltas. Distinguish body hashes, installed-definition hashes, catalog hashes and complete source-file hashes.
- Pins are reviewed expected facts with provenance. The generator never accepts target observations as their own expected answer. Keep independent raw catalog/semantic checks and complete canonical/restored tuples.
- Historical formatting profiles preserve actual whitespace, delimiters, messages and ordering. They may not hide complete per-release programs or compressed target copies. Historical dynamic DO authoring statements are reproduction inputs; future output contains complete SQL, without predecessor-body text rewriting.
- All 136 migration files, including V41, remain byte-identical. No old function, expectation, financial row or history file is rewritten by adopting the generator.

## Implementation sequence

1. Inventory generated attestation spans and all ten restore cases against a pinned source commit. Identify real shared templates/check groups and explicit exceptional fixtures. Record coverage honestly, including older immutable definitions that remain inputs rather than generated claims.
2. Implement declared states and deterministic emitters. Render to a temporary directory, with targets unavailable as inputs. Compare generated spans and whole restore scripts against the original bytes and executable modes. The comparison tool may read expected artifacts; rendering may not.
3. Use the same declared state to derive current/history tuple data. Correct the nine demonstrated historical pending-list constants in tooling with explicit tests; do not pretend that intentional bug correction is byte-identical or authorize old unsupported apply states.
4. Replace the local verifier's V31 PASS-line awk splice with a generated, explicit V31-through-V37 continuation. Preserve a focused V31 case and run the business fixtures once in the aggregate. Keep actual V26 dump ancestry and canonical/restored separation. Adopt an altered runner only after equivalent assertions, lifecycle and failures are proved.
5. Wire offline generation checking into existing candidate verification. Document the actual authoring command and update the ledger based on delivered scope. Do not mark adjacent runtime batching or provider evidence defects fixed by inference.

## Historical proof

The ten committed restore scripts total 2,855 lines. V30-to-V31 has 1,353 lines including 299- and 658-line SQL fixture blocks. Keep those domain assertions explicit. V39/V40/V41 also contain different continuation behavior, not interchangeable templates.

For each covered migration span, render the complete statement and compare bytes. Reassemble a temporary full migration with untouched non-generated sections to confirm the file comparison, but report only actual generated spans as generated coverage. Hash every historical migration before/after to prove no mutation.

For historical dynamic authoring, compare committed DO statements and installed definitions at the selected historical states on disposable PostgreSQL 17. Check complete function contracts, ACLs and existing raw/semantic readiness. A final V41-only replay does not establish overwritten predecessor definitions.

Generate all ten historical script outputs and compare complete bytes, modes and trailing newlines. Any runner replacement requires a second behavioral equivalence proof; matching a new wrapper's output label is insufficient. Preserve owned-database cleanup, predecessor refusal, negative drift checks, retained rows and continuation results. Record helper/source hash changes honestly; dump or evidence JSON bytes are not expected to be identical across executions.

## Safety and test reduction

Preserve complete object inventories so extra overloads/grants/columns/FKs cannot disappear. V41's payer writer is VOLATILE and uses separate raw evidence; the existing billing-read manifest assumes STABLE. Preserve exact normalization pairs and fail before repairing unknown drift. Do not broaden canonical/restored accepted facts into an arbitrary mix.

Keep provider mappings, inspection tokens, exact candidate identity, approvals and human production apply in the existing rollout tool. No auto-accepting hashes, provider calls, production SQL, deployment or historical data backfill.

Consolidate repeated readiness/expectation test plumbing into independently expected state cases. Retain malformed/extra-field/wrong-order/hybrid/ACL negatives and real business/concurrency tests. Remove the source-text continuation dependency and repeated V31 execution. Do not add a test for every emitter line.

Targeted checks: generator offline byte/equivalence checks; existing rollout and contract-inventory Node tests; backend readiness/restore-guard tests. Then the complete local 136-migration/51-contract suite with historical restores, negatives and concurrency, followed by exact-head candidate CI and fresh independent PR review. Use KOARYU_PG_BIN_DIR=/usr/local/opt/postgresql@17/bin locally. No generated result is release evidence until its required checks pass.
