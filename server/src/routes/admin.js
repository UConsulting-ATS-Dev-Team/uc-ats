import express from 'express';
import multer from 'multer';
import prisma from '../prismaClient.js';
import { revokeTalentPoolAccess } from '../services/talentPoolAccess.js';
import { requireAuth, requireAdmin, invalidateUserCache } from '../middleware/auth.js';
import { syncEventAttendance, syncEventRSVP, syncMemberEventRSVP, syncMemberEventAttendance, syncAllEventForms } from '../services/syncEventResponses.js';
import syncFormResponses from '../services/syncResponses.js';
import { sendRSVPConfirmation, sendAttendanceConfirmation, formatEventDate, sendMeetingCancellationEmail, sendMeetingCancellationToMember, sendOfferLetter } from '../services/emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from '../services/meetingComms.js';
import { candidateMeetingInvite, hostMeetingInvite, bookedNames } from '../services/meetingInvites.js';
import { notifyHostSlotCreated } from '../services/meetingComms.js';
import { updateMeetingSlot, SlotUpdateError } from '../services/meetingSlotUpdates.js';
import { localInputToUTC, utcToLocalInput } from '../utils/timezoneUtils.js';
import {
  getDeactivationCandidates,
  parseGraduationYear,
} from '../services/userDeactivation.js';
import {
  getGroupMemberUsers,
  getGroupMemberIds,
  groupMemberUserInclude
} from '../utils/groupMembers.js';
import { isProfileComplete, missingProfileFields } from '../utils/gtkucProfile.js';
import { candidateQuestionHandlers } from '../services/candidateQuestions.js';
import { loadGtkucProfileState } from '../utils/gtkucProfileState.js';
import {
  getOfferLetterTemplate,
  saveOfferLetterTemplate,
  uploadSignature,
  getSignatureBuffer,
  getSignatureSignedUrl,
  sendOfferLetterToCandidate,
  findLatestOfferLetterSend,
  generateOfferLetterPdf
} from '../services/offerLetter.js';
import { previewCycleEventCopy, commitCycleEventCopy } from '../services/eventCopy.js';
import {
  loadActiveCycle,
  loadAdminApplications,
  loadEvents,
  loadExistingDecisions,
  loadReviewTeams,
  loadStagingCandidates,
  loadStagingSnapshot
} from '../services/stagingSnapshot.js';
import { readStagingChangeToken } from '../utils/stagingChangeToken.js';
import {
  previewCycleBootstrap,
  commitCycleBootstrap,
  timelineFromPriorCycle
} from '../services/cycleBootstrap.js';
import { CYCLE_TIMELINE_STAGES } from '../services/cycleTimelineTemplate.js';
import { resolveFormStatus } from '../services/eventFormStatus.js';
import { parseLumaUrl, lumaUrlChanged } from '../services/luma/lumaUrl.js';
import { LUMA_HELD } from '../services/luma/heldGuests.js';
import { getEventEmailSetting, setSendSignupConfirmations } from '../services/eventEmailSettings.js';
import {
  activateCycleExclusively,
  isActiveCycleConflict,
  ActiveCycleConflictError,
  ALL_AUDIENCES,
  isValidAudience,
  resolveCycleForRequest,
  resolveAdminCycle,
  resolveCandidateCycle
} from '../services/activeCycle.js';
import {
  guardApplication,
  guardCandidate,
  lockedApplicationIds,
  lockedRowPredicate,
  redactApplication,
  redactCandidate,
  redactLockedApplications,
  sendRecordLocked
} from '../utils/lockedRecords.js';
import { processRoundDecisions } from '../services/decisionProcessing.js';
import { referredDisplayName, attachReferralToCandidate } from '../services/referrals.js';
// The roster seam: slots are the source of truth where they exist, and the
// legacy Interview.description blob everywhere else.
import {
  canonicalGroupIdFor,
  expandGroupIdsForQuestions,
  resolveGroupIds,
  getRosterForInterview
} from '../services/interviewRoster.js';
import { ROUNDS } from '../utils/roundProgression.js';
import { roundForPhase, saveRoundDecision } from '../services/stagingDecisions.js';
import {
  DEFAULT_REMINDER_MESSAGE,
  DEFAULT_REMINDER_SUBJECT,
  EVENT_POINT_TYPES,
  REMINDER_MERGE_FIELDS,
  isEventPointType,
  scoreMembers,
  sendReminders,
  updatePointConfig
} from '../services/accountabilityPoints.js';
import { mergeFieldsUsed } from '../services/emailCopyRender.js';

const router = express.Router();

const MISSING_GRADUATION_CLASS = '__UNKNOWN_GRADUATION_CLASS__';

const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Signature must be a PNG, JPEG, or WebP image'));
    }
  }
});

// Helper function to safely parse JSON fields that might be plain text
const safeParseJsonField = (field) => {
  if (!field || typeof field !== 'string') {
    return field;
  }
  const trimmed = field.trim();
  // Only try to parse if it looks like JSON (starts with { or [)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(field);
    } catch (e) {
      // If it looks like JSON but fails to parse, return empty object
      return {};
    }
  }
  // It's plain text, return as is
  return field;
};

// Protect all admin routes
router.use(requireAuth, requireAdmin);

// Routes that read or change one application's evaluation record: a sealed
// record answers 423, and nobody decides or evaluates their own application.
router.all(
  [
    '/staging/candidates/:id/status',
    '/staging/candidates/:id/final-decision',
    '/staging/candidates/:id/advance-round',
    '/applications/:id/interview-evaluations',
    '/applications/:id/final-round-interview-evaluations'
  ],
  guardApplication((req) => req.params.id)
);
// save-decision calls its application id `candidateId`.
router.post('/save-decision', guardApplication((req) => req.body?.candidateId));
router.post('/interviews/:id/evaluations', guardApplication((req) => req.body?.applicationId));

// Score overrides name the score row, so resolve it to its candidate first.
const guardScoreCandidate = (model) => async (req, res, next) => {
  try {
    const score = await prisma[model].findUnique({ where: { id: req.params.id }, select: { candidateId: true } });
    return guardCandidate(() => score?.candidateId)(req, res, next);
  } catch (error) {
    console.error('[score record guard]', error);
    res.status(500).json({ error: 'Failed to check record access' });
  }
};
router.patch('/resume-scores/:id', guardScoreCandidate('resumeScore'));
router.patch('/cover-letter-scores/:id', guardScoreCandidate('coverLetterScore'));
router.patch('/video-scores/:id', guardScoreCandidate('videoScore'));

// Get dashboard stats
router.get('/stats', async (req, res) => {
  try {
    // Wrap all database calls in try-catch blocks to handle individual failures
    let active = null;
    try {
      active = await resolveCycleForRequest(prisma, req);
    } catch (error) {
      console.error('Error fetching active cycle:', error);
    }
    
    if (!active) {
      return res.json({ totalApplicants: 0, tasks: 0, candidates: 0, currentRound: 'SUBMITTED' });
    }

    // Get each value individually with error handling
    let totalApplicants = 0;
    let resumeGrades = 0;
    let coverLetterGrades = 0;
    let videoGrades = 0;
    let candidates = [];

    try {
      totalApplicants = await prisma.application.count({ where: { cycleId: active.id } });
    } catch (error) {
      console.error('Error fetching total applicants:', error);
    }

    try {
      resumeGrades = await prisma.resumeScore.count();
    } catch (error) {
      console.error('Error fetching resume grades:', error);
    }

    try {
      coverLetterGrades = await prisma.coverLetterScore.count();
    } catch (error) {
      console.error('Error fetching cover letter grades:', error);
    }

    try {
      videoGrades = await prisma.videoScore.count();
    } catch (error) {
      console.error('Error fetching video grades:', error);
    }

    try {
      candidates = await prisma.application.findMany({
        where: {
          cycleId: active.id,
          status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'WAITLISTED'] }
        },
        select: {
          currentRound: true,
          status: true
        }
      });
    } catch (error) {
      console.error('Error fetching candidates:', error);
    }

    const totalGrades = resumeGrades + coverLetterGrades + videoGrades;

    // Calculate current stage based on currentRound field instead of status
    const roundCounts = candidates.reduce((acc, candidate) => {
      const round = candidate.currentRound || '1'; // Default to round 1 if no currentRound
      acc[round] = (acc[round] || 0) + 1;
      return acc;
    }, {});

    // Determine the current stage based on the most common round
    let currentRound = 'SUBMITTED';
    if (Object.keys(roundCounts).length > 0) {
      const mostCommonRound = Object.keys(roundCounts).reduce((a, b) =>
        roundCounts[a] > roundCounts[b] ? a : b
      );
      
      // Map round numbers to stage names
      const roundToStage = Object.fromEntries(ROUNDS.map((round) => [round.round, round.stage]));
      
      currentRound = roundToStage[mostCommonRound] || 'RESUME_REVIEW';
    }

    res.json({ totalApplicants, tasks: totalGrades, candidates: candidates.length, currentRound });
  } catch (error) {
    console.error('[GET /api/admin/stats]', error);
    // Return default values instead of error to prevent dashboard from breaking
    res.json({ totalApplicants: 0, tasks: 0, candidates: 0, currentRound: 'SUBMITTED' });
  }
});

// Get all candidates
router.get('/candidates', async (req, res) => {
  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200 items
    const skip = (page - 1) * limit;

    // Search and filter parameters
    const search = req.query.search?.trim() || '';
    const { year, gender, firstGen, transfer, status: statusFilter, eventAttendanceEventId, eventRsvpEventId } = req.query;

    // Scope to active cycle if present
    const active = await resolveCycleForRequest(prisma, req);
    if (!active) {
      return res.json([]);
    }

    // Build where clause with filters
    const whereClause = { cycleId: active.id };

    // Add search filter (search by name or email)
    if (search) {
      whereClause.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Add other filters
    if (year) whereClause.graduationYear = year;
    if (gender) whereClause.gender = gender;
    if (firstGen === 'true') whereClause.isFirstGeneration = true;
    if (firstGen === 'false') whereClause.isFirstGeneration = false;
    if (transfer === 'true') whereClause.isTransferStudent = true;
    if (transfer === 'false') whereClause.isTransferStudent = false;
    if (statusFilter) whereClause.status = statusFilter;

    // Event attendance filter (via candidate relation)
    if (eventAttendanceEventId) {
      whereClause.candidate = {
        ...(whereClause.candidate || {}),
        eventAttendance: {
          some: { eventId: eventAttendanceEventId }
        }
      };
    }

    // Event RSVP filter (via candidate relation)
    if (eventRsvpEventId) {
      whereClause.candidate = {
        ...(whereClause.candidate || {}),
        eventRsvp: {
          some: { eventId: eventRsvpEventId }
        }
      };
    }

    // Fetch paginated data and total count in parallel
    const [candidates, total] = await Promise.all([
      prisma.application.findMany({
        where: whereClause,
        orderBy: { submittedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.application.count({
        where: whereClause
      })
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      data: await redactLockedApplications(req, candidates),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error('[GET /api/admin/candidates]', error);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

router.get('/candidates/comprehensive', async (req, res) => {
  try {
    const candidates = await prisma.candidate.findMany({
      include: {
        assignedGroup: true,
        applications: {
          include: {
            cycle: true,
            comments: {
              include: {
                user: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                }
              },
              orderBy: { createdAt: 'desc' }
            },
            interviewEvaluations: {
              include: {
                evaluator: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                },
                interview: {
                  select: {
                    id: true,
                    title: true,
                    interviewType: true,
                    startDate: true
                  }
                }
              }
            },
            firstRoundEvaluations: {
              include: {
                evaluator: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                }
              }
            },
            flaggedDocuments: {
              include: {
                flagger: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                },
                resolver: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                }
              }
            }
          }
        },
        resumeScores: {
          include: {
            evaluator: {
              select: {
                id: true,
                fullName: true,
                email: true, profileImage: true }
            }
          }
        },
        coverLetterScores: {
          include: {
            evaluator: {
              select: {
                id: true,
                fullName: true,
                email: true, profileImage: true }
            }
          }
        },
        videoScores: {
          include: {
            evaluator: {
              select: {
                id: true,
                fullName: true,
                email: true, profileImage: true }
            }
          }
        },
        roundOne: {
          include: {
            evaluations: {
              include: {
                evaluator: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                }
              }
            }
          }
        },
        roundTwo: {
          include: {
            evaluations: {
              include: {
                evaluator: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                }
              }
            }
          }
        },
        coffeeChat: {
          include: {
            evaluations: {
              include: {
                evaluator: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true, profileImage: true }
                }
              }
            }
          }
        },
        eventAttendance: {
          include: {
            event: {
              select: {
                id: true,
                eventName: true,
                eventStartDate: true
              }
            }
          }
        },
        eventRsvp: {
          include: {
            event: {
              select: {
                id: true,
                eventName: true,
                eventStartDate: true
              }
            }
          }
        },
        referrals: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Sealed candidates keep their row, so the list still adds up, and lose
    // everything that says how they were evaluated.
    const isLocked = await lockedRowPredicate(req, candidates, { refOf: (candidate) => ({ candidateId: candidate.id }) });
    res.json(candidates.map((candidate) => (isLocked(candidate) ? redactCandidate(candidate) : candidate)));
  } catch (error) {
    console.error('[GET /api/admin/candidates/comprehensive]', error);
    res.status(500).json({ error: 'Failed to fetch comprehensive candidate data' });
  }
});

// Helper to build the shared role/event RSVP where-clause for user endpoints.
// Does NOT apply graduation-class filtering; that is handled by each route.
function buildBaseUserWhereClause({ role, memberEventRsvpEventId, includeInactive }) {
  const whereClause = {};

  // Deactivated accounts are hidden from user management unless explicitly requested
  if (!includeInactive) {
    whereClause.isActive = true;
  }

  // Map INTERVIEWER to MEMBER role since that's what we have in the enum
  if (role === 'INTERVIEWER') {
    whereClause.role = 'MEMBER';
  } else if (role) {
    whereClause.role = role;
  }

  // Member event RSVP filter
  if (memberEventRsvpEventId) {
    whereClause.memberEventRsvp = {
      some: { eventId: memberEventRsvpEventId }
    };
  }

  return whereClause;
}

// Get all users (with optional role, event RSVP filter, and graduation class filter)
router.get('/users', async (req, res) => {
  try {
    const { role, memberEventRsvpEventId, graduationClass, includeInactive } = req.query;

    const whereClause = buildBaseUserWhereClause({
      role,
      memberEventRsvpEventId,
      includeInactive: includeInactive === 'true'
    });

    // Graduation class filter
    if (graduationClass !== undefined && graduationClass !== null && graduationClass !== '') {
      if (typeof graduationClass !== 'string') {
        return res.status(400).json({ error: 'Invalid graduation class' });
      }

      const normalizedClass = graduationClass.trim();
      if (normalizedClass.length > 100) {
        return res.status(400).json({ error: 'Invalid graduation class' });
      }

      if (normalizedClass === MISSING_GRADUATION_CLASS) {
        whereClause.OR = [
          { graduationClass: null },
          { graduationClass: '' }
        ];
      } else {
        whereClause.graduationClass = normalizedClass;
      }
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        graduationClass: true,
        profileImage: true,
        phoneNumber: true,
        isActive: true,
        deactivatedAt: true
      },
      orderBy: { fullName: 'asc' }
    });

    res.json(users);
  } catch (error) {
    console.error('[GET /api/admin/users]', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get graduation class options and counts for the admin user filter.
// Independent of the graduation-class filter itself so the dropdown stays usable
// even when a class filter is already persisted.
router.get('/users/classes', async (req, res) => {
  try {
    const { role, memberEventRsvpEventId } = req.query;

    const whereClause = buildBaseUserWhereClause({ role, memberEventRsvpEventId });

    const users = await prisma.user.findMany({
      where: whereClause,
      select: { graduationClass: true }
    });

    const classCounts = new Map();
    let unknownCount = 0;
    let totalCount = 0;

    users.forEach((userItem) => {
      totalCount++;
      const c = (userItem.graduationClass || '').trim();
      if (!c) {
        unknownCount++;
      } else {
        classCounts.set(c, (classCounts.get(c) || 0) + 1);
      }
    });

    const classes = Array.from(classCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, count }));

    res.json({
      total: totalCount,
      classes,
      unknown: {
        value: MISSING_GRADUATION_CLASS,
        label: 'Unknown / No class',
        count: unknownCount
      }
    });
  } catch (error) {
    console.error('[GET /api/admin/users/classes]', error);
    res.status(500).json({ error: 'Failed to fetch class options' });
  }
});

router.post('/advance-candidate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🚀 Advancing candidate ${id}...`);

    const candidate = await prisma.application.findUnique({
      where: { id }
    });

    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    let nextStatus;
    if (candidate.status === 'SUBMITTED') {
      nextStatus = 'UNDER_REVIEW';
    } else if (candidate.status === 'UNDER_REVIEW') {
      nextStatus = 'ACCEPTED';
    } else if (candidate.status === 'WAITLISTED') {
      nextStatus = 'UNDER_REVIEW';
    } else {
      return res.status(400).json({ error: 'Candidate cannot be advanced further' });
    }

    await prisma.application.update({
      where: { id },
      data: {
        status: nextStatus,
        approved: null
      }
    });

    res.json({ message: `Candidate advanced to ${nextStatus}` });

  } catch (error) {
    console.error(`[POST /api/admin/advance-candidate/:id]`, error);
    res.status(500).json({ error: 'Failed to advance candidate' });
  }
});

