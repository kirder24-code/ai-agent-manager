import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const checks = [];

await mustPass("syntax", ["npm", "run", "check"], (out) => out.includes("check"));
await mustPass("unit validation", ["npm", "test"], (out) => out.includes("Validation passed"));
await mustPass("doctor", ["npm", "run", "doctor"], (out) => out.includes("Runcap Doctor"));
await mustPass("templates", ["node", "./bin/runcap.mjs", "templates"], (out) => out.includes("Coding feature with proof"));
await mustPass("preflight", ["node", "./bin/runcap.mjs", "preflight", "--", "claude", "build the full mobile app with production deploy"], (out) => out.includes("Scope risk: high"));
const planOutput = await run(["node", "./bin/runcap.mjs", "plan", "--fuel", "24", "--quality", "high", "--", "build a mobile app MVP with auth database dashboard and deployment"]);
if (!planOutput.includes("Budget risk: High")) fail("plan risk", planOutput);
const planId = planOutput.match(/Runcap plan: ([^\n]+)/)?.[1]?.trim();
if (!planId) fail("plan id", planOutput);
const planJson = JSON.parse(await readFile(path.join(root, ".runcap", "plans", planId, "plan.json"), "utf8"));
if (!planJson.commandTemplates?.[0]?.command) fail("plan command templates", JSON.stringify(planJson, null, 2));
checks.push(["plan", true]);
await mustPass("plans list", ["node", "./bin/runcap.mjs", "plans"], (out) => out.includes(planId));

const demo = await run(["node", "./bin/runcap.mjs", "run", "--label", "acceptance", "--fuel-before", "24", "--", "npm", "--prefix", "examples/broken-ts-app", "run", "build"]);
if (!demo.includes("Status: stuck")) fail("demo run", demo);
const missionId = demo.match(/Runcap mission: ([^\n]+)/)?.[1]?.trim();
if (!missionId) fail("mission id", demo);
checks.push(["demo run", true]);

await mustPass("export", ["node", "./bin/runcap.mjs", "export", missionId], (out) => out.includes("Export written"));
const exportJson = JSON.parse(await readFile(path.join(root, ".runcap", "missions", missionId, "export.json"), "utf8"));
if (exportJson.mission.status !== "stuck") fail("export status", JSON.stringify(exportJson, null, 2));
if (!exportJson.mission.rescue.recommendations?.[0]?.prompt) fail("export rescue prompt", JSON.stringify(exportJson, null, 2));
checks.push(["export content", true]);

const htmlReport = await readFile(path.join(root, ".runcap", "missions", missionId, "report.html"), "utf8");
if (!htmlReport.includes("Recommended next step")) fail("html report recommendation", htmlReport);
if (!htmlReport.includes("Technical evidence")) fail("html report evidence", htmlReport);
checks.push(["html report", true]);

const missingAgent = await run(["node", "./bin/runcap.mjs", "run", "--label", "acceptance-missing-agent", "--", "definitely-not-installed-agent-xyz", "do", "work"]);
if (!missingAgent.includes("Install or expose the missing agent command")) fail("missing agent rescue", missingAgent);
if (!missingAgent.includes("Status: stuck")) fail("missing agent stuck", missingAgent);
checks.push(["missing agent rescue", true]);

console.log("\nAcceptance passed:");
for (const [name] of checks) console.log(`OK ${name}`);

async function mustPass(name, args, predicate) {
  const out = await run(args);
  if (!predicate(out)) fail(name, out);
  checks.push([name, true]);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: root, shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(output));
  });
}

function fail(name, output) {
  throw new Error(`Acceptance check failed: ${name}\n\n${output}`);
}
