import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import config from '../config.js';
import { sendReviewerReminder } from '../services/emailNotifications.js';
import {
  getGroupMemberUsers,
  getGroupMemberIds,
  isGroupMember,
  getFirstEmptyLegacySlot,
  buildCreateGroupData,
  groupMemberUserInclude
} from '../utils/groupMembers.js';

const router = express.Router();

// Admin audit of each reviewer's grading contribution within their assigned team.
router.get('/contributions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const activeCycle = await prisma.recruitingCycle.findFirst({
      where: { isActive: true },
      select: { id: true }
    });

    if (!activeCycle) {
      return res.json([]);
    }

    const groups = await prisma.groups.findMany({
      where: { cycleId: activeCycle.id },
      select: {
        id: true,
        assignedCandidates: {
          select: {
            id: true,
            applications: {
              where: { cycleId: activeCycle.id },
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: { resumeUrl: true, coverLetterUrl: true, videoUrl: true }
            }
          }
        },
        memberOneUser: { select: { id: true, fullName: true, email: true, profileImage: true } },
        memberTwoUser: { select: { id: true, fullName: true, email: true, profileImage: true } },
        memberThreeUser: { select: { id: true, fullName: true, email: true, profileImage: true } },
        groupMembers: {
          select: {
            userId: true,
            user: { select: { id: true, fullName: true, email: true, profileImage: true } }
          }
        }
      }
    });

    const candidateIds = groups.flatMap(group => group.assignedCandidates.map(candidate => candidate.id));
    const scoreFilter = {
      candidateId: { in: candidateIds },
      cycleId: activeCycle.id,
      assignedGroupId: { not: null }
    };

    const [resumeScores, coverLetterScores, videoScores] = await Promise.all([
      prisma.resumeScore.findMany({ where: scoreFilter, select: { evaluatorId: true, assignedGroupId: true } }),
      prisma.coverLetterScore.findMany({ where: scoreFilter, select: { evaluatorId: true, assignedGroupId: true } }),
      prisma.videoScore.findMany({ where: scoreFilter, select: { evaluatorId: true, assignedGroupId: true } })
    ]);

    const countScores = (scores, groupId, evaluatorId) => scores.filter(score =>
      score.assignedGroupId === groupId && score.evaluatorId === evaluatorId
    ).length;

    res.json(groups.map(group => {
      const applications = group.assignedCandidates
        .map(candidate => candidate.applications[0])
        .filter(Boolean);
      const eligible = {
        resume: applications.filter(application => Boolean(application.resumeUrl)).length,
        coverLetter: applications.filter(application => Boolean(application.coverLetterUrl)).length,
        video: applications.filter(application => Boolean(application.videoUrl)).length
      };

      const members = getGroupMemberUsers(group)
        .map(member => {
          const completed = {
            resume: countScores(resumeScores, group.id, member.id),
            coverLetter: countScores(coverLetterScores, group.id, member.id),
            video: countScores(videoScores, group.id, member.id)
          };
          const completedTotal = completed.resume + completed.coverLetter + completed.video;
          const expectedTotal = eligible.resume + eligible.coverLetter + eligible.video;

          return {
            ...member,
            completed,
            eligible,
            completedTotal,
            expectedTotal,
            completionPercent: expectedTotal ? Math.round((completedTotal / expectedTotal) * 100) : 0
          };
        });

      return { groupId: group.id, members };
    }));
  } catch (error) {
    console.error('Error fetching reviewer contributions:', error);
    res.status(500).json({ error: 'Failed to fetch reviewer contributions' });
  }
});