router.put('/candidates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    console.log(`Updating candidate ${id}...`, updateData);

    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined || key === 'rejectedAtRound') {
        delete updateData[key];
      }
    });

    if (updateData.cumulativeGpa !== undefined) {
      const gpa = parseFloat(updateData.cumulativeGpa);
      if (isNaN(gpa) || gpa < 0 || gpa > 4) {
        return res.status(400).json({ error: 'Invalid cumulative GPA' });
      }
      updateData.cumulativeGpa = gpa;
    }

    if (updateData.majorGpa !== undefined) {
      if (updateData.majorGpa === null || updateData.majorGpa === '') {
        updateData.majorGpa = null;
      } else {
        const gpa = parseFloat(updateData.majorGpa);
        if (isNaN(gpa) || gpa < 0 || gpa > 4) {
          return res.status(400).json({ error: 'Invalid major GPA' });
        }
        updateData.majorGpa = gpa;
      }
    }

    const validStatuses = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED'];
    if (updateData.status && !validStatuses.includes(updateData.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (updateData.currentRound && !updateData.status) {
      const statusMap = {
        'SUBMITTED': 'SUBMITTED',
        'UNDER_REVIEW': 'UNDER_REVIEW',
        'ACCEPTED': 'ACCEPTED',
        'REJECTED': 'REJECTED',
        'WAITLISTED': 'WAITLISTED'
      };
      updateData.status = statusMap[updateData.currentRound] || updateData.currentRound;
      delete updateData.currentRound;
    }

    const updatedCandidate = await prisma.application.update({
      where: { id },
      data: updateData
    });

    res.json({
      message: 'Candidate updated successfully',
      candidate: updatedCandidate
    });
  } catch (error) {
    console.error(`[PUT /api/admin/candidates/:id]`, error);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

// Update candidate information (Candidate model, not Application)
router.put('/candidates/:id/info', async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, email, studentId } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !studentId) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if candidate exists
    const candidate = await prisma.candidate.findUnique({
      where: { id }
    });

    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    // Check if email or studentId is being changed and if it conflicts with another candidate
    if (email !== candidate.email) {
      const existingEmail = await prisma.candidate.findUnique({
        where: { email }
      });
      if (existingEmail && existingEmail.id !== id) {
        return res.status(400).json({ error: 'Email already in use by another candidate' });
      }
    }

    if (studentId !== candidate.studentId) {
      const existingStudentId = await prisma.candidate.findUnique({
        where: { studentId }
      });
      if (existingStudentId && existingStudentId.id !== id) {
        return res.status(400).json({ error: 'Student ID already in use by another candidate' });
      }
    }

    // Update the candidate
    const updatedCandidate = await prisma.candidate.update({
      where: { id },
      data: {
        firstName,
        lastName,
        email,
        studentId
      }
    });

    res.json({
      message: 'Candidate updated successfully',
      candidate: updatedCandidate
    });
  } catch (error) {
    console.error(`[PUT /api/admin/candidates/:id/info]`, error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email or Student ID already in use' });
    }
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

// Delete candidate (admin only)
router.delete('/candidates/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if candidate exists
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        applications: {
          select: { id: true }
        },
        eventAttendance: {
          select: { id: true }
        },
        eventRsvp: {
          select: { id: true }
        },
        coffeeChat: {
          select: { id: true }
        },
        referrals: {
          select: { id: true }
        },
        resumeScores: {
          select: { id: true }
        },
        coverLetterScores: {
          select: { id: true }
        },
        videoScores: {
          select: { id: true }
        },
        roundOne: {
          select: { id: true }
        },
        roundTwo: {
          select: { id: true }
        }
      }
    });

    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    // Check if candidate has applications
    if (candidate.applications && candidate.applications.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete candidate with associated applications. Please delete applications first.' 
      });
    }

    // Delete related records first
    await prisma.$transaction([
      // Delete event attendance
      prisma.eventAttendance.deleteMany({
        where: { candidateId: id }
      }),
      // Delete event RSVPs
      prisma.eventRsvp.deleteMany({
        where: { candidateId: id }
      }),
      // Delete coffee chats (and their evaluations via cascade)
      prisma.coffeeChat.deleteMany({
        where: { candidateId: id }
      }),
      // Delete referrals
      prisma.referral.deleteMany({
        where: { candidateId: id }
      }),
      // Delete resume scores
      prisma.resumeScore.deleteMany({
        where: { candidateId: id }
      }),
      // Delete cover letter scores
      prisma.coverLetterScore.deleteMany({
        where: { candidateId: id }
      }),
      // Delete video scores
      prisma.videoScore.deleteMany({
        where: { candidateId: id }
      }),
      // Delete round one (and evaluations via cascade)
      prisma.roundOne.deleteMany({
        where: { candidateId: id }
      }),
      // Delete round two (and evaluations via cascade)
      prisma.roundTwo.deleteMany({
        where: { candidateId: id }
      }),
      // Finally delete the candidate
      prisma.candidate.delete({
        where: { id }
      })
    ]);

    res.json({ message: 'Candidate deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/admin/candidates/:id]', error);
    res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

router.post('/reject-candidate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Rejecting candidate ${id}...`);

    await prisma.application.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approved: false
      }
    });

    res.json({ message: 'Candidate rejected' });
  } catch (error) {
    console.error(`[POST /api/admin/reject-candidate/:id]`, error);
    res.status(500).json({ error: 'Failed to reject candidate' });
  }
});

// Update approval status
router.patch('/candidates/:id/approval', async (req, res) => {
  const { id } = req.params;
  const { approved } = req.body;

  try {
    // Validate approved value
    if (approved !== null && typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'Invalid approval status' });
    }

    const updated = await prisma.application.update({
      where: { id },
      data: { approved }
    });

    res.json({
      message: `Candidate ${approved === null ? 'approval reset' : approved ? 'approved' : 'rejected'} successfully`,
      candidate: updated
    });
  } catch (error) {
    console.error('[PATCH /api/admin/candidates/:id/approval]', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    res.status(500).json({ error: 'Failed to update approval status' });
  }
});

// Advance round
router.post('/advance-round', async (req, res) => {
  try {
    console.log('Starting bulk advance...');
    const active = await resolveCycleForRequest(prisma, req);
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    const approvedCandidates = await prisma.application.findMany({
      where: {
        cycleId: active.id,
        approved: true,
        status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'WAITLISTED'] }
      }
    });

    console.log('Approved candidates to advance:', approvedCandidates.length);

    if (approvedCandidates.length === 0) {
      return res.status(400).json({ error: 'No approved candidates found to advance.' });
    }

    const updates = approvedCandidates.map(candidate => {
      let nextStatus;

      if (candidate.status === 'SUBMITTED') {
        nextStatus = 'UNDER_REVIEW';
      } else if (candidate.status === 'UNDER_REVIEW') {
        nextStatus = 'ACCEPTED';
      } else if (candidate.status === 'WAITLISTED') {
        nextStatus = 'UNDER_REVIEW';
      } else {
        return null;
      }

      return prisma.application.update({
        where: { id: candidate.id },
        data: {
          status: nextStatus,
          approved: null
        }
      });
    }).filter(Boolean);

    await Promise.all(updates);

    res.json({
      message: `Successfully advanced ${updates.length} candidates`,
      advancedCount: updates.length
    });

  } catch (error) {
    console.error('[POST /api/admin/advance-round]', error);
    res.status(500).json({ error: 'Failed to advance round', details: error.message });
  }
});

// Process All Decisions, one endpoint per Staging tab. Each moves its round's
// applications along and queues their decision emails for review in Master
// Communications; none of them sends anything. See services/decisionProcessing.js.
const processDecisionsForRound = (round) => async (req, res) => {
  try {
    const cycle = await resolveCycleForRequest(prisma, req);
    if (!cycle) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }
    res.json(await processRoundDecisions({ cycle, round, processedBy: req.user }));
  } catch (error) {
    console.error(`[process decisions, round ${round}]`, error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : 'Failed to process decisions',
      details: error.message
    });
  }
};

router.post('/process-decisions', processDecisionsForRound('1'));

// Approval status of a specific candidate
router.post('/candidates/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { approved } = req.body;

  try {
    const updated = await prisma.application.update({
      where: { id },
      data: { approved },
    });

    res.json({ success: true, updated });
  } catch (error) {
    console.error('[POST /api/admin/candidates/:id/approve]', error);
    res.status(500).json({ error: 'Failed to update approval status' });
  }
});

// Fetch all application cycles
router.get('/cycles', async (req, res) => {
  try {
    const cycles = await prisma.recruitingCycle.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(cycles);
  } catch (error) {
    console.error('[GET /api/admin/cycles]', error);
    res.status(500).json({ error: 'Failed to fetch application cycles' });
  }
});

// The admin console's own cycle. Additive extension: the body is still the admin
// cycle row, so existing readers of .id/.name/deadlines are untouched, plus
// `candidateCycle` and `audiencesSplit` so the UI can warn when admins are working in
// a different cycle than members and candidates see.
router.get('/cycles/active', async (req, res) => {
  try {
    const [adminCycle, candidateCycle] = await Promise.all([
      resolveAdminCycle(prisma),
      resolveCandidateCycle(prisma)
    ]);
    if (!adminCycle) return res.json(null);
    res.json({
      ...adminCycle,
      candidateCycle: candidateCycle
        ? { id: candidateCycle.id, name: candidateCycle.name }
        : null,
      audiencesSplit: Boolean(candidateCycle) && candidateCycle.id !== adminCycle.id
    });
  } catch (error) {
    console.error('[GET /api/admin/cycles/active]', error);
    // Return null instead of error to prevent dashboard from breaking
    res.json(null);
  }
});

// The admin form sends the application deadline as an LA-local
// `YYYY-MM-DDTHH:mm` string. Blank clears it; anything else unparseable is refused
// rather than stored as null, so a typo can't silently remove the deadline.
// A time skipped by the spring-forward change (e.g. 02:30 that night) converts to
// a different instant, so the result must convert back to exactly what was typed.
const parseApplicationDeadline = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return { value: null };
  const input = String(value).trim().replace(' ', 'T');
  const parsed = localInputToUTC(input);
  if (!parsed) return { error: 'Application deadline must be a date and time' };
  if (utcToLocalInput(parsed) !== input) {
    return { error: 'Application deadline is not a real Pacific time (clocks skip that hour)' };
  }
  return { value: parsed };
};

// Create a new cycle
router.post('/cycles', async (req, res) => {
  try {
    const { name, formUrl, startDate, endDate, isActive, resumeDeadline, coverLetterDeadline, videoDeadline } = req.body;
    const applicationDeadline = parseApplicationDeadline(req.body.applicationDeadline);
    if (applicationDeadline.error) return res.status(400).json({ error: applicationDeadline.error });
    const activate = Boolean(isActive);
    // Create then activate in one transaction, so the single-active invariant is
    // never briefly broken and a losing concurrent activation leaves no cycle.
    const created = await prisma.$transaction(async (tx) => {
      const cycle = await tx.recruitingCycle.create({
        data: {
          name,
          formUrl: formUrl || null,
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
          applicationDeadline: applicationDeadline.value,
          isActive: false,
          resumeDeadline: resumeDeadline || null,
          coverLetterDeadline: coverLetterDeadline || null,
          videoDeadline: videoDeadline || null,
        }
      });
      return activate ? activateCycleExclusively(tx, cycle.id) : cycle;
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('[POST /api/admin/cycles]', error);
    if (isActiveCycleConflict(error)) {
      return res.status(409).json({ error: new ActiveCycleConflictError().message });
    }
    res.status(500).json({ error: 'Failed to create cycle' });
  }
});

// Cycle bootstrap: full recruitment timeline -> cycle + generated event shells

// Timeline field template that drives the cycle-create form.
router.get('/cycles/timeline-template', (req, res) => {
  res.json({ stages: CYCLE_TIMELINE_STAGES });
});

// Seed the timeline form from a prior cycle's stored snapshot (dates only).
router.get('/cycles/:id/timeline-clone', async (req, res) => {
  try {
    const shiftYears = req.query.shiftYears ? parseInt(req.query.shiftYears, 10) : undefined;
    const clone = await timelineFromPriorCycle({
      prisma,
      sourceCycleId: req.params.id,
      ...(Number.isFinite(shiftYears) ? { shiftYears } : {})
    });
    res.json(clone);
  } catch (error) {
    console.error('[GET /api/admin/cycles/:id/timeline-clone]', error);
    res.status(400).json({ error: error.message });
  }
});

// Preview the events a timeline would generate, before anything is written.
router.post('/cycles/bootstrap-preview', async (req, res) => {
  try {
    const { name, timeline } = req.body || {};
    const preview = await previewCycleBootstrap({ prisma, name, timeline });
    res.json(preview);
  } catch (error) {
    console.error('[POST /api/admin/cycles/bootstrap-preview]', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message, validationErrors: error.validationErrors });
    }
    res.status(400).json({ error: error.message });
  }
});

// Commit the timeline: one transaction creating the cycle and its event shells.
router.post('/cycles/bootstrap-commit', async (req, res) => {
  try {
    const { name, timeline, events, activate } = req.body || {};
    const result = await commitCycleBootstrap({
      prisma,
      name,
      timeline,
      events,
      actorId: req.user?.id,
      activate: Boolean(activate)
    });
    res.status(201).json(result);
  } catch (error) {
    console.error('[POST /api/admin/cycles/bootstrap-commit]', error);
    if (error.name === 'ActiveCycleConflictError') {
      return res.status(409).json({ error: error.message });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message, validationErrors: error.validationErrors });
    }
    res.status(400).json({ error: error.message });
  }
});

// Set a cycle as active, for one audience or both.
//
// `audiences` defaults to both, so an existing caller posting an empty body keeps
// meaning "activate for everyone". Passing ['CANDIDATE'] alone is the handover case:
// members and candidates move while admins stay on the closing cycle.
router.post('/cycles/:id/activate', async (req, res) => {
  const { id } = req.params;
  const { audiences = ALL_AUDIENCES } = req.body ?? {};

  if (!Array.isArray(audiences) || audiences.length === 0 || !audiences.every(isValidAudience)) {
    return res.status(400).json({
      error: `audiences must be a non-empty array of ${ALL_AUDIENCES.join(' | ')}`
    });
  }

  try {
    const updated = await prisma.$transaction((tx) => activateCycleExclusively(tx, id, audiences));

    res.json({ message: 'Cycle activated', cycle: updated, audiences });
  } catch (error) {
    console.error('[POST /api/admin/cycles/:id/activate]', error);
    if (isActiveCycleConflict(error)) {
      return res.status(409).json({ error: new ActiveCycleConflictError().message });
    }
    res.status(500).json({ error: 'Failed to activate cycle' });
  }
});

// Update a cycle
router.patch('/cycles/:id', async (req, res) => {
  const { id } = req.params;
  const { name, formUrl, startDate, endDate, isActive, resumeDeadline, coverLetterDeadline, videoDeadline } = req.body;
  try {
    console.log('[PATCH /api/admin/cycles/:id] Updating cycle:', id, 'with data:', req.body);
    
    const updateData = {
      ...(name !== undefined ? { name } : {}),
      ...(formUrl !== undefined ? { formUrl } : {}),
      ...(startDate !== undefined ? { startDate: startDate ? new Date(startDate) : null } : {}),
      ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
      // Activation is applied separately below so it goes through the ordered
      // deactivate-others-then-activate path that the single-active index needs.
      ...(isActive === false ? { isActive: false } : {}),
    };
    
    // Add deadline fields if they exist in the schema
    if (resumeDeadline !== undefined) {
      updateData.resumeDeadline = resumeDeadline || null;
    }
    if (coverLetterDeadline !== undefined) {
      updateData.coverLetterDeadline = coverLetterDeadline || null;
    }
    if (videoDeadline !== undefined) {
      updateData.videoDeadline = videoDeadline || null;
    }
    if (req.body.applicationDeadline !== undefined) {
      const applicationDeadline = parseApplicationDeadline(req.body.applicationDeadline);
      if (applicationDeadline.error) return res.status(400).json({ error: applicationDeadline.error });
      updateData.applicationDeadline = applicationDeadline.value;
    }
    
    console.log('[PATCH /api/admin/cycles/:id] Update data:', updateData);
    
    const updated = await prisma.$transaction(async (tx) => {
      const cycle = await tx.recruitingCycle.update({
        where: { id },
        data: updateData
      });
      return isActive ? activateCycleExclusively(tx, cycle.id) : cycle;
    });
    
    console.log('[PATCH /api/admin/cycles/:id] Successfully updated cycle');
    res.json(updated);
  } catch (error) {
    if (isActiveCycleConflict(error)) {
      return res.status(409).json({ error: new ActiveCycleConflictError().message });
    }
    console.error('[PATCH /api/admin/cycles/:id] Error:', error);
    console.error('[PATCH /api/admin/cycles/:id] Error details:', {
      message: error.message,
      code: error.code,
      meta: error.meta,
      stack: error.stack
    });
    
    // Check if error is due to missing columns
    if (error.message && (error.message.includes('Unknown column') || 
        error.message.includes('column') && error.message.includes('does not exist'))) {
      return res.status(500).json({ 
        error: 'Database schema needs to be updated. Please run the migration to add deadline columns.',
        details: 'The deadline columns (resumeDeadline, coverLetterDeadline, videoDeadline) do not exist in the database yet.'
      });
    }
    
    res.status(500).json({ error: 'Failed to update cycle', details: error.message });
  }
});

// Delete a cycle
router.delete('/cycles/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.recruitingCycle.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/admin/cycles/:id]', error);
    res.status(500).json({ error: 'Failed to delete cycle' });
  }
});

router.post('/reset-all', async (req, res) => {
  try {
    console.log('Resetting candidates for active cycle...');
    const active = await resolveCycleForRequest(prisma, req);
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    await prisma.application.updateMany({
      where: { cycleId: active.id },
      data: { status: 'SUBMITTED', approved: null }
    });

    res.json({ message: 'All candidates reset to initial state' });
  } catch (error) {
    console.error('[POST /api/admin/reset-all]', error);
    res.status(500).json({ error: 'Failed to reset candidates' });
  }
});

