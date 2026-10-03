# Payer dependency ownership verification

Base: `0559911b4c6fd7c57095ffcfbff73a7c2bbb49ba`. Implementation: `0647c20dced74281383cd9a3eb07eb2867417614`.

Payer operations now receive the concrete database client, Connect account store, settings and Stripe factory. They retain no BillingService/opaque owner. Four existing payer helper methods, including the balance adapter, are now ordinary functions in their existing module; their behavior is unchanged. The facade uses them directly, eliminating manager construction for those calls and deleting `_billing_stripe_service_cls` and its reverse dynamic import.

The five public payer methods and the guarded operator's one manager construction pass current dependencies explicitly. The operator's faulting Stripe class, guards, flags, hash acceptance and I/O order are unchanged. The operator was not executed.

## Exact change and assurance

Runtime source, including the mandatory operator call-site update, gains 41 lines. The two edited test files lose 47 lines. Net authored change is six fewer lines; this is not advertised as a large code-volume reduction. The value is removal of an opaque component owner, copied fake-owner behavior and the reverse dependency. No new module, framework, generic context, provider operation, receipt or database state was added.

Payer tests now use a fixture holding only the fake client and actual manager. Settings changes target that manager directly, avoiding stale fixture configuration. Copied row, guardian, audit, idempotency and unused validation behavior is removed. Existing helpers moved rather than being reimplemented.

Independent coordinator proof:

- All 18 retained manager methods match the base after only declared dependency substitutions; public method signatures remain intact.
- All four relocated fact bodies match the original methods after explicit client/pure-helper substitution.
- Payer lookup, guardian lookup and audit insert match the original production definitions, including studio filters, error details and ordering.
- The complete operator module matches the base except its one checked constructor argument change.
- The two modified test files retain all 765 assertion nodes after the payer-lookup receiver substitution. The three focused suites retain 150 test definitions and 309 collected cases, including 28 unchanged operator tests.
- Independent coordinator and implementer focused runs passed all 309 cases on the final source.

The initial full backend run passed 1,904 tests before the final field-name/fixture cleanup. The final focused tests, structural comparison and formatter passed afterward. API-type and release-workflow checks passed on the initial equivalent implementation; the workflow check ran 128 cases. Fresh review and exact-head candidate CI are required on the actual final head before the guarded merge.

No production operation, provider call, migration, SQL contract/proof change, financial backfill or billing activation. BB1-09 remains pending while other billing components still use the shared-owner graph.
