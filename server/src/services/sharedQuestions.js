// Saving a group's shared ("behavioral") questions: the list every candidate in that
// group is asked. Used by the member and admin PATCH /interviews/:id/config routes.
//
// A group can be known by two ids: a session that was backfilled from an old blob
// group keeps that group's id as legacyGroupId. Questions are read under both
// (expandGroupIdsForQuestions), so the list someone edits is the two merged. It is
// written back under one, the id the group's questions already use
// (canonicalGroupIdFor), and anything left under the other is removed - otherwise a
// question deleted in the editor would come back from the other id on the next read,
// and an edited one would show twice.
//
// Rows are reused, never recreated, wherever a question survives the edit: an
// interviewer's notes are keyed by question id, so a kept question that came back
// with a new id would lose every note written against it.
//
// An editor that loaded the questions sends each one as { id, text }, and that id is
// what keeps its row. A bare string is matched as well as text allows - the same text
// first, then the next unclaimed row - which cannot tell "Foo became Bar, Bar became
// Baz" from "Foo was deleted, Baz was added". Only the id can.
import prisma from '../prismaClient.js';
import { canonicalGroupIdFor, expandGroupIdsForQuestions } from './interviewRoster.js';

export async function saveSharedQuestions({ interviewId, groupId: requestedGroupId, questions, userId }, client = prisma) {
  const groupId = await canonicalGroupIdFor(interviewId, requestedGroupId, client);
  const ids = [...new Set([groupId, ...(await expandGroupIdsForQuestions(interviewId, [requestedGroupId], client))])];

  // The merged list as the editor read it: by position, the group's own id first.
  const existing = (
    await client.behavioralQuestion.findMany({
      where: { interviewId, groupId: { in: ids }, applicationId: null },
      orderBy: { order: 'asc' },
    })
  ).sort((a, b) => a.order - b.order || (a.groupId === groupId ? -1 : 0) - (b.groupId === groupId ? -1 : 0));
  const entries = questions
    .map((q) => (typeof q === 'string' ? { id: null, text: q } : { id: q?.id ?? null, text: q?.text }))
    .filter((q) => typeof q.text === 'string' && q.text.trim() !== '');
  const wanted = entries.map((q) => q.text);

  // Who keeps which row: the row named by its id; then, for a bare string, the same
  // text wherever it sits; then the next unclaimed row in order. An id that is not one
  // of this group's rows (a client's temp id) counts as no id.
  const claimed = new Set();
  const rowFor = new Array(wanted.length).fill(null);
  entries.forEach(({ id }, i) => {
    const own = id && existing.find((row) => row.id === id && !claimed.has(row.id));
    if (own) {
      rowFor[i] = own;
      claimed.add(own.id);
    }
  });
  wanted.forEach((text, i) => {
    if (rowFor[i]) return;
    const same = existing.find((row) => !claimed.has(row.id) && row.questionText === text);
    if (same) {
      rowFor[i] = same;
      claimed.add(same.id);
    }
  });
  wanted.forEach((_, i) => {
    if (rowFor[i]) return;
    const next = existing.find((row) => !claimed.has(row.id));
    if (next) {
      rowFor[i] = next;
      claimed.add(next.id);
    }
  });

  for (let i = 0; i < wanted.length; i++) {
    const questionText = wanted[i];
    const row = rowFor[i];
    if (!row) {
      await client.behavioralQuestion.create({
        data: { interviewId, groupId, questionText, order: i, createdBy: userId },
      });
    } else if (row.questionText !== questionText || row.order !== i || row.groupId !== groupId) {
      await client.behavioralQuestion.update({
        where: { id: row.id },
        data: { questionText, order: i, groupId, updatedAt: new Date() },
      });
    }
  }

  const dropped = existing.filter((row) => !claimed.has(row.id)).map((row) => row.id);
  if (dropped.length > 0) {
    await client.behavioralQuestion.deleteMany({ where: { id: { in: dropped } } });
  }

  return { groupId, count: wanted.length };
}
