#!/usr/bin/env node

import {
  calibrateFuel,
  doctor,
  exportSnapshot,
  latestMissionId,
  listMissions,
  listPlans,
  planMission,
  preflightMission,
  recordFuel,
  renderReport,
  runMission,
  setupProject,
  startDashboard,
  startGateway,
  showStatus,
  setBudgetCap,
  clearBudgetCap,
  currentBudgetCap,
  hasStoredCap,
  templates
} from "../src/mission-control.mjs";
import {
  loginCommand,
  logoutCommand,
  whoamiCommand,
  syncRun,
  planToRun
} from "../src/cloud.mjs";
import { alertsCommand } from "../src/alerts.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function usage() {
  console.log(`Runcap — cap every agent run before it starts

Usage:
  runcap run [--label name] [--cap|--no-cap] [--mock] -- <command...>
                                 (auto-enforces your cap; no manual gateway/base-URL setup)
  runcap plan [--fuel 24] [--quality high|balanced|cheap] [--apply-cap] -- <goal...>
  runcap plans
  runcap cap <usd>               (set the hard cap the gateway enforces)
  runcap cap show                (show the current cap)
  runcap cap clear               (remove the stored cap)
  runcap preflight -- <command or prompt...>
  runcap status
  runcap list
  runcap report [mission-id]
  runcap rescue [mission-id]
  runcap export [mission-id]
  runcap templates
  runcap dashboard [--port 8791]
  runcap gateway [--port 8792] [--mock]
  runcap setup
  runcap doctor
  runcap login <license-key>     (Pro: enable cloud sync + hosted dashboard)
  runcap logout
  runcap whoami
  runcap alerts [list|add|test|clear]   (Pro: phone alerts when a run hits its cap)
  runcap fuel set <percent>
  runcap fuel calibrate <mission-id> <after-percent>

Examples:
  runcap run --label auth-fix -- claude "fix the auth bug"
  runcap plan --fuel 24 -- "build a mobile app MVP with auth and deployment"
  runcap run -- npm test
  runcap report
  runcap fuel set 24

(\`aim\` works as a legacy alias for every command.)
`);
}

function takeOption(input, name) {
  const index = input.indexOf(name);
  if (index === -1) return undefined;
  const value = input[index + 1];
  input.splice(index, 2);
  return value;
}

function takeFlag(input, name) {
  const index = input.indexOf(name);
  if (index === -1) return false;
  input.splice(index, 1);
  return true;
}

