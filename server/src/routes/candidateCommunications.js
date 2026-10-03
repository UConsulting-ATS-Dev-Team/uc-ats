import express from 'express';
import {
  listCandidateCommunications,
  summarizeCandidateCommunications,
} from '../services/candidateCommunications.js';

// What the communications log holds for a candidate, for the Candidates list
// and Candidate Detail. Mounted behind requireAuth and requireAdmin in
// index.js, like the log itself.

const router = express.Router();

// POST /api/admin/candidate-communications/summary { candidateIds }
//
// A POST because a page of ids does not fit comfortably in a query string.
router.post('/summary', async (req, res) => {
  try {
    res.json(await summarizeCandidateCommunications(req.body?.candidateIds));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('[POST /api/admin/candidate-communications/summary]', error);
    res.status(500).json({ error: 'Failed to load communications' });
  }
});

// GET /api/admin/candidate-communications/:candidateId?limit=&offset=
router.get('/:candidateId', async (req, res) => {
  try {
    const result = await listCandidateCommunications(req.params.candidateId, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    if (!result) return res.status(404).json({ error: 'Candidate not found' });
    res.json(result);
  } catch (error) {
    console.error('[GET /api/admin/candidate-communications/:candidateId]', error);
    res.status(500).json({ error: 'Failed to load communications' });
  }
});

export default router;