// Profile
router.put('/profile', async (req, res) => {
  const { email, fullName, graduationClass, originalEmail } = req.body;

  try {
    if (email !== originalEmail) {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already in use by another account' });
      }
    }

    const result = await prisma.user.update({
      where: { email: originalEmail },
      data: { email, fullName, graduationClass }
    });

    res.json({ message: 'Profile updated successfully', user: result });
  } catch (error) {
    console.error('[PUT /api/admin/profile]', error);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

router.get('/profile', async (req, res) => {
  try {
    // Get current user from authentication middleware
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        graduationClass: true,
        role: true,
        studentId: true,
        profileImage: true,
        createdAt: true
      }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('[GET /api/admin/profile]', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Event Management Routes

// Get all events
// Whether the Google Form event sync sends its own RSVP and attendance
// confirmations. Off while sign-ups run through Luma, which sends its own; the
// switch is what makes a move back to Forms a toggle rather than a revert.
// Registered before the '/events/:id' routes so 'event-email-settings' is not
// read as an event id.
router.get('/event-email-settings', async (req, res) => {
  try {
    res.json(await getEventEmailSetting());
  } catch (error) {
    console.error('[GET /api/admin/event-email-settings]', error);
    res.status(500).json({ error: 'Failed to load event email settings' });
  }
});

router.patch('/event-email-settings', async (req, res) => {
  try {
    const saved = await setSendSignupConfirmations(req.body?.sendSignupConfirmations, req.user?.id);
    console.log(
      `[events] signup confirmation emails turned ${saved.sendSignupConfirmations ? 'ON' : 'OFF'} `
      + `by ${req.user?.id || 'an admin'}`
    );
    res.json(saved);
  } catch (error) {
    if (error?.code === 'INVALID_EVENT_EMAIL_SETTING') {
      return res.status(400).json({ error: error.message });
    }
    console.error('[PATCH /api/admin/event-email-settings]', error);
    res.status(500).json({ error: 'Failed to save event email settings' });
  }
});

router.get('/events', async (req, res) => {
  try {
    res.json(await loadEvents(prisma));
  } catch (error) {
    console.error('[GET /api/admin/events]', error);
    // Return empty array instead of error to prevent dashboard from breaking
    res.json([]);
  }
});

// Create a new event
router.post('/events', async (req, res) => {
  try {
    const {
      eventName,
      eventStartDate,
      eventEndDate,
      eventLocation,
      rsvpForm,
      attendanceForm,
      showToCandidates,
      memberRsvpUrl,
      memberAttendanceForm,
      lumaUrl,
      cycleId
    } = req.body;

    // Validate required fields
    if (!eventName || !eventStartDate || !eventEndDate || !cycleId) {
      return res.status(400).json({ error: 'Event name, start date, end date, and cycle ID are required' });
    }

    const luma = parseLumaUrl(lumaUrl);
    if (luma.error) return res.status(400).json({ error: luma.error });

    // Validate that the cycle exists
    const cycle = await prisma.recruitingCycle.findUnique({
      where: { id: cycleId }
    });

    if (!cycle) {
      return res.status(400).json({ error: 'Invalid recruiting cycle' });
    }

    const event = await prisma.events.create({
      data: {
        eventName,
        eventStartDate: new Date(eventStartDate),
        eventEndDate: new Date(eventEndDate),
        eventLocation: eventLocation || null,
        rsvpForm: rsvpForm || null,
        attendanceForm: attendanceForm || null,
        showToCandidates: showToCandidates || false,
        memberRsvpUrl: memberRsvpUrl || null,
        memberAttendanceForm: memberAttendanceForm || null,
        // No lumaEventId: an event is linked to a Luma event only by the sync
        // routine resolving this URL, never by hand.
        lumaUrl: luma.url,
        cycleId
      }
    });

    res.status(201).json(event);
  } catch (error) {
    console.error('[POST /api/admin/events]', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Delete an event
router.delete('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if event exists
    const event = await prisma.events.findUnique({
      where: { id }
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Delete the event
    await prisma.events.delete({
      where: { id }
    });

    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/admin/events/:id]', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Update an event
router.patch('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      eventName,
      eventStartDate,
      eventEndDate,
      eventLocation,
      rsvpForm,
      attendanceForm,
      showToCandidates,
      memberRsvpUrl,
      memberAttendanceForm,
      lumaUrl,
      cycleId
    } = req.body;

    // Check if event exists
    const existingEvent = await prisma.events.findUnique({
      where: { id }
    });

    if (!existingEvent) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // If cycleId is being updated, validate it exists
    if (cycleId && cycleId !== existingEvent.cycleId) {
      const cycle = await prisma.recruitingCycle.findUnique({
        where: { id: cycleId }
      });

      if (!cycle) {
        return res.status(400).json({ error: 'Invalid recruiting cycle' });
      }
    }

    const luma = parseLumaUrl(lumaUrl);
    if (lumaUrl !== undefined && luma.error) {
      return res.status(400).json({ error: luma.error });
    }

    // Repointing an event at a different Luma event has to drop what the last
    // one left behind. lumaEventId is what every page of guests is checked
    // against and is unique across events, so a stale one makes the routine's
    // next resolve fail with a conflict it cannot get past; a stale
    // lumaLastSyncedAt would meanwhile report the new link as freshly synced
    // when nothing has ever been read from it. The guests already ingested
    // stay: they did attend, whatever the event is now linked to.
    const relinked = lumaUrl !== undefined && lumaUrlChanged(existingEvent.lumaUrl, luma.url);

    // Keep the generated-event form shim state in step with the links.
    const nextFormStatus = resolveFormStatus({
      currentStatus: existingEvent.formStatus,
      rsvpForm: rsvpForm !== undefined ? rsvpForm : existingEvent.rsvpForm,
      attendanceForm: attendanceForm !== undefined ? attendanceForm : existingEvent.attendanceForm,
      lumaUrl: lumaUrl !== undefined ? luma.url : existingEvent.lumaUrl
    });

    // Update the event
    const updatedEvent = await prisma.events.update({
      where: { id },
      data: {
        ...(nextFormStatus !== undefined && { formStatus: nextFormStatus }),
        ...(eventName !== undefined && { eventName }),
        ...(eventStartDate !== undefined && { eventStartDate: new Date(eventStartDate) }),
        ...(eventEndDate !== undefined && { eventEndDate: new Date(eventEndDate) }),
        ...(eventLocation !== undefined && { eventLocation: eventLocation || null }),
        ...(rsvpForm !== undefined && { rsvpForm: rsvpForm || null }),
        ...(attendanceForm !== undefined && { attendanceForm: attendanceForm || null }),
        ...(showToCandidates !== undefined && { showToCandidates }),
        ...(memberRsvpUrl !== undefined && { memberRsvpUrl: memberRsvpUrl || null }),
        ...(memberAttendanceForm !== undefined && { memberAttendanceForm: memberAttendanceForm || null }),
        ...(lumaUrl !== undefined && { lumaUrl: luma.url }),
        ...(relinked && { lumaEventId: null, lumaLastSyncedAt: null }),
        ...(cycleId !== undefined && { cycleId })
      }
    });

    res.json(updatedEvent);
  } catch (error) {
    console.error('[PATCH /api/admin/events/:id]', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Application Form Sync Routes

// Sync main application form responses
router.post('/forms/sync', async (req, res) => {
  try {
    console.log('Admin triggering sync for application form responses...');
    await syncFormResponses();
    res.json({ 
      message: 'Application form sync completed successfully'
    });
  } catch (error) {
    console.error('[POST /api/admin/forms/sync]', error);
    res.status(500).json({ error: 'Failed to sync application form responses' });
  }
});

// Event Form Sync Routes

// Sync all event forms (both RSVP and attendance)
router.post('/events/sync-all', async (req, res) => {
  try {
    console.log('Admin triggering sync for all event forms...');
    const results = await syncAllEventForms();
    res.json({ 
      message: 'Event forms sync completed',
      results: results 
    });
  } catch (error) {
    console.error('[POST /api/admin/events/sync-all]', error);
    res.status(500).json({ error: 'Failed to sync event forms' });
  }
});

// Sync RSVP responses for a specific event
router.post('/events/:id/sync-rsvp', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Admin triggering RSVP sync for event ${id}...`);
    
    const result = await syncEventRSVP(id);
    res.json({ 
      message: `RSVP sync completed for event ${id}`,
      result: result 
    });
  } catch (error) {
    console.error(`[POST /api/admin/events/${req.params.id}/sync-rsvp]`, error);
    res.status(500).json({ error: 'Failed to sync event RSVP responses' });
  }
});

// Sync attendance responses for a specific event
router.post('/events/:id/sync-attendance', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Admin triggering attendance sync for event ${id}...`);
    
    const result = await syncEventAttendance(id);
    res.json({ 
      message: `Attendance sync completed for event ${id}`,
      result: result 
    });
  } catch (error) {
    console.error(`[POST /api/admin/events/${req.params.id}/sync-attendance]`, error);
    res.status(500).json({ error: 'Failed to sync event attendance responses' });
  }
});

// Sync member RSVP responses for a specific event
router.post('/events/:id/sync-member-rsvp', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Admin triggering member RSVP sync for event ${id}...`);
    
    const result = await syncMemberEventRSVP(id);
    res.json({ 
      message: `Member RSVP sync completed for event ${id}`,
      result: result 
    });
  } catch (error) {
    console.error(`[POST /api/admin/events/${req.params.id}/sync-member-rsvp]`, error);
    res.status(500).json({ error: 'Failed to sync member RSVP responses' });
  }
});

// Sync member attendance responses for a specific event
router.post('/events/:id/sync-member-attendance', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Admin triggering member attendance sync for event ${id}...`);
    
    const result = await syncMemberEventAttendance(id);
    res.json({ 
      message: `Member attendance sync completed for event ${id}`,
      result: result 
    });
  } catch (error) {
    console.error(`[POST /api/admin/events/${req.params.id}/sync-member-attendance]`, error);
    res.status(500).json({ error: 'Failed to sync member attendance responses' });
  }
});

// Get event statistics (RSVP and attendance counts)
router.get('/events/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;

    const [event, rsvpCount, attendanceCount, memberRsvpCount, memberAttendanceCount, lumaGuestCount, lumaHeldCount] = await Promise.all([
      prisma.events.findUnique({
        where: { id },
        select: { 
          eventName: true, 
          eventStartDate: true, 
          eventEndDate: true,
          rsvpForm: true,
          attendanceForm: true,
          memberRsvpUrl: true,
          memberAttendanceForm: true,
          lumaUrl: true,
          lumaEventId: true,
          lumaLastSyncedAt: true
        }
      }),
      prisma.eventRsvp.count({ where: { eventId: id } }),
      prisma.eventAttendance.count({ where: { eventId: id } }),
      prisma.memberEventRsvp.count({ where: { eventId: id } }),
      prisma.memberEventAttendance.count({ where: { eventId: id } }),
      prisma.lumaGuest.count({ where: { eventId: id } }),
      // Guests the sync could not settle. Counted here rather than in the panel
      // so the event list can show a number without opening one panel per row;
      // the predicate is the same one lumaAdmin.js lists by.
      prisma.lumaGuest.count({ where: { eventId: id, ...LUMA_HELD } })
    ]);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({
      event: event,
      stats: {
        rsvpCount: rsvpCount,
        attendanceCount: attendanceCount,
        memberRsvpCount: memberRsvpCount,
        memberAttendanceCount: memberAttendanceCount,
        hasRsvpForm: !!event.rsvpForm,
        hasAttendanceForm: !!event.attendanceForm,
        hasMemberRsvpForm: !!event.memberRsvpUrl,
        hasMemberAttendanceForm: !!event.memberAttendanceForm,
        lumaGuestCount,
        lumaHeldCount
      }
    });
  } catch (error) {
    console.error(`[GET /api/admin/events/${req.params.id}/stats]`, error);
    res.status(500).json({ error: 'Failed to fetch event statistics' });
  }
});

// Get detailed RSVP list for an event
router.get('/events/:id/rsvps', async (req, res) => {
  try {
    const { id } = req.params;

    const rsvps = await prisma.eventRsvp.findMany({
      where: { eventId: id },
      include: {
        candidate: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            studentId: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(rsvps);
  } catch (error) {
    console.error(`[GET /api/admin/events/${req.params.id}/rsvps]`, error);
    res.status(500).json({ error: 'Failed to fetch event RSVPs' });
  }
});

// Get detailed attendance list for an event
router.get('/events/:id/attendance', async (req, res) => {
  try {
    const { id } = req.params;

    const attendance = await prisma.eventAttendance.findMany({
      where: { eventId: id },
      include: {
        candidate: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            studentId: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(attendance);
  } catch (error) {
    console.error(`[GET /api/admin/events/${req.params.id}/attendance]`, error);
    res.status(500).json({ error: 'Failed to fetch event attendance' });
  }
});

// Accountability Tracker Routes

async function getAccountabilityCycle(req) {
  const cycleId = req.query.cycleId;
  if (cycleId) {
    return prisma.recruitingCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, name: true, startDate: true, endDate: true, createdAt: true, isActive: true }
    });
  }
  return prisma.recruitingCycle.findFirst({
    where: { isActive: true },
    select: { id: true, name: true, startDate: true, endDate: true, createdAt: true, isActive: true }
  });
}

const ACCOUNTABILITY_MEMBER_SELECT = { id: true, fullName: true, email: true, studentId: true, role: true };

function activeStaff() {
  return prisma.user.findMany({
    where: { role: { in: ['MEMBER', 'ADMIN'] }, isActive: true },
    select: ACCOUNTABILITY_MEMBER_SELECT,
    orderBy: { fullName: 'asc' }
  });
}

// Get accountability summary for a cycle: every member's points, and the events
router.get('/accountability', async (req, res) => {
  try {
    const cycle = await getAccountabilityCycle(req);
    if (!cycle) {
      return res.status(404).json({ error: 'No cycle found. Activate a cycle or pass cycleId.' });
    }

    const [scored, events] = await Promise.all([
      activeStaff().then((members) => scoreMembers({ cycle, members })),
      prisma.events.findMany({
        where: { cycleId: cycle.id },
        select: {
          id: true,
          eventName: true,
          eventStartDate: true,
          eventEndDate: true,
          memberAttendanceForm: true,
          pointType: true,
          _count: {
            select: {
              memberEventAttendance: true,
              // Counted over the same people the check-in dialog lists, so the
              // two totals agree even after someone is deactivated or demoted.
              memberEventRsvp: {
                where: { member: { role: { in: ['MEMBER', 'ADMIN'] }, isActive: true } }
              }
            }
          }
        },
        orderBy: { eventStartDate: 'desc' }
      })
    ]);

    // Most points first; ties by name so the order is stable between refreshes.
    const leaderboard = [...scored.members].sort(
      (a, b) => b.points - a.points || (a.fullName || '').localeCompare(b.fullName || '')
    );

    res.json({
      cycle,
      config: { ...scored.config, eventPointTypes: EVENT_POINT_TYPES },
      reminderDefaults: {
        subject: DEFAULT_REMINDER_SUBJECT,
        message: DEFAULT_REMINDER_MESSAGE,
        mergeFields: REMINDER_MERGE_FIELDS
      },
      leaderboard,
      events: events.map(e => ({
        ...e,
        memberAttendanceCount: e._count.memberEventAttendance,
        memberRsvpCount: e._count.memberEventRsvp
      }))
    });
  } catch (error) {
    console.error('[GET /api/admin/accountability]', error);
    res.status(500).json({ error: 'Failed to fetch accountability summary' });
  }
});

// Change what each type is worth and/or the target
router.put('/accountability/config', async (req, res) => {
  try {
    const { points, targetPoints } = req.body || {};
    const config = await updatePointConfig({ points, targetPoints }, req.user.id);
    res.json({ ...config, eventPointTypes: EVENT_POINT_TYPES });
  } catch (error) {
    if (error.code === 'INVALID_ACCOUNTABILITY_CONFIG') {
      return res.status(400).json({ error: error.message });
    }
    console.error('[PUT /api/admin/accountability/config]', error);
    res.status(500).json({ error: 'Failed to save accountability points' });
  }
});

// Tag an event with the accountability type attending it earns (null for none)
router.put('/accountability/events/:id/point-type', async (req, res) => {
  try {
    const pointType = req.body?.pointType ?? null;
    if (pointType !== null && !isEventPointType(pointType)) {
      return res.status(400).json({ error: `pointType must be one of ${EVENT_POINT_TYPES.join(', ')}, or null` });
    }
    const event = await prisma.events.update({
      where: { id: req.params.id },
      data: { pointType },
      select: { id: true, pointType: true }
    });
    res.json(event);
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Event not found' });
    }
    console.error(`[PUT /api/admin/accountability/events/${req.params.id}/point-type]`, error);
    res.status(500).json({ error: 'Failed to update event point type' });
  }
});

// Email members who are under the target. Standing is recomputed here rather
// than trusted from the page, so a member who got there since it loaded is
// skipped. `memberIds` narrows the send; omitted, everyone under target gets one.
router.post('/accountability/reminders', async (req, res) => {
  try {
    const { memberIds, subject, message } = req.body || {};
    if (memberIds !== undefined && (!Array.isArray(memberIds) || memberIds.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'memberIds must be an array of ids' });
    }
    for (const [name, text] of [['subject', subject], ['message', message]]) {
      if (text === undefined) continue;
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: `${name} cannot be empty` });
      }
      const unknown = mergeFieldsUsed(text).filter((field) => !REMINDER_MERGE_FIELDS.includes(field));
      if (unknown.length) {
        return res.status(400).json({ error: `Unknown merge field in ${name}: {{${unknown.join('}}, {{')}}}` });
      }
    }

    const cycle = await getAccountabilityCycle(req);
    if (!cycle) {
      return res.status(404).json({ error: 'No cycle found. Activate a cycle or pass cycleId.' });
    }

    const { members } = await scoreMembers({ cycle, members: await activeStaff() });
    const wanted = memberIds ? new Set(memberIds) : null;
    const asked = wanted ? members.filter((m) => wanted.has(m.id)) : members;
    const recipients = asked.filter((m) => !m.met && m.email);

    const { sent, failed } = await sendReminders(recipients, {
      subject,
      message,
      cycle,
      triggeredById: req.user.id,
      dashboardUrl: process.env.CLIENT_URL ? `${process.env.CLIENT_URL}/dashboard` : null
    });

    res.json({
      sent: sent.length,
      failed,
      // Asked for, but already at target (or without an address) when it came to sending.
      skipped: asked.length - recipients.length
    });
  } catch (error) {
    console.error('[POST /api/admin/accountability/reminders]', error);
    res.status(500).json({ error: 'Failed to send accountability reminders' });
  }
});

// Get member attendance status for a specific event
router.get('/accountability/events/:id/members', async (req, res) => {
  try {
    const { id } = req.params;

    const [event, members] = await Promise.all([
      prisma.events.findUnique({
        where: { id },
        select: { id: true, eventName: true, memberAttendanceForm: true }
      }),
      prisma.user.findMany({
        where: { role: { in: ['MEMBER', 'ADMIN'] }, isActive: true },
        select: { id: true, fullName: true, email: true, studentId: true },
        orderBy: { fullName: 'asc' }
      })
    ]);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // RSVPs come alongside attendance so the check-in list can be worked from
    // who said they were coming, which is how an admin takes it at the door.
    const memberIds = members.map(m => m.id);
    const [attendances, rsvps] = await Promise.all([
      prisma.memberEventAttendance.findMany({
        where: { eventId: id, memberId: { in: memberIds } },
        select: { memberId: true, source: true }
      }),
      prisma.memberEventRsvp.findMany({
        where: { eventId: id, memberId: { in: memberIds } },
        select: { memberId: true, source: true }
      })
    ]);

    const attendanceByMember = Object.fromEntries(attendances.map(a => [a.memberId, a]));
    const rsvpByMember = Object.fromEntries(rsvps.map(r => [r.memberId, r]));

    res.json({
      event,
      members: members.map(member => ({
        ...member,
        attended: Boolean(attendanceByMember[member.id]),
        source: attendanceByMember[member.id]?.source || null,
        rsvpd: Boolean(rsvpByMember[member.id]),
        rsvpSource: rsvpByMember[member.id]?.source || null
      }))
    });
  } catch (error) {
    console.error(`[GET /api/admin/accountability/events/${req.params.id}/members]`, error);
    res.status(500).json({ error: 'Failed to fetch event member attendance' });
  }
});

// Toggle manual member attendance for an event
router.post('/accountability/events/:id/member-attendance', async (req, res) => {
  try {
    const { id } = req.params;
    const { memberId, attended } = req.body;

    if (!memberId) {
      return res.status(400).json({ error: 'memberId is required' });
    }

    const event = await prisma.events.findUnique({
      where: { id },
      select: { id: true, cycleId: true }
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const existing = await prisma.memberEventAttendance.findUnique({
      where: { eventId_memberId: { eventId: id, memberId } }
    });

    let result;
    if (attended === false || (attended === undefined && existing)) {
      if (existing) {
        await prisma.memberEventAttendance.delete({
          where: { eventId_memberId: { eventId: id, memberId } }
        });
      }
      result = { attended: false, source: null };
    } else {
      result = await prisma.memberEventAttendance.upsert({
        where: { eventId_memberId: { eventId: id, memberId } },
        update: { source: 'MANUAL' },
        create: { eventId: id, memberId, source: 'MANUAL' }
      });
      result = { attended: true, source: result.source };
    }

    res.json(result);
  } catch (error) {
    console.error(`[POST /api/admin/accountability/events/${req.params.id}/member-attendance]`, error);
    res.status(500).json({ error: 'Failed to update member attendance' });
  }
});

// Sync member attendance form for an event
router.post('/accountability/events/:id/sync-attendance', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await syncMemberEventAttendance(id);
    res.json({ message: `Member attendance sync completed for event ${id}`, result });
  } catch (error) {
    console.error(`[POST /api/admin/accountability/events/${req.params.id}/sync-attendance]`, error);
    res.status(500).json({ error: 'Failed to sync member attendance' });
  }
});

// Cycle-portable event copy routes

// Preview events that would be copied from a source cycle to a target cycle
router.post('/events/copy-preview', async (req, res) => {
  try {
    const { sourceCycleId, targetCycleId } = req.body;
    const preview = await previewCycleEventCopy({ prisma, sourceCycleId, targetCycleId });
    res.json(preview);
  } catch (error) {
    console.error('[POST /api/admin/events/copy-preview]', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message, validationErrors: error.validationErrors });
    }
    res.status(400).json({ error: error.message });
  }
});

// Commit the copy of events from a source cycle to a target cycle
router.post('/events/copy-commit', async (req, res) => {
  try {
    const { sourceCycleId, targetCycleId, events, force } = req.body;
    const result = await commitCycleEventCopy({
      prisma,
      sourceCycleId,
      targetCycleId,
      events,
      actorId: req.user?.id,
      force: Boolean(force)
    });
    res.status(201).json(result);
  } catch (error) {
    console.error('[POST /api/admin/events/copy-commit]', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message, validationErrors: error.validationErrors });
    }
    res.status(400).json({ error: error.message });
  }
});

// Interview Management Routes

// Get all interviews
router.get('/interviews', async (req, res) => {
  try {
    // Get the active cycle first
    const activeCycle = await resolveCycleForRequest(prisma, req);
    
    if (!activeCycle) {
      return res.json([]);
    }

    // Get all interviews for the active cycle
    const interviews = await prisma.interview.findMany({
      where: {
        cycleId: activeCycle.id
      },
      include: {
        cycle: true
      },
      orderBy: { startDate: 'desc' }
    });
    res.json(interviews);
  } catch (error) {
    console.error('[GET /api/admin/interviews]', {
      message: error?.message,
      code: error?.code,
    });
    // If the interviews table/columns do not exist yet, return an empty list
    if (error?.code === 'P2021' || error?.code === 'P2022') {
      return res.json([]);
    }
    res.status(500).json({ error: 'Failed to fetch interviews' });
  }
});

