// End-to-end proof that the response-side loop gate works through the REAL
// gateway over HTTP, not just in unit tests. We stand up a tiny local "upstream"
// that returns a caller-chosen error string, point the real Runcap gateway at
// it, and drive near-identical prompts through the wire:
//   A) error CHANGES each turn (convergence)  -> gateway must NOT flag a loop
//   B) error STAYS the same each turn (circling) -> gateway MUST flag a loop
// The gateway records its loop verdict per call in the gateway event log, which
// we read back to assert the real server behaved correctly.
//
// Pure Node, no framework. Exits non-zero on any failure so it can gate CI.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";

// Isolate all gateway state (the .runcap event log lives under cwd) in a
// throwaway dir so this never touches real data. The gateway writes its event
// log to ./.runcap, so we chdir into the temp dir before starting it.
const tmpHome = mkdtempSync(path.join(os.tmpdir(), "runcap-e2e-"));
process.chdir(tmpHome);
process.env.AIM_COMPRESS = "off";      // keep the wire bytes predictable
process.env.AIM_LOOP_DETECT = "on";

// A controllable upstream: returns an OpenAI-shaped completion whose assistant
// text is whatever error we tell it to via a field in the request body. We use
// the body (not a header) on purpose: the gateway forwards the request body
// upstream but rewrites headers, so the body is the channel that actually
// reaches this stub through the real gateway.
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let err = "default error";
    try { err = JSON.parse(body)?.mock_error ?? err; } catch {}
    const payload = {
      id: "chatcmpl-stub",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: String(err) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

async function listen(server, port = 0) {
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return server.address().port;
}

let failures = 0;
function check(name, pass, detail) {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const stableTail = [
  "You are a coding agent. Fix the failing build.",
  ...Array.from({ length: 40 }, (_, i) => `context line ${i}: prior file content the agent keeps resending`)
].join("\n");

async function send(port, wording, mockError) {
  // mock_error rides in the body so it survives the gateway's header rewrite and
  // reaches the upstream stub, which echoes it back as the assistant response.
  const body = JSON.stringify({
    model: "stub-model",
    mock_error: mockError,
    messages: [{ role: "user", content: stableTail + "\nLet me try this: " + wording }]
  });
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  await res.text();
}

function readEvents() {
  const log = path.join(tmpHome, ".runcap", "gateway-events.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Loop verdicts accumulate across both scenarios in one shared gateway process
// (the shape history is per-process), so each scenario asserts against only the
// events it produced. We snapshot the event count before scenario B.

const run = async () => {
  const upstreamPort = await listen(upstream);
  process.env.AIM_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env.AIM_UPSTREAM_API_KEY = "test-key";

  // Import AFTER env is set so the gateway reads our isolated config.
  const { startEphemeralGateway } = await import("../src/mission-control.mjs");
  const gw = await startEphemeralGateway();
  const gwPort = gw.port;

  // Scenario A: same prompt framing, but the error MOVES every turn (convergence).
  for (const [w, e] of [
    ["guard the undefined", "TypeError: cannot read property 'id' of undefined"],
    ["optional chain", "TypeError: cannot read property 'name' of undefined"],
    ["default to {}", "ReferenceError: parser is not defined"],
    ["try/catch", "AssertionError: expected 200 but got 404"]
  ]) {
    await send(gwPort, w, e);
  }
  const afterA = readEvents();
  const aFlagged = afterA.filter((ev) => ev.loop && ev.loop.looping).length;
  check("E2E convergence (moving error) is NOT flagged through real gateway", aFlagged === 0,
    `loops flagged in scenario A=${aFlagged}`);

  // Scenario B: same prompt framing AND the SAME error every turn (circling).
  const stuck = "TypeError: cannot read property 'id' of undefined";
  for (const w of ["attempt one", "attempt two reworded", "attempt three reworded", "attempt four reworded", "attempt five reworded"]) {
    await send(gwPort, w, stuck);
  }
  const afterB = readEvents().slice(afterA.length); // only scenario-B events
  const bFlagged = afterB.filter((ev) => ev.loop && ev.loop.looping).length;
  check("E2E circling (stuck error) IS flagged through real gateway", bFlagged > 0,
    `loops flagged in scenario B=${bFlagged}`);

  await gw.close();
  upstream.close();
};

run()
  .then(() => {
    console.log("\n" + (failures === 0 ? "ALL LOOP E2E TESTS PASSED" : `${failures} LOOP E2E TEST(S) FAILED`));
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("E2E harness error:", e);
    process.exit(1);
  });
