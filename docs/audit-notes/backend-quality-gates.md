# Backend engineering quality gate

## Implemented gate

The required release-candidate workflow now runs a pinned Ruff check before the
existing backend tests and generated API-contract verification:

```sh
cd backend
venv/bin/python -m ruff check app tests scripts
```

Ruff is pinned in `requirements-dev.in` and the hash-pinned development lock.
`ruff.toml` targets Python 3.11 and enables only the following high-signal
safety rules:

- `E9`: runtime and syntax errors
- `F63`: invalid comparisons and assertions
- `F7`: invalid control flow and syntax
- `F82`: undefined and unbound names
- `F841`: unused local variables

The gate checks application code, tests, and backend operational scripts. It
does not scan generated files, use per-file suppressions, or introduce a
repository-wide formatting change.

## Report-only baseline

The candidates were measured on `main` at `a615bdf` before source or CI files
were changed:

| Candidate | Report-only result | Decision |
| --- | ---: | --- |
| Ruff formatter over `app`, `tests`, and `scripts` | 183 files would change; 34 were already formatted | Defer to a dedicated mechanical change |
| Ruff's broad default profile | 1,817 findings | Too much style and framework-pattern noise for an initial gate |
| mypy over 140 application modules | 159 errors in 42 files | Useful future ratchet, but not a clean repository-wide baseline |
| Branch-aware coverage over the full 678-test suite | 69% overall | Keep as planning evidence; a global floor at the observed value would be ceremonial |
| Selected Ruff safety profile | 7 findings | Adopt |

The selected profile found four undefined `Any` references in
`billing_service.py` and three dead assignments in the demo seeders. The
undefined annotations could fail runtime type-hint inspection, while the dead
assignments obscured which seed data is actually used. The implementation fixes
those findings and establishes a zero-finding baseline.

## Ratchet plan

Tightening should remain evidence-led and should not weaken the gate with
blanket ignores:

1. Keep the current safety rules at zero findings for every backend change.
2. Evaluate `F401` after intentional re-exports in billing test helpers and
   service facades are represented explicitly; add it only when the remaining
   findings are genuine unused imports.
3. Apply Ruff formatting in a dedicated no-behavior-change PR, then enable
   `ruff format --check` so formatting history does not bury functional review.
4. Introduce mypy one typed boundary at a time, starting with HTTP schemas and
   high-risk billing/auth interfaces. Each boundary should reach zero errors
   without module-wide `ignore_errors`.
5. Add coverage enforcement only around risk-bearing modules with meaningful
   behavioral tests. Do not set a global `fail-under` value merely to match the
   69% baseline.

The existing dependency audit, full pytest suite, API-contract check, Bandit,
CodeQL, and aggregate release-candidate result checks remain required.
