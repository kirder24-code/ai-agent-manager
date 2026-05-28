import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

await run(["node", "./bin/aim.mjs", "setup"]);
await run(["node", "./bin/aim.mjs", "fuel", "set", "24"]);
await run(["node", "./bin/aim.mjs", "preflight", "--", "claude", "build the full mobile app with auth payments and production deploy"]);
await run(["node", "./bin/aim.mjs", "run", "--label", "demo-broken-build", "--fuel-before", "24", "--", "npm", "--prefix", "examples/broken-ts-app", "run", "build"]);
await run(["node", "./bin/aim.mjs", "status"]);
await run(["node", "./bin/aim.mjs", "report"]);

function run(args) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${args.join(" ")}`);
    const child = spawn(args[0], args.slice(1), { cwd: root, shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}
