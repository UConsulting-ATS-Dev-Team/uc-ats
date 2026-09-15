import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveVoteResultChip from './LiveVoteResultChip';

describe('LiveVoteResultChip', () => {
  it('renders nothing for a candidate never voted on', () => {
    const { container } = render(<LiveVoteResultChip ballots={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels the latest round and lists every round on hover', async () => {
    render(
      <LiveVoteResultChip
        ballots={[
          { sessionId: 's1', roundNumber: 1, yesCount: 9, noCount: 11, closedAt: '2026-09-15T02:00:00Z', decisionApplied: null },
          { sessionId: 's1', roundNumber: 2, yesCount: 18, noCount: 7, closedAt: '2026-09-15T02:10:00Z', decisionApplied: 'yes' }
        ]}
      />
    );
    const chip = screen.getByText('Vote 18–7');
    await userEvent.hover(chip);
    expect(await screen.findByText(/Round 1 · 9 yes \/ 11 no/)).toBeInTheDocument();
    expect(screen.getByText(/Round 2 · 18 yes \/ 7 no · Decision: Yes/)).toBeInTheDocument();
  });
});
