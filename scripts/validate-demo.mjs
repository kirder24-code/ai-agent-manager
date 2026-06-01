import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");

const preflight = await run(["node", "./bin/runcap.mjs", "preflight", "--", "claude", "build the full mobile app with production deploy"]);
if (!preflight.includes("Scope risk: high")) {
  throw new Error(`Expected high scope risk, got:\n${preflight}`);
}

const output = await run(["node", "./bin/runcap.mjs", "run", "--label", "validation", "--", "npm", "--prefix", "examples/broken-ts-app", "run", "build"]);
if (!output.includes("Status: stuck")) {
  throw new Error(`Expected stuck status, got:\n${output}`);
}
if (!output.includes("Parsed errors: 1")) {
  throw new Error(`Expected one parsed error, got:\n${output}`);
}

const id = output.match(/Runcap mission: ([^\n]+)/)?.[1]?.trim();
if (!id) throw new Error(`Could not find mission id in:\n${output}`);

const report = await readFile(path.join(root, ".runcap", "missions", id, "report.md"), "utf8");
const checks = [
  "Cannot find package '@/components'",
  "Source file:",
  "Resolve missing import before continuing feature work",
  "Truth Labels",
  "Progress proof: observed from git diff and command result"
];
for (const check of checks) {
  if (!report.includes(check)) {
    throw new Error(`Report missing ${check}\n\n${report}`);
  }
}

console.log(`Validation passed for ${id}`);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: root, shell: false });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk) => { text += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(text));
  });
}
