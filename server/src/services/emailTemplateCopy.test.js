import { describe, it, expect, vi } from 'vitest';

vi.mock('../prismaClient.js', () => ({ default: { $disconnect: vi.fn() } }));

import {
  DECISION_COPY_KEY,
  EMAIL_COPY_SCHEMA,
  SLOT_EMAIL_TYPES,
  defaultCopy,
  getEmailCopy,
  isEditableTemplate,
  listEmailCopy,
  normalizeCopy,
  resetEmailCopy,
  resolveEmailCopy,
  resolveEmailCopyMany,
  saveEmailCopy,
  slotCopyKey,
} from './emailTemplateCopy.js';
import { mergeFieldsUsed } from './emailCopyRender.js';

/** A store nobody has written to. */
const shipped = () => ({ emailTemplateCopy: { findMany: vi.fn(async () => []) } });

/** A store holding exactly these rows. */
const stored = (rows) => ({
  emailTemplateCopy: {
    findMany: vi.fn(async ({ where } = {}) => {
      const key = where?.templateKey;
      if (typeof key === 'string') return rows.filter((row) => row.templateKey === key);
      if (key?.in) return rows.filter((row) => key.in.includes(row.templateKey));
      return rows;
    }),
  },
});

describe('the catalog', () => {
  it('declares every merge field its wording uses', () => {
    for (const [key, template] of Object.entries(EMAIL_COPY_SCHEMA)) {
      const declared = new Set(template.mergeFields);
      for (const field of template.fields) {
        for (const used of mergeFieldsUsed(field.default)) {
          expect(declared.has(used), `${key}.${field.name} uses {{${used}}}`).toBe(true);
        }
      }
    }
  });

  it('ships wording for every field, so nothing can render blank', () => {
    for (const [key, template] of Object.entries(EMAIL_COPY_SCHEMA)) {
      for (const field of template.fields) {
        expect(field.default?.trim(), `${key}.${field.name}`).toBeTruthy();
        expect(field.label, `${key}.${field.name}`).toBeTruthy();
        expect(['line', 'block', 'signoff'], `${key}.${field.name}`).toContain(field.type);
      }
    }
  });

  it('gives every field a name of its own within its template', () => {
    for (const [key, template] of Object.entries(EMAIL_COPY_SCHEMA)) {
      const names = template.fields.map((field) => field.name);
      expect(new Set(names).size, key).toBe(names.length);
    }
  });

  it('gives every email a subject', () => {
    for (const [key, template] of Object.entries(EMAIL_COPY_SCHEMA)) {
      expect(template.fields.map((f) => f.name), key).toContain('subject');
    }
  });

  it('covers every interview-slot notification the renderer can draw', () => {
    for (const type of SLOT_EMAIL_TYPES) {
      expect(isEditableTemplate(slotCopyKey(type)), type).toBe(true);
    }
  });

  it('covers every round decision', () => {
    for (const [round, outcomes] of Object.entries({
      1: ['ADVANCED', 'REJECTED'],
      2: ['ADVANCED', 'REJECTED'],
      3: ['ADVANCED', 'REJECTED'],
      4: ['ACCEPTED', 'REJECTED'],
    })) {
      for (const outcome of outcomes) {
        expect(isEditableTemplate(DECISION_COPY_KEY(round, outcome))).toBe(true);
      }
    }
  });

  it('does not treat a prototype key as a template', () => {
    expect(isEditableTemplate('constructor')).toBe(false);
    expect(isEditableTemplate('toString')).toBe(false);
  });
});

