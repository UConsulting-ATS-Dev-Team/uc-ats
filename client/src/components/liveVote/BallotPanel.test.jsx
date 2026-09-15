// What a voter sees. While voting is open the panel has nothing but progress
// to show - the server sends no split - and it must not invent one.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BallotPanel from './BallotPanel';

const openBallot = (overrides = {}) => ({
  id: 'b1', status: 'OPEN', roundNumber: 1, votedCount: 14, eligibleCount: 22,
  myVote: null, canVote: true, cannotVoteReason: null, ...overrides
});

const closedBallot = {
  id: 'b1', status: 'CLOSED', roundNumber: 2, yesCount: 18, noCount: 7, eligibleCount: 25,
  yesPct: 72, noPct: 28, decisionApplied: 'maybe_yes'
};

describe('BallotPanel while open', () => {
  it('shows progress and no counts', () => {
    render(<BallotPanel ballot={openBallot()} myVote={null} onVote={vi.fn()} />);
    expect(screen.getByText('14 of 22 have voted')).toBeInTheDocument();
    expect(screen.queryByText(/\d+%\)/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('result-bar-yes')).not.toBeInTheDocument();
  });

  it('votes and shows the choice as pressed', async () => {
    const onVote = vi.fn();
    const { rerender } = render(<BallotPanel ballot={openBallot()} myVote={null} onVote={onVote} />);
    await userEvent.click(screen.getByRole('button', { name: /yes/i }));
    expect(onVote).toHaveBeenCalledWith('YES');

    rerender(<BallotPanel ballot={openBallot()} myVote="YES" onVote={onVote} />);
    expect(screen.getByRole('button', { name: /yes/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/you can change it until voting closes/i)).toBeInTheDocument();
  });

  it('replaces the buttons for a candidate looking at their own application', () => {
    render(<BallotPanel ballot={openBallot({ canVote: false, cannotVoteReason: 'OWN_RECORD' })} onVote={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /yes/i })).not.toBeInTheDocument();
    expect(screen.getByText(/your own application/i)).toBeInTheDocument();
  });
});

describe('BallotPanel once closed', () => {
  it('shows counts, percentages and earlier rounds', () => {
    render(
      <BallotPanel
        ballot={closedBallot}
        history={[{ id: 'b0', roundNumber: 1, yesCount: 10, noCount: 12 }]}
        isAdmin
        onVote={vi.fn()}
      />
    );
    expect(screen.getByText('(72%)')).toBeInTheDocument();
    expect(screen.getByText('(28%)')).toBeInTheDocument();
    expect(screen.getByTestId('result-bar-yes')).toHaveStyle({ width: '72%' });
    expect(screen.getByText('Round 1: 10 yes / 12 no')).toBeInTheDocument();
    expect(screen.getByText('Maybe Yes')).toBeInTheDocument();
  });

  it('does not show members the decision applied', () => {
    render(<BallotPanel ballot={closedBallot} onVote={vi.fn()} />);
    expect(screen.queryByText(/Decision applied/)).not.toBeInTheDocument();
  });
});
