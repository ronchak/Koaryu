# Dead interface verification

Revalidated base `bb7a0ae57e6d9947b5ed73fc2147d2cdc1211331`; implementation `b7a3f4c601e5bc9aa0f18e7adba9d519d464fb4b`. PR180 closes FT1-01, FT1-02, CTA2-02, FC1-11, FC1-12 and FC1-13. Its earlier draft checks are not approval of this rebased change.

Deleted the unused types, invoice forwarding wrapper, never-loaded export-history chain and obsolete live belt test. Display types now request only fields they consume instead of fabricating full records. Real Reports exports, payment recovery, capability checks, dates and pagination are unchanged. Repository-wide caller searches found no remaining application consumers of the deleted interfaces.

The coordinator reviewed the complete diff and verified the external-payment handler and all eight invoice caller props are byte-identical to base. Current formatted source was preserved through six rebase conflicts. No new framework, helper, dependencies, source assertions or tests were introduced. The database and generated contracts are unchanged.

Seventeen implementation files total 7,323→7,032 lines and 290,866→280,400 bytes. The four changed test/e2e files total 3,647→3,480 lines and 149,291→142,969 bytes. Deleted one obsolete Playwright case and two obsolete Node safety/copy cases. The full Node suite goes 909→907. One additional stale export-message assertion was removed from the unchanged operations case after the full suite exposed it. Every surrounding financial/capability/callback assertion remains; the retained Core UI static loopback guard protects the existing stateful test boundary.

Coordinator and implementer each passed 56 focused cases. Implementer also passed the final 907-case frontend suite, the 16-case operations file, targeted lint/format and the synthetic .env.example build. Two intermediate full runs failed only the stale deleted-panel copy assertion; the final run passed after its removal. No live test, provider, authentication flow, database command or deployment ran. Fresh independent review, exact-head CI and the guarded merge remain required.
