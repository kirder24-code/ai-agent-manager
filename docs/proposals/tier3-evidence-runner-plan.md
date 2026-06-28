# Tier 3 - Independent Evidence Runner (PLAN ONLY, no code yet)

Date: 2026-06-28. Status: design for review on the `tier3-plan` branch / Draft PR.
NOT merged to main. Nothing in this file is implemented.

## The problem this fixes (grounded in the current code)

Today the trust chain has a hole that the marketing copy must not overstate:

- `runcap ci` (bin/runcap.mjs:312-339) reads an existing `receipt.json` and runs
  `evaluatePolicyVerdict(receipt, policy)`. It only re-derives the PASS/BLOCKED
  **logic** from the committed policy. It does **not** re-run any verification.
- The integrity FACTS it grades on - `receipt.verificationIntegrity.status`,
  `receipt.outcome`, `integrity.violations` (scope), `receipt.cost.*` - are all
  produced by `runOutcome` (mission-control.mjs:158) on the **agent's machine**.
- The clean-worktree replay (`verifyInCleanWorktree`, mission-control.mjs:497)
  DOES exist, but it runs in the agent environment, takes `baselineCommit` from a
  contract frozen in that same environment, and copies `changedFiles` out of the
  agent's own working tree. Every input is attacker-controllable if the attacker
  is the agent that owns the machine.

Net: an agent that controls its environment can write a `receipt.json` that says
`verificationIntegrity.status: "VERIFIED_STRONG"` / `outcome: "verified"`, and
`runcap ci` will faithfully grade it **PASS**. The verdict logic is trustworthy;
the evidence feeding it is not.

**Tier 3 goal:** the verdict and every integrity fact behind it are computed in
CI by **Job B re-running the verification itself** from inputs read at the PR's
**base SHA**, never from anything produced in the agent environment. After Tier 3
this sentence is literally true (today half true):

> The agent may write the change. It cannot control the environment that decides
> whether the change is merge-eligible.

---

## Trust assertions (the requirements, explicit and load-bearing)

This section is the contract the rest of the plan must satisfy. Each is testable.

1. **Everything from the agent environment is telemetry only.** Job B does not
   trust `evidence.json`, the agent `receipt.json`, any `status`, any integrity
   fact, **or any raw exit code** originating in the agent environment or in Job A.
   Every such value is carried with `trust: untrusted` and `grades_verdict: false`.
   The PASS/BLOCKED verdict rests **only on a verification replay Job B performs
   itself** (baseline run + post-change run from base-pinned inputs). Job A's
   output is retained for display and debugging, never to move the gate. (See
   "Why Job A still exists" below for why a powerless executor is kept at all.)
2. **Job B sources truth itself.** Job B reads `base.sha` and `head.sha` from the
   trusted GitHub PR event, reads policy + verifier + protected list via `git show
   <base_sha>:<path>`, and computes the diff `base..head` itself. None of these
   come from Job A or from the receipt.
3. **No `pull_request_target` to run candidate code.** The trigger is
   `pull_request`. `pull_request_target` would expose base-repo secrets to a
   context influenced by the PR - forbidden.
4. **Job B never executes PR-controlled workflow, policy, verifier, package
   scripts, actions or config.** Job B evaluates candidate code only under a
   **base-pinned** policy, verifier and dependency graph: the verify command, its
   files, `package.json`/lockfile, the workflow and action are all taken at the
   base SHA. The candidate's in-scope code blobs are applied into a clean base
   worktree and run *by the base-pinned verifier*. A PR that would change *how* it
   is tested (verifier/harness/scripts/workflow/policy) never reaches replay - it
   is gated (req. 5).
5. **Rule/evidence changes -> HUMAN_APPROVAL_REQUIRED.** If the diff touches
   `.runcap/mission.yaml|yml|json`, `.github/workflows/**`, the verify command's
   files, or any `verification.protect` path, the verdict is
   `HUMAN_APPROVAL_REQUIRED` (a change to the rules cannot be auto-graded by those
   same new rules). Lifecycle defined in its own section below.
