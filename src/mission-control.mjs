import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { syncRun } from "./cloud.mjs";
import { sendAlert } from "./alerts.mjs";
import { compressRequestBody, estimateTokens } from "./compressor.mjs";

const STORE_DIR = ".runcap";
const MISSIONS_DIR = path.join(STORE_DIR, "missions");
const PLANS_DIR = path.join(STORE_DIR, "plans");
const FUEL_FILE = path.join(STORE_DIR, "fuel.json");
const GATEWAY_EVENTS_FILE = path.join(STORE_DIR, "gateway-events.jsonl");
const BUDGET_FILE = path.join(STORE_DIR, "budget.json");
const ENV_EXAMPLE_FILE = ".env.example";

const ERROR_PATTERNS = [
  {
    kind: "module_not_found",
    confidence: "high",
    regexes: [
      /Cannot find module ['"]([^'"]+)['"]/g,
      /Cannot find package ['"]([^'"]+)['"]/g,
      /Module not found.*?['"]([^'"]+)['"]/g,
      /Can't resolve ['"]([^'"]+)['"]/g
    ]
  },
  {
    kind: "typescript_error",
    confidence: "high",
    regexes: [/(TS\d{4})[:\s]+([^\n]+)/g]
  },
  {
    kind: "syntax_error",
    confidence: "medium",
    regexes: [/(SyntaxError|Parsing error|Unexpected token)[:\s]+([^\n]+)/g]
  },
  {
    kind: "test_failure",
    confidence: "medium",
    regexes: [/(FAIL|failed|AssertionError|Expected .* Received .*)/gi]
  },
  {
    kind: "command_not_found",
    confidence: "high",
    regexes: [
      /Error: spawn ([^\s]+) ENOENT/g,
      /spawn ([^\s]+) ENOENT/g,
      /command not found: ([^\s]+)/gi,
      /([^:\s]+): command not found/gi
    ]
  }
];

export async function runMission({ command, label, fuelBefore, autoGateway = false, mock = false }) {
  await ensureStore();
  const id = createMissionId(label);
  const missionDir = path.join(MISSIONS_DIR, id);
  await mkdir(missionDir, { recursive: true });

  const start = new Date();
  const cwd = process.cwd();
  const before = await collectSnapshot(cwd);
  const preflight = buildPreflight(command.join(" "), before);

  // Zero-config: bring up a gateway for just this run and point the child's
  // provider base URLs at it, so the cap is enforced without the user manually
  // starting a gateway or exporting any base URL.
  let gateway = null;
  let childEnv = {};
  const budgetBefore = readBudget();
  const spentBefore = autoGateway ? (await readGatewaySummary({ windowMs: budgetWindowMs() })).estimatedCostUsd : 0;
  if (autoGateway) {
    gateway = await startEphemeralGateway({ mock });
    childEnv = {
      ANTHROPIC_BASE_URL: `${gateway.baseUrl}/v1`,
      OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
      OPENAI_API_BASE: `${gateway.baseUrl}/v1`
    };
  }

  let output;
  try {
    output = await runChild(command, cwd, childEnv);
  } finally {
    if (gateway) await gateway.close().catch(() => {});
  }
  const after = await collectSnapshot(cwd);
  const terminal = `${output.stdout}\n${output.stderr}`;
  const errors = parseErrors(terminal);
  const diffEvidence = analyzeDiff(before, after);
  const stuck = detectStuck({ output, errors, diffEvidence, preflight });
  const rescue = buildRescuePacket({ command, output, errors, diffEvidence, preflight, stuck });

  const fuel = await readFuel();
  const mission = {
    id,
    label: label ?? null,
    command,
    cwd,
    startedAt: start.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: output.durationMs,
    exitCode: output.exitCode,
    signal: output.signal,
    fuelBefore: fuelBefore ?? fuel.currentPercent ?? null,
    fuelAfter: null,
    fuelUsedPercent: null,
    preflight,
    before,
    after,
    diffEvidence,
    errors,
    stuck,
    rescue,
    logs: {
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log"
    }
  };

  await writeFile(path.join(missionDir, "stdout.log"), output.stdout);
  await writeFile(path.join(missionDir, "stderr.log"), output.stderr);
  await writeFile(path.join(missionDir, "mission.json"), JSON.stringify(mission, null, 2));
  await writeFile(path.join(missionDir, "report.md"), formatReport(mission));
  await writeFile(path.join(missionDir, "report.html"), formatHtmlReport(mission));
  await writeFile(path.join(STORE_DIR, "latest"), id);

  let capSummary = null;
  if (autoGateway) {
    const spentAfter = (await readGatewaySummary({ windowMs: budgetWindowMs() })).estimatedCostUsd;
    capSummary = {
      capUsd: budgetBefore,
      spentThisRunUsd: Number((spentAfter - spentBefore).toFixed(6)),
      spentWindowUsd: spentAfter,
      mode: gateway?.gatewayMode ?? "proxy"
    };
  }

  return {
    id,
    summary: shortSummary(mission),
    capSummary
  };
}

export async function latestMissionId() {
  try {
    return (await readFile(path.join(STORE_DIR, "latest"), "utf8")).trim();
  } catch {
    return null;
  }
}

export async function renderReport(id) {
  const mission = await readMission(id);
  return formatReport(mission);
}

export async function exportSnapshot(id) {
  await ensureStore();
  const mission = await readMission(id);
  const gateway = await readGatewaySummary();
  const fuel = await readFuel();
  const exportObject = {
    exportedAt: new Date().toISOString(),
    product: "Runcap",
    truthModel: {
      progressProof: "observed_from_git_and_command_result",
      terminalErrors: "calculated_from_terminal_logs",
      fuel: mission.fuelUsedPercent === null ? "unknown_until_manual_calibration" : "manual_before_after_calibration",
      gatewayCost: gateway.truth
    },
    mission: {
      id: mission.id,
      label: mission.label,
      command: mission.command,
      status: mission.stuck.status,
      confidence: mission.stuck.confidence,
      exitCode: mission.exitCode,
      durationMs: mission.durationMs,
      evidence: mission.diffEvidence,
      errors: mission.errors,
      stuckSignals: mission.stuck.signals,
      rescue: mission.rescue
    },
    fuel,
    gateway
  };
  const file = path.join(MISSIONS_DIR, id, "export.json");
  await writeFile(file, JSON.stringify(exportObject, null, 2));
  return `Export written: ${file}`;
}

export function templates() {
  return `Runcap Templates

1. Coding feature with proof
   runcap preflight -- claude "Implement <one feature>. Acceptance: <one visible result>. Verify with <command>."
   runcap run --label feature -- claude "Implement <one feature>. Change only relevant files. Run <command>. Stop and report if blocked."

2. Stuck rescue pass
   runcap run --label rescue -- claude "Do not write broad code. Use the previous Runcap report. Diagnose the failure, map it to files/config, make the smallest fix, then run verification."

3. Explorer before expensive coding
   runcap run --label explorer -- claude "Do not edit files. Inspect the project and return the smallest implementation plan with exact files and verification command."

4. Subscription fuel discipline
   runcap fuel set 24
   runcap run --label focused-slice --fuel-before 24 -- claude "Build one vertical slice only. Stop after verification."
   runcap fuel calibrate <mission-id> <after-percent>

5. API cost gateway
   runcap gateway --mock
   # or
   AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... runcap gateway
`;
}

export async function preflightMission(command) {
  await ensureStore();
  const snapshot = await collectSnapshot(process.cwd());
  const preflight = buildPreflight(command.join(" "), snapshot);
  const fuel = await readFuel();
  return formatPreflight({ command, preflight, fuel });
}

export async function planMission(goal, options = {}) {
  await ensureStore();
  const snapshot = await collectSnapshot(process.cwd());
  const fuel = await readFuel();
  const plan = buildAiWorkPlan(goal, {
    quality: options.quality ?? "high",
    fuelPercent: options.fuelPercent ?? fuel.currentPercent,
    snapshot
  });
  const planDir = path.join(PLANS_DIR, plan.id);
  await mkdir(planDir, { recursive: true });
  await writeFile(path.join(planDir, "plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(path.join(planDir, "plan.md"), formatPlan(plan));
  await writeFile(path.join(STORE_DIR, "latest-plan"), plan.id);
  return plan;
}

// Persist a hard cap to .runcap/budget.json so the gateway enforces it without
// the user manually exporting AIM_DAILY_BUDGET_USD. env still wins if set.
// Show a meaningful figure for sub-cent spend; a real call can cost a fraction
// of a cent, and rounding it to $0.00 reads as "nothing was recorded".
function fmtUsd(n) {
  const v = Number(n);
  if (!(v > 0)) return "$0.00";
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  if (v >= 0.0001) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(2)}`;
}

export async function setBudgetCap(capUsd, { source = "manual" } = {}) {
  await ensureStore();
  const value = Number(capUsd);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Usage: runcap cap <usd> (a non-negative number).");
  }
  await writeFile(BUDGET_FILE, JSON.stringify({ capUsd: value, source, setAt: new Date().toISOString() }, null, 2));
  const envNote = process.env.AIM_DAILY_BUDGET_USD
    ? "\nNote: AIM_DAILY_BUDGET_USD is set in your env and overrides this file."
    : "";
  return `Hard cap set: $${value.toFixed(2)} per ${(process.env.AIM_BUDGET_WINDOW ?? "day")}. Saved to ${BUDGET_FILE}.${envNote}`;
}

export async function clearBudgetCap() {
  await ensureStore();
  if (existsSync(BUDGET_FILE)) await writeFile(BUDGET_FILE, JSON.stringify({ capUsd: null, clearedAt: new Date().toISOString() }, null, 2));
  return "Stored cap cleared. The gateway will only enforce AIM_DAILY_BUDGET_USD if set.";
}

export function currentBudgetCap() {
  const cap = readBudget();
  if (cap === null) return "No cap set. Run `runcap cap <usd>` or `runcap plan --apply-cap`.";
  const src = process.env.AIM_DAILY_BUDGET_USD ? "env AIM_DAILY_BUDGET_USD" : `file ${BUDGET_FILE}`;
  return `Current hard cap: $${cap.toFixed(2)} per ${(process.env.AIM_BUDGET_WINDOW ?? "day")} (from ${src}).`;
}

export function hasStoredCap() {
  return readStoredBudget() !== null;
}

export async function listPlans() {
  await ensureStore();
  const plans = await readPlans();
  if (plans.length === 0) return "No plans recorded yet.";
  return plans.map((plan) => [
    plan.id,
    `  goal: ${plan.goal}`,
    `  budget risk: ${plan.budget.risk}`,
    `  expected saving: ${plan.budget.expectedWasteReduction}`,
    `  planning model: ${plan.routing.planningTier}`,
    `  execution model: ${plan.routing.executionTier}`,
    `  report: ${path.join(PLANS_DIR, plan.id, "plan.md")}`
  ].join("\n")).join("\n\n");
}

export async function listMissions() {
  await ensureStore();
  const missions = await readMissionSummaries();
  if (missions.length === 0) return "No missions recorded yet.";
  return missions.map((mission) => [
    mission.id,
    `  status: ${mission.status}`,
    `  exit: ${mission.exitCode}`,
    `  errors: ${mission.errorCount}`,
    `  changed files: ${mission.changedFileCount}`,
    `  report: ${path.join(MISSIONS_DIR, mission.id, "report.md")}`
  ].join("\n")).join("\n\n");
}

export async function setupProject() {
  await ensureStore();
  const envExample = [
    "# Runcap",
    "# For real gateway mode:",
    "OPENAI_API_KEY=",
    "AIM_UPSTREAM_BASE_URL=https://api.openai.com/v1",
    "",
    "# Hard cap (USD) per budget window. The gateway prices each call from its",
    "# own tokens and blocks it BEFORE forwarding if it would push spend over the cap.",
    "# You can also set this with `runcap cap <usd>` or `runcap plan --apply-cap`.",
    "AIM_DAILY_BUDGET_USD=5",
    "",
    "# Budget window: day (default, rolling 24h), session (since gateway start),",
    "# all (never resets), or a number of hours. Caps reset per window.",
    "AIM_BUDGET_WINDOW=day",
    "",
    "# For demo mode without external API calls:",
    "AIM_GATEWAY_MODE=mock"
  ].join("\n");
  if (!existsSync(ENV_EXAMPLE_FILE)) {
    await writeFile(ENV_EXAMPLE_FILE, `${envExample}\n`);
  }
  return [
    "Runcap setup complete.",
    `Store: ${STORE_DIR}`,
    `Example env: ${ENV_EXAMPLE_FILE}`,
    "",
    "Try:",
    "  runcap preflight -- claude \"build the full mobile app\"",
    "  runcap run --label demo -- npm --prefix examples/broken-ts-app run build",
    "  runcap gateway --mock"
  ].join("\n");
}

export async function doctor() {
  await ensureStore();
  const snapshot = await collectSnapshot(process.cwd());
  const fuel = await readFuel();
  const missions = await readMissionSummaries();
  const gateway = await readGatewaySummary();
  const hasVerificationScript = Boolean(snapshot.packageJson && Object.keys(snapshot.packageJson.scripts ?? {}).some((name) => /test|build|lint|typecheck/.test(name)));
  const checks = [
    ["Store exists", existsSync(STORE_DIR), STORE_DIR],
    ["Git available", snapshot.gitAvailable, snapshot.gitAvailable ? "observed" : "not available"],
    ["package.json visible", Boolean(snapshot.packageJson), Boolean(snapshot.packageJson) ? "yes" : "no"],
    ["Verification scripts", hasVerificationScript, "build/test/lint/typecheck"],
    ["Fuel calibrated", fuel.currentPercent !== null, fuel.currentPercent === null ? "unknown" : `${fuel.currentPercent}%`],
    ["Missions recorded", missions.length > 0, String(missions.length)],
    ["Gateway events recorded", gateway.callCount > 0, `${gateway.callCount} calls`]
  ];
  return [
    "Runcap Doctor",
    ...checks.map(([name, ok, detail]) => `${ok ? "OK" : "WARN"}  ${name}: ${detail}`),
    "",
    "Recommended next step:",
    missions.length === 0
      ? "  runcap run --label first-check -- npm test"
      : "  runcap dashboard"
  ].join("\n");
}

// Guided first-run, shown when `runcap` is invoked with no arguments. Explains
// in one screen what Runcap does, what it does NOT do, checks readiness, and
// gives exactly ONE next step based on the current state — so a newcomer reaches
// their first result without reading docs.
export async function welcome() {
  await ensureStore();
  const hasOpenAiKey = Boolean(process.env.AIM_UPSTREAM_API_KEY ?? process.env.OPENAI_API_KEY);
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasAnyKey = hasOpenAiKey || hasAnthropicKey;
  const cap = readBudget();
  const gateway = await readGatewaySummary({ windowMs: budgetWindowMs() });
  const window = process.env.AIM_BUDGET_WINDOW ?? "day";

  const tick = (ok) => (ok ? "[x]" : "[ ]");
  const keyLabel = hasAnyKey
    ? `API key detected (${[hasAnthropicKey && "Anthropic", hasOpenAiKey && "OpenAI"].filter(Boolean).join(" + ")})`
    : "No API key in this shell (set ANTHROPIC_API_KEY or OPENAI_API_KEY)";
  const capLabel = cap === null ? "No cap set yet" : `Cap set: $${cap.toFixed(2)} per ${window}`;

  // One next step, chosen by what is missing.
  let nextStep;
  if (!hasAnyKey) {
    nextStep = [
      "Next: give Runcap the same provider key your agent already uses, e.g.",
      "  export ANTHROPIC_API_KEY=sk-...      # or OPENAI_API_KEY=sk-...",
      "Then run `runcap` again."
    ];
  } else if (cap === null) {
    nextStep = [
      "Next: set the most you want a run to spend, then run your agent through Runcap:",
      "  runcap cap 5",
      "  runcap run -- claude \"fix the failing test\"",
      "Runcap starts a local gateway, points your agent at it, and blocks any call",
      "that would push spend over $5, before it reaches the paid API.",
      "",
      "Not sure what to cap at? Estimate first:",
      "  runcap plan --apply-cap -- \"the task you're about to run\""
    ];
  } else {
    nextStep = [
      `You're ready. Cap is $${cap.toFixed(2)} per ${window}. Run any agent through Runcap:`,
      "  runcap run -- claude \"fix the failing test\"",
      "  runcap run -- codex \"...\"      runcap run -- python my_agent.py",
      "",
      gateway.callCount > 0
        ? `Spent so far this ${window}: ${fmtUsd(gateway.estimatedCostUsd)} across ${gateway.callCount} calls. See: runcap status`
        : "No calls recorded yet. Your first `runcap run` will show the spend."
    ];
  }

  return [
    "Runcap: see and cap what your AI agent spends, before it spends it.",
    "",
    "What it does:",
    "  - Prices each call your agent makes from its own tokens.",
    "  - Blocks any call that would exceed your cap BEFORE it hits the paid API.",
    "  - Shows you the real spend, per run and per day.",
    "",
    "What it does NOT do (so there are no surprises):",
    "  - It does not give you an AI model. You bring your own provider API key.",
    "  - It does not run tasks for you. You bring your own agent (Claude Code,",
    "    Codex, a script: anything that calls OpenAI/Anthropic).",
    "  - It is a local tool for that setup, not a no-account web app.",
    "",
    "Readiness:",
    `  ${tick(hasAnyKey)} ${keyLabel}`,
    `  ${tick(cap !== null)} ${capLabel}`,
    "",
    ...nextStep,
    "",
    "Full command list: `runcap help`."
  ].join("\n");
}

