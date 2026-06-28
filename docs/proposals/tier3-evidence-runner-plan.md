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
CI by **a single adjudicator job re-running the verification itself** from inputs
read at the PR's **base SHA**, never from anything produced in the agent
environment. After Tier 3 this sentence is literally true (today half true):

> The agent may write the change. It cannot control the environment that decides
> whether the change is merge-eligible.

---

## Trust assertions (the requirements, explicit and load-bearing)

This section is the contract the rest of the plan must satisfy. Each is testable.

1. **The required Proof Gate is one self-sufficient job.** Tier 3 v1 is a single
   required job (the adjudicator). It does not depend on any job that runs untrusted
   candidate code as a precondition (`needs:`), so untrusted code cannot make the
   gate skip or pass by crashing/skipping a job it depends on.
2. **Everything from the agent environment is optional advisory telemetry.** The
   receipt, gateway cost, model/call counts, agent-claimed status, and any agent or
   side-job exit codes are `trust: untrusted` / `grades_verdict: false`. They may be
   *displayed* later as advisory data; they are **never a workflow dependency** and
   **never influence the outcome**. The verdict rests only on the adjudicator's own
   replay.
3. **The adjudicator sources truth itself.** It reads `base.sha`/`head.sha` from the
   trusted GitHub PR event, reads policy + verifier + dependency manifest/lockfile +
   protected list via `git show <base_sha>:<path>`, and computes the diff
   `base..head` itself. None of these come from any artifact or the receipt.
4. **No `pull_request_target`.** Trigger is `pull_request`. `pull_request_target`
   would expose base-repo secrets to a PR-influenced context - forbidden.
5. **The adjudicator never executes PR-controlled workflow, policy, verifier,
   package scripts, actions or config.** It evaluates candidate code only under a
   **base-pinned** policy, verifier and dependency graph: the verify command, its
   files, `package.json`/lockfile, package-manager command, the workflow and action
   are all taken at the base SHA. Candidate in-scope code blobs are applied into a
   clean base worktree and run *by the base-pinned verifier*. A PR that would change
   *how* it is tested is gated (req. 7).
6. **Verdict separates the two evidence sources visibly.** Two labelled sections:
   **Code evidence: recomputed by CI** (baseline/replay, integrity status, scope,
   gate - the only thing that grades) and **Agent-side telemetry: untrusted,
   advisory** (cost, models, calls, claimed status/exits - never grades).
7. **Rule/evidence changes -> HUMAN_APPROVAL_REQUIRED.** If the diff touches
   `.runcap/mission.yaml|yml|json`, `.github/workflows/**`, the verify command's
   files, the dependency manifest/lockfile, or any `verification.protect` path, the
   verdict is `HUMAN_APPROVAL_REQUIRED` (a change to the rules cannot be auto-graded
   by those same new rules). Exact lifecycle + exit semantics below.
8. **Forged-evidence acceptance test exists.** A test feeds the adjudicator a
   malicious `evidence.json`/receipt asserting `VERIFIED_STRONG`/PASS while the real
   situation fails; the adjudicator ignores the forged values and still reaches its
   own correct verdict from its own replay.

---

## Threat model

### Asset
The **merge-eligibility verdict** (PASS / BLOCKED / HUMAN_APPROVAL_REQUIRED /
INSTALLATION_NOT_HARDENED) and the integrity facts behind it (baseline-failure,
verifier-unchanged, scope, clean-replay result) - all as computed by the
adjudicator's own replay.

### Trust boundary
UNTRUSTED: the PR head workspace, the agent `receipt.json`, any side-job/artifact
output, and any SHA carried in an artifact or receipt. TRUSTED: content read at the
target branch **base SHA**, the GitHub PR event's `base.sha`/`head.sha`, and the
pinned action commit SHA.

### Adversary
A capable AI coding agent (or malicious human) that authored the PR and fully
controls the head commit and head workspace, and can write any file it likes. The
guarantee holds only against PR authors **without** branch-protection or ruleset
**bypass** authority (see no-bypass requirement); an actor who can bypass branch
protection is out of scope.

