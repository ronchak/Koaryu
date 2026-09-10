# Backend maintenance

PR171 addresses OPS2-10, BT5-03, BT1-05, BT1-09, BT2-08, BT4-02, BT5-04 and BT5-08. Source commit `d76c90d` follows main `d9d2766`.

Repository and documented operator-entrypoint searches found no live callers of the removed guardian/membership table writers. The active import and membership RPC adapters, normalization/payload helpers and the response builder's schema-error helper remain. Their behavior is unchanged.

Lifecycle tests now import library/application names from their actual owners. Three narrow helpers own shared activation, transition and landing fixtures. Coordinator AST comparisons verified the moved fixture bodies; independent evaluation verified that the reformatted rehearsal fixture returns exactly the same values.

Six stale generic-operation cases became one three-operation matrix, a net reduction of five. The coordinator strengthened it to compare every field in the four seeded business tables, including enrollment metadata, while preserving provider-call prohibitions. Four retired-writer cases and one two-string pseudo-test also disappear. Recipe cases fall from 221 to 211; meaningful financial, tenant, authorization, atomic-write and provider-negative scenarios remain.

The 21 changed Python files fall from 14,502 to 14,470 lines, a net reduction of 32. Formatting dense nested rehearsal data into readable lines offsets much of the physical reduction; it adds no scenarios or assertions. Test count and retained contracts are reported separately from formatting volume.

Verification: the full backend suite passed 1,887 tests. After the final formatting and snapshot refinement, the complete 69 collector/validator and 50 autopay tests passed. The three enrollment suites passed independently with 56, 1 and 15 cases. Diff/compile checks passed. Exact-head CI verifies the final candidate; fresh independent review is required before merge.

No dependency, provider, migration, production or financial-behavior change is included. Outstanding import recovery remains OPS2-05 work; deleting obsolete writers does not resolve that live retry defect.
