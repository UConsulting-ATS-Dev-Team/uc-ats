import { describe, it, expect, vi } from 'vitest';
import { saveSharedQuestions } from './sharedQuestions.js';

/**
 * A session "slot-1" backfilled from blob group "old-g": questions can sit under
 * either id. The fake applies the filters the service passes.
 */
function fakeClient(rows) {
  let nextId = rows.length + 1;
  const matches = (row, where) =>
    row.interviewId === where.interviewId &&
    row.applicationId === where.applicationId &&
    (typeof where.groupId === 'string' ? row.groupId === where.groupId : where.groupId.in.includes(row.groupId)) &&
    (where.order?.gte === undefined || row.order >= where.order.gte);
  return {
    rows,
    interviewSlot: {
      findFirst: vi.fn(() => Promise.resolve({ id: 'slot-1', legacyGroupId: 'old-g' })),
      findMany: vi.fn(() => Promise.resolve([{ id: 'slot-1', legacyGroupId: 'old-g' }])),
    },
    behavioralQuestion: {
      findMany: vi.fn(({ where }) =>
        Promise.resolve(rows.filter((r) => matches(r, where)).sort((a, b) => a.order - b.order))
      ),
      create: vi.fn(({ data }) => {
        rows.push({ id: `q${nextId++}`, applicationId: null, ...data });
        return Promise.resolve();
      }),
      update: vi.fn(({ where, data }) => {
        Object.assign(rows.find((r) => r.id === where.id), data);
        return Promise.resolve();
      }),
      deleteMany: vi.fn(({ where }) => {
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
        return Promise.resolve();
      }),
    },
  };
}

const q = (id, groupId, order, questionText) => ({ id, interviewId: 'iv1', groupId, applicationId: null, order, questionText });
const listed = (rows) => rows.filter((r) => r.applicationId === null).sort((a, b) => a.order - b.order);

describe('saveSharedQuestions', () => {
  it('writes the list under the group id its questions already use', async () => {
    const client = fakeClient([q('q1', 'old-g', 0, 'Why consulting?')]);
    await saveSharedQuestions({ interviewId: 'iv1', groupId: 'slot-1', questions: ['Why consulting?', 'A setback?'], userId: 'm1' }, client);

    expect(listed(client.rows).map((r) => [r.groupId, r.questionText])).toEqual([
      ['old-g', 'Why consulting?'],
      ['old-g', 'A setback?'],
    ]);
  });

  it('clears what was split onto the other id, so a deleted question stays deleted', async () => {
    // Read as one merged list: "Why consulting?" (old id), "Delete me" (slot id).
    const client = fakeClient([q('q1', 'old-g', 0, 'Why consulting?'), q('q2', 'slot-1', 0, 'Delete me')]);

    await saveSharedQuestions({ interviewId: 'iv1', groupId: 'slot-1', questions: ['Why consulting?'], userId: 'm1' }, client);

    expect(listed(client.rows).map((r) => [r.groupId, r.questionText])).toEqual([['old-g', 'Why consulting?']]);
  });

  it('leaves candidate-specific questions alone', async () => {
    const own = { ...q('c1', 'slot-1', 0, 'For Taylor'), applicationId: 'app1' };
    const client = fakeClient([q('q1', 'old-g', 0, 'Why consulting?'), own]);

    await saveSharedQuestions({ interviewId: 'iv1', groupId: 'slot-1', questions: [], userId: 'm1' }, client);

    expect(client.rows).toEqual([own]);
  });

  it('ignores blank entries', async () => {
    const client = fakeClient([]);
    await saveSharedQuestions({ interviewId: 'iv1', groupId: 'slot-1', questions: ['', '  ', 'Real one'], userId: 'm1' }, client);
    expect(listed(client.rows).map((r) => r.questionText)).toEqual(['Real one']);
  });
});
