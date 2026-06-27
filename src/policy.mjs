// Policy-bound missions (runcap mission / policy / ci).
//
// A mission's rules are declared once in `.runcap/mission.yaml` (or .yml/.json),
// enforced during the run by the existing gateway cap + verification guard, and
// graded into a PASS/BLOCKED verdict a GitHub Action turns into a red/green PR
// check. This module is deliberately pure: it parses the policy, validates it,
// and grades an ALREADY-BUILT outcome receipt against it. It imports only
// js-yaml + node builtins and never imports mission-control, so there is no
// import cycle (mission-control imports FROM here, one direction).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const POLICY_FILENAMES = ["mission.yaml", "mission.yml", "mission.json"];

// Find and parse the policy. Precedence: an explicit path, else the first of
// .runcap/mission.{yaml,yml,json} that exists. Returns null when none is found
// so callers can decide whether a missing policy is an error.
export function loadPolicy(cwd = process.cwd(), explicitPath) {
  let source = null;
  if (explicitPath) {
    source = path.isAbsolute(explicitPath) ? explicitPath : path.join(cwd, explicitPath);
    if (!existsSync(source)) throw new Error(`Policy file not found: ${explicitPath}`);
  } else {
    for (const name of POLICY_FILENAMES) {
      const candidate = path.join(cwd, ".runcap", name);
      if (existsSync(candidate)) { source = candidate; break; }
    }
  }
  if (!source) return null;

  const raw = readFileSync(source, "utf8");
  let policy;
  if (source.endsWith(".json")) {
    // .json fallback uses native JSON.parse so the zero-config path needs no parser.
    policy = JSON.parse(raw);
  } else {
    policy = yaml.load(raw);
  }
  if (!policy || typeof policy !== "object") {
    throw new Error(`Policy file ${path.basename(source)} did not parse to an object.`);
  }
  return {
    policy,
    raw,
    hash: createHash("sha256").update(raw).digest("hex"),
    source
  };
}

