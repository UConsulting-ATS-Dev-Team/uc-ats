import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SessionBuilder from './SessionBuilder';
import apiClient from '../../utils/api';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const ada = { id: 'u1', fullName: 'Ada Reyes', email: 'ada@test.local', role: 'MEMBER' };
const ben = { id: 'u2', fullName: 'Ben Ortiz', email: 'ben@test.local', role: 'MEMBER' };
const cleo = { id: 'u3', fullName: 'Cleo Park', email: 'cleo@test.local', role: 'MEMBER' };

// 2026-10-06 is in daylight time, so 9:00 Pacific is 16:00Z.
const availability = {
  interview: {
    id: 'i1',
    title: 'First Round',
    interviewType: 'ROUND_ONE',
    startDate: '2026-10-06T16:00:00.000Z',
    endDate: '2026-10-07T00:00:00.000Z',
    location: 'Bunche 2156',
  },
  interviewers: [
    // Ada is free all morning; Ben only in the afternoon.
    { user: ada, windows: [{ id: 'w1', startTime: '2026-10-06T16:00:00.000Z', endTime: '2026-10-06T19:00:00.000Z', note: null }] },
    { user: ben, windows: [{ id: 'w2', startTime: '2026-10-06T21:00:00.000Z', endTime: '2026-10-06T23:00:00.000Z', note: null }] },
  ],
  staff: [
    { ...cleo, responded: false },
    { ...ben, responded: true },
    { ...ada, responded: true },
  ],
  sessions: [],
};

const open = (props = {}) => {
  const handlers = { onClose: vi.fn(), onCreated: vi.fn() };
  render(
    <SessionBuilder
      open
      interviewId="i1"
      interviewType="ROUND_ONE"
      defaultDay="2026-10-06"
      {...handlers}
      {...props}
    />
  );
  return handlers;
};

/** MUI date/time inputs ignore userEvent.type; set the value directly. */
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const row = (index) => within(screen.getByTestId(`draft-row-${index}`));
const rowCount = () => screen.queryAllByTestId(/^draft-row-/).length;
const loaded = () => waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/interviews/i1/availability'));

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockResolvedValue(availability);
  apiClient.post.mockResolvedValue({ created: 1, assigned: 1, slots: [] });
});

