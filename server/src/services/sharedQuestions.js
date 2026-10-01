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
import prisma from '../prismaClient.js';
import { canonicalGroupIdFor, expandGroupIdsForQuestions } from './interviewRoster.js';

export async function saveSharedQuestions({ interviewId, groupId: requestedGroupId, questions, userId }, client = prisma) {
  const groupId = await canonicalGroupIdFor(interviewId, requestedGroupId, client);
  const aliases = (await expandGroupIdsForQuestions(interviewId, [requestedGroupId], client)).filter((id) => id !== groupId);

  const existing = await client.behavioralQuestion.findMany({
    where: { interviewId, groupId, applicationId: null },
    orderBy: { order: 'asc' },
  });
  const wanted = questions.filter((q) => typeof q === 'string' && q.trim() !== '');

  for (let i = 0; i < wanted.length; i++) {
    const questionText = wanted[i];
    const current = existing[i];
    if (!current) {
      await client.behavioralQuestion.create({
        data: { interviewId, groupId, questionText, order: i, createdBy: userId },
      });
    } else if (current.questionText !== questionText || current.order !== i) {
      await client.behavioralQuestion.update({
        where: { id: current.id },
        data: { questionText, order: i, updatedAt: new Date() },
      });
    }
  }

  if (wanted.length < existing.length) {
    await client.behavioralQuestion.deleteMany({
      where: { interviewId, groupId, applicationId: null, order: { gte: wanted.length } },
    });
  }
  if (aliases.length > 0) {
    await client.behavioralQuestion.deleteMany({
      where: { interviewId, groupId: { in: aliases }, applicationId: null },
    });
  }

  return { groupId, count: wanted.length };
}