export async function startDashboard({ port = 8791 } = {}) {
  await ensureStore();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/") {
        send(response, 200, renderDashboardHtml(), "text/html; charset=utf-8");
      } else if (url.pathname === "/api/status") {
        sendJson(response, await dashboardStatus());
      } else if (url.pathname === "/api/missions") {
        sendJson(response, await readMissionSummaries());
      } else if (url.pathname === "/api/plans" && request.method === "GET") {
        sendJson(response, await readPlans());
      } else if (url.pathname === "/api/plans" && request.method === "POST") {
        const body = safeJson(await readRequestBody(request));
        if (!body.goal || typeof body.goal !== "string") {
          sendJson(response, { error: "Missing plan goal." }, 400);
          return;
        }
        sendJson(response, await planMission(body.goal, {
          quality: body.quality,
          fuelPercent: Number.isFinite(Number(body.fuelPercent)) ? Number(body.fuelPercent) : undefined
        }), 201);
      } else if (url.pathname.startsWith("/api/plans/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/plans/", ""));
        sendJson(response, await readPlan(id));
      } else if (url.pathname === "/api/gateway") {
        sendJson(response, await readGatewaySummary());
      } else if (url.pathname.startsWith("/api/missions/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/missions/", ""));
        sendJson(response, await readMission(id));
      } else {
        send(response, 404, "Not found", "text/plain; charset=utf-8");
      }
    } catch (error) {
      sendJson(response, { error: error.message }, 500);
    }
  });
  await listenLocal(server, port, "dashboard");
  console.log(`Runcap dashboard: http://127.0.0.1:${port}`);
  console.log("Press Ctrl+C to stop.");
}

async function listenLocal(server, port, label) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(`${label} port ${port} is already in use. Try another port, for example ${port + 1}.`);
    }
    if (error.code === "EPERM") {
      throw new Error(`Cannot open local ${label} port ${port} in this environment. Try another port or grant local server permission.`);
    }
    throw error;
  });
}

// Build (but do not start) the gateway HTTP server. Upstream targets are
// captured here from explicit args or env, so the auto-wrapper can pin the real
// upstream BEFORE it rewrites the child's base URLs to point at this gateway.
function createGatewayServer({ port = 8792, mock = false, upstream = {} } = {}) {
  const gatewayMode = mock || process.env.AIM_GATEWAY_MODE === "mock" ? "mock" : "proxy";
  const openaiKey = upstream.openaiKey ?? process.env.AIM_UPSTREAM_API_KEY ?? process.env.OPENAI_API_KEY;
  const anthropicKey = upstream.anthropicKey ?? process.env.ANTHROPIC_API_KEY;
  const openaiBaseUrl = upstream.openaiBaseUrl ?? process.env.AIM_UPSTREAM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const anthropicBaseUrl = upstream.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
  const anthropicVersion = process.env.ANTHROPIC_VERSION ?? "2023-06-01";
  if (gatewayMode !== "mock" && !openaiKey && !anthropicKey) {
    throw new Error("Missing upstream key. Set OPENAI_API_KEY (for /v1/chat/completions) and/or ANTHROPIC_API_KEY (for /v1/messages). The gateway cannot proxy without at least one.");
  }
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, {
          ok: true,
          mode: gatewayMode,
          openaiUpstream: openaiBaseUrl,
          anthropicUpstream: anthropicBaseUrl,
          openaiKey: Boolean(openaiKey),
          anthropicKey: Boolean(anthropicKey)
        });
        return;
      }
      if (request.method !== "POST" || !url.pathname.startsWith("/v1/")) {
        send(response, 404, "Gateway supports POST /v1/* and GET /health.", "text/plain; charset=utf-8");
        return;
      }

      const bodyText = await readRequestBody(request);
      const requestBody = safeJson(bodyText) ?? {};
      const budget = readBudget();
      const summary = await readGatewaySummary({ windowMs: budgetWindowMs() });
      // Compress the request body once (safe, lossless-by-construction). Disable with AIM_COMPRESS=off.
      const compressionOn = (process.env.AIM_COMPRESS ?? "on").toLowerCase() !== "off";
      let forwardBody = bodyText;
      let compression = null;
      if (compressionOn) {
        const c = compressRequestBody(requestBody);
        if (c.savedChars > 0 && c.touched > 0) {
          forwardBody = JSON.stringify(c.body);
          compression = {
            savedTokens: c.savedTokens,
            savedChars: c.savedChars,
            beforeChars: c.before,
            afterChars: c.after,
            fieldsTouched: c.touched,
            truth: "estimated"
          };
        }
      }
      // Pre-call cap: price THIS request from its own tokens and block before
      // forwarding if (already spent in the window + this call) would exceed the
      // cap. Catches both accumulated overspend and a single oversized call.
      const preCall = estimateRequestCost(requestBody);
      const callEstimate = preCall.estimatedUsd ?? 0;
      const projectedCostUsd = Number((summary.estimatedCostUsd + callEstimate).toFixed(6));
      if (budget !== null && projectedCostUsd > budget) {
        const blockedByThisCall = summary.estimatedCostUsd < budget;
        const event = {
          at: new Date().toISOString(),
          path: url.pathname,
          model: requestBody.model ?? "unknown",
          status: 429,
          durationMs: Date.now() - started,
          usage: null,
          cost: null,
          truth: "budget_guard",
          guard: {
            spentUsd: summary.estimatedCostUsd,
            callEstimateUsd: callEstimate,
            callEstimateTruth: preCall.truth,
            projectedUsd: projectedCostUsd,
            capUsd: budget,
            blockedByThisCall
          },
          error: blockedByThisCall
            ? `Budget would be exceeded by this call: $${summary.estimatedCostUsd} spent + ~$${callEstimate} this call > cap $${budget}`
            : `Budget exceeded: ${summary.estimatedCostUsd} >= ${budget}`,
          requestHash: createHash("sha1").update(bodyText).digest("hex")
        };
        await appendGatewayEvent(event);
        sendJson(response, { error: event.error, truth: event.truth, guard: event.guard }, 429);
        const breachText = blockedByThisCall
          ? `Runcap: cap protected. Blocked a ~$${callEstimate} call on ${event.model} before it ran ($${summary.estimatedCostUsd} already spent, cap $${budget}).`
          : `Runcap: cap hit. Run blocked at $${summary.estimatedCostUsd} (cap $${budget}) on ${event.model}. The gateway stopped the call before it could spend more.`;
        sendAlert(breachText)
          .then((channels) => {
            if (channels && channels.length) console.log(`Cap-breach alert sent to: ${channels.join(", ")}`);
          })
          .catch(() => {});
        syncRun({
          mission_id: null,
          label: `gateway cap breach (${event.model})`,
          estimate_low: budget,
          estimate_high: projectedCostUsd,
          cap: budget,
          actual: summary.estimatedCostUsd,
          capped: true,
          status: "capped"
        }).catch(() => {});
        return;
      }
      if (gatewayMode === "mock") {
        const responseBody = mockCompletion(requestBody, url.pathname);
        const responseText = JSON.stringify(responseBody);
        send(response, 200, responseText, "application/json; charset=utf-8");
        await appendGatewayEvent({
          at: new Date().toISOString(),
          path: url.pathname,
          model: requestBody.model ?? responseBody.model ?? "mock-model",
          status: 200,
          durationMs: Date.now() - started,
          usage: responseBody.usage,
          cost: estimateApiCost(responseBody.usage, requestBody.model ?? responseBody.model),
          compression,
          truth: "mock_provider_usage",
          requestHash: createHash("sha1").update(bodyText).digest("hex")
        });
        return;
      }
      const isAnthropic = url.pathname.startsWith("/v1/messages");
      const upstreamBase = isAnthropic ? anthropicBaseUrl : openaiBaseUrl;
      const upstreamKey = isAnthropic ? anthropicKey : openaiKey;
      if (!upstreamKey) {
        const missing = isAnthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        send(response, 400, `Gateway has no ${missing} set for ${url.pathname}.`, "text/plain; charset=utf-8");
        return;
      }
      const headers = isAnthropic
        ? {
            "x-api-key": upstreamKey,
            "anthropic-version": anthropicVersion,
            "content-type": request.headers["content-type"] ?? "application/json"
          }
        : {
            "authorization": `Bearer ${upstreamKey}`,
            "content-type": request.headers["content-type"] ?? "application/json"
          };
      // Both default upstream base URLs already include /v1, and the child calls
      // us at /v1/*. Strip the leading /v1 from the path when the upstream base
      // already ends in /v1, so we never produce a doubled /v1/v1 (OpenAI 404).
      const baseHasV1 = /\/v1\/?$/.test(upstreamBase);
      const pathForUpstream = baseHasV1 ? url.pathname.replace(/^\/v1/, "") : url.pathname;
      const upstreamUrl = `${upstreamBase.replace(/\/$/, "")}${pathForUpstream}`;
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: forwardBody
      });
      const responseText = await upstreamResponse.text();
      response.writeHead(upstreamResponse.status, {
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store"
      });
      response.end(responseText);

      const responseBody = safeJson(responseText) ?? {};
      await appendGatewayEvent({
        at: new Date().toISOString(),
        path: url.pathname,
        model: requestBody.model ?? responseBody.model ?? "unknown",
        status: upstreamResponse.status,
        durationMs: Date.now() - started,
        usage: responseBody.usage ?? null,
        cost: estimateApiCost(responseBody.usage, requestBody.model ?? responseBody.model),
        compression,
        truth: responseBody.usage ? "provider_usage" : "unknown",
        requestHash: createHash("sha1").update(bodyText).digest("hex")
      });
      if (responseBody.usage) {
        const spent = await readGatewaySummary({ windowMs: budgetWindowMs() });
        syncRun({
          mission_id: null,
          label: "gateway session (actual spend)",
          estimate_low: spent.estimatedCostUsd,
          estimate_high: spent.estimatedCostUsd,
          cap: budget,
          actual: spent.estimatedCostUsd,
          capped: false,
          status: "running"
        }).catch(() => {});
      }
    } catch (error) {
      await appendGatewayEvent({
        at: new Date().toISOString(),
        path: request.url,
        model: "unknown",
        status: 500,
        durationMs: Date.now() - started,
        usage: null,
        cost: null,
        truth: "unknown",
        error: error.message
      }).catch(() => {});
      sendJson(response, { error: error.message }, 500);
    }
  });
  return { server, gatewayMode, openaiKey, anthropicKey, openaiBaseUrl, anthropicBaseUrl };
}

