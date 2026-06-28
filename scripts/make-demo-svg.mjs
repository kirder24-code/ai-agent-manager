// Generates docs/assets/demo.svg — an animated terminal demo of Runcap.
// Pure SVG + SMIL, no binary, no deps. Renders and animates inline on GitHub.
// Run: node scripts/make-demo-svg.mjs
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../docs/assets/demo.svg");

// Each line: { t: text, c: color-class, at: seconds it appears }
const C = {
  dim: "#7a7a7a", prompt: "#6ee7b7", text: "#d4d4d4", bad: "#f87171",
  ok: "#34d399", accent: "#22d3ee", white: "#f5f5f5", violet: "#a78bfa"
};

const lines = [
  { t: "$ runcap mission run --policy .runcap/mission.yaml -- claude \"fix the failing checkout test\"", c: C.prompt, at: 0.3 },
  { t: "Policy: checkout · team payments · cap $10 · verify \"npm test\"", c: C.dim, at: 0.9 },
  { t: "", c: C.text, at: 1.0 },
  { t: "→ estimate $3 - $7    ·    hard cap armed at $10", c: C.text, at: 1.5 },
  { t: "→ compressed 1,186 → 737 tokens on a real call  (37.9% saved)", c: C.ok, at: 2.1 },
  { t: "", c: C.text, at: 2.2 },
  { t: "✓ verify passed - but did the agent earn it?", c: C.text, at: 2.9 },
  { t: "   · verifier unchanged   · baseline truly failed   · clean-room replay reproduced", c: C.dim, at: 3.4 },
  { t: "   Verification integrity:  VERIFIED_STRONG", c: C.ok, at: 4.0 },
  { t: "   Mission cost $0.0007 / $10.00   ·   3 files changed, all in scope", c: C.text, at: 4.6 },
  { t: "   Mission verdict:  PASS", c: C.accent, at: 5.2 },
  { t: "", c: C.text, at: 5.3 },
  { t: "$ runcap ci --policy .runcap/mission.yaml      # the same gate, on the PR", c: C.prompt, at: 6.2 },
  { t: "✗ agent rewrote app/verify.mjs - protected evidence changed", c: C.bad, at: 6.9 },
  { t: "   Verification integrity:  VERIFIER_COMPROMISED", c: C.bad, at: 7.5 },
  { t: "   Mission verdict:  BLOCKED      → PR check fails, run stopped", c: C.bad, at: 8.1 }
];

const W = 980, H = 588;
const padX = 28, top = 78, lh = 27, fs = 16.5;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const total = 11.0; // loop length seconds
const rows = lines.map((ln, i) => {
  const y = top + i * lh;
  // fade+slide in at ln.at, hold, then reset at end of loop
  return `<text x="${padX}" y="${y}" fill="${ln.c}" font-family="'JetBrains Mono','SF Mono',Menlo,monospace" font-size="${fs}" opacity="0">
  <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;${(ln.at/total).toFixed(3)};${((ln.at+0.25)/total).toFixed(3)};0.97;1" dur="${total}s" repeatCount="indefinite"/>
  <animateTransform attributeName="transform" type="translate" values="10 0;10 0;0 0;0 0;0 0" keyTimes="0;${(ln.at/total).toFixed(3)};${((ln.at+0.25)/total).toFixed(3)};0.97;1" dur="${total}s" repeatCount="indefinite" additive="sum"/>
  ${esc(ln.t)}</text>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Runcap terminal demo: estimate, cap, verify integrity, mission PASS, then a tampered run graded BLOCKED on the PR">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#34d399"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="0%" r="75%">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.10"/>
      <stop offset="60%" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="#0c0c0d"/>
  <rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="${W-1}" height="${H-1}" rx="15.5" fill="none" stroke="#27272a"/>
  <!-- title bar -->
  <g>
    <circle cx="26" cy="28" r="6" fill="#f87171"/>
    <circle cx="48" cy="28" r="6" fill="#fbbf24"/>
    <circle cx="70" cy="28" r="6" fill="#34d399"/>
    <text x="100" y="33" fill="#8a8a8a" font-family="'JetBrains Mono',monospace" font-size="14">runcap · estimate · cap · verify integrity · mission verdict</text>
    <text x="${W-150}" y="33" fill="url(#brand)" font-family="'JetBrains Mono',monospace" font-weight="700" font-size="15">run·cap</text>
  </g>
  <line x1="0" y1="50" x2="${W}" y2="50" stroke="#1c1c1f"/>
${rows}
</svg>`;

writeFileSync(OUT, svg);
console.log("wrote", OUT, `(${svg.length} bytes)`);
