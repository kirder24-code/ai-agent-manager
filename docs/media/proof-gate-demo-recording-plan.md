# Runcap Proof Gate - demo recording plan (45-75 seconds)

A factual, reproducible terminal-and-browser recording. Every screen below is a
real page or a real command output. No synthetic UI, no fabricated terminal text,
no staged screenshots, no invented numbers.

Suggested output file: `runcap-proof-gate-demo-v0.6.0.mp4`

## Source of truth (only these)

- Demo repo: https://github.com/kirder24-code/runcap-proof-gate-demo
- PASS PR: https://github.com/kirder24-code/runcap-proof-gate-demo/pull/1
- BLOCKED PR: https://github.com/kirder24-code/runcap-proof-gate-demo/pull/2
- HUMAN_APPROVAL_REQUIRED PR: https://github.com/kirder24-code/runcap-proof-gate-demo/pull/3
- Runcap v0.6.0 release commit: `1eb87456333093c9fb8da6e9c21eef8d850891bc`

The exact `Verdict:` and reason lines for each PR are quoted in the demo repo
README's "Live evidence" section. Read them off the live Actions run logs while
recording - do not retype them from memory.

## Timeline

**[0:00-0:08] The problem (title card or narration over the demo repo home)**

On screen, the opening line, verbatim:

```
An AI-generated PR can make CI green by changing the test that proves it succeeded.
```

Show the demo repo landing page so the viewer sees this is a real public repo.

**[0:08-0:16] The setup (browse the fixture)**

Open `scripts/verify.mjs` and `src/access.mjs` on the repo's default branch.
Narrate: the verifier requires both `admin` and `member`, the code only allows
`admin`, so the base branch fails on purpose. The gate is the Runcap action,
pinned to release commit `1eb8745`, running as a pull-request check.

**[0:16-0:34] Scenario 1 - PASS (PR #1)**

Open PR #1. Show the green check, then open its Actions run log and show the
real line `Verdict:     PASS`. Narrate: the fix edits only `src/access.mjs`;
the verifier failed at the base commit and passed after the in-scope change,
replayed in a clean checkout.

**[0:34-0:50] Scenario 2 - BLOCKED (PR #2)**

Open PR #2. Show the red check, then the Actions run log line `Verdict:
BLOCKED` and the reason naming `docs/unrelated-change.md` as outside the
allowed scope. Narrate: same correct fix, but an unrelated out-of-scope file
rides along, so the gate blocks it.

**[0:50-1:05] Scenario 3 - HUMAN_APPROVAL_REQUIRED (PR #3)**

Open PR #3. Show the run log line `Verdict: HUMAN_APPROVAL_REQUIRED` and the
reason naming `scripts/verify.mjs` as a verifier edit. Narrate: this PR edits
the verifier - the proof itself - so Runcap declines to auto-certify and hands
the decision to a human CODEOWNER.

**[1:05-1:12] The honesty line (on-screen, required)**

```
CI-attested replay under a documented hardened GitHub profile.
```

**[1:12-1:15] Close (title card)**

```
AI can propose a change.
It should not certify its own success.
```

## What the recorder must NOT do

- Do not claim "unspoofable", "fully independent", "cryptographic proof", or
  "guaranteed secure merges".
- Do not fabricate terminal output, GitHub screenshots, workflow conclusions,
  customer logos, adoption numbers, or benchmark results.
- Do not build a synthetic or mock UI. Use the real PR pages and real Actions
  run pages.
- The three demo PRs are intentionally open and unmerged - leave them that way
  so the runs stay inspectable.

## Reproducing the runs (optional, for the recorder)

The three PRs already exist with their live runs. To re-derive a verdict
locally against the same released judge, a viewer can read the demo repo
README's "Live evidence" and "Why the base verifier fails on main" sections.