// Create new interview
router.post('/interviews', async (req, res) => {
  try {
    const {
      title,
      interviewType,
      startDate,
      endDate,
      location,
      maxCandidates,
      description,
      cycleId,
      dresscode,
      deliberationsStart,
      deliberationsEnd
    } = req.body;

    // Validate required fields
    if (!title || !interviewType || !startDate || !endDate || !cycleId) {
      return res.status(400).json({ error: 'Interview title, interviewType, start date, end date, and cycle ID are required' });
    }

    // Validate that the cycle exists
    const cycle = await prisma.recruitingCycle.findUnique({
      where: { id: cycleId }
    });

    if (!cycle) {
      return res.status(400).json({ error: 'Invalid recruiting cycle' });
    }

    const createdBy = req.user?.id;
    if (!createdBy) {
      return res.status(401).json({ error: 'Authenticated user required' });
    }
    // Ensure creator exists (avoid FK violation P2003)
    const creator = await prisma.user.findUnique({ where: { id: createdBy } });
    if (!creator) {
      return res.status(400).json({ error: 'Creator user not found' });
    }

    const interview = await prisma.interview.create({
      data: {
        title,
        interviewType,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        location,
        maxCandidates: maxCandidates ?? null,
        description: typeof description === 'object' ? JSON.stringify(description) : (description ?? null),
        cycleId,
        createdBy,
        dresscode: dresscode ?? null,
        deliberationsStart: deliberationsStart ? new Date(deliberationsStart) : null,
        deliberationsEnd: deliberationsEnd ? new Date(deliberationsEnd) : null
      },
      include: {
        cycle: true
      }
    });

    res.json(interview);
  } catch (error) {
    console.error('[POST /api/admin/interviews]', {
      message: error?.message,
      code: error?.code,
    });
    if (error?.code === 'P2003') {
      return res.status(400).json({ error: 'Invalid reference: cycleId or createdBy does not exist' });
    }
    if (error?.code === 'P2021' || error?.code === 'P2022') {
      return res.status(400).json({ error: 'Interview schema not found. Run migrations to create interview tables.' });
    }
    res.status(500).json({ error: 'Failed to create interview' });
  }
});

// Delete interview
router.delete('/interviews/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if interview exists
    const interview = await prisma.interview.findUnique({
      where: { id }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    // Delete dependent records first to satisfy FK constraints
    const ops = [];
    if (prisma.interviewAssignment?.deleteMany) {
      ops.push(prisma.interviewAssignment.deleteMany({ where: { interviewId: id } }));
    }
    if (prisma.interviewActionItem?.deleteMany) {
      ops.push(prisma.interviewActionItem.deleteMany({ where: { interviewId: id } }));
    }
    if (prisma.interviewEvaluation?.deleteMany) {
      ops.push(prisma.interviewEvaluation.deleteMany({ where: { interviewId: id } }));
    }
    if (prisma.firstRoundInterviewEvaluation?.deleteMany) {
      ops.push(prisma.firstRoundInterviewEvaluation.deleteMany({ where: { interviewId: id } }));
    }
    ops.push(prisma.interview.delete({ where: { id } }));
    await prisma.$transaction(ops);

    res.json({ message: 'Interview deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/admin/interviews/:id]', error);
    if (error?.code === 'P2003') {
      return res.status(409).json({ error: 'Cannot delete interview due to related records' });
    }
    res.status(500).json({ error: 'Failed to delete interview' });
  }
});

// Get interview details
router.get('/interviews/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const interview = await prisma.interview.findUnique({
      where: { id },
      include: {
        cycle: true
      }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    res.json(interview);
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id]', error);
    res.status(500).json({ error: 'Failed to fetch interview details' });
  }
});

// Get interview configuration
router.get('/interviews/:id/config', async (req, res) => {
  try {
    const { id } = req.params;
    const { groupIds } = req.query;
    
    const interview = await prisma.interview.findUnique({
      where: { id }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Built from sessions where the interview has them, and from the old JSON
    // config where it does not. This is what populates the "which groups are
    // you interviewing" picker, so reading only the config left that picker
    // empty for any interview candidates had booked themselves into.
    const config = (await getRosterForInterview(id)) ?? {
      memberGroups: [],
      applicationGroups: [],
      groupAssignments: {}
    };
    
    // Get group-scoped behavioral questions if groupIds provided
    if (groupIds) {
      try {
        // Read under both the slot id and the blob group id it was backfilled
        // from. Questions written before the roster moved into real tables are
        // keyed on the old id; reading only one key would make them vanish from
        // a live interview, and nothing would fail loudly because groupId has no
        // foreign key.
        const groupIdArray = await expandGroupIdsForQuestions(id, groupIds);
        const behavioralQuestions = await prisma.behavioralQuestion.findMany({
          where: {
            interviewId: id,
            groupId: { in: groupIdArray },
            applicationId: null
          },
          orderBy: { order: 'asc' },
          include: {
            creator: {
              select: {
                id: true,
                fullName: true,
                email: true, profileImage: true }
            }
          }
        });
        
        // Group questions by group ID for easier frontend handling
        const questionsByGroup = {};
        behavioralQuestions.forEach(question => {
          if (!questionsByGroup[question.groupId]) {
            questionsByGroup[question.groupId] = [];
          }
          questionsByGroup[question.groupId].push({
            id: question.id,
            text: question.questionText,
            order: question.order,
            createdBy: question.creator,
            groupId: question.groupId,
            createdAt: question.createdAt
          });
        });
        
        config.behavioralQuestions = questionsByGroup;
      } catch (error) {
        console.warn('Behavioral questions table not found yet, returning empty questions:', error.message);
        config.behavioralQuestions = {};
      }
    }
    
    res.json(config);
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id/config]', error);
    res.status(500).json({ error: 'Failed to fetch interview configuration' });
  }
});

// Update interview configuration
router.patch('/interviews/:id/config', async (req, res) => {
  try {
    const { id } = req.params;
    const { type, config } = req.body;
    
    const interview = await prisma.interview.findUnique({
      where: { id }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Handle behavioral questions update
    if (type === 'behavioral_questions' && config.behavioralQuestions) {
      try {
        const { groupId: requestedGroupId, questions } = config;

        if (!requestedGroupId || !questions) {
          return res.status(400).json({ error: 'groupId and questions are required for behavioral questions update' });
        }

        // Write under the id this group's existing questions already use: a
        // backfilled slot keeps its legacyGroupId, a fresh slot uses its own.
        // Without this, questions saved after the roster migration would land on
        // a different key than the ones saved before it and the group's list
        // would silently split in two.
        const groupId = await canonicalGroupIdFor(id, requestedGroupId);

        console.log('Admin - Attempting to save behavioral questions:', {
          interviewId: id,
          groupId,
          questions: questions.filter(q => q.trim() !== ''),
          userId: req.user?.id
        });
        
        // Verify the interview exists
        const interviewExists = await prisma.interview.findUnique({
          where: { id: id },
          select: { id: true }
        });
        
        if (!interviewExists) {
          console.error('Interview not found:', id);
          return res.status(400).json({ error: `Interview with ID ${id} not found` });
        }
        
        console.log('Interview exists:', interviewExists);
        
        // Get existing questions for this group and interview
        const existingQuestions = await prisma.behavioralQuestion.findMany({
          where: {
            interviewId: id,
            groupId: groupId,
            applicationId: null
          },
          orderBy: { order: 'asc' }
        });
        
        const filteredQuestions = questions.filter(q => q.trim() !== '');
        
        // Update existing questions and create new ones
        for (let i = 0; i < filteredQuestions.length; i++) {
          const questionText = filteredQuestions[i];
          
          if (existingQuestions[i]) {
            // Update existing question if text has changed
            if (existingQuestions[i].questionText !== questionText) {
              await prisma.behavioralQuestion.update({
                where: { id: existingQuestions[i].id },
                data: {
                  questionText: questionText,
                  order: i,
                  updatedAt: new Date()
                }
              });
            } else if (existingQuestions[i].order !== i) {
              // Update order if it has changed
              await prisma.behavioralQuestion.update({
                where: { id: existingQuestions[i].id },
                data: {
                  order: i,
                  updatedAt: new Date()
                }
              });
            }
          } else {
            // Create new question
            await prisma.behavioralQuestion.create({
              data: {
                interviewId: id,
                groupId: groupId,
                questionText: questionText,
                order: i,
                createdBy: req.user.id
              }
            });
          }
        }
        
        // Delete any questions that are no longer in the list
        if (filteredQuestions.length < existingQuestions.length) {
          await prisma.behavioralQuestion.deleteMany({
            where: {
              interviewId: id,
              groupId: groupId,
              applicationId: null,
              order: { gte: filteredQuestions.length }
            }
          });
        }
        
        return res.json({ success: true, message: 'Behavioral questions updated successfully' });
      } catch (error) {
        console.error('Error saving behavioral questions:', error);
        return res.status(500).json({ error: 'Failed to save behavioral questions', details: error.message });
      }
    }
    
    // Handle other configuration updates (legacy support)
    const updatedInterview = await prisma.interview.update({
      where: { id },
      data: {
        description: JSON.stringify(config) // Store config as JSON in description field
      },
      include: {
        cycle: true
      }
    });
    
    res.json(updatedInterview);
  } catch (error) {
    console.error('[PATCH /api/admin/interviews/:id/config]', error);
    res.status(500).json({ error: 'Failed to update interview configuration' });
  }
});

// Get interview action items
router.get('/interviews/:id/action-items', async (req, res) => {
  try {
    const { id } = req.params;
    
    const actionItems = await prisma.interviewActionItem.findMany({
      where: { interviewId: id },
      orderBy: { order: 'asc' },
      include: {
        completedByUser: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });
    
    res.json(actionItems);
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id/action-items]', error);
    res.status(500).json({ error: 'Failed to fetch action items' });
  }
});

// Create interview action item
router.post('/interviews/:id/action-items', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, order } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const actionItem = await prisma.interviewActionItem.create({
      data: {
        interviewId: id,
        title,
        description: description || null,
        order: order || 0
      },
      include: {
        completedByUser: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });
    
    res.json(actionItem);
  } catch (error) {
    console.error('[POST /api/admin/interviews/:id/action-items]', error);
    res.status(500).json({ error: 'Failed to create action item' });
  }
});

// Update interview action item
router.patch('/interviews/:id/action-items/:actionItemId', async (req, res) => {
  try {
    const { id, actionItemId } = req.params;
    const { title, description, isCompleted, order } = req.body;
    
    const actionItem = await prisma.interviewActionItem.update({
      where: { 
        id: actionItemId,
        interviewId: id // Ensure the action item belongs to this interview
      },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(isCompleted !== undefined && { 
          isCompleted,
          completedAt: isCompleted ? new Date() : null,
          completedBy: isCompleted ? req.user?.id : null
        }),
        ...(order !== undefined && { order })
      },
      include: {
        completedByUser: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });
    
    res.json(actionItem);
  } catch (error) {
    console.error('[PATCH /api/admin/interviews/:id/action-items/:actionItemId]', error);
    res.status(500).json({ error: 'Failed to update action item' });
  }
});

// Delete interview action item
router.delete('/interviews/:id/action-items/:actionItemId', async (req, res) => {
  try {
    const { id, actionItemId } = req.params;
    
    await prisma.interviewActionItem.delete({
      where: { 
        id: actionItemId,
        interviewId: id // Ensure the action item belongs to this interview
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/admin/interviews/:id/action-items/:actionItemId]', error);
    res.status(500).json({ error: 'Failed to delete action item' });
  }
});

// Get interview resources
router.get('/interviews/:id/resources', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get resources that are associated with this interview
    // For now, we'll get all resources and filter by round/interview type
    const interview = await prisma.interview.findUnique({
      where: { id },
      select: { interviewType: true }
    });
    
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    const resources = await prisma.interviewResource.findMany({
      where: { 
        round: interview.interviewType,
        isActive: true
      },
      orderBy: { order: 'asc' }
    });
    
    res.json(resources);
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id/resources]', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

// Create interview resource
router.post('/interviews/:id/resources', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, url, fileUrl, type, category, icon, order } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const interview = await prisma.interview.findUnique({
      where: { id },
      select: { interviewType: true }
    });
    
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    const resource = await prisma.interviewResource.create({
      data: {
        title,
        description: description || null,
        url: url || null,
        fileUrl: fileUrl || null,
        type: type || null,
        category: category || null,
        icon: icon || 'book',
        order: order || 0,
        round: interview.interviewType,
        createdBy: req.user?.id || 'system'
      }
    });
    
    res.json(resource);
  } catch (error) {
    console.error('[POST /api/admin/interviews/:id/resources]', error);
    res.status(500).json({ error: 'Failed to create resource' });
  }
});

// Update interview resource
router.patch('/interviews/:id/resources/:resourceId', async (req, res) => {
  try {
    const { id, resourceId } = req.params;
    const { title, description, url, fileUrl, type, category, icon, order, isActive } = req.body;
    
    const resource = await prisma.interviewResource.update({
      where: { id: resourceId },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(url !== undefined && { url }),
        ...(fileUrl !== undefined && { fileUrl }),
        ...(type !== undefined && { type }),
        ...(category !== undefined && { category }),
        ...(icon !== undefined && { icon }),
        ...(order !== undefined && { order }),
        ...(isActive !== undefined && { isActive })
      }
    });
    
    res.json(resource);
  } catch (error) {
    console.error('[PATCH /api/admin/interviews/:id/resources/:resourceId]', error);
    res.status(500).json({ error: 'Failed to update resource' });
  }
});

// Delete interview resource
router.delete('/interviews/:id/resources/:resourceId', async (req, res) => {
  try {
    const { resourceId } = req.params;
    
    await prisma.interviewResource.delete({
      where: { id: resourceId }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/admin/interviews/:id/resources/:resourceId]', error);
    res.status(500).json({ error: 'Failed to delete resource' });
  }
});

// Start interview
router.post('/interviews/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    
    const interview = await prisma.interview.findUnique({
      where: { id }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // For now, just return success. In the future, this could:
    // - Set interview status to "ACTIVE"
    // - Initialize evaluation forms
    // - Send notifications to participants
    
    res.json({ message: 'Interview started successfully' });
  } catch (error) {
    console.error('[POST /api/admin/interviews/:id/start]', error);
    res.status(500).json({ error: 'Failed to start interview' });
  }
});

// Get all applications for admin document grading with optional pagination
router.get('/applications', async (req, res) => {
  const page = parseInt(req.query.page);
  const limit = parseInt(req.query.limit);
  const usePagination = Boolean(page && limit);

  try {
    const result = await loadAdminApplications(prisma, { page, limit });
    // Unpaginated callers still expect just the array
    const applications = await redactLockedApplications(req, result.applications);
    res.json(usePagination ? { ...result, applications } : applications);
  } catch (error) {
    console.error('Error fetching admin applications:', error);
    // Return appropriate response based on pagination usage
    if (usePagination) {
      res.json({ applications: [], total: 0, page: 1, totalPages: 0, hasNextPage: false, hasPrevPage: false });
    } else {
      res.json([]);
    }
  }
});

// Test email notifications endpoint
router.post('/test-email-notifications', async (req, res) => {
  try {
    const { eventId, type, candidateEmail } = req.body;
    
    if (!eventId || !type || !candidateEmail) {
      return res.status(400).json({ 
        error: 'Missing required fields: eventId, type, candidateEmail' 
      });
    }
    
    if (!['rsvp', 'attendance'].includes(type)) {
      return res.status(400).json({ 
        error: 'Type must be either "rsvp" or "attendance"' 
      });
    }
    
    // Get event details
    const event = await prisma.events.findUnique({
      where: { id: eventId }
    });
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Get candidate details
    const candidate = await prisma.candidate.findUnique({
      where: { email: candidateEmail }
    });
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    
    const candidateName = `${candidate.firstName} ${candidate.lastName}`;
    const eventDate = formatEventDate(event.eventStartDate);
    
    let result;
    if (type === 'rsvp') {
      result = await sendRSVPConfirmation(
        candidateEmail,
        candidateName,
        event.eventName,
        eventDate,
        event.eventLocation,
        // Same invite as the automatic confirmation, and the same UID, so a resend
        // amends the entry the candidate already has rather than adding a second.
        event
      );
    } else {
      result = await sendAttendanceConfirmation(
        candidateEmail,
        candidateName,
        event.eventName,
        eventDate,
        event.eventLocation
      );
    }
    
    if (result.success) {
      res.json({ 
        message: `${type.toUpperCase()} confirmation email sent successfully`,
        details: result
      });
    } else {
      res.status(500).json({ 
        error: `Failed to send ${type} confirmation email`,
        details: result.error
      });
    }
    
  } catch (error) {
    console.error('[POST /api/admin/test-email-notifications]', error);
    res.status(500).json({ error: 'Failed to send test email notification' });
  }
});

// Test email service
router.post('/test-email', async (req, res) => {
  try {
    const { sendAcceptanceEmail, sendRejectionEmail } = await import('../services/emailNotifications.js');
    
    // Test acceptance email
    const acceptanceResult = await sendAcceptanceEmail(
      'test@example.com',
      'Test Candidate',
      'Test Cycle 2025'
    );
    
    // Test rejection email
    const rejectionResult = await sendRejectionEmail(
      'test@example.com',
      'Test Candidate',
      'Test Cycle 2025'
    );
    
    res.json({
      message: 'Email test completed',
      acceptance: acceptanceResult,
      rejection: rejectionResult
    });
    
  } catch (error) {
    console.error('[POST /api/admin/test-email]', error);
    res.status(500).json({ error: 'Failed to test email service', details: error.message });
  }
});

// Staging endpoints

// Staging shows a sealed person as a locked row. Identity stays so the board
// still adds up; scores, attendance and decisions go. The row keeps its shape,
// because Staging reads candidate.scores.* without guarding for undefined.
const redactStagingCandidate = (candidate) => ({
  ...redactApplication(candidate),
  currentRound: candidate.currentRound,
  scores: { resume: null, coverLetter: null, video: null, overall: null },
  attendance: {},
  decisions: {},
  reviewTeam: null,
  hasReferral: false,
  referral: null
});

async function redactStagingCandidates(req, candidates) {
  const isLocked = await lockedRowPredicate(req, candidates);
  return candidates.map((candidate) => (isLocked(candidate) ? redactStagingCandidate(candidate) : candidate));
}

async function redactStagingSnapshot(req, snapshot) {
  const rows = [...snapshot.candidates, ...snapshot.applications];
  const isLocked = await lockedRowPredicate(req, rows);
  // Both lists are keyed by application id.
  const sealedIds = new Set(rows.filter(isLocked).map((row) => row.id));
  if (!sealedIds.size) return snapshot;

  const withoutSealed = (decisions) =>
    Object.fromEntries(Object.entries(decisions).filter(([applicationId]) => !sealedIds.has(applicationId)));

  return {
    ...snapshot,
    candidates: snapshot.candidates.map((candidate) =>
      sealedIds.has(candidate.id) ? redactStagingCandidate(candidate) : candidate
    ),
    applications: snapshot.applications.map((application) =>
      sealedIds.has(application.id) ? redactApplication(application) : application
    ),
    decisions: withoutSealed(snapshot.decisions),
    perRoundDecisions: Object.fromEntries(
      Object.entries(snapshot.perRoundDecisions).map(([round, decisions]) => [round, withoutSealed(decisions)])
    ),
    liveVoteResults: Object.fromEntries(
      Object.entries(snapshot.liveVoteResults || {}).map(([phase, results]) => [phase, withoutSealed(results)])
    )
  };
}

// Get staging candidates with comprehensive data and optional pagination
router.get('/staging/candidates', async (req, res) => {
  try {
    // Get pagination parameters - if not provided, return all candidates
    const page = parseInt(req.query.page);
    const limit = parseInt(req.query.limit);
    const usePagination = Boolean(page && limit);

    const snapshot = await loadStagingCandidates(prisma, { page, limit });
    const candidates = await redactStagingCandidates(req, snapshot.candidates);

    if (usePagination) {
      res.json({ ...snapshot, candidates });
    } else {
      res.json({ candidates });
    }
  } catch (error) {
    console.error('[GET /api/admin/staging/candidates]', error);
    // A read failure must stay a failure: returning an empty 200 makes pollers cache
    // and render "no candidates" as if the cycle were empty.
    res.status(500).json({ error: 'Failed to load staging candidates' });
  }
});

// One transactional read of everything the Staging console renders, so the client can
// order whole snapshots instead of guessing from six independent responses.
router.get('/staging/snapshot', async (req, res) => {
  try {
    res.json(await redactStagingSnapshot(req, await loadStagingSnapshot(prisma)));
  } catch (error) {
    console.error('[GET /api/admin/staging/snapshot]', error);
    res.status(500).json({ error: 'Failed to load staging snapshot' });
  }
});

// Cheap companion to the snapshot: one row, so clients can poll often and pay for the
// full snapshot only when this token has actually moved. Compare it for equality only —
// it reports *that* something changed, never how much or in what order.
router.get('/staging/version', async (req, res) => {
  try {
    const changeToken = await readStagingChangeToken(prisma);
    if (changeToken === null) {
      // The row is seeded by migration, so its absence means the token is not installed
      // on this database. Say so rather than returning a token that can never change,
      // which would strand every client on its first snapshot.
      return res.status(503).json({ error: 'Staging change token unavailable' });
    }
    res.json({ changeToken });
  } catch (error) {
    console.error('[GET /api/admin/staging/version]', error);
    res.status(500).json({ error: 'Failed to load staging change token' });
  }
});

// Update candidate status for staging
router.patch('/staging/candidates/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const application = await prisma.application.update({
      where: { id },
      data: { 
        status,
        approved: status === 'ACCEPTED' ? true : status === 'REJECTED' ? false : null
      }
    });

    // Add comment if notes provided
    if (notes && notes.trim()) {
      await prisma.comment.create({
        data: {
          applicationId: id,
          userId: req.user.id,
          content: notes
        }
      });
    }

    res.json(application);
  } catch (error) {
    console.error('[PATCH /api/admin/staging/candidates/:id/status]', error);
    res.status(500).json({ error: 'Failed to update candidate status' });
  }
});

