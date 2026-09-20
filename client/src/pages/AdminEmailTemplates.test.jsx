// The admin preview of the ATS's automatic emails.
//
// The claim this page makes is narrow and worth pinning down: opening a
// template shows the real email and sends nothing. So the tests check that the
// rendered markup reaches the frame intact, that switching templates refetches,
// and that a non-admin never gets there at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminEmailTemplates from './AdminEmailTemplates';
import apiClient from '../utils/api';

const mockUseAuth = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

const CATALOG = [
  {
    key: 'application-acceptance',
    label: 'Application advanced',
    description: 'Tells a candidate their written application moved forward.',
    audience: 'Candidate',
    category: 'Decisions',
    trigger: 'Queued by Process Application Decisions.',
  },
  {
    key: 'password-reset',
    label: 'Password reset link',
    description: 'Carries the one-time link that starts a password reset.',
    audience: 'Any account',
    category: 'Account',
    trigger: 'Sent from the forgot-password page.',
  },
];

const PREVIEWS = {
  'application-acceptance': {
    ...CATALOG[0],
    subject: "Congratulations! You've Advanced to Coffee Chats",
    html: '<p>Dear Jordan Rivera, you have advanced.</p>',
  },
  'password-reset': {
    ...CATALOG[1],
    subject: 'Reset Your Password - UConsulting ATS',
    html: '<p>Use this link to reset your password.</p>',
  },
};

function mockApi() {
  return vi.spyOn(apiClient, 'get').mockImplementation((path) => {
    if (path === '/admin/email-templates') return Promise.resolve(CATALOG);

    const match = path.match(/^\/admin\/email-templates\/(.+)\/preview$/);
    if (match && PREVIEWS[match[1]]) return Promise.resolve(PREVIEWS[match[1]]);

    const error = new Error('Unknown email template');
    error.serverMessage = 'Unknown email template';
    return Promise.reject(error);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: 'admin-1', role: 'ADMIN' } });
});

describe('AdminEmailTemplates', () => {
  it('lists every template grouped by category', async () => {
    mockApi();
    render(<AdminEmailTemplates />);

    expect(await screen.findByText('Application advanced')).toBeInTheDocument();
    expect(screen.getByText('Password reset link')).toBeInTheDocument();
    expect(screen.getByText('Decisions')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('previews the first template without being asked', async () => {
    mockApi();
    render(<AdminEmailTemplates />);

    expect(
      await screen.findByText("Congratulations! You've Advanced to Coffee Chats")
    ).toBeInTheDocument();
  });

  it('puts the rendered email in a sandboxed frame rather than the page', async () => {
    mockApi();
    const { container } = render(<AdminEmailTemplates />);

    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");

    const frame = container.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame.getAttribute('srcdoc')).toBe('<p>Dear Jordan Rivera, you have advanced.</p>');
    // Empty sandbox: no scripts, no navigation, no same-origin access.
    expect(frame.getAttribute('sandbox')).toBe('');
  });

  it('swaps the preview when another template is chosen', async () => {
    mockApi();
    const { container } = render(<AdminEmailTemplates />);
    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");

    await userEvent.click(screen.getByText('Password reset link'));

    await waitFor(() => {
      expect(container.querySelector('iframe').getAttribute('srcdoc')).toBe(
        '<p>Use this link to reset your password.</p>'
      );
    });
    expect(screen.getByText('Reset Your Password - UConsulting ATS')).toBeInTheDocument();
  });

  it('says so when a template fails to render, instead of showing a blank frame', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((path) => {
      if (path === '/admin/email-templates') return Promise.resolve(CATALOG);
      const error = new Error('boom');
      error.serverMessage = 'Failed to render this template';
      return Promise.reject(error);
    });

    render(<AdminEmailTemplates />);

    expect(await screen.findByText('Failed to render this template')).toBeInTheDocument();
  });

  it('tells the admin when the catalog itself will not load', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(
      Object.assign(new Error('nope'), { serverMessage: 'Failed to load email templates' })
    );

    render(<AdminEmailTemplates />);

    expect(await screen.findByText('Failed to load email templates')).toBeInTheDocument();
  });

  it('shows a member nothing at all', async () => {
    const get = mockApi();
    mockUseAuth.mockReturnValue({ user: { id: 'member-1', role: 'MEMBER' } });

    render(<AdminEmailTemplates />);

    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByText('Application advanced')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