### Attacks in scope, and the control that defeats each
1. **Forged receipt or forged evidence.json** -> adjudicator ignores all agent facts
   (advisory only); recomputes from base SHA by running its own replay.
2. **Tampered verifier / test / package scripts / manifest / lockfile** -> diff
   touches verifier, dependency files, or a protect path -> `HUMAN_APPROVAL_REQUIRED`;
   replay always uses base-SHA verifier + base-SHA dependencies.
3. **Tampered policy / workflow / action** -> diff touches policy,
   `.github/workflows/**`, or action config -> `HUMAN_APPROVAL_REQUIRED`.
4. **Out-of-scope edit** -> adjudicator's own diff/scope check -> BLOCKED.
5. **Green depends on uncommitted local state** -> clean replay at base+allowed
   diff fails to reproduce -> BLOCKED.
6. **Baseline already passing** -> adjudicator runs base-SHA verifier at base first;
   if it already passes, STRONG is impossible (WEAK at best).
7. **Credential theft via the verify step** -> neither the gate nor any side job has
   secrets, OIDC/`id-token`, or deployment credentials, which limits credential
   theft. **This is not network isolation.** See the corrected exfiltration note
   below.
8. **Side-job / artifact poisoning** -> irrelevant to the verdict: the gate has no
   `needs:` on any untrusted job and never grades on an artifact. A poisoned artifact
   at most corrupts an advisory display, which is labelled untrusted.
9. **SHA confusion** (artifact/receipt carries a `base_sha`/`head_sha`) -> adjudicator
   takes base/head only from the trusted PR event; `GITHUB_SHA`/merge SHA diagnostic
   only; a SHA from any artifact/receipt is ignored. Unresolved identity -> BLOCKED.
10. **Diff-application smuggling** (delete/rename/copy/type-change, symlink, mode/
    exec-bit, submodule pointer, binary patch, LFS pointer) -> the applier accepts
    only `A`/`M` regular UTF-8 text files in allow scope; everything else -> BLOCKED
    (or HUMAN_APPROVAL_REQUIRED if it coincides with a protect/gated path).
11. **Stale base / stale approval** (evidence produced against an old base, or a
    review left valid after later trust-path commits) -> hardened profile requires
    branch-up-to-date-before-merge and stale-approval dismissal (sections below).

### Inherited CI risks, explicitly OUT of scope for Tier 3
Removing secrets/OIDC/deploy creds limits credential theft but does **not** provide
network isolation and does **not** prevent source-code exfiltration. Candidate code
run under the base-pinned verifier may still read available repository content, make
network calls, consume runner time, or attempt upload. These are inherited CI risks,
out of scope for Tier 3, and partially mitigated only by a hard job `timeout-minutes`.

### Out of scope (named, deferred on purpose)
- Cryptographic signing / keyless attestation (own threat model, next).
- Network isolation / egress control on the runner.
- Hardware/second-OS sandbox beyond the GitHub-hosted runner.
- Merge queue (`merge_group`) support - unsupported in v1; see base-freshness.
- Monorepo path-mapping nuance (single-package repo assumed for v1).
- "Independent budget enforcement" - NOT claimed in v1 (see budget section).

---

## How does the verdict become a protected CI-attested required check?

A CI job that recomputes the verdict honestly is **not enough on its own**. If the
PR can edit the workflow that runs the adjudicator, or swap the policy/verifier it
pins to, then "the adjudicator is independent" is false - the agent rewrites the
judge. So Tier 3's trust rests on a **repository-hardening prerequisite** that the
product must state plainly and verify, not assume. We do **not** use the word
"unspoofable"; the honest claim is "protected, CI-attested required check."

**v1 trust prerequisite (the "hardened profile", required - not optional):**
1. **Protected default branch** - no direct pushes; merges only via PR that passes
   the required check.
2. **The Runcap check is marked Required** on the protected branch.
3. **Branch must be up to date before merge** (base-freshness; see section).
4. **Dismiss stale approvals on new commits** OR require approval of the most recent
   reviewable push (stale-approval protection; see section).
