# Batch 12: marketing scene contracts

IDs: `FC2-09`, `FC2-10`, `FC2-11`, `FC2-12`, `FT1-06`

Prerequisites: none. Keep approved renderer geometry, phase boundaries, content, timing, reduced motion, and accessibility. The test-only scene model must be deleted without a replacement phase model.

## Change

- In `frontend/src/components/marketing/journey/journey-scene.tsx`, memoize the IDs object derived from the stable React ID and precompute far-ridge path strings at module scope. IDs must remain unique between component instances and stable across rerenders.
- Confirm `sceneProgressModel` and `phaseProgress` in `frontend/src/components/marketing/journey/scene-model.ts` are test-only, then delete them and related exports. Keep renderer formulas and every renderer-consumed geometry/data export. Do not copy the renderer algorithm into tests or introduce a phase abstraction.
- Export the existing pure cloud path generator from `frontend/src/components/marketing/journey/scene-model.ts` and reuse it for `MOUNTAIN_WISPS` in `frontend/src/components/marketing/journey/journey-scene.tsx`. Do not merge distinct cloud collections or change seeds/output.
- Remove both ineffective hero props from `frontend/src/components/marketing/public-pages.tsx` and all callers. Delete declaration-presence assertions from `frontend/tests/marketing-public-pages.test.mjs`; retain rendered semantic, navigation, focus, target-size, and reduced-motion checks.
- In `frontend/tests/marketing-journey-scene.test.mjs`, remove shadow-model and source-expression tests. Mount the actual scene for representative progress states and inspect real SVG accessibility, instance IDs/references, layer presence, and deterministic geometry. Do not add a production API solely for testing.

- Apply the source-test cleanup inventory to `frontend/tests/marketing-foundation.test.mjs` and `frontend/tests/marketing-journey-composition.test.mjs` as these shared rendering components change. Keep existing navigation, focus, reduced-motion and history behavior; delete redundant composition/class-name scans. Reuse existing fixtures, not a new marketing test framework.

## Verify and deliver

```sh
rg -n "sceneProgressModel|phaseProgress|MOUNTAIN_WISPS" frontend/src frontend/tests
(cd frontend && node --experimental-strip-types --test tests/marketing-journey-scene.test.mjs tests/marketing-public-pages.test.mjs tests/marketing-journey-composition.test.mjs tests/marketing-journey-interaction.test.mjs tests/marketing-foundation.test.mjs)
(cd frontend && npm run lint -- src/components/marketing/journey/journey-scene.tsx src/components/marketing/journey/scene-model.ts src/components/marketing/public-pages.tsx tests/marketing-journey-scene.test.mjs tests/marketing-public-pages.test.mjs)
```

Compare fixed-seed cloud and ridge path strings before and after. Record before/after lines and removed/retained cases. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root coordinate integration. Require the exact-head `Release candidate gate` and guarded merge through `scripts/merge-release-pr.sh`.
