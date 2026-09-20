# Google sign-in setup and verification

Google is the first option on login and signup. Both use Supabase's existing PKCE
session exchange and then `/dashboard`. Membership routing sends new users to
onboarding, existing members to their studio, and archived members to the archived
account page. No database migration is needed.

## Identity policy

Use Supabase automatic identity linking, with email confirmation enabled and
manual linking disabled. A verified Google identity with the same email attaches
to the existing auth UUID, preserving studio membership. Do not match studio
access using email or create an application-side account merge. A different Google
email is a different account; users must choose the address already used for Koaryu.
The account chooser is shown on each Google sign-in.

Supabase removes unconfirmed identities and clears an unconfirmed signup's old
password before confirming the OAuth identity. This prevents an attacker who
registered someone else's address from retaining password access. Hosted tests
must verify this behavior; source review alone is not release evidence.
See [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
and [Google provider setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

## Ordered console setup

1. In Google Cloud, use a dedicated Koaryu project. Configure the consent screen
   with application name `koaryu.app`, an owner-controlled support/contact email,
   homepage `https://koaryu.app`, privacy URL `https://koaryu.app/privacy`, and terms
   URL `https://koaryu.app/terms`. Request only `openid`, email and basic profile.
   Verify homepage ownership in Google Search Console using the public Google
   verification tag in `frontend/src/app/page.tsx`. Keep that tag after verification.
   Submit **Verify branding**, resolve Google's checks, and use **Publish branding**
   after approval. Publishing the OAuth audience alone does not publish a verified
   name: until branding is approved and published, Google can show the Supabase
   callback hostname in its account chooser.
2. Create an OAuth client of type **Web application**, named `Koaryu web`.
   Add exactly these authorized redirect URIs:
   - `https://mimguepumzsgmcaycdsh.supabase.co/auth/v1/callback`
   - `https://nxgsektqsgrtyfhawxbc.supabase.co/auth/v1/callback`
   The app uses a server OAuth redirect, so JavaScript origins are not required.
3. Save the client JSON outside the repository in owner-only private storage.
   Never put the client secret in Vercel or a `NEXT_PUBLIC_*` variable.
4. Enable the Google provider in staging Supabase `nxgsektqsgrtyfhawxbc` with
   that client ID and secret. Keep email confirmation on, manual linking off,
   nonce verification on, and the email-required check on.
5. Preserve staging site URL
   `https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app` and allow
   its exact `/auth/callback` URL. Do not broaden the redirect allowlist.
6. Deploy the reviewed candidate backend and then frontend to staging. Run the
   real-account checks below before any production release.
7. Make the Google audience available to external production users. A client left
   in Testing is restricted to its test users. Complete any Google-required domain
   or branding verification before claiming public availability.
8. Configure production Supabase `mimguepumzsgmcaycdsh` with the same provider
   settings. Preserve site URL `https://koaryu.app` and exact allowed redirect
   `https://koaryu.app/auth/callback`.
9. Explicitly set Vercel production `NEXT_PUBLIC_PREVIEW_MODE=false` and read it
   back. Build a production-target deployment from the reviewed Git SHA after
   backend readiness. Never promote a preview build.
10. Verify the frontend/backend pair serves one exact SHA, then test production
    Google sign-in and existing email sign-in without altering customer records.

## Required staging evidence

Use owner-authorized disposable test accounts and studios. Keep identities and
session material outside the repository. Record candidate SHA, date, outcome,
and before/after auth UUID and studio ID privately.

| Flow | Required proof |
| --- | --- |
| New Google user | Onboarding creates one studio; reload does not create another. |
| Returning Google user | Same UUID/studio, direct dashboard route, no new studio. |
| Existing confirmed email account | Google retains UUID and studio; original password still works. |
| Unconfirmed email signup | Google retains UUID; the old unconfirmed password no longer authenticates. |
| Denied consent | Fixed recovery message; email sign-in remains usable. |
| Invited front-desk account | Use a fresh invited Google email; same invited UUID, correct studio and role. |
| Existing auth | Password, magic link, signup confirmation and password recovery still work. |

The invitation service rejects invitations to already registered addresses. It binds
new invitations to the Auth UUID returned by Supabase. The email invitation callback
may have a pre-existing implicit-flow mismatch with the code-only server callback;
verify its actual behavior separately and report any defect without expanding this feature.

## Changes to existing behavior

- Login consumes allowlisted callback error codes, fixing the discarded recovery
  guidance described in FR1-04. Provider error text is never rendered.
- Callback maps denied consent to fixed feedback and retains every cookie update
  and the SSR library's no-cache headers, including on exchange failure.
- Password/email actions remain available beneath Google. The redirect guard,
  membership resolver, onboarding creation and account ownership are unchanged.

## Verification status

Branding follow-up: the owner requested the account chooser label `koaryu.app`.
The OAuth draft display name has been changed to that exact value and submitted
for verification. Homepage ownership proof and an explicit Google sign-in privacy
disclosure are being released to meet Google's checks. This is not yet a claim
that Google has approved or published the name; verify the actual account chooser
after publishing the approved branding.

September 20, 2026: PR #229 merged. Reviewed application candidate
`75d96cfab54440df58df85a843dd7f54d298cb2c` passed the exact-head Release
candidate gate and independent review. The full frontend suite passed 912 tests;
production build and lint passed. Both production and staging frontend/backend
pairs now serve that candidate. Production Render deployment
`dep-dao67h2jnfac73aoa670` passed both readiness paths with Stripe live mode.
Production-target Vercel deployment `dpl_2ZFeFBLovTX9wbpXSBVKJWwXfU89` is READY
in `pdx1` and owns `koaryu.app` and `www.koaryu.app`. Production auto-deploy remains
off; no migration was applied. Real Google sign-in from both `koaryu.app/login` and `koaryu.app/signup` reached
`/dashboard`; provider readback confirmed the pre-existing production account UUID,
studio membership, and role were unchanged.

Google Cloud project `koaryu-auth-20260920` has a Web application client with both
exact Supabase callbacks, basic identity scopes, and an external audience published
as **In production**. Both Supabase projects have Google enabled. Email confirmation
is required, Google email is required, nonce checks are enabled, and manual linking
is disabled. Existing redirect allowlists remain unchanged. Vercel production
`NEXT_PUBLIC_PREVIEW_MODE=false` was explicitly saved and read back.

The staging tests used a real Google account that had no pre-existing staging user.
Fixtures were prepared through supported Supabase identity APIs. During preparation
only, staging manual linking was briefly enabled to unlink the test identity, then
restored to false and read back before Google transitions. No production identity
fixture was created. No schema changed, no paid entitlement was fabricated, and
no Stripe checkout or charge was performed.

| Flow | Observed result |
| --- | --- |
| New Google user | Real consent led to onboarding. One studio was created, legal-name setup completed, and the normal subscription setup screen appeared. |
| Returning Google user | Same auth UUID and one original studio; no duplicate onboarding or studio. |
| Confirmed email linking | Prepared a confirmed email-only identity while retaining its UUID/studio, then signed in with Google. Both UUID and studio remained identical. Original password worked through Auth and the actual login page. |
| Unconfirmed email | A fresh unconfirmed password account retained its UUID after real Google sign-in. Its old password was rejected with `invalid_credentials`. |
| Denied consent | Canceling the real Google consent screen returned to a usable login page with recovery guidance. The reviewed wording also covers expired email links. |
| Invited front desk | The actual StaffService sent a fresh invitation and bound its returned Auth UUID. Google retained that UUID and selected the exact invited studio with `front_desk` role. |

The invitation fixture invoked the real service after verifying its fixture admin,
without fabricating a subscription entitlement. The resulting front-desk session
correctly showed restricted workspace access because the disposable studio was
unsubscribed. This proves membership routing; it is not a claim that the paid-studio
invitation UI or subscription checkout was exercised.

Local tests covered password/magic-link form fallback, signup rendering, fixed error
messages, code exchange, password-recovery destinations, all callback cookie updates,
and SSR cache headers. All twelve hostile redirect inputs were rejected. Real email
magic-link delivery, signup email confirmation, and password-reset email delivery
were not rerun. The emailed invitation-link path was not claimed as verified; the
Google acceptance path was.

Private account IDs, fixture credentials, provider readbacks, and event evidence are
stored outside the repository in the Home Server operator's `google-sso-release`
directory. The original test studio is retained for inspection. An attempted direct
cleanup was refused by the database; no cleanup guard was bypassed. The empty,
zero-membership unconfirmed-account fixture was removed through the Auth admin API.