export async function startGateway({ port = 8792, mock = false } = {}) {
  await ensureStore();
  const { server, gatewayMode, openaiKey, anthropicKey, openaiBaseUrl, anthropicBaseUrl } =
    createGatewayServer({ port, mock });
  await listenLocal(server, port, "gateway");
  console.log(`Runcap gateway: http://127.0.0.1:${port}/v1`);
  console.log(`Mode: ${gatewayMode}`);
  if (gatewayMode === "mock") {
    console.log("Upstream: mock local responder");
  } else {
    console.log(`Upstream (OpenAI /v1/chat/completions): ${openaiKey ? openaiBaseUrl : "no key set"}`);
    console.log(`Upstream (Anthropic /v1/messages): ${anthropicKey ? anthropicBaseUrl : "no key set"}`);
  }
  console.log("Press Ctrl+C to stop.");
}

// Start the gateway on an ephemeral free port for the duration of one wrapped
// run, returning a handle the wrapper uses to point the child at it and to shut
// it down afterward. Upstream is pinned from the CURRENT env before the child's
// base URLs are rewritten, so the gateway proxies to the real provider, not to
// itself.
async function startEphemeralGateway({ mock = false } = {}) {
  await ensureStore();
  const upstream = {
    openaiKey: process.env.AIM_UPSTREAM_API_KEY ?? process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    openaiBaseUrl: process.env.AIM_UPSTREAM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"
  };
  const { server, gatewayMode } = createGatewayServer({ port: 0, mock, upstream });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const actualPort = server.address().port;
  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    gatewayMode,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function showStatus(options = {}) {
  await ensureStore();
  const fuel = await readFuel();
  const fuelLine = fuel.currentPercent === null
    ? "Fuel: unknown. Run `runcap fuel set <percent>` to calibrate subscription limits."
    : `Fuel: ${fuel.currentPercent}% (${fuel.source}, confidence: ${fuel.confidence})`;
  if (options.includeFuelOnly) return fuelLine;

  const gateway = await readGatewaySummary();
  const gatewayLine = `Gateway: ${gateway.callCount} calls, ${gateway.totalTokens} tokens, $${gateway.estimatedCostUsd} estimated (${gateway.truth})`;
  const latest = await latestMissionId();
  if (!latest) return `${fuelLine}\n${gatewayLine}\nNo missions recorded yet.`;
  const mission = await readMission(latest);
  return [
    fuelLine,
    gatewayLine,
    `Latest mission: ${mission.id}`,
    `Status: ${mission.stuck.status}`,
    `Exit code: ${mission.exitCode}`,
    `Changed files: ${mission.diffEvidence.changedFiles.length}`,
    `Errors: ${mission.errors.length}`,
    `Report: ${path.join(MISSIONS_DIR, mission.id, "report.md")}`
  ].join("\n");
}

export async function recordFuel(value) {
  await ensureStore();
  const fuel = {
    currentPercent: clampPercent(value),
    source: "manual",
    confidence: "medium",
    updatedAt: new Date().toISOString(),
    calibrations: []
  };
  await writeFile(FUEL_FILE, JSON.stringify(fuel, null, 2));
  return `Fuel set to ${fuel.currentPercent}%. Future missions can estimate subscription burn from this baseline.`;
}

export async function calibrateFuel(id, afterPercent) {
  const mission = await readMission(id);
  const after = clampPercent(afterPercent);
  const before = mission.fuelBefore;
  if (before === null || before === undefined) {
    throw new Error("Mission has no fuelBefore baseline. Use `aim run --fuel-before <percent>` next time.");
  }
  const used = Number(Math.max(0, before - after).toFixed(2));
  mission.fuelAfter = after;
  mission.fuelUsedPercent = used;
  mission.fuelAccuracy = {
    source: "manual_calibration",
    confidence: "high",
    note: "Subscription providers rarely expose exact token-to-percent formulas. This is measured from user-visible before/after fuel."
  };
  const missionDir = path.join(MISSIONS_DIR, mission.id);
  await writeFile(path.join(missionDir, "mission.json"), JSON.stringify(mission, null, 2));
  await writeFile(path.join(missionDir, "report.md"), formatReport(mission));
  await writeFile(path.join(missionDir, "report.html"), formatHtmlReport(mission));

  const fuel = await readFuel();
  fuel.currentPercent = after;
  fuel.updatedAt = new Date().toISOString();
  fuel.calibrations = [...(fuel.calibrations ?? []), { missionId: id, before, after, used, at: fuel.updatedAt }];
  await writeFile(FUEL_FILE, JSON.stringify(fuel, null, 2));
  return `Mission ${id} calibrated: used ${used}% fuel.`;
}

async function ensureStore() {
  await mkdir(MISSIONS_DIR, { recursive: true });
  await mkdir(PLANS_DIR, { recursive: true });
}

function createMissionId(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const cleanLabel = label ? `-${label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 36)}` : "";
  const hash = createHash("sha1").update(`${stamp}${Math.random()}`).digest("hex").slice(0, 7);
  return `${stamp}${cleanLabel}-${hash}`;
}

function createPlanId(goal) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const cleanGoal = goal.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 34) || "ai-work";
  const hash = createHash("sha1").update(`${stamp}${goal}${Math.random()}`).digest("hex").slice(0, 7);
  return `${stamp}-plan-${cleanGoal}-${hash}`;
}

function buildAiWorkPlan(goal, { quality = "high", fuelPercent = null, snapshot = {} } = {}) {
  const cleanGoal = goal.trim();
  const lower = cleanGoal.toLowerCase();
  const words = cleanGoal.split(/\s+/).filter(Boolean).length;
  const taskType = classifyTask(lower);
  const bigSignals = [
    /full|entire|complete|whole|production|everything|mvp|startup|platform/.test(lower),
    /полное|полностью|приложение|платформ/.test(lower),
    words > 22
  ].filter(Boolean).length;
  const hasRepo = Boolean(snapshot.packageJson);
  const hasVerification = hasRepo && Object.keys(snapshot.packageJson?.scripts ?? {}).some((name) => /test|build|lint|typecheck/.test(name));
  const fuel = fuelPercent === null || fuelPercent === undefined || fuelPercent === "" || !Number.isFinite(Number(fuelPercent))
    ? null
    : Number(fuelPercent);
  const budgetRisk = bigSignals > 0 || (fuel !== null && fuel < 30) ? "High" : fuel !== null && fuel < 55 ? "Medium" : "Low";
  const expectedWasteReduction = budgetRisk === "High" ? "40-70%" : budgetRisk === "Medium" ? "25-45%" : "10-25%";
  const qualityRisk = quality === "cheap" && budgetRisk === "High" ? "High" : budgetRisk === "High" ? "Medium" : "Low";
  const routing = routeTask({ taskType, budgetRisk, quality, hasVerification });
  const proof = proofForTask({ taskType, hasVerification });
  const missions = missionBreakdown({ taskType, budgetRisk, proof });
  const cost = estimatePlanCost({ budgetRisk, bigSignals, words, taskType, quality });
  return {
    id: createPlanId(cleanGoal),
    createdAt: new Date().toISOString(),
    goal: cleanGoal,
    taskType,
    inputs: {
      quality,
      fuelPercent: fuel,
      repoDetected: hasRepo,
      verificationDetected: hasVerification
    },
    budget: {
      risk: budgetRisk,
      expectedWasteReduction,
      costLowUsd: cost.lowUsd,
      costHighUsd: cost.highUsd,
      costRange: cost.range,
      recommendedCapUsd: cost.recommendedCapUsd,
      recommendedCap: cost.recommendedCap,
      costPrecision: cost.precision,
      reason: budgetRisk === "High"
        ? "The goal is broad or fuel is low. A single agent run is likely to waste context and repeat work."
        : "The goal can be controlled with smaller missions and proof checkpoints."
    },
    routing,
    quality: {
      risk: qualityRisk,
      proof
    },
    missions,
    stopRule: stopRuleForTask(taskType),
    commandTemplates: commandTemplatesForPlan(cleanGoal, missions),
    truth: {
      source: "local_heuristic_planner",
      costPrecision: "estimate_not_provider_bill",
      qualityPrecision: "requires_artifact_review"
    }
  };
}

