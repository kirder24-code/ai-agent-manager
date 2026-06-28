// Tier 3: the independent CI adjudicator (`runcap ci --mode adjudicate`).
//
// `runcap ci` (Tier 2) recomputes the PASS/BLOCKED *logic* from the policy, but
// it grades the integrity *facts* that the agent wrote into receipt.json. A
// forged "VERIFIED_STRONG" receipt therefore grades PASS. This module closes
// that gap: it recomputes the facts itself, in CI, from the BASE commit of the
// pull request - the last state a human reviewer approved - and never trusts a
// number the agent stamped on its own receipt.
//
// What it trusts:  the base/head SHAs from the trusted `pull_request` event, and
//                  the policy + verifier + lockfile read from the BASE commit.
// What it does NOT trust:  receipt.json, gateway telemetry, artifact-reported
//                  SHAs, the head-side policy/verifier/workflow, or any agent
//                  environment value. Agent telemetry is carried as advisory
//                  only and can never move the verdict.
//
// Three verdicts:
//   PASS                     - every changed path is an in-scope regular text
//                              edit, the task genuinely failed at base, and the
//                              change makes the base-pinned verifier pass in a
//                              clean base checkout.
//   BLOCKED                  - any structurally unsafe change (delete/rename/
//                              symlink/submodule/mode/binary/LFS), an out-of-
//                              scope edit, a meaningless baseline, or a replay
//                              that does not reproduce the pass.
//   HUMAN_APPROVAL_REQUIRED  - the change touches the rules or the evidence
//                              themselves (policy, workflow, verifier, protected
//                              or dependency files). Runcap declines to issue an
//                              automated proof; a human CODEOWNER must decide.
//
// This module imports only node builtins + js-yaml + validatePolicy/policyMeta
// from policy.mjs (one direction, no cycle). It never imports mission-control.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { validatePolicy, policyMeta } from "./policy.mjs";

const POLICY_FILENAMES = ["mission.yaml", "mission.yml", "mission.json"];

// Paths that are the rules or the evidence themselves. An edit to any of these
// is never auto-approved: a human CODEOWNER must sign off, because changing the
// verifier, the policy, or the workflow changes what "passing" even means.
const DEPENDENCY_FILES = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json",
  "yarn.lock", "pnpm-lock.yaml", "bun.lockb"
];

// The same protected globs the in-terminal guard uses (tests/config), so the
// adjudicator and the local guard agree on what counts as evidence.
const PROTECTED_GLOBS = [
  /(^|\/)[^/]*\.test\.[mc]?[jt]sx?$/,
  /(^|\/)[^/]*\.spec\.[mc]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)jest\.config\./,
  /(^|\/)vitest\.config\./
];

const LFS_POINTER_SIGNATURE = "version https://git-lfs.github.com/spec";

// --- git plumbing (local, spawn-based; no influence from agent env) ---------

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (e) => resolve({ text: "", error: e.message }));
    child.on("close", (code) => resolve({ text: stdout, error: code === 0 ? null : stderr.trim() }));
  });
}

// Exact bytes of a blob at a commit. Unlike git(), this never trims, so applied
// file content is byte-identical to what is in the head tree.
function gitShowBytes(rev, relPath, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", ["show", `${rev}:${relPath}`], { cwd, shell: false });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (e) => resolve({ ok: false, buffer: null, error: e.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true, buffer: Buffer.concat(chunks), error: null } : { ok: false, buffer: null, error: stderr.trim() }));
  });
}

async function revExists(rev, cwd) {
  const r = await git(["cat-file", "-e", `${rev}^{commit}`], cwd);
  return r.error === null;
}

async function blobExists(rev, relPath, cwd) {
  const r = await git(["cat-file", "-e", `${rev}:${relPath}`], cwd);
  return r.error === null;
}

