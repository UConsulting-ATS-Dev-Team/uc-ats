import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HostControlBar from './HostControlBar';

const stateWith = (ballot, overrides = {}) => ({
  session: { currentIndex: 1, candidateCount: 3, ...overrides.session },
  current: {
    sessionCandidateId: 'sc2',
    decision: 'maybe_no',
    candidate: { name: 'Sam', locked: false },
    ballot
  }
});

const handlers = () => ({
  onPrev: vi.fn(), onNext: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(), onDecide: vi.fn(), onEnd: vi.fn()
});

describe('HostControlBar', () => {
  it('offers Close while voting is open and keeps decisions locked until then', async () => {
    const h = handlers();
    render(<HostControlBar state={stateWith({ status: 'OPEN' })} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /close voting/i }));
    expect(h.onClose).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeDisabled();
  });

  it('offers Re-open and decisions once closed, marking the current decision', async () => {
    const h = handlers();
    render(<HostControlBar state={stateWith({ status: 'CLOSED' })} {...h} />);
    expect(screen.getByRole('button', { name: 'Maybe No' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(h.onDecide).toHaveBeenCalledWith('yes');
    await userEvent.click(screen.getByRole('button', { name: /re-open voting/i }));
    expect(h.onReopen).toHaveBeenCalled();
  });

  it('disables Prev on the first candidate and Next on the last', () => {
    const { rerender } = render(<HostControlBar state={stateWith({ status: 'CLOSED' }, { session: { currentIndex: 0 } })} {...handlers()} />);
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
    rerender(<HostControlBar state={stateWith({ status: 'CLOSED' }, { session: { currentIndex: 2 } })} {...handlers()} />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('freezes every control while an action is in flight', () => {
    render(<HostControlBar state={stateWith({ status: 'OPEN' })} pendingAction="close" {...handlers()} />);
    expect(screen.getByRole('button', { name: /close voting/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /end session/i })).toBeDisabled();
  });
});
