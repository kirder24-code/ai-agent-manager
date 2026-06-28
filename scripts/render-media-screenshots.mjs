import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mediaDir = resolve(root, "docs/assets/media");

const shots = [
  {
    html: resolve(mediaDir, "cover.html"),
    png: resolve(mediaDir, "cover.png"),
    width: 1200,
    height: 630
  },
  {
    html: resolve(mediaDir, "demo.html"),
    png: resolve(mediaDir, "demo.png"),
    width: 1200,
    height: 750
  }
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 2
    });
    await page.goto(pathToFileURL(shot.html).href, { waitUntil: "networkidle" });
    await page.screenshot({ path: shot.png, fullPage: false });
    await page.close();
    console.log(`rendered ${shot.png}`);
  }
} finally {
  await browser.close();
}
