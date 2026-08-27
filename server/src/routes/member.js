import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireAdminOrMember } from '../middleware/auth.js';
import prisma from '../prismaClient.js';
import { putResume, getResume, removeResume } from '../services/resumeStorage.js';
import { sendSlackMessage } from '../services/slackService.js';
import { sendMeetingCancellationEmail } from '../services/emailNotifications.js';
import { sendAndLogMeetingCommunication, MEETING_COMM_SUBJECTS } from '../services/meetingComms.js';
import { localInputToUTC } from '../utils/timezoneUtils.js';
import { resolveCycleForRequest, resolveCandidateCycle } from '../services/activeCycle.js';
import {
  getGroupMemberUsers,
  getGroupMemberIds,
  groupMemberUserInclude
} from '../utils/groupMembers.js';
import {
  GTKUC_INDUSTRIES,
  GTKUC_INTERESTS,
  MAX_INDUSTRIES,
  MAX_INTERESTS,
  INTEREST_MAX_LENGTH,
  sanitizeProfileInput,
  isProfileComplete,
  missingProfileFields
} from '../utils/gtkucProfile.js';
import {
  MEMBER_GENDERS,
  sanitizeMemberResumeInput,
  serializeMemberResume
} from '../utils/memberResume.js';
// GTKUC profile shown to candidates on the member's slots, loaded with the
// active cycle's confirmation so the portal knows whether to force the
// confirm/update modal before the member can open slots.
import { loadGtkucProfileState } from '../utils/gtkucProfileState.js';

const router = express.Router();

// Get events for members with per-user RSVP status
router.get('/events', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Scope in SQL rather than loading every event ever created and filtering in JS.
    const activeCycle = await resolveCycleForRequest(prisma, req);
    if (!activeCycle) return res.json([]);

    const events = await prisma.events.findMany({
      where: { cycleId: activeCycle.id },
      include: {
        cycle: true
      },
      orderBy: {
        eventStartDate: 'asc'
      }
    });


    // Build a Set of eventIds this member RSVP'd to
    const eventIds = events.map(e => e.id);
    let rsvpsByEventId = new Set();
    if (eventIds.length > 0) {
      const memberRsvps = await prisma.memberEventRsvp.findMany({
        where: {
          memberId: userId,
          eventId: { in: eventIds }
        },
        select: { eventId: true }
      });
      rsvpsByEventId = new Set(memberRsvps.map(r => r.eventId));
    }

    const eventsWithStatus = events.map(event => ({
      ...event,
      memberRsvpUrl: event.memberRsvpUrl || null,
      hasMemberRsvpd: rsvpsByEventId.has(event.id)
    }));

    res.json(eventsWithStatus);
  } catch (error) {
    console.error('[GET /api/member/events]', error);
    res.status(500).json({ error: 'Failed to fetch member events' });
  }
});

// Get all applications (member version - no admin access required)
router.get('/all-applications', requireAuth, async (req, res) => {
  try {
    console.log('Fetching all applications for member:', req.user.id);
    
    // Get the active cycle first
    const activeCycle = await resolveCycleForRequest(prisma, req);
    
    console.log('Active cycle found:', activeCycle?.id);
    
    if (!activeCycle) {
      console.log('No active cycle found, returning empty array');
      return res.json([]);
    }

    // Event attendance filter
    const eventAttendanceEventId = req.query.eventAttendanceEventId || '';

    const whereClause = { cycleId: activeCycle.id };

    if (eventAttendanceEventId) {
      whereClause.candidate = {
        ...(whereClause.candidate || {}),
        eventAttendance: { some: { eventId: eventAttendanceEventId } }
      };
    }

    // Get all applications for the active cycle
    const applications = await prisma.application.findMany({
      where: whereClause,
      include: {
        candidate: {
          select: {
            id: true,
            assignedGroupId: true
          }
        }
      },
      orderBy: {
        submittedAt: 'desc'
      }
    });

    console.log('Found applications:', applications.length);

    // Transform the data
    const transformedApplications = applications.map(app => ({
      id: app.id,
      candidateId: app.candidateId,
      name: `${app.firstName} ${app.lastName}`,
      major: app.major1 || 'N/A',
      year: app.graduationYear || 'N/A',
      gpa: app.cumulativeGpa?.toString() || 'N/A',
      status: app.status || 'SUBMITTED',
      email: app.email,
      submittedAt: app.submittedAt,
      headshotUrl: app.headshotUrl,
      gender: app.gender || 'N/A',
      isFirstGeneration: app.isFirstGeneration,
      isTransferStudent: app.isTransferStudent,
      resumeUrl: app.resumeUrl,
      coverLetterUrl: app.coverLetterUrl,
      videoUrl: app.videoUrl,
      groupId: app.candidate?.assignedGroupId,
      groupName: app.candidate?.assignedGroupId ? 
        `Team ${app.candidate.assignedGroupId.slice(-4)}` : 'Unassigned'
    }));

    console.log('Transformed applications:', transformedApplications.length);
    res.json(transformedApplications);
  } catch (error) {
    console.error('Error fetching all applications for member:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch applications', details: error.message });
  }
});

