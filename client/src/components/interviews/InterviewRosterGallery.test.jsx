import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterviewRosterGallery from './InterviewRosterGallery';

const candidate = (id, first, last) => ({
  id,
  firstName: first,
  lastName: last,
  email: `${first}@test.local`,
  major1: 'Econ',
  graduationYear: '2027',
});

const signup = (id, status, cand, over = {}) => ({
  id,
  status,
  applicationId: cand.id,
  candidate: cand,
  signedUpAt: '2026-09-01T00:00:00Z',
  waitlistedAt: status === 'WAITLISTED' ? '2026-09-01T00:00:00Z' : null,
  heldSeatId: null,
  movedById: null,
  ...over,
});

const slot = (id, label, capacity, signups, over = {}) => ({
  id,
  label,
  startTime: '2026-10-06T16:00:00Z',
  endTime: '2026-10-06T18:00:00Z',
  location: 'Covel',
  candidateCapacity: capacity,
  confirmedCount: signups.filter((s) => s.status === 'CONFIRMED').length,
  isOverCapacity: false,
  signups,
  interviewers: [],
  ...over,
});

const coffeeChatRoster = (over = {}) => ({
  interview: { id: 'iv1', title: 'Coffee Chats', interviewType: 'COFFEE_CHAT', round: '2' },
  slots: [
    slot('morning', 'Morning Block', 2, [
      signup('s1', 'CONFIRMED', candidate('a1', 'Ada', 'Lovelace')),
      signup('s2', 'CONFIRMED', candidate('a2', 'Alan', 'Turing')),
    ]),
    slot('afternoon', 'Afternoon Block', 40, [
      signup('s3', 'CONFIRMED', candidate('a3', 'Grace', 'Hopper')),
    ]),
  ],
  unassigned: [],
  ...over,
});