describe('resolving what an email says', () => {
  it('uses the shipped wording when nobody has edited it', async () => {
    const copy = await resolveEmailCopy('rsvp-confirmation', { client: shipped() });
    expect(copy).toEqual(defaultCopy('rsvp-confirmation'));
  });

  it('prefers an edit, field by field', async () => {
    const client = stored([
      { templateKey: 'rsvp-confirmation', copy: { heading: 'You are on the list' } },
    ]);
    const copy = await resolveEmailCopy('rsvp-confirmation', { client });

    expect(copy.heading).toBe('You are on the list');
    expect(copy.intro).toBe(defaultCopy('rsvp-confirmation').intro);
  });

  it('ignores a blank stored field rather than rendering a gap', async () => {
    const client = stored([{ templateKey: 'rsvp-confirmation', copy: { heading: '   ' } }]);
    const copy = await resolveEmailCopy('rsvp-confirmation', { client });

    expect(copy.heading).toBe(defaultCopy('rsvp-confirmation').heading);
  });

  it('ignores a stored field the template no longer has', async () => {
    const client = stored([{ templateKey: 'rsvp-confirmation', copy: { retired: 'x' } }]);
    const copy = await resolveEmailCopy('rsvp-confirmation', { client });

    expect(copy).not.toHaveProperty('retired');
    expect(copy).toEqual(defaultCopy('rsvp-confirmation'));
  });

  it('falls back to the shipped wording when the store cannot be read at all', async () => {
    // Migrations here are applied by hand, so a deploy can reach a send before
    // anybody has run the SQL. A missing table must not stop an email going out.
    const broken = {
      emailTemplateCopy: {
        findMany: vi.fn(async () => {
          throw new Error('relation "email_template_copy" does not exist');
        }),
      },
    };

    await expect(resolveEmailCopy('rsvp-confirmation', { client: broken })).resolves.toEqual(
      defaultCopy('rsvp-confirmation')
    );
  });

  it('refuses a key it has no wording for', async () => {
    await expect(resolveEmailCopy('not-a-template', { client: shipped() })).rejects.toMatchObject({
      status: 404,
      code: 'UNKNOWN_TEMPLATE',
    });
  });

  it('reads many templates in one query', async () => {
    const client = shipped();
    const copies = await resolveEmailCopyMany(
      ['rsvp-confirmation', 'attendance-confirmation'],
      { client }
    );

    expect(client.emailTemplateCopy.findMany).toHaveBeenCalledTimes(1);
    expect([...copies.keys()]).toEqual(['rsvp-confirmation', 'attendance-confirmation']);
  });

  it('drops a key nothing can edit rather than inventing a record for it', async () => {
    const copies = await resolveEmailCopyMany(['rsvp-confirmation', 'nonsense'], {
      client: shipped(),
    });

    expect([...copies.keys()]).toEqual(['rsvp-confirmation']);
  });
});

describe('validating an edit', () => {
  it('keeps a changed field and trims it', () => {
    expect(normalizeCopy('rsvp-confirmation', { heading: '  You are on the list  ' })).toEqual({
      heading: 'You are on the list',
    });
  });

  it('drops a field left at the shipped wording', () => {
    // The editor fills its boxes with the current words, so a save after
    // changing one sentence carries every other sentence unchanged. Storing
    // those would freeze this email at today's wording.
    const defaults = defaultCopy('rsvp-confirmation');
    expect(normalizeCopy('rsvp-confirmation', { ...defaults, heading: 'New' })).toEqual({
      heading: 'New',
    });
  });

  it('drops a blank field, which is how one goes back to the default', () => {
    expect(normalizeCopy('rsvp-confirmation', { heading: '  ' })).toEqual({});
  });

  it('drops a field the template does not have, instead of refusing the save', () => {
    // A client left open across a deploy that renamed a field must not lock an
    // admin out of saving the fields that still exist.
    expect(normalizeCopy('rsvp-confirmation', { heading: 'New', retired: 'x' })).toEqual({
      heading: 'New',
    });
  });

  it('refuses a merge field this email cannot fill in', () => {
    expect(() => normalizeCopy('rsvp-confirmation', { heading: 'Hi {{memberName}}' })).toThrow(
      /\{\{memberName\}\}/
    );
  });

  it('allows a merge field this email does declare', () => {
    expect(normalizeCopy('rsvp-confirmation', { heading: 'Hi {{candidateName}}' })).toEqual({
      heading: 'Hi {{candidateName}}',
    });
  });

  it('refuses a field longer than the column should hold', () => {
    expect(() => normalizeCopy('rsvp-confirmation', { heading: 'x'.repeat(4001) })).toThrow(
      /over 4000 characters/
    );
  });

  it('refuses HTML, because the editor promises the layout is not editable', () => {
    expect(() => normalizeCopy('rsvp-confirmation', { heading: '<div>Hi</div>' })).toThrow(/contains HTML/);
    expect(() => normalizeCopy('rsvp-confirmation', { intro: 'Hi <script>alert(1)</script>' })).toThrow(/contains HTML/);
  });

  it('allows a less-than that is not a tag', () => {
    expect(normalizeCopy('rsvp-confirmation', { heading: 'Seats < 10' })).toEqual({
      heading: 'Seats < 10',
    });
  });

  it('refuses a link that is not a web address', () => {
    // Refused on the way in as well as defused on the way out: the round
    // decision emails render through decisionTemplates.js, which does not go
    // near emailCopyRender.js.
    expect(() => normalizeCopy('rsvp-confirmation', { intro: '[click](javascript:alert(1))' })).toThrow(
      /not a web address/
    );
    expect(() => normalizeCopy('rsvp-confirmation', { intro: '[click](data:text/plain,hi)' })).toThrow(
      /not a web address/
    );
  });

  it('allows the links an email actually carries', () => {
    const links = '[ATS](https://uconsultingats.com) and [us](mailto:recruitment@example.com)';
    expect(normalizeCopy('rsvp-confirmation', { intro: links })).toEqual({ intro: links });
  });

  it('allows a link built from a merge field the email supplies', () => {
    expect(
      normalizeCopy('decision-round-4-accepted', { body: 'Hi {{firstName}}, {{accountSetup}}' })
    ).toEqual({ body: 'Hi {{firstName}}, {{accountSetup}}' });
  });

  it('refuses something that is not an object', () => {
    expect(() => normalizeCopy('rsvp-confirmation', 'nope')).toThrow(/must be an object/);
    expect(() => normalizeCopy('rsvp-confirmation', ['nope'])).toThrow(/must be an object/);
  });
});

