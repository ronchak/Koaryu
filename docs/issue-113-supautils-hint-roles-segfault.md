# Issue #113: what actually crashes the database

https://github.com/ronchak/Koaryu/issues/113

## Summary

Calling a function the current role lacks `EXECUTE` on kills the PostgreSQL
backend with SIGSEGV. The cause is `supautils`, not PostgreSQL and not our
schema. `supautils` is loaded through `session_preload_libraries`, and when
`supautils.hint_roles` is non-empty it rewrites permission-denied errors to
append a `GRANT` hint. It handles tables correctly. On functions it crashes.

Supabase fixed this between image `17.6.1.106` and `17.6.1.155`.

## Evidence

`scripts/repro-supautils-hint-roles-segfault.sh` builds a throwaway container,
creates one three-line SQL function, revokes `EXECUTE` from `anon`, and calls it.

| Image | `hint_roles` set | Denied table | Denied function |
|---|---|---|---|
| 17.6.1.105 (production) | yes | clean error | **SIGSEGV** |
| 17.6.1.105 | no | clean error | clean error |
| 17.6.1.106 (local dev) | yes | clean error | **SIGSEGV** |
| 17.6.1.106 | no | clean error | clean error |
| 17.6.1.155 (staging) | yes | clean error | clean error |
| 17.6.1.155 | no | clean error | clean error |

Two variables, and only their combination crashes. Loading `supautils` with
`hint_roles` empty is safe on every build. Setting `hint_roles` is safe on
`.155`. Setting it on `.105` or `.106` crashes the backend and restarts the
whole cluster.

## Corrections to the original report

The issue scoped the crash to functions that are `SECURITY INVOKER` and carry a
`proconfig`. That is wrong, and wrong in the unsafe direction. Every combination
crashes:

| Language | Security | `proconfig` | Result |
|---|---|---|---|
| plpgsql | INVOKER | yes | SIGSEGV |
| plpgsql | INVOKER | no | SIGSEGV |
| plpgsql | DEFINER | yes | SIGSEGV |
| sql | INVOKER | yes | SIGSEGV |
| sql | INVOKER | no | SIGSEGV |

The trigger is only this: the caller lacks `EXECUTE` on a function that exists.
Every one of our 77 `public` functions can trigger it, not the subset the issue
named. Controls that behave correctly:

- A role that **has** `EXECUTE` returns normally.
- A denied **table** raises a clean error, with the supautils hint attached.
- A **nonexistent** function raises a clean error.

The issue also treated the PostgreSQL version as the variable. It is not. A
clean `17.6.1.106` container with the same `shared_preload_libraries` raises a
clean error. I originally ruled `supautils` out by reading
`shared_preload_libraries`, where it does not appear. It is in
`session_preload_libraries`.

## Production exposure

Production runs `17.6.1.105`, which still carries the bug. Whether production is
actually exposed depends entirely on one setting, and reading it is a read-only
query that cannot crash anything:

```sql
SHOW supautils.hint_roles;
```

- Empty or unset: production is not exposed, and #113 is a local-dev and CI
  problem only.
- Non-empty: any caller who can reach PostgREST can crash the database by
  invoking a function they are not allowed to call. Treat it as a live incident.

`hint_roles` is a developer-experience feature that the CLI sets for local
stacks. There is reason to expect managed projects leave it unset, but that is
an expectation, not a measurement. Measure it.

## Fixing CI

`supautils.hint_roles` has `sighup` context, so a contract cannot clear it for
its own session. It has to change in server config followed by a reload. The
options, in order of preference:

1. Bump the pinned Supabase CLI so local and CI run an image at or past
   `.155`, where the bug is gone. This removes the problem instead of steering
   around it, and is the only option that also covers the other 35 contracts if
   they ever assert denial by invocation.
2. Clear `supautils.hint_roles` after `supabase db start` and reload, then
   restore the disabled check.

Option 1 is better. Option 2 is the fallback if the CLI bump drags in unrelated
breakage.
