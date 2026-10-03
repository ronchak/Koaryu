# Invoice command ownership verification

Base: `32b1ff3bc6ad36070e8164a5069a14b8008930c1`. Implementation: `be39dcc78bf7ebc190079c94c7390098e26a18c0`.

BillingInvoiceManager owns invoice creation, finalization, retry, void and reconciliation with a concrete client, account store, settings and projector. The separate owner-based workflow module/class is deleted. Existing payer consent eligibility has one implementation in the autopay module; projection has a named public entry. BillingService supplies current dependencies through one invoice factory.

## Reduction and preserved behavior

The affected production files change from 6,539 to 6,452 lines, losing 3,546 bytes and 15 net function/method definitions, from 217 to 202. The large diff moves 65 existing workflow methods; those algorithms are preserved. One module and one workflow class are removed, two more opaque owner back-references disappear, and the private facade falls from 18 to 16 methods. Invoice code remains substantial, but its command logic and helpers now belong to one concrete owner.

The three edited test files change from 7,434 to 7,392 lines. All 146 test definitions and 305 collected cases remain. The larger focused run includes 50 unchanged autopay cases, totaling 355. Assertions change from 853 to 855: two unreachable fake-customer-counter checks are removed and four external failure-point observations are added. All other assertions match after the moved class and equivalent fee-helper call substitutions.

The fixture loses copied row access, projection, audit, fee, date and consent logic. It uses the real account store, projector and active-consent lookup. Provider fixtures now retain their requested due date, collection method, payment method and fee. Payer-read faults target the same actual manager instance. The four projection faults record the table, persisted invoice/studio and provider state; tests assert that observation outside the application's exception handler. A coordinator mutation check removed those observations and confirmed that all four tests fail, so an assertion cannot be swallowed as the expected billing error.

## Verification

The coordinator matched all 65 moved workflow methods, eight retained manager algorithms, both relocated studio-scoped query bodies, all module-level workflow declarations, the consent eligibility body, all 42 projector methods and all 50 existing service methods after explicit dependency substitutions. Public invoice signatures, defaults and async/sync boundaries remain intact. The new constructors/factory and remaining facade calls were reviewed directly.

Coordinator and implementer focused runs each passed 355 tests on the final implementation. The full backend passed 1,904 tests before the final test-only failure-observation correction; focused coverage passed again afterward. Formatter, API types and release-workflow checks passed, including 128 workflow cases. Fresh independent exact-head review and CI remain required before guarded merge.

No migration, SQL change, new durable state, provider operation, deployment, billing activation or backfill. BB1-09 remains pending for payment, reconciliation and enrollment ownership. BB1-10's durable audit identity checks and the database-dependent overdue policy are unchanged and remain pending.
