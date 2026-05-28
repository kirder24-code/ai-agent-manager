import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const STORE_DIR = ".aim-control";
const MISSIONS_DIR = path.join(STORE_DIR, "missions");
const FUEL_FILE = path.join(STORE_DIR, "fuel.json");
const GATEWAY_EVENTS_FILE = path.join(STORE_DIR, "gateway-events.jsonl");
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

export async function runMission({ command, label, fuelBefore }) {
  await ensureStore();
  const id = createMissionId(label);
  const missionDir = path.join(MISSIONS_DIR, id);
  await mkdir(missionDir, { recursive: true });

  const start = new Date();
  const cwd = process.cwd();
  const before = await collectSnapshot(cwd);
  const preflight = buildPreflight(command.join(" "), before);
  const output = await runChild(command, cwd);
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

  return {
    id,
    summary: shortSummary(mission)
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
    product: "AI Agent Manager Lab",
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
  return `AI Agent Manager Templates

1. Coding feature with proof
   node ./bin/aim.mjs preflight -- claude "Implement <one feature>. Acceptance: <one visible result>. Verify with <command>."
   node ./bin/aim.mjs run --label feature -- claude "Implement <one feature>. Change only relevant files. Run <command>. Stop and report if blocked."

2. Stuck rescue pass
   node ./bin/aim.mjs run --label rescue -- claude "Do not write broad code. Use the previous AIM report. Diagnose the failure, map it to files/config, make the smallest fix, then run verification."

3. Explorer before expensive coding
   node ./bin/aim.mjs run --label explorer -- claude "Do not edit files. Inspect the project and return the smallest implementation plan with exact files and verification command."

4. Subscription fuel discipline
   node ./bin/aim.mjs fuel set 24
   node ./bin/aim.mjs run --label focused-slice --fuel-before 24 -- claude "Build one vertical slice only. Stop after verification."
   node ./bin/aim.mjs fuel calibrate <mission-id> <after-percent>

5. API cost gateway
   node ./bin/aim.mjs gateway --mock
   # or
   AIM_DAILY_BUDGET_USD=5 OPENAI_API_KEY=sk-... node ./bin/aim.mjs gateway
`;
}

export async function preflightMission(command) {
  await ensureStore();
  const snapshot = await collectSnapshot(process.cwd());
  const preflight = buildPreflight(command.join(" "), snapshot);
  const fuel = await readFuel();
  return formatPreflight({ command, preflight, fuel });
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
    "# AI Agent Manager Lab",
    "# For real gateway mode:",
    "OPENAI_API_KEY=",
    "AIM_UPSTREAM_BASE_URL=https://api.openai.com/v1",
    "",
    "# Optional budget guard. If estimated spend already exceeds this, gateway blocks new calls.",
    "AIM_DAILY_BUDGET_USD=5",
    "",
    "# For demo mode without external API calls:",
    "AIM_GATEWAY_MODE=mock"
  ].join("\n");
  if (!existsSync(ENV_EXAMPLE_FILE)) {
    await writeFile(ENV_EXAMPLE_FILE, `${envExample}\n`);
  }
  return [
    "AI Agent Manager setup complete.",
    `Store: ${STORE_DIR}`,
    `Example env: ${ENV_EXAMPLE_FILE}`,
    "",
    "Try:",
    "  node ./bin/aim.mjs preflight -- claude \"build the full mobile app\"",
    "  node ./bin/aim.mjs run --label demo -- npm --prefix examples/broken-ts-app run build",
    "  node ./bin/aim.mjs gateway --mock"
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
    "AI Agent Manager Doctor",
    ...checks.map(([name, ok, detail]) => `${ok ? "OK" : "WARN"}  ${name}: ${detail}`),
    "",
    "Recommended next step:",
    missions.length === 0
      ? "  node ./bin/aim.mjs run --label first-check -- npm test"
      : "  node ./bin/aim.mjs dashboard"
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
  console.log(`AI Agent Manager dashboard: http://127.0.0.1:${port}`);
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

export async function startGateway({ port = 8792, mock = false } = {}) {
  await ensureStore();
  const gatewayMode = mock || process.env.AIM_GATEWAY_MODE === "mock" ? "mock" : "proxy";
  const upstreamBaseUrl = process.env.AIM_UPSTREAM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const upstreamApiKey = process.env.AIM_UPSTREAM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (gatewayMode !== "mock" && !upstreamApiKey) {
    throw new Error("Missing AIM_UPSTREAM_API_KEY or OPENAI_API_KEY. Gateway cannot proxy model calls without an upstream key.");
  }
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, { ok: true, upstreamBaseUrl });
        return;
      }
      if (request.method !== "POST" || !url.pathname.startsWith("/v1/")) {
        send(response, 404, "Gateway supports POST /v1/* and GET /health.", "text/plain; charset=utf-8");
        return;
      }

      const bodyText = await readRequestBody(request);
      const requestBody = safeJson(bodyText) ?? {};
      const budget = readBudget();
      const summary = await readGatewaySummary();
      if (budget !== null && summary.estimatedCostUsd >= budget) {
        const event = {
          at: new Date().toISOString(),
          path: url.pathname,
          model: requestBody.model ?? "unknown",
          status: 429,
          durationMs: Date.now() - started,
          usage: null,
          cost: null,
          truth: "budget_guard",
          error: `Budget exceeded: ${summary.estimatedCostUsd} >= ${budget}`,
          requestHash: createHash("sha1").update(bodyText).digest("hex")
        };
        await appendGatewayEvent(event);
        sendJson(response, { error: event.error, truth: event.truth }, 429);
        return;
      }
      if (gatewayMode === "mock") {
        const responseBody = mockChatCompletion(requestBody);
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
          truth: "mock_provider_usage",
          requestHash: createHash("sha1").update(bodyText).digest("hex")
        });
        return;
      }
      const upstreamUrl = `${upstreamBaseUrl.replace(/\/$/, "")}${url.pathname}`;
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${upstreamApiKey}`,
          "content-type": request.headers["content-type"] ?? "application/json"
        },
        body: bodyText
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
        truth: responseBody.usage ? "provider_usage" : "unknown",
        requestHash: createHash("sha1").update(bodyText).digest("hex")
      });
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
  await listenLocal(server, port, "gateway");
  console.log(`AI Agent Manager gateway: http://127.0.0.1:${port}/v1`);
  console.log(`Mode: ${gatewayMode}`);
  console.log(`Upstream: ${gatewayMode === "mock" ? "mock local responder" : upstreamBaseUrl}`);
  console.log("Press Ctrl+C to stop.");
}

