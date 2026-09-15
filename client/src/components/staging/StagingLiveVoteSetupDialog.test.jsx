import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StagingLiveVoteSetupDialog from './StagingLiveVoteSetupDialog';
import liveVoteApi from '../../utils/liveVoteApi';

vi.mock('../../utils/liveVoteApi', () => ({
  default: { rubrics: vi.fn(), launch: vi.fn(), saveRubric: vi.fn() }
}));
vi.mock('../liveVote/Headshot', () => ({ default: () => null }));

const candidates = [
  { id: 'a1', firstName: 'Zoe', lastName: 'Park', email: 'zoe@ucla.edu', major: 'Economics' },
  { id: 'a2', firstName: 'Adam', lastName: 'Lee', email: 'adam@ucla.edu', major: 'History' },
  { id: 'a3', firstName: 'Mia', lastName: 'Chen', email: 'mia@ucla.edu', locked: true },
  { id: 'a4', firstName: 'Ben', lastName: 'Ross', email: 'ben@ucla.edu', major: 'Math' }
];
const decisions = { a1: 'maybe_no', a2: 'yes', a3: 'maybe_yes', a4: 'maybe_yes' };

const setup = (props = {}) => {
  const onLaunched = vi.fn();
  render(
    <StagingLiveVoteSetupDialog
      open
      phase="final"
      phaseLabel="Final Round"
      candidates={candidates}
      decisions={decisions}
      activeSession={null}
      onClose={vi.fn()}
      onLaunched={onLaunched}
      onOpenSession={vi.fn()}
      onEndSession={vi.fn()}
      {...props}
    />
  );
  return { onLaunched };
};

const launchButton = () => screen.getByRole('button', { name: /launch live vote/i });

beforeEach(() => {
  liveVoteApi.rubrics.mockReset().mockResolvedValue({ rubrics: { final: { criteria: [{ id: 'c1', title: 'Leadership' }] } } });
  liveVoteApi.launch.mockReset();
});

describe('StagingLiveVoteSetupDialog', () => {
  it('selects all maybes in one click and launches them in the order shown', async () => {
    liveVoteApi.launch.mockResolvedValue({ session: { id: 's1' } });
    const { onLaunched } = setup();

    expect(launchButton()).toBeDisabled();
    await userEvent.click(screen.getByText('All maybes (2)'));
    expect(launchButton()).toHaveTextContent('(2)');

    await userEvent.click(launchButton());
    // Ben (maybe yes) before Zoe (maybe no); Mia is maybe yes but sealed.
    expect(liveVoteApi.launch).toHaveBeenCalledWith({ phase: 'final', applicationIds: ['a4', 'a1'] });
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('s1'));
  });

  it('searches, selects what is visible, and clears', async () => {
    setup();
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'adam');
    await userEvent.click(screen.getByText('Select all'));
    expect(launchButton()).toHaveTextContent('(1)');
    await userEvent.click(screen.getByText('Select none'));
    expect(launchButton()).toBeDisabled();
  });

  it('will not select a sealed record', async () => {
    setup();
    await userEvent.click(screen.getByText('Select all'));
    expect(launchButton()).toHaveTextContent('(3)');
    expect(screen.getByRole('checkbox', { name: 'Include Mia Chen' })).not.toBeChecked();
  });

  it('names the candidates the server refused and drops them from the selection', async () => {
    liveVoteApi.launch.mockRejectedValue(Object.assign(new Error('refused'), {
      status: 422,
      code: 'INVALID_CANDIDATES',
      body: { rejected: [{ applicationId: 'a2', name: 'Adam Lee', reason: 'OWN_RECORD' }] }
    }));
    setup();
    await userEvent.click(screen.getByText('Select all'));
    await userEvent.click(launchButton());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Adam Lee (your own application)')).toBeInTheDocument();
    expect(launchButton()).toHaveTextContent('(2)');
  });

  it('points at the running session instead of offering a second', async () => {
    const onOpenSession = vi.fn();
    setup({ activeSession: { id: 's9', phaseLabel: 'Coffee Chat' }, onOpenSession });
    expect(screen.getByText(/Coffee Chat live vote is already running/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /launch live vote/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenSession).toHaveBeenCalledWith('s9');
  });
});
