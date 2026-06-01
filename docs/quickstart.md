# Quickstart

This guide proves the product locally without any paid API call.

## 1. Setup

```bash
cd agent-manager-lab
npm run setup
npm run doctor
```

Expected result: `doctor` should show the local store, git access, and verification scripts.

## 2. Run the Product Demo

```bash
npm run demo
```

The demo does four things:

1. sets visible subscription fuel to `24%`;
2. runs a preflight check on an intentionally broad app-building prompt;
3. runs a broken TypeScript project through the wrapper;
4. produces a rescue report with evidence and a narrower next prompt.

## 3. Open Dashboard

```bash
npm run dashboard
```

Open:

```text
http://127.0.0.1:8791
```

The dashboard is local-only. It reads `.aim-control/missions` and `.aim-control/gateway-events.jsonl`.

On macOS, double-click:

```text
Open Dashboard.command
```

to start and open the dashboard without typing commands.

## 4. Try the Mock Gateway

```bash
runcap gateway --mock
```

In another terminal:

```bash
curl -s -X POST http://127.0.0.1:8792/v1/chat/completions \
  -H "Content-Type: application/json" \
  --data '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

Then check:

```bash
runcap status
```

You should see gateway calls, tokens, and estimated spend.

## 5. Export Evidence

```bash
runcap export
```

This writes an `export.json` next to the mission report. Use it to inspect what the system actually knows.

## 6. Connect to a Real Agent

Wrap the command instead of launching it directly:

```bash
runcap run --label real-codex-test -- codex "Fix one small bug. Run tests. Stop if blocked."
runcap run --label real-claude-test -- claude "Inspect this repo and fix one failing test."
```

The first real validation target is not perfection. It is whether the report helps you continue when the agent gets stuck.

On macOS, double-click:

```text
Run Agent.command
```

and paste the agent command into the dialog.