// Send a grading reminder to a specific reviewer on a team.
router.post('/:groupId/reviewers/:reviewerId/reminder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { groupId, reviewerId } = req.params;

    const activeCycle = await prisma.recruitingCycle.findFirst({
      where: { isActive: true },
      select: { id: true, name: true }
    });

    if (!activeCycle) {
      return res.status(400).json({ error: 'No active recruiting cycle' });
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        cycleId: true,
        memberOne: true,
        memberTwo: true,
        memberThree: true,
        groupMembers: { select: { userId: true } },
        assignedCandidates: {
          select: {
            id: true,
            applications: {
              where: { cycleId: activeCycle.id },
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: { resumeUrl: true, coverLetterUrl: true, videoUrl: true }
            }
          }
        }
      }
    });

    if (!group || group.cycleId !== activeCycle.id) {
      return res.status(404).json({ error: 'Review team not found in the active cycle' });
    }

    if (!isGroupMember(group, reviewerId)) {
      return res.status(400).json({ error: 'Reviewer is not a member of this review team' });
    }

    const reviewer = await prisma.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, fullName: true, email: true, profileImage: true }
    });

    if (!reviewer) {
      return res.status(404).json({ error: 'Reviewer not found' });
    }

    if (!reviewer.email || !reviewer.email.includes('@')) {
      return res.status(400).json({ error: 'Reviewer does not have a valid email address' });
    }

    const candidateIds = group.assignedCandidates.map(candidate => candidate.id);

    const scoreFilter = {
      candidateId: { in: candidateIds },
      cycleId: activeCycle.id,
      evaluatorId: reviewerId,
      assignedGroupId: groupId
    };

    const [resumeScores, coverLetterScores, videoScores] = await Promise.all([
      prisma.resumeScore.findMany({ where: scoreFilter, select: { id: true } }),
      prisma.coverLetterScore.findMany({ where: scoreFilter, select: { id: true } }),
      prisma.videoScore.findMany({ where: scoreFilter, select: { id: true } })
    ]);

    const applications = group.assignedCandidates
      .map(candidate => candidate.applications[0])
      .filter(Boolean);

    const eligible = {
      resume: applications.filter(application => Boolean(application.resumeUrl)).length,
      coverLetter: applications.filter(application => Boolean(application.coverLetterUrl)).length,
      video: applications.filter(application => Boolean(application.videoUrl)).length
    };

    const completed = {
      resume: resumeScores.length,
      coverLetter: coverLetterScores.length,
      video: videoScores.length
    };

    const completedTotal = completed.resume + completed.coverLetter + completed.video;
    const expectedTotal = eligible.resume + eligible.coverLetter + eligible.video;
    const completionPercent = expectedTotal ? Math.round((completedTotal / expectedTotal) * 100) : 0;

    const result = await sendReviewerReminder(
      reviewer.email,
      reviewer.fullName,
      group.name || `Team ${group.id.slice(-4)}`,
      activeCycle.name || 'Current cycle',
      {
        completed,
        eligible,
        completedTotal,
        expectedTotal,
        completionPercent,
        gradingUrl: `${config.clientUrl}/document-grading`
      }
    );

    if (!result.success) {
      return res.status(502).json({ error: 'Failed to send reminder email', details: result.error });
    }

    res.json({ message: 'Reminder sent successfully' });
  } catch (error) {
    console.error('Error sending reviewer reminder:', error);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// Get all groups with their members and assigned candidates
router.get('/', requireAuth, async (req, res) => {
  try {
    console.log('Review teams endpoint called');
    
    // Get the active cycle first
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
    console.log('Active cycle found:', activeCycle?.id);
    
    if (!activeCycle) {
      console.log('No active cycle found, returning empty array');
      return res.json([]);
    }

    console.log('Fetching groups for cycle:', activeCycle.id);
    
    // Simplified query to avoid connection issues
    const groups = await prisma.groups.findMany({
      where: {
        cycleId: activeCycle.id
      },
      include: {
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
        },
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
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    console.log('Groups fetched successfully, count:', groups.length);

    console.log('Starting data transformation');
    
    // Get all candidate IDs to fetch their scores
    const allCandidateIds = groups.flatMap(group => 
      group.assignedCandidates.map(candidate => candidate.id)
    );
    
    // Fetch all scores for these candidates with full details
    const resumeScores = await prisma.resumeScore.findMany({
      where: {
        candidateId: {
          in: allCandidateIds
        }
      },
      select: {
        candidateId: true,
        evaluatorId: true,
        overallScore: true,
        assignedGroupId: true,
        evaluator: {
          select: {
            id: true,
            fullName: true, profileImage: true }
        }
      }
    });
    
    const coverLetterScores = await prisma.coverLetterScore.findMany({
      where: {
        candidateId: {
          in: allCandidateIds
        }
      },
      select: {
        candidateId: true,
        evaluatorId: true,
        overallScore: true,
        assignedGroupId: true,
        evaluator: {
          select: {
            id: true,
            fullName: true, profileImage: true }
        }
      }
    });
    
    const videoScores = await prisma.videoScore.findMany({
      where: {
        candidateId: {
          in: allCandidateIds
        }
      },
      select: {
        candidateId: true,
        evaluatorId: true,
        overallScore: true,
        assignedGroupId: true,
        evaluator: {
          select: {
            id: true,
            fullName: true, profileImage: true }
        }
      }
    });
    
    // Helper function to detect outlier scores
    // threshold: minimum point difference to be considered an outlier
    // teamMemberCount: total number of team members who should grade
    const detectOutliers = (scores, candidateId, groupId, threshold, teamMemberCount) => {
      // Filter scores for this specific candidate and group
      const relevantScores = scores.filter(
        score => score.candidateId === candidateId && score.assignedGroupId === groupId
      );
      
      // Only detect outliers if ALL team members have submitted their scores
      if (relevantScores.length < teamMemberCount || teamMemberCount < 2) {
        return []; // Need all team members to have graded before detecting outliers
      }
      
      const scoreValues = relevantScores.map(s => s.overallScore);
      const mean = scoreValues.reduce((sum, val) => sum + val, 0) / scoreValues.length;
      
      // Detect outliers based on absolute point difference from mean
      const outliers = [];
      relevantScores.forEach(score => {
        const deviationFromMean = Math.abs(score.overallScore - mean);
        
        // Only flag as outlier if deviation exceeds the threshold
        if (deviationFromMean >= threshold) {
          outliers.push({
            evaluatorId: score.evaluatorId,
            evaluatorName: score.evaluator.fullName,
            score: score.overallScore,
            mean: Math.round(mean * 10) / 10,
            deviation: Math.round(deviationFromMean * 10) / 10,
            isHigher: score.overallScore > mean
          });
        }
      });
      
      return outliers;
    };
    
    // Transform the data to match the frontend expectations
    const transformedGroups = groups.map(group => {
      const members = getGroupMemberUsers(group);
      const teamMemberIds = getGroupMemberIds(group);

      const applications = group.assignedCandidates.map(candidate => {
        // Get the latest application for this candidate
        const latestApplication = candidate.applications[0];
        
        if (!latestApplication) {
          return null; // Skip candidates without applications
        }

        // Calculate progress for each document type
        // Progress is based on how many team members have scored each document
        const candidateResumeScores = resumeScores.filter(score => 
          score.candidateId === candidate.id && 
          score.assignedGroupId === group.id &&
          teamMemberIds.includes(score.evaluatorId));
        const candidateCoverLetterScores = coverLetterScores.filter(score => 
          score.candidateId === candidate.id && 
          score.assignedGroupId === group.id &&
          teamMemberIds.includes(score.evaluatorId));
        const candidateVideoScores = videoScores.filter(score => 
          score.candidateId === candidate.id && 
          score.assignedGroupId === group.id &&
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

        // Detect outlier scores for this candidate
        // Resume: 4 points difference minimum
        // Cover Letter: 2 points difference minimum
        // Video: 2 points difference minimum
        // Only flag outliers if all team members have submitted grades
        const resumeOutliers = detectOutliers(resumeScores, candidate.id, group.id, 4, teamMemberIds.length);
        const coverLetterOutliers = detectOutliers(coverLetterScores, candidate.id, group.id, 2, teamMemberIds.length);
        const videoOutliers = detectOutliers(videoScores, candidate.id, group.id, 2, teamMemberIds.length);

        return {
          id: latestApplication.id, // Use the actual application ID
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
          avatar: null,
          // Outlier information
          resumeOutliers,
          coverLetterOutliers,
          videoOutliers,
          hasOutliers: resumeOutliers.length > 0 || coverLetterOutliers.length > 0 || videoOutliers.length > 0
        };
      }).filter(Boolean); // Remove null entries

      return {
        id: group.id,
        name: group.name || `Team ${group.id.slice(-4)}`,
        code: group.id.slice(-8),
        members: members.map(member => ({
          id: member.id,
          name: member.fullName,
          fullName: member.fullName,
          email: member.email,
          profileImage: member.profileImage,
          avatar: member.profileImage
        })),
        applications,
        cycleId: group.cycleId,
        cycleName: group.cycle?.name
      };
    });

    res.json(transformedGroups);
  } catch (error) {
    console.error('Error fetching groups:', error);
    
    // Check if it's a database connection error
    if (error.code === 'P1001') {
      console.error('Database connection error detected');
      return res.status(503).json({ 
        error: 'Database temporarily unavailable. Please try again in a few moments.',
        details: 'The database connection is currently unavailable. This might be due to the Supabase project being paused or experiencing issues.'
      });
    }
    
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Create a new group
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, memberIds, memberOne, memberTwo, memberThree, cycleId } = req.body;

    // Validate that cycleId is provided
    if (!cycleId) {
      return res.status(400).json({ error: 'Cycle ID is required' });
    }

    // Check if cycle exists
    const cycle = await prisma.recruitingCycle.findUnique({
      where: { id: cycleId }
    });

    if (!cycle) {
      return res.status(404).json({ error: 'Cycle not found' });
    }

    // Support the new memberIds array as well as legacy individual fields
    let incomingMemberIds = [];
    if (Array.isArray(memberIds)) {
      incomingMemberIds = memberIds;
    } else {
      incomingMemberIds = [memberOne, memberTwo, memberThree].filter(Boolean);
    }
    incomingMemberIds = [...new Set(incomingMemberIds.filter(Boolean))];

    // Validate that every requested member exists and is allowed to review
    if (incomingMemberIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: incomingMemberIds } },
        select: { id: true, role: true }
      });
      const allowedIds = new Set(
        users.filter(u => u.role === 'ADMIN' || u.role === 'MEMBER').map(u => u.id)
      );
      const invalid = incomingMemberIds.find(id => !allowedIds.has(id));
      if (invalid) {
        return res.status(400).json({ error: 'Invalid or unauthorized user in member list' });
      }
    }

    const group = await prisma.groups.create({
      data: buildCreateGroupData(name, cycleId, incomingMemberIds),
      include: {
        ...groupMemberUserInclude,
        cycle: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    const members = getGroupMemberUsers(group);

    const transformedGroup = {
      id: group.id,
      name: group.name || `Team ${group.id.slice(-4)}`,
      code: group.id.slice(-8),
      members: members.map(member => ({
        id: member.id,
        name: member.fullName,
        fullName: member.fullName,
        email: member.email,
        profileImage: member.profileImage,
        avatar: member.profileImage
      })),
      applications: [],
      cycleId: group.cycleId,
      cycleName: group.cycle?.name
    };

    res.status(201).json(transformedGroup);
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Assign application to group
router.post('/:groupId/assign-application', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { applicationId } = req.body;

    // Check if group exists
    const group = await prisma.groups.findUnique({
      where: { id: groupId }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Check if application exists
    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        candidate: {
          select: {
            id: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Update candidate's assigned group (since applications are linked to candidates)
    const updatedCandidate = await prisma.candidate.update({
      where: { id: application.candidateId },
      data: { assignedGroupId: groupId }
    });
    
    const transformedApplication = {
      id: application.id,
      candidateId: application.candidateId,
      name: `${application.firstName} ${application.lastName}`,
      major: application.major1 || 'N/A',
      year: application.graduationYear || 'N/A',
      gpa: application.cumulativeGpa?.toString() || 'N/A',
      status: application.status || 'SUBMITTED',
      email: application.email,
      submittedAt: application.submittedAt,
      resumeProgress: 0,
      coverLetterProgress: 0,
      videoProgress: 0,
      avatar: null
    };

    res.json(transformedApplication);
  } catch (error) {
    console.error('Error assigning application to group:', error);
    res.status(500).json({ error: 'Failed to assign application to group' });
  }
});

// Remove application from group
router.delete('/:groupId/remove-application/:applicationId', requireAuth, async (req, res) => {
  try {
    const { groupId, applicationId } = req.params;

    // Check if group exists
    const group = await prisma.groups.findUnique({
      where: { id: groupId }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Get the application to find the candidate ID
    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { candidateId: true }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Update candidate to remove group assignment
    await prisma.candidate.update({
      where: { id: application.candidateId },
      data: { assignedGroupId: null }
    });

    res.json({ message: 'Application removed from group successfully' });
  } catch (error) {
    console.error('Error removing application from group:', error);
    res.status(500).json({ error: 'Failed to remove application from group' });
  }
});

// Rename a group
router.put('/:groupId/rename', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Team name is required' });
    }

    const updatedGroup = await prisma.groups.update({
      where: { id: groupId },
      data: { name: name.trim() },
      select: {
        id: true,
        name: true
      }
    });

    res.json(updatedGroup);
  } catch (error) {
    console.error('Error renaming group:', error);
    res.status(500).json({ error: 'Failed to rename group' });
  }
});

// Add one or more members to an existing review team.
router.put('/:groupId/members', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { memberId, memberIds } = req.body;

    const idsToAdd = [...new Set(
      (Array.isArray(memberIds) ? memberIds : [memberId]).filter(Boolean)
    )];

    if (idsToAdd.length === 0) {
      return res.status(400).json({ error: 'Member ID is required' });
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      include: {
        ...groupMemberUserInclude,
        cycle: { select: { id: true } }
      }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const currentMemberIds = getGroupMemberIds(group);

    // Validate each user exists and is allowed to review
    const users = await prisma.user.findMany({
      where: { id: { in: idsToAdd } },
      select: { id: true, role: true }
    });
    const allowedIds = new Set(
      users.filter(u => u.role === 'ADMIN' || u.role === 'MEMBER').map(u => u.id)
    );

    for (const id of idsToAdd) {
      if (currentMemberIds.includes(id)) {
        return res.status(400).json({ error: 'Member is already on this team' });
      }
      if (!allowedIds.has(id)) {
        return res.status(400).json({ error: 'Invalid or unauthorized user' });
      }
    }

    // Fill legacy slots first, then create join-table records for overflow
    const updateData = {};
    const additionalMembers = [];
    let currentGroup = group;

    for (const id of idsToAdd) {
      const slot = getFirstEmptyLegacySlot(currentGroup);
      if (slot) {
        updateData[slot] = id;
        // Keep our in-memory view consistent for the next iteration
        currentGroup[slot] = id;
      } else {
        additionalMembers.push({ groupId, userId: id });
      }
    }

    const ops = [];
    if (Object.keys(updateData).length > 0) {
      ops.push(prisma.groups.update({ where: { id: groupId }, data: updateData }));
    }
    if (additionalMembers.length > 0) {
      ops.push(
        prisma.groupMember.createMany({
          data: additionalMembers,
          skipDuplicates: true
        })
      );
    }

    await prisma.$transaction(ops);

    const updatedGroup = await prisma.groups.findUnique({
      where: { id: groupId },
      include: groupMemberUserInclude
    });

    const members = getGroupMemberUsers(updatedGroup);

    const transformedMembers = members.map(member => ({
      id: member.id,
      name: member.fullName,
      fullName: member.fullName,
      email: member.email,
      profileImage: member.profileImage,
      avatar: member.profileImage
    }));

    res.json(transformedMembers);
  } catch (error) {
    console.error('Error updating group members:', error);
    res.status(500).json({ error: 'Failed to update group members' });
  }
});

// Remove a specific member from a group
router.delete('/:groupId/members/:memberId', requireAuth, async (req, res) => {
  try {
    const { groupId, memberId } = req.params;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        memberOne: true,
        memberTwo: true,
        memberThree: true
      }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    let updateData = {};
    let foundInLegacy = false;
    if (group.memberOne === memberId) {
      updateData.memberOne = null;
      foundInLegacy = true;
    } else if (group.memberTwo === memberId) {
      updateData.memberTwo = null;
      foundInLegacy = true;
    } else if (group.memberThree === memberId) {
      updateData.memberThree = null;
      foundInLegacy = true;
    }

    const ops = [];
    if (foundInLegacy) {
      ops.push(prisma.groups.update({ where: { id: groupId }, data: updateData }));
    }
    ops.push(prisma.groupMember.deleteMany({ where: { groupId, userId: memberId } }));

    const transactionResults = await prisma.$transaction(ops);
    const deleteResult = transactionResults[transactionResults.length - 1];

    if (!foundInLegacy && deleteResult.count === 0) {
      return res.status(404).json({ error: 'Member not found in this group' });
    }

    const updatedGroup = await prisma.groups.findUnique({
      where: { id: groupId },
      include: groupMemberUserInclude
    });

    const members = getGroupMemberUsers(updatedGroup);

    const transformedMembers = members.map(member => ({
      id: member.id,
      name: member.fullName,
      fullName: member.fullName,
      email: member.email,
      profileImage: member.profileImage,
      avatar: member.profileImage
    }));

    res.json(transformedMembers);
  } catch (error) {
    console.error('Error removing group member:', error);
    res.status(500).json({ error: 'Failed to remove group member' });
  }
});

// Get available applications (not assigned to any group)
router.get('/available-applications', requireAuth, async (req, res) => {
  try {
    // Get the active cycle
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
    if (!activeCycle) {
      return res.json([]);
    }

    // Get applications that are not assigned to any group
    // We need to get the latest application for each candidate that's not assigned to a group
    const unassignedCandidates = await prisma.candidate.findMany({
      where: {
        assignedGroupId: null,
        applications: {
          some: {
            cycleId: activeCycle.id
          }
        }
      },
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
    });

    const applications = unassignedCandidates
      .map(candidate => candidate.applications[0])
      .filter(Boolean); // Remove any candidates without applications

    const transformedApplications = applications.map(application => ({
      id: application.id,
      candidateId: application.candidateId,
      name: `${application.firstName} ${application.lastName}`,
      major: application.major1 || 'N/A',
      year: application.graduationYear || 'N/A',
      gpa: application.cumulativeGpa?.toString() || 'N/A',
      email: application.email,
      submittedAt: application.submittedAt
    }));

    res.json(transformedApplications);
  } catch (error) {
    console.error('Error fetching available applications:', error);
    res.status(500).json({ error: 'Failed to fetch available applications' });
  }
});

// Get all users for member selection (ADMIN and MEMBER roles only)
router.get('/users', requireAuth, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        role: {
          in: ['ADMIN', 'MEMBER']
        }
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        profileImage: true
      },
      orderBy: {
        fullName: 'asc'
      }
    });

    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get candidates assigned to a specific member's review team
router.get('/member/:memberId/candidates', requireAuth, async (req, res) => {
  try {
    const { memberId } = req.params;
    
    // Get the active cycle first
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
    if (!activeCycle) {
      return res.json([]);
    }

    // Find groups where the member is part of the team
    const memberGroups = await prisma.groups.findMany({
      where: {
        cycleId: activeCycle.id,
        OR: [
          { memberOne: memberId },
          { memberTwo: memberId },
          { memberThree: memberId },
          { groupMembers: { some: { userId: memberId } } }
        ]
      },
      include: {
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
        }
      }
    });

    // Collect all candidates from all groups the member is part of
    const allCandidates = [];
    
    memberGroups.forEach(group => {
      group.assignedCandidates.forEach(candidate => {
        const latestApplication = candidate.applications[0];
        
        if (latestApplication) {
          allCandidates.push({
            id: latestApplication.id,
            candidateId: candidate.id,
            name: `${latestApplication.firstName} ${latestApplication.lastName}`,
            major: latestApplication.major1 || 'N/A',
            year: latestApplication.graduationYear || 'N/A',
            gpa: latestApplication.cumulativeGpa?.toString() || 'N/A',
            status: latestApplication.status || 'SUBMITTED',
            email: latestApplication.email,
            submittedAt: latestApplication.submittedAt,
            resumeUrl: latestApplication.resumeUrl,
            coverLetterUrl: latestApplication.coverLetterUrl,
            videoUrl: latestApplication.videoUrl,
            groupId: group.id,
            groupName: `Team ${group.id.slice(-4)}`
          });
        }
      });
    });

    res.json(allCandidates);
  } catch (error) {
    console.error('Error fetching member candidates:', error);
    res.status(500).json({ error: 'Failed to fetch member candidates' });
  }
});

// Auto-distribute applications evenly among all teams
router.post('/auto-distribute', requireAuth, async (req, res) => {
  try {
    // Get the active cycle
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
    if (!activeCycle) {
      return res.status(400).json({ error: 'No active cycle found' });
    }

    // Get all teams for the active cycle
    const teams = await prisma.groups.findMany({
      where: { cycleId: activeCycle.id },
      select: { id: true }
    });

    if (teams.length === 0) {
      return res.status(400).json({ error: 'No teams found for the active cycle' });
    }

    // Get all candidates with applications in the active cycle
    // Include their assigned group info to check if it's in the active cycle
    const allCandidatesWithApplications = await prisma.candidate.findMany({
      where: {
        applications: {
          some: {
            cycleId: activeCycle.id
          }
        }
      },
      include: {
        applications: {
          where: {
            cycleId: activeCycle.id
          },
          orderBy: {
            submittedAt: 'desc'
          },
          take: 1 // Only get the latest application
        },
        assignedGroup: {
          select: {
            id: true,
            cycleId: true
          }
        }
      }
    });
    
    console.log(`Found ${allCandidatesWithApplications.length} candidates with applications in active cycle`);
    
    // Filter to get only unassigned candidates OR candidates assigned to groups not in active cycle
    const unassignedCandidates = allCandidatesWithApplications.filter(candidate => {
      // If not assigned, include them
      if (!candidate.assignedGroupId) {
        return true;
      }
      // If assigned to a group, check if that group is in the active cycle
      if (candidate.assignedGroup) {
        // If the assigned group's cycleId doesn't match active cycle, include them (needs reassignment)
        return candidate.assignedGroup.cycleId !== activeCycle.id;
      }
      // If assignedGroupId is set but the group doesn't exist (orphaned reference), include them
      return true;
    });
    
    console.log(`Found ${unassignedCandidates.length} unassigned candidates for active cycle`);

    // Extract the latest application for each candidate
    const availableApplications = unassignedCandidates
      .map(candidate => ({
        application: candidate.applications[0],
        candidateId: candidate.id
      }))
      .filter(item => item.application) // Remove any candidates without applications
      .sort((a, b) => new Date(a.application.submittedAt) - new Date(b.application.submittedAt)); // Sort by oldest first

    if (availableApplications.length === 0) {
      return res.json({ message: 'No applications available to distribute' });
    }

    // Distribute applications evenly among teams
    const applicationsPerTeam = Math.ceil(availableApplications.length / teams.length);
    let currentTeamIndex = 0;

    for (let i = 0; i < availableApplications.length; i++) {
      const { candidateId } = availableApplications[i];
      const teamId = teams[currentTeamIndex].id;

      // Assign the candidate to the team
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { assignedGroupId: teamId }
      });

      // Move to next team in round-robin fashion
      currentTeamIndex = (currentTeamIndex + 1) % teams.length;
    }

    res.json({ 
      message: `Successfully distributed ${availableApplications.length} applications among ${teams.length} teams`,
      applicationsDistributed: availableApplications.length,
      teamsUsed: teams.length
    });

  } catch (error) {
    console.error('Error auto-distributing applications:', error);
    res.status(500).json({ error: 'Failed to auto-distribute applications' });
  }
});

