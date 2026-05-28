# AI Agent Manager

Evidence-based mission control for AI-agent work.

This is not another token dashboard. The first wedge is **Context-Aware Rescue** for coding agents:

1. run an agent or command through `aim`;
2. capture terminal output;
3. snapshot git diff before/after;
4. parse errors such as `Cannot find module` and `TS2307`;
5. connect errors to the latest diff;
6. produce a rescue packet with evidence, confidence, and a narrower next prompt.

## Quick Start

```bash
cd agent-manager-lab
npm run check
npm run setup
npm run doctor
npm run demo
npm run report
```

The demo runs a deliberately broken TypeScript build in `examples/broken-ts-app`.

## Real Usage

Run any agent or command through the wrapper:

```bash
node ./bin/aim.mjs preflight -- claude "build the full mobile app"
node ./bin/aim.mjs run --label auth-fix -- claude "fix the auth screen"
node ./bin/aim.mjs run --label tests -- npm test
node ./bin/aim.mjs report
node ./bin/aim.mjs export
node ./bin/aim.mjs dashboard
node ./bin/aim.mjs doctor
node ./bin/aim.mjs templates
```

For subscription limits that show percentages instead of dollars:

```bash
node ./bin/aim.mjs fuel set 24
node ./bin/aim.mjs run --label feature --fuel-before 24 -- claude "build settings screen"
node ./bin/aim.mjs fuel calibrate <mission-id> 19
```

The system will then record that the mission consumed `5%` of visible subscription fuel. It does not invent exact token counts when the provider does not expose them.

## Product Flow

1. **Preflight**
   ```bash
   node ./bin/aim.mjs preflight -- claude "build a full app"
   ```
   Detects broad scope, missing verification scripts, and fuel uncertainty before an expensive run starts.

2. **Run**
   ```bash
   node ./bin/aim.mjs run --label feature -- claude "implement one settings screen"
   ```
   Captures terminal logs, git evidence, exit code, parsed errors, and stuck signals.

3. **Rescue**
   ```bash
   node ./bin/aim.mjs report
   ```
   Produces a diagnosis packet with evidence, confidence, and a narrower prompt.

4. **Dashboard**
   ```bash
   node ./bin/aim.mjs dashboard
   ```
   Opens a local dashboard at `http://127.0.0.1:8791`.

5. **Gateway**
   ```bash
   OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
   ```
   Starts an OpenAI-compatible proxy at `http://127.0.0.1:8792/v1`.

   Point compatible tools at:

   ```text
   OPENAI_BASE_URL=http://127.0.0.1:8792/v1
   OPENAI_API_KEY=local-placeholder
   ```

   Gateway events are stored in `.aim-control/gateway-events.jsonl`. Costs are labeled honestly:

   - provider returned usage: `provider_usage`;
   - known static prototype price: `calculated_from_static_price_table`;
   - unknown model price: `unknown_price`;
   - no provider usage: `unknown`.

   Demo without an external API key:

   ```bash
   node ./bin/aim.mjs gateway --mock
   ```

   Budget guard:

   ```bash
   AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
   ```

## Product Principle

Every output is labeled by truth source:

- `observed`: git diff, exit code, file changes, terminal output;
- `calculated`: parsed errors, diff hashes, stuck score;
- `manual_calibration`: user-visible before/after subscription fuel;
- `estimated`: only when exact provider data is unavailable;
- `unknown`: when the system cannot honestly know.

## Current Scope

Implemented:

- CLI wrapper: `aim run -- <command...>`;
- setup/doctor onboarding: `aim setup`, `aim doctor`;
- preflight scope check: `aim preflight -- <command...>`;
- mission log in `.aim-control/missions`;
- terminal capture;
- git before/after snapshot;
- TypeScript/module/test error parsing;
- stuck detection v1;
- context-aware rescue packet v1;
- local dashboard: `aim dashboard`;
- OpenAI-compatible gateway v1: `aim gateway`;
- mock gateway mode: `aim gateway --mock`;
- budget guard through `AIM_DAILY_BUDGET_USD`;
- manual fuel calibration for subscriptions.

Not yet implemented:

- verified live model price catalog;
- semantic model router;
- AgentSight-style zero-instrumentation monitoring;
- integrations with Cursor/Claude Code logs beyond CLI wrapping.

## Why This Wedge

Coding agents are the best first domain because progress can be checked with objective proof:

- git diff;
- build/test/lint output;
- changed files;
- repeated errors;
- artifact creation.

The goal is to avoid fake confidence. If the system cannot prove something, it says so.

## More Docs

- [Product status](PRODUCT.md)
- [Quickstart](docs/quickstart.md)
- [Product plan](docs/product-plan.md)
- [Integrations](docs/integrations.md)
- [Trust model](docs/trust-model.md)
- [Codex test plan](docs/codex-test-plan.md)
- [External review packet](docs/external-review.md)
