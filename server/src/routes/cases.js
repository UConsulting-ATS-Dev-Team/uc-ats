import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Case files live OUTSIDE the statically-served `uploads/` directory so they are
// only reachable through the authorized proxy endpoints below (interviewer-only
// pages must never be publicly fetchable).
const STORAGE_DIR = path.join(__dirname, '../../storage');

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10000;

const IMAGE_EXT_FOR_MIME = {
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

const CONTENT_TYPE_FOR_EXT = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// Keep files in memory so we can name them by the DB-generated caseId/pageNumber.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — large decks
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('File must be a PDF'));
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per rendered page
  fileFilter(req, file, cb) {
    if (IMAGE_EXT_FOR_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('Page image must be WebP, PNG, or JPEG'));
  },
});

function caseDir(caseId) {
  return path.join(STORAGE_DIR, 'cases', caseId);
}

async function ensureDir(dir) {
  await fsPromises.mkdir(dir, { recursive: true });
}

// A MEMBER may read a case only if they are assigned (InterviewAssignment) to an
// interview that has this case assigned. Admins may read any case.
async function authorizeCaseRead(caseId, user) {
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'MEMBER') return false;
  const link = await prisma.caseAssignment.findFirst({
    where: {
      caseId,
      interview: { assignments: { some: { userId: user.id } } },
    },
    select: { id: true },
  });
  return Boolean(link);
}

// Resolve the applicationIds belonging to a final-round interview from the JSON
// config stored on Interview.description (applicationGroups), matching member.js.
function applicationIdsForInterview(interview) {
  let config = {};
  try {
    config =
      typeof interview.description === 'string'
        ? JSON.parse(interview.description)
        : interview.description || {};
  } catch (e) {
    config = {};
  }
  const ids = new Set();
  config.applicationGroups?.forEach((group) => {
    group.applicationIds?.forEach((appId) => ids.add(appId));
  });
  return Array.from(ids);
}

async function isLeadOrAdmin(interviewId, user) {
  if (user.role === 'ADMIN') return true;
  const lead = await prisma.interviewAssignment.findFirst({
    where: { interviewId, userId: user.id, role: 'LEAD_INTERVIEWER' },
    select: { id: true },
  });
  return Boolean(lead);
}

router.use(requireAuth);

/* -------------------------------------------------------------------------- */
/* Case library (admin)                                                       */
/* -------------------------------------------------------------------------- */

// List all cases with page + assignment counts.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const cases = await prisma.case.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { fullName: true, profileImage: true } },
        cycle: { select: { name: true } },
        _count: { select: { pages: true, assignments: true } },
      },
    });
    res.json(
      cases.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        status: c.status,
        cycleId: c.cycleId,
        cycleName: c.cycle?.name || null,
        pageCount: c.pageCount,
        pagesUploaded: c._count.pages,
        assignedCount: c._count.assignments,
        createdBy: c.creator?.fullName || null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }))
    );
  } catch (error) {
    console.error('[GET /api/cases]', error);
    res.status(500).json({ error: 'Failed to list cases' });
  }
});

// Active cases for assignment/override pickers (admins + interviewers).
router.get('/active', requireAdminOrMember, async (req, res) => {
  try {
    const cases = await prisma.case.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { title: 'asc' },
      select: { id: true, title: true, pageCount: true },
    });
    res.json(cases);
  } catch (error) {
    console.error('[GET /api/cases/active]', error);
    res.status(500).json({ error: 'Failed to list active cases' });
  }
});

