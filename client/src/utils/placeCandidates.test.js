import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { describePlacement, placeCandidates } from './placeCandidates';

vi.mock('./api', () => ({ default: { post: vi.fn() } }));

const dee = { id: 'app-d', firstName: 'Dee', lastName: 'Diaz' };
const eli = { id: 'app-e', firstName: 'Eli', lastName: 'Evans' };
const slot = { id: 'slot-1', interviewId: 'iv-1', label: 'Morning Block' };

describe('placeCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps going past a failure and names who was seated without an email', async () => {
    // SUPPRESSED is the case that looks fine from the server's side: the row
    // was written, but SCHEDULING_EMAILS is off, so nothing reaches them.
    apiClient.post
      .mockResolvedValueOnce({ placed: true, confirmation: 'SUPPRESSED' })
      .mockRejectedValueOnce(new Error('That candidate has already booked a session in this round'));

    const result = await placeCandidates({ applications: [dee, eli], slot });

    expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/iv-1/slot-signups', {
      slotId: 'slot-1',
      applicationId: 'app-d',
      force: false,
    });
    expect(describePlacement(result, slot)).toEqual({
      ok: 'Added 1 to Morning Block.',
      bad:
        'Could not add Eli Evans (That candidate has already booked a session in this round). ' +
        'Added, but no confirmation email is going to Dee Diaz. Tell them their time directly.',
    });
  });

  it('reports nothing wrong when every email was queued', async () => {
    apiClient.post.mockResolvedValue({ placed: true, confirmation: 'QUEUED' });
    const result = await placeCandidates({ applications: [dee, eli], slot });
    expect(describePlacement(result, slot)).toEqual({ ok: 'Added 2 to Morning Block.', bad: '' });
  });
});
