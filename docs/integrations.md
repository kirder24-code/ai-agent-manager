# Integrations

## Terminal Agents

Wrap agent commands instead of launching them directly:

```bash
runcap run --label auth-fix -- claude "fix the auth bug"
runcap run --label codex-pass -- codex "implement settings screen"
runcap run --label verify -- npm test
```

On macOS, non-terminal users can double-click `Run Agent.command` and paste the same command into the dialog.

The wrapper records:

- terminal output;
- exit code;
- git diff before/after;
- parsed errors;
- evidence-backed rescue recommendations.

## OpenAI-Compatible Tools

Start the gateway:

```bash
OPENAI_API_KEY=sk-... runcap gateway
```

Point tools to:

```text
OPENAI_BASE_URL=http://127.0.0.1:8792/v1
OPENAI_API_KEY=local-placeholder
```

The upstream key remains local to the gateway process. Gateway events are stored in `.aim-control/gateway-events.jsonl`.

## Mock Gateway

For demos and tests:

```bash
runcap gateway --mock
```

Then:

```bash
curl -s -X POST http://127.0.0.1:8792/v1/chat/completions \
  -H "Content-Type: application/json" \
  --data '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

## Budget Guard

Block new gateway calls after estimated spend reaches a local limit:

```bash
AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... runcap gateway
```

Budget labels are deliberately conservative:

- if provider usage is returned, token counts are observed from provider response;
- if model price exists in the prototype table, cost is calculated;
- if price is missing, cost is `unknown_price`;
- if the budget blocks a call, the event truth label is `budget_guard`.

## Cursor / Claude Code / Codex

The safest first integration is command wrapping:

```bash
runcap run --label cursor-task -- cursor-agent-command ...
runcap run --label claude-task -- claude "..."
runcap run --label codex-task -- codex "..."
```

If a tool supports custom OpenAI-compatible base URLs, point it to the gateway as well.

Do not bypass the wrapper for missions where you want progress proof. If the agent runs directly, the manager can only see later artifacts, not the execution trace.