// Validate the policy shape. Errors block the mission; warnings are advisory.
export function validatePolicy(policy) {
  const errors = [];
  const warnings = [];
  if (!policy || typeof policy !== "object") {
    return { ok: false, errors: ["Policy is empty or not an object."], warnings };
  }

  if (policy.version !== "v1") {
    errors.push(`version must be "v1" (got ${JSON.stringify(policy.version)}).`);
  }

  const mission = policy.mission ?? {};
  if (!mission.name || !String(mission.name).trim()) {
    errors.push("mission.name is required.");
  }

  const verification = policy.verification ?? {};
  if (!verification.command || !String(verification.command).trim()) {
    errors.push("verification.command is required.");
  }
  if (verification.guard && !["strict", "off"].includes(verification.guard)) {
    errors.push(`verification.guard must be "strict" or "off" (got ${JSON.stringify(verification.guard)}).`);
  }

  const budget = policy.budget ?? {};
  const limit = budget.mission_hard_limit_usd;
  if (!(typeof limit === "number" && Number.isFinite(limit) && limit > 0)) {
    errors.push("budget.mission_hard_limit_usd is required and must be a positive number.");
  }
  if (budget.max_llm_calls !== undefined && !(Number.isFinite(budget.max_llm_calls) && budget.max_llm_calls > 0)) {
    errors.push("budget.max_llm_calls, when set, must be a positive number.");
  }
  if (budget.max_runtime_minutes !== undefined && !(Number.isFinite(budget.max_runtime_minutes) && budget.max_runtime_minutes > 0)) {
    errors.push("budget.max_runtime_minutes, when set, must be a positive number.");
  }

  const identity = policy.identity ?? {};
  if (!identity.project && !identity.team) {
    warnings.push("identity has no project or team - the receipt will not carry org attribution.");
  }
  if (!Array.isArray(verification.allow) || verification.allow.length === 0) {
    warnings.push("verification.allow is empty - any changed path passes the scope check. Declare the paths a legitimate fix should touch.");
  }
  if (verification.guard === "off") {
    warnings.push("verification.guard is off - a tampered verifier will NOT be caught.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Grade an already-built outcome receipt against the policy. Pure: no I/O.
// BLOCK is the conservative verdict - any single failing condition blocks the
// mission so a reviewer never has to read past the verdict to know it is unsafe.
export function evaluatePolicyVerdict(receipt, policy) {
  const reasons = [];
  const budget = policy?.budget ?? {};
  const limit = budget.mission_hard_limit_usd;

  const integrity = receipt.verificationIntegrity;
  if (integrity && integrity.status === "VERIFIER_COMPROMISED") {
    const tampered = (integrity.violations ?? []).filter((v) =>
      v.startsWith("verifier_file_unchanged:") ||
      v === "package_scripts_unchanged" ||
      v.startsWith("protected_path_untouched:"));
    reasons.push(`VERIFIER_COMPROMISED: the agent changed protected verification evidence${tampered.length ? " (" + tampered.join(", ") + ")" : ""}.`);
  }

  if (receipt.outcome === "UNVERIFIED") {
    reasons.push("UNVERIFIED: verification did not pass.");
  }

  const scopeViolations = (integrity?.violations ?? []).filter((v) => v.startsWith("within_allowed_scope:"));
  if (scopeViolations.length) {
    reasons.push(`Out of allowed scope: ${scopeViolations.map((v) => v.replace("within_allowed_scope:", "")).join(", ")}.`);
  }

  const cost = receipt.cost ?? {};
  if (typeof limit === "number" && typeof cost.actualCostUsd === "number" && cost.actualCostUsd > limit) {
    reasons.push(`Over budget: $${cost.actualCostUsd} spent > $${limit} mission hard limit.`);
  }
  if (cost.budgetGuardTripped) {
    reasons.push("Budget guard tripped: the gateway blocked a call to stay under the mission hard limit.");
  }

  if (Number.isFinite(budget.max_llm_calls) && typeof cost.llmCalls === "number" && cost.llmCalls > budget.max_llm_calls) {
    reasons.push(`Too many LLM calls: ${cost.llmCalls} > max_llm_calls ${budget.max_llm_calls}.`);
  }

  const work = receipt.work ?? {};
  if (Number.isFinite(budget.max_runtime_minutes) && typeof work.agentDurationMs === "number") {
    const limitMs = budget.max_runtime_minutes * 60_000;
    if (work.agentDurationMs > limitMs) {
      reasons.push(`Over time budget: ${(work.agentDurationMs / 1000).toFixed(1)}s > max_runtime_minutes ${budget.max_runtime_minutes}.`);
    }
  }

  return {
    verdict: reasons.length === 0 ? "PASS" : "BLOCKED",
    reasons,
    truth: "calculated_from_policy_and_observed_receipt"
  };
}

// The compact policy block embedded in the receipt: who/what + the rules and
// the hash of the exact policy text that graded the run, so a reviewer can
// confirm which rules were in force.
export function policyMeta(policyResult) {
  const p = policyResult.policy ?? {};
  const identity = p.identity ?? {};
  const mission = p.mission ?? {};
  const budget = p.budget ?? {};
  const verification = p.verification ?? {};
  return {
    schema: "runcap.policy/v1",
    hash: policyResult.hash,
    source: policyResult.source ? path.basename(policyResult.source) : null,
    identity: {
      project: identity.project ?? null,
      team: identity.team ?? null,
      cost_center: identity.cost_center ?? null,
      owner: identity.owner ?? null
    },
    mission: { name: mission.name ?? null, task_class: mission.task_class ?? null },
    limits: {
      mission_hard_limit_usd: budget.mission_hard_limit_usd ?? null,
      max_llm_calls: budget.max_llm_calls ?? null,
      max_runtime_minutes: budget.max_runtime_minutes ?? null,
      guard: verification.guard ?? "strict"
    }
  };
}

// Markdown lines for the printed receipt and the PR summary. Accepts the
// `receipt.policy` block (policyMeta + verdict + reasons merged).
export function formatPolicyBlock(receiptPolicy) {
  if (!receiptPolicy) return [];
  const id = receiptPolicy.identity ?? {};
  const limits = receiptPolicy.limits ?? {};
  const who = [id.project && `project ${id.project}`, id.team && `team ${id.team}`, id.cost_center && `cost center ${id.cost_center}`]
    .filter(Boolean).join(" / ") || "no org attribution";
  const lines = [
    `Mission policy:  ${receiptPolicy.mission?.name ?? "(unnamed)"}${receiptPolicy.mission?.task_class ? " [" + receiptPolicy.mission.task_class + "]" : ""}`,
    `  ${who}`,
    `  Hard limit: ${limits.mission_hard_limit_usd === null || limits.mission_hard_limit_usd === undefined ? "none" : "$" + Number(limits.mission_hard_limit_usd).toFixed(2)}` +
      `${limits.max_llm_calls ? ", max calls " + limits.max_llm_calls : ""}` +
      `${limits.max_runtime_minutes ? ", max " + limits.max_runtime_minutes + " min" : ""}`,
    `  Policy hash: ${receiptPolicy.hash}`,
    `Mission verdict: ${receiptPolicy.verdict}`
  ];
  if (Array.isArray(receiptPolicy.reasons) && receiptPolicy.reasons.length) {
    lines.push(`  Blocked because:`);
    for (const r of receiptPolicy.reasons) lines.push(`    - ${r}`);
  }
  return lines;
}