5. **CODEOWNERS ownership** of the trust surface, with required human code-owner
   review for any change to: `.github/workflows/**`, `.runcap/mission.yaml|yml|json`,
   the verify command's files, the dependency manifest/lockfile, and every
   `verification.protect` path.
6. **No bypass** - "do not allow bypassing the above settings" is enabled, so the
   protections apply even to admins/maintainers. The guarantee applies only against
   PR authors without bypass authority.
7. **Action pinned by commit SHA** in the consumer workflow (provenance records the
   resolved SHA; `@v1` is for humans).

### Hardening: configuration vs detection (kept separate)
- **Configuration** is what the repo owner sets up (the 7 items above). It is the
  thing that actually provides the guarantee.
- **Detection** is the adjudicator's best-effort attempt to *confirm* configuration
  from a low-privilege (`contents: read`) PR job. A low-privilege job may not
  reliably read all branch-protection / ruleset settings. Therefore detection is
  allowed to return only:
  - `HARDENED` - positively confirmed, OR
  - `HARDENING_UNVERIFIED` - could not positively confirm (treated as a non-PASS,
    same family as `INSTALLATION_NOT_HARDENED`).
  Detection **never infers `HARDENED` by assumption** and never downgrades a missing
  signal to a pass. Absence of proof of hardening is reported, not ignored.

---

## Architecture: one required adjudicator job (Job B). No required executor.

```
PR opened/updated  (on: pull_request   <-- NOT pull_request_target)
        |
        v
[Adjudicator - the ONE required job; GitHub-hosted; permissions: contents:read only]
   - read base.sha / head.sha from the trusted GitHub PR event (NOT GITHUB_SHA,
     NOT any artifact/receipt SHA); if unresolved -> BLOCKED
   - resolve hardening: HARDENED | HARDENING_UNVERIFIED | INSTALLATION_NOT_HARDENED
       (strict mode: any non-HARDENED -> non-zero, no merge-eligibility claim)
   - read policy + verifier + dependency manifest/lockfile + pkg-manager cmd +
     protected list @ base SHA (git show base:path)
   - compute diff base..head itself
   - GATE: diff touches policy/workflow/verifier/dependency files/protected/action
       -> HUMAN_APPROVAL_REQUIRED (success/neutral; human code owner gates merge)
   - compute scope (allow/protect) itself
   - apply ONLY A/M regular UTF-8 text blobs in allow scope; reject
     D/R/C/T, symlink, mode change, submodule, binary, LFS -> BLOCKED
   - install base-pinned deps with NO PR-controlled scripts/config
       (documented: `npm ci --ignore-scripts`, base lockfile, no shared priv cache)
   - RUN the base-pinned verifier itself: baseline (pre-change) + replay
     (post-change). THIS is the only thing that grades.
   - derive integrity_status from its own two runs
   - evaluatePolicyVerdict over recomputed facts (NOT artifact/receipt)
   - write verdict via Actions check conclusion + $GITHUB_STEP_SUMMARY
       (NO PR comments in v1)
   - exit: PASS/HUMAN_APPROVAL_REQUIRED -> success/neutral;
           BLOCKED / strict non-HARDENED -> non-zero  -> required check fails PR

[OPTIONAL advisory executor - NOT in the required path, NO `needs:` edge]
   - may run candidate code in the agent's manner to capture cost/telemetry
   - emits display-only data; if it crashes/skips, the gate is unaffected
   - can be added later; absent in v1's minimal required workflow
```

Why one job, no `needs:` on an executor: an earlier draft kept a powerless executor
(Job A) and had the adjudicator `needs:` it. That is wrong for a Required Proof Gate:
if untrusted candidate code makes the executor fail or skip, a dependent adjudicator
can be skipped too, and a skipped required check can be misconfigured into "passing."
So the gate stands alone. Telemetry, if collected at all, is a separate optional job
with no edge into the gate.

---

## Base / head handling (exact)

- **base SHA** = `github.event.pull_request.base.sha`, taken **only** from the
  trusted GitHub PR event. All TRUSTED inputs read here.