try {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "run") {
    const runArgs = args.slice(1);
    const label = takeOption(runArgs, "--label");
    const fuelBefore = takeOption(runArgs, "--fuel-before");
    const forceCap = takeFlag(runArgs, "--cap");
    const noCap = takeFlag(runArgs, "--no-cap");
    const mock = takeFlag(runArgs, "--mock");
    const separator = runArgs.indexOf("--");
    const childArgs = separator === -1 ? runArgs : runArgs.slice(separator + 1);
    if (childArgs.length === 0) {
      throw new Error("Missing command after `aim run --`.");
    }
    // Zero-config: auto-wrap with the cap gateway when a cap is set (or forced),
    // unless explicitly disabled. No manual gateway start, no base-URL exports.
    const capConfigured = Boolean(process.env.AIM_DAILY_BUDGET_USD) || hasStoredCap();
    const autoGateway = !noCap && (forceCap || mock || capConfigured);
    if (!autoGateway && !noCap && !capConfigured) {
      console.log("runcap: no cap set, running without the gateway. Set one with `runcap cap <usd>` to enforce a budget.\n");
    }
    const result = await runMission({
      command: childArgs,
      label,
      fuelBefore: fuelBefore === undefined ? undefined : Number(fuelBefore),
      autoGateway,
      mock
    });
    console.log(result.summary);
    if (result.capSummary) {
      const c = result.capSummary;
      const capLine = c.capUsd === null ? "no cap" : `cap $${c.capUsd.toFixed(2)}`;
      console.log(`\nRuncap: cap enforced (${capLine}). This run spent ~$${c.spentThisRunUsd.toFixed(4)} (window total $${c.spentWindowUsd.toFixed(4)}).`);
    }
  } else if (command === "preflight") {
    const runArgs = args.slice(1);
    const separator = runArgs.indexOf("--");
    const childArgs = separator === -1 ? runArgs : runArgs.slice(separator + 1);
    if (childArgs.length === 0) {
      throw new Error("Missing command or prompt after `aim preflight --`.");
    }
    console.log(await preflightMission(childArgs));
  } else if (command === "plan") {
    const planArgs = args.slice(1);
    const applyCapIndex = planArgs.indexOf("--apply-cap");
    const applyCap = applyCapIndex !== -1;
    if (applyCap) planArgs.splice(applyCapIndex, 1);
    const fuelPercent = takeOption(planArgs, "--fuel");
    const quality = takeOption(planArgs, "--quality") ?? "high";
    const separator = planArgs.indexOf("--");
    const goalArgs = separator === -1 ? planArgs : planArgs.slice(separator + 1);
    const goal = goalArgs.join(" ").trim();
    if (!goal) {
      throw new Error("Missing goal after `aim plan --`.");
    }
    const plan = await planMission(goal, {
      quality,
      fuelPercent: fuelPercent === undefined ? undefined : Number(fuelPercent)
    });
    console.log([
      "",
      `Runcap plan: ${plan.id}`,
      `Goal: ${plan.goal}`,
      `Estimated cost: ${plan.budget.costRange} (${plan.budget.costPrecision})`,
      `Recommended hard cap: ${plan.budget.recommendedCap}`,
      `Budget risk: ${plan.budget.risk}`,
      `Expected waste reduction: ${plan.budget.expectedWasteReduction}`,
      `Planning model: ${plan.routing.planningTier}`,
      `Execution model: ${plan.routing.executionTier}`,
      `Proof: ${plan.quality.proof}`,
      `Stop rule: ${plan.stopRule}`,
      `Report: .runcap/plans/${plan.id}/plan.md`,
      ""
    ].join("\n"));
    if (applyCap) {
      console.log(await setBudgetCap(plan.budget.recommendedCapUsd, { source: `plan:${plan.id}` }));
      console.log("");
    }
    const sync = await syncRun(planToRun(plan));
    if (sync === "synced") console.log("Cloud: synced to your Runcap Pro dashboard.");
    else if (sync && sync.startsWith("sync_failed")) console.log(`Cloud: ${sync}`);
  } else if (command === "login") {
    console.log(await loginCommand(args[1]));
  } else if (command === "logout") {
    console.log(await logoutCommand());
  } else if (command === "whoami") {
    console.log(await whoamiCommand());
  } else if (command === "alerts") {
    console.log(await alertsCommand(args.slice(1)));
  } else if (command === "cap") {
    const sub = args[1];
    if (sub === undefined || sub === "show") {
      console.log(currentBudgetCap());
    } else if (sub === "clear") {
      console.log(await clearBudgetCap());
    } else {
      console.log(await setBudgetCap(sub));
    }
  } else if (command === "plans") {
    console.log(await listPlans());
  } else if (command === "status") {
    console.log(await showStatus());
  } else if (command === "list") {
    console.log(await listMissions());
  } else if (command === "report" || command === "rescue") {
    const id = args[1] ?? (await latestMissionId());
    if (!id) throw new Error("No mission found.");
    console.log(await renderReport(id));
  } else if (command === "export") {
    const id = args[1] ?? (await latestMissionId());
    if (!id) throw new Error("No mission found.");
    console.log(await exportSnapshot(id));
  } else if (command === "templates") {
    console.log(templates());
  } else if (command === "dashboard") {
    const port = Number(takeOption(args, "--port") ?? 8791);
    await startDashboard({ port });
  } else if (command === "gateway") {
    const port = Number(takeOption(args, "--port") ?? 8792);
    const gatewayArgs = args.slice(1);
    const mock = gatewayArgs.includes("--mock");
    await startGateway({ port, mock });
  } else if (command === "setup") {
    console.log(await setupProject());
  } else if (command === "doctor") {
    console.log(await doctor());
  } else if (command === "fuel") {
    const subcommand = args[1] ?? "show";
    if (subcommand === "set") {
      const value = Number(args[2]);
      if (!Number.isFinite(value)) throw new Error("Usage: runcap fuel set <percent>");
      console.log(await recordFuel(value));
    } else if (subcommand === "calibrate") {
      const id = args[2];
      const after = Number(args[3]);
      if (!id || !Number.isFinite(after)) {
        throw new Error("Usage: runcap fuel calibrate <mission-id> <after-percent>");
      }
      console.log(await calibrateFuel(id, after));
    } else {
      console.log(await showStatus({ includeFuelOnly: true }));
    }
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`aim: ${error.message}`);
  process.exitCode = 1;
}