6. **Verdict separates the two evidence sources visibly.** The verdict prints two
   labelled sections: **Code evidence: recomputed by CI** (baseline/replay,
   integrity status, scope, gate - the only thing that grades) and **Agent-side
   telemetry: untrusted** (cost, models, calls, the agent receipt's claimed status,
   and Job A's reported exit codes - all clearly marked advisory/untrusted-for-grading).
7. **Forged-evidence acceptance test exists.** A test feeds Job B a malicious
   `evidence.json` (and a malicious receipt) asserting `VERIFIED_STRONG`/PASS while
   the real situation is a failing/out-of-scope/tampered change; Job B ignores the
   forged values and still reaches its own correct verdict from its own replay.

---

## Threat model

### Asset
The **merge-eligibility verdict** (PASS / BLOCKED / HUMAN_APPROVAL_REQUIRED) and
the integrity facts behind it (baseline-failure, verifier-unchanged, scope,
clean-replay result) - all as computed by Job B's own replay.

### Trust boundary
UNTRUSTED: the PR head workspace, the agent `receipt.json`, Job A's entire output
(including its exit codes), and any SHA carried in an artifact or receipt.
TRUSTED: content read at the target branch **base SHA**, the GitHub PR event's
`base.sha`/`head.sha`, and the pinned action commit SHA.

### Adversary
A capable AI coding agent (or malicious human) that authored the PR and fully
controls the head commit and head workspace, and can write any file it likes
(including a plausible `evidence.json`/`raw-primitives.json` if it could reach the
artifact channel).

### Why Job A still exists (a powerless executor, not a trusted one)
Job A runs the candidate code in a powerless, secret-free place and is kept
**only** for telemetry/debugging. It is NOT kept to keep untrusted execution off
Job B's runner - Job B runs candidate code too (under base-pinned inputs). Job A's
sole value is being a cheap, isolated, secret-free place to capture what the
agent's own environment produces (cost, the agent's claimed exit codes) for the
side-by-side display in req. 6. **Nothing Job A emits grades the verdict.** If
Job A were deleted entirely, the verdict would be unchanged. This is the
correction over earlier drafts: there is no "irreducible primitive" that must
cross the boundary to decide PASS/BLOCKED. The only thing that decides PASS/BLOCKED
is Job B's own replay of the base-pinned verifier against base+allowed-diff.

### Attacks in scope, and the control that defeats each
1. **Forged receipt or forged evidence.json** claiming VERIFIED_STRONG -> Job B
   ignores all agent/Job-A facts (telemetry only); recomputes from base SHA by
   running its own replay. Real failing/out-of-scope change -> BLOCKED.
2. **Tampered verifier / test / package scripts** -> diff touches verifier or a
   protect path -> `HUMAN_APPROVAL_REQUIRED`; replay always uses base-SHA verifier
   and base-SHA package scripts/lockfile.
3. **Tampered policy / workflow / action** -> diff touches policy,
   `.github/workflows/**`, or the action config -> `HUMAN_APPROVAL_REQUIRED`.
4. **Out-of-scope edit** -> Job B's own diff/scope check -> BLOCKED.
5. **Green depends on uncommitted local state** -> clean replay at base+allowed
   diff fails to reproduce -> BLOCKED.
6. **Baseline already passing** -> Job B runs base-SHA verifier at base first; if
   it already passes, STRONG is impossible (WEAK at best).
7. **Exfiltration / supply-chain via the verify step** -> neither job has secrets,
   deployment creds, or `id-token`. Both are GitHub-hosted (req. below). Nothing to
   steal, nothing to sign with.
