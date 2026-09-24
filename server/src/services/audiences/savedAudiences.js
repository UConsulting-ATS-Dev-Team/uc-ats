// Named audiences an admin can reuse. Only the filter tree is kept: a saved
// audience is re-run each time it is used, so "Kickoff list" reaches whoever
// matches on the day it is sent, including people who applied or signed up
// since it was saved. There are deliberately no frozen snapshots - "exactly the
// people who got send X" is a rule of its own (receivedCampaign) instead.
//
// Shared across admins, like drafts.

import prisma from '../../prismaClient.js';
import { normalizeAudienceTree } from './audienceFilters.js';

const SELECT = {
  id: true,
  name: true,
  description: true,
  filters: true,
  lastUsedAt: true,
  lastUsedCount: true,
  createdAt: true,
  updatedAt: true,
  creator: { select: { id: true, fullName: true } },
  editor: { select: { id: true, fullName: true } },
};

function notFound() {
  const err = new Error('Saved audience not found');
  err.status = 404;
  return err;
}

function cleanName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    const err = new Error('Give the audience a name');
    err.status = 400;
    throw err;
  }
  return trimmed.slice(0, 120);
}

export async function listSavedAudiences() {
  return prisma.savedAudience.findMany({ orderBy: { updatedAt: 'desc' }, select: SELECT });
}

export async function getSavedAudience(id, client = prisma) {
  const audience = await client.savedAudience.findUnique({ where: { id }, select: SELECT });
  if (!audience) throw notFound();
  return audience;
}

export async function createSavedAudience({ name, description, filters, createdById }) {
  return prisma.savedAudience.create({
    data: {
      name: cleanName(name),
      description: description ? String(description).trim().slice(0, 500) : null,
      // Validated before it is stored, so a saved audience can always be sent.
      filters: normalizeAudienceTree(filters),
      createdById,
    },
    select: SELECT,
  });
}

export async function updateSavedAudience({ id, updatedById, name, description, filters }) {
  await getSavedAudience(id);
  const data = { updatedById };
  if (name !== undefined) data.name = cleanName(name);
  if (description !== undefined) data.description = description ? String(description).trim().slice(0, 500) : null;
  if (filters !== undefined) data.filters = normalizeAudienceTree(filters);
  return prisma.savedAudience.update({ where: { id }, data, select: SELECT });
}

export async function deleteSavedAudience(id) {
  await getSavedAudience(id);
  // Drafts and schedules that pointed at it keep their own copy of the filters
  // (the foreign keys are ON DELETE SET NULL), so nothing queued is lost.
  await prisma.savedAudience.delete({ where: { id } });
  return { id };
}

/** Remember a send, so the picker can say how the audience has changed since. */
export async function markSavedAudienceUsed(id, count) {
  try {
    await prisma.savedAudience.update({
      where: { id },
      data: { lastUsedAt: new Date(), lastUsedCount: count },
    });
  } catch (error) {
    // Bookkeeping only: the mail has gone, and failing now would report a
    // delivered send as an error.
    console.error('[savedAudiences] could not record use:', error.message);
  }
}
