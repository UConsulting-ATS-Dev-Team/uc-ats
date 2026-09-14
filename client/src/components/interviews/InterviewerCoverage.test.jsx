import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterviewerCoverage from './InterviewerCoverage';
import apiClient from '../../utils/api';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const rsvped = { id: 'u1', fullName: 'Ada Reyes', email: 'ada@test.local', role: 'MEMBER' };
const silent = { id: 'u2', fullName: 'Ben Ortiz', email: 'ben@test.local', role: 'MEMBER' };

const payload = {
  interview: {
    id: 'i1',
    title: 'First Round',
    interviewType: 'ROUND_ONE',
    startDate: '2026-10-06T16:00:00.000Z',
    endDate: '2026-10-06T19:00:00.000Z',
  },
  cadence: { minutes: 60, interviewersPerSession: 2 },
  coverage: [
    // 9-10 has a group sitting in it; 10-11 has nobody free.
    { startTime: '2026-10-06T16:00:00.000Z', endTime: '2026-10-06T17:00:00.000Z', availableInterviewers: 2, userIds: ['u1', 'u2'], possibleSessions: 1 },
    { startTime: '2026-10-06T18:00:00.000Z', endTime: '2026-10-06T19:00:00.000Z', availableInterviewers: 0, userIds: [], possibleSessions: 0 },
  ],
  interviewers: [
    {
      user: rsvped,
      windows: [{ id: 'w1', startTime: '2026-10-06T16:00:00.000Z', endTime: '2026-10-06T19:00:00.000Z', note: null }],
    },
  ],
  sessions: [
    {
      id: 's1',
      label: 'Group 1A',
      startTime: '2026-10-06T16:00:00.000Z',
      endTime: '2026-10-06T17:00:00.000Z',
      interviewerCapacity: 2,
      canCover: ['u1'],
      assigned: [rsvped],
    },
    {
      id: 's2',
      label: 'Group 1B',
      startTime: '2026-10-06T17:00:00.000Z',
      endTime: '2026-10-06T18:00:00.000Z',
      interviewerCapacity: 2,
      canCover: ['u1'],
      assigned: [],
    },
  ],
  placements: [
    { assignmentId: 'a1', slotId: 's1', user: rsvped, conflict: null },
  ],
  // Ben never answered, but is still on the roster.
  staff: [
    { ...rsvped, responded: true },
    { ...silent, responded: false },
  ],
};

/** The session card for a given heading - Ada appears under 1A as assigned and
 *  under 1B as a suggestion, so queries have to say which one they mean. */
const sessionCard = (label) =>
  within(screen.getByText(label).closest('.MuiPaper-root'));

describe('InterviewerCoverage hour grid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue(payload);
    apiClient.post.mockResolvedValue({});
  });

  it('names who is free in each hour rather than only counting them', async () => {
    render(<InterviewerCoverage interviewId="i1" />);

    // A headcount cannot be acted on - the point is to read an hour and place
    // the people in it.
    const hour = within((await screen.findByText('9:00 AM – 10:00 AM')).closest('.MuiPaper-root'));
    expect(hour.getByText('Ada Reyes')).toBeInTheDocument();
    expect(hour.getByText('Ben Ortiz')).toBeInTheDocument();
  });

  it('places a free member into a group sitting in that hour', async () => {
    render(<InterviewerCoverage interviewId="i1" />);

    const hour = within((await screen.findByText('9:00 AM – 10:00 AM')).closest('.MuiPaper-root'));
    // Ada is already in Group 1A this hour, so Ben is the one with a picker.
    await userEvent.click(hour.getAllByLabelText('Add to…')[0]);
    await userEvent.click(await screen.findByRole('option', { name: /Group 1A/ }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/slots/s1/interviewers', { userId: 'u2' })
    );
  });

  it('says so when an hour has nobody in it', async () => {
    render(<InterviewerCoverage interviewId="i1" />);

    const hour = within((await screen.findByText('11:00 AM – 12:00 PM')).closest('.MuiPaper-root'));
    expect(hour.getByText(/Nobody has said they can make this hour/)).toBeInTheDocument();
  });
});

describe('InterviewerCoverage placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue(payload);
    apiClient.post.mockResolvedValue({ moved: true, clash: null });
    apiClient.delete.mockResolvedValue({ removed: true });
  });

  it('offers someone who never sent availability', async () => {
    render(<InterviewerCoverage interviewId="i1" />);

    const pickers = await screen.findAllByPlaceholderText('Add anyone else…');
    await userEvent.click(pickers[0]);

    // Ben is selectable even though he is not in canCover. Scoped to the
    // dropdown - his name also appears in the hour grid above.
    const listbox = within(await screen.findByRole('listbox'));
    await userEvent.click(listbox.getByText('Ben Ortiz'));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/slots/s1/interviewers', { userId: 'u2' })
    );
  });

  it('moves an assigned interviewer to another session', async () => {
    render(<InterviewerCoverage interviewId="i1" />);

    // The assigned chip opens a menu rather than only offering removal.
    await screen.findByText('Group 1A');
    await userEvent.click(sessionCard('Group 1A').getByRole('button', { name: 'Ada Reyes' }));
    await userEvent.click(await screen.findByText('Move to Group 1B'));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/slot-assignments/a1/move', { slotId: 's2' })
    );
  });

  it('warns when a move double-books somebody', async () => {
    apiClient.post.mockResolvedValue({
      moved: true,
      clash: { id: 's9', label: 'Group 2C', startTime: '2026-10-06T17:00:00.000Z', endTime: '2026-10-06T18:00:00.000Z' },
    });
    render(<InterviewerCoverage interviewId="i1" />);

    await screen.findByText('Group 1A');
    await userEvent.click(sessionCard('Group 1A').getByRole('button', { name: 'Ada Reyes' }));
    await userEvent.click(await screen.findByText('Move to Group 1B'));

    expect(await screen.findByText(/also on Group 2C, which overlaps/)).toBeInTheDocument();
  });

  it('can take an interviewer off a session', async () => {
    render(<InterviewerCoverage interviewId="i1" />);

    await screen.findByText('Group 1A');
    await userEvent.click(sessionCard('Group 1A').getByRole('button', { name: 'Ada Reyes' }));
    await userEvent.click(await screen.findByText('Take off this session'));

    await waitFor(() =>
      expect(apiClient.delete).toHaveBeenCalledWith('/admin/interviews/slot-assignments/a1')
    );
  });
});
