import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".runcap");
const LICENSE_FILE = path.join(CONFIG_DIR, "license.json");
const DEFAULT_ENDPOINT = "https://launchsoloai.com/api/runcap-ingest";

export async function readLicense() {
  if (!existsSync(LICENSE_FILE)) return null;
  try {
    const raw = await readFile(LICENSE_FILE, "utf8");
    const data = JSON.parse(raw);
    return data.key ? data : null;
  } catch {
    return null;
  }
}

export async function saveLicense(key, endpoint) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const data = { key: key.trim(), endpoint: endpoint || DEFAULT_ENDPOINT, savedAt: new Date().toISOString() };
  await writeFile(LICENSE_FILE, JSON.stringify(data, null, 2));
  return data;
}

export async function clearLicense() {
  if (existsSync(LICENSE_FILE)) {
    await writeFile(LICENSE_FILE, JSON.stringify({}, null, 2));
  }
}

function maskKey(key) {
  if (!key || key.length < 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export async function loginCommand(key) {
  if (!key) throw new Error("Usage: runcap login <license-key>");
  const saved = await saveLicense(key);
  return [
    `Saved Runcap Pro license ${maskKey(saved.key)}.`,
    `Cloud sync is now ON. Future plans and runs sync to your hosted dashboard.`,
    `Dashboard: https://launchsoloai.com/runcap/dashboard`
  ].join("\n");
}

export async function logoutCommand() {
  await clearLicense();
  return "Logged out. Cloud sync is OFF. The local core keeps working as before.";
}

export async function whoamiCommand() {
  const lic = await readLicense();
  if (!lic) return "Not logged in. Local core only (free). Run `runcap login <key>` to enable Pro cloud sync.";
  return `Logged in with license ${maskKey(lic.key)}. Cloud sync ON → ${lic.endpoint}`;
}

// Best-effort: never throws into the caller's flow. Returns a short status string.
export async function syncRun(run) {
  const lic = await readLicense();
  if (!lic) return null; // free mode, silent

  try {
    const resp = await fetch(lic.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: lic.key, run })
    });
    if (resp.ok) return "synced";
    if (resp.status === 403) return "sync_failed: license rejected (run `runcap whoami`)";
    return `sync_failed: server ${resp.status}`;
  } catch (err) {
    return `sync_failed: ${err.message}`;
  }
}

export function planToRun(plan) {
  return {
    mission_id: plan.id,
    label: plan.goal,
    estimate_low: plan.budget?.costLowUsd ?? 0,
    estimate_high: plan.budget?.costHighUsd ?? 0,
    cap: plan.budget?.recommendedCapUsd ?? null,
    actual: null,
    capped: false,
    status: "planned"
  };
}
