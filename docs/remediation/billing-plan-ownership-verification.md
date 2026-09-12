# Billing plan ownership verification

Base: `d6bab29209d2ee4650b8f01e0ece474ff519f422`. Implementation: `f6a5a167b6e25c4a86042be7e608f186ebeddeec`.

Local plan operations and durable Stripe sync now share one concrete `BillingPlanManager`. It receives the database client, the existing Connect account store and Stripe factory. It has no reference to BillingService or an opaque owner. BillingService keeps its public plan entry points and passes those dependencies explicitly.

The separate sync workflow/module, its constructor and response wrapper, the manager's private forwarding routes, and three unused facade aliases are removed. No replacement mixin, context object, callback bag, Protocol, dispatcher or compatibility shim is introduced. Existing provider step/retry logic remains in place inside the actual plan owner.

## What actually shrank

Across the four changed production files:

| Measure | Before | After |
| --- | ---: | ---: |
| Source lines | 3,041 | 3,006 |
| Source bytes | 116,145 | 114,477 |
| Classes | 5 | 4 |
| Method/function definitions | 174 | 164 |
| Plan owner back-reference fields | 2 | 0 |

The net production reduction is 35 lines and 1,668 bytes. Thirty-six workflow methods moved, about 1,472 lines by method spans. That relocation is not counted as deletion. The value is removal of the plan dependency cycle and ten definitions, not a claim of a large LOC reduction.

The two affected test files shrink from 3,936 to 3,888 lines, with the same 80 named methods and 105 collected cases. The fake owner no longer reimplements row lookup or idempotency forwarding; tests use the concrete manager and existing client/account fixtures. Four interval assertions now address the actual plan owner. Expected financial results, identity checks, recovery cases and parameter tables are retained. No tests or new fixture framework were added.

## Proof and boundaries

Root independently compared all 36 retained workflow methods after only the declared owner/dependency substitutions, with zero mismatches. Public plan method signatures are preserved, including the optional idempotency-key default. The direct plan query retains the original studio filter, query shape and 404 behavior. Archive audit uses the same insert and ordering. Eight retained local-operation methods also match under the declared substitutions in the implementer's comparison.

- Focused plan and invoice lifecycle suite: 105 passed in independent root and implementer runs.
- Full backend suite: 1,904 passed.
- Backend formatter: passed. Dependency consistency: passed.
- API type check: passed; generated contracts unchanged.
- Release workflow checks: 128 passed and controls complete.

A first test invocation used the wrong working directory and failed import collection; the documented backend-directory invocation passed. Optional all-rule Ruff cleanup was rejected; unrelated import reordering was removed. No financial algorithm or safety assertion was changed to satisfy tooling.

No schema, migration, SQL contract, provider, production deployment, new receipt mechanism or billing activation is part of this PR. It requires fresh independent review and exact-head candidate CI before guarded merge.

This is partial progress on BB1-09. The other billing owners and the private facade still exist. The overall architecture finding remains pending until those dependency routes are removed; this plan component is not presented as fixing the whole billing system.