// Get all candidates (member version - no admin access required)
router.get('/all-candidates', requireAuth, async (req, res) => {
  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    // Option to load minimal data (for faster list views)
    const minimal = req.query.minimal === 'true';
    // Search parameter
    const search = req.query.search?.trim() || '';

    // Event attendance filter
    const eventAttendanceEventId = req.query.eventAttendanceEventId || '';

    console.log('Fetching all candidates for member:', req.user.id, `(page ${page}, limit ${limit}, minimal: ${minimal}, search: "${search}", eventAttendance: "${eventAttendanceEventId}")`);

    // Build where clause for search and event filters
    let whereClause = {};

    // Event attendance filter
    if (eventAttendanceEventId) {
      whereClause.eventAttendance = {
        some: { eventId: eventAttendanceEventId }
      };
    }

    if (search) {
      // Split search into words for full name matching
      const searchWords = search.split(/\s+/).filter(word => word.length > 0);

      if (searchWords.length > 1) {
        // Multi-word search: match each word against first or last name in applications
        whereClause.AND = searchWords.map(word => ({
          applications: {
            some: {
              OR: [
                { firstName: { contains: word, mode: 'insensitive' } },
                { lastName: { contains: word, mode: 'insensitive' } }
              ]
            }
          }
        }));
      } else {
        // Single word search: match against studentId, first name, last name, or email
        whereClause.OR = [
          { studentId: { contains: search, mode: 'insensitive' } },
          { applications: { some: { firstName: { contains: search, mode: 'insensitive' } } } },
          { applications: { some: { lastName: { contains: search, mode: 'insensitive' } } } },
          { applications: { some: { email: { contains: search, mode: 'insensitive' } } } }
        ];
      }
    }

    // Get total count with search filter
    const total = await prisma.candidate.count({ where: whereClause });
    console.log('Total candidates matching search:', total);

    // Try the full query with error handling for each part
    let candidates;
    try {
      if (minimal) {
        // Minimal query for faster list loading
        candidates = await prisma.candidate.findMany({
          where: whereClause,
          select: {
            id: true,
            studentId: true,
            createdAt: true,
            assignedGroupId: true,
            applications: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                status: true,
                submittedAt: true,
                headshotUrl: true,
                cycleId: true
              },
              orderBy: { submittedAt: 'desc' },
              take: 1 // Only get most recent application
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit
        });
      } else {
        // Full query with all includes
        candidates = await prisma.candidate.findMany({
          where: whereClause,
          include: {
            assignedGroup: {
              select: {
                id: true,
                memberOne: true,
                memberTwo: true,
                memberThree: true,
                groupMembers: { select: { userId: true } }
              }
            },
            applications: {
              include: {
                cycle: {
                  select: {
                    id: true,
                    name: true,
                    isActive: true
                  }
                }
              },
              orderBy: { submittedAt: 'desc' }
            },
            eventAttendance: {
              include: {
                event: {
                  select: {
                    id: true,
                    eventName: true,
                    eventStartDate: true,
                    eventEndDate: true
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
                    eventStartDate: true,
                    eventEndDate: true
                  }
                }
              }
            }
          },
          orderBy: {
            createdAt: 'desc'
          },
          skip,
          take: limit
        });
      }
    } catch (queryError) {
      console.error('Prisma query error:', queryError);
      // Try a simpler query without includes
      candidates = await prisma.candidate.findMany({
        select: {
          id: true,
          studentId: true,
          createdAt: true,
          assignedGroupId: true
        },
        orderBy: {
          createdAt: 'desc'
        }
      });
      console.log('Using simplified query, found candidates:', candidates.length);
    }

    console.log('Found candidates:', candidates.length);

    // Return with pagination metadata
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
    console.error('Error fetching all candidates for member:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch candidates', details: error.message });
  }
});

// Get a specific candidate with all related data
router.get('/candidate/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('Fetching candidate details for:', id);
    
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        assignedGroup: {
          select: {
            id: true,
            memberOne: true,
            memberTwo: true,
            memberThree: true,
            createdAt: true,
            groupMembers: { select: { userId: true } }
          }
        },
        applications: {
          include: {
            cycle: {
              select: {
                id: true,
                name: true,
                isActive: true
              }
            }
          },
          orderBy: {
            submittedAt: 'desc'
          }
        },
        eventAttendance: {
          include: {
            event: {
              select: {
                id: true,
                eventName: true,
                eventStartDate: true,
                eventEndDate: true
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
                eventStartDate: true,
                eventEndDate: true
              }
            }
          }
        }
      }
    });

    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    console.log('Found candidate:', candidate.id);
    res.json(candidate);
  } catch (error) {
    console.error('Error fetching candidate details:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch candidate details', details: error.message });
  }
});

