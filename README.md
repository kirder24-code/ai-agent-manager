# AI Agent Manager

[![CI](https://github.com/kirder24-code/ai-agent-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/kirder24-code/ai-agent-manager/actions/workflows/ci.yml)

**AI Agent Manager is evidence-based mission control for AI-agent work.**

It helps answer the question every serious AI-agent user eventually runs into:

> Did the agent actually move the task forward, or did it just spend tokens and look busy?

This prototype focuses on coding agents such as Codex, Claude Code, Cursor-style terminal agents, and local automation scripts.

## What Problem It Solves

AI agents can spend minutes, hours, or subscription limits while:

- looping around the same error;
- rewriting plans instead of fixing the blocker;
- failing a terminal command without explaining the real cause;
- changing nothing, but producing a confident summary;
- consuming API tokens or visible subscription fuel without a finished result.

AI Agent Manager watches the work from outside the agent and produces a simple rescue notice:

```text
What happened?
Likely cause?
What changed?
Recommended next step?
Copyable rescue prompt?
```

The point is not more dashboards. The point is a clearer answer:

> The agent is stuck here. This is the evidence. This is the smallest next prompt to try.

## What Works Today

- `aim preflight` checks whether a prompt is too broad before the agent starts.
- `aim run -- <command>` wraps an agent or command and records the mission.
- Terminal output, exit code, git diff, changed files, parsed errors, and stuck signals are captured.
- `aim report` creates a human-readable rescue report.
- `aim export` writes an evidence JSON packet.
- `aim dashboard` opens a local HTML dashboard focused on the problem and next step.
- `aim gateway` starts an OpenAI-compatible local gateway for API usage tracking.
- `aim gateway --mock` demonstrates gateway behavior without an API key.
- `AIM_DAILY_BUDGET_USD` blocks calls after a local budget threshold.
- `aim fuel` supports manual calibration for subscriptions that only show percentages.

## Five-Minute Demo

No API key is required.

```bash
git clone https://github.com/kirder24-code/ai-agent-manager.git
cd ai-agent-manager
npm run setup
npm run doctor
npm run demo
npm run acceptance
```

Open the dashboard:

```bash
npm run dashboard
```

Then visit:

```text
http://127.0.0.1:8791
```

The included demo intentionally runs a broken TypeScript project so the manager can show a stuck run, the likely cause, and a rescue prompt.

## Real Usage With an Agent

Instead of launching an agent directly, wrap it:

```bash
node ./bin/aim.mjs preflight -- codex "Build a full SaaS app with auth, billing, dashboard and deployment"
node ./bin/aim.mjs run --label codex-small-task -- codex "Fix one small failing check. Run verification. Stop if blocked."
node ./bin/aim.mjs report
node ./bin/aim.mjs export
```

The same pattern works for any terminal command:

```bash
node ./bin/aim.mjs run --label tests -- npm test
node ./bin/aim.mjs run --label build -- npm run build
```

## API Cost Gateway

Mock mode, no external calls:

```bash
node ./bin/aim.mjs gateway --mock
```

Real OpenAI-compatible proxy:

```bash
OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
```

Point compatible tools to:

```text
OPENAI_BASE_URL=http://127.0.0.1:8792/v1
OPENAI_API_KEY=local-placeholder
```

Optional budget guard:

```bash
AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
```

## Trust Model

The product is designed not to fake certainty.

Every important output is labeled by source:

- `observed`: git diff, exit code, file changes, terminal output;
- `calculated`: parsed errors, diff hashes, stuck score;
- `provider_usage`: token usage returned by an upstream model provider;
- `manual_calibration`: user-visible subscription percentage before/after a mission;
- `unknown`: the system cannot honestly know.

If it cannot prove something, it should say so.

## Current Stage

This is a working local prototype, not a polished SaaS product.

It is ready for:

- evaluating the concept;
- wrapping real Codex / Claude / Cursor sessions;
- collecting stuck-agent examples;
- testing whether rescue prompts actually save time.

It is not yet:

- a hosted cloud platform;
- a verified live model price catalog;
- a universal agent observability standard;
- a replacement for Langfuse, LiteLLM, AgentOps, or other infrastructure tools.

## Why This Exists

Most AI-agent tooling answers:

```text
What happened?
```

AI Agent Manager is trying to answer:

```text
Why is the task not finished, and what is the smallest next step to rescue it?
```

The thesis:

> AI agents need managers.

## Documentation

- [Product status](PRODUCT.md)
- [Quickstart](docs/quickstart.md)
- [Product plan](docs/product-plan.md)
- [Integrations](docs/integrations.md)
- [Trust model](docs/trust-model.md)
- [Codex test plan](docs/codex-test-plan.md)
- [External review packet](docs/external-review.md)
