// Loop / circling detection tests, run against the REAL compressor exports.
// Proves the "looks productive but stuck" signal the gateway emits:
//   1. Reworded same-failure attempts (similar-but-not-identical prompts) are
//      flagged as a loop once they repeat enough times.
//   2. Genuine progress (the conversation tail actually changing) is NOT flagged.
//   3. A single slow/long legit step is NOT flagged.
//
// Pure Node, no test framework. Exits non-zero on any failure so it can gate CI.

import { detectLoop, requestShapeText, responseSignature } from "../src/compressor.mjs";

let failures = 0;
function check(name, pass, detail) {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// A long, stable conversation tail (system + history the agent keeps resending),
// plus a final attempt line that the agent only REWORDS each loop. This is the
// exact case that fools cheap hashing: 99% identical, never byte-equal.
const stableTail = [
  "You are a coding agent. Fix the failing build.",
  ...Array.from({ length: 40 }, (_, i) => `context line ${i}: prior file content the agent keeps resending`),
  "The test still fails with: TypeError: cannot read property 'id' of undefined"
].join("\n");

function attempt(wording) {
  return stableTail + "\n" + "Let me try this: " + wording;
}

// --- Test 1: reworded same-failure attempts are flagged as a loop ---
{
  const history = [
    attempt("guard the undefined with an if check"),
    attempt("add an optional chain before .id"),
    attempt("default the object to {} before reading id")
  ];
  const current = attempt("wrap the access in a try/catch and read id safely");
  const r = detectLoop(current, history);
  check("reworded same-failure attempts flagged as loop", r.looping && r.repeats >= 3,
    `repeats=${r.repeats}, similarity=${r.similarity}`);
}

// --- Test 2: real progress is NOT flagged ---
// Each turn the conversation tail genuinely changes (new files, new errors).
{
  const history = [
    "Fix the build. Error: missing module 'parser'.\n" + "ctx A ".repeat(40),
    "Installed parser. New error: parser.parse is not a function.\n" + "ctx B ".repeat(40)
  ];
  const current = "Fixed the call signature. Now the test passes; writing the next feature.\n" + "ctx C ".repeat(40);
  const r = detectLoop(current, history);
  check("genuine progress is NOT flagged as loop", !r.looping,
    `looping=${r.looping}, repeats=${r.repeats}`);
}

// --- Test 3: a single slow/long legit step is NOT flagged ---
// One big request with no prior near-identical history must never trip.
{
  const current = attempt("first and only attempt at this step");
  const r = detectLoop(current, []);
  check("single long step is NOT flagged", !r.looping && r.repeats === 0,
    `repeats=${r.repeats}`);
}

// --- Test 4: two repeats is at_risk but below the warn threshold ---
{
  const history = [attempt("try A"), attempt("try B")];
  const current = attempt("try C");
  const r = detectLoop(current, history);
  check("two near-identical repeats not yet a loop (under threshold)", !r.looping && r.repeats === 2,
    `repeats=${r.repeats}`);
}

// --- Test 5: requestShapeText pulls the same text from OpenAI and Anthropic shapes ---
{
  const openai = requestShapeText({ messages: [{ role: "user", content: "hello world" }] });
  const anthropic = requestShapeText({ messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }] });
  check("requestShapeText normalizes OpenAI and Anthropic content", openai === "hello world" && anthropic === "hello world",
    `openai="${openai}" anthropic="${anthropic}"`);
}

// --- Test 6: response-side gate — similar prompts but a MOVING error is NOT a loop ---
// The edge case raised on the thread: a converging run also sends near-identical
// prompts (same files, same framing) while it closes in on the fix. The tell is
// the observation: if the error/test output changes between turns, that's
// progress, not circling. Prompts are near-identical here, but each response
// carries a DIFFERENT error, so the gate must keep it from being flagged.
{
  const history = [attempt("try A"), attempt("try B"), attempt("try C")];
  const current = attempt("try D");
  const responseSignatures = [
    "TypeError: cannot read property 'id' of undefined",
    "TypeError: cannot read property 'name' of undefined",
    "ReferenceError: parser is not defined"
  ];
  const currentResponseSignature = "AssertionError: expected 200 but got 404";
  const r = detectLoop(current, history, { responseSignatures, currentResponseSignature });
  check("similar prompts but MOVING error are NOT flagged (convergence)", !r.looping && r.responseMoved,
    `looping=${r.looping}, repeats=${r.repeats}, responseMoved=${r.responseMoved}`);
}

// --- Test 7: response-side gate — similar prompts AND a STUCK error IS a loop ---
// Same near-identical prompts, but the identical error keeps coming back. Now
// both signals agree the run is circling, so it must still be flagged.
{
  const history = [attempt("try A"), attempt("try B"), attempt("try C")];
  const current = attempt("try D");
  const sameError = "TypeError: cannot read property 'id' of undefined";
  const responseSignatures = [sameError, sameError, sameError];
  const currentResponseSignature = sameError;
  const r = detectLoop(current, history, { responseSignatures, currentResponseSignature });
  check("similar prompts AND stuck error ARE flagged as loop", r.looping && !r.responseMoved && r.repeats >= 3,
    `looping=${r.looping}, repeats=${r.repeats}, responseMoved=${r.responseMoved}`);
}

// --- Test 8: responseSignature extracts the error/text from both provider shapes ---
{
  const openai = responseSignature({ choices: [{ message: { content: "boom: it failed" } }] });
  const anthropic = responseSignature({ content: [{ type: "text", text: "boom: it failed" }] });
  const errEnvelope = responseSignature({ error: { message: "rate limited" } });
  check("responseSignature reads OpenAI, Anthropic, and error shapes",
    openai === "boom: it failed" && anthropic === "boom: it failed" && errEnvelope === "rate limited",
    `openai="${openai}" anthropic="${anthropic}" err="${errEnvelope}"`);
}

console.log("\n" + (failures === 0 ? "ALL LOOP TESTS PASSED" : `${failures} LOOP TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
