import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { requireAuth } from '../middleware/auth.js';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

const CONTACT_EMAIL = 'uconsultingla@gmail.com';
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10000;
const MAX_CATEGORY = 120;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const EXT_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const uploadDir = path.join(__dirname, '../../uploads/feature-request-screenshots');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const ext =
      EXT_FOR_MIME[file.mimetype] ||
      path.extname(file.originalname || '').toLowerCase() ||
      '.img';
    cb(null, `feature-${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Screenshot must be PNG, JPEG, GIF, or WebP'));
    }
  },
});

function roleLabel(role) {
  if (role === 'USER') return 'Applicant';
  if (role === 'MEMBER') return 'Member';
  if (role === 'ADMIN') return 'Admin';
  return role ?? 'Unknown';
}

function buildIssueBody(user, { description, category, screenshotUrl, appPath }) {
  const cat = category?.trim() || '_None provided_';
  const shotBlock = screenshotUrl?.trim()
    ? `![Feature request screenshot](${screenshotUrl})\n\n${screenshotUrl}`
    : '_None provided_';
  const pathLine = appPath?.trim() || '_Unknown_';

  return [
    '## Submitter',
    `- **Name:** ${user.fullName ?? '_—_'}`,
    `- **Email:** ${user.email ?? '_—_'}`,
    `- **Role:** ${roleLabel(user.role)}`,
    '',
    '## Description',
    description.trim(),
    '',
    '## Category',
    cat,
    '',
    '## Screenshot',
    shotBlock,
    '',
    '## Context',
    `- **App path:** ${pathLine}`,
    `- **Submitted at (server):** ${new Date().toISOString()}`,
  ].join('\n');
}

function uploadScreenshotMiddleware(req, res, next) {
  upload.single('screenshot')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Screenshot must be 5MB or smaller' });
      }
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message || 'Invalid file upload' });
  });
}

router.post('/', requireAuth, uploadScreenshotMiddleware, async (req, res) => {
  const { title, description, category, appPath } = req.body ?? {};
  const savedPath = req.file?.path;
  const screenshotPublicUrl = savedPath
    ? `${config.baseUrl.replace(/\/$/, '')}/api/uploads/feature-request-screenshots/${req.file.filename}`
    : undefined;

  if (!title?.trim() || !description?.trim()) {
    if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
    return res.status(400).json({ error: 'Title and description are required' });
  }

  if (title.trim().length > MAX_TITLE) {
    if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
    return res.status(400).json({ error: `Title must be at most ${MAX_TITLE} characters` });
  }

  if (description.trim().length > MAX_DESCRIPTION) {
    if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
    return res.status(400).json({ error: `Description must be at most ${MAX_DESCRIPTION} characters` });
  }

  if (category != null && String(category).length > MAX_CATEGORY) {
    if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
    return res.status(400).json({ error: `Category must be at most ${MAX_CATEGORY} characters` });
  }

  const token = config.githubFeatureRequestToken;
  const repo = config.githubFeatureRequestRepo;

  if (!token) {
    console.error('GITHUB_FEATURE_REQUEST_TOKEN is not set');
    if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
    return res.status(503).json({
      error: 'Feature requests are temporarily unavailable.',
      contactEmail: CONTACT_EMAIL,
    });
  }

  const body = buildIssueBody(req.user, {
    description,
    category,
    screenshotUrl: screenshotPublicUrl,
    appPath,
  });

  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: title.trim(),
        body,
        labels: ['feature-request'],
      }),
    });

    if (!ghRes.ok) {
      const errText = await ghRes.text();
      console.error('GitHub API error:', ghRes.status, errText);
      if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
      return res.status(502).json({
        error: 'We could not submit your request automatically.',
        contactEmail: CONTACT_EMAIL,
      });
    }

    const data = await ghRes.json();
    return res.json({
      success: true,
      issueUrl: data.html_url,
      issueNumber: data.number,
    });
  } catch (err) {
    console.error('Feature request GitHub request failed:', err);
    if (savedPath) await fsPromises.unlink(savedPath).catch(() => {});
    return res.status(502).json({
      error: 'We could not submit your request automatically.',
      contactEmail: CONTACT_EMAIL,
    });
  }
});

export default router;