// Estimate a USD cost RANGE for an agent run from scope signals, priced against
// the sourced table. Deliberately a range, not an oracle: agent runs are
// stochastic. The recommended cap sits above the high end so a normal run
// completes but a runaway loop is stopped.
function estimatePlanCost({ budgetRisk, bigSignals, words, taskType, quality }) {
  // Base expected total tokens (input+output across the whole run, including
  // the agent re-reading context on each loop). Software runs loop more.
  let baseTokens = taskType === "software" ? 220000 : 120000;
  baseTokens += words * 1500;
  baseTokens += bigSignals * 350000;
  if (budgetRisk === "High") baseTokens *= 2.4;
  else if (budgetRisk === "Medium") baseTokens *= 1.5;

  // Premium-model blended price ($/token): planning on a strong model is the
  // expensive case, so we price the headline range against it to avoid
  // under-promising. Opus-class: ~$5/M in, ~$25/M out, assume ~30% output.
  const blendedPerToken = quality === "cheap"
    ? (0.75 * 0.7 + 4.5 * 0.3) / 1_000_000   // cheap tier (gpt-5.4-mini)
    : (5 * 0.7 + 25 * 0.3) / 1_000_000;       // strong tier (opus-class)

  const mid = baseTokens * blendedPerToken;
  // Range: runs vary widely, so +-45% around the midpoint.
  const lowUsd = round2(mid * 0.55);
  const highUsd = round2(mid * 1.45);
  // Cap above the high end (1.5x) so a normal run finishes, a loop is killed.
  const recommendedCapUsd = roundCap(highUsd * 1.5);
  return {
    lowUsd,
    highUsd,
    recommendedCapUsd,
    range: `$${lowUsd.toFixed(2)}-$${highUsd.toFixed(2)}`,
    recommendedCap: `$${recommendedCapUsd.toFixed(2)}`,
    precision: "calculated_estimate_not_provider_bill"
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function roundCap(n) {
  // Round caps to a friendly number: nearest $1 under $20, nearest $5 above.
  if (n < 20) return Math.max(1, Math.ceil(n));
  return Math.ceil(n / 5) * 5;
}

function classifyTask(lower) {
  if (/code|bug|test|build|app|api|database|typescript|react|python|deploy|auth|repo|github/.test(lower)) return "software";
  if (/video|script|post|content|image|marketing|copy|campaign|linkedin|youtube/.test(lower)) return "creative";
  if (/invoice|crm|email|calendar|automation|report|workflow|support|sales|ops/.test(lower)) return "operations";
  if (/research|market|competitor|analysis|strategy|audit/.test(lower)) return "research";
  return "general";
}

function routeTask({ taskType, budgetRisk, quality, hasVerification }) {
  const strongFirst = budgetRisk === "High" || quality === "high";
  const executionTier = taskType === "software" && hasVerification
    ? "Balanced or cheap model for narrow edits after diagnosis"
    : taskType === "creative" && quality !== "high"
      ? "Cheap model for drafts, strong model only for final review"
      : taskType === "research"
        ? "Cheap model for collection, strong model for synthesis"
        : "Cheap model for execution with owner review";
  return {
    planningTier: strongFirst ? "Strong model for planning only" : "Cheap model first",
    executionTier,
    escalationRule: "Escalate to a stronger model only when proof fails, architecture is unclear, or the same blocker repeats."
  };
}

function proofForTask({ taskType, hasVerification }) {
  if (taskType === "software") {
    return hasVerification
      ? "diff exists, verification command passes, and changed files match the mission scope"
      : "diff exists, app starts or manual smoke check is documented";
  }
  if (taskType === "creative") return "usable artifact exists, revision checklist is completed, and owner selects one direction";
  if (taskType === "operations") return "sample workflow output is reviewed by owner and exception path is documented";
  if (taskType === "research") return "source list, synthesis, and decision recommendation are separated";
  return "artifact exists and owner can inspect whether it solves the requested job";
}

function missionBreakdown({ taskType, budgetRisk, proof }) {
  const first = taskType === "software"
    ? "Inspect the repo, identify files, dependencies, verification command, and risk. Do not write code yet."
    : taskType === "creative"
      ? "Define target audience, format, acceptance checklist, and 2-3 directions before generation."
      : taskType === "operations"
        ? "Map current workflow, inputs, outputs, owner approvals, and failure cases."
        : "Clarify the decision, collect only necessary context, and define what proof will be accepted.";
  const second = taskType === "software"
    ? "Implement one narrow vertical slice and run exactly one verification command."
    : "Create the smallest useful artifact that can be reviewed by the owner.";
  return [
    { name: "Discovery mission", modelTier: budgetRisk === "High" ? "Strong" : "Cheap", instruction: first, proof: "plan with files/tools/proof, no broad execution" },
    { name: "Execution mission", modelTier: "Cheaper unless proof fails", instruction: second, proof },
    { name: "Review mission", modelTier: "Strong only if needed", instruction: "Compare result against proof, list gaps, and decide continue/stop/rescue.", proof: "clear continue, stop, or rescue decision" }
  ];
}

function stopRuleForTask(taskType) {
  if (taskType === "software") return "Stop after the same error appears twice, after 10 minutes with no file changes, or after a broad rewrite request appears.";
  if (taskType === "creative") return "Stop when output repeats, becomes generic, or produces no inspectable artifact.";
  if (taskType === "operations") return "Stop when the agent cannot name the owner, system of record, approval point, or exception path.";
  if (taskType === "research") return "Stop when sources are missing, claims are uncited, or the answer becomes a generic summary.";
  return "Stop when there is no new artifact, no proof, or repeated generic output.";
}

function commandTemplatesForPlan(goal, missions) {
  const quotedGoal = goal.replace(/"/g, '\\"');
  return missions.map((mission, index) => ({
    mission: mission.name,
    command: `runcap run --label plan-${index + 1} -- codex "${mission.instruction} Goal: ${quotedGoal} Proof required: ${mission.proof}"`
  }));
}

async function runChild(command, cwd, extraEnv = {}) {
  const started = Date.now();
  const [program, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, AIM_WRAPPED: "1", ...extraEnv },
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      stderr += `\n${error.stack ?? error.message}\n`;
      resolve({ stdout, stderr, exitCode: 127, signal: null, durationMs: Date.now() - started });
    });
    child.on("close", (exitCode, signal) => {
      resolve({ stdout, stderr, exitCode, signal, durationMs: Date.now() - started });
    });
  });
}

async function collectSnapshot(cwd) {
  const [status, diffNameStatus, diff, packageJson, tsconfig] = await Promise.all([
    git(["status", "--short", "--", "."], cwd),
    git(["diff", "--name-status", "--", "."], cwd),
    git(["diff", "--", "."], cwd),
    readOptional(path.join(cwd, "package.json")),
    readOptional(path.join(cwd, "tsconfig.json"))
  ]);
  return {
    at: new Date().toISOString(),
    gitAvailable: !status.error,
    status: status.text,
    diffNameStatus: diffNameStatus.text,
    diff: diff.text,
    packageJson: packageJson ? safeJson(packageJson) : null,
    tsconfig: tsconfig ? safeJson(tsconfig) : null
  };
}

async function git(args, cwd) {
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ text: "", error: error.message }));
    child.on("close", (code) => resolve({ text: stdout.trim(), error: code === 0 ? null : stderr.trim() }));
  });
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: true };
  }
}

function analyzeDiff(before, after) {
  const beforeLines = new Set(cleanDiffNameStatus(before.diffNameStatus));
  const afterLines = cleanDiffNameStatus(after.diffNameStatus);
  const missionLines = afterLines.filter((line) => !beforeLines.has(line));
  const changed = missionLines.map((line) => {
    const [, file = line] = line.split(/\s+/, 2);
    return file;
  });
  const newDiffLines = after.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const addedImports = newDiffLines
    .map((line) => line.match(/import .* from ['"]([^'"]+)['"]/))
    .filter(Boolean)
    .map((match) => match[1]);
  return {
    changedFiles: [...new Set(changed)],
    changedFileCount: new Set(changed).size,
    hadPreExistingDiff: beforeLines.size > 0,
    addedImports: [...new Set(addedImports)],
    diffBytes: after.diff.length,
    diffHash: createHash("sha1").update(after.diff).digest("hex")
  };
}

function cleanDiffNameStatus(text) {
  return (text || "")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.includes(".runcap/") && !line.includes(".aim-control/"));
}

function buildPreflight(prompt, snapshot) {
  const lower = prompt.toLowerCase();
  const broadWords = ["build app", "entire app", "full app", "production", "everything", "whole project", "сделай приложение", "полное приложение"];
  const risky = broadWords.filter((word) => lower.includes(word));
  const hasPackage = Boolean(snapshot.packageJson);
  const hasTests = hasPackage && Object.keys(snapshot.packageJson.scripts ?? {}).some((name) => /test|build|lint|typecheck/.test(name));
  return {
    scopeRisk: risky.length > 0 ? "high" : prompt.length > 180 ? "medium" : "low",
    scopeSignals: risky,
    repoSignals: {
      hasPackageJson: hasPackage,
      hasTsconfig: Boolean(snapshot.tsconfig),
      hasVerificationScripts: hasTests
    },
    recommendation: risky.length > 0
      ? "Split the mission into a narrow vertical slice before running an expensive agent loop."
      : "Mission looks narrow enough for a first run, but proof should still be verified through artifacts."
  };
}

function parseErrors(text) {
  const errors = [];
  for (const pattern of ERROR_PATTERNS) {
    for (const regex of pattern.regexes) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        errors.push({
          kind: pattern.kind,
          confidence: pattern.confidence,
          raw: match[0].slice(0, 280),
          primary: match[1] ?? null,
          detail: match[2] ?? null,
          sourceFile: findSourceFileNear(text, match.index),
          line: findLineNear(text, match.index)
        });
      }
    }
  }
  return dedupe(errors, (error) => `${error.kind}:${error.raw}`);
}

function findSourceFileNear(text, index) {
  const start = Math.max(0, index - 420);
  const end = Math.min(text.length, index + 620);
  const chunk = text.slice(start, end);
  const importedFrom = chunk.match(/imported from ([^\s\n)]+)/);
  if (importedFrom?.[1]) return cleanPath(importedFrom[1]);
  const file = chunk.match(/([A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs))/);
  return file?.[1] ? cleanPath(file[1]) : null;
}

function findLineNear(text, index) {
  const start = Math.max(0, index - 220);
  const end = Math.min(text.length, index + 220);
  const chunk = text.slice(start, end);
  const line = chunk.match(/(?:line |:)(\d+)(?::\d+)?/i);
  return line?.[1] ? Number(line[1]) : null;
}

function cleanPath(value) {
  return String(value).replace(/^file:\/\//, "").replace(/[),.;]+$/, "");
}

function detectStuck({ output, errors, diffEvidence, preflight }) {
  const signals = [];
  if (output.exitCode !== 0) signals.push({ signal: "command_failed", weight: 2, evidence: `exit code ${output.exitCode}` });
  if (errors.length > 0) signals.push({ signal: "terminal_errors", weight: 2, evidence: `${errors.length} parsed error(s)` });
  if (errors.some((error) => error.kind === "command_not_found")) {
    signals.push({ signal: "missing_cli", weight: 2, evidence: "the requested command could not be found on PATH" });
  }
  if (diffEvidence.changedFiles.length === 0 && output.durationMs > 3000) {
    signals.push({ signal: "no_artifact", weight: 2, evidence: "no git diff changed during mission" });
  }
  if (diffEvidence.changedFiles.length > 0 && output.exitCode !== 0) {
    signals.push({ signal: "artifact_but_not_verified", weight: 1, evidence: "files changed but command failed" });
  }
  if (preflight.scopeRisk === "high") {
    signals.push({ signal: "scope_too_broad", weight: 1, evidence: "preflight detected broad mission wording" });
  }
  const score = signals.reduce((sum, item) => sum + item.weight, 0);
  return {
    status: score >= 4 ? "stuck" : score >= 2 ? "at_risk" : "progressing",
    confidence: score >= 5 ? "high" : score >= 3 ? "medium" : "low",
    score,
    signals
  };
}

function buildRescuePacket({ command, output, errors, diffEvidence, preflight, stuck }) {
  const recommendations = [];
  const moduleErrors = errors.filter((error) => error.kind === "module_not_found");
  const tsErrors = errors.filter((error) => error.kind === "typescript_error");
  const commandErrors = errors.filter((error) => error.kind === "command_not_found");

  for (const error of commandErrors) {
    const missingCommand = error.primary ?? command[0];
    recommendations.push({
      title: "Install or expose the missing agent command",
      confidence: "high",
      evidence: [
        error.raw,
        `Requested command: ${command[0]}`,
        "The process failed before the agent could do any useful work."
      ],
      nextAction: `Install '${missingCommand}' or run the mission with a command that exists in this terminal session.`,
      prompt: `The agent command '${missingCommand}' was not found. Do not retry the same command until the CLI is installed and available on PATH. First run '${missingCommand} --version' or choose another installed agent command, then rerun the mission.`
    });
  }

  for (const error of moduleErrors) {
    const imported = error.primary;
    const wasAdded = imported && diffEvidence.addedImports.includes(imported);
    const sourceChanged = error.sourceFile && diffEvidence.changedFiles.some((file) => error.sourceFile.endsWith(file) || file.endsWith(error.sourceFile));
    recommendations.push({
      title: "Resolve missing import before continuing feature work",
      confidence: wasAdded || sourceChanged ? "high" : "medium",
      evidence: [
        error.raw,
        wasAdded ? `The missing import '${imported}' appears in the latest git diff.` : "The terminal reported a missing module.",
        error.sourceFile ? `Source file: ${error.sourceFile}${sourceChanged ? " (changed in this mission)" : ""}` : "No source file could be extracted from the terminal output.",
        diffEvidence.changedFiles.length ? `Changed files: ${diffEvidence.changedFiles.join(", ")}` : "No changed files were detected."
      ],
      nextAction: wasAdded
        ? `Ask the agent to verify whether '${imported}' exists, whether the path alias is configured, and to change only the import path or create the missing module.`
        : "Ask the agent to locate the missing module and inspect package.json/tsconfig paths before writing more code.",
      prompt: `Do not continue broad implementation. Diagnose this missing module first: ${error.raw}. Check package.json, tsconfig paths, and the latest git diff. Make the smallest change that resolves the import, then run the failing command again.`
    });
  }

  if (tsErrors.length > 0) {
    recommendations.push({
      title: "Fix TypeScript errors against the changed files",
      confidence: "medium",
      evidence: [
        `${tsErrors.length} TypeScript error(s) parsed from terminal output.`,
        `Source files: ${tsErrors.map((error) => error.sourceFile).filter(Boolean).join(", ") || "unknown"}`,
        diffEvidence.changedFiles.length ? `Changed files: ${diffEvidence.changedFiles.join(", ")}` : "No changed files were detected."
      ],
      nextAction: "Ask the agent to map each TS error to a changed file before editing anything else.",
      prompt: `Focus only on these TypeScript errors: ${tsErrors.map((error) => error.raw).join(" | ")}. For each error, identify the file and the smallest fix. Do not refactor unrelated code.`
    });
  }

  if (diffEvidence.changedFiles.length === 0 && output.exitCode !== 0) {
    recommendations.push({
      title: "Switch from implementation to diagnosis",
      confidence: "high",
      evidence: ["The command failed and produced no git diff artifact."],
      nextAction: "Run an explorer/diagnostic pass before asking for implementation again.",
      prompt: `Do not write code yet. Inspect the project and explain why this command failed: ${command.join(" ")}. Return the exact files or config values needed to fix it.`
    });
  }

  if (preflight.scopeRisk === "high") {
    recommendations.push({
      title: "Reduce scope before another expensive run",
      confidence: "medium",
      evidence: preflight.scopeSignals.map((signal) => `Broad scope signal: ${signal}`),
      nextAction: "Turn the mission into one vertical slice with one verification command.",
      prompt: "Rewrite this mission as one deliverable that can be completed and verified in under 30 minutes. Include acceptance criteria and stop conditions."
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      title: "Continue with checkpointed verification",
      confidence: "low",
      evidence: ["No strong failure pattern was detected."],
      nextAction: "Continue only with a clear verification command and stop if no artifact changes.",
      prompt: "Continue the task, but after each change run the smallest relevant verification command and summarize the evidence."
    });
  }

  return {
    verdict: stuck.status === "stuck" ? "rescue_required" : stuck.status === "at_risk" ? "checkpoint_required" : "continue_with_monitoring",
    recommendations
  };
}

async function readMission(id) {
  const file = path.join(MISSIONS_DIR, id, "mission.json");
  return JSON.parse(await readFile(file, "utf8"));
}

async function readMissionSummaries() {
  const ids = await listMissionIds();
  const missions = await Promise.all(ids.map(async (id) => readMission(id).catch(() => null)));
  return missions.filter(Boolean).map(summarizeMission).reverse();
}

async function readPlan(id) {
  const file = path.join(PLANS_DIR, id, "plan.json");
  return JSON.parse(await readFile(file, "utf8"));
}

async function readPlans() {
  if (!existsSync(PLANS_DIR)) return [];
  const ids = (await readdir(PLANS_DIR)).sort();
  const plans = await Promise.all(ids.map(async (id) => readPlan(id).catch(() => null)));
  return plans.filter(Boolean).reverse();
}

function summarizeMission(mission) {
  return {
    id: mission.id,
    label: mission.label,
    command: mission.command.join(" "),
    startedAt: mission.startedAt,
    status: mission.stuck.status,
    confidence: mission.stuck.confidence,
    exitCode: mission.exitCode,
    errorCount: mission.errors.length,
    changedFileCount: mission.diffEvidence.changedFiles.length,
    fuelBefore: mission.fuelBefore,
    fuelAfter: mission.fuelAfter,
    fuelUsedPercent: mission.fuelUsedPercent,
    primaryRecommendation: mission.rescue.recommendations[0]?.title ?? null
  };
}

async function listMissionIds() {
  if (!existsSync(MISSIONS_DIR)) return [];
  const names = await readdir(MISSIONS_DIR);
  return names.sort();
}

async function readFuel() {
  try {
    return JSON.parse(await readFile(FUEL_FILE, "utf8"));
  } catch {
    return { currentPercent: null, source: "unknown", confidence: "unknown", calibrations: [] };
  }
}

async function dashboardStatus() {
  const fuel = await readFuel();
  const missions = await readMissionSummaries();
  const gateway = await readGatewaySummary();
  return {
    fuel,
    gateway,
    budget: readBudget(),
    missionCount: missions.length,
    latest: missions[0] ?? null,
    counts: missions.reduce((acc, mission) => {
      acc[mission.status] = (acc[mission.status] ?? 0) + 1;
      return acc;
    }, {})
  };
}

async function appendGatewayEvent(event) {
  await appendFile(GATEWAY_EVENTS_FILE, `${JSON.stringify(event)}\n`);
}

async function readGatewayEvents() {
  const text = await readOptional(GATEWAY_EVENTS_FILE);
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => safeJson(line)).filter(Boolean);
}

