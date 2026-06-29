# Runcap Proof Gate demo - evidence manifest

This records exactly how the screen recording in `docs/assets/` was produced and
what it shows. It exists so a reviewer can confirm the video is real and not a
synthetic product UI.

## Source URLs captured

All pages are public and were captured logged-out (no account, no token, no
session). The capture browser showed the GitHub "Sign in / Sign up" header
throughout.

- Demo repo: https://github.com/kirder24-code/runcap-proof-gate-demo
- Demo repo "Live evidence" section: https://github.com/kirder24-code/runcap-proof-gate-demo#live-evidence
- Source fixture: https://github.com/kirder24-code/runcap-proof-gate-demo/blob/main/src/access.mjs
- Verifier fixture: https://github.com/kirder24-code/runcap-proof-gate-demo/blob/main/scripts/verify.mjs
- PR #1 (PASS): https://github.com/kirder24-code/runcap-proof-gate-demo/pull/1
- PR #2 (BLOCKED): https://github.com/kirder24-code/runcap-proof-gate-demo/pull/2
- PR #3 (HUMAN_APPROVAL_REQUIRED): https://github.com/kirder24-code/runcap-proof-gate-demo/pull/3
- Run #1: https://github.com/kirder24-code/runcap-proof-gate-demo/actions/runs/28336067039
- Run #2: https://github.com/kirder24-code/runcap-proof-gate-demo/actions/runs/28336110446
- Run #3: https://github.com/kirder24-code/runcap-proof-gate-demo/actions/runs/28336160932

Judge: the Runcap action pinned to the v0.6.0 release commit
`1eb87456333093c9fb8da6e9c21eef8d850891bc`.

## Expected verdicts (the three the video shows)

| PR | Change | Verdict | Run status |
| --- | --- | --- | --- |
| #1 | `src/access.mjs` only (allow member) | `PASS` | success |
| #2 | correct fix plus `docs/unrelated-change.md` | `BLOCKED` | failure |
| #3 | edits `scripts/verify.mjs` | `HUMAN_APPROVAL_REQUIRED` | success / neutral |

## What is shown, and an honest note on log visibility

Logged-out, GitHub hides the raw Actions step logs ("Sign in to view logs"), so
the literal `Verdict:` lines are not visible to an anonymous viewer on the run
pages themselves. The recording therefore shows two real public surfaces per
scenario:

1. the live Actions run page - the real GitHub-rendered **Status** (Success /
   Failure) and exit-code annotation; and
2. the demo repo's committed **"Live evidence"** section, which publicly renders
   the exact `Verdict: PASS` / `Verdict: BLOCKED` / `Verdict:
   HUMAN_APPROVAL_REQUIRED` lines and their reasons, transcribed from those same
   runs.

No step logs were reconstructed, retyped into a fake terminal, or invented. The
narration overlays are subtitles drawn on top of the real captured browser
screen.

## Capture method

- Tool: Playwright (Chromium) video recording at 1280x720, run from a temporary
  directory outside this repository. No Playwright, ffmpeg, or video dependency
  was added to `package.json`.
- The raw capture was a continuous browser navigation across the public pages
  above; it was then speed-adjusted and re-encoded with ffmpeg to land within the
  60-75 second target. It is therefore not a single real-time take.

Edited screen recording assembled from real public GitHub browser captures.
No synthetic product UI or invented terminal output was used.

## Artifacts

- Video: `docs/assets/runcap-proof-gate-demo-v0.6.0.mp4`
  - Duration: 70.0 seconds
  - Resolution: 1280x720, H.264 (yuv420p) MP4
  - Size: 1,889,139 bytes (~1.8 MB)
  - SHA-256: `1a7189e2479df40bb706b0fd96eaec15d1f749db330d451f4568624393181cd2`
- Poster: `docs/assets/runcap-proof-gate-demo-poster.png`
  - Captured from the real demo repo landing page (frame from the video)
  - Resolution: 1280x720
  - Size: 325,515 bytes (~0.32 MB)
  - SHA-256: `db513fa8fcdb812a2b32ca7d369010bf045e5bc1990d924f036d94982c20942f`

## What this does not claim

The video and this manifest do not claim the gate is "unspoofable", "fully
independent", a "cryptographic proof", or that it "guarantees safe merges". It is
a CI-attested replay under a documented hardened GitHub profile.