describe('SessionBuilder', () => {
  it('shows the rows it was opened with, people included', async () => {
    open({
      initialRows: [
        { day: '2026-10-06', start: '09:00', end: '10:00', interviewerIds: ['u1'] },
        { day: '2026-10-06', start: '09:00', end: '10:00', location: 'YRL 2' },
      ],
    });

    expect(await row(0).findByText('Ada Reyes')).toBeInTheDocument();
    expect(rowCount()).toBe(2);
    expect(row(0).getByLabelText('Start')).toHaveValue('09:00');
    // The interview's own location fills a row the caller left blank.
    expect(row(0).getByLabelText('Location')).toHaveValue('Bunche 2156');
    expect(row(1).getByLabelText('Location')).toHaveValue('YRL 2');
    expect(screen.getByText(/2 sessions · 8 seats · 1 interviewer placement$/)).toBeInTheDocument();
  });

  it('adds the next session where the last one ends, copies one, and removes one', async () => {
    open();
    await loaded();
    expect(rowCount()).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Add session' }));
    expect(rowCount()).toBe(2);
    expect(row(1).getByLabelText('Start')).toHaveValue('10:00');
    expect(row(1).getByLabelText('End')).toHaveValue('11:00');

    await userEvent.click(screen.getByRole('button', { name: 'Duplicate session 1' }));
    expect(rowCount()).toBe(3);
    // The copy lands right under its original, at the same time.
    expect(row(1).getByLabelText('Start')).toHaveValue('09:00');

    await userEvent.click(screen.getByRole('button', { name: 'Remove session 3' }));
    expect(rowCount()).toBe(2);
    expect(screen.getByRole('button', { name: 'Create 2 sessions' })).toBeEnabled();
  });

  it('fills a range in place of the untouched opening row', async () => {
    open();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Fill a time range' }));
    setValue(screen.getByLabelText('First starts'), '13:00');
    setValue(screen.getByLabelText('Last ends'), '15:30');
    // 13:00-15:30 at an hour each is two sessions; the half hour left over is dropped.
    await userEvent.click(await screen.findByRole('button', { name: 'Add 2 sessions' }));

    expect(rowCount()).toBe(2);
    expect(row(0).getByLabelText('Start')).toHaveValue('13:00');
    expect(row(1).getByLabelText('Start')).toHaveValue('14:00');
  });

  it('previews how many sessions a fill adds', async () => {
    open();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Fill a time range' }));
    setValue(screen.getByLabelText('First starts'), '08:00');
    setValue(screen.getByLabelText('Last ends'), '22:00');
    // 14 hours of 20-minute sessions in 3 rooms: 42 times, 126 sessions.
    await userEvent.click(screen.getByLabelText('Each runs'));
    await userEvent.click(await screen.findByRole('option', { name: '20 minutes' }));
    await userEvent.click(screen.getByLabelText('Rooms at once'));
    await userEvent.click(await screen.findByRole('option', { name: '3' }));

    // Said before the click, and in red, since adding them would pass the cap.
    expect(screen.getByText('Adds 126 sessions (42 times × 3 rooms)')).toBeInTheDocument();
  });

  it('will not create more than 100 sessions in one go', async () => {
    const initialRows = Array.from({ length: 101 }, () => ({ day: '2026-10-06', start: '09:00', end: '10:00' }));
    open({ initialRows });
    await loaded();

    // Text queries, not getByRole: computing roles over a hundred rows of
    // inputs takes jsdom well over a minute.
    expect(screen.getByText(/At most 100 sessions at once/)).toBeInTheDocument();
    expect(screen.getByText('Create 101 sessions').closest('button')).toBeDisabled();
    expect(apiClient.post).not.toHaveBeenCalled();
  }, 20000);

  it('offers people free at that time first, without leaving anyone out', async () => {
    open();
    await loaded();
    await userEvent.click(row(0).getByLabelText('Interviewers'));

    const text = (await screen.findByRole('listbox')).textContent ?? '';
    // A 9:00 row: Ada said 9-12, Ben said afternoons, Cleo never answered.
    const order = ['Free at this time', 'Said they are busy then', 'Never sent availability'].map((g) => text.indexOf(g));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.indexOf('Ada Reyes')).toBeLessThan(text.indexOf('Ben Ortiz'));
    expect(text.indexOf('Ben Ortiz')).toBeLessThan(text.indexOf('Cleo Park'));
  });

  it('posts every session at once with Pacific times', async () => {
    const { onCreated, onClose } = open({
      initialRows: [{ day: '2026-10-06', start: '09:00', end: '10:00', location: 'YRL 1', interviewerIds: ['u1', 'u3'] }],
    });
    await row(0).findByText('Ada Reyes');
    // Cleo never sent availability: allowed, but drawn as a warning.
    expect(row(0).getByText('Cleo Park').closest('.MuiChip-root')).toHaveClass('MuiChip-colorWarning');
    expect(row(0).getByText('Ada Reyes').closest('.MuiChip-root')).not.toHaveClass('MuiChip-colorWarning');
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 session' }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/i1/slots/generate', {
        sessions: [
          {
            label: null,
            startTime: '2026-10-06T16:00:00.000Z',
            endTime: '2026-10-06T17:00:00.000Z',
            location: 'YRL 1',
            candidateCapacity: 4,
            groupSize: null,
            interviewerCapacity: 2,
            interviewerIds: ['u1', 'u3'],
          },
        ],
      })
    );
    expect(onCreated).toHaveBeenCalledWith({ created: 1, assigned: 1, slots: [] });
    expect(onClose).toHaveBeenCalled();
  });

  it('marks a backwards session and sends nothing', async () => {
    open({ initialRows: [{ day: '2026-10-06', start: '11:00', end: '10:00' }] });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 session' }));

    expect(await screen.findByText('Must end after it starts')).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('closes after creating even when the page cannot refresh, and says so', async () => {
    const onCreated = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const { onClose } = open({ onCreated });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 session' }));

    // The sessions exist; staying open would invite a second, duplicate create.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findByText(/Created 1 session, but the page could not refresh/)).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it('shows the server refusal and stays open', async () => {
    apiClient.post.mockRejectedValue(new Error('Session 1: that room is already booked'));
    const { onCreated, onClose } = open();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 session' }));

    expect(await screen.findByText('Session 1: that room is already booked')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