async function readGatewaySummary({ windowMs } = {}) {
  const allEvents = await readGatewayEvents();
  // When a window is given (used by the budget guard), only count spend whose
  // timestamp falls inside it. The cap is then a per-window budget that resets,
  // not an all-time counter that locks the gateway forever.
  const events = windowMs
    ? allEvents.filter((event) => {
        const t = Date.parse(event.at ?? "");
        return Number.isFinite(t) && Date.now() - t <= windowMs;
      })
    : allEvents;
  const successful = events.filter((event) => event.status >= 200 && event.status < 300);
  const totalTokens = events.reduce((sum, event) => {
    const u = event.usage;
    if (!u) return sum;
    const total = Number(u.total_tokens ?? 0) ||
      Number(u.prompt_tokens ?? u.input_tokens ?? 0) + Number(u.completion_tokens ?? u.output_tokens ?? 0);
    return sum + total;
  }, 0);
  const estimatedCost = events.reduce((sum, event) => sum + Number(event.cost?.estimatedUsd ?? 0), 0);
  const savedTokens = events.reduce((sum, event) => sum + Number(event.compression?.savedTokens ?? 0), 0);
  // Value the saved tokens at a blended input rate from the price table so we can
  // show one honest dollar figure. Per saved input token: use the model's input rate.
  const savedUsd = events.reduce((sum, event) => {
    const saved = Number(event.compression?.savedTokens ?? 0);
    if (!saved) return sum;
    const pricing = modelPricing(event.model);
    const inputRate = pricing ? pricing.inputPerMillion : 3; // fall back to a mid Sonnet-ish rate
    return sum + (saved * inputRate) / 1_000_000;
  }, 0);
  return {
    callCount: events.length,
    successfulCallCount: successful.length,
    totalTokens,
    estimatedCostUsd: Number(estimatedCost.toFixed(6)),
    savedTokens,
    savedUsd: Number(savedUsd.toFixed(6)),
    wouldHaveSpentUsd: Number((estimatedCost + savedUsd).toFixed(6)),
    truth: events.some((event) => event.truth === "provider_usage" || event.truth === "mock_provider_usage")
      ? "usage_plus_static_price_table"
      : "unknown",
    windowMs: windowMs ?? null,
    recent: events.slice(-20).reverse()
  };
}

// How wide the budget window is, in ms. AIM_BUDGET_WINDOW controls it:
//   "day" (default) → rolling 24h, "session" → since gateway start, "all" → no reset.
const GATEWAY_STARTED_AT = Date.now();
function budgetWindowMs() {
  const mode = (process.env.AIM_BUDGET_WINDOW ?? "day").toLowerCase();
  if (mode === "all") return undefined;
  if (mode === "session") return Date.now() - GATEWAY_STARTED_AT;
  const hours = Number(mode);
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000; // "day" default
}

// The cap value. Precedence: AIM_DAILY_BUDGET_USD env > persisted budget.json
// (written by `runcap plan` / `runcap cap`). Null means no cap is set.
function readBudget() {
  const raw = process.env.AIM_DAILY_BUDGET_USD;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const stored = readStoredBudget();
  return stored;
}

function readStoredBudget() {
  if (!existsSync(BUDGET_FILE)) return null;
  let text = null;
  try { text = readFileSync(BUDGET_FILE, "utf8"); } catch { return null; }
  const parsed = safeJson(text);
  const raw = parsed?.capUsd;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function mockCompletion(requestBody, pathname = "/v1/chat/completions") {
  const content = "Mock response from Runcap gateway. This call was recorded with provider-like usage for demo and budget testing.";
  const promptText = JSON.stringify(requestBody.messages ?? requestBody.input ?? requestBody.prompt ?? "");
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(12, Math.ceil(content.length / 4));

  if (pathname.startsWith("/v1/messages")) {
    // Anthropic Messages API shape.
    return {
      id: `msg-mock-${Date.now()}`,
      type: "message",
      role: "assistant",
      model: requestBody.model ?? "claude-sonnet-4-6",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        cache_read_input_tokens: 0
      }
    };
  }

  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestBody.model ?? "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

// Sourced multi-provider price table.
// Sources: claude.com/pricing (Anthropic API) and developers.openai.com/api/docs/pricing.
// Verified 2026-06-01. Prices are USD per 1,000,000 tokens.
// cacheReadPerMillion = cost of a cached-read input token (Anthropic ~10% of input, OpenAI ~10% of input).
// Batch APIs run at ~50% of standard rates for both providers.
const PRICE_TABLE_SOURCE = "official_provider_pricing";
const PRICE_TABLE_VERIFIED = "2026-06-01";
const BATCH_DISCOUNT = 0.5;

const MODEL_PRICES = [
  // Anthropic (claude.com/pricing)
  { match: ["claude-opus", "opus-4"], inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, provider: "anthropic" },
  { match: ["claude-sonnet", "sonnet-4"], inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, provider: "anthropic" },
  { match: ["claude-haiku", "haiku-4"], inputPerMillion: 1, outputPerMillion: 5, cacheReadPerMillion: 0.1, provider: "anthropic" },
  // OpenAI (developers.openai.com/api/docs/pricing)
  { match: ["gpt-5.5"], inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.5, provider: "openai" },
  { match: ["gpt-5.4-nano"], inputPerMillion: 0.2, outputPerMillion: 1.25, cacheReadPerMillion: 0.02, provider: "openai" },
  { match: ["gpt-5.4-mini", "gpt-5-mini"], inputPerMillion: 0.75, outputPerMillion: 4.5, cacheReadPerMillion: 0.075, provider: "openai" },
  { match: ["gpt-5.4", "gpt-5"], inputPerMillion: 2.5, outputPerMillion: 15, cacheReadPerMillion: 0.25, provider: "openai" },
  // Legacy OpenAI (kept for back-compat with older agents)
  { match: ["gpt-4.1-mini"], inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0.1, provider: "openai" },
  { match: ["gpt-4.1"], inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5, provider: "openai" },
  { match: ["gpt-4o-mini"], inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075, provider: "openai" },
  { match: ["gpt-4o"], inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, provider: "openai" }
];

function estimateApiCost(usage, model) {
  if (!usage) return null;
  const pricing = modelPricing(model);
  if (!pricing) {
    return {
      estimatedUsd: null,
      truth: "unknown_price",
      note: `No verified price entry for model "${model}". Cost is honestly unknown rather than guessed.`
    };
  }
  // Token fields differ by provider:
  //   OpenAI: prompt_tokens / completion_tokens (+ prompt_tokens_details.cached_tokens)
  //   Anthropic: input_tokens / output_tokens (+ cache_read_input_tokens)
  const cachedInput = Number(
    usage.cache_read_input_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0
  );
  const rawInput = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const freshInput = Math.max(0, rawInput - cachedInput);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);

  const inputRate = pricing.batch ? pricing.inputPerMillion * BATCH_DISCOUNT : pricing.inputPerMillion;
  const outputRate = pricing.batch ? pricing.outputPerMillion * BATCH_DISCOUNT : pricing.outputPerMillion;
  const cacheRate = pricing.batch ? pricing.cacheReadPerMillion * BATCH_DISCOUNT : pricing.cacheReadPerMillion;

  const estimatedUsd =
    (freshInput / 1_000_000) * inputRate +
    (cachedInput / 1_000_000) * cacheRate +
    (output / 1_000_000) * outputRate;

  return {
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    truth: "calculated_from_sourced_price_table",
    pricing: {
      ...pricing,
      source: PRICE_TABLE_SOURCE,
      verified: PRICE_TABLE_VERIFIED,
      cachedInputTokens: cachedInput
    }
  };
}

// Estimate the cost of a request BEFORE it is forwarded upstream, from the
// request body alone. Input tokens are estimated from the serialized prompt;
// output tokens from the caller's max_tokens (the worst case the provider can
// bill). Returns null when the model has no verified price, so the guard can
// decide whether to fail open or closed rather than guessing a number.
function estimateRequestCost(requestBody) {
  const model = requestBody?.model ?? "";
  const pricing = modelPricing(model);
  if (!pricing) return { estimatedUsd: null, truth: "unknown_price", model };

  const promptText = JSON.stringify(
    requestBody.messages ?? requestBody.system ?? requestBody.input ?? requestBody.prompt ?? ""
  );
  const inputTokens = estimateTokens(promptText);
  // Worst-case output the provider could bill: honor the caller's stated cap,
  // else assume a generous default so the guard is not fooled by an open-ended call.
  const maxOutput = Number(
    requestBody.max_tokens ??
    requestBody.max_completion_tokens ??
    requestBody.max_output_tokens ??
    4096
  );
  const outputTokens = Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 4096;

  const estimatedUsd =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;

  return {
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    truth: "pre_call_estimate_from_request",
    model,
    inputTokens,
    outputTokens
  };
}

