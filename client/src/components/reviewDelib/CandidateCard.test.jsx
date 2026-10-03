import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CandidateCard from './CandidateCard';

// The document viewer fetches; this is about the card around it.
vi.mock('./DocumentPanel', () => ({ default: () => null }));

const emptyDoc = { has: false, max: 13, categories: [], avg: null, rows: [] };
const card = (overrides = {}) => ({
  applicationId: 'app1',
  name: 'Casey Candidate',
  major: 'Econ',
  year: '2027',
  gpa: '3.80',
  headshotUrl: null,
  resumeDecision: null,
  total: 9,
  outlierCount: 0,
  splitDocs: 0,
  docs: { resume: emptyDoc, coverLetter: emptyDoc, video: emptyDoc },
  attendance: {
    attended: [
      { id: 'e1', name: 'Info Sesh', startDate: '2026-09-20T18:00:00.000Z' },
      { id: 'meeting-s1', name: 'Get to Know UC', startDate: '2026-09-22T17:00:00.000Z', isMeeting: true }
    ],
    attendedCount: 1,
    eventCount: 3
  },
  referrals: [
    { id: 'r1', source: 'MANUAL', referrerName: 'Pat Alum', relationship: 'Classmate', reason: null },
    { id: 'r2', source: 'PRE_APPLICATION', referrerName: 'Mia Member', relationship: 'Roommate', reason: 'Sharp and kind' }
  ],
  ...overrides
});

const renderCard = (value) => render(
  <CandidateCard card={value} canEdit={false} pending={new Set()} onOverride={vi.fn()} onDecide={vi.fn()} />
);

describe('CandidateCard: overall', () => {
  it("leads with Staging's overall out of its max, beside the documents total", () => {
    renderCard(card({ participation: 2, overall: 11, overallMax: 21 }));
    expect(screen.getByText('Overall 11 / 21')).toBeInTheDocument();
    expect(screen.getByText('Documents total 9')).toBeInTheDocument();
  });

  it('drops the denominator it was not sent, and the chip on a card from before', () => {
    const { unmount } = renderCard(card({ participation: 0, overall: 9 }));
    expect(screen.getByText('Overall 9')).toBeInTheDocument();
    unmount();
    renderCard(card());
    expect(screen.queryByText(/^Overall/)).not.toBeInTheDocument();
    expect(screen.getByText('Documents total 9')).toBeInTheDocument();
  });
});

describe('CandidateCard: rank', () => {
  it("shows Staging's rank beside the overall, worded as Staging words it", async () => {
    renderCard(card({ overall: 11, overallMax: 21, rank: 7, rankedCount: 240 }));
    const chip = screen.getByText('Rank 7 of 240');
    await userEvent.hover(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('7th of 240 scored');
  });

  it('says Unranked only for a card with nothing scored, and nothing on a card from before ranks', () => {
    const { unmount } = renderCard(card({ overall: 0, rank: null, rankedCount: 240 }));
    expect(screen.getByText('Unranked')).toBeInTheDocument();
    unmount();
    renderCard(card({ overall: 9 }));
    expect(screen.queryByText(/^Rank|Unranked/)).not.toBeInTheDocument();
  });
});

describe('CandidateCard: events and referrals', () => {
  it('lists the events they came to and who referred them, with why', () => {
    renderCard(card());

    const events = screen.getByRole('region', { name: 'Events attended' });
    expect(within(events).getByText('1 of 3')).toBeInTheDocument();
    expect(within(events).getByText('Info Sesh')).toBeInTheDocument();
    expect(within(events).getByText('Get to Know UC')).toBeInTheDocument();

    const referrals = screen.getByRole('region', { name: 'Referrals' });
    expect(within(referrals).getByText('Pat Alum')).toBeInTheDocument();
    expect(within(referrals).getByText('· Classmate')).toBeInTheDocument();
    expect(within(referrals).getByText('· Roommate · Sharp and kind')).toBeInTheDocument();
    // Names and reasons are data, not UI copy.
    expect(within(referrals).getByText('Mia Member').closest('[data-no-track]')).not.toBeNull();
  });

  it('says so when there is nothing to show', () => {
    renderCard(card({ attendance: { attended: [], attendedCount: 0, eventCount: 3 }, referrals: [] }));
    expect(screen.getByText('No events attended')).toBeInTheDocument();
    expect(screen.getByText('No referrals')).toBeInTheDocument();
  });

  it('still renders a card from before these fields existed', () => {
    const older = card();
    delete older.attendance;
    delete older.referrals;
    renderCard(older);
    expect(screen.getByText('Casey Candidate')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Events attended' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Referrals' })).not.toBeInTheDocument();
  });
});
