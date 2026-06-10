// Runcap token compressor — pure Node, no ML, no native deps.
//
// Headroom (the popular Python tool) proves the demand but pays for it with
// onnxruntime/HF model weights that break installs on macOS Intel, Windows MSVC,
// etc. Runcap takes the opposite bet: only the deterministic, lossless-by-construction
// reductions that need zero dependencies and can never silently change an answer.
//
// What we compress (and why it is safe):
//   - JSON whitespace inside string-embedded JSON blobs (re-serialize compact).
//   - Repeated blank lines and trailing whitespace in long text blocks.
//   - Long log / stack-trace runs collapsed to head + tail + "(N lines elided)".
// What we never touch:
//   - The user's actual prose instructions.
//   - Code semantics (we only strip trailing whitespace, never tokens).
//   - Anything under a conservative size threshold (compression has overhead).
//
// Every reduction is COUNTED so the gateway can show one honest number:
// "X tokens saved by compression". Token counts are an estimate (~4 chars/token),
// labeled `estimated`, never claimed as provider-exact.

import { createHash } from "node:crypto";

const CHARS_PER_TOKEN = 4;
const MIN_FIELD_CHARS = 200; // below this, compression overhead isn't worth it
const MIN_DEDUP_CHARS = 256; // only dedup blocks big enough to be worth a stub
const LOG_HEAD_LINES = 12;
const LOG_TAIL_LINES = 8;
const LOG_COLLAPSE_THRESHOLD = 40; // collapse runs longer than this

// --- delta-encoding of near-duplicate blocks ---
// When a block is similar (not identical) to one seen earlier in the same
// request, we replace it with a line-diff against the original. This is the
// case identical-dedup misses: an agent re-reads a file AFTER editing it.
// Lossless: the exact text is recoverable from (original block + diff).
const DELTA_MIN_SIMILARITY = 0.5; // below this a diff isn't smaller than the original
const DELTA_MAX_LINES = 2500; // LCS is O(n*m); above ~2500 lines a diff can cost >25ms, so skip to protect the hot path

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

// Cheap line-overlap ratio. Used only to decide whether a full LCS diff is
// worth computing; the real saving is measured against the emitted delta.
export function lineSimilarity(aLines, bLines) {
  const aSet = new Set(aLines);
  let shared = 0;
  for (const l of bLines) if (aSet.has(l)) shared++;
  return shared / Math.max(aLines.length, bLines.length, 1);
}

// LCS-based line diff. Emits a compact op list of CHANGES only:
//   { at: <line index in the original>, del: <lines removed>, ins: [<lines added>] }
// Unchanged ranges are implied. Reconstruction walks the original applying ops.
function lineDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { ops.push(cur); cur = null; } };
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { flush(); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (!cur || cur.at !== i) { flush(); cur = { at: i, del: 0, ins: [] }; }
      cur.del++; i++;
    } else {
      if (!cur) cur = { at: i, del: 0, ins: [] };
      cur.ins.push(bLines[j]); j++;
    }
  }
  while (i < n) { if (!cur || cur.at !== i) { flush(); cur = { at: i, del: 0, ins: [] }; } cur.del++; i++; }
  if (j < m) { if (!cur) cur = { at: i, del: 0, ins: [] }; while (j < m) cur.ins.push(bLines[j++]); }
  flush();
  return ops;
}

// Exact inverse of lineDiff: (original lines + ops) -> reconstructed string.
// Walks ops in order (they are emitted sorted by `at`), copying untouched
// original lines up to each op's anchor, then applying the op's deletes/inserts.
// Order-based, so duplicate `at` values across ops are handled correctly.
// Kept in-module so tests can prove losslessness against the real code path.
export function applyLineDiff(aLines, ops) {
  const out = [];
  let i = 0; // cursor into aLines
  for (const op of ops) {
    while (i < op.at && i < aLines.length) { out.push(aLines[i]); i++; }
    for (const ins of op.ins) out.push(ins);
    i += op.del;
  }
  while (i < aLines.length) { out.push(aLines[i]); i++; }
  return out.join("\n");
}