function modelPricing(model = "") {
  const name = String(model).toLowerCase();
  const batch = name.includes("batch");
  for (const entry of MODEL_PRICES) {
    if (entry.match.some((m) => name.includes(m))) {
      return {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion,
        provider: entry.provider,
        batch,
        source: PRICE_TABLE_SOURCE,
        verified: PRICE_TABLE_VERIFIED
      };
    }
  }
  return null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function shortSummary(mission) {
  return [
    "",
    `Runcap mission: ${mission.id}`,
    `Status: ${mission.stuck.status} (${mission.stuck.confidence} confidence)`,
    `Exit code: ${mission.exitCode}`,
    `Changed files: ${mission.diffEvidence.changedFiles.length}`,
    `Parsed errors: ${mission.errors.length}`,
    `Primary recommendation: ${mission.rescue.recommendations[0]?.title}`,
    `Report: ${path.join(MISSIONS_DIR, mission.id, "report.md")}`,
    `HTML: ${path.join(MISSIONS_DIR, mission.id, "report.html")}`,
    ""
  ].join("\n");
}

function formatPreflight({ command, preflight, fuel }) {
  const fuelLine = fuel.currentPercent === null
    ? "Fuel: unknown. Set it with `runcap fuel set <percent>` if using subscriptions."
    : `Fuel: ${fuel.currentPercent}% (${fuel.confidence} confidence)`;
  const scopeAdvice = preflight.scopeRisk === "high"
    ? "Do not launch as one broad mission. Split into one vertical slice with a verification command."
    : preflight.scopeRisk === "medium"
      ? "Launch with a strict checkpoint and stop condition."
      : "Safe to run as a first checkpointed mission.";
  return [
    `Preflight: ${command.join(" ")}`,
    `Scope risk: ${preflight.scopeRisk}`,
    fuelLine,
    `Repo: package.json=${preflight.repoSignals.hasPackageJson}, tsconfig=${preflight.repoSignals.hasTsconfig}, verification scripts=${preflight.repoSignals.hasVerificationScripts}`,
    `Recommendation: ${scopeAdvice}`,
    "",
    "Suggested mission contract:",
    "- Define one deliverable.",
    "- Define one verification command.",
    "- Stop if no artifact changes after the first failed loop.",
    "- Require evidence before calling the task done."
  ].join("\n");
}

function formatReport(mission) {
  const fuel = mission.fuelUsedPercent === null
    ? `Fuel: before ${mission.fuelBefore ?? "unknown"}%, after unknown. Calibrate with \`runcap fuel calibrate ${mission.id} <after-percent>\`.`
    : `Fuel used: ${mission.fuelUsedPercent}% (source: manual calibration, confidence: high).`;
  const errorLines = mission.errors.length
    ? mission.errors.map((error) => `- ${error.kind} (${error.confidence}): ${error.raw}`).join("\n")
    : "- none parsed";
  const signalLines = mission.stuck.signals.length
    ? mission.stuck.signals.map((item) => `- ${item.signal}: ${item.evidence}`).join("\n")
    : "- no strong stuck signals";
  const recommendationLines = mission.rescue.recommendations.map((rec, index) => [
    `${index + 1}. ${rec.title} (${rec.confidence})`,
    `   Evidence: ${rec.evidence.join(" | ")}`,
    `   Next action: ${rec.nextAction}`,
    `   Rescue prompt: ${rec.prompt}`
  ].join("\n")).join("\n\n");
  return `# Runcap Mission Report

Mission: ${mission.id}
Command: \`${mission.command.join(" ")}\`
Status: ${mission.stuck.status}
Confidence: ${mission.stuck.confidence}
Exit code: ${mission.exitCode}
Duration: ${Math.round(mission.durationMs / 1000)}s
${fuel}

## Evidence
- Changed files: ${mission.diffEvidence.changedFiles.length ? mission.diffEvidence.changedFiles.join(", ") : "none"}
- Diff bytes: ${mission.diffEvidence.diffBytes}
- Added imports: ${mission.diffEvidence.addedImports.length ? mission.diffEvidence.addedImports.join(", ") : "none"}
- Scope risk: ${mission.preflight.scopeRisk}

## Parsed Errors
${errorLines}

## Stuck Signals
${signalLines}

## Rescue Recommendations
${recommendationLines}

## Truth Labels
- Cost/Fuel: ${mission.fuelUsedPercent === null ? "estimated/unknown until calibrated" : "observed from manual before/after calibration"}
- Progress proof: observed from git diff and command result
- Error parsing: calculated from terminal logs
- Rescue advice: generated from evidence packet, not from hidden assumptions
`;
}

function formatPlan(plan) {
  const missionLines = plan.missions.map((mission, index) => [
    `${index + 1}. ${mission.name}`,
    `   Model tier: ${mission.modelTier}`,
    `   Instruction: ${mission.instruction}`,
    `   Proof: ${mission.proof}`
  ].join("\n")).join("\n\n");
  const commandLines = plan.commandTemplates.map((template) => [
    `### ${template.mission}`,
    "```bash",
    template.command,
    "```"
  ].join("\n")).join("\n\n");
  return `# AI Work Plan

Plan: ${plan.id}
Goal: ${plan.goal}
Task type: ${plan.taskType}
Created: ${plan.createdAt}

## Budget Decision
- Risk: ${plan.budget.risk}
- Expected waste reduction: ${plan.budget.expectedWasteReduction}
- Reason: ${plan.budget.reason}

## Model Routing
- Planning: ${plan.routing.planningTier}
- Execution: ${plan.routing.executionTier}
- Escalation: ${plan.routing.escalationRule}

## Quality Proof
- Risk: ${plan.quality.risk}
- Proof: ${plan.quality.proof}

## Missions
${missionLines}

## Stop Rule
${plan.stopRule}

## Command Templates
${commandLines}

## Truth Labels
- Planner source: ${plan.truth.source}
- Cost precision: ${plan.truth.costPrecision}
- Quality precision: ${plan.truth.qualityPrecision}
`;
}

function formatHtmlReport(mission) {
  const firstRecommendation = mission.rescue.recommendations[0] ?? {};
  const firstError = mission.errors[0];
  const statusLabel = mission.stuck.status === "stuck"
    ? "Needs rescue"
    : mission.stuck.status === "at_risk"
      ? "Needs attention"
      : "Moving";
  const happened = firstError
    ? firstError.raw
    : mission.stuck.signals[0]?.evidence ?? "No critical failure pattern was parsed.";
  const cause = firstError?.kind === "command_not_found"
    ? `The command '${firstError.primary ?? mission.command[0]}' was not found in this terminal environment.`
    : firstError?.sourceFile
      ? `The failure points to ${firstError.sourceFile}.`
      : mission.stuck.status === "progressing"
        ? "No immediate blocker detected."
        : "The run failed without enough artifact evidence to prove progress.";
  const changed = mission.diffEvidence.changedFiles.length
    ? mission.diffEvidence.changedFiles.join(", ")
    : "No file changes were detected during this mission.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Runcap Mission Report - ${escapeHtml(mission.label ?? mission.id)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1115; --panel:#181c22; --soft:#202630; --line:#303946; --text:#f5f7fb; --muted:#a7b0bd; --accent:#70d6ff; --warn:#ffd166; --bad:#ff6b6b; --good:#55d78a; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:linear-gradient(145deg,#141b24,#0f1115 45%); color:var(--text); }
    main { max-width:980px; margin:0 auto; padding:36px 20px 56px; }
    .notice, details { background:rgba(24,28,34,.96); border:1px solid var(--line); border-radius:10px; padding:22px; }
    .notice { border-color:rgba(112,214,255,.5); box-shadow:0 20px 70px rgba(0,0,0,.28); }
    h1 { margin:0 0 8px; font-size:30px; letter-spacing:0; }
    h2 { margin:24px 0 10px; font-size:18px; }
    p { line-height:1.58; color:var(--muted); }
    .status { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:5px 10px; margin:0 8px 8px 0; color:var(--muted); font-size:13px; }
    .stuck { color:var(--bad); border-color:rgba(255,107,107,.55); }
    .at_risk { color:var(--warn); border-color:rgba(255,209,102,.55); }
    .progressing { color:var(--good); border-color:rgba(85,215,138,.55); }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin:22px 0; }
    .card { background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:16px; }
    .card strong { display:block; margin-bottom:8px; }
    .action { background:#10151c; border:1px solid rgba(112,214,255,.55); border-radius:8px; padding:18px; margin-top:18px; }
    .action-title { color:var(--accent); font-size:13px; font-weight:800; text-transform:uppercase; margin-bottom:8px; }
    pre { white-space:pre-wrap; background:#0b0d10; border:1px solid var(--line); border-radius:8px; padding:14px; overflow:auto; line-height:1.55; color:var(--text); }
    details { margin-top:16px; }
    summary { cursor:pointer; color:var(--muted); font-weight:700; }
    code { color:var(--accent); }
    @media (max-width:760px) { .grid { grid-template-columns:1fr; } h1 { font-size:24px; } }
  </style>
</head>
<body>
  <main>
    <div class="notice">
      <span class="status ${escapeHtml(mission.stuck.status)}">${escapeHtml(statusLabel)}</span>
      <span class="status">confidence: ${escapeHtml(mission.stuck.confidence)}</span>
      <span class="status">exit: ${escapeHtml(String(mission.exitCode))}</span>
      <h1>${escapeHtml(mission.label ?? mission.id)}</h1>
      <p><code>${escapeHtml(mission.command.join(" "))}</code></p>
      <div class="grid">
        <div class="card"><strong>What happened</strong><p>${escapeHtml(happened)}</p></div>
        <div class="card"><strong>Likely cause</strong><p>${escapeHtml(cause)}</p></div>
        <div class="card"><strong>What changed</strong><p>${escapeHtml(changed)}</p></div>
      </div>
      <div class="action">
        <div class="action-title">Recommended next step</div>
        <p>${escapeHtml(firstRecommendation.nextAction ?? "Continue only with a clear verification command.")}</p>
        <pre>${escapeHtml(firstRecommendation.prompt ?? "")}</pre>
      </div>
      <details>
        <summary>Technical evidence</summary>
        <pre>${escapeHtml(JSON.stringify({
          missionId: mission.id,
          errors: mission.errors,
          stuckSignals: mission.stuck.signals,
          diffEvidence: mission.diffEvidence,
          truthLabels: {
            fuel: mission.fuelUsedPercent === null ? "unknown_until_calibrated" : "manual_calibration",
            progress: "observed_from_git_diff_and_command_result",
            rescue: "generated_from_evidence_packet"
          }
        }, null, 2))}</pre>
      </details>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Runcap</title>
  <link rel="preconnect" href="https://api.fontshare.com" crossorigin>
  <link href="https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=general-sans@400,500,600,700&f[]=jetbrains-mono@400,500&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#ffffff; --panel2:#fbfbfc; --soft:#f0f2f5; --line:#e6e8ec; --text:#0b0d12; --muted:#6b7280; --good:#0d9f6e; --warn:#b7791f; --bad:#dc2626; --accent:#4f46e5; --violet:#7c3aed; --shadow:0 1px 2px rgba(16,24,40,0.04), 0 8px 24px rgba(16,24,40,0.06); }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family: "General Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; background:radial-gradient(circle at 18% -4%, rgba(79,70,229,0.06), transparent 36%), radial-gradient(circle at 92% 4%, rgba(124,58,237,0.05), transparent 38%); }
    button, textarea, select, input { font:inherit; }
    .app { position:relative; display:grid; grid-template-columns: 320px minmax(0,1fr); min-height:100vh; }
    aside { border-right:1px solid var(--line); background:var(--panel); padding:22px; overflow:auto; }
    main { padding:32px 36px; overflow:auto; }
    h1 { margin:0; font-family:"Clash Display", sans-serif; font-weight:700; font-size:23px; letter-spacing:-0.01em; }
    h2 { margin:0; font-family:"Clash Display", sans-serif; font-weight:600; font-size:34px; line-height:1.08; letter-spacing:-0.02em; }
    h3 { margin:0; font-family:"Clash Display", sans-serif; font-weight:600; font-size:15px; }
    p { margin:0; }
    .muted { color:var(--muted); }
    .brand { display:flex; align-items:center; gap:12px; margin-bottom:22px; }
    .mark { width:40px; height:40px; border-radius:11px; display:grid; place-items:center; color:#fff; font-family:"Clash Display",sans-serif; font-weight:700; background:linear-gradient(135deg, var(--accent), var(--violet)); box-shadow:var(--shadow); }
    .tagline { color:var(--muted); font-size:13px; margin-top:3px; line-height:1.35; }
    .nav { display:grid; gap:8px; margin:18px 0 22px; }
    .nav button { text-align:left; border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:11px; padding:12px 14px; cursor:pointer; transition:all .15s; }
    .nav button.active, .nav button:hover { border-color:var(--accent); background:#f5f4ff; }
    .nav strong { display:block; font-weight:600; }
    .nav span { display:block; color:var(--muted); font-size:12px; margin-top:3px; }
    .side-title { margin:18px 0 10px; color:var(--muted); font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; }
    .summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .mini, .panel, .mission, .metric, .step, .plan-card, details { border:1px solid var(--line); background:var(--panel); border-radius:14px; }
    .mini { padding:13px; min-height:76px; box-shadow:var(--shadow); }
    .mini strong { display:block; font-family:"JetBrains Mono",monospace; font-size:22px; font-weight:500; }
    .mini span { color:var(--muted); font-size:12px; }
    .mission { width:100%; color:inherit; text-align:left; cursor:pointer; margin:0 0 10px; padding:13px; transition:all .15s; }
    .mission:hover, .mission.active { border-color:var(--accent); }
    .mission.active { background:#f5f4ff; box-shadow: inset 3px 0 0 var(--accent); }
    .mission-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:7px; }
    .mission-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mission-line { color:var(--muted); font-size:13px; line-height:1.35; }
    .status { font-size:12px; border:1px solid var(--line); padding:4px 9px; border-radius:999px; white-space:nowrap; font-weight:500; }
    .stuck { color:var(--bad); border-color:rgba(220,38,38,0.35); background:rgba(220,38,38,0.05); }
    .at_risk { color:var(--warn); border-color:rgba(183,121,31,0.35); background:rgba(183,121,31,0.05); }
    .progressing { color:var(--good); border-color:rgba(13,159,110,0.35); background:rgba(13,159,110,0.05); }
    .hero { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(360px,0.8fr); gap:18px; margin-bottom:18px; }
    .panel { padding:26px; box-shadow:var(--shadow); }
    .hero-copy { color:var(--muted); font-size:16px; line-height:1.55; margin-top:14px; max-width:880px; }
    /* SAVINGS HERO — the one visible number (Kirill's core fix) */
    .savings { grid-column:1 / -1; border:1px solid var(--line); border-radius:18px; padding:28px 30px; margin-bottom:18px; background:linear-gradient(135deg,#ffffff, #f7f6ff); box-shadow:var(--shadow); }
    .savings-label { font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); }
    .savings-row { display:flex; align-items:flex-end; gap:14px; flex-wrap:wrap; margin-top:8px; }
    .savings-big { font-family:"Clash Display",sans-serif; font-weight:700; font-size:clamp(40px,6vw,68px); line-height:1; letter-spacing:-0.03em; background:linear-gradient(135deg,var(--accent),var(--violet)); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
    .savings-unit { font-family:"JetBrains Mono",monospace; font-size:17px; color:var(--muted); padding-bottom:8px; }
    .savings-sub { color:var(--muted); font-size:15px; margin-top:12px; }
    .savings-sub b { color:var(--text); font-family:"JetBrains Mono",monospace; font-weight:500; }
    .capbar { margin-top:18px; }
    .capbar-track { height:12px; border-radius:999px; background:var(--soft); overflow:hidden; border:1px solid var(--line); }
    .capbar-fill { height:100%; border-radius:999px; background:linear-gradient(90deg,var(--good),var(--accent)); transition:width .4s; }
    .capbar-fill.warn { background:linear-gradient(90deg,var(--warn),#e8590c); }
    .capbar-fill.over { background:linear-gradient(90deg,var(--bad),#991b1b); }
    .capbar-meta { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-top:7px; font-family:"JetBrains Mono",monospace; }
    .badge-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:18px; }
    .badge { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); color:var(--muted); border-radius:999px; padding:6px 11px; font-size:12px; background:var(--panel2); }
    .badge.good { color:var(--good); border-color:rgba(13,159,110,0.35); }
    .badge.warn { color:var(--warn); border-color:rgba(183,121,31,0.35); }
    .badge.bad { color:var(--bad); border-color:rgba(220,38,38,0.35); }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:20px; }
    .metric { padding:15px; box-shadow:var(--shadow); }
    .metric strong { display:block; font-family:"JetBrains Mono",monospace; font-size:23px; font-weight:500; line-height:1.1; }
    .metric span { display:block; color:var(--muted); font-size:12px; margin-top:6px; }
    .planner textarea { width:100%; min-height:128px; resize:vertical; background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:11px; padding:13px; line-height:1.45; }
    .field-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
    select, input { width:100%; background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:11px; padding:11px; }
    label { display:block; color:var(--muted); font-size:12px; font-weight:600; margin:0 0 7px; }
    .primary, .ghost { border-radius:11px; padding:11px 16px; cursor:pointer; font-weight:600; transition:all .15s; }
    .primary { border:1px solid transparent; color:#fff; background:linear-gradient(135deg, var(--accent), var(--violet)); box-shadow:0 6px 16px rgba(79,70,229,0.25); }
    .primary:hover { filter:brightness(1.06); transform:translateY(-1px); }
    .ghost { border:1px solid var(--line); color:var(--text); background:var(--panel); }
    .ghost:hover { border-color:var(--accent); }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .plan-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:18px 0; }
    .plan-card { padding:18px; box-shadow:var(--shadow); }
    .plan-card strong { display:block; margin-bottom:8px; font-weight:600; }
    .plan-card p, .step p { color:var(--muted); line-height:1.48; }
    .timeline { display:grid; gap:10px; margin-top:14px; }
    .step { padding:16px; display:grid; grid-template-columns:34px minmax(0,1fr); gap:12px; align-items:start; box-shadow:var(--shadow); }
    .num { width:28px; height:28px; border-radius:9px; display:grid; place-items:center; background:#f5f4ff; border:1px solid var(--line); color:var(--accent); font-family:"JetBrains Mono",monospace; font-weight:500; }
    .rescue { border-color:rgba(79,70,229,0.4); background:linear-gradient(135deg,#ffffff,#f7f6ff); }
    .decision { color:var(--bad); font-weight:600; font-size:18px; margin:8px 0 0; }
    pre { white-space:pre-wrap; margin:12px 0 0; background:#0b0d12; color:#e6e8ec; border:1px solid var(--line); border-radius:11px; padding:14px; line-height:1.5; overflow:auto; font-family:"JetBrains Mono",monospace; font-size:13px; }
    details { padding:14px 18px; margin-top:14px; box-shadow:var(--shadow); }
    summary { cursor:pointer; color:var(--muted); font-weight:600; }
    .hidden { display:none; }
    .empty { padding:42px; text-align:left; }
    .copy { margin-top:10px; }
    @media (max-width: 1180px) { .app { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } .hero, .plan-grid, .metrics { grid-template-columns:1fr; } .field-row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand">
        <div class="mark">R</div>
        <div>
          <h1>Runcap</h1>
          <div class="tagline">Estimate cost. Cap spend. Compress tokens. Rescue stuck runs.</div>
        </div>
      </div>
      <div class="nav">
        <button id="nav-plan" class="active" onclick="setView('plan')"><strong>New AI Mission</strong><span>Estimate, split, route, then run</span></button>
        <button id="nav-monitor" onclick="setView('monitor')"><strong>Active Work</strong><span>Rescue stuck agents with evidence</span></button>
      </div>
      <div class="side-title">AI budget signal</div>
      <div class="mission">
        <div class="mission-line" id="fuel">Fuel: loading...</div>
        <div class="mission-line" id="truth">Gateway truth: loading...</div>
      </div>
      <div class="summary">
        <div class="mini"><strong id="cost">$0</strong><span>spent so far</span></div>
        <div class="mini"><strong id="saved" style="color:var(--good)">$0</strong><span>saved by compression</span></div>
        <div class="mini"><strong id="tokens">0</strong><span>API tokens</span></div>
        <div class="mini"><strong id="needs">0</strong><span>need attention</span></div>
      </div>
      <div class="side-title">Saved plans</div>
      <div id="plans"></div>
      <div class="side-title">Recent agent checks</div>
      <div id="missions"></div>
    </aside>
    <main>
      <section id="plan-view"></section>
      <section id="monitor-view" class="hidden"></section>
    </main>
  </div>
  <script>
    const state = { selected: null, selectedPlan: null, missions: [], plans: [], view: "plan", plannerRendered: false };
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    async function load() {
      const [status, missions, plans] = await Promise.all([
        fetch("/api/status").then((r) => r.json()),
        fetch("/api/missions").then((r) => r.json()),
        fetch("/api/plans").then((r) => r.json())
      ]);
      state.missions = missions;
      state.plans = plans;
      document.getElementById("fuel").textContent = status.fuel.currentPercent === null ? "Fuel: unknown" : "Fuel: " + status.fuel.currentPercent + "%";
      document.getElementById("truth").textContent = "Gateway truth: " + status.gateway.truth;
      document.getElementById("needs").textContent = (status.counts.stuck ?? 0) + (status.counts.at_risk ?? 0);
      document.getElementById("tokens").textContent = Number(status.gateway.totalTokens || 0).toLocaleString();
      document.getElementById("cost").textContent = "$" + (status.gateway.estimatedCostUsd ?? 0);
      document.getElementById("saved").textContent = "$" + (status.gateway.savedUsd ?? 0);
      state.gateway = status.gateway;
      state.budget = status.budget;
      renderList();
      renderPlans();
      if (!state.plannerRendered) renderPlanner(status);
      renderSavingsHero(status.gateway);
      if (!state.selected && missions[0]) showMission(missions[0].id, false);
      if (!missions[0]) renderEmptyMonitor();
    }
    function setView(view) {
      state.view = view;
      document.getElementById("plan-view").classList.toggle("hidden", view !== "plan");
      document.getElementById("monitor-view").classList.toggle("hidden", view !== "monitor");
      document.getElementById("nav-plan").classList.toggle("active", view === "plan");
      document.getElementById("nav-monitor").classList.toggle("active", view === "monitor");
    }
    function renderList() {
      document.getElementById("missions").innerHTML = state.missions.map((m) =>
        '<button class="mission ' + (m.id === state.selected ? 'active' : '') + '" onclick="showMission(\\'' + esc(m.id) + '\\')">' +
        '<div class="mission-head"><span class="mission-name">' + esc(m.label || m.id.slice(0, 18)) + '</span><span class="status ' + esc(m.status) + '">' + labelStatus(m.status) + '</span></div>' +
        '<div class="mission-line">' + esc(shortCommand(m.command)) + '</div>' +
        '<div class="mission-line">' + summaryLine(m) + '</div>' +
        '</button>'
      ).join("");
    }
    function renderPlans() {
      document.getElementById("plans").innerHTML = state.plans.slice(0, 6).map((plan) =>
        '<button class="mission ' + (plan.id === state.selectedPlan ? 'active' : '') + '" onclick="showPlan(\\'' + esc(plan.id) + '\\')">' +
        '<div class="mission-head"><span class="mission-name">' + esc(plan.goal || plan.id.slice(0, 18)) + '</span><span class="status at_risk">' + esc(plan.budget?.risk || "plan") + '</span></div>' +
        '<div class="mission-line">saving: ' + esc(plan.budget?.expectedWasteReduction || "unknown") + '</div>' +
        '<div class="mission-line">' + esc(plan.routing?.planningTier || "routing unknown") + '</div>' +
        '</button>'
      ).join("");
    }
    function renderSavingsHero(g) {
      const el = document.getElementById("savings-hero");
      if (!el || !g) return;
      const saved = Number(g.savedUsd ?? 0);
      const tokens = Number(g.savedTokens ?? 0);
      const spent = Number(g.estimatedCostUsd ?? 0);
      const wouldHave = Number(g.wouldHaveSpentUsd ?? spent);
      const fmt = (n) => "$" + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
      if (tokens === 0 && spent === 0) {
        el.innerHTML = '<div class="savings"><div class="savings-label">Your savings will show here</div>' +
          '<div class="savings-row"><div class="savings-big">$0.00</div><div class="savings-unit">saved so far</div></div>' +
          '<div class="savings-sub">Point your agent at the Runcap gateway and every call is compressed and capped. This number grows on its own.</div></div>';
        return;
      }
      // cap bar
      let capHtml = '';
      if (state.budget && state.budget > 0) {
        const pct = Math.min(100, (spent / state.budget) * 100);
        const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
        capHtml = '<div class="capbar"><div class="capbar-track"><div class="capbar-fill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<div class="capbar-meta"><span>spent ' + fmt(spent) + '</span><span>cap ' + fmt(state.budget) + '</span></div></div>';
      }
      el.innerHTML = '<div class="savings">' +
        '<div class="savings-label">You saved</div>' +
        '<div class="savings-row"><div class="savings-big">' + fmt(saved) + '</div><div class="savings-unit">' + tokens.toLocaleString() + ' tokens compressed away</div></div>' +
        '<div class="savings-sub">You would have spent <b>' + fmt(wouldHave) + '</b>, Runcap compressed it down to <b>' + fmt(spent) + '</b>. Same answers, fewer tokens.</div>' +
        capHtml +
        '</div>';
    }
    function renderPlanner(status) {
      state.plannerRendered = true;
      const fuel = status.fuel.currentPercent === null ? 24 : Number(status.fuel.currentPercent);
      document.getElementById("plan-view").innerHTML =
        '<div id="savings-hero"></div>' +
        '<div class="hero">' +
        '<div class="panel">' +
        '<h2>Turn one expensive AI request into a managed plan.</h2>' +
        '<p class="hero-copy">Describe the outcome you want. The manager estimates budget risk, splits the work into verifiable missions, recommends model tiers, and defines stop rules before credits are burned.</p>' +
        '<div class="badge-row"><span class="badge good">Target: same or better result</span><span class="badge warn">Spend goal: 30-70% less waste</span><span class="badge">Fuel now: ' + esc(fuel) + '%</span></div>' +
        '<div class="metrics"><div class="metric"><strong>Plan</strong><span>before spending</span></div><div class="metric"><strong>Route</strong><span>right model per task</span></div><div class="metric"><strong>Prove</strong><span>with output evidence</span></div><div class="metric"><strong>Learn</strong><span>from every run</span></div></div>' +
        '</div>' +
        '<div class="panel planner">' +
        '<h3>Mission Planner</h3>' +
        '<label for="task-input">What do you want AI to achieve?</label>' +
        '<textarea id="task-input" placeholder="Example: build a mobile app MVP, create a video campaign, automate invoice processing, fix my React auth flow...">Build a mobile app MVP with login, database, dashboard and deployment</textarea>' +
        '<div class="field-row"><div><label for="fuel-input">Available weekly fuel %</label><input id="fuel-input" type="number" min="0" max="100" value="' + esc(fuel) + '"></div><div><label for="quality-input">Quality target</label><select id="quality-input"><option value="high">High quality</option><option value="balanced">Balanced</option><option value="cheap">Cheapest acceptable</option></select></div></div>' +
        '<div class="actions"><button class="primary" onclick="planTask()">Create managed plan</button><button class="ghost" onclick="copyPlan()">Copy plan</button></div>' +
        '</div>' +
        '</div>' +
        '<div id="planner-result"><div class="panel"><h3>Ready when you are</h3><p class="hero-copy">Create a managed plan to save it locally, generate mission steps, and get copyable commands for agent runs.</p></div></div>';
    }
    function renderPlan(plan) {
      const result = document.getElementById("planner-result");
      if (!result) return;
      result.innerHTML =
        '<div class="plan-grid">' +
        '<div class="plan-card"><strong>Budget decision</strong><p>Risk: <b>' + esc(plan.budget.risk) + '</b>. Expected waste reduction: <b>' + esc(plan.budget.expectedWasteReduction) + '</b>. ' + esc(plan.budget.reason) + '</p></div>' +
        '<div class="plan-card"><strong>Model routing</strong><p>Planning: <b>' + esc(plan.routing.planningTier) + '</b>. Execution: <b>' + esc(plan.routing.executionTier) + '</b></p></div>' +
        '<div class="plan-card"><strong>Quality proof</strong><p>' + esc(plan.quality.proof) + '</p></div>' +
        '</div>' +
        '<div class="timeline">' +
        plan.missions.map((mission, index) => '<div class="step"><div class="num">' + (index + 1) + '</div><div><strong>' + esc(mission.name) + '</strong><p>' + esc(mission.instruction) + '</p><p class="muted">Proof: ' + esc(mission.proof) + '</p></div></div>').join("") +
        '<div class="step"><div class="num">!</div><div><strong>Stop rule</strong><p>' + esc(plan.stopRule) + '</p></div></div>' +
        '</div>' +
        '<details open><summary>Copyable agent commands</summary><pre>' + esc(plan.commandTemplates.map((item) => item.command).join("\\n\\n")) + '</pre></details>' +
        '<details><summary>Plan truth labels</summary><pre>' + esc(JSON.stringify(plan.truth, null, 2)) + '</pre></details>';
      window.lastPlanText = "Runcap plan\\nPlan: " + plan.id + "\\nGoal: " + plan.goal + "\\nBudget risk: " + plan.budget.risk + "\\nExpected waste reduction: " + plan.budget.expectedWasteReduction + "\\nPlanning model: " + plan.routing.planningTier + "\\nExecution model: " + plan.routing.executionTier + "\\nProof: " + plan.quality.proof + "\\nStop rule: " + plan.stopRule + "\\n\\nCommands:\\n" + plan.commandTemplates.map((item) => item.command).join("\\n\\n");
    }
    async function showPlan(id) {
      state.selectedPlan = id;
      setView("plan");
      renderPlans();
      const plan = await fetch("/api/plans/" + encodeURIComponent(id)).then((r) => r.json());
      const input = document.getElementById("task-input");
      if (input) input.value = plan.goal;
      renderPlan(plan);
    }
    async function showMission(id, activate = true) {
      state.selected = id;
      if (activate) setView("monitor");
      renderList();
      const m = await fetch("/api/missions/" + encodeURIComponent(id)).then((r) => r.json());
      const d = diagnose(m);
      const roi = estimateRoi(m);
      const rec = m.rescue.recommendations[0] || {};
      document.getElementById("monitor-view").innerHTML =
        '<div class="hero">' +
        '<div class="panel ' + esc(m.stuck.status) + '">' +
        '<div class="headline"><div><h2>' + esc(d.title) + '</h2><p class="hero-copy">' + esc(d.description) + '</p></div><span class="status ' + esc(m.stuck.status) + '">' + labelStatus(m.stuck.status) + '</span></div>' +
        '<div class="badge-row"><span class="badge ' + (m.stuck.status === "stuck" ? "bad" : m.stuck.status === "at_risk" ? "warn" : "good") + '">manager decision: ' + esc(d.managerDecision) + '</span><span class="badge">quality guard: ' + esc(d.qualityGuard) + '</span><span class="badge">fuel: ' + esc(m.fuelUsedPercent === null ? "needs calibration" : m.fuelUsedPercent + "%") + '</span></div>' +
        '<div class="metrics">' +
        '<div class="metric"><strong>' + esc(roi.spendRisk) + '</strong><span>spend risk</span></div>' +
        '<div class="metric"><strong>' + esc(roi.expectedSaving) + '</strong><span>possible saving</span></div>' +
        '<div class="metric"><strong>' + esc(roi.qualityRisk) + '</strong><span>quality risk</span></div>' +
        '<div class="metric"><strong>' + esc(roi.bestModelTier) + '</strong><span>recommended tier</span></div>' +
        '</div>' +
        '</div>' +
        '<div class="panel rescue">' +
        '<h3>Manager action</h3>' +
        '<p class="decision">' + esc(rec.nextAction || d.next) + '</p>' +
        '<div class="actions"><button class="primary" onclick="copyPrompt()">Copy rescue prompt</button><button class="ghost" onclick="prefillPlanner()">Plan safer rerun</button></div>' +
        '<pre id="prompt-main">' + esc(rec.prompt || d.next) + '</pre>' +
        '</div>' +
        '</div>' +
        '<div class="plan-grid">' +
        '<div class="plan-card"><strong>What the manager sees</strong><p>' + esc(d.happened) + '</p></div>' +
        '<div class="plan-card"><strong>Why it matters</strong><p>' + esc(d.cause) + '</p></div>' +
        '<div class="plan-card"><strong>Proof of progress</strong><p>' + esc(d.changed) + '</p></div>' +
        '</div>' +
        '<details><summary>Technical evidence</summary><pre>' + esc(JSON.stringify({ command:m.command.join(" "), changedFiles:m.diffEvidence.changedFiles, parsedErrors:m.errors, stuckSignals:m.stuck.signals, scopeRisk:m.preflight.scopeRisk }, null, 2)) + '</pre></details>' +
        '<details><summary>Truth labels</summary><pre>Cost/Fuel: ' + (m.fuelUsedPercent === null ? 'unknown until calibrated' : 'manual calibration') + '\\nProgress proof: observed from git diff and command result\\nError parsing: calculated from terminal logs\\nRescue advice: generated from evidence packet</pre></details>';
    }
    function copyPrompt() {
      const text = document.getElementById("prompt-main")?.textContent || "";
      navigator.clipboard?.writeText(text);
    }
    function labelStatus(status) {
      if (status === "stuck") return "needs rescue";
      if (status === "at_risk") return "check this";
      return "moving";
    }
    function shortCommand(command) {
      const text = String(command || "");
      return text.length > 92 ? text.slice(0, 89) + "..." : text;
    }
    function summaryLine(m) {
      if (m.errorCount > 0) return m.errorCount + " parsed error(s), " + m.changedFileCount + " file change(s)";
      if (m.exitCode !== 0) return "command failed, no parsed error";
      return m.changedFileCount + " file change(s)";
    }
    function renderEmptyMonitor() {
      document.getElementById("monitor-view").innerHTML = '<div class="panel empty"><h2>No observed runs yet</h2><p class="hero-copy">Start with a managed plan, then wrap an agent command with <code>aim run --</code>. This screen will show whether the agent is progressing, wasting spend, or needs rescue.</p></div>';
    }
    function seedTask(m) {
      const command = Array.isArray(m.command) ? m.command.join(" ") : String(m.command || "");
      return command.replace(/^.*?(codex|claude)\\s+["']?/i, "").replace(/["']?$/, "").slice(0, 260);
    }
    function estimateRoi(m) {
      const noChanges = m.diffEvidence.changedFiles.length === 0;
      const failed = m.exitCode !== 0;
      const broad = m.preflight.scopeRisk === "high";
      return {
        spendRisk: failed && noChanges ? "High" : m.stuck.status === "at_risk" ? "Medium" : "Low",
        expectedSaving: failed || broad ? "30-70%" : "10-25%",
        qualityRisk: broad ? "High" : failed ? "Medium" : "Low",
        bestModelTier: broad || failed ? "Strong first" : "Cheap ok"
      };
    }
    async function planTask() {
      const input = document.getElementById("task-input");
      const result = document.getElementById("planner-result");
      if (!input || !result) return;
      const text = input.value.trim();
      if (!text) {
        result.innerHTML = '<div class="panel"><h3>Missing goal</h3><p class="hero-copy">Describe the outcome before creating a managed plan.</p></div>';
        return;
      }
      const fuelValue = Number(document.getElementById("fuel-input")?.value ?? 24);
      const quality = document.getElementById("quality-input")?.value ?? "high";
      result.innerHTML = '<div class="panel"><h3>Creating plan...</h3><p class="hero-copy">The manager is building budget, routing, proof, mission steps, and stop rules.</p></div>';
      let plan;
      try {
        plan = await fetch("/api/plans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: text, fuelPercent: fuelValue, quality })
        }).then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "Plan request failed.");
          return body;
        });
      } catch (error) {
        result.innerHTML = '<div class="panel"><h3>Plan failed</h3><p class="hero-copy">' + esc(error.message) + '</p></div>';
        return;
      }
      state.selectedPlan = plan.id;
      state.plans = [plan, ...state.plans.filter((item) => item.id !== plan.id)];
      renderPlans();
      renderPlan(plan);
    }
    function copyPlan() {
      navigator.clipboard?.writeText(window.lastPlanText || "");
    }
    function prefillPlanner() {
      setView("plan");
      const input = document.getElementById("task-input");
      if (input && state.selected) {
        const selected = state.missions.find((m) => m.id === state.selected);
        input.value = selected ? shortCommand(selected.command) : input.value;
      }
      planTask();
    }
    function diagnose(m) {
      const firstError = m.errors[0];
      const firstSignal = m.stuck.signals[0];
      const changed = m.diffEvidence.changedFiles.length
        ? m.diffEvidence.changedFiles.join(", ")
        : "No file changes were detected during this run.";
      if (m.stuck.status === "stuck") {
        return {
          title: "The agent is stuck",
          description: "The current AI run is spending effort without proving useful progress. The manager should stop broad execution, protect budget, and switch into diagnosis.",
          managerDecision: "stop and rescue",
          qualityGuard: "do not continue blindly",
          happened: firstError ? firstError.raw : firstSignal ? firstSignal.evidence : "The command failed.",
          cause: firstError?.sourceFile ? "The failure points to " + firstError.sourceFile + ". A cheaper rerun without diagnosis is likely to repeat the same failure." : "The agent needs a diagnosis pass before more implementation.",
          changed,
          next: "Run a narrow diagnostic prompt and ask the agent for the smallest fix."
        };
      }
      if (m.stuck.status === "at_risk") {
        return {
          title: "This run needs attention",
          description: "The agent may still be useful, but the manager cannot prove that more tokens will improve the result. Confirm the next step before spending more.",
          managerDecision: "check before spend",
          qualityGuard: "needs proof",
          happened: m.exitCode === 127 ? "The command could not be executed correctly." : "The run ended with warning signals.",
          cause: firstSignal ? firstSignal.evidence : "The system could not prove clean progress. This is where AI budgets usually leak.",
          changed,
          next: "Ask for diagnosis first, then rerun with one verification command."
        };
      }
      return {
        title: "The task appears to be moving",
        description: "The run has enough evidence to continue, but it should still move through small verified missions instead of one unlimited agent session.",
        managerDecision: "continue with checkpoint",
        qualityGuard: "verify next",
        happened: "The run completed without major stuck signals.",
        cause: "No immediate blocker detected.",
        changed,
        next: "Continue only with a clear verification command."
      };
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

function sendJson(response, data, status = 200) {
  send(response, status, JSON.stringify(data, null, 2), "application/json; charset=utf-8");
}

function send(response, status, body, contentType) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function clampPercent(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("Fuel percent must be a number from 0 to 100.");
  }
  return Number(value.toFixed(2));
}

function dedupe(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
