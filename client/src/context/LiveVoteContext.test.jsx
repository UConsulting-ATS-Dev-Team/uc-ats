// The "a live vote has started" prompt. It appears on any page for admins and
// members, and stays out of the way everywhere it should: for candidates, over a
// candidate preview, on the vote page itself, and after "Not now".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LiveVoteProvider } from './LiveVoteContext';
import liveVoteApi from '../utils/liveVoteApi';
import { setPreviewActive } from '../utils/previewMode';

const navigate = vi.fn();
let pathname = '/';
let currentUser;

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname })
}));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock('../supabaseClient', () => ({ supabase: null }));
vi.mock('../utils/liveVoteApi', () => ({ default: { active: vi.fn() } }));

const session = {
  id: 's1', phase: 'final', phaseLabel: 'Final Round', status: 'LOBBY',
  candidateCount: 4, createdByName: 'Ada Admin', joined: false
};

beforeEach(() => {
  navigate.mockClear();
  pathname = '/';
  currentUser = { id: 'u1', role: 'MEMBER' };
  sessionStorage.clear();
  setPreviewActive(false);
  liveVoteApi.active.mockReset().mockResolvedValue({ session });
});

describe('LiveVoteProvider', () => {
  it('asks a member to join and takes them to the session', async () => {
    render(<LiveVoteProvider><div /></LiveVoteProvider>);
    expect(await screen.findByText('A live vote has started')).toBeInTheDocument();
    expect(screen.getByText('Final Round · 4 candidates · started by Ada Admin')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /join live vote/i }));
    expect(navigate).toHaveBeenCalledWith('/live-vote/s1');
  });

  it('keeps a join button in the corner after "Not now"', async () => {
    render(<LiveVoteProvider><div /></LiveVoteProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(screen.queryByText('A live vote has started')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Join live vote' })).toBeInTheDocument();
    expect(sessionStorage.getItem('liveVote:dismissed:s1')).toBe('1');
  });

  it('never asks a candidate, and never checks for them', async () => {
    currentUser = { id: 'u2', role: 'USER' };
    render(<LiveVoteProvider><div /></LiveVoteProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(liveVoteApi.active).not.toHaveBeenCalled();
    expect(screen.queryByText('A live vote has started')).not.toBeInTheDocument();
  });

  it('stays hidden over a candidate preview and on the vote page', async () => {
    setPreviewActive(true);
    const { unmount } = render(<LiveVoteProvider><div /></LiveVoteProvider>);
    await waitFor(() => expect(liveVoteApi.active).toHaveBeenCalled());
    expect(screen.queryByText('A live vote has started')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /live vote/i })).not.toBeInTheDocument();
    unmount();

    setPreviewActive(false);
    pathname = '/live-vote/s1';
    render(<LiveVoteProvider><div /></LiveVoteProvider>);
    await waitFor(() => expect(liveVoteApi.active).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('A live vote has started')).not.toBeInTheDocument();
  });

  it('offers a way back, not a prompt, to someone already in the session', async () => {
    liveVoteApi.active.mockResolvedValue({ session: { ...session, joined: true } });
    render(<LiveVoteProvider><div /></LiveVoteProvider>);
    expect(await screen.findByRole('button', { name: 'Return to live vote' })).toBeInTheDocument();
    expect(screen.queryByText('A live vote has started')).not.toBeInTheDocument();
  });
});
