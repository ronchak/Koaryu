# Framework security correction

PR162's exact-head CI exposed a current dependency-audit failure in the unchanged
frontend lockfile. Tests, lint and build passed; the high/critical audit gate did
not. This independent correction must merge before the invoice branch is rebased
and receives fresh CI. No production deployment is included.

Update Next.js and eslint-config-next together to 16.3.3, the first fixed 16 release
for [Windows RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36)
and [AVIF image-optimization RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4).
Advance the existing Sharp override to 0.35.4 for its
[libheif fix](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
These are affected dependency versions, not evidence of exploitation or a claim
that Koaryu runs on Windows. Keep React, application APIs, routing, authorization,
tenant boundaries, provider manifests, audit thresholds and database files intact.
No major-version codemod is needed: the app already uses Next 16, and its Node/React
versions satisfy the patched package's published requirements.

Regenerate the lockfile with only the selected dependency changes and inspect its
actual package delta. Run a clean install, the unchanged production dependency
audit, frontend tests, lint and build. Verify ordinary image processing with the
installed Sharp binary. Reuse existing behavior tests; do not add source-text or
version-string tests. A fresh independent reviewer receives only this plan and the
diff. Exact-head release CI and the normal guarded merge remain mandatory.

Status: PR163 merged as 6901f715bd7edd1ea27a8a3d626f66757590f212 after final
commit review, all exact-head release checks, and guarded merge. The resolved versions are Next.js
and eslint-config-next 16.3.3, Sharp 0.35.4 and libheif 1.23.2. React 19.2.4 is unchanged.
The lockfile includes the matching platform binaries and required SWC helper;
npm also refreshes peer metadata, bundled optional WASM entries and the existing
fastq transitive patch. No direct dependency was added. A clean install and the
unchanged high-threshold audit pass, with one pre-existing moderate
baseline-browser-mapping advisory remaining. Native PNG resize/WebP processing
passes. The full frontend passed 921 tests (two fewer wording/metadata cases). Lint has
zero errors and one new warning on an unchanged hard-navigation callback; the
production build passes. Fresh independent source review approves the dependency
and test deltas. Final review bound 1fd893f; exact-head CI passed. The guarded merge read
production auto-deploy off twice. No production deployment was performed.

The invoice/V41 changes subsequently merged independently in PR162. This release
blocker is tracked as PROGRAM-SECURITY-01 outside the 278 imported audit
observations. Individual normalization verified CTA1-08 resolved indirectly by
the runtime/lint alignment; broader fixture duplication FT1-07 remains pending.

Verification caught two test-only issues. Removed the two Node-baseline tests that
match documentation/configuration wording and require npm's unstable lockfile
`type` field; the actual package remains an ES module and the existing suite imports
TypeScript application files directly. The new SWC helper resolves an ES module
through `module-sync`. The custom browser fixture packer now sends JavaScript with
line-start import/export declarations through its existing CommonJS transform.
Without this, the unchanged schedule case fails before application startup with a
browser syntax error; with it, that same case passes. No timeouts, workflow
assertions, product code, module stubs or dependencies were added to hide the error.
