// The "your review team deliberation has started" prompt. The server decides
// which sessions a person may join; this checks the prompt shows exactly those,
// stays away where it should, and remembers "Not now".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewDelibProvider } from './ReviewDelibContext';
import reviewDelibApi from '../utils/reviewDelibApi';
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
vi.mock('../utils/reviewDelibApi', () => ({ default: { active: vi.fn() } }));

const alpha = { id: 's1', groupId: 'g1', groupName: 'Team Alpha', createdByName: 'Ada Admin', joined: false };
const beta = { id: 's2', groupId: 'g2', groupName: 'Team Beta', createdByName: 'Bo Admin', joined: false };

beforeEach(() => {
  navigate.mockClear();
  pathname = '/';
  currentUser = { id: 'u1', role: 'MEMBER' };
  sessionStorage.clear();
  setPreviewActive(false);
  reviewDelibApi.active.mockReset().mockResolvedValue({ sessions: [alpha] });
});

describe('ReviewDelibProvider', () => {
  it("asks a member to join their team's session", async () => {
    render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    expect(await screen.findByText('Your review team deliberation has started')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /join deliberation/i }));
    expect(navigate).toHaveBeenCalledWith('/review-delib/s1');
  });

  it('shows nothing when the server lists no session for this person', async () => {
    reviewDelibApi.active.mockResolvedValue({ sessions: [] });
    render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    await waitFor(() => expect(reviewDelibApi.active).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a way back in the corner after "Not now"', async () => {
    render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(screen.queryByText('Your review team deliberation has started')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Join the review team deliberation' })).toBeInTheDocument();
    expect(sessionStorage.getItem('reviewDelib:dismissed:s1')).toBe('1');
  });

  it('lists every running session for an admin', async () => {
    currentUser = { id: 'a1', role: 'ADMIN' };
    reviewDelibApi.active.mockResolvedValue({ sessions: [alpha, beta] });
    render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    expect(await screen.findByText('2 review team deliberations are running')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Team Beta'));
    expect(navigate).toHaveBeenCalledWith('/review-delib/s2');
  });

  it('keeps a way back to the list after "Not now" when several are running', async () => {
    currentUser = { id: 'a1', role: 'ADMIN' };
    reviewDelibApi.active.mockResolvedValue({ sessions: [alpha, beta] });
    render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(screen.queryByText('2 review team deliberations are running')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Show the review team deliberations that are running' }));
    expect(await screen.findByText('2 review team deliberations are running')).toBeInTheDocument();
  });

  it('never checks for a candidate, and stays off the session page itself', async () => {
    currentUser = { id: 'u2', role: 'USER' };
    const { unmount } = render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reviewDelibApi.active).not.toHaveBeenCalled();
    unmount();

    currentUser = { id: 'u1', role: 'MEMBER' };
    pathname = '/review-delib/s1';
    render(<ReviewDelibProvider><div /></ReviewDelibProvider>);
    await waitFor(() => expect(reviewDelibApi.active).toHaveBeenCalled());
    expect(screen.queryByText('Your review team deliberation has started')).not.toBeInTheDocument();
  });
});
