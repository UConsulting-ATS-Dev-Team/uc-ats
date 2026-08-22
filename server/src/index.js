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
import { processFeedbackJobs, expireFeedbackResponses } from './services/feedbackScheduler.js';
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
import conversationsRoutes from './routes/conversations.js';
import feedbackRoutes from './routes/feedback.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import featureRequestRoutes from './routes/featureRequests.js';
import releaseNotesRoutes from './routes/releaseNotes.js';

const app = express();

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

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/admin/release-notes', requireAuth, requireAdmin, releaseNotesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/review-teams', reviewTeamsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/interview-resources', interviewResourcesRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/feature-requests', featureRequestRoutes);
app.use('/api/cases', casesRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api', candidateRoutes);
app.use('/api', publicRoutes);

// Test endpoint to check if uploads directory is accessible
app.get('/api/test-uploads', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const uploadsPath = path.join(process.cwd(), 'uploads', 'profile-images');
  
  try {
    const files = fs.readdirSync(uploadsPath);
    res.json({ 
      message: 'Uploads directory accessible',
      files: files,
      uploadsPath: uploadsPath
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Cannot access uploads directory',
      details: error.message,
      uploadsPath: uploadsPath
    });
  }
});

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

// Run initial sync on startup
await syncFormResponses();

// Schedule automatic sync every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Running scheduled response sync...');
  syncFormResponses();
});

// Process feedback request jobs every minute
const runFeedbackJobWorker = () => {
  console.log('Running feedback job worker...');
  processFeedbackJobs().catch((error) => {
    console.error('Feedback job worker failed:', error);
  });
};

runFeedbackJobWorker();
cron.schedule('* * * * *', runFeedbackJobWorker);

// Enforce feedback response retention daily.
const runFeedbackExpiry = () => {
  console.log('Running feedback response expiry...');
  expireFeedbackResponses().catch((error) => {
    console.error('Feedback response expiry failed:', error);
  });
};
runFeedbackExpiry();
cron.schedule('0 0 * * *', runFeedbackExpiry);

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
