// Admin side of the Talent Partner Network: client accounts and resume
// assignment. Mounted at /api/admin/talent-pool behind requireAuth +
// requireAdmin (see index.js), following the release-notes precedent rather
// than growing admin.js, which is already 181KB.
//
// The assignment model is a SNAPSHOT. Preview resolves the filter to concrete
// rows; commit takes the explicit keys the admin left checked and never re-runs
// the filter. That is what makes the per-row trim binding, and it is why a
// filter that would match more tomorrow does not quietly widen what a client
// can see.
import express from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../prismaClient.js';
import { invalidateUserCache } from '../middleware/auth.js';
import {
  FILTER_FIELDS,
  APPLICATION_STATUSES,
  PREVIEW_CAP,
  NOT_OPTED_OUT,
  sanitizeFilterDsl,
  buildApplicantWhere,
  buildMemberResumeWhere,
  buildExternalResumeWhere,
  buildAssignmentKey,
  parseAssignmentKey
} from '../utils/talentPoolFilters.js';
import { VISIBILITY_LEVELS } from '../utils/clientVisibility.js';

const router = express.Router();

const CLIENT_SELECT = {
  id: true,
  organization: true,
  visibility: true,
  notes: true,
  createdAt: true,
  user: { select: { id: true, email: true, fullName: true, isActive: true } }
};

const activeCycleId = async () => {
  const cycle = await prisma.recruitingCycle.findFirst({
    where: { isActive: true },
    select: { id: true }
  });
  return cycle?.id ?? null;
};

// ---------------------------------------------------------------------------
// Client accounts
// ---------------------------------------------------------------------------