// Get current user's team information
router.get('/my-team', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get the active cycle first
    const activeCycle = await resolveCycleForRequest(prisma, req);
    
    if (!activeCycle) {
      return res.json(null);
    }

    // Find the team that the current user belongs to
    const userTeam = await prisma.groups.findFirst({
      where: {
        cycleId: activeCycle.id,
        OR: [
          { memberOne: userId },
          { memberTwo: userId },
          { memberThree: userId },
          { groupMembers: { some: { userId } } }
        ]
      },
      include: {
        ...groupMemberUserInclude,
        assignedCandidates: {
          include: {
            applications: {
              where: {
                cycleId: activeCycle.id
              },
              orderBy: {
                submittedAt: 'desc'
              },
              take: 1 // Only get the latest application
            }
          }
        },
        cycle: {
          select: {
            id: true,
            name: true,
            isActive: true
          }
        }
      }
    });

    if (!userTeam) {
      return res.json(null);
    }

    // Transform the data to match the frontend expectations
    const members = getGroupMemberUsers(userTeam);

    // Get all scoring data for the team's assigned candidates
    const candidateIds = userTeam.assignedCandidates.map(c => c.id);
    
    const [resumeScores, coverLetterScores, videoScores] = await Promise.all([
      prisma.resumeScore.findMany({
        where: {
          candidateId: { in: candidateIds }
        },
        select: {
          candidateId: true,
          evaluatorId: true
        }
      }),
      prisma.coverLetterScore.findMany({
        where: {
          candidateId: { in: candidateIds }
        },
        select: {
          candidateId: true,
          evaluatorId: true
        }
      }),
      prisma.videoScore.findMany({
        where: {
          candidateId: { in: candidateIds }
        },
        select: {
          candidateId: true,
          evaluatorId: true
        }
      })
    ]);

    // Get team member IDs for progress calculation
    const teamMemberIds = getGroupMemberIds(userTeam);

    const applications = userTeam.assignedCandidates.map(candidate => {
      // Get the latest application for this candidate
      const latestApplication = candidate.applications[0];
      
      if (!latestApplication) {
        return null; // Skip candidates without applications
      }

      // Calculate progress for each document type
      // Progress is based on how many team members have scored each document
      const candidateResumeScores = resumeScores.filter(score => 
        score.candidateId === candidate.id && 
        score.assignedGroupId === userTeam.id &&
        teamMemberIds.includes(score.evaluatorId));
      const candidateCoverLetterScores = coverLetterScores.filter(score => 
        score.candidateId === candidate.id && 
        score.assignedGroupId === userTeam.id &&
        teamMemberIds.includes(score.evaluatorId));
      const candidateVideoScores = videoScores.filter(score => 
        score.candidateId === candidate.id && 
        score.assignedGroupId === userTeam.id &&
        teamMemberIds.includes(score.evaluatorId));

      // Calculate progress as percentage of team members who have scored each document
      const resumeProgress = !latestApplication.resumeUrl ? 100 : 
        (teamMemberIds.length > 0 ? 
          Math.round((candidateResumeScores.length / teamMemberIds.length) * 100) : 0);
      const coverLetterProgress = !latestApplication.coverLetterUrl ? 100 : 
        (teamMemberIds.length > 0 ? 
          Math.round((candidateCoverLetterScores.length / teamMemberIds.length) * 100) : 0);
      const videoProgress = !latestApplication.videoUrl ? 100 : 
        (teamMemberIds.length > 0 ? 
          Math.round((candidateVideoScores.length / teamMemberIds.length) * 100) : 0);

      return {
        id: latestApplication.id,
        candidateId: candidate.id,
        name: `${latestApplication.firstName} ${latestApplication.lastName}`,
        major: latestApplication.major1 || 'N/A',
        year: latestApplication.graduationYear || 'N/A',
        gpa: latestApplication.cumulativeGpa?.toString() || 'N/A',
        status: latestApplication.status || 'SUBMITTED',
        email: latestApplication.email,
        submittedAt: latestApplication.submittedAt,
        resumeProgress,
        coverLetterProgress,
        videoProgress,
        avatar: null
      };
    }).filter(Boolean); // Remove null entries

    const transformedTeam = {
      id: userTeam.id,
      name: `Team ${userTeam.id.slice(-4)}`,
      code: userTeam.id.slice(-8),
      members: members.map(member => ({
        id: member.id,
        name: member.fullName,
        fullName: member.fullName,
        email: member.email,
        profileImage: member.profileImage,
        avatar: member.profileImage
      })),
      applications,
      cycleId: userTeam.cycleId,
      cycleName: userTeam.cycle?.name
    };

    res.json(transformedTeam);
  } catch (error) {
    console.error('Error fetching user team:', error);
    res.status(500).json({ error: 'Failed to fetch team information' });
  }
});

// Get member's assigned interviews
router.get('/interviews', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
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

    // Filter interviews to only show those where the current user is assigned
    // This would need to be based on the interview configuration and member groups
    // For now, we'll return all interviews and let the frontend handle filtering
    // In a real implementation, you'd parse the interview description to check
    // if the current user is in any of the member groups
    
    res.json(interviews);
  } catch (error) {
    console.error('[GET /api/member/interviews]', {
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

// Get current user's profile information
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
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
    console.error('[GET /api/member/profile]', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Get specific interview details for member
router.get('/interviews/:id', requireAuth, async (req, res) => {
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
    console.error('[GET /api/member/interviews/:id]', error);
    res.status(500).json({ error: 'Failed to fetch interview details' });
  }
});

// Get interview configuration (member version)
router.get('/interviews/:id/config', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { groupIds } = req.query;
    const userId = req.user.id;
    
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
      const groupIdArray = groupIds.split(',');
      
      // Note: groupIds are application group IDs, not review group IDs
      // Access control is handled at the interview level, not the group level
      console.log('Member - Loading behavioral questions for application groups:', groupIdArray);
      
      try {
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
        console.log('Member - Loaded behavioral questions:', questionsByGroup);
      } catch (error) {
        console.warn('Behavioral questions table not found yet, returning empty questions:', error.message);
        config.behavioralQuestions = {};
      }
    }
    
    res.json(config);
  } catch (error) {
    console.error('[GET /api/member/interviews/:id/config]', error);
    res.status(500).json({ error: 'Failed to fetch interview configuration' });
  }
});