// Render a delta as a block the MODEL can read and apply in its head. The header
// names the base (sha + which message it first appeared in) so the model knows
// what to patch; each op is shown as removed/added lines at a 1-based line number.
function renderDelta(baseHash, firstIndex, ops) {
  const lines = [
    `[runcap delta vs the identical block first seen in message ${firstIndex + 1} (sha:${baseHash}).`,
    ` Reconstruct the current text by applying these line changes to that block; all other lines are unchanged.]`
  ];
  for (const op of ops) {
    const at1 = op.at + 1;
    if (op.del > 0) lines.push(`@@ line ${at1}: remove ${op.del} line(s)`);
    else lines.push(`@@ line ${at1}: insert`);
    for (const ins of op.ins) lines.push(`+ ${ins}`);
  }
  return lines.join("\n");
}

// Re-serialize an embedded JSON string compactly. Handles two shapes safely:
//   1. The whole field is JSON ("{...}" or "[...]").
//   2. A short text prefix followed by a JSON blob ("Here is the data:\n{...}").
// In case 2 we only touch the JSON tail and keep the prefix verbatim, so prose
// is never altered. Returns null if nothing valid/smaller was found.
function compactEmbeddedJson(value) {
  const trimmed = value.trim();
  // Case 1: entire field is JSON.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const compact = JSON.stringify(JSON.parse(trimmed));
      if (compact.length < value.length) return compact;
    } catch {
      // fall through to prefix handling
    }
  }
  // Case 2: a prefix then a JSON blob. Find the first { or [ and try to parse
  // from there to end. Only accept if the tail is valid JSON in full.
  const idx = value.search(/[{[]/);
  if (idx > 0) {
    const prefix = value.slice(0, idx);
    // Keep the prefix small/prose-like; don't swallow huge text blocks.
    if (prefix.length <= 200) {
      const tail = value.slice(idx).trim();
      try {
        const compact = JSON.stringify(JSON.parse(tail));
        const rebuilt = prefix + compact;
        if (rebuilt.length < value.length) return rebuilt;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const LOG_LINE_RE = /^\s*(\d{4}-\d{2}-\d{2}[T ]|\[?\d{2}:\d{2}:\d{2}|DEBUG|INFO|WARN|ERROR|TRACE|at\s+\w|\s+File ")/;

// Collapse a long, log-like block: keep the head and tail (the parts a model
// actually needs to diagnose), elide the repetitive middle.
function collapseLogBlock(value) {
  const lines = value.split("\n");
  if (lines.length <= LOG_COLLAPSE_THRESHOLD) return null;
  const logish = lines.filter((l) => LOG_LINE_RE.test(l)).length;
  // Only collapse if it really looks like logs/stack traces, not prose.
  if (logish < lines.length * 0.5) return null;
  const head = lines.slice(0, LOG_HEAD_LINES);
  const tail = lines.slice(-LOG_TAIL_LINES);
  const elided = lines.length - head.length - tail.length;
  if (elided <= 0) return null;
  return [...head, `... (${elided} repetitive log lines elided by Runcap) ...`, ...tail].join("\n");
}

// Collapse 3+ blank lines to 1, and strip trailing whitespace ONLY on lines
// that are part of a multi-line block. We deliberately leave single-line prose
// (and its final trailing space) untouched so instructions are never altered.
function squeezeWhitespace(value) {
  const lines = value.split("\n");
  if (lines.length < 3) return null; // not a structural block; leave prose alone
  const squeezed = lines
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return squeezed.length < value.length ? squeezed : null;
}

// Compress a single string field through the safe ladder. Returns the smallest
// safe result (or the original if nothing helped).
function compressField(value) {
  if (typeof value !== "string" || value.length < MIN_FIELD_CHARS) return value;
  let out = value;
  const json = compactEmbeddedJson(out);
  if (json !== null) out = json;
  const logs = collapseLogBlock(out);
  if (logs !== null && logs.length < out.length) out = logs;
  const ws = squeezeWhitespace(out);
  if (ws !== null && ws.length < out.length) out = ws;
  return out;
}

// Deduplicate identical content blocks within a single request. In a long
// agentic session the same file dump or tool_result ships as a fresh block on
// every turn (the agent re-reads auth.ts five times); the model already saw
// those exact bytes earlier in the SAME request, so replacing the repeats with
// a deterministic stub is lossless-by-construction. This is where the real
// savings on agentic traffic live — per-field whitespace/JSON trimming barely
// moves the needle by comparison.
//
// Walks messages in order. The first occurrence of a block is kept verbatim;
// any later block with the same content hash becomes:
//   [runcap: identical content seen at message N, sha:abcd1234]
// We only dedup blocks >= MIN_DEDUP_CHARS so a tiny stub never costs more than
// the original. Mutates the message tree in place on the already-cloned `next`.
function dedupRepeatedBlocks(body) {
  let saved = 0;
  let blocks = 0;
  let deltas = 0;
  // hash -> { index, text, lines } for the first occurrence of each block.
  const seen = new Map();
  // Ordered list of prior blocks, for near-duplicate (delta) matching.
  const priors = [];

  const stubFor = (hash, firstIndex) =>
    `[runcap: identical content seen at message ${firstIndex + 1}, sha:${hash}]`;

  // Try to encode `text` as a delta against the most similar prior block.
  // Returns the delta string if it is smaller than the original, else null.
  const tryDelta = (text) => {
    const bLines = text.split("\n");
    if (bLines.length > DELTA_MAX_LINES) return null; // protect the hot path
    let best = null;
    for (const p of priors) {
      if (p.lines.length > DELTA_MAX_LINES) continue;
      const sim = lineSimilarity(p.lines, bLines);
      if (sim < DELTA_MIN_SIMILARITY) continue;
      if (!best || sim > best.sim) best = { ...p, sim };
    }
    if (!best) return null;
    const ops = lineDiff(best.lines, bLines);
    // Safety: only emit if it reconstructs exactly (lossless-by-construction).
    if (applyLineDiff(best.lines, ops) !== text) return null;
    const rendered = renderDelta(best.hash, best.index, ops);
    return rendered.length < text.length ? rendered : null;
  };

  const dedupString = (text, msgIndex) => {
    if (typeof text !== "string" || text.length < MIN_DEDUP_CHARS) return text;
    const hash = shortHash(text);
    const firstSeen = seen.get(hash);
    if (firstSeen === undefined) {
      // First time we see this exact block. Try a delta vs an earlier *similar*
      // block before recording it as a fresh original.
      const delta = tryDelta(text);
      const record = { index: msgIndex, hash, text, lines: text.split("\n") };
      seen.set(hash, record);
      priors.push(record);
      if (delta !== null) {
        saved += text.length - delta.length;
        blocks += 1;
        deltas += 1;
        return delta;
      }
      return text;
    }
    const stub = stubFor(hash, firstSeen.index);
    if (stub.length >= text.length) return text;
    saved += text.length - stub.length;
    blocks += 1;
    return stub;
  };

  const dedupContent = (content, msgIndex) => {
    if (typeof content === "string") return dedupString(content, msgIndex);
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (!part || typeof part !== "object") return part;
        // OpenAI/Anthropic text parts
        if (typeof part.text === "string") {
          return { ...part, text: dedupString(part.text, msgIndex) };
        }
        // Anthropic tool_result blocks: content can be string or array of parts
        if (part.type === "tool_result") {
          if (typeof part.content === "string") {
            return { ...part, content: dedupString(part.content, msgIndex) };
          }
          if (Array.isArray(part.content)) {
            return {
              ...part,
              content: part.content.map((c) =>
                c && typeof c === "object" && typeof c.text === "string"
                  ? { ...c, text: dedupString(c.text, msgIndex) }
                  : c
              )
            };
          }
        }
        return part;
      });
    }
    return content;
  };

  let next = body;
  if (Array.isArray(body.messages)) {
    next = {
      ...body,
      messages: body.messages.map((m, i) =>
        m && typeof m === "object" && "content" in m ? { ...m, content: dedupContent(m.content, i) } : m
      )
    };
  }
  return { body: next, saved, blocks, deltas };
}

// Walk an OpenAI- or Anthropic-shaped request body and compress message content.
// Returns { body, before, after, savedChars, savedTokens, touched }.
export function compressRequestBody(body) {
  const result = { body, savedChars: 0, savedTokens: 0, touched: 0, before: 0, after: 0 };
  if (!body || typeof body !== "object") return result;

  const measureBefore = JSON.stringify(body).length;
  let touched = 0;

  const compressContent = (content) => {
    if (typeof content === "string") {
      const next = compressField(content);
      if (next !== content) touched += 1;
      return next;
    }
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (part && typeof part === "object" && typeof part.text === "string") {
          const next = compressField(part.text);
          if (next !== part.text) touched += 1;
          return { ...part, text: next };
        }
        return part;
      });
    }
    return content;
  };

  let next = body;
  // OpenAI chat.completions: messages[].content
  if (Array.isArray(body.messages)) {
    next = {
      ...body,
      messages: body.messages.map((m) =>
        m && typeof m === "object" && "content" in m ? { ...m, content: compressContent(m.content) } : m
      )
    };
  }
  // Anthropic system prompt (string or block array)
  if (next.system !== undefined) {
    next = { ...next, system: compressContent(next.system) };
  }
  // OpenAI responses API / raw input
  if (typeof next.input === "string") {
    next = { ...next, input: compressContent(next.input) };
  }

  // Cross-message dedup of identical blocks + delta-encoding of near-duplicates
  // (the big win on agentic traffic: re-reads after an edit).
  const deduped = dedupRepeatedBlocks(next);
  next = deduped.body;
  touched += deduped.blocks;

  const measureAfter = JSON.stringify(next).length;
  const savedChars = Math.max(0, measureBefore - measureAfter);
  return {
    body: next,
    before: measureBefore,
    after: measureAfter,
    savedChars,
    savedTokens: Math.round(savedChars / CHARS_PER_TOKEN),
    touched,
    deltas: deduped.deltas
  };
}

// --- loop / circling detection (the "looks productive but stuck" signal) ---
// The gateway sees every request the agent sends. An agent that is circling the
// same failure with reworded attempts sends prompts that are SIMILAR-but-not-
// identical turn after turn: the conversation tail barely moves while tokens
// keep burning. Plain hashing misses this (the text differs slightly each loop);
// this catches it with the same line-similarity primitive the delta-encoder uses.
const LOOP_SIMILARITY = 0.92; // two consecutive prompts this similar = no real progress made between them
const LOOP_MIN_REPEATS = 3;   // how many near-identical prompts in a row before we warn

// Pull the comparable "shape" of a request: the concatenated text the agent is
// actually sending this turn (messages / input / system), order-preserving.
export function requestShapeText(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  const push = (content) => {
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const p of content) if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) if (m && typeof m === "object") push(m.content);
  if (body.system !== undefined) push(body.system);
  if (typeof body.input === "string") push(body.input);
  return parts.join("\n");
}

