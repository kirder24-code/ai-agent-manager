// Proves src/policy.mjs parses, validates, and grades correctly. Pure unit test:
// no gateway, no git, no agent - just the policy module over hand-built inputs.
// Covers: YAML parse + hash, .json fallback, required-field validation, the
// guard/scope warnings, and every BLOCK condition in evaluatePolicyVerdict.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";

const SRC_DIR = process.env.RUNCAP_SRC ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const { loadPolicy, validatePolicy, evaluatePolicyVerdict, policyMeta } = await import(path.join(SRC_DIR, "policy.mjs"));

let failures = 0;
const check = (name, pass, detail) => { if (!pass) failures++; console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const tmp = mkdtempSync(path.join(os.tmpdir(), "runcap-policy-"));
mkdirSync(path.join(tmp, ".runcap"), { recursive: true });

const VALID_YAML = `version: v1
identity:
  project: checkout
  team: payments
mission:
  name: Fix the failing checkout test
  task_class: bugfix
budget:
  mission_hard_limit_usd: 10
  max_llm_calls: 12
  max_runtime_minutes: 30
verification:
  command: "node app/verify.mjs"
  guard: strict
  protect: ["tests/**"]
  allow: ["src/checkout/**"]
`;

// 1. Valid YAML loads, parses, hashes, validates clean.
writeFileSync(path.join(tmp, ".runcap", "mission.yaml"), VALID_YAML);
const loaded = loadPolicy(tmp);
check("loadPolicy finds .runcap/mission.yaml", loaded && loaded.source.endsWith("mission.yaml"));
check("loadPolicy computes a sha256 hash", /^[0-9a-f]{64}$/.test(loaded.hash), loaded.hash);
check("valid policy parses mission.name", loaded.policy.mission.name === "Fix the failing checkout test");
const v1 = validatePolicy(loaded.policy);
check("valid policy validates ok", v1.ok === true, JSON.stringify(v1.errors));
check("valid policy with allow has no scope warning", !v1.warnings.some((w) => w.includes("allow is empty")));
const meta = policyMeta(loaded);
check("policyMeta carries identity + hash", meta.identity.project === "checkout" && meta.hash === loaded.hash);
check("policyMeta carries the limits", meta.limits.mission_hard_limit_usd === 10 && meta.limits.max_llm_calls === 12);

// 2. .json fallback parses with native JSON.parse (no parser needed).
const tmp2 = mkdtempSync(path.join(os.tmpdir(), "runcap-policy-json-"));
mkdirSync(path.join(tmp2, ".runcap"), { recursive: true });
writeFileSync(path.join(tmp2, ".runcap", "mission.json"), JSON.stringify({
  version: "v1",
  mission: { name: "json mission" },
  budget: { mission_hard_limit_usd: 5 },
  verification: { command: "npm test" }
}));
const jsonLoaded = loadPolicy(tmp2);
check("loadPolicy reads .json fallback", jsonLoaded && jsonLoaded.source.endsWith("mission.json"));
check("json policy validates ok", validatePolicy(jsonLoaded.policy).ok === true);

// 3. Missing verification.command → invalid.
const noVerify = validatePolicy({ version: "v1", mission: { name: "x" }, budget: { mission_hard_limit_usd: 1 } });
check("missing verification.command is invalid", noVerify.ok === false && noVerify.errors.some((e) => e.includes("verification.command")));

// 4. Bad version → invalid.
const badVersion = validatePolicy({ version: "v2", mission: { name: "x" }, budget: { mission_hard_limit_usd: 1 }, verification: { command: "npm test" } });
check("wrong version is invalid", badVersion.ok === false && badVersion.errors.some((e) => e.includes("version")));

// 5. Missing budget cap → invalid.
const noBudget = validatePolicy({ version: "v1", mission: { name: "x" }, verification: { command: "npm test" } });
check("missing mission_hard_limit_usd is invalid", noBudget.ok === false && noBudget.errors.some((e) => e.includes("mission_hard_limit_usd")));

// 6. No allow scope → warning (not error).
const noAllow = validatePolicy({ version: "v1", mission: { name: "x" }, budget: { mission_hard_limit_usd: 1 }, verification: { command: "npm test", allow: [] } });
check("empty allow produces a warning", noAllow.ok === true && noAllow.warnings.some((w) => w.includes("allow is empty")));

// 7. evaluatePolicyVerdict: a clean VERIFIED receipt → PASS.
const policy = loaded.policy;
const cleanReceipt = {
  outcome: "VERIFIED",
  verificationIntegrity: { status: "VERIFIED_STRONG", violations: [] },
  cost: { actualCostUsd: 0.0007, llmCalls: 2, budgetGuardTripped: false },
  work: { agentDurationMs: 5000 }
};
check("clean receipt grades PASS", evaluatePolicyVerdict(cleanReceipt, policy).verdict === "PASS");

// 8. Compromised verifier → BLOCKED with the reason.
const compromised = { ...cleanReceipt, verificationIntegrity: { status: "VERIFIER_COMPROMISED", violations: ["verifier_file_unchanged:app/verify.mjs"] } };
const cv = evaluatePolicyVerdict(compromised, policy);
check("compromised verifier grades BLOCKED", cv.verdict === "BLOCKED" && cv.reasons.some((r) => r.includes("VERIFIER_COMPROMISED")));

// 9. UNVERIFIED → BLOCKED.
const unver = { ...cleanReceipt, outcome: "UNVERIFIED", verificationIntegrity: { status: "UNVERIFIED", violations: [] } };
check("unverified grades BLOCKED", evaluatePolicyVerdict(unver, policy).verdict === "BLOCKED");

// 10. Out-of-allow scope → BLOCKED.
const scope = { ...cleanReceipt, verificationIntegrity: { status: "VERIFIED_STRONG", violations: ["within_allowed_scope:src/other.mjs"] } };
const sc = evaluatePolicyVerdict(scope, policy);
check("out-of-scope edit grades BLOCKED", sc.verdict === "BLOCKED" && sc.reasons.some((r) => r.toLowerCase().includes("scope")));

// 11. Over the dollar cap → BLOCKED.
const overCost = { ...cleanReceipt, cost: { actualCostUsd: 11, llmCalls: 2, budgetGuardTripped: false } };
check("over the cap grades BLOCKED", evaluatePolicyVerdict(overCost, policy).verdict === "BLOCKED");

// 12. budget_guard tripped → BLOCKED.
const guardTrip = { ...cleanReceipt, cost: { actualCostUsd: 1, llmCalls: 2, budgetGuardTripped: true } };
check("budget guard trip grades BLOCKED", evaluatePolicyVerdict(guardTrip, policy).verdict === "BLOCKED");

// 13. Too many LLM calls → BLOCKED.
const tooMany = { ...cleanReceipt, cost: { actualCostUsd: 1, llmCalls: 99, budgetGuardTripped: false } };
check("too many llm calls grades BLOCKED", evaluatePolicyVerdict(tooMany, policy).verdict === "BLOCKED");

// 14. Over the runtime budget → BLOCKED.
const slow = { ...cleanReceipt, work: { agentDurationMs: 31 * 60_000 } };
check("over runtime budget grades BLOCKED", evaluatePolicyVerdict(slow, policy).verdict === "BLOCKED");

console.log("\n" + (failures === 0 ? "ALL POLICY TESTS PASSED" : `${failures} POLICY TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
