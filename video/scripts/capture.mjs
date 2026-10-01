// Walks one tutorial's flow through the real client in Chromium and screenshots
// every state the video shows, plus the box of everything the cursor aims at,
// into public/shots/<id>/ (states.json + PNGs at 2x).
//
// The app is the real client, but every /api request is answered by the
// video's flow (scripts/flows/<id>.mjs) from made-up sample data, so no server
// or database is involved and no real applicant appears. Writes are stubbed.
//
// Needs the Vite client running: `npx vite --port 5199` in client/ (or
// CLIENT_URL). Usage: node scripts/capture.mjs <id>
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const id = process.argv[2];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!id || !existsSync(join(root, "scripts/flows", `${id}.mjs`))) {
  const ids = readdirSync(join(root, "scripts/flows")).map((f) => f.replace(/\.mjs$/, ""));
  console.error(`Usage: npm run capture -- <id>   (one of: ${ids.join(", ")})`);
  process.exit(1);
}
const flow = await import(`./flows/${id}.mjs`);

const out = join(root, "public/shots", id);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const base = process.env.CLIENT_URL || "http://localhost:5199";
const SCALE = 2;

// CHROME_PATH if set; otherwise the newest Chromium in the macOS Playwright cache;
// otherwise whatever `npx playwright install chromium` put where playwright-core looks.
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  if (!dir) return undefined;
  const p = join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  return existsSync(p) ? p : undefined;
}

let browser;
try {
  browser = await chromium.launch({ executablePath: chromePath() });
} catch (e) {
  console.error(`Could not start Chromium (${e.message.split("\n")[0]}).\nInstall it with \`npx playwright@1.56.1 install chromium\`, or point CHROME_PATH at a Chrome or Chromium binary.`);
  process.exit(1);
}
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE });
await context.addInitScript(() => {
  localStorage.setItem("token", "sample-token");
  localStorage.setItem("theme", "light");
});

// Calls the app makes on every page, whatever the flow.
function common(path, json) {
  if (path === "/member/events") return json([]);
  if (path === "/member/accountability") return json({ cycle: null, standing: null });
  if (path === "/live-votes/active") return json({ session: null });
  if (path.startsWith("/analytics")) return true;
  return false;
}

const page = await context.newPage();
// Native alert/confirm/prompt never show in screenshots; accept them so the flow runs.
page.on("dialog", (d) => d.accept(d.type() === "prompt" ? d.defaultValue() : undefined).catch(() => {}));

const states = {};
const settle = (ms = 350) => page.waitForTimeout(ms);
const rect = async (loc) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no box for ${loc}`);
  return b;
};
const file = (name) => `${id}/${name}.png`;
const shotPath = (name) => join(out, `${name}.png`);

/**
 * A whole page: the full-length screenshot (so the video can scroll it) and a
 * viewport shot at the top for the fixed top bar and sidebar. Boxes are in
 * page coordinates. Targets that are not on the page are skipped.
 */
async function pageState(name, targets = {}) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(250);
  await page.screenshot({ path: shotPath(name), fullPage: true });
  await page.screenshot({ path: shotPath(`${name}-chrome`) });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const boxes = {};
  for (const [k, loc] of Object.entries(targets)) {
    if ((await loc.count()) === 0) continue;
    const r = await rect(loc.first());
    const sy = await page.evaluate(() => window.scrollY);
    boxes[k] = { ...r, y: r.y + sy };
  }
  states[name] = { kind: "page", file: file(name), chrome: file(`${name}-chrome`), w: 1440, h: height, boxes };
  console.log("page", name, height);
}

/** The viewport as it stands (no scrolling), e.g. a page with a drawer open. */
async function viewState(name, targets = {}) {
  await settle(250);
  await page.screenshot({ path: shotPath(name) });
  const boxes = {};
  for (const [k, loc] of Object.entries(targets)) {
    if ((await loc.count()) === 0) continue;
    boxes[k] = await rect(loc.first());
  }
  states[name] = { kind: "view", file: file(name), w: 1440, h: 900, boxes };
  console.log("view", name);
}

/** One element (a dialog) on its own; boxes are relative to it. */
async function elState(name, el, targets = {}, extra) {
  await settle();
  const b = await rect(el);
  await el.screenshot({ path: shotPath(name), animations: "disabled" });
  const boxes = {};
  for (const [k, loc] of Object.entries(targets)) {
    if ((await loc.count()) === 0) continue;
    const r = await rect(loc.first());
    boxes[k] = { x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height };
  }
  if (extra) Object.assign(boxes, await extra(el, b));
  states[name] = { kind: "el", file: file(name), x: b.x, y: b.y, w: b.width, h: b.height, boxes };
  console.log("el", name);
}

const kit = { id, root, out, base, page, context, browser, states, settle, rect, pageState, viewState, elState };

if (flow.setup) await flow.setup(kit);
await context.route("**/api/**", async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname.replace(/^\/api/, "");
  // A flow answers by calling json() or fulfill(); whatever it leaves falls through.
  let answered = false;
  const fulfill = (opts) => {
    answered = true;
    return route.fulfill(opts);
  };
  const json = (body, status = 200) => fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await flow.api({ path, req, route: { fulfill }, json, url: new URL(req.url()) });
  if (answered) return;
  const handled = common(path, json);
  if (handled === true) return route.fulfill({ status: 204, body: "" });
  if (handled) return;
  console.warn("unhandled", req.method(), path);
  return json({});
});

await flow.run(kit);

writeFileSync(join(out, "states.json"), JSON.stringify({ scale: SCALE, states }, null, 1));
await browser.close();
console.log(`wrote ${Object.keys(states).length} states to ${out}`);
