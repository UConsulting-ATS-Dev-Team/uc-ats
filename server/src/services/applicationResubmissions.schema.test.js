// The merge re-points every row that holds an application id and then deletes
// the duplicate. A table it does not know about is orphaned, cascade-deleted,
// or blocks the delete, so a new model with an application id has to be added
// to APPLICATION_DEPENDENTS (or APPLICATION_ID_ARRAYS, for a JSON array) in the
// same change. This test is what makes that hard to forget.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLICATION_DEPENDENTS, APPLICATION_ID_ARRAYS } from './applicationResubmissions.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/schema.prisma');

/** [{ model, table, column }] for every field whose name ends in applicationId(s). */
function applicationIdColumns(schema) {
  const found = [];
  for (const [, model, body] of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (model === 'Application') continue;
    const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model;
    for (const line of body.split('\n')) {
      const field = line.trim().match(/^(\w+)\s+\S/)?.[1];
      if (field && /applicationids?$/i.test(field)) found.push({ model, table, column: field });
    }
  }
  return found;
}

describe('APPLICATION_DEPENDENTS', () => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const known = new Set([...APPLICATION_DEPENDENTS, ...APPLICATION_ID_ARRAYS].map((d) => `${d.table}.${d.column}`));

  it('finds the columns it is checking', () => {
    // Guards the parser: if it found nothing, the test below would pass vacuously.
    expect(applicationIdColumns(schema).length).toBeGreaterThanOrEqual(12);
  });

  it('lists every model in schema.prisma that holds an application id', () => {
    const missing = applicationIdColumns(schema)
      .map(({ table, column }) => `${table}.${column}`)
      .filter((key) => !known.has(key));
    expect(missing, 'add these to APPLICATION_DEPENDENTS in applicationResubmissions.js').toEqual([]);
  });

  it('lists nothing the schema no longer has', () => {
    const inSchema = new Set(applicationIdColumns(schema).map(({ table, column }) => `${table}.${column}`));
    expect([...known].filter((key) => !inSchema.has(key))).toEqual([]);
  });
});
