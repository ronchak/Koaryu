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
   with application name `Koaryu`, an owner-controlled support/contact email,
   homepage `https://koaryu.app`, privacy URL `https://koaryu.app/privacy`, and terms
   URL `https://koaryu.app/terms`. Request only `openid`, email and basic profile.
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

Local mounted tests exercise both real page components with synthetic auth I/O,
callback messages, Google options, loading state and email fallback. Route tests
exercise PKCE exchange, recovery destinations, cookie accumulation and cache headers.
All twelve hostile redirect inputs remain rejected. These do not prove Google
provider behavior or hosted identity linking. Hosted results must be recorded before
production release; no hosted Google flow has been claimed yet.
