# Shared UI contracts

PR169 addresses FR1-12, FR1-14, FC2-15, FC2-16, FC3-06 and FC3-07. Source commit `b0f9c10fb3c8d9dcec20d3ced62a7e80c699a32b` follows main `8c96132`.

The three identical account role labels share one formatter. The two 404 entries and two legal pages share their existing presentation. Reports uses its existing presentation helpers and drops unused role metadata. The no-op overflow option disappears. Button's linked-child mode forwards advertised attributes and refs while preserving click order, disabled behavior and callback-ref cleanup. System theme follows the device when storage is unavailable.

The coordinator corrected changed click cancellation, lost React 19 ref cleanup and ignored wrapper tab order. Independent review then caught unnecessary ref detach/reattach on ordinary rerenders; stable input refs now keep one composed callback. Role authorization, sign-out, report permissions, schedule behavior, legal content and routing remain unchanged.

Verification: 40 focused tests pass, plus TypeScript, narrow lint and a production build with 62 static pages. Direct built-output checks cover legal paragraphs, notices, anchors, labels and six static routes' metadata. The mounted cases exercise Button composition and stable ref lifetime, real Privacy/Terms route rendering with working section links, and theme media changes with blocked storage. The earlier full frontend run passed 917 cases before final test consolidation; exact-head CI verifies the final tree.

Associated tests, including the new mounted file, shrink from 1,672 lines and 41 cases to 1,666 lines and 40 cases. Removed checks duplicated legal text, matched exact renderer/CSS/metadata spelling or prohibited already-retired source names. Duplicated public navigation assertions were consolidated into the existing navigation suite. Existing financial, authorization and schedule assertions remain. The small isolated UI loader stays local because existing loaders bind unrelated store or billing dependencies; wider fixture consolidation remains FT1-07 work.

Fresh independent review and the exact candidate gate are required before merge. No migration, backfill or production operation is included.

Review disposition: accepted the ref-lifecycle defect and the need for meaningful legal-rendering coverage. Declined restoring exact-source metadata/CSS assertions and duplicated full legal copy; the mounted legal contract, direct built-metadata inspection and existing route/model checks protect useful behavior with less maintenance.
