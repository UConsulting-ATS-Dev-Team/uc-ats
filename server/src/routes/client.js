// The Talent Partner Network portal: everything a CLIENT account can reach.
//
// Five routes, four read-only and one that renders a CSV. The containment
// middleware already 403s a CLIENT anywhere else; requireClient here is the
// actual gate, and it loads the partner row onto req.partnerClient.
//
// The security shape of this file: a client addresses resumes only by
// assignment id, and every lookup is scoped to their own clientId. A wrong or
// revoked id answers 404 rather than 403 so ids are not enumerable - a 403
// would confirm the id exists.
//
// Every response body is built by projectAssignment(), never by a hand-written
// select. That is what keeps the filter, facet, table and CSV paths from
// drifting apart: four features, one projection, one place a field can leak.
import express from 'express';
import prisma from '../prismaClient.js';
import { getResume } from '../services/resumeStorage.js';
import { requireAuth, requireClient } from '../middleware/auth.js';
import { getFileStream } from '../services/google/drive.js';
import {
  projectAssignment,
  resolveResumeSource
} from '../utils/clientVisibility.js';
import {
  MAX_EXPORT,
  MAX_MATERIALIZED,
  buildAssignmentFilters,
  buildFacets,
  buildSearchClause,
  csvFilename,
  filterableFields,
  sanitizeClientQuery,
  sortRows,
  sortableFields,
  toCsv
} from '../utils/clientResumeQuery.js';

// The two directories an uploaded resume can legitimately live in. A resolved
// path must sit under one of them: `storagePath` comes out of the database, and
// this is the check that keeps a malformed or tampered value from reading its
// way out of the storage tree.
const UPLOADED_RESUME_PREFIXES = ['member-resumes/', 'external-resumes/'];

const router = express.Router();

router.use(requireAuth, requireClient);

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
  },
  externalResume: {
    select: {
      id: true,
      storagePath: true,
      graduationYear: true,
      major1: true,
      major2: true,
      gender: true,
      user: { select: { fullName: true, email: true } }
    }
  }
};

const logAccess = (fields) =>
  prisma.clientResumeAccessLog
    .create({ data: fields })
    // A logging failure must not decide whether a client can read a resume they
    // were legitimately assigned.
    .catch((error) => console.error('[client access log]', error));

const requestContext = (req) => ({
  clientId: req.partnerClient.id,
  userId: req.user.id,
  ipAddress: req.ip || null,
  userAgent: req.headers['user-agent']?.slice(0, 500) || null
});

/**
 * Load and project the client's own assignments matching a sanitized spec.
 *
 * Filtering happens in the database so `total` is exact and cheap; sorting
 * happens in memory over the projected DTOs, because an assignment points at an
 * application OR a member resume and no Prisma orderBy interleaves two nullable
 * to-one relations on the same column. See sortRows() for the full reasoning.
 *
 * MAX_MATERIALIZED bounds that in-memory set. When it bites, `truncated` says
 * so - serving a sorted prefix as though it were the whole library would be the
 * one failure here that looks exactly like success.
 */
const loadProjected = async ({ clientId, visibility, q, filters }) => {
  const { and, notes } = buildAssignmentFilters(filters);
  const where = { clientId, revokedAt: null };
  const AND = [...and];
  if (q) AND.push(buildSearchClause(q, visibility));
  if (AND.length > 0) where.AND = AND;

  const [total, assignments] = await Promise.all([
    prisma.clientResumeAssignment.count({ where }),
    prisma.clientResumeAssignment.findMany({
      where,
      include: ASSIGNMENT_INCLUDE,
      orderBy: { assignedAt: 'desc' },
      take: MAX_MATERIALIZED
    })
  ]);

  const rows = assignments.map((a) => projectAssignment(a, visibility));
  const truncated = total > rows.length;
  if (truncated) {
    notes.push(
      `Showing the ${rows.length} most recently shared resumes of ${total}. Narrow the filters to see the rest.`
    );
  }

  return { rows, total, truncated, notes };
};

router.get('/me', async (req, res) => {
  try {
    const { id: clientId, visibility } = req.partnerClient;

    const resumeCount = await prisma.clientResumeAssignment.count({
      where: { clientId, revokedAt: null }
    });

    res.json({
      organization: req.partnerClient.organization,
      visibility,
      resumeCount,
      // The UI renders columns, filter controls and sort headers from these, so
      // a level that hides a field hides its control too rather than offering
      // one that silently does nothing.
      filterableFields: filterableFields(visibility),
      sortableFields: sortableFields(visibility),
      maxExport: MAX_EXPORT
    });
  } catch (error) {
    console.error('[GET /api/client/me]', error);
    res.status(500).json({ error: 'Failed to load your account' });
  }
});

/**
 * Distinct values for the filter bar, computed over this client's own library
 * so a dropdown never offers a choice that returns nothing.
 *
 * Deliberately unfiltered by the current query: dropdowns that reshuffle as you
 * pick make it impossible to widen a selection you have already narrowed.
 */
