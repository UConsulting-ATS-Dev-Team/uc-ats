import express from 'express';
import { getReleaseNotes } from '../services/releaseNotes.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const notes = getReleaseNotes();
    res.json(notes);
  } catch (error) {
    console.error('[GET /api/admin/release-notes] Error loading release notes:', error);
    res.status(500).json({ error: 'Failed to load release notes' });
  }
});

export default router;
