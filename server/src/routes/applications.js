import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import { getFormQuestions, getResponses } from '../services/google/forms.js';
import config from '../config.js';

const router = express.Router();

// Test Google Form API connection
router.get('/test-google-api', async (req, res) => {
  try {
    console.log('Testing Google Form API connection...');
    
    // Test 1: Check if config is loaded
    if (!config.form || !config.form.id) {
      return res.status(500).json({ 
        error: 'Form configuration not found',
        config: {
          formConfigPath: process.env.FORM_CONFIG_PATH,
          formId: config.form?.id
        }
      });
    }

    const formId = config.form.id;
    console.log('Form ID:', formId);

    // Test 2: Test authentication first
    console.log('Testing Google authentication...');
    const { getGoogleAuthClient } = await import('../services/google/auth.js');
    const authClient = await getGoogleAuthClient();
    
    // Get service account info
    const credentials = await authClient.getCredentials();
    console.log('Service account email:', credentials.client_email);
    
    // Test 3: Try to get form questions with detailed error handling
    console.log('Testing form questions retrieval...');
    try {
      const questions = await getFormQuestions(formId);
      console.log('Questions retrieved:', questions.length);
    } catch (questionError) {
      console.error('Form questions error:', questionError);
      return res.status(500).json({
        error: 'Failed to get form questions',
        details: {
          message: questionError.message,
          code: questionError.code,
          status: questionError.status,
          suggestion: 'The service account may not have access to this specific form. Try sharing the form with the service account email.'
        },
        serviceAccount: credentials.client_email,
        formId: formId
      });
    }

    // Test 4: Try to get form responses
    console.log('Testing form responses retrieval...');
    try {
      const responses = await getResponses(formId);
      console.log('Responses retrieved:', responses.length);
    } catch (responseError) {
      console.error('Form responses error:', responseError);
      return res.status(500).json({
        error: 'Failed to get form responses',
        details: {
          message: responseError.message,
          code: responseError.code,
          status: responseError.status,
          suggestion: 'The service account may not have access to form responses. Make sure the form is shared with Editor permissions.'
        },
        serviceAccount: credentials.client_email,
        formId: formId
      });
    }

    // If we get here, both tests passed
    const questions = await getFormQuestions(formId);
    const responses = await getResponses(formId);

    res.json({
      success: true,
      message: 'Google Form API connection successful',
      formId: formId,
      serviceAccount: credentials.client_email,
      questionsCount: questions.length,
      responsesCount: responses.length,
      sampleQuestions: questions.slice(0, 3), // First 3 questions
      sampleResponses: responses.slice(0, 2)  // First 2 responses
    });

  } catch (error) {
    console.error('Google Form API test failed:', error);
    
    // Provide detailed error information
    let errorDetails = {
      message: error.message,
      code: error.code,
      status: error.status
    };

    // Add specific error handling for common issues
    if (error.code === 'ENOENT') {
      errorDetails.suggestion = 'Check if google-cloud-key.json file exists in the server directory';
    } else if (error.message.includes('invalid_grant')) {
      errorDetails.suggestion = 'Service account key may be invalid or expired';
    } else if (error.message.includes('not found')) {
      errorDetails.suggestion = 'Form ID may be incorrect or form may not exist';
    } else if (error.message.includes('permission')) {
      errorDetails.suggestion = 'Service account may not have proper permissions for this form';
    }

    res.status(500).json({
      error: 'Google Form API connection failed',
      details: errorDetails,
      config: {
        formConfigPath: process.env.FORM_CONFIG_PATH,
        gCloudKeyPath: process.env.GOOGLE_CLOUD_KEY_PATH,
        formId: config.form?.id
      }
    });
  }
});

// All routes below require authentication
router.use(requireAuth);

