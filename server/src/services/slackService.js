import fetch from 'node-fetch';
import { recordCommunication } from './communicationLog.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// The webhook URL is a credential, so the log names the destination generically.
// One workspace channel is all this server can post to.
const SLACK_DESTINATION = 'Slack (webhook)';

/**
 * Post to the configured Slack webhook, and record it.
 *
 * Like email, this is the only way a Slack message leaves the server, so it is
 * where the audit row is written. `meta` is optional and shaped exactly like
 * sendEmail's - unlabelled posts still land in the log as automated OTHER.
 */
export const sendSlackMessage = async (message, meta = {}) => {
  const text = typeof message === 'string' ? message : message?.text ?? null;

  if (!SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not configured. Message not sent to Slack.');
    return;
  }

  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
    }

    console.log('Message sent to Slack successfully');
    await recordCommunication({
      channel: 'slack',
      recipient: SLACK_DESTINATION,
      bodyPreview: text,
      status: 'SENT',
      ...meta,
    });
  } catch (error) {
    console.error('Failed to send message to Slack:', error);
    await recordCommunication({
      channel: 'slack',
      recipient: SLACK_DESTINATION,
      bodyPreview: text,
      status: 'FAILED',
      error: error.message,
      ...meta,
    });
    throw error;
  }
};
