import express from 'express';
import multer from 'multer';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin, invalidateUserCache } from '../middleware/auth.js';
import { syncEventAttendance, syncEventRSVP, syncMemberEventRSVP, syncAllEventForms } from '../services/syncEventResponses.js';
import syncFormResponses from '../services/syncResponses.js';
import { sendRSVPConfirmation, sendAttendanceConfirmation, formatEventDate, sendMeetingCancellationEmail, sendMeetingCancellationToMember, sendOfferLetter } from '../services/emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from '../services/meetingComms.js';
import { localInputToUTC } from '../utils/timezoneUtils.js';
import {
  getDeactivationCandidates,
  parseGraduationYear
} from '../services/userDeactivation.js';
import {
  getGroupMemberUsers,
  getGroupMemberIds,
  groupMemberUserInclude
} from '../utils/groupMembers.js';
import { isProfileComplete, missingProfileFields } from '../utils/gtkucProfile.js';
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
import {
  activateCycleExclusively,
  isActiveCycleConflict,
  ActiveCycleConflictError
} from '../services/activeCycle.js';

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

// Get dashboard stats
router.get('/stats', async (req, res) => {
  try {
    // Wrap all database calls in try-catch blocks to handle individual failures
    let active = null;
    try {
      active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
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
      const roundToStage = {
        '1': 'RESUME_REVIEW',
        '2': 'COFFEE_CHAT',
        '3': 'FIRST_ROUND',
        '4': 'FINAL_ROUND'
      };
      
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
    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
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
      data: candidates,
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

    res.json(candidates);
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
    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
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

// Process decisions with emails and round advancement
router.post('/process-decisions', async (req, res) => {
  try {
    console.log('Starting decision processing...');
    
    // Check if emails should be sent (default to true for backward compatibility)
    const sendEmails = req.body.sendEmails !== false;
    console.log('Send emails:', sendEmails);
    
    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    console.log('Active cycle:', active.name);

    // Get applications in Resume Review round (currentRound = '1') only
    const applications = await prisma.application.findMany({
      where: {
        cycleId: active.id,
        currentRound: '1'
      },
      include: {
        candidate: true // Just include the candidate, no need for nested user
      }
    });

    console.log('Applications to process:', applications.length);
    console.log('Sample application:', applications[0]);

    if (applications.length === 0) {
      return res.status(400).json({ error: 'No applications found in Resume Review round.' });
    }

    // Import email functions
    let sendAcceptanceEmail, sendRejectionEmail;
    try {
      const emailModule = await import('../services/emailNotifications.js');
      sendAcceptanceEmail = emailModule.sendAcceptanceEmail;
      sendRejectionEmail = emailModule.sendRejectionEmail;
      console.log('Email services imported successfully');
      
      // Verify the functions exist
      if (typeof sendAcceptanceEmail !== 'function' || typeof sendRejectionEmail !== 'function') {
        throw new Error('Email service functions not found');
      }
    } catch (importError) {
      console.error('Failed to import email services:', importError);
      return res.status(500).json({ 
        error: 'Failed to import email services', 
        details: importError.message 
      });
    }

    const results = {
      accepted: [],
      rejected: [],
      errors: [],
      emailsSent: 0,
      emailsFailed: 0
    };

    // Process each application
    for (const application of applications) {
      try {
        if (!application.candidate) {
          results.errors.push({
            applicationId: application.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            error: 'No candidate associated with application'
          });
          continue;
        }

        console.log(`Processing application ${application.id} for candidate ${application.candidate.id}: ${application.firstName} ${application.lastName}`);
        
        // Get the decision from the database (approved field)
        let decision = null;
        if (application.approved === true) {
          decision = 'yes';
        } else if (application.approved === false) {
          decision = 'no';
        }
        // Note: approved === null means no decision or intermediate decision (maybe_yes/maybe_no)
        
        console.log(`Application ${application.id}: decision = ${decision} (approved = ${application.approved})`);
        
        if (!decision) {
          // Check if there's a comment indicating an intermediate decision
          const latestComment = await prisma.comment.findFirst({
            where: { applicationId: application.id },
            orderBy: { createdAt: 'desc' }
          });
          
          let errorMessage = 'No decision provided (approved field is null)';
          if (latestComment && latestComment.content.includes('Maybe -')) {
            errorMessage = 'Intermediate decision provided (Maybe - Yes/No) - needs final decision';
          }
          
          results.errors.push({
            applicationId: application.id,
            candidateId: application.candidate.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            error: errorMessage
          });
          continue;
        }

        if (decision === 'yes') {
          // Accept candidate - advance to coffee chat round
          console.log(`Updating application ${application.id} to coffee chat round`);
          
          const updatedApp = await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'UNDER_REVIEW', // This represents coffee chat round
              currentRound: '2', // Coffee chat round
              approved: null // reset for new round decisions
            }
          });
          
          console.log(`Application ${application.id} updated successfully:`, {
            id: updatedApp.id,
            status: updatedApp.status,
            currentRound: updatedApp.currentRound,
            approved: updatedApp.approved
          });

          // Send acceptance email (only if sendEmails is true)
          let emailResult = { success: true }; // Default to success if emails are disabled
          if (sendEmails) {
            try {
              emailResult = await sendAcceptanceEmail(
                application.email, // Use application email
                `${application.firstName} ${application.lastName}`,
                active.name
              );
              console.log(`Acceptance email result for ${application.email}:`, emailResult);
            } catch (emailError) {
              console.error(`Error sending acceptance email to ${application.email}:`, emailError);
              emailResult = { success: false, error: emailError.message };
            }
          } else {
            console.log(`Skipping acceptance email for ${application.email} (emails disabled)`);
          }

          if (emailResult.success) {
            if (sendEmails) results.emailsSent++;
            results.accepted.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: sendEmails,
              emailSkipped: !sendEmails
            });
          } else {
            if (sendEmails) results.emailsFailed++;
            results.accepted.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: false,
              emailError: emailResult.error
            });
          }

        } else if (decision === 'no') {
          // Reject candidate
          await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'REJECTED',
              currentRound: '1', // Resume review round (final)
              approved: false
            }
          });

          // Send rejection email (only if sendEmails is true)
          let emailResult = { success: true }; // Default to success if emails are disabled
          if (sendEmails) {
            try {
              emailResult = await sendRejectionEmail(
                application.email, // Use application email
                `${application.firstName} ${application.lastName}`,
                active.name
              );
              console.log(`Rejection email result for ${application.email}:`, emailResult);
            } catch (emailError) {
              console.error(`Error sending rejection email to ${application.email}:`, emailError);
              emailResult = { success: false, error: emailError.message };
            }
          } else {
            console.log(`Skipping rejection email for ${application.email} (emails disabled)`);
          }

          if (emailResult.success) {
            if (sendEmails) results.emailsSent++;
            results.rejected.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: sendEmails,
              emailSkipped: !sendEmails
            });
          } else {
            if (sendEmails) results.emailsFailed++;
            results.rejected.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: false,
              emailError: emailResult.error
            });
          }

        } else {
          // Invalid decision
          results.errors.push({
            applicationId: application.id,
            candidateId: application.candidate.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            error: `Invalid decision: ${decision}`
          });
        }

      } catch (error) {
        console.error(`Error processing application ${application.id}:`, error);
        results.errors.push({
          applicationId: application.id,
          candidateId: application.candidate?.id,
          candidateName: application.candidate ? `${application.firstName} ${application.lastName}` : 'Unknown',
          error: error.message
        });
      }
    }

    console.log('Decision processing completed:', results);
    console.log('Summary:', {
      totalApplications: applications.length,
      accepted: results.accepted.length,
      rejected: results.rejected.length,
      errors: results.errors.length,
      emailsSent: results.emailsSent,
      emailsFailed: results.emailsFailed
    });

    res.json({
      message: 'Decision processing completed',
      results,
      summary: {
        totalApplications: applications.length,
        accepted: results.accepted.length,
        rejected: results.rejected.length,
        errors: results.errors.length,
        emailsSent: results.emailsSent,
        emailsFailed: results.emailsFailed
      }
    });

  } catch (error) {
    console.error('[POST /api/admin/process-decisions]', error);
    
    // Ensure we always return valid JSON with detailed error information
    const errorResponse = {
      error: 'Failed to process decisions',
      details: error.message || 'Unknown error occurred',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString()
    };
    
    console.error('Sending error response:', errorResponse);
    res.status(500).json(errorResponse);
  }
});

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