- **head SHA** = `github.event.pull_request.head.sha`, taken **only** from the
  trusted GitHub PR event. UNTRUSTED content, trusted identity.
- **`GITHUB_SHA` / the merge commit SHA** = diagnostic/provenance only; never used
  to select replay identity.
- **No SHA from an artifact or receipt** can influence replay identity. A
  `base_sha`/`head_sha` in `evidence.json`/`receipt.json` is ignored.
- **If trusted PR identity is unresolved** (event payload missing/ambiguous) -> the
  verdict is **BLOCKED** (fail closed). Replay never runs against an unverified
  identity.
- **diff** = `git diff --name-status <base_sha>..<head_sha>`, computed by the
  adjudicator. Never from `receipt.changedFiles` or any artifact.
- **policy / verifier / protected / dependency manifest+lockfile / pkg-manager cmd**
  = `git show <base_sha>:<path>`. Never from the post-head working tree.
- **action commit** = consumer workflow pins the action by **commit SHA**; recorded
  in provenance.
- **applied changes** = for each `base..head` path that is `A` or `M`, matches
  `allow`, is not `protect`/gated, and is a plain regular-file UTF-8 text change, the
  **head** blob is applied into the clean base worktree. Anything else -> BLOCKED.

### Base-freshness (v1 decision, documented)
Evidence must not be produced against an old base and then merged against a newer
base. v1 choice: **strict branch protection requires the branch to be up to date
before merge.** **Merge queue is unsupported in v1.** Future note: if merge-queue
support is added, the workflow must also trigger on `merge_group` and re-run the
adjudicator against the queued base.

### Stale-approval protection (hardened profile)
A safe-workflow review must not stay valid after later trust-path changes. The
hardened profile requires one of: **dismiss stale approvals when new commits are
pushed**, OR **require approval of the most recent reviewable push.**

---

## The four verdict states - exact exit semantics

| State | Meaning | Action conclusion | Merge effect |
|---|---|---|---|
| `PASS` | Adjudicator's replay reproduced the verified result under base-pinned rules. | success | Mergeable (with other required gates). |
| `BLOCKED` | Replay failed, scope violation, rejected diff type, unresolved identity, etc. | **failure (non-zero)** | Cannot merge until **code** changes. |
| `HUMAN_APPROVAL_REQUIRED` | Diff changes the rules (policy/workflow/verifier/deps/protected). Runcap refuses to issue automated code proof. | **success / neutral (NOT failure)** | Held by CODEOWNERS + protected branch until an authorized human approves; merges on **human** authority. |
| `INSTALLATION_NOT_HARDENED` (and `HARDENING_UNVERIFIED`) | Hardened-profile prerequisite is missing or cannot be positively confirmed. | **strict mode: failure (non-zero)** | No merge-eligibility claim; never rendered as PASS. |

### HUMAN_APPROVAL_REQUIRED lifecycle (the previous contradiction, fixed)
Earlier the plan said this state exits non-zero AND that a CODEOWNER approval lets
the same PR merge - contradictory, because a failed required check stays failed
regardless of review approval. Corrected semantics:

- The adjudicator returns **success/neutral**, not failure. It does not block by
  failing the check; it explicitly **declines to auto-grade** a rules change.
- The job summary states plainly that **human authority (CODEOWNER review) is
  required** and names the gated trust path. It must NOT imply Runcap itself grants
  approval.
- The PR is held not by a red Runcap check but by the **protected branch +
  CODEOWNERS** machinery: the required human code-owner review is the gate.
- When the authorized human approves and the PR merges, the **new** human-approved
  policy/verifier/deps become the base for **subsequent** PRs, which the adjudicator
  pins to and auto-grades going forward. Rules evolve only through a human code
  owner, never through the agent that benefits.

### INSTALLATION_NOT_HARDENED - fail closed
Default (strict Proof Gate) mode: a non-HARDENED result (`INSTALLATION_NOT_HARDENED`
or `HARDENING_UNVERIFIED`) exits non-zero and makes **no** merge-eligibility claim.
**PASS-plus-warning is not allowed by default.**