// Update interview configuration (member version)
router.patch('/interviews/:id/config', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, config } = req.body;
    const userId = req.user.id;
    
    const interview = await prisma.interview.findUnique({
      where: { id }
    });

    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    // Handle behavioral questions update
    if (type === 'behavioral_questions' && config.behavioralQuestions) {
      const { groupId, questions } = config;
      
      if (!groupId || !questions) {
        return res.status(400).json({ error: 'groupId and questions are required for behavioral questions update' });
      }
      
      console.log('Member - Attempting to save behavioral questions:', {
        interviewId: id,
        groupId,
        questions: questions.filter(q => q.trim() !== ''),
        userId
      });
      
      // Note: For behavioral questions, we're working with application groups
      // The access control is handled at the interview level, not the group level
      console.log('Member - Using application group for behavioral questions:', groupId);
      
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
              createdBy: userId
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
    console.error('[PATCH /api/member/interviews/:id/config]', error);
    res.status(500).json({ error: 'Failed to update interview configuration' });
  }
});

const serializeGtkucProfileState = ({ user, activeCycle, profile, confirmationRequired }) => ({
  profile: profile
    ? {
        industries: profile.industries,
        interests: profile.interests,
        linkedinUrl: profile.linkedinUrl || '',
        candidateVisible: profile.candidateVisible,
        hiddenFromGtkuc: profile.hiddenFromGtkuc,
        updatedAt: profile.updatedAt,
        confirmedAtForCycle:
          profile.confirmations?.find((c) => c.cycleId === activeCycle?.id)?.confirmedAt || null
      }
    : null,
  profileImage: user?.profileImage || null,
  graduationClass: user?.graduationClass || null,
  activeCycle: activeCycle ? { id: activeCycle.id, name: activeCycle.name } : null,
  complete: isProfileComplete(profile, user),
  missingFields: missingProfileFields(profile, user),
  confirmationRequired,
  taxonomy: {
    industries: GTKUC_INDUSTRIES,
    interests: GTKUC_INTERESTS,
    maxIndustries: MAX_INDUSTRIES,
    maxInterests: MAX_INTERESTS,
    interestMaxLength: INTEREST_MAX_LENGTH
  }
});

// Member: read own GTKUC profile plus whether this cycle still needs a confirm
router.get('/gtkuc-profile', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const state = await loadGtkucProfileState(req.user.id);
    res.json(serializeGtkucProfileState(state));
  } catch (error) {
    console.error('[GET /api/member/gtkuc-profile]', error);
    res.status(500).json({ error: 'Failed to load your Get to Know UC profile' });
  }
});

// Member: create/update own GTKUC profile. Submitting also counts as the
// confirmation for the active cycle, which is what unblocks slot creation.
router.put('/gtkuc-profile', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const { industries, interests, linkedinUrl, candidateVisible, rejected } = sanitizeProfileInput(
      req.body || {}
    );

    if (industries.length === 0) {
      return res.status(400).json({ error: 'Select at least one industry from the list' });
    }
    if (interests.length === 0) {
      return res.status(400).json({ error: 'Select at least one interest from the list' });
    }
    // A LinkedIn value that survived normalization is a profile URL; anything
    // else the member typed is rejected rather than silently dropped.
    if (req.body?.linkedinUrl && !linkedinUrl) {
      return res.status(400).json({ error: 'Enter a LinkedIn profile URL, e.g. linkedin.com/in/your-handle' });
    }

    // Candidate pointer even for admin callers: the confirmation this writes is keyed
    // (profileId, cycleId) and must match the cycle the gate checks.
    const activeCycle = await resolveCandidateCycle(prisma);

    // Members may clear an auto-filled LinkedIn link, so an empty submission
    // overwrites rather than falling back to what was stored.
    const profile = await prisma.memberGtkucProfile.upsert({
      where: { memberId: req.user.id },
      create: { memberId: req.user.id, industries, interests, linkedinUrl, candidateVisible },
      update: { industries, interests, linkedinUrl, candidateVisible }
    });

    if (activeCycle) {
      await prisma.memberGtkucProfileConfirmation.upsert({
        where: { profileId_cycleId: { profileId: profile.id, cycleId: activeCycle.id } },
        create: { profileId: profile.id, cycleId: activeCycle.id },
        update: { confirmedAt: new Date() }
      });
    }

    const state = await loadGtkucProfileState(req.user.id);
    res.json({ ...serializeGtkucProfileState(state), rejectedValues: rejected });
  } catch (error) {
    console.error('[PUT /api/member/gtkuc-profile]', error);
    res.status(500).json({ error: 'Failed to save your Get to Know UC profile' });
  }
});

