# Operator documentation verification

Base: `c40215d906e2639b79762d73e6e8e5fa79b929e5`. Implementation: `3c945c9992d706b8bd83d0f04aeb6d77bcd93dd2`.

Batch02 fixes DOC1-02, DOC1-03, DOC1-04, DOC1-06, DOC1-07, DOC1-11 and DOC1-12. Active instructions now have one guarded backup owner and one candidate-specific release authority. The production packet links to the current backup section and back. Its pinned candidate, migration hashes and unfulfilled evidence gates are unchanged.

The coordinator reviewed command arguments against their existing parsers, private operator guidance, local links and anchors. The schema-v4 generated template is byte-identical, SHA256 `e7c5d4f3c47b0c6c80f8b26e545feb071a990a62925ba32f61dbf8f6766b1094`. Reconciliation checkpoints remain schema3. July backup hashes and image-patch evidence remain dated history, while Storage bytes still require a separate backup. The private helper knows V37/V38 and does not attest a future post-V45 backup.

The twelve edited documents total 5,698 → 5,681 lines. Staging recovery 502→450; image patch 2,403→2,410; cutover gates 281→271; release controls 184→195; Render deployment 482→486; payments staging/rollback 274→269; operator tooling 308→310; services 264→266; live rollout 319→321; reconciliation 170→181; provider capture 250→256; production packet 261→266. Tracking files are excluded from these counts.

Repository-local release-workflow checks pass all 128 cases. No test or application code changed, and no wording tests were added. No provider command, backup, restore, credential operation, migration, deployment, authorization grant or report capture ran. Fresh independent review and exact-head CI remain required before guarded merge.
