// Reads a constant the server ships (a default rubric, the default decision guide)
// straight out of its source, so a video always shows what the app shows.
//
// Importing the module itself would pull in Prisma and the server's dependencies, so
// this evaluates just the one expression instead: everything after
// `export const NAME =` up to the end of that expression, found by matching brackets
// (string-aware), so reformatting the file does not change what is read. Callers check
// the shape of what comes back and fail the capture if it is not what they expect.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

/** The source text of `export const name = <expression>` in a server file. */
function expressionText(src, name, file) {
  const decl = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*`).exec(src);
  if (!decl) throw new Error(`${file}: no "export const ${name}"`);
  let depth = 0;
  let quote = null;
  for (let i = decl.index + decl[0].length; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === ";" && depth === 0) return src.slice(decl.index + decl[0].length, i);
    if (depth < 0) throw new Error(`${file}: unbalanced brackets reading ${name}`);
  }
  throw new Error(`${file}: could not find the end of ${name}`);
}

/**
 * The value of a server constant. `check` receives it and should throw if its shape is
 * wrong; the capture stops there rather than filming a wrong default.
 */
export function readServerConstant(relativeFile, name, check) {
  const file = join(root, relativeFile);
  const text = expressionText(readFileSync(file, "utf8"), name, relativeFile);
  let value;
  try {
    value = Function(`"use strict"; return (${text});`)();
  } catch (e) {
    throw new Error(`${relativeFile}: ${name} is not a plain literal any more (${e.message}); update scripts/server-source.mjs`);
  }
  check?.(value);
  return value;
}

export const expect = (ok, message) => {
  if (!ok) throw new Error(`server default changed shape: ${message}`);
};