// Member: create a meeting slot
router.post('/meeting-slots', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const { location, startTime, endTime, capacity } = req.body || {};
    if (!location || !startTime) {
      return res.status(400).json({ error: 'Location and start time are required' });
    }

    // Members can't open slots until their candidate-facing profile is complete
    // and confirmed for the active cycle (first slot of each cycle).
    const profileState = await loadGtkucProfileState(req.user.id);
    if (profileState.confirmationRequired) {
      return res.status(409).json({
        error: 'Confirm your Get to Know UC profile before opening a timeslot',
        code: 'GTKUC_PROFILE_CONFIRMATION_REQUIRED',
        missingFields: missingProfileFields(profileState.profile, profileState.user)
      });
    }
    
    console.log('Received startTime:', startTime);
    console.log('Received endTime:', endTime);

    const slot = await prisma.meetingSlot.create({
      data: {
        memberId: req.user.id,
        location,
        startTime: localInputToUTC(startTime),
        endTime: endTime ? localInputToUTC(endTime) : null,
        capacity: Number.isInteger(capacity) ? capacity : 2
      }
    });
    
    console.log('Created slot startTime:', slot.startTime);
    console.log('Created slot endTime:', slot.endTime);
    
    res.json(slot);
  } catch (error) {
    console.error('[POST /api/member/meeting-slots]', error);
    res.status(500).json({ error: 'Failed to create meeting slot' });
  }
});

// Member: list own meeting slots with signups
router.get('/meeting-slots', requireAuth, async (req, res) => {
  try {
    const slots = await prisma.meetingSlot.findMany({
      where: { memberId: req.user.id },
      orderBy: { startTime: 'asc' },
      include: { signups: true }
    });
    res.json(slots);
  } catch (error) {
    console.error('[GET /api/member/meeting-slots]', error);
    res.status(500).json({ error: 'Failed to fetch meeting slots' });
  }
});

// Member: update a meeting slot
router.put('/meeting-slots/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { location, startTime, endTime, capacity } = req.body || {};
    
    // Check if the slot belongs to this member
    const existingSlot = await prisma.meetingSlot.findUnique({
      where: { id },
      include: { signups: true }
    });
    
    if (!existingSlot) {
      return res.status(404).json({ error: 'Meeting slot not found' });
    }
    
    if (existingSlot.memberId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this meeting slot' });
    }
    
    // Check if there are existing signups and the new time conflicts
    if (existingSlot.signups.length > 0) {
      // If there are signups, only allow updating location and capacity
      if (startTime || endTime) {
        return res.status(400).json({ 
          error: 'Cannot change time of meeting slot with existing signups. Only location and capacity can be updated.' 
        });
      }
    }
    
    const updateData = {};
    if (location !== undefined) updateData.location = location;
    if (startTime !== undefined) updateData.startTime = localInputToUTC(startTime);
    if (endTime !== undefined) updateData.endTime = endTime ? localInputToUTC(endTime) : null;
    if (capacity !== undefined) updateData.capacity = Number.isInteger(capacity) ? capacity : existingSlot.capacity;
    
    const updatedSlot = await prisma.meetingSlot.update({
      where: { id },
      data: updateData,
      include: { signups: true }
    });
    
    res.json(updatedSlot);
  } catch (error) {
    console.error('[PUT /api/member/meeting-slots/:id]', error);
    res.status(500).json({ error: 'Failed to update meeting slot' });
  }
});

// Member: delete a meeting slot
router.delete('/meeting-slots/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if the slot belongs to this member
    const existingSlot = await prisma.meetingSlot.findUnique({
      where: { id },
      include: { 
        signups: true,
        member: {
          select: { fullName: true, profileImage: true }
        }
      }
    });
    
    if (!existingSlot) {
      return res.status(404).json({ error: 'Meeting slot not found' });
    }
    
    if (existingSlot.memberId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this meeting slot' });
    }
    
    // Send cancellation emails to all signups before deleting
    if (existingSlot.signups.length > 0) {
      const memberName = existingSlot.member?.fullName || 'UC Consulting Member';
      
      // Send cancellation emails to all signups (and log each communication)
      const emailPromises = existingSlot.signups.map((signup) =>
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
      
      // Wait for all emails to be sent (or fail)
      await Promise.allSettled(emailPromises);
    }
    
    // Delete the meeting slot (this will cascade delete all signups due to foreign key constraint)
    await prisma.$transaction(async (tx) => {
      await tx.meetingSignup.deleteMany({
        where: { slotId: id },
      })

      await tx.meetingSlot.delete({
        where: { id },
      })
    })
    
    const message = existingSlot.signups.length > 0 
      ? `Meeting slot deleted successfully. Cancellation emails sent to ${existingSlot.signups.length} signup(s).`
      : 'Meeting slot deleted successfully.';
    
    res.json({ message });
  } catch (error) {
    console.error('[DELETE /api/member/meeting-slots/:id]', error);
    res.status(500).json({ error: 'Failed to delete meeting slot' });
  }
});