// Submit final decision
router.post('/staging/candidates/:id/final-decision', async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, feedback } = req.body;

    const status = decision === 'ACCEPT' ? 'ACCEPTED' : 
                   decision === 'REJECT' ? 'REJECTED' : 'WAITLISTED';

    const application = await prisma.application.update({
      where: { id },
      data: { 
        status,
        approved: decision === 'ACCEPT' ? true : decision === 'REJECT' ? false : null
      }
    });

    // Add comment if feedback provided
    if (feedback && feedback.trim()) {
      await prisma.comment.create({
        data: {
          applicationId: id,
          userId: req.user.id,
          content: `Final Decision: ${decision}. Feedback: ${feedback}`
        }
      });
    }

    res.json(application);
  } catch (error) {
    console.error('[POST /api/admin/staging/candidates/:id/final-decision]', error);
    res.status(500).json({ error: 'Failed to submit final decision' });
  }
});

// Get interview rounds configuration
router.get('/interview-rounds', async (req, res) => {
  try {
    const rounds = [
      { id: 1, name: 'Resume Review', status: 'completed' },
      { id: 2, name: 'First Interview', status: 'active' },
      { id: 3, name: 'Second Interview', status: 'pending' },
      { id: 4, name: 'Final Decision', status: 'pending' }
    ];

    res.json(rounds);
  } catch (error) {
    console.error('[GET /api/admin/interview-rounds]', error);
    res.status(500).json({ error: 'Failed to fetch interview rounds' });
  }
});

// Get review teams for filtering
router.get('/review-teams', async (req, res) => {
  try {
    res.json(await loadReviewTeams(prisma));
  } catch (error) {
    console.error('[GET /api/admin/review-teams]', error);
    res.status(500).json({ error: 'Failed to fetch review teams' });
  }
});

// Advance candidate to next round
router.post('/staging/candidates/:id/advance-round', async (req, res) => {
  try {
    const { id } = req.params;
    const { roundNumber } = req.body;

    // Determine next status based on round
    let nextStatus;
    if (roundNumber === 1) nextStatus = 'UNDER_REVIEW';
    else if (roundNumber === 2) nextStatus = 'UNDER_REVIEW'; // Could be different for second interview
    else if (roundNumber === 3) nextStatus = 'UNDER_REVIEW'; // Could be different for final round
    else nextStatus = 'ACCEPTED';

    const application = await prisma.application.update({
      where: { id },
      data: { status: nextStatus }
    });

    res.json(application);
  } catch (error) {
    console.error('[POST /api/admin/staging/candidates/:id/advance-round]', error);
    res.status(500).json({ error: 'Failed to advance candidate' });
  }
});

// Save individual decision
router.post('/save-decision', async (req, res) => {
  try {
    const { candidateId, decision, phase } = req.body;

    if (!candidateId) {
      return res.status(400).json({ error: 'Missing required field: candidateId' });
    }

    const active = await resolveCycleForRequest(prisma, req);
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    // candidateId is the application id - Staging rows are keyed by application.
    // A missing or unknown phase has always meant resume review.
    const application = await saveRoundDecision({
      applicationId: candidateId,
      cycleId: active.id,
      phase: roundForPhase(phase) ? phase : 'resume',
      decision,
      userId: req.user?.id
    });

    res.json({
      success: true,
      message: 'Decision saved successfully',
      application
    });

  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('[POST /api/admin/save-decision]', error);
    res.status(500).json({ error: 'Failed to save decision', details: error.message });
  }
});

// Get existing decisions for the active cycle
router.get('/existing-decisions', async (req, res) => {
  try {
    res.json(await loadExistingDecisions(prisma));
  } catch (error) {
    console.error('[GET /api/admin/existing-decisions]', error);
    res.status(500).json({ error: 'Failed to fetch existing decisions', details: error.message });
  }
});

// Round-one questions for one specific candidate (see services/candidateQuestions.js).
router.get('/interviews/:id/candidate-questions', candidateQuestionHandlers.list);
router.post(
  '/interviews/:id/candidate-questions',
  guardApplication((req) => req.body?.applicationId),
  candidateQuestionHandlers.create
);
router.patch('/interviews/:id/candidate-questions/:questionId', candidateQuestionHandlers.update);
router.delete('/interviews/:id/candidate-questions/:questionId', candidateQuestionHandlers.remove);

// Get applications for interview groups
router.get('/interviews/:id/applications', async (req, res) => {
  try {
    const { id: interviewId } = req.params;
    const { groupIds } = req.query;
    
    if (!groupIds) {
      return res.status(400).json({ error: 'Group IDs are required' });
    }
    
    const groupIdArray = groupIds.split(',');
    
    // Get interview configuration
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId }
    });
    
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Slots first, then the legacy JSON blob for anything they do not claim.
    // A group id here may be a slot id, the group id a slot was backfilled from,
    // or a blob-only group - bookmarked URLs and past cycles contain all three.
    const applicationIds = await resolveGroupIds(id, groupIdArray);

    if (applicationIds.length === 0) {
      return res.json([]);
    }

    // Fetch applications
    const applications = await prisma.application.findMany({
      where: {
        id: { in: applicationIds }
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        major1: true,
        graduationYear: true,
        resumeUrl: true,
        coverLetterUrl: true,
        videoUrl: true,
        headshotUrl: true,
        testFor: true,
        candidateId: true,
        studentId: true
      }
    });
    
    // Transform applications to include name field
    const transformedApplications = applications.map(app => ({
      ...app,
      name: `${app.firstName} ${app.lastName}`,
      major: app.major1,
      year: app.graduationYear
    }));
    
    res.json(await redactLockedApplications(req, transformedApplications));
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id/applications]', error);
    res.status(500).json({ error: 'Failed to fetch applications', details: error.message });
  }
});

// Get evaluations for current admin user
router.get('/evaluations', async (req, res) => {
  try {
    const { interviewId } = req.query;
    const userId = req.user.id;
    
    if (!interviewId) {
      return res.status(400).json({ error: 'Interview ID is required' });
    }
    
    // Check if this is a first round interview
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId }
    });
    
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    let evaluations = [];
    
    if (interview.interviewType === 'ROUND_ONE') {
      // Get first round evaluations
      evaluations = await prisma.firstRoundInterviewEvaluation.findMany({
        where: {
          interviewId,
          evaluatorId: userId
        },
        include: {
          application: {
            include: {
              candidate: true
            }
          }
        }
      });
    } else {
      // Get regular evaluations
      evaluations = await prisma.interviewEvaluation.findMany({
        where: {
          interviewId,
          evaluatorId: userId
        },
        include: {
          application: {
            include: {
              candidate: true
            }
          }
        }
      });
    }
    
    // Parse JSON fields for each evaluation
    const parsedEvaluations = evaluations.map(evaluation => {
      const parsed = { ...evaluation };
      
      // Parse behavioralNotes if it's a string
      if (parsed.behavioralNotes && typeof parsed.behavioralNotes === 'string') {
        try {
          parsed.behavioralNotes = JSON.parse(parsed.behavioralNotes);
        } catch (e) {
          console.warn('Failed to parse behavioralNotes JSON:', e);
          parsed.behavioralNotes = {};
        }
      }
      
      // Parse casingNotes if it's a string
      if (parsed.casingNotes && typeof parsed.casingNotes === 'string') {
        try {
          parsed.casingNotes = JSON.parse(parsed.casingNotes);
        } catch (e) {
          console.warn('Failed to parse casingNotes JSON:', e);
          parsed.casingNotes = {};
        }
      }
      
      // Parse candidateDetails if it's a string
      if (parsed.candidateDetails && typeof parsed.candidateDetails === 'string') {
        try {
          parsed.candidateDetails = JSON.parse(parsed.candidateDetails);
        } catch (e) {
          console.warn('Failed to parse candidateDetails JSON:', e);
          parsed.candidateDetails = {};
        }
      }
      
      return parsed;
    });
    
    // An evaluator's own notes about a sealed person are sealed with the rest of
    // their record.
    const sealed = await lockedApplicationIds(req, parsedEvaluations.map((evaluation) => evaluation.applicationId));
    res.json(parsedEvaluations.filter((evaluation) => !sealed.has(evaluation.applicationId)));
  } catch (error) {
    console.error('[GET /api/admin/evaluations]', error);
    res.status(500).json({ error: 'Failed to fetch evaluations' });
  }
});

// Get interview evaluations
router.get('/interviews/:id/evaluations', async (req, res) => {
  try {
    const { id: interviewId } = req.params;
    
    // Check if this is a first round interview
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId }
    });
    
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    let evaluations = [];
    
    if (interview.interviewType === 'ROUND_ONE') {
      // Get first round evaluations
      evaluations = await prisma.firstRoundInterviewEvaluation.findMany({
        where: { interviewId },
        include: {
          application: {
            include: {
              candidate: true
            }
          }
        }
      });
    } else {
      // Get regular evaluations
      evaluations = await prisma.interviewEvaluation.findMany({
        where: { interviewId },
        include: {
          rubricScores: true
        }
      });
    }
    
    // Parse JSON fields for each evaluation
    const parsedEvaluations = evaluations.map(evaluation => {
      const parsed = { ...evaluation };
      
      // Safely parse JSON fields
      parsed.behavioralNotes = safeParseJsonField(parsed.behavioralNotes);
      parsed.casingNotes = safeParseJsonField(parsed.casingNotes);
      parsed.candidateDetails = safeParseJsonField(parsed.candidateDetails);
      
      return parsed;
    });
    
    const sealed = await lockedApplicationIds(req, parsedEvaluations.map((evaluation) => evaluation.applicationId));
    res.json(parsedEvaluations.filter((evaluation) => !sealed.has(evaluation.applicationId)));
  } catch (error) {
    console.error('[GET /api/admin/interviews/:id/evaluations]', error);
    res.status(500).json({ error: 'Failed to fetch evaluations', details: error.message });
  }
});

// Get final round interview evaluations for an application
router.get('/applications/:id/final-round-interview-evaluations', async (req, res) => {
  try {
    const { id: applicationId } = req.params;
    
    // Get all final round interview evaluations for this application
    const evaluations = await prisma.interviewEvaluation.findMany({
      where: {
        applicationId,
        interview: {
          interviewType: {
            in: ['ROUND_TWO', 'FINAL_ROUND']
          }
        }
      },
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        },
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    // Parse JSON fields for each evaluation
    const parsedEvaluations = evaluations.map(evaluation => {
      const parsed = { ...evaluation };
      
      // Safely parse JSON fields
      parsed.behavioralNotes = safeParseJsonField(parsed.behavioralNotes);
      parsed.casingNotes = safeParseJsonField(parsed.casingNotes);
      parsed.candidateDetails = safeParseJsonField(parsed.candidateDetails);
      
      return parsed;
    });
    
    res.json(parsedEvaluations);
  } catch (error) {
    console.error('[GET /api/admin/applications/:id/final-round-interview-evaluations]', error);
    res.status(500).json({ error: 'Failed to fetch final round interview evaluations', details: error.message });
  }
});

// Create or update interview evaluation
router.post('/interviews/:id/evaluations', async (req, res) => {
  try {
    const { id: interviewId } = req.params;
    const { 
      applicationId, 
      notes, 
      decision, 
      rubricScores,
      // First round interview specific fields
      behavioralLeadership,
      behavioralProblemSolving,
      behavioralInterest,
      behavioralTotal,
      marketSizingTeamwork,
      marketSizingLogic,
      marketSizingCreativity,
      marketSizingTotal,
      behavioralNotes,
      marketSizingNotes,
      additionalNotes,
      // Final round interview specific fields
      casingNotes,
      candidateDetails
    } = req.body;
    const evaluatorId = req.user.id;
    
    console.log('Creating evaluation:', { interviewId, applicationId, evaluatorId, decision, rubricScores });
    
    // Validate required fields
    if (!applicationId) {
      return res.status(400).json({ error: 'Application ID is required' });
    }
    
    // Check if this is a first round interview
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId }
    });
    
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Handle first round interviews with dedicated table
    if (interview.interviewType === 'ROUND_ONE') {
      // Check if first round evaluation already exists
      const existingFirstRoundEvaluation = await prisma.firstRoundInterviewEvaluation.findFirst({
        where: {
          interviewId,
          applicationId,
          evaluatorId
        }
      });
      
      const firstRoundData = {
        interviewId,
        applicationId,
        evaluatorId,
        decision,
        behavioralLeadership,
        behavioralProblemSolving,
        behavioralInterest,
        behavioralTotal,
        marketSizingTeamwork,
        marketSizingLogic,
        marketSizingCreativity,
        marketSizingTotal,
        behavioralNotes: behavioralNotes ? JSON.stringify(behavioralNotes) : null,
        marketSizingNotes,
        additionalNotes,
        updatedAt: new Date()
      };
      
      let evaluation;
      if (existingFirstRoundEvaluation) {
        // Update existing first round evaluation
        evaluation = await prisma.firstRoundInterviewEvaluation.update({
          where: { id: existingFirstRoundEvaluation.id },
          data: firstRoundData
        });
      } else {
        // Create new first round evaluation
        evaluation = await prisma.firstRoundInterviewEvaluation.create({
          data: firstRoundData
        });
      }
      
      res.json(evaluation);
    } else {
      // Handle regular interviews with standard evaluation table
      const existingEvaluation = await prisma.interviewEvaluation.findFirst({
        where: {
          interviewId,
          applicationId,
          evaluatorId
        },
        include: {
          rubricScores: true
        }
      });
      
      if (existingEvaluation) {
        // Update existing evaluation
        const updatedEvaluation = await prisma.interviewEvaluation.update({
          where: { id: existingEvaluation.id },
          data: {
            notes,
            decision,
            behavioralNotes: behavioralNotes ? JSON.stringify(behavioralNotes) : null,
            casingNotes: casingNotes ? JSON.stringify(casingNotes) : null,
            candidateDetails: candidateDetails ? JSON.stringify(candidateDetails) : null
          }
        });
        
        // Update rubric scores
        if (rubricScores) {
          for (const [category, score] of Object.entries(rubricScores)) {
            await prisma.interviewRubricScore.upsert({
              where: {
                evaluationId_category: {
                  evaluationId: existingEvaluation.id,
                  category
                }
              },
              update: { score },
              create: {
                evaluationId: existingEvaluation.id,
                category,
                score
              }
            });
          }
        }
        
        res.json(updatedEvaluation);
      } else {
        // Create new evaluation
        const newEvaluation = await prisma.interviewEvaluation.create({
          data: {
            interviewId,
            applicationId,
            evaluatorId,
            notes,
            decision,
            behavioralNotes: behavioralNotes ? JSON.stringify(behavioralNotes) : null,
            casingNotes: casingNotes ? JSON.stringify(casingNotes) : null,
            candidateDetails: candidateDetails ? JSON.stringify(candidateDetails) : null
          }
        });
        
        // Create rubric scores
        if (rubricScores) {
          for (const [category, score] of Object.entries(rubricScores)) {
            await prisma.interviewRubricScore.create({
              data: {
                evaluationId: newEvaluation.id,
                category,
                score
              }
            });
          }
        }
        
        res.json(newEvaluation);
      }
    }
  } catch (error) {
    console.error('[POST /api/admin/interviews/:id/evaluations]', error);
    console.error('Request body:', req.body);
    console.error('User ID:', req.user?.id);
    res.status(500).json({ error: 'Failed to save evaluation', details: error.message });
  }
});

