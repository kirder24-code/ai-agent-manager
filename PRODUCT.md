# AI Agent Manager

## Status

External local prototype ready for real-agent testing.

## What It Does

AI Agent Manager is an evidence-based control layer for AI-agent work.

It can:

- preflight broad tasks before a costly agent run;
- wrap terminal agents and commands;
- record terminal output, exit code, git diff, changed files and parsed errors;
- detect stuck or at-risk missions;
- produce context-aware rescue prompts;
- calibrate visible subscription fuel percentages;
- proxy OpenAI-compatible API traffic through a local gateway;
- record gateway token usage and estimated cost;
- block calls through a budget guard;
- show all of this in a local dashboard.

## Main Commands

```bash
npm run setup
npm run doctor
npm run demo
npm run acceptance
npm run dashboard
```

Real agent wrapping:

```bash
node ./bin/aim.mjs run --label codex-test -- codex "Fix one failing test. Stop if blocked."
node ./bin/aim.mjs run --label claude-test -- claude "Implement one narrow feature and run verification."
```

Gateway:

```bash
node ./bin/aim.mjs gateway --mock
AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
```

## Acceptance

The local acceptance suite checks:

- syntax;
- validation fixture;
- doctor;
- templates;
- preflight high-risk detection;
- stuck mission detection;
- export generation;
- rescue prompt existence.

Run:

```bash
npm run acceptance
```

## Known Limits

- The prototype is strongest for coding workflows.
- Subscription fuel is not exact unless manually calibrated.
- Gateway pricing uses a static prototype table until a verified price catalog is added.
- Agents launched outside the wrapper are not fully observable.
- Rescue quality must be tested on real Codex/Claude/Cursor sessions.

## Next Real Test

Use `docs/codex-test-plan.md` and run a real Codex task through:

```bash
node ./bin/aim.mjs run --label real-codex-test -- codex "<one narrow coding task>"
```

Then inspect:

```bash
node ./bin/aim.mjs report
node ./bin/aim.mjs export
```
