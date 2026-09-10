# Dependency maintenance verification

Source commit: `715e322d9030dcb28527a27bd52ad38f517c88a9`, based on main `9785f13c77ebd1ffb55c31185a1ca5c055ab9e41`. A fresh Sol task implemented the bounded dependency batch; the coordinator inspected all changed lines and command evidence. This addresses PROGRAM-DEPENDENCIES-02 outside the original 278 findings.

The frontend lock changes js-yaml 4.3.1 to 4.3.2 and baseline-browser-mapping 2.10.44 to 2.11.21. They remain transitive dependencies. The development Python lock changes pip 26.1.2 to 26.2.1 and pip-tools 7.5.3 to 7.6.1. The development input records the compiler pin. Runtime Python inputs/lock and direct frontend versions are unchanged.

The initial pip-only update broke lock regeneration with a missing allow_editables argument. A run through the older canonical compiler did not prove the new environment. The coordinator reproduced that failure before accepting the corrected pair. [pip-tools 7.6.1](https://github.com/jazzband/pip-tools/releases/tag/v7.6.1) adds pip 26.2 compatibility.

## Evidence

- Clean npm installation and both online npm audits passed with zero reported vulnerabilities. Lint passed with the existing hard-navigation warning; the frontend passed 914 tests and its production build.
- The complete hashed development lock installed successfully. Pip check and development-lock pip-audit passed with no broken requirements or known vulnerabilities. The backend passed 1,897 tests.
- The updated worktree environment reports pip 26.2.1 and pip-compile 7.6.1. Two actual regenerations with the repository command produced identical lock SHA256 `52776944c532e1c30aa7402bcac543535caec2021860e07d4559f5d08d2aa081`. The coordinator separately reran the updated compiler's dry-run and pip check successfully.
- No tests were added to pin version strings. Existing behavioral checks and lock/audit verification supply the useful assurance.

No application architecture, migration, financial, authorization, tenant or provider configuration changed. No production operation occurred. Package audits cover known advisories at verification time. Fresh independent review and the exact-head candidate gate remain required before guarded merge.
