# Codex Test Plan

Use this when you are ready to test AI Agent Manager on Codex itself.

## Goal

Verify that the manager can turn a failed or incomplete Codex session into a useful rescue report.

## Test 1: Narrow Coding Task

```bash
node ./bin/aim.mjs preflight -- codex "Add one CLI command called hello that prints hello. Verify with npm run check."
node ./bin/aim.mjs run --label codex-hello -- codex "Add one CLI command called hello that prints hello. Verify with npm run check. Stop if blocked."
node ./bin/aim.mjs report
node ./bin/aim.mjs export
```

Pass if:

- changed files are detected;
- verification result is recorded;
- report distinguishes progress from failure.

## Test 2: Intentionally Broad Task

```bash
node ./bin/aim.mjs preflight -- codex "Build a full SaaS app with auth, payments, dashboard, deployment and tests."
```

Pass if:

- scope risk is high;
- recommendation says to split into a vertical slice.

## Test 3: Stuck Task

Ask Codex to fix a failing build where a module path is wrong.

Pass if:

- terminal error is parsed;
- source file is extracted when present;
- rescue prompt tells Codex to diagnose/fix the smallest path/config issue first.

## Test 4: Fuel Calibration

Before a real subscription-heavy run:

```bash
node ./bin/aim.mjs fuel set 24
node ./bin/aim.mjs run --label codex-real --fuel-before 24 -- codex "<task>"
node ./bin/aim.mjs fuel calibrate <mission-id> 19
```

Pass if:

- mission records `5%` visible fuel burn;
- report clearly labels it as manual calibration, not exact provider tokens.

## Decision Rule

After 30 real sessions, keep building only if:

- stuck detection catches useful failures;
- rescue reports save time;
- false alarms are tolerable;
- reports feel more trustworthy than the agent's own summary.
