// The member Talent Partner Network reminder.
//
// The rules worth pinning down are all about when it stays quiet: it is a
// reminder, not a gate, so every way it could become an irritation - showing to
// the wrong role, showing to someone who already answered, showing twice in a
// session, showing over the page it points at - is a bug.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MemberTalentNetworkPrompt from './MemberTalentNetworkPrompt';
import apiClient from '../utils/api';

const navigate = vi.fn();
let pathname = '/';
let currentUser = { id: 'member-1', role: 'MEMBER' };

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: currentUser }),
}));

const mockResume = (resume) => vi.spyOn(apiClient, 'get').mockResolvedValue({ resume });

beforeEach(() => {
  vi.restoreAllMocks();
  navigate.mockClear();
  pathname = '/';
  currentUser = { id: 'member-1', role: 'MEMBER' };
  sessionStorage.clear();
});

const title = /Set up your Talent Partner Network resume/;

describe('when it appears', () => {
  it('asks a member who has no resume yet', async () => {
    mockResume(null);
    render(<MemberTalentNetworkPrompt />);
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it('mentions the stale application resume, which is why we are asking', async () => {
    mockResume(null);
    render(<MemberTalentNetworkPrompt />);
    await screen.findByText(title);
    expect(screen.getByText(/applied in an earlier cycle/i)).toBeInTheDocument();
  });
});

describe('when it stays quiet', () => {
  it('never asks a member who already uploaded a resume', async () => {
    const get = mockResume({ id: 'mr-1', shareConsent: true });
    render(<MemberTalentNetworkPrompt />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  });

  it('never asks someone who uploaded and declined - they answered', async () => {
    // Continuing to ask would be nagging them to reverse a decision they made.
    const get = mockResume({ id: 'mr-1', shareConsent: false });
    render(<MemberTalentNetworkPrompt />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  });

  it.each([['ADMIN'], ['USER'], ['CLIENT']])('never asks a %s', async (role) => {
    currentUser = { id: 'u-1', role };
    const get = vi.spyOn(apiClient, 'get');
    render(<MemberTalentNetworkPrompt />);
    expect(screen.queryByText(title)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not appear over the page it is asking them to visit', async () => {
    pathname = '/member/talent-network';
    const get = vi.spyOn(apiClient, 'get');
    render(<MemberTalentNetworkPrompt />);
    expect(screen.queryByText(title)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('stays quiet when the check fails rather than interrupting a broken page', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('boom'));
    render(<MemberTalentNetworkPrompt />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(title)).not.toBeInTheDocument();
  });
});

describe('dismissal', () => {
  it('does not come back for the rest of the session', async () => {
    mockResume(null);
    const { unmount } = render(<MemberTalentNetworkPrompt />);
    await screen.findByText(title);

    await userEvent.click(screen.getByRole('button', { name: /Not now/ }));
    await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());

    // A later navigation remounts it; it must not reappear.
    unmount();
    render(<MemberTalentNetworkPrompt />);
    await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());
  });

  it('asks again in a new session, which is the next login', async () => {
    mockResume(null);
    const { unmount } = render(<MemberTalentNetworkPrompt />);
    await screen.findByText(title);
    await userEvent.click(screen.getByRole('button', { name: /Not now/ }));
    unmount();

    sessionStorage.clear(); // what ending the browser session does
    render(<MemberTalentNetworkPrompt />);
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it('keys dismissal per user, so a shared browser does not silence the next person', async () => {
    mockResume(null);
    const { unmount } = render(<MemberTalentNetworkPrompt />);
    await screen.findByText(title);
    await userEvent.click(screen.getByRole('button', { name: /Not now/ }));
    unmount();

    currentUser = { id: 'member-2', role: 'MEMBER' };
    render(<MemberTalentNetworkPrompt />);
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it('sends them to the page and does not ask again on arrival', async () => {
    mockResume(null);
    render(<MemberTalentNetworkPrompt />);
    await screen.findByText(title);

    await userEvent.click(screen.getByRole('button', { name: /Set it up/ }));
    expect(navigate).toHaveBeenCalledWith('/member/talent-network');
    await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());
  });
});
