// Proves runOutcome produces an honest receipt end-to-end through the REAL cap
// gateway (mock upstream, so no network/keys), for both the VERIFIED and
// UNVERIFIED cases. The agent spends recorded tokens; the verify command's exit
// code is the oracle; Verified Outcome Cost is the actual spend only when verify
// passes. Runs in an isolated temp cwd so it never touches real .runcap data.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";

// Resolve the engine relative to this script so the test runs from any cwd
// (it chdir's into a temp dir below, so a relative import would break).
const SRC_DIR = process.env.RUNCAP_SRC ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const tmp = mkdtempSync(path.join(os.tmpdir(), "runcap-outcome-"));
process.chdir(tmp);

// A tiny agent that spends through the gateway and writes (or doesn't write) a fix.
mkdirSync(path.join(tmp, "app"), { recursive: true });
writeFileSync(path.join(tmp, "app", "broken.mjs"), "export const ok = false;\n");
writeFileSync(path.join(tmp, "app", "verify.mjs"),
  "import { ok } from './broken.mjs'; import assert from 'node:assert'; assert.strictEqual(ok, true, 'not fixed'); console.log('ok');\n");
writeFileSync(path.join(tmp, "agent-fix.mjs"),
  "const b=process.env.OPENAI_BASE_URL;await fetch(`${b}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer x'},body:JSON.stringify({model:'gpt-4o',messages:[{role:'user',content:'fix it'}]})}).then(r=>r.text());" +
  "const {writeFile}=await import('node:fs/promises');await writeFile('app/broken.mjs','export const ok = true;\\n');\n");
writeFileSync(path.join(tmp, "agent-nop.mjs"),
  "const b=process.env.OPENAI_BASE_URL;await fetch(`${b}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer x'},body:JSON.stringify({model:'gpt-4o',messages:[{role:'user',content:'think'}]})}).then(r=>r.text());console.log('no fix');\n");

let failures = 0;
const check = (name, pass, detail) => { if (!pass) failures++; console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const { runOutcome } = await import(path.join(SRC_DIR, "mission-control.mjs"));

const nop = await runOutcome({ task: "fix ok", verify: "node app/verify.mjs", command: ["node", "agent-nop.mjs"], label: "nop", mock: true });
check("no-fix run is UNVERIFIED", nop.receipt.outcome === "UNVERIFIED", `outcome=${nop.receipt.outcome}`);
check("no-fix run still spent real money", nop.receipt.cost.actualCostUsd > 0, `cost=${nop.receipt.cost.actualCostUsd}`);
check("no-fix Verified Outcome Cost is null", nop.receipt.cost.verifiedOutcomeCostUsd === null);
check("no-fix counts money without delivery", nop.receipt.cost.moneySpentWithoutVerifiedDeliveryUsd > 0);

const fix = await runOutcome({ task: "fix ok", verify: "node app/verify.mjs", command: ["node", "agent-fix.mjs"], label: "fix", mock: true });
check("fix run is VERIFIED", fix.receipt.outcome === "VERIFIED", `outcome=${fix.receipt.outcome}`);
check("fix Verified Outcome Cost equals actual spend", fix.receipt.cost.verifiedOutcomeCostUsd === fix.receipt.cost.actualCostUsd);
check("fix counts zero undelivered money", fix.receipt.cost.moneySpentWithoutVerifiedDeliveryUsd === 0);
check("cost truth is calculated from usage + price table", /price_table/.test(fix.receipt.cost.truth));

console.log("\n" + (failures === 0 ? "ALL OUTCOME TESTS PASSED" : `${failures} OUTCOME TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
