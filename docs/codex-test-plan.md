# Codex Test Plan

Use this when you are ready to test Runcap on Codex itself.

## Goal

Verify that the manager can turn a failed or incomplete Codex session into a useful rescue report.

## Test 1: Narrow Coding Task

```bash
runcap preflight -- codex "Add one CLI command called hello that prints hello. Verify with npm run check."
runcap run --label codex-hello -- codex "Add one CLI command called hello that prints hello. Verify with npm run check. Stop if blocked."
runcap report
runcap export
```

Pass if:

- changed files are detected;
- verification result is recorded;
- report distinguishes progress from failure.

## Test 2: Intentionally Broad Task

```bash
runcap preflight -- codex "Build a full SaaS app with auth, payments, dashboard, deployment and tests."
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
runcap fuel set 24
runcap run --label codex-real --fuel-before 24 -- codex "<task>"
runcap fuel calibrate <mission-id> 19
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