// Create a case; optionally store the original PDF.
router.post('/', requireAdmin, pdfUpload.single('pdf'), async (req, res) => {
  try {
    const { title, description, cycleId } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (title.length > MAX_TITLE) {
      return res.status(400).json({ error: 'Title is too long' });
    }
    if (description && description.length > MAX_DESCRIPTION) {
      return res.status(400).json({ error: 'Description is too long' });
    }

    const created = await prisma.case.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        cycleId: cycleId || null,
        createdBy: req.user.id,
        status: 'DRAFT',
      },
    });

    if (req.file) {
      const dir = caseDir(created.id);
      await ensureDir(dir);
      await fsPromises.writeFile(path.join(dir, 'original.pdf'), req.file.buffer);
      await prisma.case.update({
        where: { id: created.id },
        data: { pdfStoragePath: `cases/${created.id}/original.pdf` },
      });
    }

    res.status(201).json({ id: created.id, title: created.title, status: created.status });
  } catch (error) {
    console.error('[POST /api/cases]', error);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

// Case detail with ordered pages (admins, or assigned interviewers).
router.get('/:id', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = await authorizeCaseRead(id, req.user);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const found = await prisma.case.findUnique({
      where: { id },
      include: {
        pages: { orderBy: { pageNumber: 'asc' } },
        cycle: { select: { name: true } },
      },
    });
    if (!found) return res.status(404).json({ error: 'Case not found' });

    res.json({
      id: found.id,
      title: found.title,
      description: found.description,
      status: found.status,
      cycleId: found.cycleId,
      cycleName: found.cycle?.name || null,
      pageCount: found.pageCount,
      hasPdf: Boolean(found.pdfStoragePath),
      pages: found.pages.map((p) => ({
        id: p.id,
        pageNumber: p.pageNumber,
        pageType: p.pageType,
        exhibitLabel: p.exhibitLabel,
        width: p.width,
        height: p.height,
      })),
    });
  } catch (error) {
    console.error('[GET /api/cases/:id]', error);
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

// Update case metadata (title/description/status). Status ACTIVE/ARCHIVED etc.
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, status } = req.body;
    const data = {};
    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ error: 'Title cannot be empty' });
      if (title.length > MAX_TITLE) return res.status(400).json({ error: 'Title is too long' });
      data.title = title.trim();
    }
    if (description !== undefined) {
      if (description && description.length > MAX_DESCRIPTION) {
        return res.status(400).json({ error: 'Description is too long' });
      }
      data.description = description?.trim() || null;
    }
    if (status !== undefined) {
      if (!['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      data.status = status;
    }
    const updated = await prisma.case.update({ where: { id }, data });
    res.json({ id: updated.id, title: updated.title, status: updated.status });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Case not found' });
    console.error('[PATCH /api/cases/:id]', error);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

/* -------------------------------------------------------------------------- */
/* Pages: upload (per-page, retryable), tag, serve image                      */
/* -------------------------------------------------------------------------- */

// Upsert a single rendered page image by pageNumber. Idempotent so the client
// can retry a failed page without redoing the whole deck.
router.post('/:id/pages', requireAdmin, imageUpload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const pageNumber = parseInt(req.body.pageNumber, 10);
    const width = req.body.width ? parseInt(req.body.width, 10) : null;
    const height = req.body.height ? parseInt(req.body.height, 10) : null;

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: 'Valid pageNumber is required' });
    }
    if (!req.file) return res.status(400).json({ error: 'Page image is required' });

    const existingCase = await prisma.case.findUnique({ where: { id }, select: { id: true } });
    if (!existingCase) return res.status(404).json({ error: 'Case not found' });

    const ext = IMAGE_EXT_FOR_MIME[req.file.mimetype] || '.webp';
    const relPath = `cases/${id}/page-${pageNumber}${ext}`;
    const dir = caseDir(id);
    await ensureDir(dir);
    await fsPromises.writeFile(path.join(STORAGE_DIR, relPath), req.file.buffer);

    const page = await prisma.casePage.upsert({
      where: { caseId_pageNumber: { caseId: id, pageNumber } },
      create: {
        caseId: id,
        pageNumber,
        imageStoragePath: relPath,
        width,
        height,
      },
      update: {
        imageStoragePath: relPath,
        width,
        height,
      },
    });

    // Keep pageCount in sync with the number of uploaded pages.
    const count = await prisma.casePage.count({ where: { caseId: id } });
    await prisma.case.update({ where: { id }, data: { pageCount: count } });

    res.status(201).json({
      id: page.id,
      pageNumber: page.pageNumber,
      pageType: page.pageType,
      exhibitLabel: page.exhibitLabel,
    });
  } catch (error) {
    console.error('[POST /api/cases/:id/pages]', error);
    res.status(500).json({ error: 'Failed to upload page' });
  }
});

