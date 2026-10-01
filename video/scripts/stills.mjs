// Renders review stills at the given frames, for every composition or just COMP.
// Usage: COMP=GradingTutorial node scripts/stills.mjs out/stills 30 120 400 ...
import { bundle } from "@remotion/bundler";
import { getCompositions, renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [outDir, ...rest] = process.argv.slice(2);
const only = process.env.COMP;
const frames = rest.filter(Boolean).map(Number);
mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: join(here, "..", "src", "index.ts") });
for (const { id } of await getCompositions(serveUrl)) {
  if (only && only !== id) continue;
  const composition = await selectComposition({ serveUrl, id, inputProps: {} });
  for (const frame of frames) {
    await renderStill({
      serveUrl,
      composition,
      frame,
      output: join(outDir, `${id}-${String(frame).padStart(4, "0")}.jpg`),
      imageFormat: "jpeg",
      jpegQuality: 80,
      scale: 0.5,
    });
  }
}
console.log("done");