// Member: delete a signup
router.delete('/meeting-signups/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if the signup exists and belongs to a slot of this member
    const signup = await prisma.meetingSignup.findUnique({
      where: { id },
      include: {
        slot: {
          include: {
            member: {
              select: { fullName: true, profileImage: true }
            }
          }
        }
      }
    });

    if (!signup) {
      return res.status(404).json({ error: 'Signup not found' });
    }

    if (signup.slot.memberId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this signup' });
    }

    // Send cancellation email to the signup (and log the communication).
    // Logged before deletion; the log survives with signupId set null (slot remains).
    const memberName = signup.slot.member?.fullName || 'UC Consulting Member';

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

    // Delete the signup
    await prisma.meetingSignup.delete({
      where: { id }
    });

    res.json({
      message: 'Signup deleted successfully. Cancellation email sent.',
      deletedSignup: {
        id: signup.id,
        fullName: signup.fullName,
        email: signup.email
      }
    });
  } catch (error) {
    console.error('[DELETE /api/member/meeting-signups/:id]', error);
    res.status(500).json({ error: 'Failed to delete signup' });
  }
});

// Member: mark attendance for a signup
router.patch('/meeting-signups/:id/attendance', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { attended } = req.body || {};

    // Ensure the signup belongs to a slot of this member
    const signup = await prisma.meetingSignup.findUnique({
      where: { id },
      include: { slot: true }
    });

    if (!signup) {
      return res.status(404).json({ error: 'Signup not found' });
    }
    if (signup.slot.memberId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this signup' });
    }

    const updated = await prisma.meetingSignup.update({
      where: { id },
      data: { attended: Boolean(attended) }
    });

    // If marking as attended and studentId exists, add 5 points to overall score
    if (Boolean(attended) && signup.studentId) {
      try {
        // Find the candidate by studentId
        const candidate = await prisma.candidate.findUnique({
          where: { studentId: signup.studentId },
          include: { applications: true }
        });

        if (candidate && candidate.applications.length > 0) {
          // Get the latest application for the active cycle
          const activeCycle = await resolveCycleForRequest(prisma, req);

          if (activeCycle) {
            const latestApplication = candidate.applications
              .filter(app => app.cycleId === activeCycle.id)
              .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0];

            if (latestApplication) {
              console.log(`Adding 1 point to application ${latestApplication.id} for meeting attendance (studentId: ${signup.studentId})`);

              // Note: The 1 point will be automatically added when the overall score is calculated
              // in the existing scoring system (similar to referral bonus and event points)
              // No need to store this separately as it's calculated dynamically
            }
          }
        }
      } catch (scoreError) {
        console.error('Error processing meeting attendance bonus:', scoreError);
        // Don't fail the attendance update if scoring fails
      }
    }

    res.json(updated);
  } catch (error) {
    console.error('[PATCH /api/member/meeting-signups/:id/attendance]', error);
    res.status(500).json({ error: 'Failed to update attendance' });
  }
});

// Get applications for interview groups (member version)
router.get('/interviews/:id/applications', requireAuth, async (req, res) => {
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
    console.error('[GET /api/member/interviews/:id/applications]', error);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Get evaluations for an interview
router.get('/evaluations', requireAuth, async (req, res) => {
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
      
      // Safely parse JSON fields - only parse if it looks like JSON
      if (parsed.behavioralNotes && typeof parsed.behavioralNotes === 'string') {
        const trimmed = parsed.behavioralNotes.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            parsed.behavioralNotes = JSON.parse(parsed.behavioralNotes);
          } catch (e) {
            parsed.behavioralNotes = {};
          }
        } else {
          // If it's a string but not JSON, convert to empty object
          parsed.behavioralNotes = {};
        }
      } else if (!parsed.behavioralNotes) {
        parsed.behavioralNotes = {};
      }
      
      if (parsed.casingNotes && typeof parsed.casingNotes === 'string') {
        const trimmed = parsed.casingNotes.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            parsed.casingNotes = JSON.parse(parsed.casingNotes);
          } catch (e) {
            parsed.casingNotes = {};
          }
        }
      }
      
      if (parsed.candidateDetails && typeof parsed.candidateDetails === 'string') {
        const trimmed = parsed.candidateDetails.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            parsed.candidateDetails = JSON.parse(parsed.candidateDetails);
          } catch (e) {
            parsed.candidateDetails = {};
          }
        }
      }
      
      return parsed;
    });
    
    res.json(parsedEvaluations);
  } catch (error) {
    console.error('[GET /api/member/evaluations]', error);
    res.status(500).json({ error: 'Failed to fetch evaluations' });
  }
});

// Save or update evaluation
router.post('/evaluations', requireAuth, async (req, res) => {
  try {
    const { 
      interviewId, 
      applicationId, 
      decision, 
      notes,
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
    
    if (!interviewId || !applicationId) {
      return res.status(400).json({ error: 'Interview ID and application ID are required' });
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
        }
      });
      
      const evaluationData = {
        decision,
        notes,
        behavioralNotes: behavioralNotes ? JSON.stringify(behavioralNotes) : null,
        casingNotes: casingNotes ? JSON.stringify(casingNotes) : null,
        candidateDetails: candidateDetails ? JSON.stringify(candidateDetails) : null,
        updatedAt: new Date()
      };
      
      let evaluation;
      if (existingEvaluation) {
        // Update existing evaluation
        evaluation = await prisma.interviewEvaluation.update({
          where: { id: existingEvaluation.id },
          data: evaluationData
        });
      } else {
        // Create new evaluation
        evaluation = await prisma.interviewEvaluation.create({
          data: {
            interviewId,
            applicationId,
            evaluatorId,
            ...evaluationData
          }
        });
      }
      
      res.json(evaluation);
    }
  } catch (error) {
    console.error('[POST /api/member/evaluations]', error);
    res.status(500).json({ error: 'Failed to save evaluation' });
  }
});

