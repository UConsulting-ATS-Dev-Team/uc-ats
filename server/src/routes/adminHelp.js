import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

const TUTORIAL_CATEGORIES = [
  'DOCUMENT_GRADING',
  'INTERVIEW_CONDUCT',
  'GTKUC',
  'ATS_NAVIGATION',
  'NEW_FEATURES',
];

// Announcements admin ---------------------------------------------------------

// GET /api/admin/help/announcements
router.get('/announcements', requireAuth, requireAdmin, async (req, res) => {
  try {
    const announcements = await prisma.helpAnnouncement.findMany({
      orderBy: { publishedAt: 'desc' },
      include: {
        cycle: { select: { id: true, name: true } },
        _count: {
          select: { reads: true },
        },
      },
    });

    res.json(announcements);
  } catch (error) {
    console.error('[GET /api/admin/help/announcements]', error);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

// POST /api/admin/help/announcements
router.post('/announcements', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, body, publishedAt, cycleId } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const data = {
      title: title.trim(),
      body: typeof body === 'string' ? body : '',
      cycleId: cycleId || null,
      publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
    };

    const announcement = await prisma.helpAnnouncement.create({ data });
    res.status(201).json(announcement);
  } catch (error) {
    console.error('[POST /api/admin/help/announcements]', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// PUT /api/admin/help/announcements/:id
router.put('/announcements/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, publishedAt, cycleId } = req.body;

    const existing = await prisma.helpAnnouncement.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    const data = {};
    if (title !== undefined) data.title = title.trim();
    if (body !== undefined) data.body = body;
    if (publishedAt !== undefined) data.publishedAt = new Date(publishedAt);
    if (cycleId !== undefined) data.cycleId = cycleId || null;

    const announcement = await prisma.helpAnnouncement.update({
      where: { id },
      data,
    });

    res.json(announcement);
  } catch (error) {
    console.error('[PUT /api/admin/help/announcements/:id]', error);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

// DELETE /api/admin/help/announcements/:id
router.delete('/announcements/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.helpAnnouncement.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    await prisma.helpAnnouncement.delete({ where: { id } });
    res.json({ message: 'Announcement deleted' });
  } catch (error) {
    console.error('[DELETE /api/admin/help/announcements/:id]', error);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// Tutorials admin -------------------------------------------------------------

// GET /api/admin/help/tutorials
router.get('/tutorials', requireAuth, requireAdmin, async (req, res) => {
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
    console.error('[GET /api/admin/help/tutorials]', error);
    res.status(500).json({ error: 'Failed to load tutorials' });
  }
});

// POST /api/admin/help/tutorials
router.post('/tutorials', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, category, videoUrl, body, order } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    if (!category || !TUTORIAL_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Valid category is required' });
    }

    const data = {
      title: title.trim(),
      description: description || null,
      category,
      videoUrl: videoUrl || null,
      body: body || null,
      order: order === undefined || order === null ? 0 : parseInt(order, 10) || 0,
    };

    const tutorial = await prisma.tutorial.create({ data });
    res.status(201).json(tutorial);
  } catch (error) {
    console.error('[POST /api/admin/help/tutorials]', error);
    res.status(500).json({ error: 'Failed to create tutorial' });
  }
});

// PUT /api/admin/help/tutorials/:id
router.put('/tutorials/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, category, videoUrl, body, order } = req.body;

    const existing = await prisma.tutorial.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Tutorial not found' });
    }

    if (category !== undefined && !TUTORIAL_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const data = {};
    if (title !== undefined) data.title = title.trim();
    if (description !== undefined) data.description = description || null;
    if (category !== undefined) data.category = category;
    if (videoUrl !== undefined) data.videoUrl = videoUrl || null;
    if (body !== undefined) data.body = body || null;
    if (order !== undefined && order !== null) data.order = parseInt(order, 10) || 0;

    const tutorial = await prisma.tutorial.update({
      where: { id },
      data,
    });

    res.json(tutorial);
  } catch (error) {
    console.error('[PUT /api/admin/help/tutorials/:id]', error);
    res.status(500).json({ error: 'Failed to update tutorial' });
  }
});

// DELETE /api/admin/help/tutorials/:id
router.delete('/tutorials/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.tutorial.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Tutorial not found' });
    }

    await prisma.tutorial.delete({ where: { id } });
    res.json({ message: 'Tutorial deleted' });
  } catch (error) {
    console.error('[DELETE /api/admin/help/tutorials/:id]', error);
    res.status(500).json({ error: 'Failed to delete tutorial' });
  }
});

export default router;
