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

const CHARS_PER_TOKEN = 4;
const MIN_FIELD_CHARS = 200; // below this, compression overhead isn't worth it
const LOG_HEAD_LINES = 12;
const LOG_TAIL_LINES = 8;
const LOG_COLLAPSE_THRESHOLD = 40; // collapse runs longer than this

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
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

  const measureAfter = JSON.stringify(next).length;
  const savedChars = Math.max(0, measureBefore - measureAfter);
  return {
    body: next,
    before: measureBefore,
    after: measureAfter,
    savedChars,
    savedTokens: Math.round(savedChars / CHARS_PER_TOKEN),
    touched
  };
}
