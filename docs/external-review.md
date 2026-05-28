# External Review Packet

## One-Liner

AI Agent Manager is evidence-based mission control for AI agents. It watches agent work, proves progress, catches stuck loops, controls model spend, and produces rescue prompts when the agent stops moving the task forward.

## Problem

AI agents can consume subscription limits or API budget while producing plans, retries, and terminal noise instead of finished work.

Users need to know:

- what the agent actually did;
- whether the task moved forward;
- where it got stuck;
- what to do next;
- how much visible fuel or API cost was consumed.

## Current Prototype

The prototype is local-only:

- CLI wrapper;
- preflight scope check;
- stuck detector;
- context-aware rescue report;
- local dashboard;
- OpenAI-compatible gateway;
- mock gateway;
- budget guard;
- fuel calibration.

## Demo

```bash
cd agent-manager-lab
npm run setup
npm run demo
npm run dashboard
```

## What Makes It Different

Most LLM observability tools answer:

```text
What happened?
```

This product is designed to answer:

```text
Why is the task not finished, and what is the next smallest action that can rescue it?
```

## Honest Limitations

- The product is strongest for coding workflows because code has objective proof: diff, build, tests, errors.
- Subscription percentages require user calibration.
- Gateway model prices are currently a prototype static table.
- Agents launched outside the wrapper are not fully observable.
- Rescue quality must be validated on real sessions before commercial claims.

## Near-Term Roadmap

1. Run 30-50 real Codex/Claude/Cursor sessions.
2. Improve stuck detection using repeated command/error patterns.
3. Add verified model price catalog.
4. Add semantic cache/model routing only after evidence quality is solid.
5. Package as desktop/local app.
