import express from 'express';
import { requireAuth, requireAdmin, requireAdminOrMember } from '../middleware/auth.js';
import { getRubrics, previewRubric, resetRubric, saveRubric } from '../services/documentRubrics.js';

// The document grading rubrics. Rules live in services/documentRubrics.js;
// this file only maps HTTP onto them.
//
// Members read them - they grade against them - and only admins write.

const router = express.Router();

router.use(requireAuth, requireAdminOrMember);

const rubricRoute = (label, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    if (!error.status) {
      console.error(`[${label}]`, error);
      return res.status(500).json({ error: 'Document rubric request failed' });
    }
    res.status(error.status).json({ error: error.message, code: error.code });
  }
};

router.get('/', rubricRoute('GET /api/document-rubrics',
  () => getRubrics()));

// Validates a draft and counts this cycle's scores it would leave out of range. Writes nothing.
router.post('/:type/preview', requireAdmin, rubricRoute('POST /api/document-rubrics/:type/preview',
  (req) => previewRubric({ type: req.params.type, rubric: req.body?.rubric })));

router.put('/:type', requireAdmin, rubricRoute('PUT /api/document-rubrics/:type',
  (req) => saveRubric({ type: req.params.type, rubric: req.body?.rubric, user: req.user })));

router.delete('/:type', requireAdmin, rubricRoute('DELETE /api/document-rubrics/:type',
  (req) => resetRubric({ type: req.params.type })));

export default router;