8. **Artifact-channel poisoning** (agent overwrites/injects Job A's artifact) ->
   irrelevant to the verdict: Job B never grades on Job A's artifact. A poisoned
   artifact at most corrupts the untrusted-telemetry display, which is labelled
   untrusted. The verdict is Job B's replay regardless.
9. **SHA confusion** (artifact/receipt carries a `base_sha`/`head_sha` to redirect
   replay identity) -> Job B takes base/head only from the trusted PR event;
   `GITHUB_SHA`/merge SHA is diagnostic only; a SHA from any artifact/receipt is
   ignored. If trusted PR identity cannot be resolved -> BLOCKED.
10. **Diff-application smuggling** (symlink, file-mode/exec-bit flip, submodule
    pointer, binary/`GIT_BINARY_PATCH`) used to apply something other than a plain
    in-scope text blob -> Job B's diff applier rejects non-regular-file changes,
    mode changes, submodule changes, and binary patches in the allowed set ->
    BLOCKED (or HUMAN_APPROVAL_REQUIRED if it coincides with a protect/gated path).

### Out of scope (named, deferred on purpose)
- Cryptographic signing / keyless attestation (Sigstore/OIDC) of the verdict.
  Reason: it requires giving a job a signing identity, and we refuse to put any
  signing capability in a job that runs PR-candidate code. Tier 3 trust = a
  **protected GitHub workflow + required status check + CODEOWNERS** (CI-attested,
  not crypto-attested - see prerequisite section). Signing gets its own threat
  model next.
- Hardware/second-OS sandbox beyond the GitHub-hosted runner.
- Monorepo path-mapping nuance (single-package repo assumed for v1).

---

## How does the evidence verdict become an unspoofable required PR check?

A CI job that recomputes the verdict honestly is **not enough on its own**. If the
PR can edit the workflow that runs Job B, or swap the policy/verifier that Job B
pins to, then "Job B is independent" is false - the agent rewrites the judge. So
Tier 3's trust rests on a **repository-hardening prerequisite** that the product
must state plainly and verify, not assume:

**v1 trust prerequisite (required, not optional):**
1. **Protected default branch** - no direct pushes; merges only via PR that passes
   the required check.
2. **The Runcap check is marked Required** on the protected branch.
3. **CODEOWNERS ownership** of the trust surface, with required review from a human
   code owner for any change to:
   - `.github/workflows/**` (the workflow that runs Job A/Job B),
   - `.runcap/mission.yaml|yml|json` (the policy),
   - the verify command's own files,
   - every `verification.protect` path.
4. **Action pinned by commit SHA** in the consumer workflow (provenance records the
   resolved SHA; `@v1` is for humans).

Without this, an agent's PR can change the rules in the same PR whose rules are
being graded. The CODEOWNERS + protected-branch combination is what makes
HUMAN_APPROVAL_REQUIRED meaningful: the gated change physically cannot merge until a
human code owner approves it.

**Honesty rule for the product copy and the runner:** Runcap must NOT claim "the
runner is fully independent" in the absence of this hardening. At install time the
tool checks for the prerequisite and, if it is missing, reports
`INSTALLATION_NOT_HARDENED` (acceptance test below) rather than implying a
guarantee it cannot make. Detection is best-effort over what the GitHub API exposes
to a `contents: read` / `pull-requests: read` token (branch protection + required
checks where readable, presence of a CODEOWNERS file covering the trust paths); it
reports `INSTALLATION_NOT_HARDENED` when it cannot positively confirm the
prerequisite, and never reports "hardened" by assumption.

---

## Architecture: two GitHub-hosted jobs, verdict computed only by Job B's replay

```
PR opened/updated  (on: pull_request   <-- NOT pull_request_target)
        |
        v
[Job A: execute - TELEMETRY ONLY]   GitHub-hosted; NO secrets, NO id-token, contents:read
   - checkout base SHA (persist-credentials:false)
   - run candidate code as the agent's env would
   - emit telemetry.json: { agent_reported_exit, cost, models, calls }
     (trust: untrusted, grades_verdict: false - NOTHING here grades)
        |  (artifact = UNTRUSTED, display-only)
        v
[Job B: adjudicate - GitHub-hosted only, NO secrets/id-token/deploy creds]
   needs: Job A (only to attach its telemetry to the report)
   - read base.sha / head.sha from the trusted GitHub PR event (NOT GITHUB_SHA,
     NOT any artifact/receipt SHA); if unresolved -> BLOCKED
   - read policy + verifier + protected + package scripts/lockfile @ base SHA
     (git show base:path)
   - compute diff base..head itself
   - GATE: diff touches policy/workflow/verifier/protected/action
       -> HUMAN_APPROVAL_REQUIRED
   - compute scope (allow/protect) itself
   - apply ONLY plain in-scope text blobs into a clean base worktree; reject
     symlink / mode-change / submodule / binary-patch smuggling -> BLOCKED
   - RUN the base-pinned verifier itself: baseline (pre-change) + replay
     (post-change). THIS is the only thing that grades.
   - derive integrity_status from Job B's own two runs
   - evaluatePolicyVerdict over B's recomputed facts (NOT artifact/receipt)
   - print verdict: two sections (code evidence: recomputed | agent telemetry: untrusted)
   - write PR check + $GITHUB_STEP_SUMMARY + provenance
   - exit non-zero on BLOCKED / HUMAN_APPROVAL_REQUIRED  -> required check fails PR
```

Why both jobs are GitHub-hosted with no privilege: Job A runs untrusted candidate
code, so it is stripped of all authority and secrets. Job B *also* runs candidate
code (under base-pinned inputs), so it too must be GitHub-hosted only - **no
self-hosted runner, no secrets, no `id-token`, no deployment credentials, no shared
privileged cache** that a prior PR could have poisoned. The only authority Job B
holds is posting a status, granted by the protected-workflow + required-check
prerequisite, not by a secret. In v1 there is **no signing secret in either job**.

---

## Base / head handling (exact)

- **base SHA** = `github.event.pull_request.base.sha`, taken **only** from the
  trusted GitHub PR event. All TRUSTED inputs read here.
- **head SHA** = `github.event.pull_request.head.sha`, taken **only** from the
  trusted GitHub PR event. UNTRUSTED content, trusted identity.
- **`GITHUB_SHA` / the merge commit SHA** = diagnostic/provenance only; never used
  to select replay identity.
- **No SHA from an artifact or receipt** can influence replay identity. A
  `base_sha`/`head_sha` appearing in `evidence.json`/`receipt.json` is ignored.
- **If trusted PR identity is unresolved** (event payload missing/ambiguous, e.g.
  the workflow was triggered in a context without a `pull_request` event) -> the
  verdict is **BLOCKED** (fail closed). Replay never runs against an unverified
  identity.
- **diff** = `git diff --name-status <base_sha>..<head_sha>`, computed by Job B.
  Never taken from `receipt.changedFiles` or from Job A.
- **policy / verifier / protected / package scripts + lockfile** = `git show
  <base_sha>:<path>`. Never from the post-head working tree.
- **action commit** = consumer workflow pins the Runcap action by **commit SHA**;
  Job B records the resolved SHA in provenance.
- **applied changes** = for each `base..head` path matching `allow` AND not
  matching `protect` AND not a gated path AND that is a plain regular-file text
  change (no symlink, no mode change, no submodule, no binary patch), the **head**
  blob is applied into the clean base worktree. Anything else -> BLOCKED.

---

## HUMAN_APPROVAL_REQUIRED (third verdict state) - exact lifecycle

`evaluatePolicyVerdict` today returns `PASS | BLOCKED`. Tier 3 adds
`HUMAN_APPROVAL_REQUIRED`, emitted by Job B's gate when the diff touches:
`.runcap/mission.yaml|yml|json`, `.github/workflows/**`, the verify command's own
files, or any `verification.protect` path.

- **Does it block?** Yes. It is a non-PASS state; the required check exits non-zero,
  so the PR cannot auto-merge. Distinct from BLOCKED ("ran and failed the rules")
  in meaning and message, but identical in merge effect: not mergeable as-is.
- **Who approves?** A human **code owner** of the touched trust path (via the
  CODEOWNERS prerequisite). Approval is a GitHub PR review approval from that code
  owner - i.e. it happens in GitHub's protected-branch machinery, not inside
  Runcap. Runcap does not grant the approval; it only refuses to auto-grade.
- **How does a legitimate policy/verifier update eventually pass?** The code owner
  reviews and approves the PR in GitHub. On a protected branch configured so that
  the required code-owner review + the required check together gate merge, the
  approved PR becomes mergeable: the **new** policy/verifier is now the base for all
  *subsequent* PRs, which Job B will pin to going forward. The gated PR itself
  merges on human authority (the rules cannot grade their own change); every PR
  after it is auto-graded against the now-updated, human-approved base. This is the
  intended escape hatch: rules evolve, but only through a human code owner, never
  through the agent that benefits from the change.

Required check fails the PR for both non-PASS states.

---

## Inputs / outputs (contracts)

### Job A output: `telemetry.json` (NO verdict, NO trusted facts)
```jsonc
{
  "schema": "runcap.ci-telemetry/v1",
  "trust": "untrusted",
  "grades_verdict": false,
  "agent_reported_baseline_exit": 1,   // DISPLAY ONLY - never grades
  "agent_reported_replay_exit": 0,     // DISPLAY ONLY - never grades
  "observed_cost_usd": 0.0007,
  "models": ["gpt-4o"],
  "llm_calls": 3
}
```
Hard rule: Job A computes no integrity status, no scope, no verdict. Every field is
display-only. If Job A emits a `verdict`/`status`/`integrity_status` field, Job B
ignores it. Deleting Job A entirely would not change any verdict.

### Job B output: the verdict (two visibly separated evidence sources, req. 6)
```jsonc
{
  "schema": "runcap.ci-verdict/v1",
  "verdict": "PASS|BLOCKED|HUMAN_APPROVAL_REQUIRED",
  "reasons": [ "..." ],
  "truth": "calculated_in_ci_from_base_sha_inputs_by_job_b_replay",
  "code_evidence": {                  // recomputed by CI - the ONLY thing that grades
    "source": "recomputed_by_ci_from_base_sha",
    "grades_verdict": true,
    "integrity_status": "VERIFIED_STRONG|VERIFIED_WEAK|UNVERIFIED|VERIFIER_COMPROMISED",
    "baseline_passed": false, "replay_passed": true,
    "scope_violations": [], "gate": { "triggered": false, "reason": null },
    "diff_application": "ok"          // or "rejected: symlink|mode|submodule|binary"
  },
  "agent_telemetry": {                // untrusted - display only
    "source": "agent_environment_and_job_a",
    "trust": "untrusted",
    "grades_verdict": false,
    "agent_claimed_status": "VERIFIED_STRONG",   // shown, never trusted
    "agent_reported_exits": { "baseline": 1, "replay": 0 },
    "observed_cost_usd": 0.0007, "models": ["gpt-4o"], "llm_calls": 3
  },
  "hardening": {                      // the prerequisite check (req. / section above)
    "status": "HARDENED|INSTALLATION_NOT_HARDENED",
    "protected_branch": true, "required_check": true,
    "codeowners_covers_trust_paths": true, "action_pinned_by_sha": true
  },
  "provenance": {
    "base_sha": "...", "head_sha": "...", "policy_hash": "...",
    "action_sha": "...", "workflow_run_id": "...", "job_id": "...",
    "github_sha_diagnostic": "..."    // recorded, NOT used for replay identity
  }
}
```
`agent_telemetry.grades_verdict` is permanently `false`: cost and the agent's
claimed status/exits are retained and displayed but can never move the gate. (Budget
*limits* are still enforced at run time by the gateway 429 and recorded; but the CI
verdict's integrity does not depend on any agent-reported number or exit code.)

### Permissions (the load-bearing posture)
```yaml
on: pull_request                 # req. 3 - NOT pull_request_target
permissions:
  contents: read                 # read-only
  pull-requests: write           # Job B only, to post the check/summary
  id-token: none                 # NO OIDC / no signing capability (both jobs)
# GitHub-hosted runners only (both jobs); no self-hosted runner;
# no secrets exposed to either job; no deployment creds; no shared privileged cache
```

---

## Acceptance tests (all must pass before Tier 3 ships)

Extend the existing `check(name, pass)` style. CI logic is exercised by driving
the future `runcap ci --mode execute` (Job A telemetry) and `--mode adjudicate`
(Job B verdict) against fixtures in temp git repos with a real base/head.

1. **Forged receipt is ignored.** Head workspace has a hand-written `receipt.json`
   = VERIFIED_STRONG/verified, but the diff does not fix the failing task. -> Job B
   recomputes via its own replay -> UNVERIFIED -> **BLOCKED**; the receipt's claimed
   status appears only under `agent_telemetry`, never in the grading path.
2. **Forged Job-A artifact is ignored (req. 7, the headline test).** Feed Job B a
   malicious `telemetry.json` claiming `agent_reported_replay_exit: 0` and a
   `status: "VERIFIED_STRONG"` field, while the real replay fails. -> Job B's own
   replay decides -> **BLOCKED**; assert the forged values appear only under
   `agent_telemetry` and never in `code_evidence` or `reasons`.
3. **Verifier change -> human gate.** Diff edits the verify file / a `protect`
   path -> `HUMAN_APPROVAL_REQUIRED`, reason names the path; required check fails.
4. **Policy change -> human gate.** Diff edits `.runcap/mission.yaml`
   -> `HUMAN_APPROVAL_REQUIRED`.
5. **Workflow change -> human gate.** Diff edits `.github/workflows/*.yml`
   -> `HUMAN_APPROVAL_REQUIRED`.
6. **Honest allowed diff -> PASS.** Diff entirely within `allow`; baseline verify
   fails (real task); Job B's replay passes from base+allowed diff -> `VERIFIED_STRONG`
   -> **PASS**.
7. **Out-of-scope diff -> BLOCKED.** Diff includes a path outside `allow` (not a
   gated path) -> scope_violations non-empty -> **BLOCKED**.
8. **Baseline already passes -> no strong proof.** Verifier passes at base SHA
   before any change -> integrity capped at `VERIFIED_WEAK`; STRONG impossible.
9. **Replay fails in clean CI -> BLOCKED.** Pass existed only in the agent's dirty
   tree; clean base+allowed-diff replay fails -> **BLOCKED**.
10. **Cost/exit telemetry retained, cannot grade (req. 6).** Receipt/telemetry
    carries a cost/model/exit block; assert it appears under `agent_telemetry` with
    `grades_verdict:false`, and that mutating it (cost -> $0, cost -> $9999, or
    flipping `agent_reported_replay_exit`) does NOT change the verdict for any
    fixture above.
11. **Verdict shows both sources separately (req. 6).** Assert the rendered verdict
    contains a "Code evidence: recomputed by CI" section and an "Agent-side
    telemetry: untrusted" section, distinctly labelled.
12. **Provenance recorded (req. 2).** Verdict JSON has base_sha, head_sha,
    policy_hash, action_sha, workflow_run_id, job_id; `truth` =
    `calculated_in_ci_from_base_sha_inputs_by_job_b_replay`; `github_sha_diagnostic`
    present but unused for replay identity.
13. **No-authority posture (static check, req. 3 + both-jobs safety).** A lint/test
    asserts the shipped workflow template uses `pull_request` (not
    `pull_request_target`), sets `id-token` absent/none, exposes no `secrets:` to
    either job, and uses GitHub-hosted runners only (no `runs-on: self-hosted`).
14. **SHA cannot be redirected by artifact/receipt (req. / base-head section).**
    Feed Job B a `receipt.json`/`telemetry.json` carrying a different
    `base_sha`/`head_sha`; assert replay uses the PR-event SHAs and the artifact
    SHAs are ignored. Separately: simulate an unresolved PR identity (no
    `pull_request` event payload) -> **BLOCKED** (fail closed).
15. **Diff-smuggling rejected.** Four sub-fixtures, each an in-`allow` path that is
    NOT a plain text blob: (a) a symlink, (b) an exec-bit/mode change, (c) a
    submodule pointer change, (d) a binary patch. Each -> Job B's applier rejects it
    -> **BLOCKED** with `code_evidence.diff_application` naming the reason.
16. **Un-hardened installation is reported, not silently trusted.** Run the adjudicator
    against a repo whose branch protection / required check / CODEOWNERS prerequisite
    is absent -> verdict carries `hardening.status: "INSTALLATION_NOT_HARDENED"`, and
    the tool does NOT print any "fully independent / unspoofable" guarantee. (Whether
    this also forces a non-PASS is a product decision flagged for Kirill in the PR;
    default proposal: surface it loudly as a warning on PASS, and document that the
    guarantee holds only when `HARDENED`.)
17. **HUMAN_APPROVAL_REQUIRED lifecycle.** A gated-path diff -> verdict
    `HUMAN_APPROVAL_REQUIRED`, required check non-zero (does not auto-merge); the
    reason explains a human code owner must approve; assert the message names the
    gated path and does NOT imply Runcap itself can grant approval.

---

## What changes in code (for the LATER build step, NOT now)

Listed so the plan is actionable; not to be implemented until approved:
- `evaluatePolicyVerdict`: add `HUMAN_APPROVAL_REQUIRED`; grade off a passed-in
  **CI-recomputed evidence** object built from Job B's own replay, never the agent
  receipt or Job A artifact fields. Keep the receipt path only for the local
  `mission run` developer loop, clearly labelled "local, advisory."
- New CI evidence builder (Job B core): port `freezeTaskContract` +
  `checkVerificationIntegrity` + `verifyInCleanWorktree` logic to source ALL
  inputs from base SHA, compute the diff itself, reject diff-smuggling, and run the
  baseline + replay itself. This is the heart of Tier 3.
- Diff applier with a hard allowlist of change kinds (regular-file text blobs only).
- Hardening detector: best-effort read of branch protection / required check /
  CODEOWNERS coverage -> `HARDENED | INSTALLATION_NOT_HARDENED`.
- `runcap ci` gains `--mode execute` (Job A telemetry) and `--mode adjudicate`
  (Job B verdict). The composite `action.yml` wires both jobs with the permissions
  block above, GitHub-hosted only.
- Ship a hardened reference workflow template + a sample CODEOWNERS; document
  "protect the default branch; mark the check Required; own the trust paths via
  CODEOWNERS; pin the action by commit SHA."

---

## Stop line

After Tier 3 (CI-attested verdict via protected workflow + required check +
CODEOWNERS, verdict computed only by Job B's own replay), the product is a coherent
**proof gate** for public launch and design partners. Do NOT add in this scope:
cryptographic signing/keyless attestation (own threat model, next), orchestration,
benchmark/model-ranking, or a SaaS dashboard.