An optional future advisory mode (`runcap ci --advisory`) may run the replay without
the hardened prerequisite, but it must output something like:
```
ADVISORY_REPLAY_PASSED
Hardening: unverified
Not a Proof Gate verdict
```
It must **never** be called PASS.

---

## Inputs / outputs (contracts)

### Verdict output (the adjudicator; two visibly separated sources, req. 6)
```jsonc
{
  "schema": "runcap.ci-verdict/v1",
  "verdict": "PASS|BLOCKED|HUMAN_APPROVAL_REQUIRED|INSTALLATION_NOT_HARDENED",
  "mode": "proof_gate_strict",        // or "advisory" (never emits PASS)
  "reasons": [ "..." ],
  "truth": "calculated_in_ci_from_base_sha_inputs_by_adjudicator_replay",
  "code_evidence": {                  // recomputed by CI - the ONLY thing that grades
    "source": "recomputed_by_ci_from_base_sha",
    "grades_verdict": true,
    "integrity_status": "VERIFIED_STRONG|VERIFIED_WEAK|UNVERIFIED|VERIFIER_COMPROMISED",
    "baseline_passed": false, "replay_passed": true,
    "scope_violations": [],
    "gate": { "triggered": false, "reason": null },
    "diff_application": "ok",         // or "rejected: D|R|C|T|symlink|mode|submodule|binary|lfs"
    "deps": { "source": "base_sha", "install": "npm ci --ignore-scripts" }
  },
  "agent_telemetry": {                // untrusted, advisory, OPTIONAL - display only
    "source": "agent_environment_optional_advisory_job",
    "trust": "untrusted",
    "grades_verdict": false,
    "available": true,                // false when telemetry missing/corrupt/skipped
    "agent_claimed_status": "VERIFIED_STRONG",
    "agent_reported_exits": { "baseline": 1, "replay": 0 },
    "observed_cost_usd": 0.0007, "models": ["gpt-4o"], "llm_calls": 3
  },
  "hardening": {
    "status": "HARDENED|HARDENING_UNVERIFIED|INSTALLATION_NOT_HARDENED",
    "detected": { "protected_branch": true, "required_check": true,
      "up_to_date_before_merge": true, "stale_approval_dismissal": true,
      "codeowners_covers_trust_paths": true, "no_bypass": true,
      "action_pinned_by_sha": true }
  },
  "provenance": {
    "base_sha": "...", "head_sha": "...", "policy_hash": "...",
    "action_sha": "...", "workflow_run_id": "...", "job_id": "...",
    "github_sha_diagnostic": "..."    // recorded, NOT used for replay identity
  }
}
```
`agent_telemetry.grades_verdict` is permanently `false`. When telemetry is missing,
corrupt, unavailable or skipped, `available:false` and the verdict is unaffected.

### Permissions (the load-bearing posture - minimal)
```yaml
on: pull_request                 # req. 4 - NOT pull_request_target
permissions:
  contents: read                 # ONLY this
# Explicitly NOT present: pull-requests:write, checks:write, issues:write,
#   id-token, secrets, deployment credentials.
# GitHub-hosted runners only; no self-hosted runner; no cache shared with
#   privileged workflows.
jobs:
  proof-gate:
    runs-on: ubuntu-latest        # GitHub-hosted only (no self-hosted)
    timeout-minutes: 10           # hard cap on runner time (inherited-CI mitigation)
```
No PR comments in v1: the verdict surfaces only via the Actions **check conclusion**
and `$GITHUB_STEP_SUMMARY`. (`contents: read` is sufficient for the check
conclusion; we deliberately do not request `checks: write` or `pull-requests: write`.)

### Dependency-install contract (base-pinned, no PR-controlled execution)
- Package-manager command comes from the **base** revision.
- Package manifest + lockfile come from the **base** revision.
- **No `npm install`; no floating tags; no arbitrary `npx` download.**
- **No PR-controlled `.npmrc`, package scripts, config, or lifecycle hooks.**
- v1 mandates **`npm ci --ignore-scripts`** (lifecycle/install scripts disabled).
- **No cache shared with privileged workflows.**