// Run the base-pinned verify command in a directory. Mirrors mission-control's
// runShell so a verifier behaves identically here and in the terminal guard.
function runShell(commandString, cwd) {
  const started = Date.now();
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/c", commandString] : ["-c", commandString];
  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, AIM_WRAPPED: "1" }, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { const t = c.toString(); stdout += t; });
    child.stderr?.on("data", (c) => { const t = c.toString(); stderr += t; });
    child.on("error", (e) => resolve({ stdout, stderr: stderr + `\n${e.message}`, exitCode: 127, durationMs: Date.now() - started }));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1, durationMs: Date.now() - started }));
  });
}

// --- SHA resolution (trusted PR event ONLY) ---------------------------------

// The ONLY trusted source of base/head is the `pull_request` event payload that
// GitHub itself writes to $GITHUB_EVENT_PATH. We never read a SHA from the
// receipt, an artifact, or any agent-controlled value. Explicit flags exist for
// local runs and tests; on a real PR job the event payload wins.
function resolveShas({ baseFlag, headFlag } = {}) {
  if (baseFlag && headFlag) {
    return { baseSha: baseFlag, headSha: headFlag, shaSource: "explicit_flags" };
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"));
      const base = event?.pull_request?.base?.sha;
      const head = event?.pull_request?.head?.sha;
      if (base && head) {
        // pull_request_target would run with base-repo secrets against head code.
        // We only adjudicate the read-only `pull_request` event.
        const trusted = eventName === "pull_request" || eventName === undefined;
        return { baseSha: base, headSha: head, shaSource: trusted ? "github_pull_request_event" : `untrusted_event:${eventName}` };
      }
    } catch { /* fall through to unresolved */ }
  }
  return { baseSha: null, headSha: null, shaSource: "unresolved" };
}

// --- policy loaded FROM THE BASE COMMIT -------------------------------------

// Read and parse the policy as it exists at the base commit - the rules the
// reviewer last approved - not the head-side policy the PR could have rewritten.
async function loadPolicyFromBase(baseSha, explicitPath, cwd) {
  const candidates = explicitPath ? [explicitPath] : POLICY_FILENAMES.map((n) => path.posix.join(".runcap", n));
  for (const rel of candidates) {
    if (!(await blobExists(baseSha, rel, cwd))) continue;
    const got = await gitShowBytes(baseSha, rel, cwd);
    if (!got.ok) continue;
    const raw = got.buffer.toString("utf8");
    let policy;
    try {
      policy = rel.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
    } catch (e) {
      return { error: `policy at base:${rel} did not parse: ${e.message}` };
    }
    if (!policy || typeof policy !== "object") return { error: `policy at base:${rel} is not an object.` };
    return {
      result: { policy, raw, hash: createHash("sha256").update(raw).digest("hex"), source: rel }
    };
  }
  return { error: "no policy (.runcap/mission.{yaml,yml,json}) found at the base commit." };
}

// --- diff classification ----------------------------------------------------

function isProtectedPath(relPath, extraProtected) {
  if (extraProtected.some((p) => relPath === p || relPath.startsWith(p.replace(/\/?$/, "/")))) return true;
  return PROTECTED_GLOBS.some((re) => re.test(relPath));
}

function withinAllowed(relPath, allowed) {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((a) => relPath === a || relPath.startsWith(a.replace(/\/?$/, "/")));
}

function isWorkflowPath(relPath) {
  return relPath.startsWith(".github/workflows/");
}

function isPolicyPath(relPath) {
  return POLICY_FILENAMES.some((n) => relPath === path.posix.join(".runcap", n));
}

function isDependencyPath(relPath) {
  const base = relPath.split("/").pop();
  return DEPENDENCY_FILES.includes(base);
}

