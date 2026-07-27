import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CelebrationProvider, useCelebration } from './CelebrationContext';
import { setPreviewActive } from '../utils/previewMode';

const mockConfetti = vi.hoisted(() => vi.fn());

vi.mock(import('canvas-confetti'), () => ({
  default: mockConfetti,
}));

const TestTrigger = ({ eventName }) => {
  const { triggerCelebration } = useCelebration();

  return (
    <button data-testid="trigger" onClick={() => triggerCelebration(eventName)}>
      Trigger
    </button>
  );
};

function createMatchMedia(matches) {
  return vi.fn((query) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

function renderProvider(eventName) {
  return render(
    <CelebrationProvider>
      <TestTrigger eventName={eventName} />
    </CelebrationProvider>
  );
}

describe('CelebrationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPreviewActive(false);
    vi.stubGlobal('matchMedia', createMatchMedia(false));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fires confetti for an allowed event', async () => {
    renderProvider('deliberations-completed');

    fireEvent.click(screen.getByTestId('trigger'));

    await waitFor(() => expect(mockConfetti).toHaveBeenCalled());
    expect(mockConfetti).toHaveBeenCalledTimes(1);
  });

  it('does not fire confetti when no event is provided', async () => {
    renderProvider(undefined);

    fireEvent.click(screen.getByTestId('trigger'));

    await waitFor(() => expect(mockConfetti).not.toHaveBeenCalled(), { timeout: 300 });
  });

  it('does not fire confetti for an unknown event', async () => {
    renderProvider('evaluation-saved');

    fireEvent.click(screen.getByTestId('trigger'));

    await waitFor(() => expect(mockConfetti).not.toHaveBeenCalled(), { timeout: 300 });
  });

  it('does not fire confetti while preview mode is active', async () => {
    setPreviewActive(true);
    renderProvider('deliberations-completed');

    fireEvent.click(screen.getByTestId('trigger'));

    await waitFor(() => expect(mockConfetti).not.toHaveBeenCalled(), { timeout: 300 });
  });

  it('shows a static success state and does not load confetti when reduced motion is preferred', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('matchMedia', createMatchMedia(true));

    renderProvider('deliberations-completed');

    fireEvent.click(screen.getByTestId('trigger'));

    expect(await screen.findByText('Milestone completed')).toBeInTheDocument();
    expect(mockConfetti).not.toHaveBeenCalled();
  });

  it('does not fail when matchMedia is unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined);

    renderProvider('deliberations-completed');

    fireEvent.click(screen.getByTestId('trigger'));

    await waitFor(() => expect(mockConfetti).toHaveBeenCalled());
  });

  it('does not fire duplicate confetti for the same allowed event within the cooldown', async () => {
    renderProvider('deliberations-completed');

    fireEvent.click(screen.getByTestId('trigger'));
    fireEvent.click(screen.getByTestId('trigger'));

    await waitFor(() => expect(mockConfetti).toHaveBeenCalled());
    expect(mockConfetti).toHaveBeenCalledTimes(1);
  });

  it('allows a different allowed event during the cooldown window', async () => {
    render(
      <CelebrationProvider>
        <TestTrigger eventName="deliberations-completed" />
        <TestTrigger eventName="cycle-closed" />
      </CelebrationProvider>
    );

    fireEvent.click(screen.getAllByTestId('trigger')[0]);
    fireEvent.click(screen.getAllByTestId('trigger')[1]);

    await waitFor(() => expect(mockConfetti).toHaveBeenCalledTimes(2));
  });

  it('clears the static success state after a short duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.unstubAllGlobals();
    vi.stubGlobal('matchMedia', createMatchMedia(true));

    renderProvider('deliberations-completed');

    fireEvent.click(screen.getByTestId('trigger'));

    expect(await screen.findByText('Milestone completed')).toBeInTheDocument();

    vi.advanceTimersByTime(2500);

    await waitFor(() => {
      expect(screen.queryByText('Milestone completed')).not.toBeInTheDocument();
    });
  });
});
