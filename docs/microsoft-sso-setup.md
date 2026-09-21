# Microsoft sign-in setup and verification

Microsoft appears below Google and above email on login and signup. It uses the
existing Supabase PKCE callback, redirect allowlist, and membership routing. No
application-side email merge or database migration is required.

## Application ownership and audience

Register `koaryu.app` in an owner-controlled Microsoft Entra directory. Do not
register it in a university, employer, or customer directory merely because the
browser is signed in there. Record the actual directory and app identifiers in the
services inventory after registration.

Choose **Accounts in any organizational directory and personal Microsoft accounts**
for supported account types, represented by `AzureADandPersonalMicrosoftAccount`.
Use the common tenant endpoint `https://login.microsoftonline.com/common` in
Supabase. This supports personal and work or school accounts. Organization policies
may still require administrator approval; do not disable those policies.

## Ordered setup

1. Create a Web app registration named `koaryu.app` in the owner-controlled tenant.
2. Register both exact Web redirect URIs:
   - `https://mimguepumzsgmcaycdsh.supabase.co/auth/v1/callback`
   - `https://nxgsektqsgrtyfhawxbc.supabase.co/auth/v1/callback`
3. Configure application branding with homepage `https://koaryu.app`, privacy URL
   `https://koaryu.app/privacy`, and terms URL `https://koaryu.app/terms`. Configure
   and verify the publisher domain using Microsoft's provided verification process.
   A verified publisher domain and the Microsoft verified-publisher badge are
   separate checks. Report the actual consent screen, not an assumed badge.
4. Keep Microsoft-issued access tokens at version 2 for the mixed audience.
5. Configure optional `email` and `xms_edov` claims on ID tokens and `xms_edov` on
   access tokens, following the Supabase Microsoft provider guide. Do not enable
   `authenticationBehaviors.removeUnverifiedEmailClaim=false` or otherwise allow
   unverified email domains. Capture the final manifest without secrets.
6. Create a client secret. Save its **value**, application client ID, owning tenant,
   and expiry in owner-only operator storage outside the repository. Record expiry
   and the rotation procedure before release. The secret belongs only in Supabase,
   never in a public frontend environment variable.
7. Enable Supabase's Azure provider on staging with the client ID, secret, and
   common tenant URL. Preserve existing site URLs, callback allowlists, Google
   configuration, email confirmation, and disabled manual linking.
8. Deploy the reviewed candidate to staging, backend first and frontend last, then
   run the real-account verification below.
9. After those checks pass, configure production's provider identically and follow
   the normal guarded merge, production deployment, and exact-SHA checks.
10. Verify both production entry points and the displayed Microsoft consent branding.

## Email and account safety

The app requests only the `email profile` scopes, with `openid` supplied by Supabase and uses the account chooser. It requests no
mail, file, calendar, or offline access. Both buttons share a submission lock so
concurrent provider requests cannot replace each other's PKCE verifier. Successful
OAuth initiation stays locked until navigation; returning via the browser's page
cache resets the controls. Existing Google options and the callback are preserved.

Supabase owns identity linking. Microsoft can return email claims with different
verification semantics from Google. The `xms_edov` claim allows Supabase to identify
verified email domains; requesting `email` alone does not provide that proof.
The current Supabase provider falls back to treating an email as verified when
`xms_edov` is absent. Therefore, verify the configured optional claims and actual
Microsoft claim/identity behavior for both account types before release; do not
describe missing verification claims as failing closed.
Never grant studio access based on `preferred_username`, `upn`, or client-supplied
email. Membership remains bound to the Supabase user UUID.

Reference: [Supabase Microsoft provider](https://supabase.com/docs/guides/auth/social-login/auth-azure)
and [Microsoft optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).

## Required hosted verification

Record the exact candidate, account type, expected auth UUID/studio/role, observed
result, and time in private operator evidence. Use authorized disposable staging
fixtures. Never describe a mocked SDK test as a real Microsoft login.

| Flow | Required evidence |
| --- | --- |
| Personal Microsoft account | Successful OAuth and expected onboarding or existing membership route. |
| Work or school account | Successful OAuth, or clearly recorded tenant-admin restriction without bypass. |
| New account | One auth user and one studio after onboarding/retry. |
| Returning account | Same UUID and studio, no duplicate onboarding. |
| Existing confirmed email or Google account | Matching verified Microsoft email preserves UUID and studio; original login still works. |
| Unconfirmed email | Microsoft authentication must not preserve an attacker's unconfirmed password access. |
| Invited front desk | Microsoft retains the invited UUID, correct studio and role. |
| Denied consent | Fixed recovery guidance; Google/email remain usable. |
| Existing providers | Google, password and magic-link entry points remain usable. |
| Branding | Microsoft shows `koaryu.app`; record any publisher badge or admin-consent limitations. |

## Secret rotation

Before expiry, create a second secret in the same Entra application, privately
store the new value and expiry, update staging and verify real login, then update
production and verify login. Retain the old secret until both environments are
verified with the replacement, then remove only that old credential. Do not rotate
application IDs or create a replacement app to renew a secret.

## Current status

Implementation passes the local frontend suite, 915 tests, plus build and lint.
These are synthetic auth tests, not hosted Microsoft verification. Both Supabase projects had
Microsoft disabled and no configured client at the initial readback. The available
browser session belongs to external university/employer directories; application
ownership must be established in an owner-controlled directory before registration.
The owner authorized creating `koaryu@outlook.com` if no suitable saved personal
account is available; creation and Entra tenant setup remain pending.
No Microsoft provider has been enabled, no Microsoft hosted flow is claimed as
verified, and production remains on the working Google release.
