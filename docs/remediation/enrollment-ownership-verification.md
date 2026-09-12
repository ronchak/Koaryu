# Enrollment ownership and final billing facade removal

Base: `df2ccedab3833e4306025c4eac20846496de97fe`. Implementation: `20fb542acf697029c6b8f13862943cabd206473e`.

Enrollment records now own the existing database queries, quantity selectors and locks. Activation and transitions remain distinct workflows with concrete records/account/projection dependencies. The misleading Stripe lifecycle class, dynamic fallback, manager forwarding and private BillingService facade are removed. One operator payer lookup uses the existing payer function; every other operator statement is unchanged and the operator was not executed.

The final graph sweep found a payment-to-landing import that returned to BillingService. Moving the unchanged month-boundary function to payment reporting removes that cycle. The billing components now have no opaque owner/service arguments or fields, whole-service constructor injection, dynamic owner fallback, or import cycle through BillingService. Higher-level API, webhook and landing consumers still use its public interface.

## Change and assurance

Affected runtime source, including the operator caller, changes from 8,760 to 8,663 lines, losing 3,627 bytes and 26 function/method definitions. The ten test/fixture files retain 223 test definitions and 251 collected cases. They change from 12,484 to 12,525 lines and lose eleven helper definitions. All original assertions remain after equivalent fee/consent helper-call substitutions; five new checks confirm actual projection failure evidence and no onboarding audit write. Cases do not increase.

Fixtures use real record, account, consent and subscription projection behavior. The empty transition fixture subclass is deleted. Failure and balance observations use existing storage/RPC hooks. Projection observations are asserted outside application catch paths; a coordinator mutation check removed those observations and confirmed both tests fail. Reservation-race hooks, rejection recovery, provider fault injection and scheduled-transition reload coverage remain intact.

Coordinator comparisons matched 21 activation methods, 58 transition methods, 12 retained manager methods, five record implementations, two scoped queries, provider-item extraction, all 52 existing service methods and the remaining webhook bodies after explicit dependency substitutions. The complete operator module matches except the one verified lookup substitution. The period helper is AST-identical and its former/current owning modules otherwise retain their behavior. Constructors, dispatch and fixture changes were reviewed directly.

The coordinator's final affected run passed 341 tests, including enrollment, lifecycle, operator, reload, landing and payment coverage. The implementer passed the full 1,904-test backend before the final unchanged-body/helper and test-only cleanup, then passed the relevant suites again. Formatter, API types and release-workflow checks passed; the workflow check ran 128 cases. Fresh independent exact-head review and CI remain required before guarded merge.

## Program-wide architecture result

Relative to the formatted baseline `d6bab29209d2ee4650b8f01e0ece474ff519f422`, billing service modules change 29 → 27, source lines 20,760 → 20,085 and bytes 834,268 → 806,569. The sixteen classes reaching through an opaque owner/service become zero. The four opaque workflow owners become zero. All 71 original facade methods and the facade file are gone, with necessary implementations moved to real owners or existing functions.

This closes BB1-09's ownership/forwarding defect. Billing remains substantial; this does not resolve every financial or test observation. ACS1-07's public transition contract, PROGRAM-REFUND-01, PROGRAM-ACTIVATION-01, mixed-currency/overdue definitions and other database-dependent risks remain separately pending. No SQL/migration change, new durable state, provider action, deployment, billing activation or financial backfill occurred.