// Get interview evaluations for a specific application
router.get('/applications/:id/interview-evaluations', async (req, res) => {
  try {
    const { id: applicationId } = req.params;
    
    // Get regular interview evaluations
    const regularEvaluations = await prisma.interviewEvaluation.findMany({
      where: { applicationId },
      include: {
        interview: {
          select: {
            id: true,
            title: true,
            interviewType: true,
            startDate: true,
            endDate: true
          }
        },
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        },
        rubricScores: {
          orderBy: { category: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get first round interview evaluations
    const firstRoundEvaluations = await prisma.firstRoundInterviewEvaluation.findMany({
      where: { applicationId },
      include: {
        interview: {
          select: {
            id: true,
            title: true,
            interviewType: true,
            startDate: true,
            endDate: true
          }
        },
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get behavioral questions for all first round interviews
    const firstRoundInterviewIds = [...new Set(firstRoundEvaluations.map(e => e.interviewId))];
    const behavioralQuestions = firstRoundInterviewIds.length > 0
      ? await prisma.behavioralQuestion.findMany({
          where: {
            interviewId: { in: firstRoundInterviewIds }
          },
          orderBy: { order: 'asc' }
        })
      : [];

    // Create a map of question ID to question text
    const questionMap = {};
    behavioralQuestions.forEach(q => {
      questionMap[q.id] = q.questionText;
    });

    // Combine both types of evaluations
    const allEvaluations = [...regularEvaluations, ...firstRoundEvaluations];

    // Parse JSON fields for each evaluation
    const parsedEvaluations = allEvaluations.map(evaluation => {
      const parsed = { ...evaluation };

      // Safely parse JSON fields
      parsed.behavioralNotes = safeParseJsonField(parsed.behavioralNotes);
      parsed.casingNotes = safeParseJsonField(parsed.casingNotes);
      parsed.candidateDetails = safeParseJsonField(parsed.candidateDetails);

      // Add question map for first round evaluations
      if (parsed.interview?.interviewType === 'ROUND_ONE') {
        parsed.behavioralQuestionMap = questionMap;
      }

      return parsed;
    });

    res.json(parsedEvaluations);
  } catch (error) {
    console.error('[GET /api/admin/applications/:id/interview-evaluations]', error);
    res.status(500).json({ error: 'Failed to fetch interview evaluations', details: error.message });
  }
});

// Get evaluation summaries for multiple applications
router.post('/applications/evaluation-summaries', async (req, res) => {
  try {
    const { applicationIds } = req.body;
    
    if (!applicationIds || !Array.isArray(applicationIds)) {
      return res.status(400).json({ error: 'applicationIds array is required' });
    }
    
    const summaries = {};
    
    // Fetch regular evaluations for all applications
    const regularEvaluations = await prisma.interviewEvaluation.findMany({
      where: { 
        applicationId: { in: applicationIds }
      },
      select: {
        id: true,
        applicationId: true,
        decision: true,
        createdAt: true,
        interview: {
          select: {
            interviewType: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Fetch first round evaluations for all applications
    const firstRoundEvaluations = await prisma.firstRoundInterviewEvaluation.findMany({
      where: { 
        applicationId: { in: applicationIds }
      },
      select: {
        id: true,
        applicationId: true,
        decision: true,
        behavioralTotal: true,
        marketSizingTotal: true,
        createdAt: true,
        interview: {
          select: {
            interviewType: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    // Combine both types of evaluations
    const allEvaluations = [...regularEvaluations, ...firstRoundEvaluations];
    
    // Group evaluations by application ID
    allEvaluations.forEach(evaluation => {
      if (!summaries[evaluation.applicationId]) {
        summaries[evaluation.applicationId] = {
          evaluations: []
        };
      }
      summaries[evaluation.applicationId].evaluations.push(evaluation);
    });
    
    // Sealed applications drop out of the summaries entirely.
    const sealed = await lockedApplicationIds(req, applicationIds);
    for (const applicationId of sealed) delete summaries[applicationId];
    res.json(summaries);
  } catch (error) {
    console.error('[POST /api/admin/applications/evaluation-summaries]', error);
    res.status(500).json({ error: 'Failed to fetch evaluation summaries', details: error.message });
  }
});

router.post('/process-coffee-decisions', processDecisionsForRound('2'));
router.post('/process-first-round-decisions', processDecisionsForRound('3'));
router.post('/process-final-decisions', processDecisionsForRound('4'));

// Shared validation for offer-letter send/preview
function isFinalRoundAccepted(application) {
  return (
    application.status === 'ACCEPTED' &&
    (application.finalRoundDecision === 'yes' || application.currentRound === '5')
  );
}

async function validateSendRequest(id, body) {
  const { position, responseDeadline } = body;

  const application = await prisma.application.findUnique({
    where: { id },
    include: { candidate: true, cycle: true }
  });

  if (!application) {
    return { error: 'Application not found', status: 404 };
  }

  if (!application.candidate) {
    return { error: 'No candidate associated with application', status: 400 };
  }

  if (!isFinalRoundAccepted(application)) {
    return { error: 'Offer letters can only be sent to Final Round accepted candidates', status: 400 };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!application.email || !emailRegex.test(application.email)) {
    return { error: 'Invalid candidate email address', status: 400 };
  }

  if (!position || !position.trim() || !responseDeadline || !responseDeadline.trim()) {
    return { error: 'Position and response deadline are required', status: 400 };
  }

  return { application };
}

async function loadAndValidateTemplate(cycleId) {
  const template = await getOfferLetterTemplate(cycleId);

  if (!template.presidentName || !template.presidentName.trim()) {
    throw new Error('Offer letter template is missing the president name');
  }
  if (!template.signaturePath) {
    throw new Error('Offer letter template is missing the president signature');
  }
  if (!template.terms || template.terms.length === 0) {
    throw new Error('Offer letter template is missing terms/expectations');
  }

  const signatureBuffer = await getSignatureBuffer(template.signaturePath);
  if (!signatureBuffer) {
    throw new Error('President signature image could not be loaded');
  }

  return { template, signatureBuffer };
}

// Preview the generated offer-letter PDF for a Final Round accepted candidate
router.post('/applications/:id/offer-letter-preview', async (req, res) => {
  try {
    const { id } = req.params;
    const { position, startDate, responseDeadline, additionalNotes } = req.body;

    const validation = await validateSendRequest(id, { position, responseDeadline });
    if (validation.error) {
      return res.status(validation.status).json({ error: validation.error });
    }
    const { application } = validation;

    const { template, signatureBuffer } = await loadAndValidateTemplate(application.cycleId);
    const deadline = responseDeadline?.trim() || template.responseDeadline || '';
    const offerDetails = { position, startDate, responseDeadline: deadline, additionalNotes };
    const pdfBuffer = await generateOfferLetterPdf(application, application.cycle, template, offerDetails, signatureBuffer);

    res.json({
      filename: 'UConsulting-Offer-Letter-Preview.pdf',
      pdf: pdfBuffer.toString('base64')
    });
  } catch (error) {
    console.error('[POST /api/admin/applications/:id/offer-letter-preview]', error);
    const status = error.message?.includes('template') || error.message?.includes('signature') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to generate offer letter preview' });
  }
});

// Send offer letter to a Final Round accepted candidate
router.post('/applications/:id/send-offer-letter', async (req, res) => {
  try {
    const { id } = req.params;
    const { position, startDate, responseDeadline, additionalNotes, force } = req.body;
    const userId = req.user?.id;

    const validation = await validateSendRequest(id, { position, responseDeadline });
    if (validation.error) {
      return res.status(validation.status).json({ error: validation.error });
    }
    const { application } = validation;

    const { template, signatureBuffer } = await loadAndValidateTemplate(application.cycleId);
    const deadline = responseDeadline?.trim() || template.responseDeadline || '';
    const offerDetails = { position, startDate, responseDeadline: deadline, additionalNotes };

    const result = await sendOfferLetterToCandidate(
      application,
      application.cycle,
      template,
      signatureBuffer,
      offerDetails,
      userId,
      force
    );

    if (result.alreadySent) {
      return res.status(409).json({ error: result.error });
    }
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to send offer letter', details: result.error });
    }

    res.json({
      success: true,
      messageId: result.messageId,
      message: 'Offer letter sent successfully'
    });
  } catch (error) {
    console.error('[POST /api/admin/applications/:id/send-offer-letter]', error);
    const status = error.message?.includes('template') || error.message?.includes('signature') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to send offer letter' });
  }
});

// Get the offer-letter template for a recruiting cycle
router.get('/cycles/:cycleId/offer-letter-template', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const template = await getOfferLetterTemplate(cycleId);
    res.json(template);
  } catch (error) {
    console.error('[GET /api/admin/cycles/:cycleId/offer-letter-template]', error);
    res.status(500).json({ error: 'Failed to load offer letter template', details: error.message });
  }
});

// Get a short-lived signed URL for the president signature image
router.get('/cycles/:cycleId/offer-letter-template/signature', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const template = await getOfferLetterTemplate(cycleId);
    if (!template.signaturePath) {
      return res.status(404).json({ error: 'No signature configured for this cycle' });
    }
    const signedUrl = await getSignatureSignedUrl(template.signaturePath, 300);
    if (!signedUrl) {
      return res.status(404).json({ error: 'Signature not found' });
    }
    res.json({ signedUrl });
  } catch (error) {
    console.error('[GET /api/admin/cycles/:cycleId/offer-letter-template/signature]', error);
    res.status(500).json({ error: 'Failed to get signature URL', details: error.message });
  }
});

// Save the offer-letter template for a recruiting cycle
router.post('/cycles/:cycleId/offer-letter-template', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const { introText, terms, closingText, checklist, presidentName, presidentTitle, responseDeadline, signatureLabel, printedNameLabel, officialOfferLabel, confidentialityLabel, signaturePath } = req.body;
    const template = {
      introText,
      terms: Array.isArray(terms) ? terms.filter(Boolean) : [],
      closingText,
      checklist: Array.isArray(checklist) ? checklist.filter(Boolean) : [],
      presidentName,
      presidentTitle,
      responseDeadline,
      signatureLabel,
      printedNameLabel,
      officialOfferLabel,
      confidentialityLabel,
      signaturePath
    };
    const saved = await saveOfferLetterTemplate(cycleId, template);
    res.json(saved);
  } catch (error) {
    console.error('[POST /api/admin/cycles/:cycleId/offer-letter-template]', error);
    res.status(500).json({ error: 'Failed to save offer letter template', details: error.message });
  }
});

// Upload the president signature image for a recruiting cycle
router.post('/cycles/:cycleId/offer-letter-template/signature', signatureUpload.single('signature'), async (req, res) => {
  try {
    const { cycleId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'Signature image is required' });
    }
    const result = await uploadSignature(cycleId, req.file.buffer, req.file.mimetype);
    res.json({ path: result.path, contentType: result.contentType });
  } catch (error) {
    console.error('[POST /api/admin/cycles/:cycleId/offer-letter-template/signature]', error);
    res.status(500).json({ error: 'Failed to upload signature', details: error.message });
  }
});

// Preview the offer letter for a cycle using a sample candidate
router.post('/cycles/:cycleId/offer-letter-preview', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const { responseDeadline, sampleFirstName, sampleLastName } = req.body;

    const cycle = await prisma.recruitingCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      return res.status(404).json({ error: 'Recruiting cycle not found' });
    }

    const { template, signatureBuffer } = await loadAndValidateTemplate(cycleId);
    const deadline = responseDeadline?.trim() || template.responseDeadline || '';
    const offerDetails = {
      responseDeadline: deadline
    };

    const application = {
      id: 'sample',
      firstName: sampleFirstName?.trim() || 'Sample',
      lastName: sampleLastName?.trim() || 'Candidate',
      email: 'sample@example.com'
    };

    const pdfBuffer = await generateOfferLetterPdf(application, cycle, template, offerDetails, signatureBuffer);
    res.json({
      filename: 'UConsulting-Offer-Letter-Preview.pdf',
      pdf: pdfBuffer.toString('base64')
    });
  } catch (error) {
    console.error('[POST /api/admin/cycles/:cycleId/offer-letter-preview]', error);
    const status = error.message?.includes('template') || error.message?.includes('signature') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to generate offer letter preview' });
  }
});

// List Final Round accepted candidates for a cycle with their offer-letter send status
router.get('/cycles/:cycleId/offer-letter-candidates', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const cycle = await prisma.recruitingCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      return res.status(404).json({ error: 'Recruiting cycle not found' });
    }

    const applications = await prisma.application.findMany({
      where: {
        cycleId,
        status: 'ACCEPTED',
        OR: [
          { finalRoundDecision: 'yes' },
          { currentRound: '5' }
        ]
      },
      include: { candidate: true }
    });

    const candidates = await Promise.all(
      applications.map(async (app) => {
        const latestSend = await findLatestOfferLetterSend(app.id);
        return {
          applicationId: app.id,
          firstName: app.firstName,
          lastName: app.lastName,
          email: app.email,
          status: latestSend?.status || 'not_sent',
          sentAt: latestSend?.createdAt || null,
          messageId: latestSend?.messageId || null
        };
      })
    );

    res.json({ cycleId, cycleName: cycle.name, candidates });
  } catch (error) {
    console.error('[GET /api/admin/cycles/:cycleId/offer-letter-candidates]', error);
    res.status(500).json({ error: 'Failed to load offer letter candidates', details: error.message });
  }
});

// Send offer letters to multiple Final Round accepted candidates in a cycle
router.post('/cycles/:cycleId/send-offer-letters', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const { applicationIds, position, startDate, responseDeadline, force } = req.body;
    const userId = req.user?.id;

    if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
      return res.status(400).json({ error: 'At least one candidate must be selected' });
    }
    if (!position || !position.trim() || !responseDeadline || !responseDeadline.trim()) {
      return res.status(400).json({ error: 'Position and response deadline are required' });
    }

    const cycle = await prisma.recruitingCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      return res.status(404).json({ error: 'Recruiting cycle not found' });
    }

    const { template, signatureBuffer } = await loadAndValidateTemplate(cycleId);
    const deadline = responseDeadline?.trim() || template.responseDeadline || '';
    const offerDetails = { position, startDate, responseDeadline: deadline };

    const results = [];
    for (const applicationId of applicationIds) {
      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { candidate: true }
      });

      if (!application) {
        results.push({ applicationId, success: false, error: 'Application not found' });
        continue;
      }

      if (!isFinalRoundAccepted(application)) {
        results.push({ applicationId, success: false, error: 'Not a Final Round accepted candidate' });
        continue;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!application.email || !emailRegex.test(application.email)) {
        results.push({ applicationId, success: false, error: 'Invalid candidate email address' });
        continue;
      }

      const result = await sendOfferLetterToCandidate(
        application,
        cycle,
        template,
        signatureBuffer,
        offerDetails,
        userId,
        force
      );

      results.push({
        applicationId,
        success: result.success,
        alreadySent: result.alreadySent || false,
        messageId: result.messageId || null,
        error: result.error || null
      });
    }

    res.json({ results });
  } catch (error) {
    console.error('[POST /api/admin/cycles/:cycleId/send-offer-letters]', error);
    const status = error.message?.includes('template') || error.message?.includes('signature') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to send offer letters' });
  }
});

// Flag Document Routes

// Flag a document
router.post('/flag-document', async (req, res) => {
  try {
    const { applicationId, documentType, reason, message } = req.body;
    const flaggedBy = req.user.id;

    // Validate required fields
    if (!applicationId || !documentType || !reason) {
      return res.status(400).json({ error: 'Application ID, document type, and reason are required' });
    }

    // Validate document type
    const validDocumentTypes = ['resume', 'coverLetter', 'video'];
    if (!validDocumentTypes.includes(documentType)) {
      return res.status(400).json({ error: 'Invalid document type. Must be resume, coverLetter, or video' });
    }

    // Check if document is already flagged
    const existingFlag = await prisma.flaggedDocument.findFirst({
      where: {
        applicationId,
        documentType,
        isResolved: false
      }
    });

    if (existingFlag) {
      return res.status(409).json({ error: 'This document is already flagged' });
    }

    // Create the flag
    const flaggedDocument = await prisma.flaggedDocument.create({
      data: {
        applicationId,
        documentType,
        flaggedBy,
        reason,
        message: message || null
      },
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        flagger: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });

    res.status(201).json({
      message: 'Document flagged successfully',
      flaggedDocument
    });
  } catch (error) {
    console.error('[POST /api/admin/flag-document]', error);
    res.status(500).json({ error: 'Failed to flag document' });
  }
});

// Get flagged documents
router.get('/flagged-documents', async (req, res) => {
  try {
    const { resolved } = req.query;
    
    // Get the active cycle first
    const activeCycle = await resolveCycleForRequest(prisma, req);
    
    if (!activeCycle) {
      return res.json([]);
    }
    
    let whereClause = {};
    if (resolved !== undefined) {
      whereClause.isResolved = resolved === 'true';
    }
    
    // Filter by active cycle through the application relationship
    whereClause.application = {
      cycleId: activeCycle.id
    };

    const flaggedDocuments = await prisma.flaggedDocument.findMany({
      where: whereClause,
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            major1: true,
            graduationYear: true,
            resumeUrl: true,
            coverLetterUrl: true,
            videoUrl: true,
            candidateId: true,
            cycleId: true
          }
        },
        flagger: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        },
        resolver: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(flaggedDocuments);
  } catch (error) {
    console.error('[GET /api/admin/flagged-documents]', error);
    res.status(500).json({ error: 'Failed to fetch flagged documents' });
  }
});

// Resolve a flagged document
router.patch('/flagged-documents/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const resolvedBy = req.user.id;

    const flaggedDocument = await prisma.flaggedDocument.findUnique({
      where: { id }
    });

    if (!flaggedDocument) {
      return res.status(404).json({ error: 'Flagged document not found' });
    }

    if (flaggedDocument.isResolved) {
      return res.status(400).json({ error: 'Document is already resolved' });
    }

    const updatedDocument = await prisma.flaggedDocument.update({
      where: { id },
      data: {
        isResolved: true,
        resolvedBy,
        resolvedAt: new Date()
      },
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        flagger: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        },
        resolver: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });

    res.json({
      message: 'Document resolved successfully',
      flaggedDocument: updatedDocument
    });
  } catch (error) {
    console.error('[PATCH /api/admin/flagged-documents/:id/resolve]', error);
    res.status(500).json({ error: 'Failed to resolve flagged document' });
  }
});

// Unresolve a flagged document
router.patch('/flagged-documents/:id/unresolve', async (req, res) => {
  try {
    const { id } = req.params;

    const flaggedDocument = await prisma.flaggedDocument.findUnique({
      where: { id }
    });

    if (!flaggedDocument) {
      return res.status(404).json({ error: 'Flagged document not found' });
    }

    if (!flaggedDocument.isResolved) {
      return res.status(400).json({ error: 'Document is not resolved' });
    }

    const updatedDocument = await prisma.flaggedDocument.update({
      where: { id },
      data: {
        isResolved: false,
        resolvedBy: null,
        resolvedAt: null
      },
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        flagger: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });

    res.json({
      message: 'Document unresolved successfully',
      flaggedDocument: updatedDocument
    });
  } catch (error) {
    console.error('[PATCH /api/admin/flagged-documents/:id/unresolve]', error);
    res.status(500).json({ error: 'Failed to unresolve flagged document' });
  }
});

