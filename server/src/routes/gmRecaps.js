import express from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { isExecUnlocked } from '../services/execAccess.js';
import { storeEmailImage } from '../services/emailImageStorage.js';
import {
  createRecap,
  deleteRecap,
  getRecap,
  kickRecapQueue,
  listRecaps,
  markRecapFailed,
  recapAudience,
  recapFields,
  renderRecapPreview,
  scheduleRecap,
  sendRecapTest,
  unscheduleRecap,
  updateRecap,
} from '../services/gmRecaps.js';

// Weekly general meeting recaps (services/gmRecaps.js). Mail to every member
// as the executive team is executive business, so every route needs a live
// executive unlock on top of the admin role, like managing the seal does.

const router = express.Router();

router.use(requireAuth, requireAdmin, (req, res, next) => {
  if (!isExecUnlocked(req)) {
    return res.status(403).json({ error: 'Enter the executive password first.', code: 'EXEC_UNLOCK_REQUIRED' });
  }
  next();
});

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype?.startsWith('image/')) return cb(null, true);
    cb(Object.assign(new Error('Only image files are allowed.'), { code: 'NOT_AN_IMAGE' }));
  },
});

// multer reports a rejected file through next(err), which would skip the
// route's try/catch; answer 400 with something the page can show.
const imageUpload = (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Images must be under 10MB.' });
    return res.status(400).json({ error: err.message || 'Upload failed.' });
  });
};

const route = (label, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    // Statuses the service chose carry a message written for the page.
    if (error.status && error.status !== 500) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error(`[${label}]`, error);
    res.status(500).json({ error: 'Something went wrong with the recap. Please try again.' });
  }
};

router.get('/', route('GET /api/exec-access/gm-recaps', () => listRecaps()));

router.get('/audience', route('GET /api/exec-access/gm-recaps/audience', () => recapAudience()));

router.post('/', route('POST /api/exec-access/gm-recaps', (req) => createRecap({ userId: req.user.id })));

// Renders unsaved edits too, so the preview follows typing without saving.
router.post('/preview', route('POST /api/exec-access/gm-recaps/preview', (req) =>
  renderRecapPreview({ recap: recapFields(req.body || {}), user: req.user })
));

router.post('/images', imageUpload, route('POST /api/exec-access/gm-recaps/images', async (req) => {
  if (!req.file) throw Object.assign(new Error('Choose an image to upload.'), { status: 400 });
  return { url: await storeEmailImage(req.file.buffer) };
}));

router.get('/:id', route('GET /api/exec-access/gm-recaps/:id', (req) => getRecap(req.params.id)));

router.patch('/:id', route('PATCH /api/exec-access/gm-recaps/:id', (req) =>
  updateRecap({ id: req.params.id, userId: req.user.id, input: req.body || {} })
));

router.delete('/:id', route('DELETE /api/exec-access/gm-recaps/:id', (req) => deleteRecap({ id: req.params.id })));

router.post('/:id/test', route('POST /api/exec-access/gm-recaps/:id/test', (req) =>
  sendRecapTest({ id: req.params.id, user: req.user })
));

// `scheduledAt` omitted means send now. Either way the request only queues it
// and answers; the send runs outside the request, so the proxy cannot cut it off.
router.post('/:id/schedule', route('POST /api/exec-access/gm-recaps/:id/schedule', async (req) => {
  const recap = await scheduleRecap({
    id: req.params.id,
    userId: req.user.id,
    scheduledAt: req.body?.scheduledAt || null,
  });
  if (new Date(recap.scheduledAt).getTime() <= Date.now()) kickRecapQueue();
  return recap;
}));

router.post('/:id/unschedule', route('POST /api/exec-access/gm-recaps/:id/unschedule', (req) =>
  unscheduleRecap({ id: req.params.id })
));

router.post('/:id/mark-failed', route('POST /api/exec-access/gm-recaps/:id/mark-failed', (req) =>
  markRecapFailed({ id: req.params.id })
));

export default router;
