// The panel is read by someone about to write questions for a candidate's next
// round, so the three states that matter are: what they were asked (both lists,
// with the notes attributed), nothing on record, and sealed. The last two must
// look different from each other - "no round one" and "you may not see round
// one" lead to opposite decisions about whether to go looking elsewhere.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RoundOneHistoryPanel from './RoundOneHistoryPanel';
import apiClient from '../../utils/api';

const history = {
  applicationId: 'app-1',
  interviews: [
    {
      interviewId: 'int-r1',
      title: 'Round One',
      interviewType: 'ROUND_ONE',
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: null,
      questions: [
        { id: 'q1', text: 'Tell me about a conflict.', order: 0, scope: 'SHARED' },
        { id: 'q2', text: 'Why this industry?', order: 0, scope: 'CANDIDATE' }
      ],
      evaluators: [
        {
          evaluationId: 'e1',
          evaluatorId: 'u1',
          evaluatorName: 'Dana',
          decision: 'YES',
          notesByQuestionId: { q1: 'Named the conflict, owned their part.' },
          marketSizingNotes: null,
          additionalNotes: 'Strong close.',
          submittedAt: '2026-03-02T00:00:00.000Z'
        }
      ]
    }
  ]
};

const sealedError = () =>
  Object.assign(new Error('This record is sealed. (Status: 423)'), {
    status: 423,
    code: 'RECORD_LOCKED'
  });

const panel = () => <RoundOneHistoryPanel applicationId="app-1" candidateName="Jordan Reyes" />;

const expand = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /round one history/i }));
};

beforeEach(() => {
  vi.restoreAllMocks();
  apiClient.token = 'test-token';
});

describe('round one history panel', () => {
  it('shows the shared questions and the candidate-specific ones, with notes attributed', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(history);

    render(panel());
    await expand();

    expect(await screen.findByText('Tell me about a conflict.')).toBeInTheDocument();
    expect(screen.getByText('Why this industry?')).toBeInTheDocument();
    // The candidate-specific one is marked; the shared one is not.
    expect(screen.getByText(/candidate-specific/i)).toBeInTheDocument();
    // Attributed twice over: once on the question she noted, once on her
    // closing remarks below.
    expect(screen.getAllByText('Dana')).toHaveLength(2);
    expect(screen.getByText('Named the conflict, owned their part.')).toBeInTheDocument();
    expect(screen.getByText(/Strong close\./)).toBeInTheDocument();
  });

  it('says the notes are the interviewers’, not a transcript of the candidate', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(history);

    render(panel());
    await expand();

    expect(await screen.findByText(/not a transcript of what the candidate said/i)).toBeInTheDocument();
  });

  it('summarises the volume before it is opened, so it can be skipped', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(history);

    render(panel());

    expect(await screen.findByText('2 questions · 1 evaluator')).toBeInTheDocument();
    // Nothing is rendered until asked for.
    expect(screen.queryByText('Tell me about a conflict.')).not.toBeInTheDocument();
  });

  it('says plainly when there is no round one on record', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ applicationId: 'app-1', interviews: [] });

    render(panel());
    await expand();

    expect(
      await screen.findByText(/no round one interview is on record/i)
    ).toBeInTheDocument();
  });

  it('shows the sealed placeholder for a sealed candidate, not an empty panel', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(sealedError());

    render(panel());
    await expand();

    expect(await screen.findByText('Round One is sealed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enter executive password/i })).toBeInTheDocument();
    // Must not read as "this candidate had no round one".
    expect(screen.queryByText(/no round one interview is on record/i)).not.toBeInTheDocument();
  });

  it('reports a real failure as a failure rather than as an empty round one', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500, serverMessage: 'Failed to fetch round one history' })
    );

    render(panel());
    await expand();

    expect(await screen.findByText('Failed to fetch round one history')).toBeInTheDocument();
    expect(screen.queryByText(/no round one interview is on record/i)).not.toBeInTheDocument();
  });

  it('does not fetch anything when there is no application', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(history);

    render(<RoundOneHistoryPanel applicationId={null} candidateName="Jordan Reyes" />);

    await waitFor(() => expect(get).not.toHaveBeenCalled());
  });
});
