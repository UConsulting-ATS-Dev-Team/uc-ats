import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RoundSignupStatus, { buildSignupRows, formatReminded } from './RoundSignupStatus';

const candidate = (id, first, last) => ({
  id: `cand-${id}`,
  firstName: first,
  lastName: last,
  email: `${first.toLowerCase()}@test.local`,
  major1: 'Econ',
  graduationYear: '2027',
});

const signup = (id, status, applicationId, cand) => ({ id, status, applicationId, groupLabel: null, candidate: cand });

const slot = (id, label, signups, over = {}) => ({
  id,
  label,
  startTime: '2026-10-06T16:00:00Z',
  endTime: '2026-10-06T18:00:00Z',
  interviewTitle: 'Coffee Chats',
  isBookable: true,
  signups,
  ...over,
});

const ana = candidate('a', 'Ana', 'Alvarez');
const ben = candidate('b', 'Ben', 'Brooks');
const cara = candidate('c', 'Cara', 'Cho');

const round = (over = {}) => ({
  round: 'COFFEE_CHAT',
  label: 'Coffee Chats',
  slots: [
    slot('s1', 'Morning', [signup('x1', 'WAITLISTED', 'app-a', ana), signup('x2', 'CONFIRMED', 'app-b', ben)]),
    slot('s2', 'Afternoon', [signup('x3', 'CONFIRMED', 'app-a', ana), signup('x4', 'WAITLISTED', 'app-c', cara)]),
  ],
  unassigned: [
    { id: 'app-d', firstName: 'Dee', lastName: 'Diaz', email: 'dee@test.local', lastRemindedAt: '2026-10-01T00:00:00Z' },
    { id: 'app-e', firstName: 'Eli', lastName: 'Evans', email: 'eli@test.local', lastRemindedAt: null },
  ],
  stats: { eligible: 5, bookableSessions: 2, confirmed: 2, waitlisted: 2, needsPlacement: 0, unassigned: 2 },
  ...over,
});

describe('buildSignupRows', () => {
  it('collapses a confirmed seat and a waitlist entry into one booked row', () => {
    const rows = buildSignupRows(round());
    const anaRows = rows.filter((r) => r.applicationId === 'app-a');
    expect(anaRows).toHaveLength(1);
    expect(anaRows[0]).toMatchObject({ status: 'BOOKED', session: 'Afternoon', waitlistedFor: ['Morning'] });
  });

  it('keeps a waitlist-only signup as waitlisted, and adds unassigned people as not booked', () => {
    const rows = buildSignupRows(round());
    expect(rows.map((r) => [r.applicationId, r.status])).toEqual([
      ['app-a', 'BOOKED'],
      ['app-b', 'BOOKED'],
      ['app-c', 'WAITLISTED'],
      ['app-d', 'NOT_BOOKED'],
      ['app-e', 'NOT_BOOKED'],
    ]);
    expect(rows.find((r) => r.applicationId === 'app-d').lastRemindedAt).toBe('2026-10-01T00:00:00Z');
  });

  it('names the interview in the session when the round spans several', () => {
    const r = round({
      slots: [slot('s1', 'Morning', [signup('x2', 'CONFIRMED', 'app-b', ben)], { interviewTitle: 'R1 Day 1' }),
        slot('s2', 'Morning', [], { interviewTitle: 'R1 Day 2' })],
      unassigned: [],
    });
    expect(buildSignupRows(r)[0].session).toBe('R1 Day 1 · Morning');
  });

  it('falls back to the time range for an unlabelled session', () => {
    const r = round({ slots: [slot('s1', null, [signup('x2', 'CONFIRMED', 'app-b', ben)])], unassigned: [] });
    expect(buildSignupRows(r)[0].session).toMatch(/9:00 AM - 11:00 AM/);
  });

  it('handles an empty round', () => {
    expect(buildSignupRows({ slots: [], unassigned: [] })).toEqual([]);
    expect(buildSignupRows(null)).toEqual([]);
  });
});

describe('formatReminded', () => {
  const now = new Date('2026-10-03T12:00:00Z').getTime();
  it('is a dash when never reminded', () => expect(formatReminded(null, now)).toBe('—'));
  it('is relative when recent', () => expect(formatReminded('2026-10-03T09:00:00Z', now)).toBe('3h ago'));
});

describe('RoundSignupStatus', () => {
  const defaults = { subject: 'Book your time', message: 'Hi {{firstName}}', mergeFields: ['firstName'] };

  it('opens on the not-booked filter and sends only the selected ids', async () => {
    const onRemind = vi.fn().mockResolvedValue({ sent: 1, failed: [], skipped: 0 });
    render(<RoundSignupStatus round={round()} reminderDefaults={defaults} busy={false} onRemind={onRemind} />);

    expect(screen.getByTestId('signup-summary')).toHaveTextContent('5 in this round · 2 booked · 1 waitlisted · 2 not booked');
    expect(screen.queryByText('Ana Alvarez')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('signup-row-app-e')).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Remind selected \(1\)/ }));
    expect(screen.getByLabelText('Subject')).toHaveValue('Book your time');
    await userEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    expect(onRemind).toHaveBeenCalledWith(['app-e'], 'Book your time', 'Hi {{firstName}}');
  });

  it('keeps the dialog open with the server message when the send is refused', async () => {
    const err = Object.assign(new Error('x (Status: 409)'), { serverMessage: 'No session is open for signup' });
    const onRemind = vi.fn().mockRejectedValue(err);
    render(<RoundSignupStatus round={round()} reminderDefaults={defaults} busy={false} onRemind={onRemind} />);
    await userEvent.click(screen.getByRole('button', { name: /Remind all not booked \(2\)/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Send 2' }));
    expect(onRemind).toHaveBeenCalledWith(null, 'Book your time', 'Hi {{firstName}}');
    expect(await screen.findByText('No session is open for signup')).toBeInTheDocument();
  });

  it('lists need placing in the summary only when there is someone to count', () => {
    const r = round({
      slots: [slot('s1', 'Morning', [signup('x5', 'NEEDS_PLACEMENT', 'app-f', ben)])],
      unassigned: [],
    });
    render(<RoundSignupStatus round={r} reminderDefaults={defaults} busy={false} onRemind={vi.fn()} />);
    expect(screen.getByTestId('signup-summary')).toHaveTextContent('1 in this round · 0 booked · 1 need placing · 0 not booked');
  });

  it('disables reminding when no session is open', () => {
    const r = round({ stats: { ...round().stats, bookableSessions: 0 } });
    render(<RoundSignupStatus round={r} reminderDefaults={defaults} busy={false} onRemind={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Remind all not booked/ })).toBeDisabled();
  });

  it('shows an empty state when nobody is in the round', () => {
    render(
      <RoundSignupStatus round={round({ slots: [], unassigned: [] })} reminderDefaults={defaults} busy={false} onRemind={vi.fn()} />
    );
    expect(screen.getByText('Nobody is in this round yet')).toBeInTheDocument();
  });
});