router.get('/facets', async (req, res) => {
  try {
    const { id: clientId, visibility } = req.partnerClient;

    const assignments = await prisma.clientResumeAssignment.findMany({
      where: { clientId, revokedAt: null },
      include: ASSIGNMENT_INCLUDE,
      orderBy: { assignedAt: 'desc' },
      take: MAX_MATERIALIZED
    });

    const rows = assignments.map((a) => projectAssignment(a, visibility));
    res.json(buildFacets(rows, visibility));
  } catch (error) {
    console.error('[GET /api/client/facets]', error);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

router.get('/resumes', async (req, res) => {
  try {
    const { id: clientId, visibility } = req.partnerClient;
    const { value, errors } = sanitizeClientQuery(req.query, visibility);

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const { rows, total, truncated, notes } = await loadProjected({
      clientId,
      visibility,
      q: value.q,
      filters: value.filters
    });

    const sorted = sortRows(rows, value.sort);
    const page = sorted.slice(value.offset, value.offset + value.limit);

    res.json({
      items: page,
      total,
      truncated,
      notes,
      limit: value.limit,
      offset: value.offset,
      sort: value.sort,
      filters: value.filters
    });
  } catch (error) {
    console.error('[GET /api/client/resumes]', error);
    res.status(500).json({ error: 'Failed to load your resume library' });
  }
});

/**
 * Export selected rows as CSV.
 *
 * POST rather than GET for two reasons: a selection is a list of ids that does
 * not belong in a URL or a proxy log, and an export is a recorded act, which a
 * cacheable GET is the wrong verb for.
 *
 * The CSV carries exactly the columns projectAssignment() emits at this
 * visibility - no Drive ids, no storage paths, nothing the client could not
 * already read on screen. It is a spreadsheet of the table, not a second, more
 * generous API.
 */
router.post('/resumes/export', async (req, res) => {
  try {
    const { id: clientId, visibility, organization } = req.partnerClient;

    const ids = Array.isArray(req.body?.assignmentIds) ? req.body.assignmentIds : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ error: 'Select at least one resume to export.' });
    }
    if (ids.length > MAX_EXPORT) {
      return res
        .status(400)
        .json({ error: `You can export at most ${MAX_EXPORT} resumes at a time.` });
    }

    const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (wanted.length === 0) {
      return res.status(400).json({ error: 'Select at least one resume to export.' });
    }

    // Scoped to this client's own live assignments, so a borrowed or revoked id
    // contributes no row. Silently dropping rather than 404ing keeps the same
    // non-enumerability property the PDF route has.
    const assignments = await prisma.clientResumeAssignment.findMany({
      where: { id: { in: wanted }, clientId, revokedAt: null },
      include: ASSIGNMENT_INCLUDE
    });

    if (assignments.length === 0) {
      return res.status(404).json({ error: 'None of those resumes are available to export.' });
    }

    const rows = sortRows(
      assignments.map((a) => projectAssignment(a, visibility)),
      { field: 'assignedAt', dir: 'desc' }
    );

    const context = requestContext(req);
    await prisma.clientResumeAccessLog
      .createMany({
        data: rows.map((row) => ({ ...context, assignmentId: row.assignmentId, action: 'EXPORT' }))
      })
      .catch((error) => console.error('[client access log]', error));

    const csv = toCsv(rows, visibility);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${csvFilename(organization)}"`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(csv);
  } catch (error) {
    console.error('[POST /api/client/resumes/export]', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build your export' });
    }
  }
});

router.get('/resumes/:assignmentId/pdf', async (req, res) => {
  const { assignmentId } = req.params;
  const { id: clientId, visibility } = req.partnerClient;
  const context = requestContext(req);

  try {
    const assignment = await prisma.clientResumeAssignment.findFirst({
      where: { id: assignmentId, clientId, revokedAt: null },
      include: ASSIGNMENT_INCLUDE
    });

    if (!assignment) {
      // 404 rather than 403: a 403 would confirm the id exists. The log still
      // records the attempt - a denied one is the more interesting half of the
      // record, which is why it carries its own action.
      await logAccess({ ...context, assignmentId: null, action: 'VIEW_DENIED' });
      return res.status(404).json({ error: 'Resume not found' });
    }

    const source = resolveResumeSource(assignment, visibility);

    if (!source) {
      // BLIND with no redacted resume on file, or a member resume for a BLIND
      // client. Never fall back to the unredacted file.
      await logAccess({ ...context, assignmentId, action: 'VIEW_DENIED' });
      return res.status(404).json({ error: 'This resume is not available.' });
    }

    await logAccess({ ...context, assignmentId, action: 'VIEW' });

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

    // The two prefixes an uploaded resume can legitimately carry. `storagePath`
    // comes out of the database, and this is the check that keeps a malformed or
    // tampered value from reaching for something it should not.
    if (!UPLOADED_RESUME_PREFIXES.some((prefix) => source.storagePath.startsWith(prefix))) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const buffer = await getResume(source.storagePath);
    if (!buffer) {
      return res.status(404).json({ error: 'This resume is not available.' });
    }
    return res.send(buffer);
  } catch (error) {
    console.error('[GET /api/client/resumes/:assignmentId/pdf]', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to load resume' });
    }
  }
});

export default router;
