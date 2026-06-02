import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLicense } from "./cloud.mjs";

const CONFIG_DIR = path.join(os.homedir(), ".runcap");
const ALERTS_FILE = path.join(CONFIG_DIR, "alerts.json");

async function readAlerts() {
  if (!existsSync(ALERTS_FILE)) return { channels: [] };
  try {
    const raw = await readFile(ALERTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return { channels: Array.isArray(data.channels) ? data.channels : [] };
  } catch {
    return { channels: [] };
  }
}

async function writeAlerts(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(ALERTS_FILE, JSON.stringify(config, null, 2));
}

function describeChannel(c) {
  if (c.type === "telegram") return `telegram (chat ${c.chatId})`;
  if (c.type === "whatsapp") return `whatsapp (${c.phone})`;
  if (c.type === "webhook") return `webhook (${c.url})`;
  return c.type;
}

async function deliverToChannel(channel, text) {
  if (channel.type === "telegram") {
    const resp = await fetch(`https://api.telegram.org/bot${channel.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channel.chatId, text })
    });
    return resp.ok;
  }
  if (channel.type === "whatsapp") {
    // CallMeBot free WhatsApp API: user supplies their own phone + apikey.
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(channel.phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(channel.apikey)}`;
    const resp = await fetch(url);
    return resp.ok;
  }
  if (channel.type === "webhook") {
    // Send both keys so Slack ("text") and Discord ("content") both work.
    const resp = await fetch(channel.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text })
    });
    return resp.ok;
  }
  return false;
}

// Best-effort, never throws into the caller. Pro-gated: requires a stored license.
export async function sendAlert(text) {
  const license = await readLicense();
  if (!license) return null; // free tier: no alerts
  const { channels } = await readAlerts();
  if (!channels.length) return null;
  const results = [];
  for (const ch of channels) {
    try {
      const ok = await deliverToChannel(ch, text);
      results.push(ok ? describeChannel(ch) : `${describeChannel(ch)} (failed)`);
    } catch (err) {
      results.push(`${describeChannel(ch)} (error: ${err.message})`);
    }
  }
  return results;
}

export async function alertsCommand(args) {
  const sub = args[0] ?? "list";

  if (sub === "list") {
    const { channels } = await readAlerts();
    const license = await readLicense();
    const lines = [];
    if (!license) {
      lines.push("Alerts are a Runcap Pro feature. Run `runcap login <key>` to enable them.");
      lines.push("");
    }
    if (!channels.length) {
      lines.push("No alert channels configured.");
      lines.push("");
      lines.push("Add one (the run that breaches your cap will ping you on your phone):");
      lines.push("  runcap alerts add telegram <bot-token> <chat-id>");
      lines.push("  runcap alerts add whatsapp <phone> <callmebot-apikey>");
      lines.push("  runcap alerts add webhook <url>          (Slack / Discord / custom)");
      return lines.join("\n");
    }
    lines.push("Configured alert channels:");
    channels.forEach((c, i) => lines.push(`  ${i + 1}. ${describeChannel(c)}`));
    lines.push("");
    lines.push("Test them with: runcap alerts test");
    return lines.join("\n");
  }

  if (sub === "add") {
    const type = args[1];
    const { channels } = await readAlerts();
    let channel;
    if (type === "telegram") {
      const token = args[2];
      const chatId = args[3];
      if (!token || !chatId) throw new Error("Usage: runcap alerts add telegram <bot-token> <chat-id>");
      channel = { type: "telegram", token, chatId };
    } else if (type === "whatsapp") {
      const phone = args[2];
      const apikey = args[3];
      if (!phone || !apikey) throw new Error("Usage: runcap alerts add whatsapp <phone> <callmebot-apikey>");
      channel = { type: "whatsapp", phone, apikey };
    } else if (type === "webhook") {
      const url = args[2];
      if (!url) throw new Error("Usage: runcap alerts add webhook <url>");
      channel = { type: "webhook", url };
    } else {
      throw new Error("Unknown channel type. Use: telegram | whatsapp | webhook");
    }
    channels.push(channel);
    await writeAlerts({ channels });
    return `Added ${describeChannel(channel)}. Run \`runcap alerts test\` to confirm it reaches your phone.`;
  }

  if (sub === "test") {
    const license = await readLicense();
    if (!license) return "Alerts are Pro-only. Run `runcap login <key>` first.";
    const results = await sendAlert("Runcap test alert — your cap-breach notifications are working.");
    if (!results) return "No channels configured. Add one with `runcap alerts add ...`.";
    return `Test sent to: ${results.join(", ")}`;
  }

  if (sub === "clear" || sub === "off") {
    await writeAlerts({ channels: [] });
    return "Cleared all alert channels.";
  }

  throw new Error("Usage: runcap alerts [list|add|test|clear]");
}
