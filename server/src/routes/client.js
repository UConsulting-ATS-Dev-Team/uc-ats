// The Talent Partner Network portal: everything a CLIENT account can reach.
//
// Three routes, all read-only. The containment middleware already 403s a CLIENT
// anywhere else; requireClient here is the actual gate, and it loads the partner
// row onto req.partnerClient.
//
// The security shape of this file: a client addresses resumes only by
// assignment id, and every lookup is scoped to their own clientId. A wrong or
// revoked id answers 404 rather than 403 so ids are not enumerable - a 403
// would confirm the id exists.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from '../prismaClient.js';
import { requireAuth, requireClient } from '../middleware/auth.js';
import { getFileStream } from '../services/google/drive.js';
import {
  projectAssignment,
  resolveResumeSource,
  searchableFields
} from '../utils/clientVisibility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same root cases.js uses, and deliberately not the statically-served uploads/
// directory - see the comment in routes/cases.js.
const STORAGE_DIR = path.join(__dirname, '../../storage');
const MEMBER_RESUME_ROOT = path.join(STORAGE_DIR, 'member-resumes');

const router = express.Router();

router.use(requireAuth, requireClient);

const MAX_PAGE = 100;

// Included fields are the superset the projection may read. The projection, not
// this select, decides what actually reaches the client.
const ASSIGNMENT_INCLUDE = {
  application: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneNumber: true,
      graduationYear: true,
      major1: true,
      major2: true,
      gender: true,
      cumulativeGpa: true,
      majorGpa: true,
      resumeUrl: true,
      blindResumeUrl: true
    }
  },
  memberResume: {
    select: {
      id: true,
      storagePath: true,
      graduationYear: true,
      major1: true,
      major2: true,
      gender: true,
      member: { select: { fullName: true, email: true } }
    }
  }
};

/**
 * Search only across fields the client's visibility already exposes. Under
 * BLIND that excludes names - otherwise the result count answers "is this
 * person in my set?", which is deanonymization by another route.
 */
const buildSearchWhere = (q, visibility) => {
  const fields = searchableFields(visibility);
  const or = [];
  let memberNameAdded = false;

  for (const field of fields) {
    if (field === 'firstName' || field === 'lastName') {
      or.push({ application: { [field]: { contains: q, mode: 'insensitive' } } });
      if (!memberNameAdded) {
        or.push({ memberResume: { member: { fullName: { contains: q, mode: 'insensitive' } } } });
        memberNameAdded = true;
      }
      continue;
    }
    or.push({ application: { [field]: { contains: q, mode: 'insensitive' } } });
    or.push({ memberResume: { [field]: { contains: q, mode: 'insensitive' } } });
  }

  return { OR: or };
};

router.get('/me', async (req, res) => {
  try {
    const resumeCount = await prisma.clientResumeAssignment.count({
      where: { clientId: req.partnerClient.id, revokedAt: null }
    });

    res.json({
      organization: req.partnerClient.organization,
      visibility: req.partnerClient.visibility,
      resumeCount
    });
  } catch (error) {
    console.error('[GET /api/client/me]', error);
    res.status(500).json({ error: 'Failed to load your account' });
  }
});

router.get('/resumes', async (req, res) => {
  try {
    const { id: clientId, visibility } = req.partnerClient;

    const limit = Math.min(parseInt(req.query.limit, 10) || 25, MAX_PAGE);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const where = { clientId, revokedAt: null };
    if (q) {
      where.AND = [buildSearchWhere(q, visibility)];
    }

    const [total, assignments] = await Promise.all([
      prisma.clientResumeAssignment.count({ where }),
      prisma.clientResumeAssignment.findMany({
        where,
        include: ASSIGNMENT_INCLUDE,
        orderBy: { assignedAt: 'desc' },
        take: limit,
        skip: offset
      })
    ]);

    res.json({
      items: assignments.map((a) => projectAssignment(a, visibility)),
      total,
      limit,
      offset
    });
  } catch (error) {
    console.error('[GET /api/client/resumes]', error);
    res.status(500).json({ error: 'Failed to load your resume library' });
  }
});

router.get('/resumes/:assignmentId/pdf', async (req, res) => {
  const { assignmentId } = req.params;
  const { id: clientId, visibility } = req.partnerClient;

  // Every view is recorded, including the ones that are refused - a denied
  // attempt is the more interesting half of the record.
  const logView = async () => {
    try {
      await prisma.clientResumeAccessLog.create({
        data: {
          clientId,
          userId: req.user.id,
          assignmentId: assignmentId || null,
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent']?.slice(0, 500) || null
        }
      });
    } catch (error) {
      // A logging failure must not decide whether a client can read a resume
      // they were legitimately assigned.
      console.error('[client access log]', error);
    }
  };

  try {
    const assignment = await prisma.clientResumeAssignment.findFirst({
      where: { id: assignmentId, clientId, revokedAt: null },
      include: ASSIGNMENT_INCLUDE
    });

    if (!assignment) {
      // 404 rather than 403: a 403 would confirm the id exists.
      await prisma.clientResumeAccessLog
        .create({
          data: {
            clientId,
            userId: req.user.id,
            assignmentId: null,
            ipAddress: req.ip || null,
            userAgent: req.headers['user-agent']?.slice(0, 500) || null
          }
        })
        .catch((error) => console.error('[client access log]', error));
      return res.status(404).json({ error: 'Resume not found' });
    }

    const source = resolveResumeSource(assignment, visibility);
    await logView();

    if (!source) {
      // BLIND with no redacted resume on file, or a member resume for a BLIND
      // client. Never fall back to the unredacted file.
      return res.status(404).json({ error: 'This resume is not available.' });
    }

    // No filename in the disposition - it would carry the applicant's name
    // straight past a BLIND projection.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (source.kind === 'drive') {
      const stream = await getFileStream(source.fileId);
      return stream.pipe(res);
    }

    const absPath = path.join(STORAGE_DIR, source.storagePath);
    if (!absPath.startsWith(MEMBER_RESUME_ROOT)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'This resume is not available.' });
    }
    return fs.createReadStream(absPath).pipe(res);
  } catch (error) {
    console.error('[GET /api/client/resumes/:assignmentId/pdf]', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to load resume' });
    }
  }
});

export default router;
