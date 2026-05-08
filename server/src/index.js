import express from 'express';
import cors from 'cors';
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
import conversationsRoutes from './routes/conversations.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';

const app = express();

app.use(cors());
app.use(express.json());

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
app.use('/api/admin', adminRoutes);
app.use('/api/review-teams', reviewTeamsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/interview-resources', interviewResourcesRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/conversations', conversationsRoutes);
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

// Run initial sync on startup
await syncFormResponses();

// Schedule automatic sync every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Running scheduled response sync...');
  syncFormResponses();
});

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
