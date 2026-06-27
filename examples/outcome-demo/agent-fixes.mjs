// A stand-in coding agent that (1) spends money via the gateway and (2) actually
// fixes the bug. It points at whatever base URL Runcap injected (the cap
// gateway), so the spend is recorded and priced exactly like a real agent's.
import { writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const model = process.env.OUTCOME_DEMO_MODEL || "gpt-4o";

async function call(prompt) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer demo" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] })
  });
  return res.text();
}

await call("Read broken.mjs. The sum() function subtracts instead of adds. Plan the one-line fix.");
await call("Apply the fix: sum should return a + b.");

const file = path.join(process.cwd(), "examples/outcome-demo/broken.mjs");
await writeFile(file, "export function sum(a, b) {\n  return a + b;\n}\n");
console.log("agent-fixes: rewrote sum() to add");
