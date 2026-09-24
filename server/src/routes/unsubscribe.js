import express from 'express';
import {
  suppressionStatus,
  readUnsubscribeToken,
  resubscribeEmail,
  suppressEmail,
} from '../services/emailSuppression.js';

// Public: the person following an unsubscribe link has no account, or is not
// signed in. The signed token in `t` is the whole of the auth - it proves the
// holder received Master Communications mail at that address, and it names no
// other.
//
// A GET never changes anything. Mail scanners and link previewers fetch every
// URL in a message, so the footer link opens a page with a button, and only the
// POSTs below act.

const router = express.Router();

const tokenFrom = (req) => req.query.t || req.body?.t;

function resolveEmail(req, res) {
  const email = readUnsubscribeToken(tokenFrom(req));
  if (!email) {
    res.status(400).json({ error: 'This unsubscribe link is not valid. Copy the whole link from the email and try again.' });
    return null;
  }
  return email;
}

router.get('/', async (req, res) => {
  const email = resolveEmail(req, res);
  if (!email) return;
  try {
    res.json({ email, ...(await suppressionStatus(email)) });
  } catch (err) {
    console.error('[GET /api/unsubscribe]', err);
    res.status(500).json({ error: 'Could not look that up' });
  }
});

router.post('/', async (req, res) => {
  const email = resolveEmail(req, res);
  if (!email) return;
  try {
    await suppressEmail({ email, reason: 'UNSUBSCRIBED', source: 'LINK' });
    res.json({ email, ...(await suppressionStatus(email)) });
  } catch (err) {
    console.error('[POST /api/unsubscribe]', err);
    res.status(500).json({ error: 'Could not unsubscribe you. Please try again.' });
  }
});

router.post('/resubscribe', async (req, res) => {
  const email = resolveEmail(req, res);
  if (!email) return;
  try {
    await resubscribeEmail(email);
    // Asked again rather than assumed: a bounce or admin block on the other
    // UCLA spelling of this inbox survives a resubscribe and still holds mail.
    res.json({ email, ...(await suppressionStatus(email)) });
  } catch (err) {
    console.error('[POST /api/unsubscribe/resubscribe]', err);
    res.status(500).json({ error: 'Could not resubscribe you. Please try again.' });
  }
});

// RFC 8058. The mailbox provider POSTs `List-Unsubscribe=One-Click` here when
// the person presses its own Unsubscribe button; the body carries nothing we
// need, so it is not parsed. The answer is empty on purpose - nobody reads it.
router.post('/one-click', async (req, res) => {
  const email = readUnsubscribeToken(req.query.t);
  if (!email) return res.status(400).end();
  try {
    await suppressEmail({ email, reason: 'UNSUBSCRIBED', source: 'ONE_CLICK' });
    res.status(200).end();
  } catch (err) {
    console.error('[POST /api/unsubscribe/one-click]', err);
    res.status(500).end();
  }
});

export default router;
