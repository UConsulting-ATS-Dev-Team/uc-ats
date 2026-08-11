import prisma from '../prismaClient.js';
import { getGroupMemberUsers } from '../utils/groupMembers.js';
import { readSnapshotVersion } from '../utils/snapshotVersion.js';

// The Staging console renders six resources as a single screen, so each of them has
// to be readable through the same database transaction: that is what makes one
// `snapshotVersion` describe all of them instead of only the candidate read. Each
// loader therefore takes a Prisma client (`prisma`, or a transaction client) and
// returns data instead of writing a response; the routes below map them to HTTP and
// `loadStagingSnapshot` maps them to one transactional read.

// Six reads serialized on one connection; the admin console tolerates a slow refresh
// far better than an incoherent one.
const SNAPSHOT_MAX_WAIT_MS = 10 * 1000;
const SNAPSHOT_TIMEOUT_MS = 30 * 1000;

export async function loadActiveCycle(client) {
  return (await client.recruitingCycle.findFirst({ where: { isActive: true } })) || null;
}

export async function loadEvents(client) {
  // Get the active cycle to filter events
  const activeCycle = await client.recruitingCycle.findFirst({
    where: { isActive: true },
    select: { id: true }
  });

  // Only return events from the active cycle (or empty if no active cycle)
  return client.events.findMany({
    where: activeCycle ? { cycleId: activeCycle.id } : { cycleId: 'none' },
    orderBy: { eventStartDate: 'desc' },
    include: {
      cycle: {
        select: { name: true, isActive: true }
      }
    }
  });
}

