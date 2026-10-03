# Email Domain Authentication

Records that stop anyone from spoofing `@koaryu.app`. These are DNS changes at
Name.com, not code — nothing in this repository applies them.

## Why the strict policy is the right one today

`koaryu.app` sends no email from its own domain. Verified 2026-08-22:

- No `MX`, no `SPF`, no `DMARC`, and no `DKIM` at any common selector
- No TXT records of any kind at the apex
- No sending-provider verification records (Resend, SendGrid, Postmark, Mailgun)
- No email provider in `frontend/package.json` or `backend/requirements.txt`, and
  no SMTP configuration anywhere in the codebase

Signup confirmations and password resets go out through Supabase Auth's default
SMTP, which sends from Supabase's own domain (`mail.app.supabase.io`) and signs
with Supabase's DKIM key. That mail is unaffected by everything below.

A domain that sends nothing should say so. An external assessment suggested
`p=quarantine`; publish the stricter pair instead, because there is no
legitimate mail to put at risk and quarantine still lets spoofed mail reach a
spam folder where people find it.

## Records to add

| Host | Type | Value |
|---|---|---|
| `@` | TXT | `v=spf1 -all` |
| `_dmarc` | TXT | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; fo=1` |
| `*._domainkey` | TXT | `v=DKIM1; p=` |
| `@` | MX | `0 .` (priority 0, value a single dot) |

What each one does:

- **SPF `-all`** — no host on earth is authorized to send as `@koaryu.app`.
- **DMARC `p=reject`** — receivers should reject, not quarantine, anything
  claiming to be from the domain. `sp=reject` extends that to every subdomain,
  which closes the `billing@mail.koaryu.app` style of lookalike. Strict
  alignment (`adkim=s`, `aspf=s`) blocks relaxed-alignment tricks.
- **Wildcard null DKIM** — declares that no selector holds a valid signing key,
  so a forged signature cannot claim an unpublished selector.
- **Null MX (RFC 7505)** — the domain accepts no mail. Senders fail immediately
  instead of queueing for days, and it removes the backscatter surface.

### On DMARC aggregate reports

`rua=mailto:` is deliberately omitted. Adding it publishes a working inbox
address in a record anyone can query, and it needs an address that can absorb
daily XML from every receiver on the internet. Add it only with an address
chosen for that purpose:

```
v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; fo=1; rua=mailto:dmarc@example.invalid
```

## Before you ever send mail as @koaryu.app

**These records will reject 100% of it.** If Supabase Auth moves to custom SMTP
with a `@koaryu.app` sender, or a transactional provider is added, the records
above must be relaxed *first*, in this order:

1. Add the provider's DKIM records (usually CNAMEs at a named selector).
2. Replace the wildcard null DKIM with nothing, or narrow it to unused selectors.
3. Change SPF to authorize the provider, e.g. `v=spf1 include:provider.example -all`.
4. Drop the null MX if the domain now needs to receive mail (bounce handling).
5. Move DMARC to `p=none` while you confirm alignment in aggregate reports, then
   walk it back up to `p=reject`.

Skipping step 5 is how a launch day turns into silent delivery failure.

## Verifying

```bash
dig +short TXT koaryu.app
```

```bash
dig +short TXT _dmarc.koaryu.app
```

```bash
dig +short MX koaryu.app
```

Expect exactly `"v=spf1 -all"`, the DMARC string, and `0 .` respectively.
DNS propagation at Name.com is usually minutes; allow an hour before treating a
missing record as a mistake.