// Send flagged document back to members for grading
router.patch('/flagged-documents/:id/send-back', async (req, res) => {
  try {
    const { id } = req.params;

    const flaggedDocument = await prisma.flaggedDocument.findUnique({
      where: { id },
      include: {
        application: {
          include: {
            candidate: {
              include: {
                assignedGroup: {
                  include: {
                    ...groupMemberUserInclude
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!flaggedDocument) {
      return res.status(404).json({ error: 'Flagged document not found' });
    }

    // Delete the flag to send it back to members
    await prisma.flaggedDocument.delete({
      where: { id }
    });

    // Get the group members who should grade this document
    const group = flaggedDocument.application.candidate?.assignedGroup;
    const groupMembers = group ? getGroupMemberUsers(group) : [];

    res.json({
      message: 'Document sent back to members for grading',
      groupMembers: groupMembers.map(member => ({
        id: member.id,
        fullName: member.fullName,
        email: member.email,
        profileImage: member.profileImage
      })),
      candidate: {
        id: flaggedDocument.application.candidate?.id,
        firstName: flaggedDocument.application.firstName,
        lastName: flaggedDocument.application.lastName,
        email: flaggedDocument.application.email
      },
      documentType: flaggedDocument.documentType
    });
  } catch (error) {
    console.error('[PATCH /api/admin/flagged-documents/:id/send-back]', error);
    res.status(500).json({ error: 'Failed to send document back to members' });
  }
});

// Delete a flagged document
router.delete('/flagged-documents/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const flaggedDocument = await prisma.flaggedDocument.findUnique({
      where: { id }
    });

    if (!flaggedDocument) {
      return res.status(404).json({ error: 'Flagged document not found' });
    }

    await prisma.flaggedDocument.delete({
      where: { id }
    });

    res.json({ message: 'Flagged document deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/admin/flagged-documents/:id]', error);
    res.status(500).json({ error: 'Failed to delete flagged document' });
  }
});

// Update resume score (admin only)
router.patch('/resume-scores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { overallScore, scoreOne, scoreTwo, scoreThree, notes, adminScore, adminNotes } = req.body;

    const resumeScore = await prisma.resumeScore.findUnique({
      where: { id }
    });

    if (!resumeScore) {
      return res.status(404).json({ error: 'Resume score not found' });
    }

    const updateData = {};
    if (scoreOne !== undefined) updateData.scoreOne = scoreOne !== null ? parseInt(scoreOne) : null;
    if (scoreTwo !== undefined) updateData.scoreTwo = scoreTwo !== null ? parseInt(scoreTwo) : null;
    if (scoreThree !== undefined) updateData.scoreThree = scoreThree !== null ? parseInt(scoreThree) : null;
    if (notes !== undefined) updateData.notes = notes;
    if (adminScore !== undefined) updateData.adminScore = adminScore !== null ? parseFloat(adminScore) : null;
    if (adminNotes !== undefined) updateData.adminNotes = adminNotes;
    
    // Calculate overallScore if not explicitly provided but individual scores are updated
    if (overallScore === undefined && (scoreOne !== undefined || scoreTwo !== undefined)) {
      const scores = [
        scoreOne !== undefined ? (scoreOne !== null ? parseInt(scoreOne) : null) : resumeScore.scoreOne,
        scoreTwo !== undefined ? (scoreTwo !== null ? parseInt(scoreTwo) : null) : resumeScore.scoreTwo
      ].filter(score => score !== null && score !== undefined);
      updateData.overallScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) : 0;
    } else if (overallScore !== undefined) {
      updateData.overallScore = parseFloat(overallScore);
    }

    const updatedScore = await prisma.resumeScore.update({
      where: { id },
      data: updateData,
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });

    res.json(updatedScore);
  } catch (error) {
    console.error('[PATCH /api/admin/resume-scores/:id]', error);
    res.status(500).json({ error: 'Failed to update resume score' });
  }
});

// Update cover letter score (admin only)
router.patch('/cover-letter-scores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { overallScore, scoreOne, scoreTwo, scoreThree, notesOne, adminScore, adminNotes } = req.body;

    const coverLetterScore = await prisma.coverLetterScore.findUnique({
      where: { id }
    });

    if (!coverLetterScore) {
      return res.status(404).json({ error: 'Cover letter score not found' });
    }

    const updateData = {};
    if (scoreOne !== undefined) updateData.scoreOne = scoreOne !== null ? parseInt(scoreOne) : null;
    if (scoreTwo !== undefined) updateData.scoreTwo = scoreTwo !== null ? parseInt(scoreTwo) : null;
    if (scoreThree !== undefined) updateData.scoreThree = scoreThree !== null ? parseInt(scoreThree) : null;
    if (notesOne !== undefined) updateData.notesOne = notesOne;
    if (adminScore !== undefined) updateData.adminScore = adminScore !== null ? parseFloat(adminScore) : null;
    if (adminNotes !== undefined) updateData.adminNotes = adminNotes;
    
    // Calculate overallScore if not explicitly provided but individual scores are updated
    if (overallScore === undefined && (scoreOne !== undefined || scoreTwo !== undefined || scoreThree !== undefined)) {
      const scores = [
        scoreOne !== undefined ? (scoreOne !== null ? parseInt(scoreOne) : null) : coverLetterScore.scoreOne,
        scoreTwo !== undefined ? (scoreTwo !== null ? parseInt(scoreTwo) : null) : coverLetterScore.scoreTwo,
        scoreThree !== undefined ? (scoreThree !== null ? parseInt(scoreThree) : null) : coverLetterScore.scoreThree
      ].filter(score => score !== null && score !== undefined);
      updateData.overallScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    } else if (overallScore !== undefined) {
      updateData.overallScore = parseFloat(overallScore);
    }

    const updatedScore = await prisma.coverLetterScore.update({
      where: { id },
      data: updateData,
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });

    res.json(updatedScore);
  } catch (error) {
    console.error('[PATCH /api/admin/cover-letter-scores/:id]', error);
    res.status(500).json({ error: 'Failed to update cover letter score' });
  }
});

// Update video score (admin only)
router.patch('/video-scores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { overallScore, scoreOne, scoreTwo, scoreThree, notesOne, adminScore, adminNotes } = req.body;

    const videoScore = await prisma.videoScore.findUnique({
      where: { id }
    });

    if (!videoScore) {
      return res.status(404).json({ error: 'Video score not found' });
    }

    const updateData = {};
    if (scoreOne !== undefined) updateData.scoreOne = scoreOne !== null ? parseInt(scoreOne) : null;
    if (scoreTwo !== undefined) updateData.scoreTwo = scoreTwo !== null ? parseInt(scoreTwo) : null;
    if (scoreThree !== undefined) updateData.scoreThree = scoreThree !== null ? parseInt(scoreThree) : null;
    if (notesOne !== undefined) updateData.notesOne = notesOne;
    if (adminScore !== undefined) updateData.adminScore = adminScore !== null ? parseFloat(adminScore) : null;
    if (adminNotes !== undefined) updateData.adminNotes = adminNotes;
    
    // Calculate overallScore if not explicitly provided but individual scores are updated
    if (overallScore === undefined && scoreOne !== undefined) {
      updateData.overallScore = scoreOne !== null ? parseInt(scoreOne) : 0;
    } else if (overallScore !== undefined) {
      updateData.overallScore = parseFloat(overallScore);
    }

    const updatedScore = await prisma.videoScore.update({
      where: { id },
      data: updateData,
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      }
    });

    res.json(updatedScore);
  } catch (error) {
    console.error('[PATCH /api/admin/video-scores/:id]', error);
    res.status(500).json({ error: 'Failed to update video score' });
  }
});

// Update application testFor note (admin only)
router.patch('/applications/:id/test-for', async (req, res) => {
  try {
    const { id } = req.params;
    const { testFor } = req.body;

    const application = await prisma.application.findUnique({
      where: { id }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const updatedApplication = await prisma.application.update({
      where: { id },
      data: { testFor: testFor || null },
      select: {
        id: true,
        testFor: true,
        firstName: true,
        lastName: true,
        candidateId: true
      }
    });

    res.json(updatedApplication);
  } catch (error) {
    console.error('[PATCH /api/admin/applications/:id/test-for]', error);
    res.status(500).json({ error: 'Failed to update testFor note' });
  }
});

// Delete application (admin only)
router.delete('/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const application = await prisma.application.findUnique({
      where: { id }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Delete related records first (comments, evaluations, etc.)
    await prisma.comment.deleteMany({
      where: { applicationId: id }
    });

    await prisma.interviewEvaluation.deleteMany({
      where: { applicationId: id }
    });

    await prisma.firstRoundInterviewEvaluation.deleteMany({
      where: { applicationId: id }
    });

    await prisma.flaggedDocument.deleteMany({
      where: { applicationId: id }
    });

    // Delete the application
    await prisma.application.delete({
      where: { id }
    });

    res.json({ message: 'Application deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/admin/applications/:id]', error);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

// ===========================================================================
// Get to Know UC (GTKUC) meeting-slot administration
// Admin-wide management of every member's slots, signups, attendance, and the
// communications log. All routes are already protected by requireAuth +
// requireAdmin via router.use() at the top of this file.
// ===========================================================================

// Admin: list ALL meeting slots (across every member) with host details,
// signups, and the communications log. Clients compute slot count / attendance
// rate from this payload (optionally after filtering by cycle client-side).
// Newest-created first, so a slot someone just opened is at the top of the list.
router.get('/meeting-slots', async (req, res) => {
  try {
    const slots = await prisma.meetingSlot.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        member: {
          select: { id: true, fullName: true, email: true, profileImage: true, graduationClass: true, role: true }
        },
        signups: {
          orderBy: { createdAt: 'asc' }
        },
        communications: {
          orderBy: { sentAt: 'desc' }
        }
      }
    });

    // Convenience aggregate stats over the full (unfiltered) set.
    const totalSlots = slots.length;
    const totalSignups = slots.reduce((sum, s) => sum + s.signups.length, 0);
    const attendedSignups = slots.reduce(
      (sum, s) => sum + s.signups.filter((su) => su.attended).length,
      0
    );
    const totalCapacity = slots.reduce((sum, s) => sum + (s.capacity || 0), 0);

    res.json({
      slots,
      stats: {
        totalSlots,
        totalSignups,
        attendedSignups,
        totalCapacity,
        attendanceRate: totalSignups > 0 ? attendedSignups / totalSignups : 0
      }
    });
  } catch (error) {
    console.error('[GET /api/admin/meeting-slots]', error);
    res.status(500).json({ error: 'Failed to fetch meeting slots' });
  }
});

// Admin: create a meeting slot on behalf of any member (defaults to self).
router.post('/meeting-slots', async (req, res) => {
  try {
    const { memberId, location, startTime, endTime, capacity } = req.body || {};
    if (!location || !startTime) {
      return res.status(400).json({ error: 'Location and start time are required' });
    }

    const hostId = memberId || req.user.id;
    const host = await prisma.user.findUnique({ where: { id: hostId } });
    if (!host) {
      return res.status(400).json({ error: 'Host member not found' });
    }

    // Admins host GTKUC slots too, so opening one for themselves goes through
    // the same per-cycle profile confirmation members get. Slots an admin opens
    // on behalf of someone else aren't gated — that host confirms their own
    // profile, and until they do candidates simply see no profile card.
    if (hostId === req.user.id) {
      const profileState = await loadGtkucProfileState(req.user.id);
      if (profileState.confirmationRequired) {
        return res.status(409).json({
          error: 'Confirm your Get to Know UC profile before opening a timeslot',
          code: 'GTKUC_PROFILE_CONFIRMATION_REQUIRED',
          missingFields: missingProfileFields(profileState.profile, profileState.user)
        });
      }
    }

    const slot = await prisma.meetingSlot.create({
      data: {
        memberId: hostId,
        location,
        startTime: localInputToUTC(startTime),
        endTime: endTime ? localInputToUTC(endTime) : null,
        capacity: Number.isInteger(capacity) ? capacity : 2
      },
      include: {
        member: { select: { id: true, fullName: true, email: true, profileImage: true, graduationClass: true, role: true } },
        signups: true,
        communications: { orderBy: { sentAt: 'desc' } }
      }
    });

    res.json(slot);

    // After the response, as in the member route: a slow mail server must not
    // hold open a request whose slot already exists.
    notifyHostSlotCreated(slot, host).catch((err) =>
      console.error('[POST /api/admin/meeting-slots] slot confirmation failed', err)
    );
  } catch (error) {
    console.error('[POST /api/admin/meeting-slots]', error);
    res.status(500).json({ error: 'Failed to create meeting slot' });
  }
});

// Admin: update any meeting slot (full override — including host and time).
//
// Rescheduling here used to write the new time and say nothing, so signed-up
// candidates and the host member kept a calendar entry for a meeting that had
// moved. It now goes through the same service as the member route, which emails
// them; an admin changing only capacity or the host still sends nothing.
router.put('/meeting-slots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { memberId, location, startTime, endTime, capacity } = req.body || {};

    const { slot, notified } = await updateMeetingSlot({
      slotId: id,
      patch: { memberId, location, startTime, endTime, capacity },
      actorId: req.user.id,
      allowHostChange: true
    });

    res.json({ ...slot, notified });
  } catch (error) {
    if (error instanceof SlotUpdateError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[PUT /api/admin/meeting-slots/:id]', error);
    res.status(500).json({ error: 'Failed to update meeting slot' });
  }
});

// Admin: delete any meeting slot; notify + log cancellation for every signup.
router.delete('/meeting-slots/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existingSlot = await prisma.meetingSlot.findUnique({
      where: { id },
      include: { signups: true, member: { select: { fullName: true, email: true, profileImage: true } } }
    });

    if (!existingSlot) {
      return res.status(404).json({ error: 'Meeting slot not found' });
    }

    const memberName = existingSlot.member?.fullName || 'UC Consulting Member';

    // Notify everyone involved: all signed-up candidates AND the host member.
    const notifications = [];

    if (existingSlot.signups.length > 0) {
      existingSlot.signups.forEach((signup) => {
        notifications.push(
          sendAndLogMeetingCommunication(
            () => sendMeetingCancellationEmail(
              signup.email,
              signup.fullName,
              memberName,
              existingSlot.location,
              existingSlot.startTime,
              existingSlot.endTime,
              {
                invite: candidateMeetingInvite({
                  slot: existingSlot,
                  signupId: signup.id,
                  candidateEmail: signup.email,
                  candidateName: signup.fullName,
                  hostName: memberName,
                  method: 'CANCEL',
                }),
              }
            ),
            {
              slotId: existingSlot.id,
              signupId: signup.id,
              type: 'CANCELLATION',
              recipient: signup.email,
              subject: MEETING_COMM_SUBJECTS.CANCELLATION,
            }
          )
        );
      });
    }

    // Notify the host member their slot was cancelled.
    if (existingSlot.member?.email) {
      notifications.push(
        sendAndLogMeetingCommunication(
          () => sendMeetingCancellationToMember(
            existingSlot.member.email,
            memberName,
            existingSlot.location,
            existingSlot.startTime,
            existingSlot.endTime,
            {
              signupCount: existingSlot.signups.length,
              invite: hostMeetingInvite({
                slot: existingSlot,
                hostEmail: existingSlot.member.email,
                hostName: memberName,
                method: 'CANCEL',
              }),
            }
          ),
          {
            slotId: existingSlot.id,
            signupId: null,
            type: 'CANCELLATION',
            recipient: existingSlot.member.email,
            subject: MEETING_COMM_SUBJECTS.CANCELLATION_TO_HOST,
          }
        )
      );
    }

    await Promise.allSettled(notifications);

    // Cascade-delete signups and the slot. The slot's communications rows are
    // removed with it (onDelete: Cascade) — moot once the slot itself is gone.
    await prisma.$transaction(async (tx) => {
      await tx.meetingSignup.deleteMany({ where: { slotId: id } });
      await tx.meetingSlot.delete({ where: { id } });
    });

    const recipientCount = existingSlot.signups.length + (existingSlot.member?.email ? 1 : 0);
    const message = recipientCount > 0
      ? `Meeting slot deleted. Cancellation emails sent to ${existingSlot.signups.length} candidate(s) and the host member.`
      : 'Meeting slot deleted successfully.';

    res.json({ message });
  } catch (error) {
    console.error('[DELETE /api/admin/meeting-slots/:id]', error);
    res.status(500).json({ error: 'Failed to delete meeting slot' });
  }
});

// Admin: list every member's GTKUC profile state (for the visibility controls).
router.get('/gtkuc-profiles', async (req, res) => {
  try {
    const members = await prisma.user.findMany({
      where: { role: { in: ['MEMBER', 'ADMIN'] }, isActive: true },
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        email: true,
        profileImage: true,
        graduationClass: true,
        gtkucProfile: true
      }
    });

    res.json(
      members.map((member) => ({
        id: member.id,
        fullName: member.fullName,
        email: member.email,
        profileImage: member.profileImage,
        graduationClass: member.graduationClass,
        industries: member.gtkucProfile?.industries || [],
        interests: member.gtkucProfile?.interests || [],
        linkedinUrl: member.gtkucProfile?.linkedinUrl || '',
        candidateVisible: member.gtkucProfile?.candidateVisible ?? true,
        hiddenFromGtkuc: member.gtkucProfile?.hiddenFromGtkuc ?? false,
        complete: isProfileComplete(member.gtkucProfile, member),
        missingFields: missingProfileFields(member.gtkucProfile, member)
      }))
    );
  } catch (error) {
    console.error('[GET /api/admin/gtkuc-profiles]', error);
    res.status(500).json({ error: 'Failed to fetch GTKUC profiles' });
  }
});

// Admin: hide/unhide a member from candidate-facing GTKUC.
router.patch('/gtkuc-profiles/:memberId/visibility', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { hiddenFromGtkuc } = req.body || {};

    if (typeof hiddenFromGtkuc !== 'boolean') {
      return res.status(400).json({ error: 'hiddenFromGtkuc must be a boolean' });
    }

    const member = await prisma.user.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const profile = await prisma.memberGtkucProfile.upsert({
      where: { memberId },
      create: { memberId, industries: [], interests: [], hiddenFromGtkuc },
      update: { hiddenFromGtkuc }
    });

    res.json({ memberId, hiddenFromGtkuc: profile.hiddenFromGtkuc });
  } catch (error) {
    console.error('[PATCH /api/admin/gtkuc-profiles/:memberId/visibility]', error);
    res.status(500).json({ error: 'Failed to update GTKUC visibility' });
  }
});

// Admin: mark attendance for any signup. Setting attended=true feeds the
// existing dynamic candidate-scoring bonus (read from attended elsewhere).
router.patch('/meeting-signups/:id/attendance', async (req, res) => {
  try {
    const { id } = req.params;
    const { attended } = req.body || {};

    const signup = await prisma.meetingSignup.findUnique({ where: { id } });
    if (!signup) {
      return res.status(404).json({ error: 'Signup not found' });
    }

    const updated = await prisma.meetingSignup.update({
      where: { id },
      data: { attended: Boolean(attended) }
    });

    res.json(updated);
  } catch (error) {
    console.error('[PATCH /api/admin/meeting-signups/:id/attendance]', error);
    res.status(500).json({ error: 'Failed to update attendance' });
  }
});

// Admin: delete any signup; notify + log cancellation (slot remains, so the
// communication persists with signupId set null).
router.delete('/meeting-signups/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const signup = await prisma.meetingSignup.findUnique({
      where: { id },
      include: { slot: { include: { member: { select: { fullName: true, email: true, profileImage: true } } } } }
    });

    if (!signup) {
      return res.status(404).json({ error: 'Signup not found' });
    }

    const memberName = signup.slot.member?.fullName || 'UC Consulting Member';

    // Notify the candidate their signup was cancelled...
    await sendAndLogMeetingCommunication(
      () => sendMeetingCancellationEmail(
        signup.email,
        signup.fullName,
        memberName,
        signup.slot.location,
        signup.slot.startTime,
        signup.slot.endTime,
        {
          invite: candidateMeetingInvite({
            slot: signup.slot,
            signupId: signup.id,
            candidateEmail: signup.email,
            candidateName: signup.fullName,
            hostName: memberName,
            method: 'CANCEL',
          }),
        }
      ),
      {
        slotId: signup.slotId,
        signupId: signup.id,
        type: 'CANCELLATION',
        recipient: signup.email,
        subject: MEETING_COMM_SUBJECTS.CANCELLATION,
      }
    );

    // ...and notify the host member the spot reopened.
    if (signup.slot.member?.email) {
      const hostAttendees = await bookedNames(signup.slotId, { excludingSignupId: signup.id });
      await sendAndLogMeetingCommunication(
        () => sendMeetingCancellationToMember(
          signup.slot.member.email,
          memberName,
          signup.slot.location,
          signup.slot.startTime,
          signup.slot.endTime,
          {
            candidateName: signup.fullName,
            invite: hostMeetingInvite({
              slot: signup.slot,
              hostEmail: signup.slot.member.email,
              hostName: memberName,
              attendeeNames: hostAttendees,
            }),
          }
        ),
        {
          slotId: signup.slotId,
          signupId: signup.id,
          type: 'CANCELLATION',
          recipient: signup.slot.member.email,
          subject: MEETING_COMM_SUBJECTS.CANCELLATION_TO_HOST,
        }
      );
    }

    await prisma.meetingSignup.delete({ where: { id } });

    res.json({
      message: 'Signup deleted successfully. Cancellation email sent.',
      deletedSignup: { id: signup.id, fullName: signup.fullName, email: signup.email }
    });
  } catch (error) {
    console.error('[DELETE /api/admin/meeting-signups/:id]', error);
    res.status(500).json({ error: 'Failed to delete signup' });
  }
});

