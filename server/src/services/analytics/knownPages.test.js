import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { KNOWN_PAGES, normalizeRoutePattern } from './knownPages.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../client/src/App.jsx');

describe('KNOWN_PAGES', () => {
  it('lists exactly the routes App.jsx declares', () => {
    const declared = [...fs.readFileSync(APP, 'utf8').matchAll(/path="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((p) => p !== '*')
      .map(normalizeRoutePattern);
    expect([...new Set(declared)].sort()).toEqual([...KNOWN_PAGES].sort());
  });
});