// Pull the "did the work move?" signal out of an upstream RESPONSE. Similar
// prompts alone can't tell circling from convergence: a run closing in on a fix
// also sends near-identical prompts turn after turn. The tell is whether the
// observation changed - the error/test output coming back. We reduce a response
// to the assistant's returned text (plus any explicit error), which carries the
// error/stack/test signature the next prompt is reacting to.
export function responseSignature(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  const push = (content) => {
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const p of content) if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
  };
  // OpenAI chat: choices[].message.content
  if (Array.isArray(body.choices)) {
    for (const ch of body.choices) {
      if (ch && typeof ch === "object" && ch.message) push(ch.message.content);
    }
  }
  // Anthropic messages: content blocks at top level
  if (Array.isArray(body.content)) push(body.content);
  // Provider error envelopes (OpenAI {error:{message}}, Anthropic {error:{message}})
  if (body.error) {
    if (typeof body.error === "string") parts.push(body.error);
    else if (typeof body.error.message === "string") parts.push(body.error.message);
  }
  return parts.join("\n");
}

// Given the current request and a rolling history of prior request shapes,
// decide whether the agent is circling. Returns { looping, repeats, similarity }.
// History is oldest->newest of prior requestShapeText() strings in this session.
//
// Prompt similarity is the cheap pre-filter. When response signatures are
// available it becomes a GATE, not the verdict: a run only counts as circling
// when the prompts are near-identical AND the upstream response did not move
// (same error/output signature). A converging run sends similar prompts but the
// observation shifts, so it passes. Pass responseSignatures (oldest->newest,
// aligned with history) and currentResponseSignature to enable the gate; omit
// them and detection falls back to prompt-similarity-only (prior behavior).
export function detectLoop(currentShape, history, {
  similarityThreshold = LOOP_SIMILARITY,
  minRepeats = LOOP_MIN_REPEATS,
  responseSignatures = null,
  currentResponseSignature = null,
  responseMovedThreshold = LOOP_SIMILARITY
} = {}) {
  if (!currentShape || !Array.isArray(history) || history.length === 0) {
    return { looping: false, repeats: 0, similarity: 0, responseMoved: false };
  }
  const curLines = String(currentShape).split("\n");
  const haveResponses = Array.isArray(responseSignatures) && currentResponseSignature != null;
  let repeats = 0;
  let lastSimilarity = 0;
  let responseMoved = false;

  // Response-side gate. Prompt similarity alone can't separate circling from
  // convergence: a run closing in on a fix also sends near-identical prompts.
  // The tell is the observation - the error/output coming back. A change in the
  // response between consecutive turns is progress, and it breaks the run the
  // same way a dissimilar prompt does. So we walk backward counting only the
  // trailing turns that are BOTH prompt-similar AND error-stuck; the first turn
  // where the prompt differs OR the response moved ends the run. This means a
  // run that made progress and THEN got stuck on one error still flags once it
  // has circled that same error long enough. With no response data we fall back
  // to prompt-similarity-only (prior behavior).
  //
  // Responses, newest->oldest: currentResponseSignature (what the current prompt
  // is reacting to), then responseSignatures[N-1], [N-2], ... A "stuck" step
  // between turn i and the next-newer turn means their responses match.
  let newerResp = haveResponses ? currentResponseSignature : null;
  for (let i = history.length - 1; i >= 0; i--) {
    const sim = lineSimilarity(curLines, String(history[i]).split("\n"));
    if (sim < similarityThreshold) break;
    if (haveResponses) {
      const olderResp = responseSignatures[i];
      const haveBoth = olderResp != null && newerResp != null &&
        String(olderResp).length && String(newerResp).length;
      if (haveBoth) {
        const respSim = lineSimilarity(String(newerResp).split("\n"), String(olderResp).split("\n"));
        if (respSim < responseMovedThreshold) { responseMoved = true; break; }
      }
      newerResp = olderResp;
    }
    repeats += 1;
    lastSimilarity = sim;
  }

  return {
    looping: repeats >= minRepeats,
    repeats,
    similarity: Number(lastSimilarity.toFixed(3)),
    responseMoved
  };
}