// Tag a page: set pageType (NORMAL/EXHIBIT/INTERVIEWER_ONLY) and exhibitLabel.
router.patch('/:id/pages/:pageId', requireAdmin, async (req, res) => {
  try {
    const { id, pageId } = req.params;
    const { pageType, exhibitLabel } = req.body;
    const data = {};
    if (pageType !== undefined) {
      if (!['NORMAL', 'EXHIBIT', 'INTERVIEWER_ONLY'].includes(pageType)) {
        return res.status(400).json({ error: 'Invalid pageType' });
      }
      data.pageType = pageType;
      // Clear the exhibit label if the page is no longer an exhibit.
      if (pageType !== 'EXHIBIT' && exhibitLabel === undefined) data.exhibitLabel = null;
    }
    if (exhibitLabel !== undefined) {
      data.exhibitLabel = exhibitLabel ? String(exhibitLabel).slice(0, 100) : null;
    }

    const page = await prisma.casePage.findFirst({ where: { id: pageId, caseId: id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const updated = await prisma.casePage.update({ where: { id: pageId }, data });
    res.json({
      id: updated.id,
      pageNumber: updated.pageNumber,
      pageType: updated.pageType,
      exhibitLabel: updated.exhibitLabel,
    });
  } catch (error) {
    console.error('[PATCH /api/cases/:id/pages/:pageId]', error);
    res.status(500).json({ error: 'Failed to update page' });
  }
});

// Delete a page and close the gap in page numbering. Numbering is updated with a
// single SQL decrement (O(1) queries regardless of deck size) — image files are
// NOT renamed (imageStoragePath is opaque and stays valid), so this stays fast
// even on 100+ page decks.
router.delete('/:id/pages/:pageId', requireAdmin, async (req, res) => {
  try {
    const { id, pageId } = req.params;
    const page = await prisma.casePage.findFirst({ where: { id: pageId, caseId: id } });
    if (!page) return res.status(404).json({ error: 'Page not found' });

    await fsPromises.unlink(path.join(STORAGE_DIR, page.imageStoragePath)).catch(() => {});
    await prisma.casePage.delete({ where: { id: pageId } });

    // Shift every later page down by one to keep numbering gap-free.
    await prisma.$executeRaw`
      UPDATE "case_pages"
      SET "pageNumber" = "pageNumber" - 1
      WHERE "caseId" = ${id} AND "pageNumber" > ${page.pageNumber}`;

    const count = await prisma.casePage.count({ where: { caseId: id } });
    await prisma.case.update({ where: { id }, data: { pageCount: count } });

    res.json({ ok: true, pageCount: count });
  } catch (error) {
    console.error('[DELETE /api/cases/:id/pages/:pageId]', error);
    res.status(500).json({ error: 'Failed to delete page' });
  }
});

// Stream a page image through the authorized proxy. This is the ONLY way case
// page images are served — never statically. Interviewers must be assigned.
router.get('/:id/pages/:pageId/image', async (req, res) => {
  try {
    const { id, pageId } = req.params;
    const allowed = await authorizeCaseRead(id, req.user);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const page = await prisma.casePage.findFirst({
      where: { id: pageId, caseId: id },
      select: { imageStoragePath: true },
    });
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const absPath = path.join(STORAGE_DIR, page.imageStoragePath);
    // Guard against path escaping the storage root (defensive; path is DB-sourced).
    if (!absPath.startsWith(path.join(STORAGE_DIR, 'cases'))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Image not found' });

    const ext = path.extname(absPath).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPE_FOR_EXT[ext] || 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    fs.createReadStream(absPath).pipe(res);
  } catch (error) {
    console.error('[GET /api/cases/:id/pages/:pageId/image]', error);
    res.status(500).json({ error: 'Failed to serve page image' });
  }
});

// Replace the original PDF: clear existing pages (rows + files) so the client
// re-renders and re-uploads from scratch.
router.post('/:id/replace-pdf', requireAdmin, pdfUpload.single('pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'PDF is required' });
    const existingCase = await prisma.case.findUnique({ where: { id }, select: { id: true } });
    if (!existingCase) return res.status(404).json({ error: 'Case not found' });

    await prisma.casePage.deleteMany({ where: { caseId: id } });
    const dir = caseDir(id);
    await ensureDir(dir);
    // Remove old page image files, keep the directory.
    const entries = await fsPromises.readdir(dir).catch(() => []);
    await Promise.all(
      entries
        .filter((f) => f.startsWith('page-'))
        .map((f) => fsPromises.unlink(path.join(dir, f)).catch(() => {}))
    );
    await fsPromises.writeFile(path.join(dir, 'original.pdf'), req.file.buffer);
    await prisma.case.update({
      where: { id },
      data: { pdfStoragePath: `cases/${id}/original.pdf`, pageCount: 0 },
    });

    res.json({ id, pageCount: 0 });
  } catch (error) {
    console.error('[POST /api/cases/:id/replace-pdf]', error);
    res.status(500).json({ error: 'Failed to replace PDF' });
  }
});

/* -------------------------------------------------------------------------- */
/* Assignments + override (Phase 3)                                           */
/* -------------------------------------------------------------------------- */

// Whether the caller may assign/override cases on this interview (lead or admin).
router.get('/interviews/:interviewId/permissions', requireAdminOrMember, async (req, res) => {
  try {
    const canManage = await isLeadOrAdmin(req.params.interviewId, req.user);
    res.json({ canManage });
  } catch (error) {
    console.error('[GET /api/cases/interviews/:interviewId/permissions]', error);
    res.status(500).json({ error: 'Failed to check permissions' });
  }
});

// For a final-round interview, list each candidate (application) with its case
// assignment or null (so the UI can flag unassigned candidates).
router.get('/assignments/for-interview', requireAdminOrMember, async (req, res) => {
  try {
    const { interviewId } = req.query;
    if (!interviewId) return res.status(400).json({ error: 'interviewId is required' });

    const interview = await prisma.interview.findUnique({ where: { id: interviewId } });
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    const appIds = applicationIdsForInterview(interview);
    if (appIds.length === 0) return res.json([]);

    const [applications, assignments] = await Promise.all([
      prisma.application.findMany({
        where: { id: { in: appIds } },
        select: { id: true, firstName: true, lastName: true, major1: true, graduationYear: true },
      }),
      prisma.caseAssignment.findMany({
        where: { interviewId },
        include: { case: { select: { id: true, title: true, status: true } } },
      }),
    ]);

    const byApp = new Map(assignments.map((a) => [a.applicationId, a]));
    const result = applications.map((app) => {
      const a = byApp.get(app.id);
      return {
        applicationId: app.id,
        name: `${app.firstName} ${app.lastName}`,
        major: app.major1,
        year: app.graduationYear,
        assignment: a
          ? {
              id: a.id,
              caseId: a.caseId,
              caseTitle: a.case?.title || null,
              caseStatus: a.case?.status || null,
              overriddenBy: a.overriddenBy,
              overriddenAt: a.overriddenAt,
            }
          : null,
      };
    });
    res.json(result);
  } catch (error) {
    console.error('[GET /api/cases/assignments/for-interview]', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Admin: assign (or reassign) a case to a candidate's final round.
router.post('/assignments', requireAdmin, async (req, res) => {
  try {
    const { interviewId, applicationId, caseId } = req.body;
    if (!interviewId || !applicationId || !caseId) {
      return res.status(400).json({ error: 'interviewId, applicationId and caseId are required' });
    }
    const caseExists = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!caseExists) return res.status(404).json({ error: 'Case not found' });

    const assignment = await prisma.caseAssignment.upsert({
      where: { interviewId_applicationId: { interviewId, applicationId } },
      create: { interviewId, applicationId, caseId, assignedBy: req.user.id },
      update: { caseId, assignedBy: req.user.id, overriddenBy: null, overriddenAt: null },
      include: { case: { select: { id: true, title: true } } },
    });
    res.json({
      id: assignment.id,
      applicationId: assignment.applicationId,
      caseId: assignment.caseId,
      caseTitle: assignment.case?.title || null,
    });
  } catch (error) {
    console.error('[POST /api/cases/assignments]', error);
    res.status(500).json({ error: 'Failed to assign case' });
  }
});

// Interviewer (lead) or admin: override the assigned case mid-interview. Records
// who overrode and when. Never touches notes/rubric (separate table).
router.patch('/assignments/:id/override', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;
    const { caseId } = req.body;
    if (!caseId) return res.status(400).json({ error: 'caseId is required' });

    const existing = await prisma.caseAssignment.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Assignment not found' });

    const permitted = await isLeadOrAdmin(existing.interviewId, req.user);
    if (!permitted) {
      return res.status(403).json({ error: 'Only the lead interviewer can override the case' });
    }
    const caseExists = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!caseExists) return res.status(404).json({ error: 'Case not found' });

    const updated = await prisma.caseAssignment.update({
      where: { id },
      data: { caseId, overriddenBy: req.user.id, overriddenAt: new Date() },
      include: { case: { select: { id: true, title: true } } },
    });
    res.json({
      id: updated.id,
      applicationId: updated.applicationId,
      caseId: updated.caseId,
      caseTitle: updated.case?.title || null,
      overriddenBy: updated.overriddenBy,
      overriddenAt: updated.overriddenAt,
    });
  } catch (error) {
    console.error('[PATCH /api/cases/assignments/:id/override]', error);
    res.status(500).json({ error: 'Failed to override case' });
  }
});

// Create an assignment record from the interviewer side when none exists yet
// (inline picker), so a lead can pick a case without an admin pre-assignment.
router.post('/assignments/self', requireAdminOrMember, async (req, res) => {
  try {
    const { interviewId, applicationId, caseId } = req.body;
    if (!interviewId || !applicationId || !caseId) {
      return res.status(400).json({ error: 'interviewId, applicationId and caseId are required' });
    }
    const permitted = await isLeadOrAdmin(interviewId, req.user);
    if (!permitted) {
      return res.status(403).json({ error: 'Only the lead interviewer can assign the case' });
    }
    const caseExists = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!caseExists) return res.status(404).json({ error: 'Case not found' });

    const assignment = await prisma.caseAssignment.upsert({
      where: { interviewId_applicationId: { interviewId, applicationId } },
      create: { interviewId, applicationId, caseId, assignedBy: req.user.id },
      update: { caseId, overriddenBy: req.user.id, overriddenAt: new Date() },
      include: { case: { select: { id: true, title: true } } },
    });
    res.json({
      id: assignment.id,
      applicationId: assignment.applicationId,
      caseId: assignment.caseId,
      caseTitle: assignment.case?.title || null,
    });
  } catch (error) {
    console.error('[POST /api/cases/assignments/self]', error);
    res.status(500).json({ error: 'Failed to assign case' });
  }
});

export default router;
