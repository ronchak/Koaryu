# Billing private-facade pruning verification

Base: `91184e762f99be7e3ebb26d959701d365797e57b`. Implementation: `c63b6ba2413c3ca4f39f6ac2589c2a735b4df61c`.

Removed 35 private-facade methods and four enrollment-manager forwarding methods. The underlying financial implementations remain in their actual managers/projectors. No implementation moved, no replacement layer was added and no billing behavior changed.

The original facade inventory found six test-only aliases and 27 methods with no BillingService receiver callers. Further tracing found four unused enrollment forwarding methods; one kept two additional facade helpers reachable only through that dead chain. Repo-wide attribute, constructor, callback/string and dynamic-delegation checks established the removal set. Same-named methods on concrete owners were retained.

## Exact changes

| Scope | Before lines | After lines |
| --- | ---: | ---: |
| Private facade | 689 | 376 |
| Enrollment manager | 443 | 421 |
| Production total | 1,132 | 797 |
| Three affected lifecycle test files | 7,064 | 7,098 |

Production shrinks by 335 lines and 11,816 bytes. The 39 removed definitions occupy 287 lines including decorators; the rest is obsolete imports and separators. The facade now has 33 methods and the enrollment manager 29. Root independently confirmed that all 62 surviving method ASTs are identical to the base.

Tests retain all 121 cases and 712 assertion nodes, with the same parameter/decorator inputs. Forty calls now address the concrete owner. Local projectors are constructed inside the original provider-patch scopes; later unpatched replay phases construct fresh owners. No new fixture helper/framework or regression cases were added. The 34 additional lines make that setup explicit. Across this and PR183, the unique affected billing test files are 14 lines smaller than the formatter baseline; this PR alone does not claim a test-line reduction.

## Verification

- Targeted lifecycle suites: 121 passed in independent coordinator and implementer runs.
- Full backend after the complete production deletion: 1,904 passed.
- Final test-fixture readability correction: targeted 121 passed; assertions/cases unchanged.
- Formatter, API-type, release-workflow and diff checks passed. The workflow checker ran 128 cases.
- Root independently verified the exact removed method set and unchanged surviving method bodies, then reviewed every test receiver change and provider-patch scope.

No schema, migrations, SQL contracts, database proofs, provider operations, production deployment, historical backfill or billing activation. Fresh independent review and exact-head candidate CI remain mandatory before guarded merge.

BB1-09 stays pending. The dead routes are removed, but the live owner graph, remaining facade and reverse import still require structural work. Their remaining complexity is not relabeled as fixed.
