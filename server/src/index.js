import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import config from './config.js';
import prisma from './prismaClient.js';
import syncFormResponses from './services/syncResponses.js';
import applicationsRoutes from './routes/applications.js';
import filesRoutes from './routes/files.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import reviewTeamsRoutes from './routes/reviewTeams.js';
import usersRoutes from './routes/users.js';
import publicRoutes from './routes/public.js';
import interviewResourcesRoutes from './routes/interviewResources.js';
import memberRoutes from './routes/member.js';
import candidateRoutes from './routes/candidate.js';
import casesRoutes from './routes/cases.js';
import resumeUploadsRoutes from './routes/resumeUploads.js';
import applicantInfoRoutes from './routes/applicantInfo.js';
import conversationsRoutes from './routes/conversations.js';
import execAccessRoutes from './routes/execAccess.js';
import liveVoteRoutes from './routes/liveVotes.js';
import reviewDelibRoutes from './routes/reviewDelibs.js';
import decisionGuideRoutes from './routes/decisionGuides.js';
import documentRubricRoutes from './routes/documentRubrics.js';
import masterCommunicationsRoutes from './routes/masterCommunications.js';
import { processScheduledMessages } from './services/masterCommunications.js';
import { sendDueHostReminders } from './services/meetingHostReminders.js';
import { sendDueAttendanceReminders } from './services/meetingAttendanceReminders.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import externalContainment from './middleware/externalContainment.js';
import clientRoutes from './routes/client.js';
import talentRoutes from './routes/talent.js';
import candidateOnboardingRoutes from './routes/candidateOnboarding.js';
import candidateInterviewSignupRoutes from './routes/candidateInterviewSignups.js';
import interviewSlotsAdminRoutes from './routes/interviewSlotsAdmin.js';
import interviewSlotsMemberRoutes from './routes/interviewSlotsMember.js';
import talentPoolAdminRoutes from './routes/talentPoolAdmin.js';
import featureRequestRoutes from './routes/featureRequests.js';
import releaseNotesRoutes from './routes/releaseNotes.js';
import memberHelpRoutes from './routes/memberHelp.js';
import adminHelpRoutes from './routes/adminHelp.js';
import emailTemplateRoutes from './routes/emailTemplates.js';
import emailHealthRoutes from './routes/emailHealth.js';
import candidateCommunicationsRoutes from './routes/candidateCommunications.js';
import sesWebhookRoutes from './routes/sesWebhooks.js';
import unsubscribeRoutes from './routes/unsubscribe.js';
import lumaIntegrationRoutes from './routes/lumaIntegration.js';
import lumaAdminRoutes from './routes/lumaAdmin.js';
import analyticsAdminRoutes from './routes/analyticsAdmin.js';
import analyticsIngestRoutes from './routes/analyticsIngest.js';
import { requestMetrics } from './services/analytics/requestMetrics.js';
import { installErrorCapture, expressErrorHandler } from './services/analytics/errorCapture.js';
import { startAnalyticsJobs } from './services/analytics/rollup.js';
import { flushAll, sleep } from './services/analytics/buffer.js';

// Record every console.error and crash as a server error for Site Analytics.
// Here rather than at import time so tests, which import services directly,
// never get the wrapper. See services/analytics/errorCapture.js.
installErrorCapture();

const app = express();

// Render (and any single-hop proxy) sits in front of this service. Without
// this, req.ip is the proxy's address and every access-log row records it
// instead of the caller.
app.set('trust proxy', 1);

// Single-service deploys (Render staging) build the SPA into client/dist and
// serve it from here. Locally that directory doesn't exist — the Vite dev
// server serves the client and proxies /api — so this stays switched off.
const clientDistPath = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist');
const serveClient = fs.existsSync(clientDistPath);

