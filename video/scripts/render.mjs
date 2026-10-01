// Renders one tutorial to out/<id>.mp4 and its thumbnail to out/<id>-thumb.png.
// Usage: node scripts/render.mjs <id>
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { getCompositions } from "@remotion/renderer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = process.argv[2];
const serveUrl = await bundle({ entryPoint: join(root, "src/index.ts") });
const comps = await getCompositions(serveUrl);
// Composition ids are the video id in PascalCase plus "Tutorial" (see src/videos).
const pascal = (s) => s.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
const comp = comps.find((c) => c.id === `${pascal(id ?? "")}Tutorial`);
if (!comp) {
  console.error(`Usage: npm run render -- <id>   (compositions: ${comps.map((c) => c.id).join(", ")})`);
  process.exit(1);
}
if (!existsSync(join(root, `public/shots/${id}/states.json`))) {
  console.error(`No captures for ${id}: run \`npm run capture -- ${id}\` first.`);
  process.exit(1);
}
const { THUMB_FRAME } = await import(`../src/videos/${id}/timeline.ts`);
const run = (...args) => execFileSync("npx", ["remotion", ...args], { cwd: root, stdio: "inherit" });
run("render", "src/index.ts", comp.id, `out/${id}.mp4`, "--codec=h264");
run("still", "src/index.ts", comp.id, `out/${id}-thumb.png`, `--frame=${THUMB_FRAME}`);
