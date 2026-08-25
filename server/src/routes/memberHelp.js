import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const TUTORIAL_CATEGORIES = [
  'DOCUMENT_GRADING',
  'INTERVIEW_CONDUCT',
  'GTKUC',
  'ATS_NAVIGATION',
  'NEW_FEATURES',
];

// GET /api/member/help/announcements
router.get('/announcements', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const activeCycle = await prisma.recruitingCycle.findFirst({
      where: { isActive: true },
      select: { id: true },
    });

    const cycleFilter = activeCycle
      ? { OR: [{ cycleId: activeCycle.id }, { cycleId: null }] }
      : { cycleId: null };

    const announcements = await prisma.helpAnnouncement.findMany({
      where: {
        ...cycleFilter,
      },
      orderBy: { publishedAt: 'desc' },
      include: {
        reads: {
          where: { memberId: userId },
          select: { id: true, readAt: true },
        },
      },
    });

    const result = announcements.map((a) => ({
      ...a,
      isRead: a.reads.length > 0,
      readAt: a.reads[0]?.readAt || null,
      reads: undefined,
    }));

    res.json(result);
  } catch (error) {
    console.error('[GET /api/member/help/announcements]', error);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

// POST /api/member/help/announcements/:id/dismiss
router.post('/announcements/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const memberId = req.user.id;

    const existing = await prisma.helpAnnouncement.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    await prisma.memberAnnouncementRead.upsert({
      where: {
        memberId_announcementId: {
          memberId,
          announcementId: id,
        },
      },
      update: {},
      create: {
        memberId,
        announcementId: id,
      },
    });

    res.json({ id, isRead: true });
  } catch (error) {
    console.error('[POST /api/member/help/announcements/:id/dismiss]', error);
    res.status(500).json({ error: 'Failed to dismiss announcement' });
  }
});

// GET /api/member/help/tutorials?search=&category=
router.get('/tutorials', requireAuth, async (req, res) => {
  try {
    const { search, category } = req.query;

    const where = {};
    if (category && TUTORIAL_CATEGORIES.includes(category)) {
      where.category = category;
    }

    if (search && search.trim()) {
      const term = search.trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    const tutorials = await prisma.tutorial.findMany({
      where,
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
    });

    res.json(tutorials);
  } catch (error) {
    console.error('[GET /api/member/help/tutorials]', error);
    res.status(500).json({ error: 'Failed to load tutorials' });
  }
});

export default router;