describe('InterviewRosterGallery', () => {
  it('renders a column per session with a seat meter', async () => {
    render(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText('Morning Block')).toBeInTheDocument();
    expect(screen.getByText('Afternoon Block')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('1 / 40')).toBeInTheDocument();
  });

  it('renders both shapes from the same component', () => {
    // Two wide blocks of forty, or sixteen narrow sittings of four - the thing
    // being drawn is the same thing, so density is a prop and not a fork.
    const firstRound = {
      interview: { id: 'iv2', title: 'First Round', interviewType: 'ROUND_ONE', round: '3' },
      slots: Array.from({ length: 6 }, (_, i) =>
        slot(`t${i}`, null, 4, [signup(`s${i}`, 'CONFIRMED', candidate(`a${i}`, `Cand${i}`, 'X'))])
      ),
      unassigned: [],
    };
    const { rerender } = render(<InterviewRosterGallery roster={firstRound} onMove={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getAllByTestId(/^slot-/)).toHaveLength(6);

    rerender(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getAllByTestId(/^slot-/)).toHaveLength(2);
  });

  it('shows an unlabelled slot by its time range', () => {
    const roster = {
      interview: { id: 'iv2', title: 'First Round', interviewType: 'ROUND_ONE' },
      slots: [slot('t1', null, 4, [])],
      unassigned: [],
    };
    render(<InterviewRosterGallery roster={roster} onMove={vi.fn()} onRemove={vi.fn()} />);
    // 16:00-18:00 UTC is 9-11am Pacific, and Pacific is what candidates are told.
    expect(screen.getByText('9:00 AM - 11:00 AM')).toBeInTheDocument();
  });

  it('marks a waitlisted candidate as holding a seat elsewhere', () => {
    const roster = coffeeChatRoster();
    roster.slots[0].signups.push(
      signup('s4', 'WAITLISTED', candidate('a4', 'Katherine', 'Johnson'), { heldSeatId: 's3' })
    );
    render(<InterviewRosterGallery roster={roster} onMove={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText('Waitlist (1)')).toBeInTheDocument();
    expect(screen.getByText('Holding a seat elsewhere')).toBeInTheDocument();
  });

  it('raises the unscheduled overflow to the top of the page', () => {
    const roster = coffeeChatRoster();
    roster.slots[0].signups.push(signup('s5', 'NEEDS_PLACEMENT', candidate('a5', 'Mary', 'Jackson')));
    render(<InterviewRosterGallery roster={roster} onMove={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText(/1 candidate could not be scheduled/i)).toBeInTheDocument();
    expect(screen.getByText(/you can go over\s+capacity/i)).toBeInTheDocument();
  });

  it('lists people in the round who have not booked yet', () => {
    // The question the old page could not answer: who have we forgotten.
    // Named for what it is - candidates book themselves, so this is "not yet",
    // not "not assigned".
    const roster = coffeeChatRoster({ unassigned: [candidate('a9', 'Forgotten', 'Person')] });
    render(<InterviewRosterGallery roster={roster} onMove={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText("Haven't booked yet (1)")).toBeInTheDocument();
    expect(screen.getByText('Forgotten Person')).toBeInTheDocument();
  });

  it('moves a candidate through the menu without a drag', async () => {
    const onMove = vi.fn();
    render(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={onMove} onRemove={vi.fn()} />);

    await userEvent.click(screen.getByLabelText('Actions for Ada Lovelace'));
    await userEvent.click(screen.getByText('Move to Afternoon Block'));

    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      expect.objectContaining({ id: 'afternoon' }),
      { force: false }
    );
  });

  it('asks before overfilling a session, and forces only on confirmation', async () => {
    const onMove = vi.fn();
    render(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={onMove} onRemove={vi.fn()} />);

    // Afternoon -> Morning, and Morning is 2/2.
    await userEvent.click(screen.getByLabelText('Actions for Grace Hopper'));
    await userEvent.click(screen.getByText('Move to Morning Block'));

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByText('This session is full')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /move anyway/i }));
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's3' }),
      expect.objectContaining({ id: 'morning' }),
      { force: true }
    );
  });

  it('does not move anyone when the overfill prompt is dismissed', async () => {
    const onMove = vi.fn();
    render(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={onMove} onRemove={vi.fn()} />);

    await userEvent.click(screen.getByLabelText('Actions for Grace Hopper'));
    await userEvent.click(screen.getByText('Move to Morning Block'));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onMove).not.toHaveBeenCalled();
  });

  it('states over capacity every time the page is drawn, not just when it happened', () => {
    const roster = coffeeChatRoster();
    roster.slots[0].isOverCapacity = true;
    render(<InterviewRosterGallery roster={roster} onMove={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Over capacity')).toBeInTheDocument();
  });

  it('dims non-matching cards rather than removing them', async () => {
    // Filtering a gallery by hiding defeats the point of a gallery: you lose
    // which session the match is sitting in.
    render(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={vi.fn()} onRemove={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Find a candidate'), 'Ada');

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
    expect(screen.getByTestId('candidate-s2')).toHaveStyle({ opacity: '0.25' });
    expect(screen.getByTestId('candidate-s1')).toHaveStyle({ opacity: '1' });
  });

  it('prompts before removing someone from the interview', async () => {
    const onRemove = vi.fn();
    render(<InterviewRosterGallery roster={coffeeChatRoster()} onMove={vi.fn()} onRemove={onRemove} />);

    await userEvent.click(screen.getByLabelText('Actions for Ada Lovelace'));
    await userEvent.click(screen.getByText('Remove from interview'));

    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('says what to do when there are no sessions yet', () => {
    render(
      <InterviewRosterGallery
        roster={{ interview: { id: 'iv1', title: 'x' }, slots: [], unassigned: [] }}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it('renders an empty session without implying something is wrong', () => {
    const roster = { interview: { id: 'iv1', title: 'x' }, slots: [slot('empty', 'Evening', 4, [])], unassigned: [] };
    render(<InterviewRosterGallery roster={roster} onMove={vi.fn()} onRemove={vi.fn()} />);
    expect(within(screen.getByTestId('slot-empty')).getByText('Nobody yet')).toBeInTheDocument();
  });
});
