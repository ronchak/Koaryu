# Payment and reconciliation ownership verification

Base: `9d99ad53cddcbd03989671ff408e1ac30e47e9e0`. Implementation: `32f686bd6b4f3ce416deeb48d4a8184090ba43eb`.

Payment commands and reconciliation use concrete client, account, action and projector dependencies. Payment projection exposes its actual component methods; ten webhook forwarding/dead methods and eight facade methods are removed. The status reporter's loader targets the concrete Connect action. No component in this change calls back into BillingService.

## Reduction and tests

The six production files change from 4,563 to 4,481 lines, losing 2,890 bytes and 22 function/method definitions, from 167 to 145. Two opaque owner references are removed. The eight remaining facade methods belong to enrollment callers.

The six edited test files change from 10,533 to 10,598 lines, retaining 180 test definitions/cases. Seven helper definitions and copied account, row, audit, refund and balance behavior are removed. Real projector construction and full RPC/failure traces add physical lines. Assertions change from 956 to 969. All original checks remain; one RPC trace assertion now includes the real balance call, with additional checks for ordering and valid failure states. The five other files' assertions are AST-identical. No source-text checks or new test cases were added.

Fixtures use the actual account store and refund projector. Balance observations come from the existing RPC acknowledgement mixin. Pending refunds come from the provider fixture's actual status. The projection failure records its real insert target and provider-call evidence, asserted outside application exception handling. A pending refund interrupted before completion creates the `projected` fixture state through the application, without manually changing receipt state or forging a resource fingerprint. Five obsolete service balance stubs are removed.

## Verification and limits

Coordinator comparison matched 16 retained payment algorithms, the studio-scoped query body, all 24 payment projector methods, 32 retained webhook methods, six reconciliation workflows, the moved conversion helper and the remaining facade methods. Existing public service signatures and command bodies match after declared dependency substitutions. Constructors, the reconciliation composition and status callback were reviewed directly, including provider-patch scope in the tests.

The coordinator's final eight-suite run passed 225 tests. The implementer passed all 1,904 backend tests before the final test-only corrections, then passed the affected suites again. Formatter, API types and release-workflow checks passed; the workflow check ran 128 cases. Fresh independent exact-head review and CI remain required before guarded merge.

The stricter fixture review exposed [PROGRAM-REFUND-01](refund-completion-risk.md), a succeeded refund whose own projection can block same-key completion recovery. It was reproduced on unchanged main and checked against SQL source. Its database correction is outside this run; no SQL was executed or changed and no database/concurrency proof is claimed. The valid pending-refund test does not close that risk.

No provider activity, deployment, new persisted state, migration, financial backfill or billing activation. BB1-09 remains pending until enrollment ownership and the remaining facade are resolved.