describe('saving and resetting', () => {
  const editorClient = (rows = []) => ({
    ...stored(rows),
    emailTemplateCopy: {
      ...stored(rows).emailTemplateCopy,
      upsert: vi.fn(async ({ create }) => {
        rows.push({ templateKey: create.templateKey, copy: create.copy, updatedAt: new Date() });
      }),
      deleteMany: vi.fn(async ({ where }) => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].templateKey === where.templateKey) rows.splice(i, 1);
        }
      }),
    },
  });

  it('writes only the fields that differ from the shipped wording', async () => {
    const client = editorClient();
    await saveEmailCopy({
      client,
      key: 'rsvp-confirmation',
      copy: { ...defaultCopy('rsvp-confirmation'), heading: 'You are on the list' },
      user: { id: 'admin-1' },
    });

    expect(client.emailTemplateCopy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ copy: { heading: 'You are on the list' } }),
      })
    );
  });

  it('records who made the change', async () => {
    const client = editorClient();
    await saveEmailCopy({
      client,
      key: 'rsvp-confirmation',
      copy: { heading: 'New' },
      user: { id: 'admin-1' },
    });

    expect(client.emailTemplateCopy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ updatedById: 'admin-1' }) })
    );
  });

  it('treats a save with nothing changed as a reset, not an empty row', async () => {
    // An empty row would report this template as customized forever.
    const client = editorClient([{ templateKey: 'rsvp-confirmation', copy: { heading: 'Old' } }]);
    const result = await saveEmailCopy({
      client,
      key: 'rsvp-confirmation',
      copy: defaultCopy('rsvp-confirmation'),
      user: { id: 'admin-1' },
    });

    expect(client.emailTemplateCopy.upsert).not.toHaveBeenCalled();
    expect(client.emailTemplateCopy.deleteMany).toHaveBeenCalled();
    expect(result.customized).toBe(false);
  });

  it('puts the shipped wording back', async () => {
    const rows = [{ templateKey: 'rsvp-confirmation', copy: { heading: 'Old' } }];
    const client = editorClient(rows);
    const result = await resetEmailCopy({ client, key: 'rsvp-confirmation' });

    expect(rows).toHaveLength(0);
    expect(result.customized).toBe(false);
    expect(result.fields.find((f) => f.name === 'heading').value).toBe('');
  });

  it('is not an error to reset a template nobody had edited', async () => {
    const client = editorClient();
    await expect(resetEmailCopy({ client, key: 'rsvp-confirmation' })).resolves.toBeTruthy();
  });

  it('refuses to save against a key it has no wording for', async () => {
    await expect(
      saveEmailCopy({ client: editorClient(), key: 'nonsense', copy: {}, user: { id: 'a' } })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('what the editor is handed', () => {
  it('shows each field with what is stored and what it falls back to', async () => {
    const client = stored([{ templateKey: 'rsvp-confirmation', copy: { heading: 'Mine' } }]);
    const one = await getEmailCopy('rsvp-confirmation', { client });

    const heading = one.fields.find((field) => field.name === 'heading');
    expect(heading.value).toBe('Mine');
    expect(heading.default).toBe(defaultCopy('rsvp-confirmation').heading);

    const intro = one.fields.find((field) => field.name === 'intro');
    expect(intro.value).toBe('');
    expect(intro.default).toBeTruthy();
    expect(one.customized).toBe(true);
  });

  it('lists every template in one query', async () => {
    const client = shipped();
    const all = await listEmailCopy({ client });

    expect(client.emailTemplateCopy.findMany).toHaveBeenCalledTimes(1);
    expect(Object.keys(all).sort()).toEqual(Object.keys(EMAIL_COPY_SCHEMA).sort());
    expect(Object.values(all).every((entry) => entry.customized === false)).toBe(true);
  });
});