---

## Budget evidence (honest scope)

Tier 3 independently proves **code evidence only**: frozen policy, scope, baseline,
clean replay, CI verdict. Agent-side telemetry remains advisory: model, local
gateway cost, call count, agent-reported cap status. Until there is a trusted
gateway / central ledger, **no agent-side spend field may affect the Proof Gate
verdict**, and we must **not** claim "independent budget enforcement." The hard
spend cap is still enforced locally at run time by the gateway 429; that is a
local-run guarantee, not a CI-attested one.

---

## Acceptance tests (all must pass before Tier 3 ships)

Extend the existing `check(name, pass)` style, driving the future
`runcap ci --mode adjudicate` against fixtures in temp git repos with a real
base/head.

1. **Forged receipt is ignored.** Hand-written `receipt.json` = VERIFIED_STRONG, but
   the diff does not fix the failing task -> adjudicator's replay -> UNVERIFIED ->
   **BLOCKED**; claimed status appears only under `agent_telemetry`.
2. **Forged advisory artifact is ignored (headline).** Malicious telemetry claiming
   `replay_exit:0` + `status:VERIFIED_STRONG` while the real replay fails -> **BLOCKED**;
   forged values appear only under `agent_telemetry`, never in `code_evidence`/`reasons`.
3. **Gate runs without telemetry (req. 1/2).** Optional telemetry is missing,
   corrupt, unavailable, or intentionally skipped -> adjudicator still runs and
   reports a verdict; `agent_telemetry.available:false`; verdict unchanged.
4. **Verifier change -> human gate.** Diff edits the verify file / a `protect` path
   -> `HUMAN_APPROVAL_REQUIRED`.
5. **Policy change -> human gate.** Diff edits `.runcap/mission.yaml` ->
   `HUMAN_APPROVAL_REQUIRED`.
6. **Workflow change -> human gate.** Diff edits `.github/workflows/*.yml` ->
   `HUMAN_APPROVAL_REQUIRED`.
7. **Dependency change -> human gate.** Diff edits `package.json`/lockfile ->
   `HUMAN_APPROVAL_REQUIRED`.
8. **HUMAN_APPROVAL_REQUIRED returns success/neutral (NOT failure).** Assert the
   Action conclusion is success/neutral, the summary says a human CODEOWNER review is
   required and names the gated path, and it does NOT imply Runcap grants approval.
9. **Honest allowed diff -> PASS.** Diff entirely within `allow`; baseline fails;
   adjudicator's replay passes -> `VERIFIED_STRONG` -> **PASS**.
10. **Out-of-scope diff -> BLOCKED.** Path outside `allow` (not gated) ->
    scope_violations non-empty -> **BLOCKED**.
11. **Baseline already passes -> no strong proof.** Verifier passes at base SHA
    before any change -> capped at `VERIFIED_WEAK`; STRONG impossible.
12. **Replay fails in clean CI -> BLOCKED.** Pass existed only in the agent's dirty
    tree; clean base+allowed-diff replay fails -> **BLOCKED**.
13. **Cost/exit telemetry cannot grade.** Mutating cost (-> $0, -> $9999) or flipping
    a reported exit does NOT change the verdict for any fixture; agent-claimed
    budget-cap status cannot affect the proof verdict.
14. **Two sources shown separately.** Rendered verdict has a "Code evidence:
    recomputed by CI" section and an "Agent-side telemetry: untrusted, advisory"
    section, distinctly labelled.
15. **Provenance recorded.** Verdict has base_sha, head_sha, policy_hash, action_sha,
    workflow_run_id, job_id; `truth` = `..._by_adjudicator_replay`;
    `github_sha_diagnostic` present but unused for replay identity.
16. **SHA cannot be redirected by artifact/receipt.** Feed a receipt/telemetry with a
    different base/head SHA -> replay uses PR-event SHAs; artifact SHAs ignored.
    Separately: unresolved PR identity -> **BLOCKED** (fail closed).
