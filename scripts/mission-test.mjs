// Proves a policy-bound mission grades a real run into a PASS/BLOCKED verdict and
// that the verdict drives the process exit code (so CI fails on a blocked mission).
// Everything runs offline through the mock cap gateway inside a throwaway git repo:
//   - an honest fix within scope, under cap        → PASS, exit 0
//   - an agent that rewrites the verifier           → BLOCKED (VERIFIER_COMPROMISED)
//   - an edit outside the declared allow scope      → BLOCKED (out of scope)
//   - a mission whose first call trips the hard cap → BLOCKED (budget guard)
// It also drives the real `bin/runcap.mjs` so the exit codes and the GitHub
// Action's `runcap ci` PR summary are tested as a reviewer would see them.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";

const SRC_DIR = process.env.RUNCAP_SRC ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const BIN = path.join(SRC_DIR, "..", "bin", "runcap.mjs");

const tmp = mkdtempSync(path.join(os.tmpdir(), "runcap-mission-"));
process.chdir(tmp);

mkdirSync(path.join(tmp, "app"), { recursive: true });
mkdirSync(path.join(tmp, ".runcap"), { recursive: true });
// broken.mjs starts wrong, so the task genuinely fails on baseline.
writeFileSync(path.join(tmp, "app", "broken.mjs"), "export const ok = false;\n");
writeFileSync(path.join(tmp, "app", "verify.mjs"),
  "import { ok } from './broken.mjs'; import assert from 'node:assert'; assert.strictEqual(ok, true, 'not fixed'); console.log('ok');\n");
// A tracked file OUTSIDE the allow scope: editing it must trip the scope check.
// (The guard reads `git diff --name-status`, which sees tracked edits - the
// honest unit of "out of scope" for this scenario.)
writeFileSync(path.join(tmp, "app", "other.mjs"), "export const other = 0;\n");

const spend = (msg) =>
  "const b=process.env.OPENAI_BASE_URL;await fetch(`${b}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer x'},body:JSON.stringify({model:'gpt-4o',messages:[{role:'user',content:'" + msg + "'}]})}).then(r=>r.text());";

// Honest agent: spends, fixes the source file (the one allowed change).
writeFileSync(path.join(tmp, "agent-fix.mjs"),
  spend("fix it") + "const {writeFile}=await import('node:fs/promises');await writeFile('app/broken.mjs','export const ok = true;\\n');\n");
// Cheating agent: rewrites the VERIFIER so it always passes instead of fixing the bug.
writeFileSync(path.join(tmp, "agent-cheat.mjs"),
  spend("cheat") + "const {writeFile}=await import('node:fs/promises');await writeFile('app/verify.mjs','console.log(\"ok\");\\n');\n");
// Out-of-scope agent: fixes the bug (verify passes) BUT also edits a tracked file outside `allow`.
writeFileSync(path.join(tmp, "agent-scope.mjs"),
  spend("scope") + "const {writeFile}=await import('node:fs/promises');await writeFile('app/broken.mjs','export const ok = true;\\n');await writeFile('app/other.mjs','export const other = 1;\\n');\n");

// The mission policy a reviewer commits to the repo.
const POLICY = `version: v1
identity:
  project: checkout
  team: payments
mission:
  name: Fix the failing checkout test
  task_class: bugfix
budget:
  mission_hard_limit_usd: 5
  max_llm_calls: 12
verification:
  command: "node app/verify.mjs"
  guard: strict
  protect: ["app/verify.mjs"]
  allow: ["app/broken.mjs"]
`;
writeFileSync(path.join(tmp, ".runcap", "mission.yaml"), POLICY);

// A second policy with a hair-thin cap, so the gateway trips the budget guard pre-flight.
const TINY_POLICY = POLICY.replace("mission_hard_limit_usd: 5", "mission_hard_limit_usd: 0.0000001");
writeFileSync(path.join(tmp, ".runcap", "mission-tiny.yaml"), TINY_POLICY);

// Commit a baseline so the guard has a real commit + clean tree to check against.
const g = (...a) => execFileSync("git", a, { cwd: tmp, stdio: "pipe" });
g("init", "-q");
g("config", "user.email", "test@runcap.local");
g("config", "user.name", "runcap-test");
g("add", "-A");
g("commit", "-qm", "baseline");

