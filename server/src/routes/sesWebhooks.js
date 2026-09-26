import express from 'express';
import { verifySnsMessage, applySesEvent, isSnsUrl } from '../services/sesEvents.js';

// POST /api/webhooks/ses - where SNS delivers SES delivery, bounce and complaint
// events. There is no bearer token: SNS cannot send one. What authenticates a
// request is its SNS signature plus the topic it names, which must be ours.
//
// Status codes matter to SNS: anything but 2xx is retried with backoff, so a
// database hiccup answers 500 and the event comes back, while a forged or
// foreign message answers 403 and is never worth retrying.

const router = express.Router();

// SNS posts JSON with Content-Type text/plain, which the app-wide express.json
// leaves alone. Accept it as text here; a body express.json already parsed is
// used as-is.
router.use(express.text({ type: '*/*', limit: '256kb' }));

function parseBody(body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

router.post('/', async (req, res) => {
  const topicArn = process.env.SES_SNS_TOPIC_ARN;
  if (!topicArn) {
    // Unconfigured means we cannot tell our topic from anyone else's, so
    // nothing is accepted rather than everything.
    return res.status(503).json({ error: 'SES event webhook is not configured' });
  }

  const message = parseBody(req.body);
  if (!message) return res.status(400).json({ error: 'Body is not JSON' });

  if (message.TopicArn !== topicArn || !(await verifySnsMessage(message))) {
    return res.status(403).json({ error: 'Not a valid SNS message for this topic' });
  }

  if (message.Type === 'SubscriptionConfirmation') {
    // Visiting SubscribeURL is how SNS asks "do you want these?". The signature
    // already proves SNS sent it; the host check keeps a bug elsewhere from
    // ever turning this into a fetch-anything endpoint.
    if (!isSnsUrl(message.SubscribeURL)) return res.status(403).json({ error: 'Unexpected SubscribeURL' });
    const confirm = await fetch(message.SubscribeURL).catch((error) => ({ ok: false, error }));
    if (!confirm.ok) {
      console.error('[sesWebhooks] subscription confirmation failed:', confirm.error?.message || confirm.status);
      return res.status(502).json({ error: 'Could not confirm subscription' });
    }
    console.log('[sesWebhooks] confirmed SNS subscription to', topicArn);
    return res.status(200).json({ confirmed: true });
  }

  if (message.Type !== 'Notification') {
    // UnsubscribeConfirmation: someone removed the subscription in AWS. Nothing
    // to do but acknowledge it.
    return res.status(200).json({ ignored: message.Type });
  }

  let event;
  try {
    event = JSON.parse(message.Message);
  } catch {
    // A notification on our topic that is not an SES event (a test publish from
    // the console, say). Retrying will not make it one.
    return res.status(200).json({ ignored: 'not an SES event' });
  }

  try {
    const updated = await applySesEvent(event);
    return res.status(200).json({ updated });
  } catch (error) {
    console.error('[sesWebhooks] failed to apply SES event:', error);
    return res.status(500).json({ error: 'Failed to record event' });
  }
});

export default router;
