// Virtual coffee chats, admin only.
//
// Mounted under /api/admin/virtual-coffee-chats, which already applies
// requireAuth + requireAdmin. Every rule lives in services/virtualCoffeeChats.js;
// this file only translates HTTP.

import express from 'express';
import prisma from '../prismaClient.js';
import { resolveAdminCycle } from '../services/activeCycle.js';
import { SlotTransactionError } from '../utils/withSerializableTransaction.js';
import {
  addApplicants,
  addInterviewers,
  cancelVirtualCoffeeChat,
  createVirtualCoffeeChat,
  getVirtualCoffeeChat,
  listEligibleApplicants,
  listVirtualCoffeeChats,
  removeApplicant,
  removeInterviewer,
  updateVirtualCoffeeChat,
} from '../services/virtualCoffeeChats.js';

const router = express.Router();

const fail = (res, error, fallback) => {
  if (error instanceof SlotTransactionError || (error?.status && error?.message)) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[virtualCoffeeChats]', error);
  return res.status(500).json({ error: fallback });
};

const idList = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);

// GET /api/admin/virtual-coffee-chats
// The chats in the admin cycle, plus who could be put in one.
router.get('/', async (req, res) => {
  try {
    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.json({ cycle: null, chats: [], applicants: [] });
    const [chats, applicants] = await Promise.all([
      listVirtualCoffeeChats(cycle.id),
      listEligibleApplicants(cycle.id),
    ]);
    res.json({ cycle: { id: cycle.id, name: cycle.name }, chats, applicants });
  } catch (error) {
    fail(res, error, 'Failed to load virtual coffee chats');
  }
});

// POST /api/admin/virtual-coffee-chats
// { title?, day, start, end, meetingUrl?, notes?, interviewerIds?, applicationIds? }
router.post('/', async (req, res) => {
  try {
    const cycle = await resolveAdminCycle(prisma);
    if (!cycle) return res.status(409).json({ error: 'There is no active cycle' });
    const body = req.body ?? {};
    const result = await createVirtualCoffeeChat({
      cycleId: cycle.id,
      actorId: req.user.id,
      body: { ...body, interviewerIds: idList(body.interviewerIds), applicationIds: idList(body.applicationIds) },
    });
    res.status(201).json(result);
  } catch (error) {
    fail(res, error, 'Failed to create that virtual coffee chat');
  }
});

// PATCH /api/admin/virtual-coffee-chats/:id   { title?, day?, start?, end?, meetingUrl?, notes? }
router.patch('/:id', async (req, res) => {
  try {
    res.json(await updateVirtualCoffeeChat(req.params.id, req.body ?? {}));
  } catch (error) {
    fail(res, error, 'Failed to update that virtual coffee chat');
  }
});

// POST /api/admin/virtual-coffee-chats/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    res.json(await cancelVirtualCoffeeChat(req.params.id, req.user.id));
  } catch (error) {
    fail(res, error, 'Failed to cancel that virtual coffee chat');
  }
});

// POST /api/admin/virtual-coffee-chats/:id/applicants   { applicationIds: [] }
router.post('/:id/applicants', async (req, res) => {
  try {
    const applicants = await addApplicants(req.params.id, idList(req.body?.applicationIds), req.user.id);
    res.json({ applicants, chat: await getVirtualCoffeeChat(req.params.id) });
  } catch (error) {
    fail(res, error, 'Failed to add those applicants');
  }
});

// DELETE /api/admin/virtual-coffee-chats/:id/applicants/:signupId
router.delete('/:id/applicants/:signupId', async (req, res) => {
  try {
    res.json(await removeApplicant(req.params.id, req.params.signupId, req.user.id));
  } catch (error) {
    fail(res, error, 'Failed to remove that applicant');
  }
});

// POST /api/admin/virtual-coffee-chats/:id/interviewers   { userIds: [] }
router.post('/:id/interviewers', async (req, res) => {
  try {
    const interviewers = await addInterviewers(req.params.id, idList(req.body?.userIds));
    res.json({ interviewers, chat: await getVirtualCoffeeChat(req.params.id) });
  } catch (error) {
    fail(res, error, 'Failed to add those interviewers');
  }
});

// DELETE /api/admin/virtual-coffee-chats/:id/interviewers/:assignmentId
router.delete('/:id/interviewers/:assignmentId', async (req, res) => {
  try {
    res.json(await removeInterviewer(req.params.id, req.params.assignmentId, req.user.id));
  } catch (error) {
    fail(res, error, 'Failed to remove that interviewer');
  }
});

export default router;
