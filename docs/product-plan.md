# Product Plan: Evidence-Based AI Agent Manager

## Position

AI agents need managers. This product is a control layer that makes AI-agent work accountable:

- define mission scope before the run;
- observe work while it happens;
- measure cost or subscription fuel honestly;
- prove progress through artifacts;
- detect stuck loops;
- rescue the task with evidence-backed next actions.

## Build Order

1. Context-Aware Rescue for coding agents.
2. Cost/Fuel Governor.
3. Progress Proof dashboard.
4. OpenAI-compatible gateway.
5. Model Router and Model Radar.
6. Team workspace and integrations.
7. Optional hardware/appliance packaging.

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
node ./bin/aim.mjs preflight -- claude "build a full app"
node ./bin/aim.mjs run --label auth-fix -- claude "fix auth"
node ./bin/aim.mjs report
node ./bin/aim.mjs dashboard
OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
```

The dashboard is local-only and reads `.aim-control/missions`. It is intentionally not a cloud product yet because the first trust problem is evidence quality, not hosting.
