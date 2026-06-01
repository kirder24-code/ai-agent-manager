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
  console.log(`AI Agent Manager Lab

Usage:
  aim run [--label name] [--fuel-before 24] -- <command...>
  aim plan [--fuel 24] [--quality high|balanced|cheap] -- <goal...>
  aim plans
  aim preflight -- <command or prompt...>
  aim status
  aim list
  aim report [mission-id]
  aim rescue [mission-id]
  aim export [mission-id]
  aim templates
  aim dashboard [--port 8791]
  aim gateway [--port 8792] [--mock]
  aim setup
  aim doctor
  aim fuel set <percent>
  aim fuel calibrate <mission-id> <after-percent>

Examples:
  aim run --label auth-fix -- claude "fix the auth bug"
  aim plan --fuel 24 -- "build a mobile app MVP with auth and deployment"
  aim run -- npm test
  aim report
  aim fuel set 24
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
      `AIM plan: ${plan.id}`,
      `Goal: ${plan.goal}`,
      `Budget risk: ${plan.budget.risk}`,
      `Expected waste reduction: ${plan.budget.expectedWasteReduction}`,
      `Planning model: ${plan.routing.planningTier}`,
      `Execution model: ${plan.routing.executionTier}`,
      `Proof: ${plan.quality.proof}`,
      `Stop rule: ${plan.stopRule}`,
      `Report: .aim-control/plans/${plan.id}/plan.md`,
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
      if (!Number.isFinite(value)) throw new Error("Usage: aim fuel set <percent>");
      console.log(await recordFuel(value));
    } else if (subcommand === "calibrate") {
      const id = args[2];
      const after = Number(args[3]);
      if (!id || !Number.isFinite(after)) {
        throw new Error("Usage: aim fuel calibrate <mission-id> <after-percent>");
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
