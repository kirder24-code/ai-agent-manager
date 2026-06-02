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
  templates
} from "../src/mission-control.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function usage() {
  console.log(`Runcap — cap every agent run before it starts

Usage:
  runcap run [--label name] [--fuel-before 24] -- <command...>
  runcap plan [--fuel 24] [--quality high|balanced|cheap] -- <goal...>
  runcap plans
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

try {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "run") {
    const runArgs = args.slice(1);
    const label = takeOption(runArgs, "--label");
    const fuelBefore = takeOption(runArgs, "--fuel-before");
    const separator = runArgs.indexOf("--");
    const childArgs = separator === -1 ? runArgs : runArgs.slice(separator + 1);
    if (childArgs.length === 0) {
      throw new Error("Missing command after `aim run --`.");
    }
    const result = await runMission({
      command: childArgs,
      label,
      fuelBefore: fuelBefore === undefined ? undefined : Number(fuelBefore)
    });
    console.log(result.summary);
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