export async function showStatus(options = {}) {
  await ensureStore();
  const fuel = await readFuel();
  const fuelLine = fuel.currentPercent === null
    ? "Fuel: unknown. Run `aim fuel set <percent>` to calibrate subscription limits."
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
}

function createMissionId(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const cleanLabel = label ? `-${label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 36)}` : "";
  const hash = createHash("sha1").update(`${stamp}${Math.random()}`).digest("hex").slice(0, 7);
  return `${stamp}${cleanLabel}-${hash}`;
}

async function runChild(command, cwd) {
  const started = Date.now();
  const [program, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, AIM_WRAPPED: "1" },
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
    .filter((line) => !line.includes(".aim-control/"));
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

async function readGatewaySummary() {
  const events = await readGatewayEvents();
  const successful = events.filter((event) => event.status >= 200 && event.status < 300);
  const totalTokens = events.reduce((sum, event) => sum + Number(event.usage?.total_tokens ?? 0), 0);
  const estimatedCost = events.reduce((sum, event) => sum + Number(event.cost?.estimatedUsd ?? 0), 0);
  return {
    callCount: events.length,
    successfulCallCount: successful.length,
    totalTokens,
    estimatedCostUsd: Number(estimatedCost.toFixed(6)),
    truth: events.some((event) => event.truth === "provider_usage" || event.truth === "mock_provider_usage")
      ? "usage_plus_static_price_table"
      : "unknown",
    recent: events.slice(-20).reverse()
  };
}

function readBudget() {
  const raw = process.env.AIM_DAILY_BUDGET_USD;
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function mockChatCompletion(requestBody) {
  const content = "Mock response from AI Agent Manager gateway. This call was recorded with provider-like usage for demo and budget testing.";
  const promptText = JSON.stringify(requestBody.messages ?? requestBody.input ?? requestBody.prompt ?? "");
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(12, Math.ceil(content.length / 4));
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestBody.model ?? "gpt-4o-mini",
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

function estimateApiCost(usage, model) {
  if (!usage) return null;
  const pricing = modelPricing(model);
  if (!pricing) {
    return {
      estimatedUsd: null,
      truth: "unknown_price",
      note: "Provider returned usage, but this prototype has no verified price table for the model."
    };
  }
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const estimatedUsd = (input / 1_000_000) * pricing.inputPerMillion + (output / 1_000_000) * pricing.outputPerMillion;
  return {
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    truth: "calculated_from_static_price_table",
    pricing
  };
}

function modelPricing(model = "") {
  const name = String(model).toLowerCase();
  if (name.includes("gpt-4.1-mini")) return { inputPerMillion: 0.4, outputPerMillion: 1.6, source: "static_prototype_table" };
  if (name.includes("gpt-4.1")) return { inputPerMillion: 2, outputPerMillion: 8, source: "static_prototype_table" };
  if (name.includes("gpt-4o-mini")) return { inputPerMillion: 0.15, outputPerMillion: 0.6, source: "static_prototype_table" };
  if (name.includes("gpt-4o")) return { inputPerMillion: 2.5, outputPerMillion: 10, source: "static_prototype_table" };
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
    `AIM mission: ${mission.id}`,
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
    ? "Fuel: unknown. Set it with `aim fuel set <percent>` if using subscriptions."
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
    ? `Fuel: before ${mission.fuelBefore ?? "unknown"}%, after unknown. Calibrate with \`aim fuel calibrate ${mission.id} <after-percent>\`.`
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
  return `# AI Mission Report

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
  <title>AI Mission Report - ${escapeHtml(mission.label ?? mission.id)}</title>
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
  <title>AI Agent Manager</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1115; --panel:#181c22; --soft:#202630; --line:#303946; --text:#f5f7fb; --muted:#a7b0bd; --good:#55d78a; --warn:#ffd166; --bad:#ff6b6b; --accent:#70d6ff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:radial-gradient(circle at top left, #17202b 0, var(--bg) 38%); color:var(--text); }
    header { padding:26px 32px 18px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:20px; align-items:flex-end; }
    h1 { margin:0; font-size:24px; font-weight:780; letter-spacing:0; }
    h2 { margin:0; font-size:28px; letter-spacing:0; }
    h3 { margin:0 0 10px; font-size:15px; color:var(--muted); font-weight:700; text-transform:uppercase; }
    .sub { color:var(--muted); margin-top:6px; font-size:14px; }
    main { display:grid; grid-template-columns: 340px minmax(0, 1fr); min-height: calc(100vh - 94px); }
    aside { border-right:1px solid var(--line); padding:18px; overflow:auto; }
    section { padding:28px; overflow:auto; }
    .summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-bottom:18px; }
    .mini, .mission, .notice, .step, details { background:rgba(24,28,34,0.94); border:1px solid var(--line); border-radius:8px; }
    .mini { padding:12px; }
    .mini strong { display:block; font-size:18px; }
    .mini span, .muted { color:var(--muted); font-size:13px; }
    .mission { width:100%; color:inherit; text-align:left; margin:0 0 10px; cursor:pointer; padding:12px; }
    .mission:hover, .mission.active { border-color:var(--accent); }
    .mission.active { box-shadow: inset 3px 0 0 var(--accent); }
    .mission-title { display:flex; gap:8px; align-items:center; justify-content:space-between; margin-bottom:6px; }
    .mission-name { font-weight:750; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .status { font-size:12px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }
    .stuck { color:var(--bad); }
    .at_risk { color:var(--warn); }
    .progressing { color:var(--good); }
    .notice { padding:24px; border-color:rgba(112,214,255,0.55); box-shadow:0 18px 60px rgba(0,0,0,0.22); }
    .notice.stuck { border-color:rgba(255,107,107,0.5); }
    .notice.at_risk { border-color:rgba(255,209,102,0.5); }
    .headline { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:18px; }
    .badge { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:5px 10px; color:var(--muted); font-size:12px; margin:0 6px 8px 0; }
    .badge.warn { color:var(--warn); border-color:rgba(255,209,102,0.55); }
    .badge.bad { color:var(--bad); border-color:rgba(255,107,107,0.55); }
    .problem { color:var(--muted); line-height:1.6; font-size:16px; max-width:900px; }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin:18px 0; }
    .step { padding:16px; }
    .step strong { display:block; margin-bottom:8px; font-size:16px; }
    .step p { color:var(--muted); line-height:1.5; margin:0; }
    .action { background:var(--soft); border:1px solid rgba(112,214,255,0.55); border-radius:8px; padding:18px; margin-top:16px; }
    .action-title { color:var(--accent); font-size:14px; font-weight:750; text-transform:uppercase; margin-bottom:8px; }
    .prompt { white-space:pre-wrap; background:#0b0d10; border:1px solid var(--line); border-radius:8px; padding:14px; line-height:1.55; overflow:auto; }
    .copy { border:1px solid var(--line); background:#0b0d10; color:var(--text); border-radius:6px; padding:8px 12px; cursor:pointer; margin-top:12px; }
    .copy:hover { border-color:var(--accent); }
    details { margin-top:16px; padding:14px 16px; }
    summary { cursor:pointer; color:var(--muted); font-weight:700; }
    pre { white-space:pre-wrap; background:#0b0d10; border:1px solid var(--line); border-radius:8px; padding:14px; line-height:1.5; overflow:auto; }
    code { color:var(--accent); }
    @media (max-width: 980px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AI Agent Manager</h1>
      <div class="sub">A clear rescue notice for stuck AI-agent work</div>
    </div>
    <div class="sub"><span id="fuel">Fuel: loading...</span><br><span id="truth">Truth: loading...</span></div>
  </header>
  <main>
    <aside>
      <div class="summary">
        <div class="mini"><strong id="total">0</strong><span>checks</span></div>
        <div class="mini"><strong id="needs">0</strong><span>need attention</span></div>
        <div class="mini"><strong id="tokens">0</strong><span>API tokens</span></div>
        <div class="mini"><strong id="cost">$0</strong><span>API estimate</span></div>
      </div>
      <h3>Recent agent checks</h3>
      <div id="missions"></div>
    </aside>
    <section id="detail">
      <div class="notice"><p class="muted">Select a mission to see the problem, the likely cause, and the next recommended action.</p></div>
    </section>
  </main>
  <script>
    const state = { selected: null, missions: [] };
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    async function load() {
      const [status, missions] = await Promise.all([
        fetch("/api/status").then((r) => r.json()),
        fetch("/api/missions").then((r) => r.json())
      ]);
      state.missions = missions;
      document.getElementById("fuel").textContent = status.fuel.currentPercent === null ? "Fuel: unknown" : "Fuel: " + status.fuel.currentPercent + "%";
      document.getElementById("truth").textContent = "Gateway truth: " + status.gateway.truth;
      document.getElementById("total").textContent = status.missionCount;
      document.getElementById("needs").textContent = (status.counts.stuck ?? 0) + (status.counts.at_risk ?? 0);
      document.getElementById("tokens").textContent = status.gateway.totalTokens;
      document.getElementById("cost").textContent = "$" + status.gateway.estimatedCostUsd;
      renderList();
      if (!state.selected && missions[0]) showMission(missions[0].id);
    }
    function renderList() {
      document.getElementById("missions").innerHTML = state.missions.map((m) =>
        '<button class="mission ' + (m.id === state.selected ? 'active' : '') + '" onclick="showMission(\\'' + esc(m.id) + '\\')">' +
        '<div class="mission-title"><span class="mission-name">' + esc(m.label || m.id.slice(0, 18)) + '</span><span class="status ' + esc(m.status) + '">' + labelStatus(m.status) + '</span></div>' +
        '<div class="muted">' + esc(shortCommand(m.command)) + '</div>' +
        '<div class="muted">' + summaryLine(m) + '</div>' +
        '</button>'
      ).join("");
    }
    async function showMission(id) {
      state.selected = id;
      renderList();
      const m = await fetch("/api/missions/" + encodeURIComponent(id)).then((r) => r.json());
      const d = diagnose(m);
      const rec = m.rescue.recommendations[0] || {};
      document.getElementById("detail").innerHTML =
        '<div class="notice ' + esc(m.stuck.status) + '">' +
        '<div class="headline"><div><h2>' + esc(d.title) + '</h2><p class="problem">' + esc(d.description) + '</p></div><span class="status ' + esc(m.stuck.status) + '">' + labelStatus(m.stuck.status) + '</span></div>' +
        '<p><span class="badge ' + (m.stuck.status === "stuck" ? "bad" : m.stuck.status === "at_risk" ? "warn" : "") + '">confidence: ' + esc(m.stuck.confidence) + '</span><span class="badge">exit code: ' + esc(m.exitCode) + '</span><span class="badge">fuel: ' + esc(m.fuelUsedPercent === null ? "not calibrated" : m.fuelUsedPercent + "%") + '</span></p>' +
        '<div class="grid">' +
        '<div class="step"><strong>What happened</strong><p>' + esc(d.happened) + '</p></div>' +
        '<div class="step"><strong>Likely cause</strong><p>' + esc(d.cause) + '</p></div>' +
        '<div class="step"><strong>What changed</strong><p>' + esc(d.changed) + '</p></div>' +
        '</div>' +
        '<div class="action"><div class="action-title">Recommended next step</div><p>' + esc(rec.nextAction || d.next) + '</p><button class="copy" onclick="copyPrompt()">Copy rescue prompt</button><pre id="prompt-main" class="prompt">' + esc(rec.prompt || d.next) + '</pre></div>' +
        '<details><summary>Technical evidence</summary><pre>' + esc(JSON.stringify({ command:m.command.join(" "), changedFiles:m.diffEvidence.changedFiles, parsedErrors:m.errors, stuckSignals:m.stuck.signals, scopeRisk:m.preflight.scopeRisk }, null, 2)) + '</pre></details>' +
        '<details><summary>Truth labels</summary><pre>Cost/Fuel: ' + (m.fuelUsedPercent === null ? 'unknown until calibrated' : 'manual calibration') + '\\nProgress proof: observed from git diff and command result\\nError parsing: calculated from terminal logs\\nRescue advice: generated from evidence packet</pre></details>' +
        '</div>';
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
    function diagnose(m) {
      const firstError = m.errors[0];
      const firstSignal = m.stuck.signals[0];
      const changed = m.diffEvidence.changedFiles.length
        ? m.diffEvidence.changedFiles.join(", ")
        : "No file changes were detected during this run.";
      if (m.stuck.status === "stuck") {
        return {
          title: "The agent is stuck",
          description: "The run failed and there is not enough evidence that the task moved forward. Do not continue with a broad prompt yet.",
          happened: firstError ? firstError.raw : firstSignal ? firstSignal.evidence : "The command failed.",
          cause: firstError?.sourceFile ? "The failure points to " + firstError.sourceFile + "." : "The agent needs a diagnosis pass before more implementation.",
          changed,
          next: "Run a narrow diagnostic prompt and ask the agent for the smallest fix."
        };
      }
      if (m.stuck.status === "at_risk") {
        return {
          title: "This run needs attention",
          description: "The agent did not clearly finish the task. Review the recommended next step before spending more tokens.",
          happened: m.exitCode === 127 ? "The command could not be executed correctly." : "The run ended with warning signals.",
          cause: firstSignal ? firstSignal.evidence : "The system could not prove clean progress.",
          changed,
          next: "Ask for diagnosis first, then rerun with one verification command."
        };
      }
      return {
        title: "The task appears to be moving",
        description: "No strong stuck pattern was detected. Continue with checkpoints and verification.",
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