app.use(helmet({
  // Helmet's default CSP falls back to `default-src 'self'` for connect-src and
  // img-src, which would block Supabase's realtime websocket and remotely
  // hosted document/headshot images. That only bites when this service is the
  // origin for the HTML too, so the policy is relaxed just for that case —
  // API-only deploys keep the stricter default.
  contentSecurityPolicy: serveClient ? false : undefined,
}));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (config.corsOrigin.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Serve static files for profile images
app.use('/api/uploads', express.static('uploads', {
  setHeaders: (res, path) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Talent Partner Network clients reach only /api/client/*. Mounted ahead of
// every route so a route file that forgets its own role gate is still covered.
// Transparent to every other role and to unauthenticated requests.
app.use(externalContainment);

// Times every request and records denied or suspicious ones. After
// externalContainment, which has already resolved req.user from the token.
app.use(requestMetrics);

// Routes
app.use('/api/auth', authRoutes);
// Public: browsers post page views, clicks and errors here, signed in or not.
app.use('/api/analytics/events', analyticsIngestRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/admin/release-notes', requireAuth, requireAdmin, releaseNotesRoutes);
// Ahead of the catch-all /api/admin mount, same as release-notes above.
app.use('/api/admin/talent-pool', requireAuth, requireAdmin, talentPoolAdminRoutes);
app.use('/api/admin/help', requireAuth, requireAdmin, adminHelpRoutes);
app.use('/api/admin/email-templates', requireAuth, requireAdmin, emailTemplateRoutes);
app.use('/api/admin/email-health', requireAuth, requireAdmin, emailHealthRoutes);
app.use('/api/admin/candidate-communications', requireAuth, requireAdmin, candidateCommunicationsRoutes);
app.use('/api/admin/luma', requireAuth, requireAdmin, lumaAdminRoutes);
app.use('/api/admin/analytics', requireAuth, requireAdmin, analyticsAdminRoutes);
// Before the catch-all admin router so its slot routes are matched first.
app.use('/api/admin', requireAuth, requireAdmin, interviewSlotsAdminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/review-teams', reviewTeamsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/interview-resources', interviewResourcesRoutes);
// Before the catch-all member router so its slot routes are matched first.
app.use('/api/member', requireAuth, interviewSlotsMemberRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/member/help', requireAuth, memberHelpRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/talent', talentRoutes);
app.use('/api/candidate/onboarding', candidateOnboardingRoutes);
app.use('/api/my-interview-signups', candidateInterviewSignupRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/exec-access', execAccessRoutes);
app.use('/api/live-votes', liveVoteRoutes);
app.use('/api/review-delibs', reviewDelibRoutes);
app.use('/api/decision-guides', decisionGuideRoutes);
app.use('/api/document-rubrics', documentRubricRoutes);
app.use('/api/master-communications', masterCommunicationsRoutes);
app.use('/api/webhooks/ses', sesWebhookRoutes);
// Public, token-gated: the Master Communications footer link and one-click header.
app.use('/api/unsubscribe', unsubscribeRoutes);
// The hourly Luma sync routine. Carries its own bearer token rather than a JWT;
// no user session ever reaches it.
app.use('/api/integrations/luma', lumaIntegrationRoutes);
app.use('/api/feature-requests', featureRequestRoutes);
app.use('/api/cases', casesRoutes);
app.use('/api/resume-uploads', resumeUploadsRoutes);
app.use('/api/applicant-info', applicantInfoRoutes);
app.use('/api', candidateRoutes);
app.use('/api', publicRoutes);

// Health check endpoint to test database connection
app.get('/api/health', async (req, res) => {
  try {
    // Test database connection with timeout
    const healthCheckPromise = prisma.$queryRaw`SELECT 1`;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Health check timeout')), 5000);
    });
    
    await Promise.race([healthCheckPromise, timeoutPromise]);
    
    res.json({ 
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ 
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Serve the built client. Registered after every /api route so it can never
// shadow one, and skipped entirely in local development.
if (serveClient) {
  app.use(express.static(clientDistPath));

  // SPA fallback so deep links (/admin/candidates, password reset links, ...)
  // resolve to index.html and let React Router take over. The negative lookahead
  // keeps unmatched /api paths returning a real 404 instead of HTML. Express 5
  // no longer accepts '*' as a path string, hence the RegExp.
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });

  console.log(`Serving client bundle from ${clientDistPath}`);
}

// Last: anything a route throws without catching, plus body-parser and CORS
// failures, answers JSON instead of Express's HTML page, and a 5xx is recorded.
app.use(expressErrorHandler);

// Scheduled jobs run on one kind of server only; see `runCrons` in config.js.
if (config.runCrons) {
  // Run initial sync on startup
  await syncFormResponses();

  // Schedule automatic sync every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    console.log('Running scheduled response sync...');
    syncFormResponses();
  });

  // Check for and send scheduled messages every minute
  cron.schedule('* * * * *', async () => {
    const count = await processScheduledMessages();
    if (count > 0) {
      console.log(`Processed ${count} scheduled master communication(s)`);
    }
  });

  // Remind Get to Know UC hosts of a slot about 24 hours ahead. A slow run is
  // skipped over rather than overlapped, so one slot cannot be reminded twice.
  let hostRemindersRunning = false;
  cron.schedule('*/15 * * * *', async () => {
    if (hostRemindersRunning) return;
    hostRemindersRunning = true;
    try {
      const sent = await sendDueHostReminders();
      if (sent > 0) console.log(`Sent ${sent} GTKUC host reminder(s)`);
    } catch (error) {
      console.error('[gtkuc host reminders] run failed:', error);
    } finally {
      hostRemindersRunning = false;
    }
  });

  // An hour after a Get to Know UC slot ends, ask its host to mark attendance.
  let attendanceRemindersRunning = false;
  cron.schedule('*/15 * * * *', async () => {
    if (attendanceRemindersRunning) return;
    attendanceRemindersRunning = true;
    try {
      const sent = await sendDueAttendanceReminders();
      if (sent > 0) console.log(`Sent ${sent} GTKUC attendance reminder(s)`);
    } catch (error) {
      console.error('[gtkuc attendance reminders] run failed:', error);
    } finally {
      attendanceRemindersRunning = false;
    }
  });

  // Site analytics: roll up yesterday and prune raw rows, 02:15 Los Angeles.
  startAnalyticsJobs(cron);
} else {
  console.log(`Scheduled jobs are off here (CLIENT_URL ${config.clientUrl}). Set RUN_CRONS=true to run them.`);
}

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});

// Render sends SIGTERM on every deploy. Give buffered analytics rows a moment
// to reach the database, then close, and never hang the deploy on it.
process.once('SIGTERM', () => {
  Promise.race([flushAll(), sleep(2000)]).finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
});