17. **Old-base evidence rejected / branch must be up to date.** Assert the hardened
    profile requires branch-up-to-date-before-merge; evidence produced against a
    superseded base is not merge-eligible. (Merge queue unsupported in v1.)
18. **Diff-smuggling rejected (one sub-fixture each).** `D` delete, `R` rename, `C`
    copy, `T` type-change, symlink, mode/exec-bit change, submodule pointer, binary
    patch, LFS pointer change -> each rejected -> **BLOCKED** with
    `code_evidence.diff_application` naming the reason. Only `A`/`M` regular UTF-8
    text files in allow scope are accepted.
19. **No privileged permissions in the reference workflow (static check).** Asserts
    `pull_request` (not `pull_request_target`); `permissions: contents: read` only
    (no `pull-requests`/`checks`/`issues`/`id-token`); no `secrets:` exposed; GitHub-
    hosted runner only (no `runs-on: self-hosted`); a `timeout-minutes` is present.
20. **Dependency install cannot execute PR-controlled scripts/config.** Install uses
    base manifest/lockfile + base pkg-manager cmd with `--ignore-scripts`; a
    PR-added lifecycle script / `.npmrc` / config is NOT executed.
21. **Network activity is not claimed to be prevented.** A doc/test assertion: the
    rendered verdict and docs do NOT claim network isolation or exfiltration
    prevention; they state these are inherited CI risks, out of scope.
22. **Un-hardened / unverified install fails closed.** No branch protection / required
    check / CODEOWNERS, OR detection cannot confirm them -> `INSTALLATION_NOT_HARDENED`
    / `HARDENING_UNVERIFIED`; strict mode exits non-zero; never renders PASS. Advisory
    mode emits `ADVISORY_REPLAY_PASSED` + `Hardening: unverified` + `Not a Proof Gate
    verdict`, never PASS.

---

## What changes in code (for the LATER build step, NOT now)

Listed so the plan is actionable; not to be implemented until approved:
- `evaluatePolicyVerdict`: add `HUMAN_APPROVAL_REQUIRED` and `INSTALLATION_NOT_HARDENED`;
  grade off a passed-in **CI-recomputed evidence** object built from the adjudicator's
  own replay, never the agent receipt. Keep the receipt path only for the local
  `mission run` developer loop, clearly labelled "local, advisory."
- New CI evidence builder (adjudicator core): port `freezeTaskContract` +
  `checkVerificationIntegrity` + `verifyInCleanWorktree` to source ALL inputs from
  base SHA, compute the diff itself, reject diff-smuggling, install base-pinned deps
  with `--ignore-scripts`, and run baseline + replay itself.
- Diff applier with a hard allowlist: `A`/`M` regular UTF-8 text blobs in allow scope
  only; reject D/R/C/T, symlink, mode, submodule, binary, LFS.
- Hardening detector: best-effort read of branch protection / required check / up-to-
  date / stale-approval / CODEOWNERS coverage / no-bypass -> `HARDENED |
  HARDENING_UNVERIFIED | INSTALLATION_NOT_HARDENED`; never infers HARDENED.
- `runcap ci` gains `--mode adjudicate` (the gate) and `--advisory`. The composite
  `action.yml` ships ONE required job, `contents: read` only, GitHub-hosted,
  `timeout-minutes`, no `needs:` on any executor.
- Ship a hardened reference workflow template + sample CODEOWNERS + a documented
  branch-protection/ruleset profile (protected branch, required check, up-to-date,
  stale-approval dismissal, CODEOWNERS over trust paths, no-bypass, action pinned by
  SHA).

---

## Stop line

After Tier 3 (CI-attested verdict via a single required adjudicator job under a
documented hardened profile; verdict computed only by the adjudicator's own replay),
the product is a coherent **proof gate** for public launch and design partners. Do
NOT add in this scope: cryptographic signing/keyless attestation (own threat model,
next), network isolation, merge-queue support, orchestration, benchmark/model-ranking,
or a SaaS dashboard.
