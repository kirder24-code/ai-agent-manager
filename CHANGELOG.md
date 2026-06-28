# Changelog

All notable changes to Runcap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-06-28

The release that turns Runcap from a single developer's terminal tool into a
CI-side merge gate. Runcap can now recompute the merge decision in a clean CI
job from the pull request's base commit, so an AI-generated PR has to earn
merge eligibility instead of asserting it.

### Added

- **`runcap ci --mode adjudicate`** - the CI-side judge a consumer repo makes a
  required PR check. It does not trust the agent or the agent's receipt; it
  recomputes the merge decision from the pull request's base commit.
- **Base-pinned policy and verifier** - the mission policy and the verification
  command (plus the files it names) are read from the base commit, never from
  the candidate PR, so a PR cannot relax its own rules.
- **Clean-room replay** - the base-pinned verifier is re-run in a throwaway git
  worktree: it must fail at base and pass after the change, or the verdict is
  not `PASS`.
- **Three verdicts** - `PASS` (exit 0), `BLOCKED` (exit 1), and
  `HUMAN_APPROVAL_REQUIRED` (exit 0) for changes that touch the policy, a
  workflow, a verifier file, a dependency manifest/lockfile, or a protected
  path.
- **Strict text-only diff application** - only allowed, in-scope, regular
  UTF-8 text edits (A/M) can earn a candidate `PASS`. Deletes, renames, copies,
  type changes, symlinks, submodules, mode changes, and binary diffs are not
  auto-approved.
- **Consumer GitHub Actions template** - `examples/runcap-adjudicate.yml`, a
  hardened reference workflow (`on: pull_request`, `permissions: contents:
  read`, `persist-credentials: false`, every action pinned by full commit SHA,
  capped runtime, no `needs:`). The judge comes only from the Runcap action
  pinned by a full 40-character commit SHA, never from PR-workspace code.

### Changed

- **The agent receipt is excluded from the required gate.** The adjudicator
  never reads the agent's self-reported receipt: it is neither graded nor
  displayed by the required check, so a forged `VERIFIED_STRONG` receipt has no
  effect on the verdict.
- Version bumped `0.5.0` -> `0.6.0` (new CI adjudication mode and a new public
  integration model).

### Known limits

The verdict is a CI-attested replay under a documented hardened GitHub profile.
It is not "unspoofable" and not "fully independent": its integrity rests on the
required GitHub setup being in place. It does not prove network isolation of the
agent or CI job, absence of source-code exfiltration, independent LLM
cost/budget accounting, safety against repository admins or merge-bypass actors,
or cryptographic attestation, and it does not support merge queues in v0.6.

See [docs/trust-model.md](docs/trust-model.md#ci-adjudication-v06) for the full
"what it proves / what it does not prove" breakdown and the required GitHub
setup.
