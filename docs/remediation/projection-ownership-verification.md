# Provider projection ownership verification

Base: `b219fd029f621baa2686485c84979e4c7f31b9c2`. Implementation: `811477c801e04d0b2b193fe7796a2ea4cf8a46a4`.

The webhook, payment and subscription projectors now receive the database client and existing Connect account store directly. They retain no BillingService reference. Account identity resolution belongs to the account store; payer lookup and facts use the existing payer module. Payment parsing stays in its actual projector. The public webhook entry keeps its signature and behavior on BillingService.

## Change and assurance

The seven production files shrink from 4,975 to 4,889 lines, removing 86 lines, 3,259 bytes and 21 net function/method definitions. Six existing bodies move to their actual owners, so those movements are not counted as deleted algorithms. The private facade falls from 32 to 24 methods. No new module, generic dependency object, workflow framework or persisted state is introduced.

The two edited test files go from 4,314 to 4,319 lines because direct constructors name their dependencies. They retain 93 test definitions, 106 collected cases and all 462 assertion nodes, unchanged. One unnecessary service fixture construction is removed. No source-text assertion, copied algorithm or test for a moved line is added. Billing test reductions across PR183 through this change remain net negative despite the five extra constructor lines here.

Coordinator verification:

- All 169 retained methods outside constructors/factories and the two replaced parsing forwarders match the base after only the declared dependency substitutions.
- The six relocated bodies match their original implementations. Account conflict rejection, payer studio filtering and error detail, payment parsing and public event dispatch are unchanged.
- Constructor/factory review confirms current client, account store and Stripe factory binding. Repository-wide callers are accounted for; no removed facade receiver remains.
- Fifteen direct account identity cases pass, including conflicting metadata, unknown account IDs and absent account IDs. These checks performed no database or provider I/O.
- The coordinator's six affected suites pass all 189 cases. The implementer's full backend run passes all 1,904 tests.

Backend format, generated API types and release-workflow checks pass. The workflow check ran 128 cases. Fresh independent review and exact-head CI remain required before guarded merge. No production operation, migration, SQL contract change, financial backfill or billing activation. BB1-09 remains pending because command managers and three workflow owners still depend on the remaining shared-owner graph.
