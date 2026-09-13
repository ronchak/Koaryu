# Password recovery guidance verification

Base: `76ea4187df4d536122d3ce6c1bbb122e6bb2fc7a`. Implementation: `5639566907ea547c7e82371bc794a91c80bb914b`.

FR1-05 is fixed. The invalid-session page directs signed-out users to the existing magic-link sign-in option, then to Account Settings for another password reset. The coordinator verified the actual login and settings labels. Only the explanatory paragraph changes; the /login link, recovery checks, password policy, session handling and email behavior remain unchanged.

The page remains 151 lines, with two lines replaced. No tests were added or changed for wording. Coordinator and implementer each passed the nine existing auth-route cases. Targeted lint, pinned formatting and the synthetic-environment build passed. Fresh independent exact-head review and CI remain required before guarded merge. No real authentication, email, provider or deployment action occurred.
