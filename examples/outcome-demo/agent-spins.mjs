// A stand-in coding agent that spends money via the gateway but never fixes the
// bug - it circles, re-reading and re-planning, the way a stuck agent burns
// budget while reporting confident progress. broken.mjs is left untouched.
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

await call("Read broken.mjs and explain the bug in sum().");
await call("Re-read broken.mjs once more to be sure, then restate the plan.");
await call("Describe at length how you would fix it, but do not write the file yet.");
console.log("agent-spins: lots of talk, no fix written");
process.exit(0);
