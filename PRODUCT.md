# Runcap

## Status

External local prototype ready for real-agent testing. The current build is a proof engine for a broader AI efficiency product.

## What It Does

Runcap is an AI efficiency control layer. It sits between a person or company and their AI agents, then helps plan, route, monitor, rescue, and learn from AI work.

The commercial promise is:

```text
Spend less on AI work without losing quality.
```

The first measurable target is to reduce wasted AI sessions: broad prompts, stuck loops, repeated errors, expensive models used for cheap tasks, and agent output that cannot prove progress.

It can:

- preflight broad tasks before a costly agent run;
- suggest smaller missions before spend starts;
- explain spend risk and quality risk;
- wrap terminal agents and commands;
- record terminal output, exit code, git diff, changed files and parsed errors;
- detect stuck or at-risk missions;
- produce context-aware rescue prompts;
- recommend whether to stop, continue, or switch into diagnosis;
- estimate when a strong model is needed and when cheaper execution may be safe;
- write standalone HTML mission reports;
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

macOS launchers:

```text
Open Dashboard.command
Run Agent.command
```

Real agent wrapping:

```bash
runcap run --label codex-test -- codex "Fix one failing test. Stop if blocked."
runcap run --label claude-test -- claude "Implement one narrow feature and run verification."
```

Gateway:

```bash
runcap gateway --mock
AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... runcap gateway
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
runcap run --label real-codex-test -- codex "<one narrow coding task>"
```

Then inspect:

```bash
runcap report
runcap export
```