// Message admin endpoint
router.post('/message-admin', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    const userId = req.user.id;
    
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get user information with better error handling
    let user;
    try {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          fullName: true,
          email: true,
          role: true, profileImage: true }
      });
    } catch (dbError) {
      console.error('[POST /api/member/message-admin] Database error:', dbError);
      return res.status(503).json({ 
        error: 'Database temporarily unavailable. Please try again later.',
        details: 'Unable to retrieve user information'
      });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Send message to Slack
    const slackMessage = {
      text: `New message from UC Member`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "📩 New Message from UC Member"
          }
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*From:* ${user.fullName}`
            },
            {
              type: "mrkdwn",
              text: `*Email:* ${user.email}`
            },
            {
              type: "mrkdwn",
              text: `*Role:* ${user.role}`
            },
            {
              type: "mrkdwn",
              text: `*Time:* ${new Date().toLocaleString()}`
            }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Message:*\n${message.trim()}`
          }
        }
      ]
    };

    try {
      await sendSlackMessage(slackMessage);
    } catch (slackError) {
      console.error('[POST /api/member/message-admin] Slack error:', slackError);
      // Don't fail the request if Slack is down, but log the error
      console.warn('Slack message failed, but continuing with success response');
    }

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('[POST /api/member/message-admin] Unexpected error:', error);
    res.status(500).json({ 
      error: 'Failed to send message',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Flag a document (member access)
router.post('/flag-document', requireAuth, async (req, res) => {
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

    // Get the active cycle first
    const activeCycle = await resolveCycleForRequest(prisma, req);

    if (!activeCycle) {
      return res.status(400).json({ error: 'No active recruitment cycle found' });
    }

    // Check if the member has access to this application (they must be assigned to review it)
    const memberGroup = await prisma.groups.findFirst({
      where: {
        cycleId: activeCycle.id,
        OR: [
          { memberOne: flaggedBy },
          { memberTwo: flaggedBy },
          { memberThree: flaggedBy },
          { groupMembers: { some: { userId: flaggedBy } } }
        ],
        assignedCandidates: {
          some: {
            applications: {
              some: {
                id: applicationId
              }
            }
          }
        }
      }
    });

    if (!memberGroup) {
      return res.status(403).json({ error: 'You do not have permission to flag this application' });
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
      return res.status(400).json({ error: 'This document is already flagged' });
    }

    // Create the flag
    const flaggedDocument = await prisma.flaggedDocument.create({
      data: {
        applicationId,
        documentType,
        reason,
        message: message?.trim() || null,
        flaggedBy,
        isResolved: false
      },
      include: {
        application: {
          select: {
            id: true,
            studentId: true,
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

    // Send Slack notification
    try {
      const slackMessage = `🚩 Document Flagged\n\n` +
        `**Application:** Student ${flaggedDocument.application.studentId}\n` +
        `**Document Type:** ${documentType}\n` +
        `**Reason:** ${reason}\n` +
        `**Flagged by:** ${flaggedDocument.flagger.fullName}\n` +
        `**Message:** ${message || 'No additional details provided'}\n\n` +
        `Please review this flagged document in the admin panel.`;

      await sendSlackMessage(slackMessage);
    } catch (slackError) {
      console.error('Failed to send Slack notification for flagged document:', slackError);
      // Don't fail the request if Slack notification fails
    }

    res.status(201).json({
      message: 'Document flagged successfully',
      flaggedDocument
    });
  } catch (error) {
    console.error('[POST /api/member/flag-document]', error);
    res.status(500).json({ error: 'Failed to flag document' });
  }
});

// ---------------------------------------------------------------------------
// Member resume - Talent Partner Network
// ---------------------------------------------------------------------------
// A member's own resume plus the consent that makes it assignable to a partner
// client. Gated on MEMBER specifically rather than requireAdminOrMember: an
// admin uploading "their" member resume is meaningless. The ownership key is
// always req.user.id, never a route param.

const __memberDirname = path.dirname(fileURLToPath(import.meta.url));
// Same root cases.js uses. Deliberately NOT uploads/, which index.js serves
// statically and unauthenticated - a resume there would be world-readable.

// In memory so the file can be named by the DB-generated row id, matching the
// reasoning in cases.js.
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Resume must be a PDF'));
  }
});

// There is no global Express error handler in this app, so an unwrapped multer
// rejection returns an HTML 500 that the client renders as
// "Server Error (500): <!doctype html...". This wrapper is what turns it into a
// usable message. Pattern copied from routes/featureRequests.js.
function resumeUploadMiddleware(req, res, next) {
  resumeUpload.single('resume')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Resume must be 10MB or smaller' });
      }
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message || 'Invalid file upload' });
  });
}

const requireMemberRole = (req, res, next) => {
  if (req.user?.role !== 'MEMBER') {
    return res.status(403).json({ error: 'Member access required' });
  }
  next();
};

const loadOwnResume = (memberId) =>
  prisma.memberResume.findFirst({ where: { memberId, isCurrent: true } });

