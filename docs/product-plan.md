# Product Plan: AI Efficiency Manager

> Historical planning document. It may describe ideas, pricing, or product direction that are not part of Runcap's current public offer. See `docs/current-product-status.md` for the current product boundary.

## Position

AI users do not only need more agents. They need a manager that turns AI spend into accountable work.

This product is a control layer that makes AI-agent work cheaper, safer, and easier to understand:

- define mission scope before the run;
- estimate spend and quality risk before the run;
- route work to the right model tier;
- observe work while it happens;
- measure cost or subscription fuel honestly;
- prove progress through artifacts;
- detect stuck loops;
- rescue the task with evidence-backed next actions.

The product should feel less like an observability dashboard and more like an AI operations advisor:

```text
What are you trying to achieve?
How should this be split?
Which agent/model should do each part?
How much budget might it burn?
When should the system stop it?
What did we learn for next time?
```

## Build Order

1. Task Planner: turn broad goals into small, verifiable missions.
2. Context-Aware Rescue for coding agents.
3. Cost/Fuel Governor.
4. Progress Proof dashboard.
5. Model Router and Model Radar.
6. Learning Layer: remember which agents, prompts, and models worked.
7. Team workspace and integrations.
8. Optional hardware/appliance packaging.

## Non-Negotiables

- Never claim exact cost when only subscription percentages are visible.
- Never call a task "done" without an artifact or verification signal.
- Never generate rescue advice without showing evidence.
- Never build a replacement chat UI before the manager layer works.

## First Success Metric

On 30 real coding-agent sessions:

- correctly flags stuck/at-risk runs in at least 60%;
- false stop rate under 20%;
- rescue packet judged useful in at least 40%;
- every cost/fuel value has a truth label.

## Current Prototype Commands

```bash
runcap preflight -- claude "build a full app"
runcap run --label auth-fix -- claude "fix auth"
runcap report
runcap dashboard
OPENAI_API_KEY=sk-... runcap gateway
```

The dashboard is local-only and reads `.aim-control/missions`. It is intentionally not a cloud product yet because the first trust problem is evidence quality, not hosting.
