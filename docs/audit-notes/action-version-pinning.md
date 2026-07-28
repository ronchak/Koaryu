# GitHub Actions dependency-pinning policy

Status: implemented on 2026-07-27 after inventorying every `uses:` reference in
`.github/workflows`.

## Policy decision

Every non-local action or reusable workflow must use a full 40-character commit
SHA. The reference must keep a same-line, human-readable release tag comment,
for example:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

Repository-local actions and reusable workflows beginning with `./` are allowed
because their code is already fixed by the Koaryu candidate SHA. Docker
`docker://` action references are not allowed until the repository has both an
immutable-digest rule and an automated update path for them.

Publisher trust changes review depth, not pin format. GitHub-maintained actions
are lower publisher risk than an unfamiliar third-party action, but a moving
GitHub tag still prevents an old Koaryu commit from identifying the exact action
code it ran. Applying one rule to the small action inventory is easier to review
and enforce than maintaining a risk-tier exception list.

This follows GitHub's guidance that a full-length commit SHA is the only
immutable action release reference. GitHub also documents that Dependabot can
update SHA-pinned repository actions and their same-line version comments:

- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [Dependabot support for GitHub Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#github-actions)

Full pins improve action-source reproducibility; they do not make a hosted
workflow completely hermetic. Runner images, operating-system packages, and
tools downloaded by an action may still change independently.

## Complete inventory

The two workflow files contain 15 `uses:` occurrences across six external
repositories. There are no local actions, external reusable workflows, or
Docker action references at the time of this inventory.

| Action entry point | Workflow jobs and count | Publisher | Permission and secret context | Immutable release |
| --- | --- | --- | --- | --- |
| `actions/checkout` | All five release-candidate worker jobs plus API contracts; 6 | GitHub (`actions`) | Receives the checkout token. Most jobs have `contents: read`; the static-analysis job also has `security-events: write`. | `3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`) |
| `actions/setup-node` | Repository controls and frontend; 2 | GitHub (`actions`) | `contents: read`; frontend also uses the GitHub Actions cache service. No explicit repository secret input. | `249970729cb0ef3589644e2896645e5dc5ba9c38` (`v6.5.0`) |
| `actions/setup-python` | Backend, static analysis, and API contracts; 3 | GitHub (`actions`) | Backend and API contracts have `contents: read`; static analysis also has `security-events: write`. Cache access is enabled, with no explicit repository secret input. | `ece7cb06caefa5fff74198d8649806c4678c61a1` (`v6.3.0`) |
| `supabase/setup-cli` | Database; 1 | Supabase | `contents: read`; no explicit secret input. It installs the separately fixed CLI version `2.95.4` for a disposable local database. | `ab058987d8d6c725971f6cf9d0b5c98467e30bd1` (`v1.7.1`) |
| `gitleaks/gitleaks-action` | Static analysis; 1 | Gitleaks | Runs in the `security-events: write` job and explicitly receives `GITHUB_TOKEN`; this is the highest direct secret-access action in the inventory. | `ff98106e4c7b2bc287b24eaf42907196329070c7` (`v2.3.9`) |
| `github/codeql-action/init` | Static analysis; 1 | GitHub (`github`) | Runs with `contents: read` and `security-events: write`; prepares repository analysis. | `e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81` (`v4.37.3`) |
| `github/codeql-action/analyze` | Static analysis; 1 | GitHub (`github`) | Runs with `contents: read` and `security-events: write`; uploads security results. | `e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81` (`v4.37.3`) |

No workflow trigger, permission, action input, runtime version, CLI version,
secret exposure, or job dependency changed as part of pinning these references.

## Resolution evidence

The moving major tags were resolved through each publisher repository's GitHub
REST tag reference on 2026-07-27, then matched to the most specific release tag
on that commit:

| Requested tag | Authoritative tag target | Matching release tag |
| --- | --- | --- |
| `actions/checkout@v7` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `v7.0.1` |
| `actions/setup-node@v6` | `249970729cb0ef3589644e2896645e5dc5ba9c38` | `v6.5.0` |
| `actions/setup-python@v6` | `ece7cb06caefa5fff74198d8649806c4678c61a1` | `v6.3.0` |
| `github/codeql-action@v4` | annotated tag object `adfda868f108ac4222129de456ea554034a27db7`, dereferenced to commit `e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81` | `v4.37.3` |
| Existing Supabase pin | `ab058987d8d6c725971f6cf9d0b5c98467e30bd1` | `v1.7.1` |
| Existing Gitleaks pin | `ff98106e4c7b2bc287b24eaf42907196329070c7` | `v2.3.9` |

For a future manual resolution, inspect the publisher-owned tag ref and
dereference annotated tags before using the commit:

```bash
gh api repos/OWNER/REPOSITORY/git/ref/tags/TAG
gh api repos/OWNER/REPOSITORY/git/tags/TAG_OBJECT_SHA
gh api --paginate repos/OWNER/REPOSITORY/tags
```

Match the resulting commit to a release tag. Do not copy a SHA from a fork,
unreviewed comment, or arbitrary branch head.

## Enforcement and maintenance

`scripts/check-action-pinning.mjs` scans every YAML file under
`.github/workflows`. It rejects floating remote references, shortened SHAs,
missing version comments, and Docker action references without the configured
maintenance path. Its unit tests and repository scan run inside
`npm run check:release-workflow`, which is already part of the unfiltered exact-
head release-candidate gate.

`.github/dependabot.yml` checks the `github-actions` ecosystem weekly. Updates
remain ordinary pull requests: there is no auto-merge or permission expansion.
For every action update:

1. Confirm the new SHA belongs to the same publisher repository and matches the
   version comment.
2. Review release notes and the action source diff, with extra scrutiny for
   publisher changes, major versions, token inputs, secret access, and jobs with
   write permissions.
3. Keep action updates separate from unrelated workflow behavior or permission
   changes.
4. Run `npm run check:release-workflow` and require the new exact PR head to pass
   the full `Release candidate gate`.

When introducing a new remote action, document it in this inventory and record
why its publisher, permissions, inputs, and secret exposure are acceptable.
