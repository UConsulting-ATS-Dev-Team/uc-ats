// The SNS-facing webhook. No bearer token reaches it, so the signature and the
// topic are the whole of its authentication - and the status codes decide
// whether SNS retries.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { verifySnsMessage, applySesEvent } from '../services/sesEvents.js';
import routes from './sesWebhooks.js';

vi.mock('../services/sesEvents.js', async (importOriginal) => ({
  ...(await importOriginal()),
  verifySnsMessage: vi.fn(),
  applySesEvent: vi.fn(),
}));

const TOPIC = 'arn:aws:sns:us-west-1:1:ats';
const realFetch = globalThis.fetch;

let server;
let port;

// SNS sends JSON as text/plain; posting it the same way is the point.
const post = (body, contentType = 'text/plain; charset=UTF-8') =>
  realFetch(`http://localhost:${port}/api/webhooks/ses`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const notification = (event, overrides = {}) => ({
  Type: 'Notification',
  TopicArn: TOPIC,
  Message: JSON.stringify(event),
  ...overrides,
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks/ses', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SES_SNS_TOPIC_ARN = TOPIC;
  verifySnsMessage.mockResolvedValue(true);
  applySesEvent.mockResolvedValue(1);
});

afterEach(() => {
  delete process.env.SES_SNS_TOPIC_ARN;
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/ses', () => {
  it('applies a verified SES event from our topic', async () => {
    const event = { eventType: 'Bounce', mail: { messageId: 'ses-1' } };
    const res = await post(notification(event));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1 });
    expect(applySesEvent).toHaveBeenCalledWith(event);
  });

  it('also accepts the body as application/json', async () => {
    const res = await post(notification({ eventType: 'Delivery', mail: { messageId: 'x' } }), 'application/json');
    expect(res.status).toBe(200);
    expect(applySesEvent).toHaveBeenCalled();
  });

  it('refuses a message whose signature does not verify', async () => {
    verifySnsMessage.mockResolvedValue(false);
    const res = await post(notification({ eventType: 'Delivery' }));
    expect(res.status).toBe(403);
    expect(applySesEvent).not.toHaveBeenCalled();
  });

  it('refuses a validly signed message from another topic', async () => {
    const res = await post(notification({ eventType: 'Delivery' }, { TopicArn: 'arn:aws:sns:us-west-1:2:theirs' }));
    expect(res.status).toBe(403);
    expect(applySesEvent).not.toHaveBeenCalled();
  });

  it('refuses everything while no topic is configured', async () => {
    delete process.env.SES_SNS_TOPIC_ARN;
    const res = await post(notification({ eventType: 'Delivery' }));
    expect(res.status).toBe(503);
    expect(verifySnsMessage).not.toHaveBeenCalled();
  });

  it('answers 500 when the event cannot be recorded, so SNS retries it', async () => {
    applySesEvent.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(notification({ eventType: 'Delivery' }));
    expect(res.status).toBe(500);
  });

  it('acknowledges a notification that is not an SES event without retrying', async () => {
    const res = await post(notification(null, { Message: 'hello from the console' }));
    expect(res.status).toBe(200);
    expect(applySesEvent).not.toHaveBeenCalled();
  });

  it('confirms a subscription by visiting its SNS SubscribeURL', async () => {
    const subscribeUrl = 'https://sns.us-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=t';
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
      String(url).startsWith('https://sns.') ? Promise.resolve({ ok: true }) : realFetch(url, init)
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, SubscribeURL: subscribeUrl });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(subscribeUrl);
  });

  it('will not visit a SubscribeURL outside SNS', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await post({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, SubscribeURL: 'https://evil.example.com/' });
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalledWith('https://evil.example.com/');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
  });
});
