# Marketing scene cleanup verification

Source commit: `309df2bc5ea14b348fb2e128525c159525d0efba`, based on main `0f8685347d19579c6784b804bc420a777afabadc`. Implemented by a fresh GPT-5.6 Sol task from batch12; the coordinator reviewed every source/test diff and requested one bounded correction. No earlier audit/reviewer context was passed to the worker.

The renderer keeps one ID object per React ID and precomputes static far-ridge paths. One cloud-path implementation serves the two existing collections with unchanged seeds. The unused phase model, test-only chapter-stop export and ineffective hero props are removed. FC2-09/10/11/12 and FT1-06 are addressed.

## Evidence

- The 37 targeted marketing tests passed. Narrow ESLint, TypeScript no-emit checking and diff whitespace checks passed.
- The coordinator independently loaded the base and candidate scene/model implementations and compared complete server-rendered SVG bytes for 22 combinations of landscape/portrait dimensions and progress, including out-of-range and NaN inputs. Every output matched. Aggregate comparison digest: `982d8841e187bcce25fdb5a66182947c461e9de831957a0d89d7240ece97b9b1`.
- The four touched test files changed from 886 to 560 lines, with 79 additions and 405 deletions. Cases changed from 31 to 24: three actual rendered-scene cases replace ten obsolete or incidental cases. Finite coordinate/output checks remain. Existing keyboard, FAQ, focus, reduced-motion and history tests remain.
- Caller searches establish the removed phase/stop exports and hero props had no remaining consumers. The actual controller and chapter content stay authoritative.

The comparison proves unchanged synthetic rendered SVG, not animation performance or measured browser layout. No hosted e2e, backend, SQL, auth, money, provider or production operation was part of this change. Full candidate CI and one fresh independent reviewer must pass on the actual final head before the guarded merge. Broader source-test cleanup remains open.

PR165 merged as `9785f13c77ebd1ffb55c31185a1ca5c055ab9e41`. Fresh independent review gave GREEN LIGHT on `7d868bb8cf5f3bfbdaf55c5fbd43f0b86319569b`; automated review completed without findings. The full frontend suite passed 914 tests, and release run 34440341413 passed every check. The guarded merge verified production auto-deploy off twice. No production deployment occurred.
