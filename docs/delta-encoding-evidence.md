# Delta-encoding: test evidence

This is the proof behind Runcap's delta-encoding compression. Every number here
came from a real run on 2026-06-05, not an estimate. The raw events are in
`.runcap/gateway-events.jsonl`; the tests are in `scripts/delta-test.mjs` and run
on every `npm test`.

## What it does

Identical-block dedup (what other proxies do) only fires when the same bytes
repeat. But the most common agentic pattern is: the agent reads a file, edits one
line, then re-reads it. Now the block is *similar but not identical*, so plain
dedup saves nothing.

Delta-encoding catches exactly that case. When a block is similar to one seen
earlier in the same request, Runcap replaces it with a readable line-diff against
the original instead of the full text. The model reconstructs the current file in
its head from (original block + diff). It is lossless by construction: the exact
bytes are recoverable, and the compressor refuses to emit a delta unless it
reconstructs the original exactly.

## Proof 1: the model still answers correctly from a delta (real provider call)

Two identical calls were sent through the gateway to OpenAI `gpt-4o-mini`. The
agent had "read" auth.ts, then re-read it after changing one line from
`throw new Error("no token")` to `return res.status(401)...`. The question's
answer depends entirely on that changed line.

| Run | Compression | prompt_tokens (billed by OpenAI) | Answer |
|---|---|---|---|
| Baseline | OFF | **1186** | "...returns an HTTP response with status code 401." |
| Delta | ON | **737** | "...returns an HTTP response with status code 401." |

**449 real tokens saved on one re-read = 37.9% of the prompt. Identical answer.**
Source: `truth: provider_usage` (counts returned by OpenAI), gateway events at
2026-06-05T20:22:09Z (ON) and 2026-06-05T20:22:33Z (OFF).

The model never received the full edited file. It got the diff and still answered
correctly about the changed line. That is the make-or-break result: comprehension
survives compression.

## Proof 2: lossless + correct on the unit tests

`npm test` runs `scripts/delta-test.mjs` against the real compressor exports:

```
PASS  applyLineDiff reconstructs the edited file exactly  — byte-identical
PASS  near-duplicate re-read is delta-encoded  — deltas=1, savedChars=1982, savedTokens=496
PASS  delta block is shorter than the full re-read  — delta=280ch vs full=2227ch
PASS  identical re-read collapses to stub
PASS  unrelated block is NOT delta-encoded  — left verbatim
PASS  full chat-message shape does not crash
ALL DELTA TESTS PASSED
```

- **Lossless:** `applyLineDiff(original, ops)` reconstructs the edited file byte-identically.
- **No false positives:** an unrelated file is left verbatim (not wrongly diffed).
- **Layered safely:** identical re-reads still collapse to the cheaper stub; only
  similar-but-different blocks become deltas.

On the test file, one edited re-read went from 2227 chars to a 280-char delta:
**87.4% saved on that block.**

## Proof 3: it is safe on the hot path (LCS cost is bounded)

Line-diff is O(n*m), so large files are capped (`DELTA_MAX_LINES = 2500`). Above
the cap the block is left verbatim rather than stalling the gateway.

| File size | Behavior | Time |
|---|---|---|
| 500 lines | delta, 26K chars saved | 5 ms |
| 2000 lines | delta, 107K chars saved | 21 ms |
| 6000 lines | safely skipped (verbatim) | 3 ms |

## A bug we found and fixed (honest record)

The first build crashed with "Invalid array length" when whole chat messages
(prose + fenced code) were diffed: the reconstruction step keyed ops by anchor
in a Map, which collapsed ops that shared an anchor and desynced the cursor into
an unbounded loop. Fixed by walking ops in order with an explicit cursor. A
regression test ("full chat-message shape does not crash") now locks that path.

## How to reproduce

```bash
npm test                 # runs the delta unit + regression tests
# real provider proof (needs your own OpenAI key):
OPENAI_API_KEY=sk-... AIM_DAILY_BUDGET_USD=5 runcap gateway     # ON
OPENAI_API_KEY=sk-... AIM_DAILY_BUDGET_USD=5 AIM_COMPRESS=off runcap gateway   # baseline
# send the same edited-file-re-read call to each, compare prompt_tokens in
# .runcap/gateway-events.jsonl
```

## Truth labels

- Provider token counts (1186 vs 737): `provider_usage` — returned by OpenAI.
- 37.9% saved: derived from those two provider counts.
- savedTokens/savedChars inside the compression record: `estimated` (~4 chars/token).
- Lossless reconstruction, no-crash, no-false-positive: `calculated` — asserted by tests.