// Create manual application
router.post('/manual', requireAdmin, async (req, res) => {
  try {
    
    const {
      firstName,
      lastName,
      email,
      studentId,
      phoneNumber,
      graduationYear,
      isTransferStudent,
      priorCollegeYears,
      cumulativeGpa,
      majorGpa,
      major1,
      major2,
      gender,
      isFirstGeneration,
      resumeUrl,
      headshotUrl,
      coverLetterUrl,
      videoUrl,
      responseID,
      rawResponses
    } = req.body;

    // Validate required fields
    const requiredFields = { firstName, lastName, email, studentId, phoneNumber, graduationYear, cumulativeGpa, major1, resumeUrl, headshotUrl };
    const missingFields = Object.entries(requiredFields)
      .filter(([key, value]) => {
        // Special handling for cumulativeGpa - 0 is a valid value
        if (key === 'cumulativeGpa') {
          return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
        }
        // For other fields, check if they're falsy or empty strings
        return !value || (typeof value === 'string' && value.trim() === '');
      })
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({ 
        error: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Get the active recruiting cycle
    const activeCycle = await prisma.recruitingCycle.findFirst({ 
      where: { isActive: true } 
    });

    if (!activeCycle) {
      return res.status(400).json({ 
        error: 'No active recruiting cycle found. Please create an active cycle first.' 
      });
    }

    // Check if candidate already exists
    let candidate = await prisma.candidate.findUnique({
      where: { studentId }
    });

    // Create candidate if doesn't exist
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: {
          studentId,
          firstName,
          lastName,
          email
        }
      });
    }

    // Create the application
    const applicationData = {
      status: 'SUBMITTED',
      responseID,
      email,
      firstName,
      lastName,
      studentId,
      phoneNumber,
      graduationYear,
      isTransferStudent: isTransferStudent || false,
      priorCollegeYears,
      cumulativeGpa: parseFloat(cumulativeGpa),
      major1,
      major2,
      gender,
      isFirstGeneration: isFirstGeneration || false,
      resumeUrl,
      headshotUrl,
      coverLetterUrl,
      videoUrl,
      rawResponses: rawResponses || {},
      cycleId: activeCycle.id,
      candidateId: candidate.id
    };

    // Handle majorGpa - set to 0.00 if empty, otherwise parse the value
    if (majorGpa && majorGpa !== '') {
      applicationData.majorGpa = parseFloat(majorGpa);
    } else {
      applicationData.majorGpa = 0.00;
    }

    const application = await prisma.application.create({
      data: applicationData
    });

    res.status(201).json(application);
  } catch (error) {
    console.error('Error creating manual application:', error);
    res.status(500).json({ 
      error: 'Failed to create application',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all applications with average grades
router.get('/', async (req, res) => {
  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;

    // Search and filter parameters
    const search = req.query.search?.trim() || '';
    const { year, gender, firstGen, transfer, status: statusFilter, returning, eventAttendanceEventId } = req.query;

    // Optional: scope to active recruiting cycle if one exists
    const activeCycle = await prisma.recruitingCycle.findFirst({ where: { isActive: true } });
    if (!activeCycle) {
      // When no active cycle, return empty list instead of all
      return res.json([]);
    }

    // Build where clause with filters
    const whereClause = { cycleId: activeCycle.id };

    // Add search filter (search by name or email)
    if (search) {
      // Split search into words for full name matching
      const searchWords = search.split(/\s+/).filter(word => word.length > 0);

      if (searchWords.length > 1) {
        // Multi-word search: match each word against first or last name
        whereClause.AND = searchWords.map(word => ({
          OR: [
            { firstName: { contains: word, mode: 'insensitive' } },
            { lastName: { contains: word, mode: 'insensitive' } }
          ]
        }));
      } else {
        // Single word search: match against first name, last name, or email
        whereClause.OR = [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } }
        ];
      }
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
        eventAttendance: { some: { eventId: eventAttendanceEventId } }
      };
    }

    // Returning is a computed value, so resolve it before count/pagination.
    // This keeps page sizes, totals, and page counts aligned with the filter.
    if (returning === 'true' || returning === 'false') {
      const matchingApplications = await prisma.application.findMany({
        where: whereClause,
        select: {
          id: true,
          candidateId: true,
          studentId: true
        }
      });

      const candidateIds = [...new Set(matchingApplications.map(app => app.candidateId).filter(Boolean))];
      const studentIds = [...new Set(matchingApplications.map(app => app.studentId).filter(Boolean))];

      const [pastAppCountsByCandidateId, pastAppCountsByStudentId] = await Promise.all([
        candidateIds.length > 0
          ? prisma.application.groupBy({
              by: ['candidateId'],
              where: {
                candidateId: { in: candidateIds },
                cycleId: { not: activeCycle.id }
              },
              _count: { id: true }
            })
          : [],
        studentIds.length > 0
          ? prisma.application.groupBy({
              by: ['studentId'],
              where: {
                studentId: { in: studentIds },
                cycleId: { not: activeCycle.id }
              },
              _count: { id: true }
            })
          : []
      ]);

      const pastAppCountMapByCandidateId = new Map(
        pastAppCountsByCandidateId.map(p => [p.candidateId, p._count.id])
      );
      const pastAppCountMapByStudentId = new Map(
        pastAppCountsByStudentId.map(p => [p.studentId, p._count.id])
      );

      const shouldReturnReturningApplicants = returning === 'true';
      const matchingApplicationIds = matchingApplications
        .filter(application => {
          let pastApplicationCount = 0;
          if (application.candidateId && pastAppCountMapByCandidateId.has(application.candidateId)) {
            pastApplicationCount = pastAppCountMapByCandidateId.get(application.candidateId);
          } else if (application.studentId && pastAppCountMapByStudentId.has(application.studentId)) {
            pastApplicationCount = pastAppCountMapByStudentId.get(application.studentId);
          }

          return shouldReturnReturningApplicants
            ? pastApplicationCount > 0
            : pastApplicationCount === 0;
        })
        .map(application => application.id);

      whereClause.id = { in: matchingApplicationIds };
    }

    // Get total count and paginated applications in parallel
    const [total, applications] = await Promise.all([
      prisma.application.count({ where: whereClause }),
      prisma.application.findMany({
        where: whereClause,
        orderBy: { submittedAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    // Get grades only for the applications on this page
    const applicationIds = applications.map(app => app.id);
    const allGrades = await prisma.grade.findMany({
      where: { applicant: { in: applicationIds } }
    });

    // Get counts of past applications by candidateId (primary) and studentId (fallback)
    const candidateIds = [...new Set(applications.map(app => app.candidateId).filter(Boolean))];
    const studentIds = [...new Set(applications.map(app => app.studentId).filter(Boolean))];

    // Count by candidateId first (this is the proper relation)
    const pastAppCountsByCandidateId = await prisma.application.groupBy({
      by: ['candidateId'],
      where: {
        candidateId: { in: candidateIds },
        cycleId: { not: activeCycle.id }
      },
      _count: { id: true }
    });
    const pastAppCountMapByCandidateId = new Map(pastAppCountsByCandidateId.map(p => [p.candidateId, p._count.id]));

    // Also count by studentId as fallback for applications without candidateId
    const pastAppCountsByStudentId = await prisma.application.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: studentIds },
        cycleId: { not: activeCycle.id }
      },
      _count: { id: true }
    });
    const pastAppCountMapByStudentId = new Map(pastAppCountsByStudentId.map(p => [p.studentId, p._count.id]));

    // Calculate average grades for each application
    const applicationsWithAverages = await Promise.all(applications.map(async (application) => {
      // Find grades for this application
      const appGrades = allGrades.filter(grade => grade.applicant === application.id);

      // Filter out null grades and convert string grades to numbers
      const resumeGrades = appGrades
        .filter(g => g.resume !== null && g.resume !== undefined)
        .map(g => parseFloat(g.resume));

      const videoGrades = appGrades
        .filter(g => g.video !== null && g.video !== undefined)
        .map(g => parseFloat(g.video));

      const coverLetterGrades = appGrades
        .filter(g => g.cover_letter !== null && g.cover_letter !== undefined)
        .map(g => parseFloat(g.cover_letter));

      // Calculate averages
      const avgResume = resumeGrades.length > 0 ?
        (resumeGrades.reduce((a, b) => a + b, 0) / resumeGrades.length).toFixed(1) : null;

      const avgVideo = videoGrades.length > 0 ?
        (videoGrades.reduce((a, b) => a + b, 0) / videoGrades.length).toFixed(1) : null;

      const avgCoverLetter = coverLetterGrades.length > 0 ?
        (coverLetterGrades.reduce((a, b) => a + b, 0) / coverLetterGrades.length).toFixed(1) : null;

      // Calculate overall average if at least one grade exists
      const allGradeValues = [...resumeGrades, ...videoGrades, ...coverLetterGrades];
      const overallAverage = allGradeValues.length > 0 ?
        (allGradeValues.reduce((a, b) => a + b, 0) / allGradeValues.length).toFixed(1) : null;

      // Get past application count - prefer candidateId (proper relation), fallback to studentId
      let pastApplicationCount = 0;
      if (application.candidateId && pastAppCountMapByCandidateId.has(application.candidateId)) {
        pastApplicationCount = pastAppCountMapByCandidateId.get(application.candidateId);
      } else if (application.studentId && pastAppCountMapByStudentId.has(application.studentId)) {
        pastApplicationCount = pastAppCountMapByStudentId.get(application.studentId);
      }

      // Return application with average grades and returning applicant info
      return {
        ...application,
        averageGrades: {
          resume: avgResume,
          video: avgVideo,
          cover_letter: avgCoverLetter,
          overall: overallAverage
        },
        pastApplicationCount,
        isReturningApplicant: pastApplicationCount > 0
      };
    }));

    // Return with pagination metadata
    const totalPages = Math.ceil(total / limit);
    res.json({
      data: applicationsWithAverages,
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
    console.error('Error fetching applications:', error);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Comments: list for an application
router.get('/:id/comments', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;
    const comments = await prisma.comment.findMany({
      where: { applicationId: id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, fullName: true } } }
    });
    res.json(comments);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Get latest grades for an application and user (for the old grading system compatibility)
router.get('/:id/grades/latest', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Get the application to find the candidate ID
    const application = await prisma.application.findUnique({
      where: { id },
      select: { candidateId: true }
    });

    if (!application || !application.candidateId) {
      return res.status(404).json({ error: 'Application not found or not linked to a candidate' });
    }

    // Get the latest resume score for this candidate and user
    const resumeScore = await prisma.resumeScore.findFirst({
      where: {
        candidateId: application.candidateId,
        evaluatorId: userId
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!resumeScore) {
      return res.status(404).json({ error: 'No grades found for this application and user' });
    }

    // Convert to the old format for compatibility
    // Resume is the average of all three scores (0-10), video and cover letter are separate 0-10 scores
    res.json({
      resume: ((resumeScore.scoreOne || 0) + (resumeScore.scoreTwo || 0) + (resumeScore.scoreThree || 0)) / 3, // Average of all three categories
      video: resumeScore.scoreTwo, // Using scoreTwo as video for compatibility
      cover_letter: resumeScore.scoreThree, // Using scoreThree as cover letter for compatibility
      createdAt: resumeScore.createdAt
    });
  } catch (error) {
    console.error('Error fetching latest grades:', error);
    res.status(500).json({ error: 'Failed to fetch latest grades' });
  }
});

// Get average grades for an application (for the old grading system compatibility)
router.get('/:id/grades/average', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the application to find the candidate ID
    const application = await prisma.application.findUnique({
      where: { id },
      select: { candidateId: true }
    });

    if (!application || !application.candidateId) {
      return res.status(404).json({ 
        error: 'Application not found or not linked to a candidate',
        averages: {
          resume: 0,
          video: 0,
          cover_letter: 0,
          total: 0,
          count: 0
        }
      });
    }

    // Get all resume scores for this candidate
    const resumeScores = await prisma.resumeScore.findMany({
      where: { candidateId: application.candidateId }
    });

    if (resumeScores.length === 0) {
      return res.status(404).json({ 
        error: 'No grades found for this application',
        averages: {
          resume: 0,
          video: 0,
          cover_letter: 0,
          total: 0,
          count: 0
        }
      });
    }

    // Calculate averages from resume scores
    const validScores = resumeScores.filter(score => score.overallScore !== null);
    
    // Resume is average of all three categories (0-10), video and cover letter are separate (0-10)
    const avgResume = validScores.length > 0 ? 
      (validScores.reduce((sum, score) => {
        const avgResume = (parseFloat(score.scoreOne || 0) + parseFloat(score.scoreTwo || 0) + parseFloat(score.scoreThree || 0)) / 3;
        return sum + avgResume;
      }, 0) / validScores.length).toFixed(1) : 0;
    
    const avgVideo = validScores.length > 0 ? 
      (validScores.reduce((sum, score) => sum + parseFloat(score.scoreTwo || 0), 0) / validScores.length).toFixed(1) : 0;
    
    const avgCoverLetter = validScores.length > 0 ? 
      (validScores.reduce((sum, score) => sum + parseFloat(score.scoreThree || 0), 0) / validScores.length).toFixed(1) : 0;
    
    const avgTotal = validScores.length > 0 ? 
      (validScores.reduce((sum, score) => sum + parseFloat(score.overallScore || 0), 0) / validScores.length).toFixed(1) : 0;

    res.json({
      resume: parseFloat(avgResume),
      video: parseFloat(avgVideo),
      cover_letter: parseFloat(avgCoverLetter),
      total: parseFloat(avgTotal),
      count: validScores.length
    });
  } catch (error) {
    console.error('Error fetching average grades:', error);
    res.status(500).json({ error: 'Failed to fetch average grades' });
  }
});

// Save grades for an application (for the old grading system compatibility)
router.post('/:id/grades', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { resume_grade, video_grade, cover_letter_grade } = req.body;

    // Get the application to find the candidate ID
    const application = await prisma.application.findUnique({
      where: { id },
      select: { candidateId: true }
    });

    if (!application || !application.candidateId) {
      return res.status(404).json({ error: 'Application not found or not linked to a candidate' });
    }

    // Check if a score already exists for this candidate and user
    const existingScore = await prisma.resumeScore.findFirst({
      where: {
        candidateId: application.candidateId,
        evaluatorId: userId
      }
    });

    // Calculate overall score
    const scores = [resume_grade, video_grade, cover_letter_grade].filter(score => score !== null && score !== undefined);
    const overallScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;

    let resumeScore;
    if (existingScore) {
      // Update existing score
      resumeScore = await prisma.resumeScore.update({
        where: { id: existingScore.id },
        data: {
          overallScore,
          scoreOne: resume_grade,
          scoreTwo: video_grade,
          scoreThree: cover_letter_grade,
          status: 'completed'
        }
      });
    } else {
      // Create new score
      resumeScore = await prisma.resumeScore.create({
        data: {
          candidateId: application.candidateId,
          evaluatorId: userId,
          overallScore,
          scoreOne: resume_grade,
          scoreTwo: video_grade,
          scoreThree: cover_letter_grade,
          status: 'completed'
        }
      });
    }

    res.json(resumeScore);
  } catch (error) {
    console.error('Error saving grades:', error);
    res.status(500).json({ error: 'Failed to save grades' });
  }
});

// Comments: add to an application
router.post('/:id/comments', requireAdminOrMember, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    const created = await prisma.comment.create({
      data: {
        applicationId: id,
        userId: req.user.id,
        content: content.trim(),
      }
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating comment:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// Get all applications for the current user (candidate)
router.get('/my-applications', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('Fetching applications for user:', userId);

    // First, get the user to find their studentId
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { studentId: true, email: true, fullName: true }
    });

    console.log('User found:', user);

    if (!user || !user.studentId) {
      console.log('No user or studentId found for user:', userId);
      return res.status(404).json({ 
        error: 'User not found or no studentId associated',
        details: {
          userId,
          hasUser: !!user,
          hasStudentId: user ? !!user.studentId : false
        }
      });
    }

    // Directly query applications table by studentId
    // Convert user.studentId to string since applications table stores it as string
    const applications = await prisma.application.findMany({
      where: { 
        studentId: user.studentId.toString()
      },
      include: {
        cycle: {
          select: {
            id: true,
            name: true,
            isActive: true,
            startDate: true,
            endDate: true
          }
        }
      },
      orderBy: { submittedAt: 'desc' }
    });

    console.log(`Found ${applications.length} applications for studentId: ${user.studentId}`);

    // If no applications found, let's check what studentIds exist in the applications table
    if (applications.length === 0) {
      const allStudentIds = await prisma.application.findMany({
        select: { studentId: true },
        distinct: ['studentId']
      });
      console.log('Available studentIds in applications table:', allStudentIds.map(app => app.studentId));
    }

    res.json(applications);
  } catch (error) {
    console.error('Error fetching user applications:', error);
    res.status(500).json({ 
      error: 'Failed to fetch user applications',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single application by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        comments: {
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, email: true, fullName: true } } }
        },
        candidate: {
          select: {
            id: true,
            studentId: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        cycle: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (req.user.role !== 'ADMIN' && req.user.role !== 'MEMBER') {
      const ownsByEmail = req.user.email && (
        application.email === req.user.email ||
        application.candidate?.email === req.user.email
      );
      const ownsByStudentId = req.user.studentId && (
        application.studentId === req.user.studentId ||
        application.candidate?.studentId === req.user.studentId
      );
      if (!ownsByEmail && !ownsByStudentId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Fetch past applications for this applicant (excluding current application)
    // Prefer candidateId (proper relation) with fallback to studentId
    let pastApplications = [];
    if (application.candidateId) {
      // Use candidateId - this is the proper relation
      pastApplications = await prisma.application.findMany({
        where: {
          candidateId: application.candidateId,
          id: { not: id }
        },
        include: {
          cycle: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: { submittedAt: 'desc' }
      });
    } else if (application.studentId) {
      // Fallback to studentId if no candidateId
      pastApplications = await prisma.application.findMany({
        where: {
          studentId: application.studentId,
          id: { not: id }
        },
        include: {
          cycle: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: { submittedAt: 'desc' }
      });
    }

    res.json({
      ...application,
      pastApplications
    });
  } catch (error) {
    console.error('Error fetching application:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch application', details: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

// Get current user's ID
router.get('/current-user/id', (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    res.json({ userId: req.user.id });
  } catch (error) {
    console.error('Error getting user ID:', error);
    res.status(500).json({ error: 'Failed to get user ID' });
  }
});

// Save or update grades for an application
router.post('/:id/grades', requireAuth, async (req, res) => {
  try {
    const { id: applicationId } = req.params;
    const userId = req.user.id;
    const { resume_grade, video_grade, cover_letter_grade } = req.body;

    // Check if at least one grade is provided
    if (resume_grade === undefined && video_grade === undefined && cover_letter_grade === undefined) {
      return res.status(400).json({ 
        error: 'At least one grade field is required' 
      });
    }
    
    // Prepare data for upsert
    const gradeData = {};
    
    // Validate and process each grade
    if (resume_grade !== undefined) {
      if (resume_grade !== null) {
        const value = parseInt(resume_grade);
        if (isNaN(value) || value < 1 || value > 10) {
          return res.status(400).json({ error: 'Resume grade must be between 1 and 10' });
        }
        gradeData.resume = value.toString();
      } else {
        gradeData.resume = null;
      }
    }
    
    if (video_grade !== undefined) {
      if (video_grade !== null) {
        const value = parseInt(video_grade);
        if (isNaN(value) || value < 1 || value > 10) {
          return res.status(400).json({ error: 'Video grade must be between 1 and 10' });
        }
        gradeData.video = value.toString();
      } else {
        gradeData.video = null;
      }
    }
    
    if (cover_letter_grade !== undefined) {
      if (cover_letter_grade !== null) {
        const value = parseInt(cover_letter_grade);
        if (isNaN(value) || value < 1 || value > 10) {
          return res.status(400).json({ error: 'Cover letter grade must be between 1 and 10' });
        }
        gradeData.cover_letter = value.toString();
      } else {
        gradeData.cover_letter = null;
      }
    }

    // Check if a grade already exists for this user and application
    const existingGrade = await prisma.grade.findFirst({
      where: {
        applicant: applicationId,
        user: userId
      }
    });

    let grade;
    if (existingGrade) {
      // Update existing grade
      grade = await prisma.grade.update({
        where: { id: existingGrade.id },
        data: gradeData,
      });
    } else {
      // Create new grade with the provided data
      grade = await prisma.grade.create({
        data: {
          ...gradeData,
          applicant: applicationId,
          user: userId,
        },
      });
    }
    // Get application and user details for the response
    const [applicationDetails, userDetails] = await Promise.all([
      prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true
        }
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          fullName: true,
          email: true
        }
      })
    ]);
    
    res.status(201).json({
      message: 'Grades saved successfully',
      grade: {
        id: grade.id,
        resume_grade: grade.resume,
        video_grade: grade.video,
        cover_letter_grade: grade.cover_letter,
        createdAt: grade.createdAt,
        application: applicationDetails,
        user: userDetails
      }
    });
    
  } catch (error) {
    console.error('Error saving grades:', {
      message: error.message,
      stack: error.stack,
      applicationId,
      userId,
      grades: req.body
    });
    
    // Return more detailed error information
    res.status(500).json({ 
      error: 'Failed to save grades',
      details: {
        message: error.message,
        ...(process.env.NODE_ENV === 'development' && {
          stack: error.stack,
          code: error.code,
          meta: error.meta
        })
      }
    });
  }
});

// Get most recent grades for an application and user
router.get('/:id/grades/latest', requireAuth, async (req, res) => {
  try {
    const { id: applicationId } = req.params;
    const userId = req.user.id;

    // Find the most recent grade for this application and user
    const latestGrade = await prisma.grade.findFirst({
      where: {
        applicant: applicationId,
        user: userId
      },
      orderBy: {
        createdAt: 'desc'
      },
      select: {
        resume: true,
        video: true,
        cover_letter: true,
        createdAt: true
      }
    });

    if (!latestGrade) {
      return res.status(404).json({ error: 'No grades found for this application and user' });
    }

    res.json(latestGrade);
  } catch (error) {
    console.error('Error fetching latest grades:', error);
    res.status(500).json({ 
      error: 'Failed to fetch latest grades',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get average grades for an application
router.get('/:id/grades/average', requireAuth, async (req, res) => {
  try {
    const { id: applicationId } = req.params;

    // Get all grades for this application
    const grades = await prisma.grade.findMany({
      where: {
        applicant: applicationId
      },
      select: {
        resume: true,
        video: true,
        cover_letter: true
      }
    });

    if (grades.length === 0) {
      return res.status(404).json({ 
        error: 'No grades found for this application',
        averages: {
          resume: 0,
          video: 0,
          cover_letter: 0,
          total: 0,
          count: 0
        }
      });
    }

    // Filter out null grades and convert string grades to numbers
    const resumeGrades = grades
      .filter(g => g.resume !== null && g.resume !== undefined)
      .map(g => parseFloat(g.resume));
      
    const videoGrades = grades
      .filter(g => g.video !== null && g.video !== undefined)
      .map(g => parseFloat(g.video));
      
    const coverLetterGrades = grades
      .filter(g => g.cover_letter !== null && g.cover_letter !== undefined)
      .map(g => parseFloat(g.cover_letter));
    
    // Calculate averages
    const avgResume = resumeGrades.length > 0 ? 
      (resumeGrades.reduce((a, b) => a + b, 0) / resumeGrades.length) : 0;
      
    const avgVideo = videoGrades.length > 0 ? 
      (videoGrades.reduce((a, b) => a + b, 0) / videoGrades.length) : 0;
      
    const avgCoverLetter = coverLetterGrades.length > 0 ? 
      (coverLetterGrades.reduce((a, b) => a + b, 0) / coverLetterGrades.length) : 0;
    
    // Calculate overall average if at least one grade exists
    const allGradeValues = [...resumeGrades, ...videoGrades, ...coverLetterGrades];
    let overallAverage = allGradeValues.length > 0 ? 
      (allGradeValues.reduce((a, b) => a + b, 0) / allGradeValues.length) : 0;

    // Get application for candidate ID and cycle dates
    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        candidateId: true,
        studentId: true,
        cycleId: true,
        cycle: {
          select: {
            startDate: true,
            endDate: true
          }
        }
      }
    });

    let eventPointsContribution = 0;
    
    if (application && application.candidateId) {
      // Calculate event points contribution (raw points, not scaled)
      // Only include events from the current cycle
      const eventAttendance = await prisma.eventAttendance.findMany({
        where: {
          candidateId: application.candidateId,
          event: {
            cycleId: application.cycleId
          }
        },
        include: { event: true }
      });

      const totalEventPoints = eventAttendance.reduce((sum, attendance) => {
        return sum + (attendance.event.points || 0);
      }, 0);

      eventPointsContribution = totalEventPoints;
      overallAverage += eventPointsContribution;

      // Add meeting attendance bonus (1 point for attending "Get to Know UC")
      // Only count meetings within the current cycle's date range
      // If the cycle has no start date, we cannot determine which meetings belong to this cycle,
      // so we don't count any GTKUC attendance to avoid crediting old meetings
      const cycleStartDate = application.cycle?.startDate ? new Date(application.cycle.startDate) : null;
      const cycleEndDate = application.cycle?.endDate ? new Date(application.cycle.endDate) : null;

      if (cycleStartDate) {
        const meetingAttendance = await prisma.meetingSignup.findFirst({
          where: {
            studentId: application.studentId,
            attended: true,
            slot: {
              startTime: {
                gte: cycleStartDate,
                ...(cycleEndDate && { lte: cycleEndDate })
              }
            }
          }
        });

        if (meetingAttendance) {
          overallAverage += 1;
        }
      }
    }

    const averages = {
      resume: parseFloat(avgResume.toFixed(2)),
      video: parseFloat(avgVideo.toFixed(2)),
      cover_letter: parseFloat(avgCoverLetter.toFixed(2)),
      total: parseFloat(overallAverage.toFixed(2)),
      count: grades.length,
      referralBonus: 0, // Referrals no longer contribute to overall score
      eventPointsContribution: parseFloat(eventPointsContribution.toFixed(2))
    };

    res.json(averages);
  } catch (error) {
    console.error('Error calculating average grades:', error);
    res.status(500).json({ 
      error: 'Failed to calculate average grades',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get latest application ID for a candidate
router.get('/candidate/:candidateId/latest', requireAuth, async (req, res) => {
  try {
    const { candidateId } = req.params;

    // Find the latest application for this candidate
    const latestApplication = await prisma.application.findFirst({
      where: { candidateId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true }
    });

    if (!latestApplication) {
      return res.status(404).json({ error: 'No application found for this candidate' });
    }

    res.json({ applicationId: latestApplication.id });
  } catch (error) {
    console.error('Error fetching latest application for candidate:', error);
    res.status(500).json({ 
      error: 'Failed to fetch latest application for candidate',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get events and attendance for a specific application's cycle
router.get('/:id/events', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the application with cycle information
    const application = await prisma.application.findUnique({
      where: { id },
      select: {
        cycleId: true,
        candidateId: true,
        studentId: true,
        candidate: {
          select: {
            studentId: true
          }
        },
        cycle: {
          select: {
            id: true,
            isActive: true,
            startDate: true,
            endDate: true
          }
        }
      }
    });

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (!application.cycleId) {
      return res.json({ events: [], totalPoints: 0 });
    }

    // Get all events for this cycle
    const events = await prisma.events.findMany({
      where: { cycleId: application.cycleId },
      orderBy: { eventStartDate: 'asc' },
      select: {
        id: true,
        eventName: true,
        eventStartDate: true,
        eventEndDate: true,
        eventLocation: true
      }
    });

    // Get RSVP and attendance status for the candidate
    const candidateId = application.candidateId;
    if (!candidateId) {
      return res.json({ events: [], totalPoints: 0 });
    }

    const eventsWithStatus = await Promise.all(
      events.map(async (event) => {
        // Check RSVP status
        const rsvp = await prisma.eventRsvp.findFirst({
          where: {
            eventId: event.id,
            candidateId: candidateId
          }
        });

        // Check attendance status
        const attendance = await prisma.eventAttendance.findFirst({
          where: {
            eventId: event.id,
            candidateId: candidateId
          }
        });

        return {
          ...event,
          rsvpStatus: rsvp ? 'RSVPed' : 'Not RSVPed',
          attendanceStatus: attendance ? 'Attended' : 'Not Attended',
          points: attendance ? 1 : 0
        };
      })
    );

    // Add "Get to Know UC" meeting attendance as a special event
    // Only count meetings within the current cycle's date range
    // If the cycle has no start date, we cannot determine which meetings belong to this cycle,
    // so we don't count any GTKUC attendance to avoid crediting old meetings
    const cycleStartDate = application.cycle?.startDate ? new Date(application.cycle.startDate) : null;
    const cycleEndDate = application.cycle?.endDate ? new Date(application.cycle.endDate) : null;

    if (cycleStartDate) {
      const meetingAttendance = await prisma.meetingSignup.findFirst({
        where: {
          studentId: application.candidate?.studentId || application.studentId,
          attended: true,
          slot: {
            startTime: {
              gte: cycleStartDate,
              ...(cycleEndDate && { lte: cycleEndDate })
            }
          }
        },
        include: {
          slot: {
            include: {
              member: {
                select: { fullName: true }
              }
            }
          }
        }
      });

      if (meetingAttendance) {
        eventsWithStatus.push({
          id: 'meeting-' + meetingAttendance.id,
          eventName: 'Get to Know UC',
          eventStartDate: meetingAttendance.slot.startTime,
          eventEndDate: meetingAttendance.slot.endTime,
          eventLocation: meetingAttendance.slot.location,
          rsvpStatus: 'RSVPed',
          attendanceStatus: 'Attended',
          points: 1,
          isMeeting: true,
          memberName: meetingAttendance.slot.member.fullName
        });
      }
    }

    const totalPoints = eventsWithStatus.reduce((sum, event) => sum + event.points, 0);

    res.json({
      events: eventsWithStatus,
      totalPoints
    });

  } catch (error) {
    console.error('Error fetching events for application:', error);
    res.status(500).json({ 
      error: 'Failed to fetch events for application',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Referral endpoints

// Get referral for an application
router.get('/:id/referral', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the application to find the candidate ID and cycle ID
    const application = await prisma.application.findUnique({
      where: { id },
      select: { candidateId: true, cycleId: true }
    });

    if (!application || !application.candidateId) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Get referral for this candidate in this cycle
    const referral = await prisma.referral.findFirst({
      where: {
        candidateId: application.candidateId,
        cycleId: application.cycleId
      }
    });

    res.json(referral);
  } catch (error) {
    console.error('Error fetching referral:', error);
    res.status(500).json({ error: 'Failed to fetch referral' });
  }
});

// Add referral for an application
router.post('/:id/referral', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { referrerName, relationship } = req.body;

    if (!referrerName || !relationship) {
      return res.status(400).json({ error: 'Referrer name and relationship are required' });
    }

    // Get the application to find the candidate ID and cycle ID
    const application = await prisma.application.findUnique({
      where: { id },
      select: { candidateId: true, cycleId: true }
    });

    if (!application || !application.candidateId) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Check if referral already exists for this candidate in this cycle
    const existingReferral = await prisma.referral.findFirst({
      where: {
        candidateId: application.candidateId,
        cycleId: application.cycleId
      }
    });

    if (existingReferral) {
      return res.status(400).json({ error: 'This application already has a referral' });
    }

    // Create the referral with cycle association
    const referral = await prisma.referral.create({
      data: {
        referrerName,
        relationship,
        candidateId: application.candidateId,
        cycleId: application.cycleId
      }
    });

    res.json(referral);
  } catch (error) {
    console.error('Error creating referral:', error);
    res.status(500).json({ error: 'Failed to create referral' });
  }
});

// Remove referral for an application
router.delete('/:id/referral', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the application to find the candidate ID and cycle ID
    const application = await prisma.application.findUnique({
      where: { id },
      select: { candidateId: true, cycleId: true }
    });

    if (!application || !application.candidateId) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Delete the referral for this candidate in this cycle only
    const deletedReferral = await prisma.referral.deleteMany({
      where: {
        candidateId: application.candidateId,
        cycleId: application.cycleId
      }
    });

    if (deletedReferral.count === 0) {
      return res.status(404).json({ error: 'No referral found for this application' });
    }

    res.json({ message: 'Referral removed successfully' });
  } catch (error) {
    console.error('Error removing referral:', error);
    res.status(500).json({ error: 'Failed to remove referral' });
  }
});

export default router; 
 
