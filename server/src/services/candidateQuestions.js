import prisma from '../prismaClient.js';

// Round-one questions asked of a single candidate. They live in
// behavioral_questions next to the group-wide list; applicationId is what
// separates the two. The interview config routes only ever read and rewrite
// rows where applicationId is null, and everything here only ever touches rows
// where it is set, so neither list can clobber the other.

export class CandidateQuestionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const serialize = (question) => ({
  id: question.id,
  text: question.questionText,
  order: question.order,
  applicationId: question.applicationId,
  groupId: question.groupId,
  createdBy: question.createdBy,
  createdAt: question.createdAt,
  updatedAt: question.updatedAt
});

const parseConfig = (description) => {
  if (!description) return {};
  if (typeof description !== 'string') return description;
  try {
    return JSON.parse(description);
  } catch {
    return {};
  }
};

const cleanText = (questionText) => {
  const text = typeof questionText === 'string' ? questionText.trim() : '';
  if (!text) throw new CandidateQuestionError(400, 'questionText is required');
  return text;
};

export async function listCandidateQuestions(interviewId, applicationIds) {
  const ids = (applicationIds || []).filter(Boolean);
  if (ids.length === 0) return {};

  const rows = await prisma.behavioralQuestion.findMany({
    where: { interviewId, applicationId: { in: ids } },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }]
  });

  const byApplication = {};
  rows.forEach((row) => {
    if (!byApplication[row.applicationId]) byApplication[row.applicationId] = [];
    byApplication[row.applicationId].push(serialize(row));
  });
  return byApplication;
}

export async function createCandidateQuestion({ interviewId, applicationId, questionText, userId }) {
  if (!applicationId) throw new CandidateQuestionError(400, 'applicationId is required');
  const text = cleanText(questionText);

  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { id: true, interviewType: true, description: true }
  });
  if (!interview) throw new CandidateQuestionError(404, 'Interview not found');
  if (interview.interviewType !== 'ROUND_ONE') {
    throw new CandidateQuestionError(400, 'Candidate-specific questions are only available in first-round interviews');
  }

  // groupId is required on the row; take it from the group the candidate is
  // actually assigned to in this interview, which also rejects outsiders.
  const group = (parseConfig(interview.description).applicationGroups || []).find((g) =>
    Array.isArray(g.applicationIds) && g.applicationIds.includes(applicationId)
  );
  if (!group) throw new CandidateQuestionError(400, 'That candidate is not part of this interview');

  const last = await prisma.behavioralQuestion.findFirst({
    where: { interviewId, applicationId },
    orderBy: { order: 'desc' },
    select: { order: true }
  });

  const created = await prisma.behavioralQuestion.create({
    data: {
      interviewId,
      groupId: group.id,
      applicationId,
      questionText: text,
      order: last ? last.order + 1 : 0,
      createdBy: userId
    }
  });
  return serialize(created);
}

async function findCandidateQuestion(interviewId, questionId) {
  const question = await prisma.behavioralQuestion.findUnique({ where: { id: questionId } });
  // Group-wide rows belong to the config routes; never reachable from here.
  if (!question || question.interviewId !== interviewId || !question.applicationId) {
    throw new CandidateQuestionError(404, 'Question not found');
  }
  return question;
}

export async function updateCandidateQuestion({ interviewId, questionId, questionText }) {
  const text = cleanText(questionText);
  await findCandidateQuestion(interviewId, questionId);
  const updated = await prisma.behavioralQuestion.update({
    where: { id: questionId },
    data: { questionText: text }
  });
  return serialize(updated);
}

export async function deleteCandidateQuestion({ interviewId, questionId }) {
  await findCandidateQuestion(interviewId, questionId);
  await prisma.behavioralQuestion.delete({ where: { id: questionId } });
  return { id: questionId };
}

const respond = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (error) {
    if (error instanceof CandidateQuestionError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`[${label}]`, error);
    res.status(500).json({ error: 'Failed to update candidate questions' });
  }
};

// Shared by the member and admin routers, which differ only in auth middleware.
export const candidateQuestionHandlers = {
  list: respond('GET candidate-questions', (req) =>
    listCandidateQuestions(req.params.id, String(req.query.applicationIds || '').split(','))
  ),
  create: respond('POST candidate-questions', (req) =>
    createCandidateQuestion({
      interviewId: req.params.id,
      applicationId: req.body?.applicationId,
      questionText: req.body?.questionText,
      userId: req.user.id
    })
  ),
  update: respond('PATCH candidate-questions', (req) =>
    updateCandidateQuestion({
      interviewId: req.params.id,
      questionId: req.params.questionId,
      questionText: req.body?.questionText
    })
  ),
  remove: respond('DELETE candidate-questions', (req) =>
    deleteCandidateQuestion({ interviewId: req.params.id, questionId: req.params.questionId })
  )
};
