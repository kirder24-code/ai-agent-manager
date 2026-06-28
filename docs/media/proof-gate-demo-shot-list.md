# Runcap Proof Gate - demo shot list

Each shot is a real page. No synthetic UI. Capture verdict lines by reading the
live Actions run log, not by retyping.

| # | Duration | Screen / URL | What must be visible |
| --- | --- | --- | --- |
| 1 | 0:00-0:08 | Title card over https://github.com/kirder24-code/runcap-proof-gate-demo | Opening line: "An AI-generated PR can make CI green by changing the test that proves it succeeded." Real repo landing page behind it. |
| 2 | 0:08-0:13 | https://github.com/kirder24-code/runcap-proof-gate-demo/blob/main/scripts/verify.mjs | Verifier asserts both `admin` and `member` have access. |
| 3 | 0:13-0:16 | https://github.com/kirder24-code/runcap-proof-gate-demo/blob/main/src/access.mjs | `canAccess` returns true only for `admin` (so base fails). |
| 4 | 0:16-0:20 | https://github.com/kirder24-code/runcap-proof-gate-demo/blob/main/.github/workflows/runcap-adjudicate.yml | Runcap action pinned to commit `1eb87456333093c9fb8da6e9c21eef8d850891bc`; `on: pull_request`; `permissions: contents: read`. |
| 5 | 0:20-0:34 | https://github.com/kirder24-code/runcap-proof-gate-demo/pull/1 then its run https://github.com/kirder24-code/runcap-proof-gate-demo/actions/runs/28336067039 | Green check on PR #1; run log line `Verdict:     PASS` and the "failed at base and passed after ... in-scope text change(s), recomputed in a clean base checkout" reason. |
| 6 | 0:34-0:50 | https://github.com/kirder24-code/runcap-proof-gate-demo/pull/2 then its run https://github.com/kirder24-code/runcap-proof-gate-demo/actions/runs/28336110446 | Red check on PR #2; run log line `Verdict:     BLOCKED` and "docs/unrelated-change.md: outside the policy's allowed scope". |
| 7 | 0:50-1:05 | https://github.com/kirder24-code/runcap-proof-gate-demo/pull/3 then its run https://github.com/kirder24-code/runcap-proof-gate-demo/actions/runs/28336160932 | PR #3; run log line `Verdict: HUMAN_APPROVAL_REQUIRED` and "scripts/verify.mjs: edits a verifier file (the evidence) - human CODEOWNER must approve". |
| 8 | 1:05-1:12 | On-screen honesty line | "CI-attested replay under a documented hardened GitHub profile." |
| 9 | 1:12-1:15 | Closing title card | "AI can propose a change." / "It should not certify its own success." |

## Notes for the recorder

- Show the Actions tab and each PR's checks live. Do not fabricate screenshots or
  workflow conclusions.
- The exact `Verdict:` and reason lines are also quoted in the demo repo README's
  "Live evidence" section - cross-check against the live run, do not paraphrase.
- The three PRs are intentionally open and unmerged. Do not merge them while
  recording.
- Do not claim "unspoofable", "fully independent", "cryptographic proof", or
  "guaranteed secure merges".
- Output file: `runcap-proof-gate-demo-v0.6.0.mp4`.