router.get('/clients', async (req, res) => {
  try {
    const clients = await prisma.talentPartnerClient.findMany({
      select: {
        ...CLIENT_SELECT,
        _count: { select: { assignments: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const liveCounts = await prisma.clientResumeAssignment.groupBy({
      by: ['clientId'],
      where: { revokedAt: null },
      _count: { _all: true }
    });
    const liveByClient = new Map(liveCounts.map((r) => [r.clientId, r._count._all]));

    res.json(
      clients.map(({ _count, ...client }) => ({
        ...client,
        assignmentCount: liveByClient.get(client.id) ?? 0
      }))
    );
  } catch (error) {
    console.error('[GET /api/admin/talent-pool/clients]', error);
    res.status(500).json({ error: 'Failed to load partner clients' });
  }
});

router.post('/clients', async (req, res) => {
  try {
    const { email, password, fullName, organization, visibility, notes } = req.body || {};

    if (!email || !password || !fullName || !organization) {
      return res
        .status(400)
        .json({ error: 'Email, password, contact name, and organization are required' });
    }
    if (String(password).length < 12) {
      // These credentials are handed to an outside organization and there is no
      // self-service reset, so a weak one tends to stay weak.
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }
    if (visibility && !VISIBILITY_LEVELS.includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility level' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const client = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, password: hashedPassword, fullName, role: 'CLIENT' }
      });
      return tx.talentPartnerClient.create({
        data: {
          userId: user.id,
          organization,
          visibility: visibility || 'BLIND',
          notes: notes || null,
          createdById: req.user.id
        },
        select: CLIENT_SELECT
      });
    });

    // Never echo the password back - the admin already has it.
    res.status(201).json({ client });
  } catch (error) {
    console.error('[POST /api/admin/talent-pool/clients]', error);
    res.status(500).json({ error: 'Failed to create partner client' });
  }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const client = await prisma.talentPartnerClient.findUnique({
      where: { id: req.params.id },
      select: CLIENT_SELECT
    });
    if (!client) return res.status(404).json({ error: 'Partner client not found' });

    const assignments = await prisma.clientResumeAssignment.findMany({
      where: { clientId: client.id, revokedAt: null },
      orderBy: { assignedAt: 'desc' },
      take: 1000,
      include: {
        application: {
          select: { id: true, firstName: true, lastName: true, graduationYear: true, major1: true }
        },
        memberResume: {
          select: {
            id: true,
            graduationYear: true,
            major1: true,
            shareConsent: true,
            consentRevokedAt: true,
            member: { select: { fullName: true } }
          }
        },
        externalResume: {
          select: {
            id: true,
            graduationYear: true,
            major1: true,
            shareConsent: true,
            consentRevokedAt: true,
            user: { select: { fullName: true, emailVerifiedAt: true } }
          }
        },
        batch: { select: { id: true, createdAt: true, note: true } }
      }
    });

    res.json({
      client,
      // Real names here - this is the admin console, not the portal.
      assignments: assignments.map((a) => {
        // The two uploaded-resume pools carry the same fields in the same
        // shape; only the relation holding the owner's name differs.
        const uploaded = a.memberResume || a.externalResume;
        const ownerName = a.memberResume?.member?.fullName || a.externalResume?.user?.fullName;

        return {
          id: a.id,
          kind: a.application ? 'APPLICANT' : a.externalResume ? 'EXTERNAL' : 'MEMBER',
          name: a.application
            ? `${a.application.firstName} ${a.application.lastName}`.trim()
            : ownerName || 'Unknown',
          graduationYear: a.application?.graduationYear ?? uploaded?.graduationYear ?? null,
          major1: a.application?.major1 ?? uploaded?.major1 ?? null,
          assignedAt: a.assignedAt,
          batchId: a.batchId,
          // Surfaced so an admin can see someone who withdrew after assignment.
          // Withdrawal auto-revokes, so this should normally be false.
          consentWithdrawn: Boolean(
            uploaded && (!uploaded.shareConsent || uploaded.consentRevokedAt)
          ),
          // An external owner can be deactivated or have their verification
          // cleared after the fact. Neither auto-revokes, so unlike consent this
          // one really can be true on a live row.
          ownerUnverified: Boolean(a.externalResume && !a.externalResume.user?.emailVerifiedAt)
        };
      })
    });
  } catch (error) {
    console.error('[GET /api/admin/talent-pool/clients/:id]', error);
    res.status(500).json({ error: 'Failed to load partner client' });
  }
});

router.patch('/clients/:id', async (req, res) => {
  try {
    const { organization, visibility, notes } = req.body || {};
    if (visibility && !VISIBILITY_LEVELS.includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility level' });
    }

    const existing = await prisma.talentPartnerClient.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Partner client not found' });

    const data = {};
    if (organization !== undefined) data.organization = organization;
    if (visibility !== undefined) data.visibility = visibility;
    if (notes !== undefined) data.notes = notes || null;

    const client = await prisma.talentPartnerClient.update({
      where: { id: req.params.id },
      data,
      select: CLIENT_SELECT
    });

    // Tightening to BLIND can strand live assignments that have no redacted
    // resume. Report the count rather than letting them silently 404 later.
    const warnings = {};
    if (visibility === 'BLIND' && existing.visibility !== 'BLIND') {
      warnings.blindUnavailable = await prisma.clientResumeAssignment.count({
        where: {
          clientId: client.id,
          revokedAt: null,
          OR: [
            // Neither uploaded-resume pool has a redacted variant, so every one
            // of those rows is stranded by a tightening to BLIND.
            { memberResumeId: { not: null } },
            { externalResumeId: { not: null } },
            { application: { OR: [{ blindResumeUrl: null }, { blindResumeUrl: '' }] } }
          ]
        }
      });
    }

    res.json({ client, warnings });
  } catch (error) {
    console.error('[PATCH /api/admin/talent-pool/clients/:id]', error);
    res.status(500).json({ error: 'Failed to update partner client' });
  }
});

router.post('/clients/:id/password', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }

    const client = await prisma.talentPartnerClient.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Partner client not found' });

    await prisma.user.update({
      where: { id: client.userId },
      data: { password: await bcrypt.hash(password, 12), resetToken: null, resetTokenExpiry: null }
    });
    invalidateUserCache(client.userId);

    res.json({ ok: true });
  } catch (error) {
    console.error('[POST /api/admin/talent-pool/clients/:id/password]', error);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// ---------------------------------------------------------------------------
// Filter vocabulary
// ---------------------------------------------------------------------------

// Options come from the data, not a hardcoded list. Application.gender and
// major1 are free text off a Google Form, so a hardcoded "Female" would quietly
// miss "female" and a hardcoded major list would match nothing at all.
router.get('/filter-fields', async (req, res) => {
  try {
    const [genders, years, majors1, majors2, cycles] = await Promise.all([
      prisma.application.findMany({
        distinct: ['gender'],
        select: { gender: true },
        where: { gender: { not: null } }
      }),
      prisma.application.findMany({ distinct: ['graduationYear'], select: { graduationYear: true } }),
      prisma.application.findMany({ distinct: ['major1'], select: { major1: true } }),
      prisma.application.findMany({
        distinct: ['major2'],
        select: { major2: true },
        where: { major2: { not: null } }
      }),
      prisma.recruitingCycle.findMany({
        select: { id: true, name: true, isActive: true },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const uniqueSorted = (values) =>
      [...new Set(values.filter((v) => v && String(v).trim()).map((v) => String(v).trim()))].sort();

    res.json({
      fields: FILTER_FIELDS,
      options: {
        gender: uniqueSorted(genders.map((g) => g.gender)),
        graduationYear: uniqueSorted(years.map((y) => y.graduationYear)),
        major: uniqueSorted([...majors1.map((m) => m.major1), ...majors2.map((m) => m.major2)]),
        status: APPLICATION_STATUSES,
        cycleId: cycles.map((c) => ({ value: c.id, label: c.name, isActive: c.isActive }))
      }
    });
  } catch (error) {
    console.error('[GET /api/admin/talent-pool/filter-fields]', error);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

// ---------------------------------------------------------------------------
// Preview and assign
// ---------------------------------------------------------------------------

router.post('/clients/:id/preview', async (req, res) => {
  try {
    const client = await prisma.talentPartnerClient.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Partner client not found' });

    const { value: dsl, errors } = sanitizeFilterDsl(req.body?.filter);
    // Errors with nothing usable left to run. An empty filter is not this case -
    // it produces no errors and means "the whole pool" (see sanitizeFilterDsl).
    if (errors.length > 0 && dsl.rows.length === 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const cycleId = await activeCycleId();
    const applicant = buildApplicantWhere(dsl, { visibility: client.visibility, activeCycleId: cycleId });
    const member = buildMemberResumeWhere(dsl, { visibility: client.visibility });
    const external = buildExternalResumeWhere(dsl, { visibility: client.visibility });

    const notes = [...errors, ...applicant.notes, ...member.notes, ...external.notes];
    if (dsl.unfiltered) {
      // Said plainly, because an unfiltered preview looks exactly like a
      // filtered one that happened to match a lot.
      notes.unshift(
        'No filters - this is every assignable resume in the pools you selected. Untick anyone you do not mean to share.'
      );
    }
    const excluded = {
      optedOut: 0,
      noBlindResume: 0,
      memberNoConsent: 0,
      externalNotAssignable: 0,
      alreadyAssigned: 0
    };

    const rows = [];
    let total = 0;

    if (applicant.where) {
      // Diagnostics: how many the consent gate and the blind gate each removed.
      // filterOnlyWhere is never used to select rows for assignment.
      const [matched, filterOnly, notOptedOut] = await Promise.all([
        prisma.application.count({ where: applicant.where }),
        prisma.application.count({ where: applicant.filterOnlyWhere }),
        prisma.application.count({
          where: { AND: [...applicant.filterOnlyWhere.AND, NOT_OPTED_OUT] }
        })
      ]);
      // Only an explicit No is an exclusion now. An unanswered opt-in is not
      // counted here because it is not a refusal - it is simply assignable.
      excluded.optedOut = Math.max(filterOnly - notOptedOut, 0);
      excluded.noBlindResume = Math.max(notOptedOut - matched, 0);
      total += matched;

      const applications = await prisma.application.findMany({
        where: applicant.where,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          graduationYear: true,
          major1: true,
          major2: true,
          gender: true,
          cumulativeGpa: true
        },
        orderBy: { submittedAt: 'desc' },
        take: PREVIEW_CAP
      });

      rows.push(
        ...applications.map((a) => ({
          key: buildAssignmentKey('APPLICATION', a.id),
          kind: 'APPLICANT',
          name: `${a.firstName} ${a.lastName}`.trim(),
          graduationYear: a.graduationYear,
          major1: a.major1,
          major2: a.major2,
          gender: a.gender,
          cumulativeGpa: a.cumulativeGpa != null ? String(a.cumulativeGpa) : null
        }))
      );
    }

    if (member.where) {
      const [matched, filterOnly] = await Promise.all([
        prisma.memberResume.count({ where: member.where }),
        prisma.memberResume.count({ where: member.filterOnlyWhere })
      ]);
      excluded.memberNoConsent = Math.max(filterOnly - matched, 0);
      total += matched;

      const memberResumes = await prisma.memberResume.findMany({
        where: member.where,
        select: {
          id: true,
          graduationYear: true,
          major1: true,
          major2: true,
          gender: true,
          member: { select: { fullName: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: PREVIEW_CAP
      });

      rows.push(
        ...memberResumes.map((m) => ({
          key: buildAssignmentKey('MEMBER_RESUME', m.id),
          kind: 'MEMBER',
          name: m.member?.fullName || 'Unknown member',
          graduationYear: m.graduationYear,
          major1: m.major1,
          major2: m.major2,
          gender: m.gender,
          cumulativeGpa: null,
          // The filter asked something this pool cannot answer, so these rows
          // are narrowed by less than the admin specified. The builder starts
          // them unticked - see the unnarrowedBy note in talentPoolFilters.js.
          unnarrowedBy: member.unnarrowedBy ?? []
        }))
      );
    }

    if (external.where) {
      // filterOnlyWhere drops the consent AND verification gates together, so
      // this one diagnostic covers both reasons a student resume is not
      // assignable. They are not worth separating: the admin's next action is
      // the same either way, which is to leave that person alone.
      const [matched, filterOnly] = await Promise.all([
        prisma.externalResume.count({ where: external.where }),
        prisma.externalResume.count({ where: external.filterOnlyWhere })
      ]);
      excluded.externalNotAssignable = Math.max(filterOnly - matched, 0);
      total += matched;

      const externalResumes = await prisma.externalResume.findMany({
        where: external.where,
        select: {
          id: true,
          graduationYear: true,
          major1: true,
          major2: true,
          gender: true,
          user: { select: { fullName: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: PREVIEW_CAP
      });

      rows.push(
        ...externalResumes.map((e) => ({
          key: buildAssignmentKey('EXTERNAL_RESUME', e.id),
          kind: 'EXTERNAL',
          name: e.user?.fullName || 'Unknown student',
          graduationYear: e.graduationYear,
          major1: e.major1,
          major2: e.major2,
          gender: e.gender,
          cumulativeGpa: null,
          unnarrowedBy: external.unnarrowedBy ?? []
        }))
      );
    }

    // Flag rows this client already has so the admin is not re-assigning blind.
    const idsOfKind = (kind) =>
      rows
        .map((r) => parseAssignmentKey(r.key))
        .filter((p) => p?.kind === kind)
        .map((p) => p.id);

    const applicationIds = idsOfKind('APPLICATION');
    const memberResumeIds = idsOfKind('MEMBER_RESUME');
    const externalResumeIds = idsOfKind('EXTERNAL_RESUME');

    const live = await prisma.clientResumeAssignment.findMany({
      where: {
        clientId: client.id,
        revokedAt: null,
        OR: [
          { applicationId: { in: applicationIds } },
          { memberResumeId: { in: memberResumeIds } },
          { externalResumeId: { in: externalResumeIds } }
        ]
      },
      select: { applicationId: true, memberResumeId: true, externalResumeId: true }
    });

    const liveKeys = new Set([
      ...live.filter((l) => l.applicationId).map((l) => buildAssignmentKey('APPLICATION', l.applicationId)),
      ...live.filter((l) => l.memberResumeId).map((l) => buildAssignmentKey('MEMBER_RESUME', l.memberResumeId)),
      ...live
        .filter((l) => l.externalResumeId)
        .map((l) => buildAssignmentKey('EXTERNAL_RESUME', l.externalResumeId))
    ]);

    for (const row of rows) {
      row.alreadyAssigned = liveKeys.has(row.key);
      if (row.alreadyAssigned) excluded.alreadyAssigned += 1;
    }

    res.json({
      rows: rows.slice(0, PREVIEW_CAP),
      total,
      truncated: total > rows.length,
      cap: PREVIEW_CAP,
      excluded,
      notes,
      visibility: client.visibility
    });
  } catch (error) {
    console.error('[POST /api/admin/talent-pool/clients/:id/preview]', error);
    res.status(500).json({ error: 'Failed to preview matches' });
  }
});

router.post('/clients/:id/assign', async (req, res) => {
  try {
    const client = await prisma.talentPartnerClient.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Partner client not found' });

    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    if (keys.length === 0) {
      return res.status(400).json({ error: 'Select at least one resume to assign' });
    }
    if (keys.length > PREVIEW_CAP) {
      return res.status(400).json({ error: `Assign at most ${PREVIEW_CAP} resumes at a time` });
    }

    const parsed = [];
    const skipped = [];
    const seen = new Set();

    for (const key of keys) {
      const p = parseAssignmentKey(key);
      if (!p) {
        skipped.push({ key, reason: 'Unrecognised selection' });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push({ key, ...p });
    }

    const applicationIds = parsed.filter((p) => p.kind === 'APPLICATION').map((p) => p.id);
    const memberResumeIds = parsed.filter((p) => p.kind === 'MEMBER_RESUME').map((p) => p.id);
    const externalResumeIds = parsed.filter((p) => p.kind === 'EXTERNAL_RESUME').map((p) => p.id);

    // Re-validate every key independently of the filter that produced it. The
    // commit never re-runs the filter - these lookups are what make the
    // snapshot safe rather than trusting whatever the browser sent.
    const [applications, memberResumes, externalResumes, live] = await Promise.all([
      applicationIds.length
        ? prisma.application.findMany({
            where: { id: { in: applicationIds } },
            select: { id: true, talentPoolOptIn: true, resumeUrl: true, blindResumeUrl: true }
          })
        : [],
      memberResumeIds.length
        ? prisma.memberResume.findMany({
            where: { id: { in: memberResumeIds } },
            select: {
              id: true,
              isCurrent: true,
              shareConsent: true,
              consentRevokedAt: true
            }
          })
        : [],
      externalResumeIds.length
        ? prisma.externalResume.findMany({
            where: { id: { in: externalResumeIds } },
            select: {
              id: true,
              isCurrent: true,
              shareConsent: true,
              consentRevokedAt: true,
              // The gate members do not have. Read here as well as in the
              // filter so a student who was verified at preview time and is not
              // any more cannot slip through on a stale key.
              user: { select: { emailVerifiedAt: true, isActive: true } }
            }
          })
        : [],
      prisma.clientResumeAssignment.findMany({
        where: {
          clientId: client.id,
          revokedAt: null,
          OR: [
            { applicationId: { in: applicationIds } },
            { memberResumeId: { in: memberResumeIds } },
            { externalResumeId: { in: externalResumeIds } }
          ]
        },
        select: { applicationId: true, memberResumeId: true, externalResumeId: true }
      })
    ]);

    const appById = new Map(applications.map((a) => [a.id, a]));
    const memberById = new Map(memberResumes.map((m) => [m.id, m]));
    const externalById = new Map(externalResumes.map((e) => [e.id, e]));
    const liveApps = new Set(live.map((l) => l.applicationId).filter(Boolean));
    const liveMembers = new Set(live.map((l) => l.memberResumeId).filter(Boolean));
    const liveExternals = new Set(live.map((l) => l.externalResumeId).filter(Boolean));

    const toCreate = [];

    for (const p of parsed) {
      if (p.kind === 'APPLICATION') {
        const app = appById.get(p.id);
        if (!app) {
          skipped.push({ key: p.key, reason: 'Application no longer exists' });
        } else if (app.talentPoolOptIn === false) {
          // An explicit No, and only that. A null means the applicant was never
          // asked, which is not a refusal - see the gate in talentPoolFilters.js.
          skipped.push({ key: p.key, reason: 'Applicant opted out of the Talent Partner Network' });
        } else if (!app.resumeUrl) {
          skipped.push({ key: p.key, reason: 'No resume on file' });
        } else if (client.visibility === 'BLIND' && !app.blindResumeUrl) {
          skipped.push({ key: p.key, reason: 'No redacted resume, and this client is blind-visibility' });
        } else if (liveApps.has(p.id)) {
          skipped.push({ key: p.key, reason: 'Already assigned to this client' });
        } else {
          toCreate.push({ applicationId: p.id, memberResumeId: null, externalResumeId: null });
        }
        continue;
      }

      if (p.kind === 'MEMBER_RESUME') {
        const mr = memberById.get(p.id);
        if (!mr) {
          skipped.push({ key: p.key, reason: 'Member resume no longer exists' });
        } else if (!mr.isCurrent) {
          skipped.push({ key: p.key, reason: 'Member has replaced this resume' });
        } else if (!mr.shareConsent || mr.consentRevokedAt) {
          skipped.push({ key: p.key, reason: 'Member has not consented to sharing' });
        } else if (client.visibility === 'BLIND') {
          skipped.push({ key: p.key, reason: 'Member resumes have no redacted version' });
        } else if (liveMembers.has(p.id)) {
          skipped.push({ key: p.key, reason: 'Already assigned to this client' });
        } else {
          toCreate.push({ applicationId: null, memberResumeId: p.id, externalResumeId: null });
        }
        continue;
      }

      const er = externalById.get(p.id);
      if (!er) {
        skipped.push({ key: p.key, reason: 'Student resume no longer exists' });
      } else if (!er.isCurrent) {
        skipped.push({ key: p.key, reason: 'Student has replaced this resume' });
      } else if (!er.shareConsent || er.consentRevokedAt) {
        skipped.push({ key: p.key, reason: 'Student has not consented to sharing' });
      } else if (!er.user?.emailVerifiedAt || er.user?.isActive === false) {
        skipped.push({ key: p.key, reason: 'Student has not verified their UCLA email' });
      } else if (client.visibility === 'BLIND') {
        skipped.push({ key: p.key, reason: 'Student resumes have no redacted version' });
      } else if (liveExternals.has(p.id)) {
        skipped.push({ key: p.key, reason: 'Already assigned to this client' });
      } else {
        toCreate.push({ applicationId: null, memberResumeId: null, externalResumeId: p.id });
      }
    }

    if (toCreate.length === 0) {
      return res.status(400).json({ error: 'Nothing left to assign', skipped, created: 0 });
    }

    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.clientAssignmentBatch.create({
        data: {
          clientId: client.id,
          createdById: req.user.id,
          // Documentation only. The assignments below are the snapshot and are
          // never re-derived from this.
          filterJson: req.body?.filter ?? null,
          matchedCount: toCreate.length,
          note: req.body?.note || null
        }
      });

      await tx.clientResumeAssignment.createMany({
        data: toCreate.map((t) => ({
          clientId: client.id,
          batchId: created.id,
          applicationId: t.applicationId,
          memberResumeId: t.memberResumeId,
          externalResumeId: t.externalResumeId,
          assignedById: req.user.id
        }))
      });

      return created;
    });

    res.status(201).json({ batchId: batch.id, created: toCreate.length, skipped });
  } catch (error) {
    console.error('[POST /api/admin/talent-pool/clients/:id/assign]', error);
    res.status(500).json({ error: 'Failed to assign resumes' });
  }
});

// ---------------------------------------------------------------------------
// Revocation - always soft, so history and the access log keep valid keys
// ---------------------------------------------------------------------------

router.delete('/clients/:id/assignments/:assignmentId', async (req, res) => {
  try {
    const result = await prisma.clientResumeAssignment.updateMany({
      where: { id: req.params.assignmentId, clientId: req.params.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: req.user.id }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/admin/talent-pool/clients/:id/assignments/:assignmentId]', error);
    res.status(500).json({ error: 'Failed to revoke assignment' });
  }
});

router.delete('/clients/:id/batches/:batchId', async (req, res) => {
  try {
    const result = await prisma.clientResumeAssignment.updateMany({
      where: { batchId: req.params.batchId, clientId: req.params.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: req.user.id }
    });
    res.json({ ok: true, revoked: result.count });
  } catch (error) {
    console.error('[DELETE /api/admin/talent-pool/clients/:id/batches/:batchId]', error);
    res.status(500).json({ error: 'Failed to revoke batch' });
  }
});

export default router;