// Get applications assigned to a specific member's review team
router.get('/member-applications/:memberId', requireAuth, async (req, res) => {
  try {
    const { memberId } = req.params;
    const evaluatorId = req.user?.id;
    console.log('Fetching applications for member:', memberId);
    
    // Get the active cycle first
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });
    
    console.log('Active cycle:', activeCycle?.id);
    
    if (!activeCycle) {
      console.log('No active cycle found');
      return res.json([]);
    }

    // First, let's check if the member exists and get their groups
    const memberGroups = await prisma.groups.findMany({
      where: {
        cycleId: activeCycle.id,
        OR: [
          { memberOne: memberId },
          { memberTwo: memberId },
          { memberThree: memberId },
          { groupMembers: { some: { userId: memberId } } }
        ]
      },
      select: {
        id: true,
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

    console.log('Member groups found:', memberGroups.length);

    if (memberGroups.length === 0) {
      console.log('No groups found for member');
      return res.json([]);
    }

    // Get candidates assigned to these groups
    const groupIds = memberGroups.map(group => group.id);
    const candidates = await prisma.candidate.findMany({
      where: {
        assignedGroupId: {
          in: groupIds
        }
      },
      include: {
        applications: {
          where: {
            cycleId: activeCycle.id
          },
          orderBy: {
            submittedAt: 'desc'
          },
          take: 1
        }
      }
    });

    console.log('Candidates found:', candidates.length);

    // Get grading records for these candidates for THIS evaluator (filtered by current cycle)
    const resumeScores = await prisma.resumeScore.findMany({
      where: {
        evaluatorId: evaluatorId,
        cycleId: activeCycle.id,
        candidateId: {
          in: candidates.map(c => c.id)
        }
      },
      select: {
        candidateId: true
      }
    });

    const coverLetterScores = await prisma.coverLetterScore.findMany({
      where: {
        evaluatorId: evaluatorId,
        cycleId: activeCycle.id,
        candidateId: {
          in: candidates.map(c => c.id)
        }
      },
      select: {
        candidateId: true
      }
    });

    const videoScores = await prisma.videoScore.findMany({
      where: {
        evaluatorId: evaluatorId,
        cycleId: activeCycle.id,
        candidateId: {
          in: candidates.map(c => c.id)
        }
      },
      select: {
        candidateId: true
      }
    });

    // Get ALL grading records for these candidates (not just current evaluator) for team completion calculation (filtered by current cycle)
    const allResumeScores = await prisma.resumeScore.findMany({
      where: {
        cycleId: activeCycle.id,
        candidateId: {
          in: candidates.map(c => c.id)
        }
      },
      select: {
        candidateId: true,
        evaluatorId: true,
        assignedGroupId: true
      }
    });

    // Get flagged documents for these applications
    const flaggedDocuments = await prisma.flaggedDocument.findMany({
      where: {
        applicationId: {
          in: candidates.flatMap(c => c.applications.map(app => app.id))
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

    const allCoverLetterScores = await prisma.coverLetterScore.findMany({
      where: {
        cycleId: activeCycle.id,
        candidateId: {
          in: candidates.map(c => c.id)
        }
      },
      select: {
        candidateId: true,
        evaluatorId: true,
        assignedGroupId: true
      }
    });

    const allVideoScores = await prisma.videoScore.findMany({
      where: {
        cycleId: activeCycle.id,
        candidateId: {
          in: candidates.map(c => c.id)
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
      
      const group = memberGroups.find(g => g.id === groupId);
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

    // Transform the data
    const applications = [];
    console.log('Starting to process candidates:', candidates.length);
    
    candidates.forEach(candidate => {
      const latestApplication = candidate.applications[0];
      if (latestApplication) {
        const group = memberGroups.find(g => g.id === candidate.assignedGroupId);
        const hasResumeScore = resumeScores.some(score => score.candidateId === candidate.id);
        const hasCoverLetterScore = coverLetterScores.some(score => score.candidateId === candidate.id);
        const hasVideoScore = videoScores.some(score => score.candidateId === candidate.id);
        
        // Calculate team completion status
        const resumeStatus = checkTeamCompletion(candidate.id, candidate.assignedGroupId, allResumeScores, 'resume');
        const coverLetterStatus = checkTeamCompletion(candidate.id, candidate.assignedGroupId, allCoverLetterScores, 'coverLetter');
        const videoStatus = checkTeamCompletion(candidate.id, candidate.assignedGroupId, allVideoScores, 'video');
        
        // Get flag information for this application
        const resumeFlag = flaggedDocuments.find(flag => 
          flag.applicationId === latestApplication.id && flag.documentType === 'resume'
        );
        const coverLetterFlag = flaggedDocuments.find(flag => 
          flag.applicationId === latestApplication.id && flag.documentType === 'coverLetter'
        );
        const videoFlag = flaggedDocuments.find(flag => 
          flag.applicationId === latestApplication.id && flag.documentType === 'video'
        );

        applications.push({
          id: latestApplication.id,
          candidateId: candidate.id,
          cycleId: activeCycle.id,
          studentId: candidate.studentId,
          name: `${latestApplication.firstName} ${latestApplication.lastName}`,
          major: latestApplication.major1 || 'N/A',
          year: latestApplication.graduationYear || 'N/A',
          gpa: latestApplication.cumulativeGpa?.toString() || 'N/A',
          status: latestApplication.status || 'SUBMITTED',
          email: latestApplication.email,
          submittedAt: latestApplication.submittedAt,
          headshotUrl: latestApplication.headshotUrl,
          gender: latestApplication.gender || 'N/A',
          isFirstGeneration: latestApplication.isFirstGeneration,
          isTransferStudent: latestApplication.isTransferStudent,
          resumeUrl: latestApplication.resumeUrl,
          coverLetterUrl: latestApplication.coverLetterUrl,
          videoUrl: latestApplication.videoUrl,
          groupId: group?.id,
          groupName: group ? `Team ${group.id.slice(-4)}` : 'Unknown Team',
          hasResumeScore: hasResumeScore, // Individual member's completion status
          hasCoverLetterScore: hasCoverLetterScore, // Individual member's completion status
          hasVideoScore: hasVideoScore, // Individual member's completion status
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
          resumeFlagged: resumeFlag || null,
          coverLetterFlagged: coverLetterFlag || null,
          videoFlagged: videoFlag || null
        });
      }
    });

    console.log('Applications processed:', applications.length);
    
    // Ensure we always return an array
    if (!Array.isArray(applications)) {
      console.error('Applications is not an array:', applications);
      return res.json([]);
    }
    
    res.json(applications);
  } catch (error) {
    console.error('Error fetching member applications:', error);
    // Return empty array instead of error object to prevent frontend filter errors
    res.json([]);
  }
});

// Test endpoint to check if the route is working
router.get('/test', requireAuth, async (req, res) => {
  try {
    res.json({ 
      message: 'Review teams route is working',
      user: req.user?.id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ error: 'Test endpoint failed' });
  }
});

// Save resume score (per evaluator per candidate)
router.post('/resume-score', requireAuth, async (req, res) => {
  try {
    const { candidateId, assignedGroupId, scoreOne, scoreTwo, scoreThree, notes, cycleId } = req.body;
    const evaluatorId = req.user.id;

    // Calculate overall score (sum of the two scores for resume: Content/Relevance/Impact + Structure/Formatting)
    const scores = [scoreOne, scoreTwo].filter(score => score !== null && score !== undefined);
    const overallScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) : 0;

    // Get cycleId from assignedGroup if not provided
    let finalCycleId = cycleId;
    if (!finalCycleId && assignedGroupId) {
      const group = await prisma.groups.findUnique({
        where: { id: assignedGroupId },
        select: { cycleId: true }
      });
      if (group) {
        finalCycleId = group.cycleId;
      }
    }
    // If still no cycleId, get from candidate's most recent application
    if (!finalCycleId) {
      const application = await prisma.application.findFirst({
        where: { candidateId },
        orderBy: { submittedAt: 'desc' },
        select: { cycleId: true }
      });
      if (application?.cycleId) {
        finalCycleId = application.cycleId;
      }
    }

    // Check if a score already exists for this candidate, evaluator, and cycle
    const existingScoreWhere = { candidateId, evaluatorId };
    if (finalCycleId) {
      existingScoreWhere.cycleId = finalCycleId;
    }
    const existingScore = await prisma.resumeScore.findFirst({
      where: existingScoreWhere
    });

    let resumeScore;
    if (existingScore) {
      // Update existing score
      resumeScore = await prisma.resumeScore.update({
        where: { id: existingScore.id },
        data: {
          overallScore,
          scoreOne,
          scoreTwo,
          scoreThree,
          notes,
          assignedGroupId,
          cycleId: finalCycleId,
          status: 'completed'
        }
      });
    } else {
      // Create new score
      resumeScore = await prisma.resumeScore.create({
        data: {
          candidateId,
          evaluatorId,
          assignedGroupId,
          overallScore,
          scoreOne,
          scoreTwo,
          scoreThree,
          notes,
          cycleId: finalCycleId,
          status: 'completed'
        }
      });
    }

    res.json(resumeScore);
  } catch (error) {
    console.error('Error saving resume score:', error);
    res.status(500).json({ error: 'Failed to save resume score' });
  }
});

// Get resume score for a candidate (for current evaluator)
router.get('/resume-score/:candidateId', requireAuth, async (req, res) => {
  try {
    const { candidateId } = req.params;
    let { cycleId } = req.query;
    const evaluatorId = req.user.id;

    // If no cycleId provided, get the active cycle
    if (!cycleId) {
      const activeCycle = await prisma.recruitingCycle.findFirst({
        where: { isActive: true }
      });
      if (activeCycle) {
        cycleId = activeCycle.id;
      }
    }

    const whereClause = { candidateId, evaluatorId };
    if (cycleId) {
      whereClause.cycleId = cycleId;
    }

    const resumeScore = await prisma.resumeScore.findFirst({
      where: whereClause
    });

    res.json(resumeScore || null);
  } catch (error) {
    console.error('Error fetching resume score:', error);
    res.status(500).json({ error: 'Failed to fetch resume score' });
  }
});

// Get all resume scores for a candidate
router.get('/resume-scores/:candidateId', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const { candidateId } = req.params;
    const { cycleId } = req.query;

    const whereClause = { candidateId };
    if (cycleId) {
      whereClause.cycleId = cycleId;
    }

    const resumeScores = await prisma.resumeScore.findMany({
      where: whereClause,
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(resumeScores);
  } catch (error) {
    console.error('Error fetching resume scores:', error);
    res.status(500).json({ error: 'Failed to fetch resume scores' });
  }
});

// Save cover letter score (per evaluator per candidate)
router.post('/cover-letter-score', requireAuth, async (req, res) => {
  try {
    const { candidateId, assignedGroupId, scoreOne, scoreTwo, scoreThree, notes, cycleId } = req.body;
    const evaluatorId = req.user.id;

    // Calculate overall score (average of the three scores)
    const scores = [scoreOne, scoreTwo, scoreThree].filter(score => score !== null && score !== undefined);
    const overallScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;

    // Get cycleId from assignedGroup if not provided
    let finalCycleId = cycleId;
    if (!finalCycleId && assignedGroupId) {
      const group = await prisma.groups.findUnique({
        where: { id: assignedGroupId },
        select: { cycleId: true }
      });
      if (group) {
        finalCycleId = group.cycleId;
      }
    }
    // If still no cycleId, get from candidate's most recent application
    if (!finalCycleId) {
      const application = await prisma.application.findFirst({
        where: { candidateId },
        orderBy: { submittedAt: 'desc' },
        select: { cycleId: true }
      });
      if (application?.cycleId) {
        finalCycleId = application.cycleId;
      }
    }

    // Check if a score already exists for this candidate, evaluator, and cycle
    const existingScoreWhere = { candidateId, evaluatorId };
    if (finalCycleId) {
      existingScoreWhere.cycleId = finalCycleId;
    }
    const existingScore = await prisma.coverLetterScore.findFirst({
      where: existingScoreWhere
    });

    let coverLetterScore;
    if (existingScore) {
      // Update existing score
      coverLetterScore = await prisma.coverLetterScore.update({
        where: { id: existingScore.id },
        data: {
          overallScore,
          scoreOne,
          scoreTwo,
          scoreThree,
          notesOne: notes, // Store general notes in notesOne field
          assignedGroupId,
          cycleId: finalCycleId,
          status: 'completed'
        }
      });
    } else {
      // Create new score
      coverLetterScore = await prisma.coverLetterScore.create({
        data: {
          candidateId,
          evaluatorId,
          assignedGroupId,
          overallScore,
          scoreOne,
          scoreTwo,
          scoreThree,
          notesOne: notes, // Store general notes in notesOne field
          cycleId: finalCycleId,
          status: 'completed'
        }
      });
    }

    res.json(coverLetterScore);
  } catch (error) {
    console.error('Error saving cover letter score:', error);
    res.status(500).json({ error: 'Failed to save cover letter score' });
  }
});

// Get cover letter score for a candidate (for current evaluator)
router.get('/cover-letter-score/:candidateId', requireAuth, async (req, res) => {
  try {
    const { candidateId } = req.params;
    let { cycleId } = req.query;
    const evaluatorId = req.user.id;

    // If no cycleId provided, get the active cycle
    if (!cycleId) {
      const activeCycle = await prisma.recruitingCycle.findFirst({
        where: { isActive: true }
      });
      if (activeCycle) {
        cycleId = activeCycle.id;
      }
    }

    const whereClause = { candidateId, evaluatorId };
    if (cycleId) {
      whereClause.cycleId = cycleId;
    }

    const coverLetterScore = await prisma.coverLetterScore.findFirst({
      where: whereClause
    });

    // Transform the response to match frontend expectations
    if (coverLetterScore) {
      const transformedScore = {
        ...coverLetterScore,
        notes: coverLetterScore.notesOne // Map notesOne to notes for frontend compatibility
      };
      res.json(transformedScore);
    } else {
      res.json(null);
    }
  } catch (error) {
    console.error('Error fetching cover letter score:', error);
    res.status(500).json({ error: 'Failed to fetch cover letter score' });
  }
});

// Get all cover letter scores for a candidate
router.get('/cover-letter-scores/:candidateId', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const { candidateId } = req.params;
    const { cycleId } = req.query;

    const whereClause = { candidateId };
    if (cycleId) {
      whereClause.cycleId = cycleId;
    }

    const coverLetterScores = await prisma.coverLetterScore.findMany({
      where: whereClause,
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(coverLetterScores);
  } catch (error) {
    console.error('Error fetching cover letter scores:', error);
    res.status(500).json({ error: 'Failed to fetch cover letter scores' });
  }
});

// Save video score (per evaluator per candidate)
router.post('/video-score', requireAuth, async (req, res) => {
  try {
    const { candidateId, assignedGroupId, scoreOne, scoreTwo, scoreThree, notes, cycleId } = req.body;
    const evaluatorId = req.user.id;

    // Calculate overall score (for video, just use scoreOne since it's a single category)
    const overallScore = scoreOne || 0;

    // Get cycleId from assignedGroup if not provided
    let finalCycleId = cycleId;
    if (!finalCycleId && assignedGroupId) {
      const group = await prisma.groups.findUnique({
        where: { id: assignedGroupId },
        select: { cycleId: true }
      });
      if (group) {
        finalCycleId = group.cycleId;
      }
    }
    // If still no cycleId, get from candidate's most recent application
    if (!finalCycleId) {
      const application = await prisma.application.findFirst({
        where: { candidateId },
        orderBy: { submittedAt: 'desc' },
        select: { cycleId: true }
      });
      if (application?.cycleId) {
        finalCycleId = application.cycleId;
      }
    }

    // Check if a score already exists for this candidate, evaluator, and cycle
    const existingScoreWhere = { candidateId, evaluatorId };
    if (finalCycleId) {
      existingScoreWhere.cycleId = finalCycleId;
    }
    const existingScore = await prisma.videoScore.findFirst({
      where: existingScoreWhere
    });

    let videoScore;
    if (existingScore) {
      // Update existing score
      videoScore = await prisma.videoScore.update({
        where: { id: existingScore.id },
        data: {
          overallScore,
          scoreOne,
          scoreTwo,
          scoreThree,
          notesOne: notes, // Store general notes in notesOne field
          assignedGroupId,
          cycleId: finalCycleId,
          status: 'completed'
        }
      });
    } else {
      // Create new score
      videoScore = await prisma.videoScore.create({
        data: {
          candidateId,
          evaluatorId,
          assignedGroupId,
          overallScore,
          scoreOne,
          scoreTwo,
          scoreThree,
          notesOne: notes, // Store general notes in notesOne field
          cycleId: finalCycleId,
          status: 'completed'
        }
      });
    }

    res.json(videoScore);
  } catch (error) {
    console.error('Error saving video score:', error);
    res.status(500).json({ error: 'Failed to save video score' });
  }
});

// Get video score for a candidate (for current evaluator)
router.get('/video-score/:candidateId', requireAuth, async (req, res) => {
  try {
    const { candidateId } = req.params;
    let { cycleId } = req.query;
    const evaluatorId = req.user.id;

    // If no cycleId provided, get the active cycle
    if (!cycleId) {
      const activeCycle = await prisma.recruitingCycle.findFirst({
        where: { isActive: true }
      });
      if (activeCycle) {
        cycleId = activeCycle.id;
      }
    }

    const whereClause = { candidateId, evaluatorId };
    if (cycleId) {
      whereClause.cycleId = cycleId;
    }

    const videoScore = await prisma.videoScore.findFirst({
      where: whereClause
    });

    // Transform the response to match frontend expectations
    if (videoScore) {
      const transformedScore = {
        ...videoScore,
        notes: videoScore.notesOne // Map notesOne to notes for frontend compatibility
      };
      res.json(transformedScore);
    } else {
      res.json(null);
    }
  } catch (error) {
    console.error('Error fetching video score:', error);
    res.status(500).json({ error: 'Failed to fetch video score' });
  }
});

// Get all video scores for a candidate
router.get('/video-scores/:candidateId', requireAuth, requireAdminOrMember, async (req, res) => {
  try {
    const { candidateId } = req.params;
    const { cycleId } = req.query;

    const whereClause = { candidateId };
    if (cycleId) {
      whereClause.cycleId = cycleId;
    }

    const videoScores = await prisma.videoScore.findMany({
      where: whereClause,
      include: {
        evaluator: {
          select: {
            id: true,
            fullName: true,
            email: true, profileImage: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(videoScores);
  } catch (error) {
    console.error('Error fetching video scores:', error);
    res.status(500).json({ error: 'Failed to fetch video scores' });
  }
});

export default router;