export async function loadReviewTeams(client) {
  const active = await client.recruitingCycle.findFirst({ where: { isActive: true } });
  if (!active) return [];

  const reviewTeams = await client.groups.findMany({
    where: { cycleId: active.id },
    select: {
      id: true,
      name: true,
      memberOneUser: { select: { id: true, fullName: true, email: true, profileImage: true } },
      memberTwoUser: { select: { id: true, fullName: true, email: true, profileImage: true } },
      memberThreeUser: { select: { id: true, fullName: true, email: true, profileImage: true } },
      groupMembers: {
        select: {
          userId: true,
          user: { select: { id: true, fullName: true, email: true, profileImage: true } }
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  // Transform to include team name and member count
  return reviewTeams.map(team => {
    const members = getGroupMemberUsers(team);

    // Use the name from the database if it exists, otherwise generate a fallback name
    const teamName = team.name || (members.length > 0
      ? `Team ${team.id.slice(-4)} (${members.map(m => m.fullName.split(' ')[0]).join(', ')})`
      : `Team ${team.id.slice(-4)}`);

    return {
      id: team.id,
      name: teamName,
      members: members,
      memberCount: members.length
    };
  });
}

export async function loadExistingDecisions(client) {
  const active = await client.recruitingCycle.findFirst({ where: { isActive: true } });
  if (!active) {
    return { decisions: {}, perRoundDecisions: { resume: {}, coffee: {}, firstRound: {}, final: {} } };
  }

  // Get all applications for the current cycle with per-round decision fields
  const applications = await client.application.findMany({
    where: {
      cycleId: active.id
    },
    select: {
      id: true,
      candidateId: true,
      approved: true,
      currentRound: true,
      resumeDecision: true,
      coffeeChatDecision: true,
      firstRoundDecision: true,
      finalRoundDecision: true
    }
  });

  // Build per-round decisions structure
  const perRoundDecisions = {
    resume: {},
    coffee: {},
    firstRound: {},
    final: {}
  };

  // Legacy format for backward compatibility
  const decisions = {};

  applications.forEach(app => {
    // Per-round decisions from new fields
    if (app.resumeDecision) perRoundDecisions.resume[app.id] = app.resumeDecision;
    if (app.coffeeChatDecision) perRoundDecisions.coffee[app.id] = app.coffeeChatDecision;
    if (app.firstRoundDecision) perRoundDecisions.firstRound[app.id] = app.firstRoundDecision;
    if (app.finalRoundDecision) perRoundDecisions.final[app.id] = app.finalRoundDecision;

    // Legacy: use approved field for backward compatibility
    if (app.approved === true) {
      decisions[app.id] = 'yes';
    } else if (app.approved === false) {
      decisions[app.id] = 'no';
    }
  });

  return { decisions, perRoundDecisions };
}

export async function loadStagingCandidates(client, { page, limit } = {}) {
  const usePagination = Boolean(page && limit);
  const skip = usePagination ? (page - 1) * limit : 0;

  const active = await client.recruitingCycle.findFirst({
    where: { isActive: true },
    select: { id: true, startDate: true, endDate: true }
  });
  console.log('Active cycle:', active ? active.id : 'No active cycle found');
  if (!active) {
    return { candidates: [], total: 0, page: usePagination ? page : 1, totalPages: 0, hasNextPage: false, hasPrevPage: false };
  }

  // Get total count for pagination (only if using pagination)
  let totalCount = 0;
  if (usePagination) {
    totalCount = await client.application.count({
      where: { cycleId: active.id }
    });
  }

  // Optimized query - only get essential data first
  const queryOptions = {
    where: { cycleId: active.id },
    include: {
      candidate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          studentId: true,
          assignedGroupId: true,
          // Only get referrals for the current cycle
          referrals: {
            where: { cycleId: active.id },
            select: {
              id: true,
              referrerName: true
            },
            take: 1 // Only need one referral
          }
        }
      }
    },
    orderBy: { submittedAt: 'desc' }
  };

  // Add pagination options only if using pagination
  if (usePagination) {
    queryOptions.skip = skip;
    queryOptions.take = limit;
  }

  const applications = await client.application.findMany(queryOptions);

  console.log(`Found ${applications.length} applications for staging candidates`);


  // Get all candidate IDs and student IDs for batch queries
  const candidateIds = applications.map(app => app.candidateId).filter(Boolean);
  const studentIds = applications.map(app => app.studentId).filter(Boolean);
  const reviewTeamIds = applications.map(app => app.candidate?.assignedGroupId).filter(Boolean);
  
  console.log(`Found ${candidateIds.length} candidate IDs, ${studentIds.length} student IDs, ${reviewTeamIds.length} review team IDs`);
  console.log('Prisma object:', typeof prisma, prisma ? 'defined' : 'undefined');

  // Batch fetch all related data in parallel
  console.log('Starting batch queries...');
  
  const allResumeScores = await client.resumeScore.findMany({
    where: { candidateId: { in: candidateIds }, cycleId: active.id },
    select: { candidateId: true, overallScore: true, adminScore: true }
  });
  console.log('Resume scores fetched:', allResumeScores.length);
  
  const allCoverLetterScores = await client.coverLetterScore.findMany({
    where: { candidateId: { in: candidateIds }, cycleId: active.id },
    select: { candidateId: true, overallScore: true, adminScore: true }
  });
  console.log('Cover letter scores fetched:', allCoverLetterScores.length);
  
  const allVideoScores = await client.videoScore.findMany({
    where: { candidateId: { in: candidateIds }, cycleId: active.id },
    select: { candidateId: true, overallScore: true, adminScore: true }
  });
  console.log('Video scores fetched:', allVideoScores.length);
  
  const allEventAttendance = await client.eventAttendance.findMany({
    where: {
      candidateId: { in: candidateIds },
      event: {
        cycleId: active.id  // Only include attendance for events in the current cycle
      }
    },
    select: { candidateId: true, eventId: true, event: { select: { id: true, eventName: true, cycleId: true } } }
  });
  console.log('Event attendance fetched:', allEventAttendance.length);
  // Debug: log unique events being counted
  const uniqueEvents = [...new Set(allEventAttendance.map(att => `${att.event.eventName} (cycleId: ${att.event.cycleId}, eventId: ${att.eventId})`))];
  console.log('Unique events in attendance:', uniqueEvents);
  
  // Only count meetings within the current cycle's date range
  // If the cycle has no start date, we cannot determine which meetings belong to this cycle,
  // so we don't count any GTKUC attendance to avoid crediting old meetings
  const cycleStartDate = active.startDate ? new Date(active.startDate) : null;
  const cycleEndDate = active.endDate ? new Date(active.endDate) : null;

  let allMeetingAttendance = [];
  if (cycleStartDate) {
    // Only query for meetings if we have at least a start date to filter by
    allMeetingAttendance = await client.meetingSignup.findMany({
      where: {
        studentId: { in: studentIds },
        attended: true,
        slot: {
          startTime: {
            gte: cycleStartDate,
            ...(cycleEndDate && { lte: cycleEndDate })
          }
        }
      },
      select: { studentId: true }
    });
  }
  console.log('Meeting attendance fetched:', allMeetingAttendance.length);
  
  const allReviewTeams = await client.groups.findMany({
    where: { id: { in: reviewTeamIds } },
    select: {
      id: true,
      memberOneUser: { select: { fullName: true, profileImage: true } },
      memberTwoUser: { select: { fullName: true, profileImage: true } },
      memberThreeUser: { select: { fullName: true, profileImage: true } },
      groupMembers: {
        select: {
          user: { select: { fullName: true, profileImage: true } }
        }
      }
    }
  });
  console.log('Review teams fetched:', allReviewTeams.length);

  // Create lookup maps for efficient data access
  const resumeScoresMap = new Map();
  const coverLetterScoresMap = new Map();
  const videoScoresMap = new Map();
  const eventAttendanceMap = new Map();
  const meetingAttendanceSet = new Set(allMeetingAttendance.map(ma => ma.studentId));
  const reviewTeamsMap = new Map();

  // Populate lookup maps - use adminScore if available, otherwise use overallScore
  allResumeScores.forEach(score => {
    if (!resumeScoresMap.has(score.candidateId)) resumeScoresMap.set(score.candidateId, []);
    // Use adminScore override if it exists, otherwise use overallScore
    const scoreToUse = score.adminScore !== null && score.adminScore !== undefined 
      ? parseFloat(score.adminScore) 
      : parseFloat(score.overallScore);
    resumeScoresMap.get(score.candidateId).push(scoreToUse);
  });

  allCoverLetterScores.forEach(score => {
    if (!coverLetterScoresMap.has(score.candidateId)) coverLetterScoresMap.set(score.candidateId, []);
    // Use adminScore override if it exists, otherwise use overallScore
    const scoreToUse = score.adminScore !== null && score.adminScore !== undefined 
      ? parseFloat(score.adminScore) 
      : parseFloat(score.overallScore);
    coverLetterScoresMap.get(score.candidateId).push(scoreToUse);
  });

  allVideoScores.forEach(score => {
    if (!videoScoresMap.has(score.candidateId)) videoScoresMap.set(score.candidateId, []);
    // Use adminScore override if it exists, otherwise use overallScore
    const scoreToUse = score.adminScore !== null && score.adminScore !== undefined 
      ? parseFloat(score.adminScore) 
      : parseFloat(score.overallScore);
    videoScoresMap.get(score.candidateId).push(scoreToUse);
  });

  // Use a Set to track unique eventIds per candidate to prevent duplicate counting
  const eventAttendanceByCandidate = new Map();
  allEventAttendance.forEach(att => {
    if (!eventAttendanceByCandidate.has(att.candidateId)) {
      eventAttendanceByCandidate.set(att.candidateId, new Set());
    }
    // Only add if we haven't seen this eventId for this candidate
    eventAttendanceByCandidate.get(att.candidateId).add(att.eventId);
  });

  // Now build the eventAttendanceMap with unique events only
  allEventAttendance.forEach(att => {
    if (!eventAttendanceMap.has(att.candidateId)) eventAttendanceMap.set(att.candidateId, []);
    const events = eventAttendanceMap.get(att.candidateId);
    // Only add event name if we haven't added this eventId yet
    if (!events.some(e => e.eventId === att.eventId)) {
      events.push({ eventId: att.eventId, eventName: att.event.eventName });
    }
  });

  allReviewTeams.forEach(team => {
    const members = getGroupMemberUsers(team);

    reviewTeamsMap.set(team.id, {
      id: team.id,
      name: members.length > 0 
        ? `Team ${team.id.slice(-4)} (${members.map(m => m.fullName.split(' ')[0]).join(', ')})`
        : `Team ${team.id.slice(-4)}`,
      members: members,
      memberCount: members.length
    });
  });

  // Process applications with pre-fetched data (no more async operations)
  // Filter out applications without candidates
  const validApplications = applications.filter(app => app.candidate);
  console.log(`Processing ${validApplications.length} valid applications (${applications.length - validApplications.length} without candidates)`);
  
  const stagingCandidates = validApplications.map(app => {
    // Get scores from maps
    const resumeScores = resumeScoresMap.get(app.candidateId) || [];
    const coverLetterScores = coverLetterScoresMap.get(app.candidateId) || [];
    const videoScores = videoScoresMap.get(app.candidateId) || [];

    // Calculate averages
    const avgResume = resumeScores.length > 0 ? 
      resumeScores.reduce((a, b) => a + b, 0) / resumeScores.length : 0;
    const avgCoverLetter = coverLetterScores.length > 0 ? 
      coverLetterScores.reduce((a, b) => a + b, 0) / coverLetterScores.length : 0;
    const avgVideo = videoScores.length > 0 ? 
      videoScores.reduce((a, b) => a + b, 0) / videoScores.length : 0;

    // Calculate overall total by summing all document scores
    let overallScore = 0;
    if (avgResume > 0) overallScore += avgResume;
    if (avgCoverLetter > 0) overallScore += avgCoverLetter;
    if (avgVideo > 0) overallScore += avgVideo;

    // Add participation points (events + GTKUC meeting, capped at 3 total)
    const attendedEvents = eventAttendanceMap.get(app.candidateId) || [];
    let participationCount = attendedEvents.length;

    // GTKUC meeting counts as a participation point
    if (meetingAttendanceSet.has(app.studentId)) {
      participationCount += 1;
    }

    // Cap at 3 points max (even if they attended all 4: info, womens, case, GTKUC)
    const totalParticipationPoints = Math.min(participationCount, 3);
    overallScore += totalParticipationPoints;


    // Build attendance object from pre-fetched data
    const attendance = {};
    attendedEvents.forEach(event => {
      attendance[event.eventName] = true;
    });

    // Add GTKUC attendance if candidate attended a meeting this cycle
    if (meetingAttendanceSet.has(app.studentId)) {
      attendance['GTKUC'] = true;
    }

    // Use the actual currentRound from the database, fallback to status-based calculation
    let currentRound = app.currentRound ? parseInt(app.currentRound) : 1; // Default to Resume Review
    if (!app.currentRound) {
      // Fallback logic for legacy applications without currentRound
      if (app.status === 'UNDER_REVIEW') currentRound = 2; // First Interview
      else if (app.status === 'ACCEPTED') currentRound = 4; // Final Decision
      else if (app.status === 'REJECTED') currentRound = 4; // Final Decision
    }

    // Get review team information from pre-fetched data
    const reviewTeam = app.candidate.assignedGroupId ? 
      (reviewTeamsMap.get(app.candidate.assignedGroupId) || null) : null;

    return {
      id: app.id,
      candidateId: app.candidateId,
      firstName: app.firstName,
      lastName: app.lastName,
      email: app.email,
      studentId: app.studentId,
      major: app.major1,
      graduationYear: app.graduationYear,
      cumulativeGpa: parseFloat(app.cumulativeGpa),
      majorGpa: parseFloat(app.majorGpa),
      status: app.status,
      currentRound,
      submittedAt: app.submittedAt,
      isTransferStudent: app.isTransferStudent,
      isFirstGeneration: app.isFirstGeneration,
      gender: app.gender,
      phoneNumber: app.phoneNumber,
      headshotUrl: app.headshotUrl,
      attendance,
      reviewTeam,
      scores: {
        resume: parseFloat(avgResume.toFixed(1)),
        coverLetter: parseFloat(avgCoverLetter.toFixed(1)),
        video: parseFloat(avgVideo.toFixed(1)),
        overall: parseFloat(overallScore.toFixed(1))
      },
      decisions: {
        resumeReview: app.status === 'SUBMITTED' ? null : 'ADVANCE',
        firstInterview: app.status === 'UNDER_REVIEW' ? null : 
                       app.status === 'ACCEPTED' || app.status === 'REJECTED' ? 'ADVANCE' : null,
        secondInterview: app.status === 'ACCEPTED' || app.status === 'REJECTED' ? 'ADVANCE' : null,
        final: app.status === 'ACCEPTED' ? 'ACCEPT' : 
               app.status === 'REJECTED' ? 'REJECT' : null
      },
      hasReferral: app.candidate.referrals && app.candidate.referrals.length > 0,
      referral: app.candidate.referrals && app.candidate.referrals.length > 0 ? app.candidate.referrals[0] : null,
      notes: ''
    };
  });

  console.log(`Processed ${stagingCandidates.length} staging candidates`);
  
  const totalPages = usePagination ? Math.ceil(totalCount / limit) : 1;
  return {
    candidates: stagingCandidates,
    total: usePagination ? totalCount : stagingCandidates.length,
    page: usePagination ? page : 1,
    totalPages,
    hasNextPage: usePagination ? page < totalPages : false,
    hasPrevPage: usePagination ? page > 1 : false
  };
}

export async function loadAdminApplications(client, { page, limit } = {}) {
  const usePagination = Boolean(page && limit);
  const skip = usePagination ? (page - 1) * limit : 0;

  const activeCycle = await client.recruitingCycle.findFirst({
    where: { isActive: true }
  });

  if (!activeCycle) {
    return { applications: [], total: 0, page: usePagination ? page : 1, totalPages: 0, hasNextPage: false, hasPrevPage: false };
  }

  // Get total count for pagination (only if using pagination)
  let totalCount = 0;
  if (usePagination) {
    totalCount = await client.application.count({
      where: { cycleId: activeCycle.id }
    });
  }

  // Get applications for the active cycle
  const queryOptions = {
    where: {
      cycleId: activeCycle.id
    },
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
  };

  // Add pagination options only if using pagination
  if (usePagination) {
    queryOptions.skip = skip;
    queryOptions.take = limit;
  }

  const applications = await client.application.findMany(queryOptions);

  // Get all groups and their members for the active cycle
  const groups = await client.groups.findMany({
    where: {
      cycleId: activeCycle.id
    },
    select: {
      id: true,
      name: true,
      memberOne: true,
      memberTwo: true,
      memberThree: true,
      memberOneUser: {
        select: {
          id: true,
          fullName: true,
          email: true, profileImage: true }
      },
      memberTwoUser: {
        select: {
          id: true,
          fullName: true,
          email: true, profileImage: true }
      },
      memberThreeUser: {
        select: {
          id: true,
          fullName: true,
          email: true, profileImage: true }
      },
      groupMembers: {
        select: {
          userId: true,
          user: { select: { id: true, fullName: true, email: true, profileImage: true } }
        }
      }
    }
  });

  // Get all grading records for these candidates
  const resumeScores = await client.resumeScore.findMany({
    where: {
      candidateId: {
        in: applications.map(app => app.candidateId)
      },
      cycleId: activeCycle.id
    },
    select: {
      candidateId: true,
      evaluatorId: true,
      assignedGroupId: true
    }
  });

  // Get flagged documents for these applications
  const flaggedDocuments = await client.flaggedDocument.findMany({
    where: {
      applicationId: {
        in: applications.map(app => app.id)
      },
      isResolved: false
    },
    select: {
      applicationId: true,
      documentType: true,
      reason: true,
      message: true,
      flaggedBy: true,
      createdAt: true
    }
  });

  const coverLetterScores = await client.coverLetterScore.findMany({
    where: {
      candidateId: {
        in: applications.map(app => app.candidateId)
      },
      cycle: {
        id: activeCycle.id
      }
    },
    select: {
      candidateId: true,
      evaluatorId: true,
      assignedGroupId: true
    }
  });

  const videoScores = await client.videoScore.findMany({
    where: {
      candidateId: {
        in: applications.map(app => app.candidateId)
      },
      cycle: {
        id: activeCycle.id
      }
    },
    select: {
      candidateId: true,
      evaluatorId: true,
      assignedGroupId: true
    }
  });

  // Helper function to check team completion and get missing grades count
  const checkTeamCompletion = (candidateId, groupId, scores, scoreType) => {
    if (!groupId) return { completed: false, missingGrades: 0, totalMembers: 0, teamMembers: [], completedEvaluators: [] };
    
    const group = groups.find(g => g.id === groupId);
    if (!group) return { completed: false, missingGrades: 0, totalMembers: 0, teamMembers: [], completedEvaluators: [] };
    
    // Get all assigned team members with user info (filter out null/undefined)
    const teamMembers = getGroupMemberUsers(group);
    
    if (teamMembers.length === 0) return { completed: false, missingGrades: 0, totalMembers: 0, teamMembers: [], completedEvaluators: [] };
    
    // Get scores for this candidate and group
    const candidateScores = scores.filter(score => 
      score.candidateId === candidateId && score.assignedGroupId === groupId
    );
    
    // Check if all team members have completed their scores
    const completedEvaluators = candidateScores.map(score => score.evaluatorId);
    const allMembersCompleted = teamMembers.every(member => 
      completedEvaluators.includes(member.id)
    );
    
    const missingGrades = teamMembers.length - completedEvaluators.length;
    
    return {
      completed: allMembersCompleted,
      missingGrades,
      totalMembers: teamMembers.length,
      teamMembers: teamMembers,
      completedEvaluators: completedEvaluators
    };
  };

  // Helper function to get flag info for a document type
  const getFlagInfo = (applicationId, documentType) => {
    return flaggedDocuments.find(flag => 
      flag.applicationId === applicationId && flag.documentType === documentType
    );
  };

  // Transform the data
  const transformedApplications = [];
  
  applications.forEach(app => {
    const resumeStatus = checkTeamCompletion(app.candidateId, app.candidate.assignedGroupId, resumeScores, 'resume');
    const coverLetterStatus = checkTeamCompletion(app.candidateId, app.candidate.assignedGroupId, coverLetterScores, 'coverLetter');
    const videoStatus = checkTeamCompletion(app.candidateId, app.candidate.assignedGroupId, videoScores, 'video');
    
    const assignedGroup = app.candidate.assignedGroupId
      ? groups.find(g => g.id === app.candidate.assignedGroupId)
      : null;
    
    transformedApplications.push({
      id: app.id,
      candidateId: app.candidateId,
      name: `${app.firstName} ${app.lastName}`,
      major: app.major1 || 'N/A',
      year: app.graduationYear || 'N/A',
      gpa: app.cumulativeGpa?.toString() || 'N/A',
      status: app.status || 'SUBMITTED',
      approved: app.approved, // Add approved field for decision status
      currentRound: app.currentRound, // Add currentRound field for round filtering
      email: app.email,
      submittedAt: app.submittedAt,
      gender: app.gender || 'N/A',
      isFirstGeneration: app.isFirstGeneration,
      isTransferStudent: app.isTransferStudent,
      resumeUrl: app.resumeUrl,
      coverLetterUrl: app.coverLetterUrl,
      videoUrl: app.videoUrl,
      headshotUrl: app.headshotUrl,
      groupId: assignedGroup?.id || null,
      groupName: assignedGroup?.name || (assignedGroup ? `Team ${assignedGroup.id.slice(-4)}` : 'Unknown Team'),
      hasResumeScore: resumeStatus.completed,
      hasCoverLetterScore: coverLetterStatus.completed,
      hasVideoScore: videoStatus.completed,
      resumeMissingGrades: resumeStatus.missingGrades,
      coverLetterMissingGrades: coverLetterStatus.missingGrades,
      videoMissingGrades: videoStatus.missingGrades,
      resumeTotalMembers: resumeStatus.totalMembers,
      coverLetterTotalMembers: coverLetterStatus.totalMembers,
      videoTotalMembers: videoStatus.totalMembers,
      groupMembers: resumeStatus.teamMembers, // Team members info
      resumeCompletedEvaluators: resumeStatus.completedEvaluators,
      coverLetterCompletedEvaluators: coverLetterStatus.completedEvaluators,
      videoCompletedEvaluators: videoStatus.completedEvaluators,
      // Flag information
      resumeFlagged: getFlagInfo(app.id, 'resume'),
      coverLetterFlagged: getFlagInfo(app.id, 'coverLetter'),
      videoFlagged: getFlagInfo(app.id, 'video')
    });
  });

  const totalPages = usePagination ? Math.ceil(totalCount / limit) : 1;
  return {
    applications: transformedApplications,
    total: usePagination ? totalCount : transformedApplications.length,
    page: usePagination ? page : 1,
    totalPages,
    hasNextPage: usePagination ? page < totalPages : false,
    hasPrevPage: usePagination ? page > 1 : false
  };
}

/**
 * Reads every resource the Staging console applies as one snapshot, inside a single
 * repeatable-read transaction, and stamps it with the database's own clock read in
 * that same transaction.
 *
 * Both halves matter for the version to mean anything:
 * - repeatable read fixes the transaction's database snapshot at its first statement,
 *   so all six resources describe the same committed state — not six states seen at
 *   six different moments through six requests
 * - the stamp is `clock_timestamp()` from the database, taken as that first statement,
 *   so `a.snapshotVersion < b.snapshotVersion` means b's state includes every commit
 *   a could see, no matter which API instance served either read
 */
export async function loadStagingSnapshot(client = prisma) {
  return client.$transaction(
    async (tx) => {
      // First statement in the transaction: this is both the snapshot's version and
      // the point in time the reads below are consistent as of.
      const snapshotVersion = await readSnapshotVersion(tx);

      const candidates = await loadStagingCandidates(tx);
      const activeCycle = await loadActiveCycle(tx);
      const applications = await loadAdminApplications(tx);
      const events = await loadEvents(tx);
      const reviewTeams = await loadReviewTeams(tx);
      const existingDecisions = await loadExistingDecisions(tx);

      return {
        snapshotVersion,
        candidates: candidates.candidates,
        activeCycle,
        applications: applications.applications,
        events,
        reviewTeams,
        ...existingDecisions
      };
    },
    {
      isolationLevel: 'RepeatableRead',
      maxWait: SNAPSHOT_MAX_WAIT_MS,
      timeout: SNAPSHOT_TIMEOUT_MS
    }
  );
}