let failures = 0;
const check = (name, pass, detail) => { if (!pass) failures++; console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const { runOutcome } = await import(path.join(SRC_DIR, "mission-control.mjs"));
const { loadPolicy } = await import(path.join(SRC_DIR, "policy.mjs"));

// Each scenario starts from the committed baseline so one run's edits (the cheat
// run's rewritten verifier especially) never leak into the next.
const resetToBaseline = () => { g("checkout", "-f", "HEAD"); g("clean", "-fdq", "-e", ".runcap"); };

const loaded = loadPolicy(tmp);

// 1. Honest fix, within scope, under cap → PASS with a strong verification.
const fix = await runOutcome({ task: "fix ok", verify: "node app/verify.mjs", command: ["node", "agent-fix.mjs"], label: "mission-fix", mock: true, guard: true, protect: ["app/verify.mjs"], allow: ["app/broken.mjs"], capUsd: 5, policy: loaded });
check("honest fix verifies", fix.receipt.outcome === "VERIFIED", `outcome=${fix.receipt.outcome}`);
check("honest fix grades VERIFIED_STRONG", fix.receipt.verificationIntegrity.status === "VERIFIED_STRONG", `status=${fix.receipt.verificationIntegrity.status}`);
check("honest fix mission verdict PASS", fix.receipt.policy?.verdict === "PASS", JSON.stringify(fix.receipt.policy?.reasons));
check("receipt carries the policy hash", /^[0-9a-f]{64}$/.test(fix.receipt.policy?.hash ?? ""), fix.receipt.policy?.hash);
check("receipt carries org attribution", fix.receipt.policy?.identity?.project === "checkout" && fix.receipt.policy?.identity?.team === "payments");
check("receipt bumps to v0.3 schema", fix.receipt.schema === "runcap.outcome-receipt/v0.3", fix.receipt.schema);

// 2. Cheat by rewriting the verifier → BLOCKED, VERIFIER_COMPROMISED.
resetToBaseline();
const cheat = await runOutcome({ task: "fix ok", verify: "node app/verify.mjs", command: ["node", "agent-cheat.mjs"], label: "mission-cheat", mock: true, guard: true, protect: ["app/verify.mjs"], allow: ["app/broken.mjs"], capUsd: 5, policy: loaded });
check("cheat run mission verdict BLOCKED", cheat.receipt.policy?.verdict === "BLOCKED", `verdict=${cheat.receipt.policy?.verdict}`);
check("cheat run names VERIFIER_COMPROMISED", (cheat.receipt.policy?.reasons ?? []).some((r) => r.includes("VERIFIER_COMPROMISED")), JSON.stringify(cheat.receipt.policy?.reasons));

// 3. Edit outside the declared scope → BLOCKED, out-of-scope.
resetToBaseline();
const scope = await runOutcome({ task: "fix ok", verify: "node app/verify.mjs", command: ["node", "agent-scope.mjs"], label: "mission-scope", mock: true, guard: true, protect: ["app/verify.mjs"], allow: ["app/broken.mjs"], capUsd: 5, policy: loaded });
check("out-of-scope run mission verdict BLOCKED", scope.receipt.policy?.verdict === "BLOCKED", `verdict=${scope.receipt.policy?.verdict}`);
check("out-of-scope run names the scope breach", (scope.receipt.policy?.reasons ?? []).some((r) => r.toLowerCase().includes("scope")), JSON.stringify(scope.receipt.policy?.reasons));

// 4. A hair-thin cap trips the gateway budget guard → BLOCKED, budget reason.
resetToBaseline();
const tinyLoaded = loadPolicy(tmp, ".runcap/mission-tiny.yaml");
const broke = await runOutcome({ task: "fix ok", verify: "node app/verify.mjs", command: ["node", "agent-fix.mjs"], label: "mission-broke", mock: true, guard: true, protect: ["app/verify.mjs"], allow: ["app/broken.mjs"], capUsd: 0.0000001, policy: tinyLoaded });
check("tiny cap trips the budget guard", broke.receipt.cost.budgetGuardTripped === true, `tripped=${broke.receipt.cost.budgetGuardTripped}`);
check("budget trip mission verdict BLOCKED", broke.receipt.policy?.verdict === "BLOCKED", `verdict=${broke.receipt.policy?.verdict}`);
check("budget trip names the budget guard", (broke.receipt.policy?.reasons ?? []).some((r) => r.toLowerCase().includes("budget")), JSON.stringify(broke.receipt.policy?.reasons));

// 5. The real bin must exit 0 on PASS and 1 on BLOCKED so CI fails on a bad mission.
const runBin = (args, extraEnv = {}) => {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { cwd: tmp, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout: String(stdout) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
};

resetToBaseline();
const binPass = runBin(["mission", "run", "--mock", "--", "node", "agent-fix.mjs"]);
check("`runcap mission run` exits 0 on a PASS mission", binPass.code === 0, `code=${binPass.code}`);
check("PASS run prints the verdict", /Mission verdict: PASS/.test(binPass.stdout), binPass.stdout.slice(-200));

resetToBaseline();
const binBlock = runBin(["mission", "run", "--mock", "--", "node", "agent-cheat.mjs"]);
check("`runcap mission run` exits 1 on a BLOCKED mission", binBlock.code === 1, `code=${binBlock.code}`);

// 6. `runcap ci` (the GitHub Action's grader) must write the PR summary and exit 1 on BLOCKED.
//    It grades the latest receipt on disk - which the BLOCKED cheat run just wrote.
const summaryFile = path.join(tmp, "step-summary.md");
writeFileSync(summaryFile, "");
const ci = runBin(["ci", "--policy", ".runcap/mission.yaml"], { GITHUB_STEP_SUMMARY: summaryFile });
check("`runcap ci` exits 1 when the graded receipt is BLOCKED", ci.code === 1, `code=${ci.code}`);
const summary = readFileSync(summaryFile, "utf8");
check("`runcap ci` writes a PR summary to GITHUB_STEP_SUMMARY", /Runcap mission verdict: BLOCKED/.test(summary), summary.slice(0, 200));

console.log("\n" + (failures === 0 ? "ALL MISSION TESTS PASSED" : `${failures} MISSION TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
