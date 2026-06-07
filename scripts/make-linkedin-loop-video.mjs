// Renders a LinkedIn-ready MP4 for the Runcap loop-detection post.
// Narrative: a circling agent looks busy but burns money -> Runcap catches the
// loop in real time -> proven 37.9% compression -> hard cap stops the run.
// Output: docs/assets/media/runcap-linkedin-loop-demo.mp4
// Requires: playwright + ffmpeg available on the machine.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "docs/assets/media");
const framesDir = "/private/tmp/runcap-linkedin-loop-frames";
const outFile = join(outDir, "runcap-linkedin-loop-demo.mp4");

const width = 1080;
const height = 1080;
const fps = 30;
const duration = 13;
const frameCount = fps * duration;

mkdirSync(outDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });
for (const file of readdirSync(framesDir)) {
  if (file.startsWith("frame-") && file.endsWith(".png")) {
    rmSync(join(framesDir, file));
  }
}

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #f4f6fb;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #f8fafc;
    }
    .stage {
      width: ${width}px;
      height: ${height}px;
      padding: 58px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 15% 10%, rgba(167, 139, 250, .2), transparent 32%),
        radial-gradient(circle at 85% 12%, rgba(34, 211, 238, .16), transparent 34%),
        linear-gradient(135deg, #eef2ff, #f8fafc);
    }
    .card {
      width: 964px;
      height: 964px;
      border-radius: 42px;
      padding: 42px;
      background: #080b12;
      box-shadow: 0 36px 90px rgba(15, 23, 42, .25);
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 50% -10%, rgba(167, 139, 250, .18), transparent 36%),
        linear-gradient(180deg, rgba(255,255,255,.06), transparent 28%);
      pointer-events: none;
    }
    .top {
      position: relative;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #94a3b8;
      font-size: 23px;
      letter-spacing: -0.02em;
    }
    .brand {
      display: flex;
      gap: 14px;
      align-items: center;
      font-weight: 800;
      color: #fff;
      font-size: 30px;
    }
    .logo {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #22d3ee, #34d399);
      color: #021014;
      font-weight: 900;
    }
    .pill {
      border: 1px solid rgba(148, 163, 184, .28);
      background: rgba(15, 23, 42, .68);
      color: #cbd5e1;
      border-radius: 999px;
      padding: 10px 16px;
      font-size: 18px;
      font-weight: 650;
    }
    .content {
      position: relative;
      height: 818px;
      padding-top: 44px;
    }
    .headline {
      margin: 0;
      color: #f8fafc;
      font-size: 68px;
      line-height: .98;
      letter-spacing: -0.06em;
      max-width: 840px;
    }
    .sub {
      margin-top: 22px;
      color: #cbd5e1;
      font-size: 29px;
      line-height: 1.28;
      letter-spacing: -0.03em;
      max-width: 820px;
    }
    .accent { color: #67e8f9; }
    .green { color: #34d399; }
    .red { color: #fb7185; }
    .violet { color: #a78bfa; }
    .mono {
      font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      letter-spacing: -0.04em;
    }
    .terminal {
      margin-top: 38px;
      border: 1px solid rgba(148, 163, 184, .22);
      background: rgba(2, 6, 23, .82);
      border-radius: 24px;
      padding: 26px;
      font-size: 24px;
      line-height: 1.5;
      color: #dbeafe;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
    }
    .terminal .line { opacity: 1; }
    .warning {
      margin-top: 28px;
      border: 1px solid rgba(167, 139, 250, .4);
      background: rgba(167, 139, 250, .12);
      color: #ddd6fe;
      border-radius: 22px;
      padding: 22px 26px;
      font-size: 28px;
      font-weight: 850;
      letter-spacing: -0.04em;
    }
    .numbers {
      margin-top: 46px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      align-items: end;
    }
    .number-card {
      border-radius: 26px;
      padding: 28px;
      background: rgba(15, 23, 42, .9);
      border: 1px solid rgba(148, 163, 184, .22);
    }
    .label {
      color: #94a3b8;
      font-size: 22px;
      margin-bottom: 12px;
      letter-spacing: -0.03em;
    }
    .big {
      font-size: 78px;
      line-height: .9;
      font-weight: 900;
      letter-spacing: -0.08em;
    }
    .bar {
      margin-top: 32px;
      height: 34px;
      border-radius: 999px;
      background: rgba(148, 163, 184, .16);
      overflow: hidden;
      border: 1px solid rgba(148, 163, 184, .24);
    }
    .fill {
      height: 100%;
      width: 37.9%;
      border-radius: 999px;
      background: linear-gradient(90deg, #22d3ee, #34d399);
    }
    .footer {
      position: absolute;
      left: 42px;
      right: 42px;
      bottom: 34px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #94a3b8;
      font-size: 20px;
    }
    .scene {
      position: absolute;
      inset: 44px 0 0 0;
      opacity: 0;
      transform: translateY(24px) scale(.985);
      transition: opacity .24s ease, transform .24s ease;
    }
    .scene.active {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="card">
      <div class="top">
        <div class="brand"><div class="logo">R</div> Runcap</div>
        <div class="pill">local-first AI cost control</div>
      </div>
      <div class="content">
        <section class="scene active" id="s0">
          <h1 class="headline">Your AI agent looks busy. It is just circling.</h1>
          <p class="sub">Same failure, reworded every turn. It produces output, makes no progress, and keeps spending your tokens.</p>
          <div class="terminal mono">
            <div class="line">attempt 1: guard the undefined with an if check</div>
            <div class="line">attempt 2: add an optional chain before .id</div>
            <div class="line">attempt 3: default the object to {} first</div>
            <div class="line red">test still fails. budget still draining.</div>
          </div>
        </section>
        <section class="scene" id="s1">
          <h1 class="headline">Plain hashing never catches this.</h1>
          <p class="sub">The prompt is similar but never byte-identical between loops, so the hash changes every turn and nothing trips.</p>
          <div class="terminal mono">
            <div class="line">hash(attempt 1) = a91f...  hash(attempt 2) = c4d2...</div>
            <div class="line red">different hash every time -&gt; loop invisible</div>
          </div>
        </section>
        <section class="scene" id="s2">
          <h1 class="headline">Runcap measures similarity, not hashes.</h1>
          <p class="sub">A local gateway sees every request in real time and compares each prompt's shape against the recent run.</p>
          <div class="warning">loop: last 3 prompts 97.7% identical, no progress. The agent is circling the same failure.</div>
          <div class="terminal mono">
            <div class="line green">$ runcap status</div>
            <div class="line violet">Loop warning: stepping in before it burns more budget.</div>
          </div>
        </section>
        <section class="scene" id="s3">
          <h1 class="headline">And it compresses every call it lets through.</h1>
          <div class="numbers">
            <div class="number-card">
              <div class="label">baseline prompt</div>
              <div class="big red mono">1,186</div>
              <div class="label">tokens</div>
            </div>
            <div class="number-card">
              <div class="label">with Runcap</div>
              <div class="big green mono">737</div>
              <div class="label">tokens</div>
            </div>
          </div>
          <div class="bar"><div class="fill"></div></div>
          <p class="sub"><span class="green">37.9% saved</span> on a real OpenAI call. The model still answered correctly about the changed line.</p>
        </section>
        <section class="scene" id="s4">
          <h1 class="headline">Estimate. Cap. Compress. Catch the loop.</h1>
          <p class="sub">Point your OpenAI or Anthropic-compatible tools at the local gateway. When the ceiling is crossed, the next call stops.</p>
          <div class="terminal mono">
            <div class="line green">$ AIM_DAILY_BUDGET_USD=10 runcap gateway</div>
            <div class="line">gateway up · compress on · hard cap armed · loop guard on</div>
            <div class="line red">HTTP 429 budget_guard</div>
            <div class="line accent">stopped before money left your account</div>
          </div>
        </section>
      </div>
      <div class="footer">
        <span class="mono">npm install -g runcap</span>
        <span>Free · MIT · 100% local</span>
      </div>
    </div>
  </div>
  <script>
    const scenes = [...document.querySelectorAll(".scene")];
    window.renderFrame = (seconds) => {
      const index =
        seconds < 2.8 ? 0 :
        seconds < 5.2 ? 1 :
        seconds < 8.2 ? 2 :
        seconds < 10.6 ? 3 : 4;
      scenes.forEach((scene, i) => scene.classList.toggle("active", i === index));
    };
  </script>
</body>
</html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(100);

for (let i = 0; i < frameCount; i += 1) {
  const seconds = i / fps;
  await page.evaluate((t) => window.renderFrame(t), seconds);
  await page.screenshot({ path: join(framesDir, `frame-${String(i).padStart(4, "0")}.png`) });
}
await browser.close();

const ffmpeg = spawnSync("ffmpeg", [
  "-y",
  "-framerate", String(fps),
  "-i", join(framesDir, "frame-%04d.png"),
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-crf", "18",
  outFile
], { stdio: "inherit" });

if (ffmpeg.status !== 0) {
  process.exit(ffmpeg.status ?? 1);
}

console.log(`wrote ${outFile}`);