// Walk `git diff --raw -z --find-renames base head`. -z gives NUL-delimited
// fields; rename/copy records carry two paths, everything else one.
function parseRawDiff(buffer) {
  const parts = buffer.toString("utf8").split("\0");
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta || meta[0] !== ":") { i++; continue; }
    // ":<oldmode> <newmode> <oldsha> <newsha> <status>"
    const fields = meta.slice(1).split(/\s+/);
    const oldMode = fields[0];
    const newMode = fields[1];
    const statusField = fields[4] ?? "";
    const statusChar = statusField[0] ?? "";
    i++;
    if (statusChar === "R" || statusChar === "C") {
      const srcPath = parts[i]; const dstPath = parts[i + 1];
      i += 2;
      entries.push({ statusChar, statusField, oldMode, newMode, srcPath, path: dstPath });
    } else {
      const p = parts[i];
      i += 1;
      entries.push({ statusChar, statusField, oldMode, newMode, path: p });
    }
  }
  return entries;
}

function looksBinary(buffer) {
  // A NUL byte in the first 8KB is git's own "binary" heuristic.
  const slice = buffer.subarray(0, 8192);
  return slice.includes(0);
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

// Classify one diff entry into candidate | blocked | human, with a reason.
// Structural rejects come first (never auto-approvable), then sensitive paths
// (human gate), then scope (block), then the in-scope regular edit (candidate).
async function classifyEntry(entry, { headSha, cwd, protectedPaths, allowed, verifierPaths }) {
  const p = entry.path;
  const s = entry.statusChar;

  if (s === "D") return { path: p, class: "blocked", detail: "file deleted (deletions are never auto-approved)" };
  if (s === "R") return { path: p, class: "blocked", detail: `file renamed from ${entry.srcPath} (renames are never auto-approved)` };
  if (s === "C") return { path: p, class: "blocked", detail: `file copied from ${entry.srcPath} (copies are never auto-approved)` };
  if (s === "T") return { path: p, class: "blocked", detail: "file type changed (type changes are never auto-approved)" };
  if (entry.newMode === "120000") return { path: p, class: "blocked", detail: "symlink (symlinks are never auto-approved)" };
  if (entry.newMode === "160000") return { path: p, class: "blocked", detail: "submodule/gitlink (submodules are never auto-approved)" };
  if (s === "M" && entry.oldMode !== entry.newMode) return { path: p, class: "blocked", detail: `mode change ${entry.oldMode} -> ${entry.newMode} (mode changes are never auto-approved)` };
  if (entry.newMode !== "100644") return { path: p, class: "blocked", detail: `non-regular file mode ${entry.newMode} (only plain 100644 text files can be auto-applied)` };
  if (s !== "A" && s !== "M") return { path: p, class: "blocked", detail: `unsupported diff status ${entry.statusField}` };

  // Content checks on the HEAD blob (the bytes we would apply).
  const got = await gitShowBytes(headSha, p, cwd);
  if (!got.ok) return { path: p, class: "blocked", detail: `could not read head blob: ${got.error}` };
  if (looksBinary(got.buffer)) return { path: p, class: "blocked", detail: "binary content (only UTF-8 text files can be auto-applied)" };
  if (!isValidUtf8(got.buffer)) return { path: p, class: "blocked", detail: "not valid UTF-8 (only UTF-8 text files can be auto-applied)" };
  const head = got.buffer.toString("utf8");
  if (head.startsWith(LFS_POINTER_SIGNATURE)) return { path: p, class: "blocked", detail: "Git LFS pointer (real content is not in the tree, cannot replay)" };

  // Sensitive-path human gate: the rules or the evidence themselves.
  if (isPolicyPath(p)) return { path: p, class: "human", detail: "edits the mission policy (the rules) - human CODEOWNER must approve" };
  if (isWorkflowPath(p)) return { path: p, class: "human", detail: "edits a GitHub workflow - human CODEOWNER must approve" };
  if (verifierPaths.includes(p)) return { path: p, class: "human", detail: "edits a verifier file (the evidence) - human CODEOWNER must approve" };
  if (isDependencyPath(p)) return { path: p, class: "human", detail: "edits a dependency manifest/lockfile - human CODEOWNER must approve" };
  if (isProtectedPath(p, protectedPaths)) return { path: p, class: "human", detail: "edits a protected/test/config path - human CODEOWNER must approve" };

  // In-scope regular text edit. Out-of-scope edits are blocked.
  if (!withinAllowed(p, allowed)) return { path: p, class: "blocked", detail: "outside the policy's allowed scope" };

  return { path: p, class: "candidate", detail: s === "A" ? "added in-scope text file" : "modified in-scope text file", blob: got.buffer };
}

// The concrete file paths a verify command names, resolved at the BASE commit so
// a head-side rename of the verifier cannot hide it from the human gate.
async function verifierFilesAtBase(verify, baseSha, cwd) {
  const tokens = String(verify).split(/\s+/).filter(Boolean);
  const files = [];
  for (const raw of tokens) {
    const tok = raw.replace(/^["']|["']$/g, "");
    if (!/[./]/.test(tok)) continue;
    const rel = tok.replace(/^\.\//, "");
    if (await blobExists(baseSha, rel, cwd)) {
      if (!files.includes(rel)) files.push(rel);
    }
  }
  return files;
}

// --- the replay -------------------------------------------------------------

// Baseline + replay in a throwaway worktree pinned at the base commit. Deps come
// from the base lockfile (npm ci --ignore-scripts: no lifecycle scripts, no
// floating install). Then the permitted candidate blobs are written in and the
// base-pinned verifier runs again. Truth comes only from this replay.
async function replay({ baseSha, candidates, verify, cwd }) {
  const tmpBase = await mkdtempWorktreeBase();
  const wt = path.join(tmpBase, `wt-${createHash("sha1").update(`${baseSha}${Date.now()}${Math.random()}`).digest("hex").slice(0, 8)}`);
  const add = await git(["worktree", "add", "--detach", wt, baseSha], cwd);
  if (add.error) {
    return { baselineFailed: null, replayPassed: null, dependencyInstall: "skipped_no_manifest", detail: `worktree add failed: ${add.error}`, ran: false };
  }
  try {
    // Base-pinned dependency install (only when the base has a lockfile).
    let dependencyInstall = "skipped_no_manifest";
    const hasPkg = existsSync(path.join(wt, "package.json"));
    const hasLock = existsSync(path.join(wt, "package-lock.json")) || existsSync(path.join(wt, "npm-shrinkwrap.json"));
    if (hasPkg && hasLock) {
      const ci = await runShell("npm ci --ignore-scripts --no-audit --no-fund", wt);
      dependencyInstall = ci.exitCode === 0 ? "npm_ci_ignore_scripts" : "failed";
      if (ci.exitCode !== 0) {
        return { baselineFailed: null, replayPassed: null, dependencyInstall, detail: "npm ci (base-pinned, --ignore-scripts) failed", ran: true };
      }
    }

    // 1. Baseline: the task must genuinely fail at base, or a later pass is meaningless.
    const baseline = await runShell(verify, wt);
    const baselineFailed = baseline.exitCode !== 0;

    // 2. Apply only the permitted candidate blobs from head.
    for (const c of candidates) {
      const dst = path.join(wt, c.path);
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, c.blob);
    }

    // 3. Replay the base-pinned verifier with the change applied.
    const after = await runShell(verify, wt);
    const replayPassed = after.exitCode === 0;

    return { baselineFailed, replayPassed, dependencyInstall, ran: true, detail: "baseline + replay completed in a clean base checkout" };
  } finally {
    await git(["worktree", "remove", "--force", wt], cwd);
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

async function mkdtempWorktreeBase() {
  const base = path.join(os.tmpdir(), `runcap-adj-${process.pid}-${Date.now()}`);
  await mkdir(base, { recursive: true });
  return base;
}

// --- agent telemetry: deliberately NOT read by the required gate ------------

// The agent's receipt is agent-controlled input. A forged "VERIFIED_STRONG"
// receipt is exactly the Tier 2 attack this gate exists to defeat, so the
// required job must never parse it: not to grade the verdict (it never did),
// and not even to display it, because reading attacker-controlled JSON in the
// mandatory check is needless attack surface (a malformed or enormous receipt
// could crash or stall the only gate guarding the merge). The verdict therefore
// reports a constant, telling a reviewer plainly that no receipt was consulted.
// A later, NON-required report layer may surface advisory telemetry; the gate
// that decides the merge does not.
const GATE_AGENT_TELEMETRY = Object.freeze({
  present: false,
  influence_on_verdict: "none",
  truth: "agent_receipt_not_read_by_required_gate"
});

// --- the adjudicator --------------------------------------------------------

export async function adjudicate({ cwd = process.cwd(), baseFlag, headFlag, policyPath } = {}) {
  const hardening = { required_profile: "documented", runtime_attestation: "not_performed_in_pr_job" };
  const agentTelemetry = GATE_AGENT_TELEMETRY;

  const base = (verdict, reasons, extra = {}) => ({
    schema: "runcap.ci-verdict/v1",
    verdict,
    reasons,
    repository_hardening: hardening,
    agent_telemetry: agentTelemetry,
    truth: "recomputed_by_adjudicator_from_base_sha",
    ...extra
  });

  // 1. Resolve base/head from the trusted PR event only.
  const { baseSha, headSha, shaSource } = resolveShas({ baseFlag, headFlag });
  if (!baseSha || !headSha) {
    return base("BLOCKED", ["Could not resolve base/head from the trusted pull_request event (and no explicit --base/--head). Refusing to adjudicate."], { sha_source: shaSource });
  }
  if (shaSource.startsWith("untrusted_event")) {
    return base("BLOCKED", [`Refusing to adjudicate an untrusted event (${shaSource}). Only the read-only pull_request event is adjudicated.`], { base_sha: baseSha, head_sha: headSha, sha_source: shaSource });
  }
  if (!(await revExists(baseSha, cwd)) || !(await revExists(headSha, cwd))) {
    return base("BLOCKED", ["base or head commit is not present in the checkout (fetch depth too shallow?). Refusing to adjudicate."], { base_sha: baseSha, head_sha: headSha, sha_source: shaSource });
  }

  // 2. Policy from the BASE commit (the approved rules), then validate it.
  const loaded = await loadPolicyFromBase(baseSha, policyPath, cwd);
  if (loaded.error) {
    return base("BLOCKED", [loaded.error], { base_sha: baseSha, head_sha: headSha, sha_source: shaSource });
  }
  const policyResult = loaded.result;
  const { ok, errors } = validatePolicy(policyResult.policy);
  if (!ok) {
    return base("BLOCKED", errors.map((e) => `base policy invalid: ${e}`), { base_sha: baseSha, head_sha: headSha, sha_source: shaSource, policy: policyMeta(policyResult) });
  }
  const verification = policyResult.policy.verification ?? {};
  const verify = verification.command;
  const protectedPaths = Array.isArray(verification.protect) ? verification.protect : [];
  const allowed = Array.isArray(verification.allow) ? verification.allow : [];
  const verifierPaths = await verifierFilesAtBase(verify, baseSha, cwd);

  // 3. Compute the base..head diff ourselves and classify every entry.
  const rawDiff = await new Promise((resolve) => {
    const child = spawn("git", ["diff", "--raw", "-z", "--find-renames", baseSha, headSha], { cwd, shell: false });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => resolve(Buffer.alloc(0)));
    child.on("close", () => resolve(Buffer.concat(chunks)));
  });
  const entries = parseRawDiff(rawDiff);
  const classified = [];
  for (const entry of entries) {
    classified.push(await classifyEntry(entry, { headSha, cwd, protectedPaths, allowed, verifierPaths }));
  }
  const publicClassification = classified.map(({ blob, ...rest }) => rest);

  const blocked = classified.filter((c) => c.class === "blocked");
  const human = classified.filter((c) => c.class === "human");
  const candidates = classified.filter((c) => c.class === "candidate");

  const policyBlock = policyMeta(policyResult);

  // 4. Verdict precedence: any structural/scope reject blocks; else a sensitive
  //    path sends it to a human; else we must reproduce the proof ourselves.
  if (blocked.length) {
    return base("BLOCKED", blocked.map((b) => `${b.path}: ${b.detail}`), {
      base_sha: baseSha, head_sha: headSha, sha_source: shaSource, policy: policyBlock,
      diff_classification: publicClassification
    });
  }
  if (human.length) {
    return base("HUMAN_APPROVAL_REQUIRED",
      ["Runcap declined to issue an automated proof: the change touches the rules or the evidence themselves. A human CODEOWNER must approve.", ...human.map((h) => `${h.path}: ${h.detail}`)],
      { base_sha: baseSha, head_sha: headSha, sha_source: shaSource, policy: policyBlock, diff_classification: publicClassification });
  }
  if (candidates.length === 0) {
    return base("BLOCKED", ["No applicable code change to adjudicate (empty or non-content diff)."], {
      base_sha: baseSha, head_sha: headSha, sha_source: shaSource, policy: policyBlock, diff_classification: publicClassification
    });
  }

  // 5. Replay from the base commit with only the candidate blobs applied.
  const r = await replay({ baseSha, candidates, verify, cwd });
  const codeEvidence = {
    truth: "recomputed_by_adjudicator_from_base_sha",
    baseline_failed: r.baselineFailed,
    replay_passed: r.replayPassed,
    dependency_install: r.dependencyInstall,
    candidate_files: candidates.map((c) => c.path),
    detail: r.detail
  };

  const reasons = [];
  if (r.dependencyInstall === "failed") reasons.push("Base-pinned `npm ci --ignore-scripts` failed: cannot establish a clean baseline.");
  if (r.baselineFailed === false) reasons.push("Baseline already green: the verifier passed at the base commit, so a post-change pass proves nothing.");
  if (r.replayPassed !== true) reasons.push("Replay did not pass: the change did not make the base-pinned verifier pass in a clean base checkout.");

  if (reasons.length) {
    return base("BLOCKED", reasons, { base_sha: baseSha, head_sha: headSha, sha_source: shaSource, policy: policyBlock, diff_classification: publicClassification, code_evidence: codeEvidence });
  }

  return base("PASS",
    [`Verifier failed at base and passed after applying ${candidates.length} in-scope text change(s), recomputed in a clean base checkout.`],
    { base_sha: baseSha, head_sha: headSha, sha_source: shaSource, policy: policyBlock, diff_classification: publicClassification, code_evidence: codeEvidence });
}

// Markdown lines for the PR step summary + terminal print.
export function formatAdjudication(v) {
  const lines = [
    `Runcap CI adjudication (independent replay from base)`,
    `====================================================`,
    `Verdict:     ${v.verdict}`,
    `Base SHA:    ${v.base_sha ?? "unresolved"}  (source: ${v.sha_source ?? "unknown"})`,
    `Head SHA:    ${v.head_sha ?? "unresolved"}`
  ];
  if (v.policy) {
    lines.push(`Policy:      ${v.policy.mission?.name ?? "(unnamed)"} - hash ${v.policy.hash}`);
  }
  if (v.code_evidence) {
    const ce = v.code_evidence;
    lines.push(`Replay:      baseline_failed=${ce.baseline_failed}  replay_passed=${ce.replay_passed}  deps=${ce.dependency_install}`);
  }
  lines.push(`Hardening:   required_profile=${v.repository_hardening.required_profile}, runtime_attestation=${v.repository_hardening.runtime_attestation}`);
  lines.push(`Agent receipt: not read by this required gate (verdict is recomputed from the base commit).`);
  if (Array.isArray(v.reasons) && v.reasons.length) {
    lines.push(v.verdict === "PASS" ? `Why:` : `Why ${v.verdict}:`);
    for (const r of v.reasons) lines.push(`  - ${r}`);
  }
  return lines;
}

// Exit code: PASS and HUMAN_APPROVAL_REQUIRED are non-failing (the human gate is
// a success/neutral outcome that hands authority to a CODEOWNER); BLOCKED fails.
export function exitCodeFor(verdict) {
  return verdict === "BLOCKED" ? 1 : 0;
}