const countLiveAssignments = (resumeId) =>
  resumeId
    ? prisma.clientResumeAssignment.count({ where: { memberResumeId: resumeId, revokedAt: null } })
    : Promise.resolve(0);

router.get('/resume', requireAuth, requireMemberRole, async (req, res) => {
  try {
    const resume = await loadOwnResume(req.user.id);
    const assignedCount = await countLiveAssignments(resume?.id);
    res.json({ resume: serializeMemberResume(resume, assignedCount), genders: MEMBER_GENDERS });
  } catch (error) {
    console.error('[GET /api/member/resume]', error);
    res.status(500).json({ error: 'Failed to load your resume' });
  }
});

router.post('/resume', requireAuth, requireMemberRole, resumeUploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Attach a PDF resume' });
    }

    const { value, errors } = sanitizeMemberResumeInput(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // Re-uploading supersedes rather than overwrites. An assignment already
    // committed to a client keeps pointing at the exact file that was assigned,
    // which is what makes the snapshot true for members as well as applicants.
    const created = await prisma.$transaction(async (tx) => {
      await tx.memberResume.updateMany({
        where: { memberId: req.user.id, isCurrent: true },
        data: { isCurrent: false }
      });
      return tx.memberResume.create({
        data: {
          memberId: req.user.id,
          isCurrent: true,
          storagePath: 'pending',
          originalName: req.file.originalname ? req.file.originalname.slice(0, 255) : 'resume.pdf',
          fileSize: req.file.size,
          major1: value.major1,
          major2: value.major2,
          graduationYear: value.graduationYear,
          gender: value.gender,
          shareConsent: value.shareConsent,
          consentAt: value.shareConsent ? new Date() : null
        }
      });
    });

    const relPath = `member-resumes/${created.id}/resume.pdf`;
    try {
      await putResume(relPath, req.file.buffer);
    } catch (writeError) {
      // Leaving a row pointing at a file that does not exist would make the
      // resume look uploaded and then 404 for whoever opens it.
      await prisma.memberResume.delete({ where: { id: created.id } }).catch(() => {});
      throw writeError;
    }

    const resume = await prisma.memberResume.update({
      where: { id: created.id },
      data: { storagePath: relPath }
    });

    res.status(201).json({ resume: serializeMemberResume(resume, 0) });
  } catch (error) {
    console.error('[POST /api/member/resume]', error);
    res.status(500).json({ error: 'Failed to upload your resume' });
  }
});

router.patch('/resume/consent', requireAuth, requireMemberRole, async (req, res) => {
  try {
    const shareConsent = req.body?.shareConsent === true || req.body?.shareConsent === 'true';

    const existing = await loadOwnResume(req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Upload a resume first' });
    }

    const now = new Date();

    const resume = await prisma.$transaction(async (tx) => {
      const updated = await tx.memberResume.update({
        where: { id: existing.id },
        data: {
          shareConsent,
          consentAt: shareConsent ? now : existing.consentAt,
          consentRevokedAt: shareConsent ? null : now
        }
      });

      if (!shareConsent) {
        // Withdrawal takes effect immediately rather than waiting for an admin
        // to notice. This is the one place the snapshot rule yields, and it
        // yields to the person whose resume it is.
        await tx.clientResumeAssignment.updateMany({
          where: { memberResumeId: existing.id, revokedAt: null },
          data: { revokedAt: now, revokedById: req.user.id }
        });
      }

      return updated;
    });

    const assignedCount = await countLiveAssignments(resume.id);
    res.json({ resume: serializeMemberResume(resume, assignedCount) });
  } catch (error) {
    console.error('[PATCH /api/member/resume/consent]', error);
    res.status(500).json({ error: 'Failed to update your sharing preference' });
  }
});

router.get('/resume/pdf', requireAuth, requireMemberRole, async (req, res) => {
  try {
    const resume = await loadOwnResume(req.user.id);
    if (!resume) return res.status(404).json({ error: 'No resume on file' });

    if (!resume.storagePath.startsWith('member-resumes/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const buffer = await getResume(resume.storagePath);
    if (!buffer) {
      // Distinct from the "no resume" above on purpose. A row with no file
      // behind it is a storage fault, and reporting it as "you never uploaded
      // one" is what made this take a production debugging session to find.
      return res.status(404).json({ error: 'Your resume file could not be found. Please upload it again.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  } catch (error) {
    console.error('[GET /api/member/resume/pdf]', error);
    res.status(500).json({ error: 'Failed to load your resume' });
  }
});

router.delete('/resume', requireAuth, requireMemberRole, async (req, res) => {
  try {
    const existing = await loadOwnResume(req.user.id);
    if (!existing) return res.status(404).json({ error: 'No resume on file' });

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.memberResume.update({
        where: { id: existing.id },
        data: { isCurrent: false, shareConsent: false, consentRevokedAt: now }
      });
      await tx.clientResumeAssignment.updateMany({
        where: { memberResumeId: existing.id, revokedAt: null },
        data: { revokedAt: now, revokedById: req.user.id }
      });
    });

    // The file stays on disk on purpose: revoked assignment rows still
    // reference this resume, and the history is worth more than a few hundred KB.
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/member/resume]', error);
    res.status(500).json({ error: 'Failed to remove your resume' });
  }
});

export default router;