// Get active cycle
router.get('/cycles/active', async (req, res) => {
  try {
    res.json(await loadActiveCycle(prisma));
  } catch (error) {
    console.error('[GET /api/admin/cycles/active]', error);
    // Return null instead of error to prevent dashboard from breaking
    res.json(null);
  }
});

// Create a new cycle
router.post('/cycles', async (req, res) => {
  try {
    const { name, formUrl, startDate, endDate, isActive, resumeDeadline, coverLetterDeadline, videoDeadline } = req.body;
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

// Set a cycle as active
router.post('/cycles/:id/activate', async (req, res) => {
  const { id } = req.params;

  try {
    const updated = await prisma.$transaction((tx) => activateCycleExclusively(tx, id));

    res.json({ message: 'Cycle activated', cycle: updated });
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
    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
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
      cycleId
    } = req.body;

    // Validate required fields
    if (!eventName || !eventStartDate || !eventEndDate || !cycleId) {
      return res.status(400).json({ error: 'Event name, start date, end date, and cycle ID are required' });
    }

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

    // Keep the generated-event form shim state in step with the links.
    const nextFormStatus = resolveFormStatus({
      currentStatus: existingEvent.formStatus,
      rsvpForm: rsvpForm !== undefined ? rsvpForm : existingEvent.rsvpForm,
      attendanceForm: attendanceForm !== undefined ? attendanceForm : existingEvent.attendanceForm
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

// Get event statistics (RSVP and attendance counts)
router.get('/events/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;

    const [event, rsvpCount, attendanceCount, memberRsvpCount] = await Promise.all([
      prisma.events.findUnique({
        where: { id },
        select: { 
          eventName: true, 
          eventStartDate: true, 
          eventEndDate: true,
          rsvpForm: true,
          attendanceForm: true,
          memberRsvpUrl: true
        }
      }),
      prisma.eventRsvp.count({ where: { eventId: id } }),
      prisma.eventAttendance.count({ where: { eventId: id } }),
      prisma.memberEventRsvp.count({ where: { eventId: id } })
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
        hasRsvpForm: !!event.rsvpForm,
        hasAttendanceForm: !!event.attendanceForm,
        hasMemberRsvpForm: !!event.memberRsvpUrl
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
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
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
    
    // Parse the configuration from description field
    let config = {};
    if (interview.description) {
      try {
        config = typeof interview.description === 'string' 
          ? JSON.parse(interview.description) 
          : interview.description;
      } catch (e) {
        console.warn('Failed to parse interview description:', e);
        config = {};
      }
    }
    
    // Get group-scoped behavioral questions if groupIds provided
    if (groupIds) {
      try {
        const groupIdArray = groupIds.split(',');
        const behavioralQuestions = await prisma.behavioralQuestion.findMany({
          where: {
            interviewId: id,
            groupId: { in: groupIdArray }
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
        const { groupId, questions } = config;
        
        if (!groupId || !questions) {
          return res.status(400).json({ error: 'groupId and questions are required for behavioral questions update' });
        }
        
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
            groupId: groupId
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
    res.json(usePagination ? result : result.applications);
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
        event.eventLocation
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

// Get staging candidates with comprehensive data and optional pagination
router.get('/staging/candidates', async (req, res) => {
  try {
    // Get pagination parameters - if not provided, return all candidates
    const page = parseInt(req.query.page);
    const limit = parseInt(req.query.limit);
    const usePagination = Boolean(page && limit);

    const snapshot = await loadStagingCandidates(prisma, { page, limit });

    if (usePagination) {
      res.json(snapshot);
    } else {
      res.json({ candidates: snapshot.candidates });
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
    res.json(await loadStagingSnapshot(prisma));
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

    console.log('Saving decision:', { candidateId, decision, phase });

    if (!candidateId) {
      return res.status(400).json({ error: 'Missing required field: candidateId' });
    }

    // Find the application for this candidate in the active cycle
    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    // Find the application - the candidateId parameter is actually the application ID
    const application = await prisma.application.findFirst({
      where: {
        id: candidateId, // Use the ID directly as it's the application ID
        cycleId: active.id
      }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found for this ID and cycle' });
    }

    console.log('Found application:', application.id, 'for candidate:', application.candidateId);

    // Map phase to the correct decision field
    const phaseToField = {
      'resume': 'resumeDecision',
      'coffee': 'coffeeChatDecision',
      'firstRound': 'firstRoundDecision',
      'final': 'finalRoundDecision'
    };

    const decisionField = phaseToField[phase] || 'resumeDecision';
    const phaseLabel = {
      'resume': 'Resume Review',
      'coffee': 'Coffee Chat',
      'firstRound': 'First Round',
      'final': 'Final Round'
    }[phase] || 'Resume Review';

    // Get user ID if available (from authentication middleware)
    const userId = req.user?.id || 'system';

    console.log('Processing decision:', decision, 'for application:', application.id, 'phase:', phase, 'field:', decisionField);

    // Build update data with the per-round decision field
    let updateData = {
      [decisionField]: decision || null,
      // Keep updating approved for backward compatibility
      approved: decision === 'yes' ? true : decision === 'no' ? false : null
    };

    // Add comment for tracking
    const decisionLabel = decision === 'yes' ? 'Yes - Advanced' :
                          decision === 'no' ? 'No - Not advanced' :
                          decision === 'maybe_yes' ? 'Maybe - Yes (needs final decision)' :
                          decision === 'maybe_no' ? 'Maybe - No (needs final decision)' :
                          'Cleared';

    updateData.comments = {
      create: {
        content: `${phaseLabel} decision: ${decisionLabel}`,
        userId: userId
      }
    };

    console.log('Update data:', updateData);

    // Update the application
    const updatedApplication = await prisma.application.update({
      where: { id: application.id },
      data: updateData
    });

    console.log('Decision saved successfully for application:', updatedApplication.id);
    console.log('Updated application data:', {
      id: updatedApplication.id,
      [decisionField]: updatedApplication[decisionField],
      approved: updatedApplication.approved,
      status: updatedApplication.status
    });

    res.json({
      success: true,
      message: 'Decision saved successfully',
      application: updatedApplication
    });

  } catch (error) {
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
    
    // Parse interview configuration
    let config = {};
    try {
      config = typeof interview.description === 'string' 
        ? JSON.parse(interview.description) 
        : interview.description || {};
    } catch (e) {
      console.warn('Failed to parse interview description:', e);
    }
    
    // Get applications from selected groups
    const applicationIds = new Set();
    config.applicationGroups?.forEach(group => {
      if (groupIdArray.includes(group.id)) {
        group.applicationIds?.forEach(appId => applicationIds.add(appId));
      }
    });
    
    if (applicationIds.size === 0) {
      return res.json([]);
    }
    
    // Fetch applications
    const applications = await prisma.application.findMany({
      where: {
        id: { in: Array.from(applicationIds) }
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
        testFor: true
      }
    });
    
    // Transform applications to include name field
    const transformedApplications = applications.map(app => ({
      ...app,
      name: `${app.firstName} ${app.lastName}`,
      major: app.major1,
      year: app.graduationYear
    }));
    
    res.json(transformedApplications);
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
    
    res.json(parsedEvaluations);
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
    
    res.json(parsedEvaluations);
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
    
    res.json(summaries);
  } catch (error) {
    console.error('[POST /api/admin/applications/evaluation-summaries]', error);
    res.status(500).json({ error: 'Failed to fetch evaluation summaries', details: error.message });
  }
});

// Process Coffee Chat decisions with emails and advancement to First Round
router.post('/process-coffee-decisions', async (req, res) => {
  try {
    console.log('Starting coffee chat decision processing...');

    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    console.log('Active cycle:', active.name);

    // Get applications in Coffee Chat round (currentRound = '2')
    const allApplications = await prisma.application.findMany({
      where: {
        cycleId: active.id,
        currentRound: '2'
      },
      include: {
        candidate: true
      }
    });

    // Filter to only applications with clear Yes/No decisions (approved field is true or false)
    const applications = allApplications.filter(app => app.approved === true || app.approved === false);
    
    // Also mark any remaining applications in round 2 as rejected (they should have been processed)
    const remainingApplications = allApplications.filter(app => app.approved === null || (app.approved !== true && app.approved !== false));
    
    console.log('Applications with clear decisions:', applications.length);
    console.log('Remaining applications to mark as rejected:', remainingApplications.length);

    console.log('Total coffee chat applications:', allApplications.length);
    console.log('Coffee chat applications with clear decisions:', applications.length);

    if (applications.length === 0) {
      const unclearDecisions = allApplications.filter(app => app.approved === null || (app.approved !== true && app.approved !== false));
      return res.status(400).json({ 
        error: 'No applications with clear decisions found in Coffee Chat round.',
        details: `${unclearDecisions.length} applications have unclear decisions (Maybe/Unsure) and cannot be processed.`
      });
    }

    // Disable email sending for coffee chat decisions
    console.log('Email sending disabled for coffee chat decisions');

    const results = {
      accepted: [],
      rejected: [],
      errors: [],
      emailsSent: 0,
      emailsFailed: 0
    };

    for (const application of applications) {
      try {
        if (!application.candidate) {
          results.errors.push({
            applicationId: application.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            error: 'No candidate associated with application'
          });
          continue;
        }

        // Decision from approved field (we already filtered for clear decisions)
        const decision = application.approved === true ? 'yes' : 'no';

        if (decision === 'yes') {
          // Advance to First Round Interviews (round 3)
          const updatedApp = await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'UNDER_REVIEW',
              currentRound: '3',
              approved: null // reset for next round decisions
            }
          });

          // Email sending disabled for coffee chat decisions
          results.accepted.push({
            applicationId: application.id,
            candidateId: application.candidate.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            email: application.email,
            emailSent: false,
            note: 'Email sending disabled for coffee chat decisions'
          });
        } else if (decision === 'no') {
          // Mark as rejected and remove from active process
          await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'REJECTED',
              currentRound: '2', // Keep the round they were rejected from for tracking
              approved: false // Mark as rejected
            }
          });

          // Don't send rejection email - they are marked as rejected
          results.rejected.push({
            applicationId: application.id,
            candidateId: application.candidate.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            email: application.email,
            emailSent: false,
            note: 'Rejected from Coffee Chat round'
          });
        }
      } catch (error) {
        console.error(`Error processing coffee chat application ${application.id}:`, error);
        results.errors.push({
          applicationId: application.id,
          candidateId: application.candidate?.id,
          candidateName: application.candidate ? `${application.firstName} ${application.lastName}` : 'Unknown',
          error: error.message
        });
      }
    }

    res.json({
      message: 'Coffee chat decision processing completed (no emails sent)',
      results,
      summary: {
        totalApplications: applications.length,
        accepted: results.accepted.length,
        rejected: results.rejected.length,
        errors: results.errors.length,
        emailsSent: 0, // No emails sent for coffee chat decisions
        emailsFailed: 0
      },
      note: 'Accepted candidates moved to First Round Interviews (round 3). "No" candidates marked as rejected.'
    });
  } catch (error) {
    console.error('[POST /api/admin/process-coffee-decisions]', error);
    res.status(500).json({ error: 'Failed to process coffee chat decisions', details: error.message });
  }
});

// Process First Round decisions with emails and advancement to Final Round
router.post('/process-first-round-decisions', async (req, res) => {
  try {
    console.log('Starting first round decision processing...');
    
    // Check if emails should be sent (default to true for backward compatibility)
    const sendEmails = req.body.sendEmails !== false;
    console.log('Send emails:', sendEmails);

    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    console.log('Active cycle:', active.name);

    // Get applications in First Round (currentRound = '3') with clear decisions only
    const allApplications = await prisma.application.findMany({
      where: {
        cycleId: active.id,
        currentRound: '3'
      },
      include: {
        candidate: true
      }
    });

    // Filter to only applications with clear Yes/No decisions (approved field is true or false)
    const applications = allApplications.filter(app => app.approved === true || app.approved === false);

    console.log('Total first round applications:', allApplications.length);
    console.log('First round applications with clear decisions:', applications.length);

    if (applications.length === 0) {
      const unclearDecisions = allApplications.filter(app => app.approved === null || (app.approved !== true && app.approved !== false));
      return res.status(400).json({ 
        error: 'No applications with clear decisions found in First Round.',
        details: `${unclearDecisions.length} applications have unclear decisions (Maybe/Unsure) and cannot be processed.`
      });
    }

    let sendFirstRoundAcceptanceEmail, sendFirstRoundRejectionEmail;
    try {
      const emailModule = await import('../services/emailNotifications.js');
      sendFirstRoundAcceptanceEmail = emailModule.sendFirstRoundAcceptanceEmail;
      sendFirstRoundRejectionEmail = emailModule.sendFirstRoundRejectionEmail;
      if (typeof sendFirstRoundAcceptanceEmail !== 'function' || typeof sendFirstRoundRejectionEmail !== 'function') {
        throw new Error('First round email service functions not found');
      }
    } catch (importError) {
      console.error('Failed to import first round email services:', importError);
      return res.status(500).json({ 
        error: 'Failed to import first round email services', 
        details: importError.message 
      });
    }

    const results = {
      accepted: [],
      rejected: [],
      errors: [],
      emailsSent: 0,
      emailsFailed: 0
    };

    for (const application of applications) {
      try {
        if (!application.candidate) {
          results.errors.push({
            applicationId: application.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            error: 'No candidate associated with application'
          });
          continue;
        }

        // Decision from approved field (we already filtered for clear decisions)
        const decision = application.approved === true ? 'yes' : 'no';

        if (decision === 'yes') {
          // Advance to Final Round (round 4) but keep the decision in First Round
          const updatedApp = await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'UNDER_REVIEW',
              currentRound: '4'
              // Don't reset approved - keep the "Yes" decision visible in First Round tab
            }
          });

          let emailResult = { success: true }; // Default to success if emails disabled
          
          if (sendEmails) {
            try {
              emailResult = await sendFirstRoundAcceptanceEmail(
                application.email,
                `${application.firstName} ${application.lastName}`,
                active.name
              );
            } catch (emailError) {
              console.error(`Error sending first round acceptance email to ${application.email}:`, emailError);
              emailResult = { success: false, error: emailError.message };
            }
          } else {
            console.log(`Skipping email for ${application.email} (emails disabled)`);
          }

          if (emailResult.success) {
            if (sendEmails) {
              results.emailsSent++;
            }
            results.accepted.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: sendEmails && emailResult.success,
              emailSkipped: !sendEmails
            });
          } else {
            results.emailsFailed++;
            results.accepted.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: false,
              emailError: emailResult.error
            });
          }

        } else {
          // Mark as rejected and remove from the process
          await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'REJECTED',
              currentRound: '3',
              approved: false // keep the No decision
            }
          });

          // Don't send rejection email - they are marked as rejected
          results.rejected.push({
            applicationId: application.id,
            candidateId: application.candidate.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            email: application.email,
            emailSent: false,
            note: 'Marked as rejected'
          });
        }

      } catch (error) {
        console.error(`Error processing application ${application.id}:`, error);
        results.errors.push({
          applicationId: application.id,
          candidateId: application.candidate?.id,
          candidateName: `${application.firstName} ${application.lastName}`,
          error: error.message
        });
      }
    }

    console.log('First round decision processing completed:', results);

    res.json({
      success: true,
      summary: {
        totalApplications: applications.length,
        accepted: results.accepted.length,
        rejected: results.rejected.length,
        errors: results.errors.length,
        emailsSent: results.emailsSent,
        emailsFailed: results.emailsFailed
      },
      note: 'Accepted candidates moved to Final Round (round 4) and remain visible in First Round with "Yes" decision. "No" candidates marked as rejected.'
    });
  } catch (error) {
    console.error('[POST /api/admin/process-first-round-decisions]', error);
    res.status(500).json({ error: 'Failed to process first round decisions', details: error.message });
  }
});

// Process Final Round decisions with emails and final advancement
router.post('/process-final-decisions', async (req, res) => {
  try {
    console.log('Starting final round decision processing...');

    const active = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!active) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    console.log('Active cycle:', active.name);

    // Get applications in Final Round (currentRound = '4') with clear decisions only
    const allApplications = await prisma.application.findMany({
      where: {
        cycleId: active.id,
        currentRound: '4'
      },
      include: {
        candidate: true
      }
    });

    // Filter to only applications with clear Yes/No decisions (approved field is true or false)
    const applications = allApplications.filter(app => app.approved === true || app.approved === false);

    console.log('Total final round applications:', allApplications.length);
    console.log('Final round applications with clear decisions:', applications.length);

    if (applications.length === 0) {
      const unclearDecisions = allApplications.filter(app => app.approved === null || (app.approved !== true && app.approved !== false));
      return res.status(400).json({ 
        error: 'No applications with clear decisions found in Final Round.',
        details: `${unclearDecisions.length} applications have unclear decisions (Maybe/Unsure) and cannot be processed.`
      });
    }

    let sendFinalAcceptanceEmail, sendFinalRejectionEmail;
    try {
      const emailModule = await import('../services/emailNotifications.js');
      sendFinalAcceptanceEmail = emailModule.sendFinalAcceptanceEmail;
      sendFinalRejectionEmail = emailModule.sendFinalRejectionEmail;
      if (typeof sendFinalAcceptanceEmail !== 'function' || typeof sendFinalRejectionEmail !== 'function') {
        throw new Error('Final round email service functions not found');
      }
    } catch (importError) {
      console.error('Failed to import final round email services:', importError);
      return res.status(500).json({ 
        error: 'Failed to import final round email services', 
        details: importError.message 
      });
    }

    const results = {
      accepted: [],
      rejected: [],
      errors: [],
      emailsSent: 0,
      emailsFailed: 0
    };

    for (const application of applications) {
      try {
        if (!application.candidate) {
          results.errors.push({
            applicationId: application.id,
            candidateName: `${application.firstName} ${application.lastName}`,
            error: 'No candidate associated with application'
          });
          continue;
        }

        // Decision from approved field (we already filtered for clear decisions)
        const decision = application.approved === true ? 'yes' : 'no';

        if (decision === 'yes') {
          // Accept candidate - move to final stage (round 5)
          const updatedApp = await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'ACCEPTED',
              currentRound: '5',
              approved: true // final acceptance
            }
          });

          let emailResult;
          try {
            emailResult = await sendFinalAcceptanceEmail(
              application.email,
              `${application.firstName} ${application.lastName}`,
              active.name
            );
          } catch (emailError) {
            console.error(`Error sending final acceptance email to ${application.email}:`, emailError);
            emailResult = { success: false, error: emailError.message };
          }

          if (emailResult.success) {
            results.emailsSent++;
            results.accepted.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: true
            });
          } else {
            results.emailsFailed++;
            results.accepted.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: false,
              emailError: emailResult.error
            });
          }
        } else if (decision === 'no') {
          // Reject
          await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'REJECTED',
              currentRound: '4',
              approved: false
            }
          });

          const emailResult = await sendFinalRejectionEmail(
            application.email,
            `${application.firstName} ${application.lastName}`,
            active.name
          );

          if (emailResult.success) {
            results.emailsSent++;
            results.rejected.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: true
            });
          } else {
            results.emailsFailed++;
            results.rejected.push({
              applicationId: application.id,
              candidateId: application.candidate.id,
              candidateName: `${application.firstName} ${application.lastName}`,
              email: application.email,
              emailSent: false,
              emailError: emailResult.error
            });
          }
        }
      } catch (error) {
        console.error(`Error processing final round application ${application.id}:`, error);
        results.errors.push({
          applicationId: application.id,
          candidateId: application.candidate?.id,
          candidateName: application.candidate ? `${application.firstName} ${application.lastName}` : 'Unknown',
          error: error.message
        });
      }
    }

    res.json({
      message: 'Final round decision processing completed',
      results,
      summary: {
        totalApplications: applications.length,
        accepted: results.accepted.length,
        rejected: results.rejected.length,
        errors: results.errors.length,
        emailsSent: results.emailsSent,
        emailsFailed: results.emailsFailed
      },
      note: 'Accepted candidates moved to final stage (round 5). Rejected candidates remain in Final Round (round 4).'
    });
  } catch (error) {
    console.error('[POST /api/admin/process-final-decisions]', error);
    res.status(500).json({ error: 'Failed to process final round decisions', details: error.message });
  }
});

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
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
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
router.get('/meeting-slots', async (req, res) => {
  try {
    const slots = await prisma.meetingSlot.findMany({
      orderBy: { startTime: 'asc' },
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
  } catch (error) {
    console.error('[POST /api/admin/meeting-slots]', error);
    res.status(500).json({ error: 'Failed to create meeting slot' });
  }
});

// Admin: update any meeting slot (full override — including host and time).
router.put('/meeting-slots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { memberId, location, startTime, endTime, capacity } = req.body || {};

    const existingSlot = await prisma.meetingSlot.findUnique({ where: { id } });
    if (!existingSlot) {
      return res.status(404).json({ error: 'Meeting slot not found' });
    }

    if (memberId !== undefined && memberId !== existingSlot.memberId) {
      const host = await prisma.user.findUnique({ where: { id: memberId } });
      if (!host) {
        return res.status(400).json({ error: 'Host member not found' });
      }
    }

    const updateData = {};
    if (memberId !== undefined) updateData.memberId = memberId;
    if (location !== undefined) updateData.location = location;
    if (startTime !== undefined) updateData.startTime = localInputToUTC(startTime);
    if (endTime !== undefined) updateData.endTime = endTime ? localInputToUTC(endTime) : null;
    if (capacity !== undefined) updateData.capacity = Number.isInteger(capacity) ? capacity : existingSlot.capacity;

    const updatedSlot = await prisma.meetingSlot.update({
      where: { id },
      data: updateData,
      include: {
        member: { select: { id: true, fullName: true, email: true, profileImage: true, graduationClass: true, role: true } },
        signups: { orderBy: { createdAt: 'asc' } },
        communications: { orderBy: { sentAt: 'desc' } }
      }
    });

    res.json(updatedSlot);
  } catch (error) {
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
              existingSlot.endTime
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
            { signupCount: existingSlot.signups.length }
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
        signup.slot.endTime
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
      await sendAndLogMeetingCommunication(
        () => sendMeetingCancellationToMember(
          signup.slot.member.email,
          memberName,
          signup.slot.location,
          signup.slot.startTime,
          signup.slot.endTime,
          { candidateName: signup.fullName }
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

    const activeCycles = await prisma.recruitingCycle.findMany({
      where: { isActive: true },
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

    const activeCycles = await prisma.recruitingCycle.findMany({
      where: { isActive: true },
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

    res.json({
      ...preview,
      dryRun: false,
      deactivatedCount: updateResult.count
    });
  } catch (error) {
    console.error('[POST /api/admin/users/deactivate]', error);
    res.status(500).json({ error: 'Failed to deactivate users' });
  }
});

export default router;