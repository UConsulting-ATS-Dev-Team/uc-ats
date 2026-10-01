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
  const wanted = questions.filter((q) => typeof q === 'string' && q.trim() !== '');

  // Who keeps which row: the same text first, wherever it sits; then, for a question
  // whose text was edited, the next unclaimed row in order.
  const claimed = new Set();
  const rowFor = new Array(wanted.length).fill(null);
  wanted.forEach((text, i) => {
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