// Preview graduated-member deactivation for a selected graduation class.
// Returns eligible members, blocked members (active/current-cycle), and ineligible
// members (not yet reached deactivation date), with relation counts.
router.post('/users/deactivate-preview', async (req, res) => {
  try {
    const { graduationClass } = req.body;

    if (typeof graduationClass !== 'string' || graduationClass.trim().length === 0) {
      return res.status(400).json({ error: 'graduationClass is required' });
    }

    // Union of both audience pointers on purpose: a member still staffed on the
    // admin-facing cycle must not be deactivatable just because candidates have
    // already moved on to the next one.
    const activeCycles = await prisma.recruitingCycle.findMany({
      where: { OR: [{ isActive: true }, { isAdminActive: true }] },
      select: { id: true }
    });
    const activeCycleIds = new Set(activeCycles.map(c => c.id));

    const result = await getDeactivationCandidates({
      graduationClass,
      requesterId: req.user.id,
      activeCycleIds
    });

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('[POST /api/admin/users/deactivate-preview]', error);
    res.status(500).json({ error: 'Failed to generate deactivation preview' });
  }
});

// Deactivate graduated members for a selected class.
// Requires typed confirmation equal to the graduation class and a matching count.
router.post('/users/deactivate', async (req, res) => {
  try {
    const { graduationClass, confirmationText, confirmedCount, dryRun } = req.body;

    if (typeof graduationClass !== 'string' || graduationClass.trim().length === 0) {
      return res.status(400).json({ error: 'graduationClass is required' });
    }

    const normalizedClass = graduationClass.trim();
    if (normalizedClass.length > 100) {
      return res.status(400).json({ error: 'Invalid graduation class' });
    }

    if (confirmationText !== normalizedClass) {
      return res.status(400).json({ error: 'Confirmation text does not match graduation class' });
    }

    if (parseGraduationYear(normalizedClass) === null) {
      return res.status(400).json({ error: 'Could not determine a graduation year from the class value' });
    }

    // Union of both audience pointers on purpose: a member still staffed on the
    // admin-facing cycle must not be deactivatable just because candidates have
    // already moved on to the next one.
    const activeCycles = await prisma.recruitingCycle.findMany({
      where: { OR: [{ isActive: true }, { isAdminActive: true }] },
      select: { id: true }
    });
    const activeCycleIds = new Set(activeCycles.map(c => c.id));

    const preview = await getDeactivationCandidates({
      graduationClass: normalizedClass,
      requesterId: req.user.id,
      activeCycleIds
    });

    if (preview.error) {
      return res.status(400).json({ error: preview.error });
    }

    if (typeof confirmedCount !== 'number' || confirmedCount !== preview.eligibleCount) {
      return res.status(400).json({ error: 'Confirmed count does not match eligible count' });
    }

    if (dryRun) {
      return res.json({ ...preview, dryRun: true });
    }

    if (preview.eligible.length === 0) {
      return res.json({ ...preview, deactivatedCount: 0, dryRun: false });
    }

    const eligibleIds = preview.eligible.map(u => u.id);

    const [updateResult] = await prisma.$transaction([
      prisma.user.updateMany({
        where: { id: { in: eligibleIds } },
        data: {
          isActive: false,
          deactivatedAt: new Date(),
          deactivatedBy: req.user.id
        }
      })
    ]);

    // Cut existing sessions immediately rather than after the cache TTL
    invalidateUserCache(eligibleIds);

    // Their resumes stop being assignable via the pool gates, but assignments
    // already handed to a client are snapshots and would otherwise survive the
    // deactivation. Failing here must not un-deactivate anyone, so it is
    // reported rather than thrown.
    let revoked = 0;
    try {
      ({ revoked } = await revokeTalentPoolAccess(eligibleIds, req.user.id));
    } catch (error) {
      console.error('[POST /api/admin/users/deactivate] talent pool revocation failed', error);
    }

    res.json({
      ...preview,
      dryRun: false,
      deactivatedCount: updateResult.count,
      talentPoolAssignmentsRevoked: revoked
    });
  } catch (error) {
    console.error('[POST /api/admin/users/deactivate]', error);
    res.status(500).json({ error: 'Failed to deactivate users' });
  }
});

// ---------------------------------------------------------------------------
// Talent Partner Network (TPN)
// ---------------------------------------------------------------------------
// Opt-in is captured on the application form (see Application.talentPoolOptIn).
// Requires auth + admin via router.use() at the top of this file.

// Returns the opt-in breakdown - yes, no, and never asked - plus the full
// applicant roster. Only an explicit no makes someone unassignable, so the
// roster is everyone, with their answer on each row rather than as a filter.
// `cycleId` is optional; omitted means the active cycle, `all` means every cycle.
router.get('/talent-pool/stats', async (req, res) => {
  try {
    const cycles = await prisma.recruitingCycle.findMany({
      select: { id: true, name: true, isActive: true, isAdminActive: true },
      orderBy: { createdAt: 'desc' }
    });
    // Omitted cycleId means "the cycle I am working in", which on an admin route is
    // the admin pointer, not the one candidates see.
    const defaultCycle = await resolveCycleForRequest(prisma, req);

    const requested = req.query.cycleId;
    let cycleFilter;
    let selectedCycleId;

    if (requested === 'all') {
      cycleFilter = {};
      selectedCycleId = 'all';
    } else {
      const target = requested
        ? cycles.find((c) => c.id === requested)
        : cycles.find((c) => c.id === defaultCycle?.id);
      if (!target) {
        return res.status(404).json({ error: 'Recruiting cycle not found' });
      }
      cycleFilter = { cycleId: target.id };
      selectedCycleId = target.id;
    }

    const applications = await prisma.application.findMany({
      where: cycleFilter,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        studentId: true,
        candidateId: true,
        major1: true,
        graduationYear: true,
        resumeUrl: true,
        submittedAt: true,
        talentPoolOptIn: true,
        cycle: { select: { id: true, name: true } }
      },
      orderBy: { submittedAt: 'desc' }
    });

    // Across all cycles the same person appears once per cycle they applied in.
    // Collapse those to one row each so the roster lists people rather than
    // submissions. Rows arrive newest-first, so the first one seen for a person
    // is their latest application - which carries their most recent resume and
    // their most recent opt-in answer.
    //
    // Only done for the all-cycles view; within a single cycle each row is
    // already a distinct applicant.
    let applicants = applications;
    let duplicatesCollapsed = 0;

    if (selectedCycleId === 'all') {
      const seen = new Map();
      for (const app of applications) {
        const key = app.candidateId
          || (app.email ? `email:${app.email.trim().toLowerCase()}` : null)
          || (app.studentId ? `student:${app.studentId.trim()}` : null)
          || `app:${app.id}`;
        const existing = seen.get(key);
        if (!existing) {
          seen.set(key, { ...app, priorApplications: 0 });
        } else {
          existing.priorApplications += 1;
          duplicatesCollapsed += 1;
        }
      }
      applicants = Array.from(seen.values());
    }

    const registeredClients = await prisma.talentPartnerClient.count({
      where: { user: { isActive: true } }
    });

    // Self-registered UCLA students. Deliberately NOT folded into the opt-in
    // breakdown above: that one counts applicants within a recruiting cycle,
    // and an external account belongs to no cycle at all. Adding them would
    // make the percentages answer a question nobody asked.
    // Counted off external_resumes rather than off users.isExternalTalent.
    //
    // The two are no longer the same set. A resume reaches this pool by either
    // route now: a self-registered student uploading one in the talent portal,
    // or a candidate with no application answering yes to the sharing question
    // during onboarding. The second is role USER with isExternalTalent false, so
    // counting accounts by that flag while counting shareable resumes by the
    // table produced "2 shareable of 0 verified of 0 self-registered" - three
    // numbers that cannot all be true at once.
    //
    // One user has at most one isCurrent resume (uploading supersedes), so a row
    // count here is a person count.
    const inPool = { isCurrent: true, user: { isActive: true } };
    const [externalAccounts, externalVerified, externalShared, externalRows] = await Promise.all([
      prisma.externalResume.count({ where: inPool }),
      prisma.externalResume.count({
        where: { ...inPool, user: { isActive: true, emailVerifiedAt: { not: null } } }
      }),
      // The number that actually matters: how many are assignable right now.
      prisma.externalResume.count({
        where: {
          ...inPool,
          shareConsent: true,
          consentRevokedAt: null,
          user: { isActive: true, emailVerifiedAt: { not: null } }
        }
      }),
      prisma.externalResume.findMany({
        where: inPool,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          major1: true,
          major2: true,
          graduationYear: true,
          gender: true,
          shareConsent: true,
          consentRevokedAt: true,
          updatedAt: true,
          user: {
            select: { id: true, fullName: true, email: true, emailVerifiedAt: true, isExternalTalent: true }
          }
        }
      })
    ]);

    // Members are the second uploaded-resume pool, and until now the page said
    // nothing about them at all - no count, no roster. Counted and listed the
    // same way, off member_resumes, because "how many members have uploaded?"
    // is the same question as "how many students have?" asked of the other
    // table.
    //
    // The gate here is consent alone. A member is vouched for by having been
    // recruited, so there is no email to verify - which is why this is not the
    // same conjunction the external pool uses.
    const memberPool = { isCurrent: true, member: { isActive: true } };
    const [memberAccounts, memberShared, memberRows] = await Promise.all([
      prisma.memberResume.count({ where: memberPool }),
      prisma.memberResume.count({
        where: { ...memberPool, shareConsent: true, consentRevokedAt: null }
      }),
      prisma.memberResume.findMany({
        where: memberPool,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          major1: true,
          major2: true,
          graduationYear: true,
          gender: true,
          shareConsent: true,
          consentRevokedAt: true,
          updatedAt: true,
          member: { select: { id: true, fullName: true, email: true, graduationClass: true } }
        }
      })
    ]);

    const memberResumes = memberRows.map((r) => ({
      id: r.id,
      userId: r.member.id,
      name: r.member.fullName,
      email: r.member.email,
      graduationYear: r.graduationYear,
      major1: r.major1,
      major2: r.major2,
      gender: r.gender,
      shared: Boolean(r.shareConsent) && !r.consentRevokedAt,
      updatedAt: r.updatedAt
    }));

    // The roster behind those counts. Without it the page can say how many
    // uploaded resumes exist but cannot show a single one of the people, which
    // is the only question an admin actually opens this page to answer.
    const externals = externalRows.map((r) => ({
      id: r.id,
      userId: r.user.id,
      name: r.user.fullName,
      email: r.user.email,
      graduationYear: r.graduationYear,
      major1: r.major1,
      major2: r.major2,
      gender: r.gender,
      emailVerified: Boolean(r.user.emailVerifiedAt),
      // How this person got into the pool. Worth showing: an onboarded
      // applicant is someone recruitment already knows, a portal signup is not.
      source: r.user.isExternalTalent ? 'PORTAL' : 'ONBOARDED',
      shared: Boolean(r.shareConsent) && !r.consentRevokedAt,
      // Assignable is the conjunction the pool query actually gates on, so this
      // column and the shareable count can never disagree.
      assignable: Boolean(r.shareConsent) && !r.consentRevokedAt && Boolean(r.user.emailVerifiedAt),
      updatedAt: r.updatedAt
    }));

    // Counted off the same array the roster renders, so the breakdown always
    // agrees with the rows behind it.
    const optedIn = applicants.filter((a) => a.talentPoolOptIn === true).length;
    const optedOut = applicants.filter((a) => a.talentPoolOptIn === false).length;
    const noAnswer = applicants.filter((a) => a.talentPoolOptIn === null).length;

    res.json({
      cycles,
      selectedCycleId,
      optIn: {
        total: applicants.length,
        optedIn,
        optedOut,
        noAnswer
      },
      applicants,
      // True when a row is a unique person rather than a single submission.
      deduplicated: selectedCycleId === 'all',
      duplicatesCollapsed,
      totalApplications: applications.length,
      // resumesUpdatedRecently still has no source of truth: applications store
      // a resume at submission time only, with no "resume last updated"
      // timestamp to count. Reported as null so the UI shows "not tracked yet"
      // rather than a zero that reads like a real measurement.
      resumesUpdatedRecently: null,
      // registeredClients is now real - active CLIENT accounts with a partner
      // row. Deactivated ones are excluded: the number is meant to answer "how
      // many organizations can log in right now?".
      registeredClients,
      // The external talent portal, which is cycle-independent - these counts
      // do not move when the cycle selector does.
      externalTalent: {
        accounts: externalAccounts,
        verified: externalVerified,
        shareable: externalShared
      },
      externals,
      // Cycle-independent for the same reason the external counts are: a member
      // resume belongs to a person, not to a recruiting cycle.
      memberTalent: {
        accounts: memberAccounts,
        shareable: memberShared
      },
      memberResumes
    });
  } catch (error) {
    console.error('Error fetching talent pool stats:', error);
    res.status(500).json({ error: 'Failed to fetch talent pool stats' });
  }
});

// -------------------- Interview Question Bank (ATS-23 / ATS-68) --------------------

// Create a new interview question
router.post('/interview-questions', async (req, res) => {
  try {
    const { cycleId, prompt, guidance, round, category, status } = req.body || {};

    if (!cycleId || !prompt || !round) {
      return res.status(400).json({ error: 'cycleId, prompt, and round are required' });
    }

    const validStatus = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
    const questionStatus = status && validStatus.includes(status) ? status : 'DRAFT';

    const question = await prisma.interviewQuestion.create({
      data: {
        cycleId,
        prompt,
        guidance: guidance || null,
        round,
        category: category || null,
        status: questionStatus,
        createdBy: req.user.id
      }
    });

    res.status(201).json(question);
  } catch (error) {
    console.error('[POST /api/admin/interview-questions]', error);
    res.status(500).json({ error: 'Failed to create interview question' });
  }
});

// List and filter interview questions (admin sees all)
router.get('/interview-questions', async (req, res) => {
  try {
    const { cycleId, round, category, status } = req.query || {};
    const where = {};
    if (cycleId) where.cycleId = String(cycleId);
    if (round) where.round = String(round);
    if (category) where.category = String(category);
    if (status) where.status = String(status);

    const questions = await prisma.interviewQuestion.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    res.json(questions);
  } catch (error) {
    console.error('[GET /api/admin/interview-questions]', error);
    res.status(500).json({ error: 'Failed to fetch interview questions' });
  }
});

// Update an interview question
router.put('/interview-questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { prompt, guidance, round, category } = req.body || {};

    if (!prompt || !round) {
      return res.status(400).json({ error: 'prompt and round are required' });
    }

    const question = await prisma.interviewQuestion.update({
      where: { id },
      data: {
        prompt,
        guidance: guidance || null,
        round,
        category: category || null
      }
    });

    res.json(question);
  } catch (error) {
    console.error('[PUT /api/admin/interview-questions/:id]', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Interview question not found' });
    }
    res.status(500).json({ error: 'Failed to update interview question' });
  }
});

// Distinct category and round values in use, for filter dropdowns. Both columns are
// free text, so the only source of truth for "what can I filter by" is the data itself.
// Registered ahead of the /:id routes so "facets" is never read as an id.
router.get('/interview-questions/facets', async (req, res) => {
  try {
    const { cycleId } = req.query || {};
    const where = {};
    if (cycleId) where.cycleId = String(cycleId);

    const [categories, rounds] = await Promise.all([
      prisma.interviewQuestion.findMany({
        where: { ...where, category: { not: null } },
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' }
      }),
      prisma.interviewQuestion.findMany({
        where,
        distinct: ['round'],
        select: { round: true },
        orderBy: { round: 'asc' }
      })
    ]);

    res.json({
      categories: categories.map((c) => c.category).filter(Boolean),
      rounds: rounds.map((r) => r.round).filter(Boolean)
    });
  } catch (error) {
    console.error('[GET /api/admin/interview-questions/facets]', error);
    res.status(500).json({ error: 'Failed to fetch interview question facets' });
  }
});

// Update question status (DRAFT / PUBLISHED / ARCHIVED)
router.patch('/interview-questions/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    const validStatus = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

    if (!status || !validStatus.includes(status)) {
      return res.status(400).json({ error: 'status must be DRAFT, PUBLISHED, or ARCHIVED' });
    }

    const question = await prisma.interviewQuestion.update({
      where: { id },
      data: { status }
    });

    res.json(question);
  } catch (error) {
    console.error('[PATCH /api/admin/interview-questions/:id/status]', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Interview question not found' });
    }
    res.status(500).json({ error: 'Failed to update interview question status' });
  }
});

// Permanently delete a bank question. Session questions are independent snapshots, so
// they survive this - but their questionBankId would otherwise point at a row that no
// longer exists, so it is cleared in the same transaction.
router.delete('/interview-questions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [detached] = await prisma.$transaction([
      prisma.interviewSessionQuestion.updateMany({
        where: { questionBankId: id },
        data: { questionBankId: null }
      }),
      prisma.interviewQuestion.delete({ where: { id } })
    ]);

    res.json({ success: true, detachedSessionQuestions: detached.count });
  } catch (error) {
    console.error('[DELETE /api/admin/interview-questions/:id]', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Interview question not found' });
    }
    res.status(500).json({ error: 'Failed to delete interview question' });
  }
});

// -------------------- Referrals --------------------

// Every referral in a cycle, including the ones still waiting for their person
// to apply. `status=PENDING` is the queue worth watching: a member vouched for
// someone who has not shown up yet, and nobody has to do anything about it
// until they do.
router.get('/referrals', async (req, res) => {
  try {
    const { status } = req.query || {};
    const cycle = await resolveCycleForRequest(prisma, req);
    if (!cycle) {
      return res.json([]);
    }

    const where = { cycleId: cycle.id };
    if (status === 'PENDING') where.candidateId = null;
    if (status === 'ATTACHED') where.candidateId = { not: null };

    const referrals = await prisma.referral.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        candidate: { select: { id: true, firstName: true, lastName: true, email: true } },
        referredBy: { select: { id: true, fullName: true, email: true } }
      }
    });

    // A sealed candidate keeps their name on the row and loses the link
    // through to their record, which enforces its own seal anyway.
    const isLocked = await lockedRowPredicate(req, referrals);

    res.json(
      referrals.map((referral) => ({
        id: referral.id,
        referrerName: referral.referrerName,
        relationship: referral.relationship,
        source: referral.source,
        referredName: referredDisplayName(referral),
        referredBy: referral.referredBy,
        createdAt: referral.createdAt,
        claimedAt: referral.claimedAt,
        status: referral.candidateId ? 'ATTACHED' : 'PENDING',
        candidateId: isLocked(referral) ? null : referral.candidateId,
        locked: isLocked(referral)
      }))
    );
  } catch (error) {
    console.error('[GET /api/admin/referrals]', error);
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

// Match a pending referral to a candidate by hand. This is the escape hatch for
// everything name matching will not decide on its own: a member picked "Other"
// for someone already in the system, the name was spelled differently enough to
// miss, or two applicants share it and the claim was held back on purpose.
router.patch('/referrals/:id', async (req, res) => {
  try {
    const candidateId = typeof req.body?.candidateId === 'string' ? req.body.candidateId.trim() : '';
    if (!candidateId) {
      return res.status(400).json({ error: 'candidateId is required' });
    }

    const { notFound, sealed, referral } = await attachReferralToCandidate({
      referralId: req.params.id,
      candidateId
    });

    if (notFound === 'referral') return res.status(404).json({ error: 'Referral not found' });
    if (notFound === 'candidate') return res.status(404).json({ error: 'Candidate not found' });
    if (sealed) return sendRecordLocked(res);

    res.json(referral);
  } catch (error) {
    console.error('[PATCH /api/admin/referrals/:id]', error);
    res.status(500).json({ error: 'Failed to attach referral' });
  }
});

// Candidate search for the admin matcher. Unlike the member-facing one this is
// not scoped to a cycle: a referral may well belong to someone who applied in a
// different one.
router.get('/referral-candidates', async (req, res) => {
  try {
    const query = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2) return res.json([]);

    const candidates = await prisma.candidate.findMany({
      where: {
        recordsLockedAt: null,
        OR: [
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } }
        ]
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 20
    });

    res.json(candidates);
  } catch (error) {
    console.error('[GET /api/admin/referral-candidates]', error);
    res.status(500).json({ error: 'Failed to search candidates' });
  }
});

export default router;