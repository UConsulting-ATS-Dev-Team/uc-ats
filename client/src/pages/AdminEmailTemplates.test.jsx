// The admin preview of the ATS's automatic emails.
//
// The claim this page makes is narrow and worth pinning down: opening a
// template shows the real email and sends nothing, and editing one changes what
// that email will say. So the tests check that the rendered markup reaches the
// frame intact, that switching templates refetches, that a save re-renders the
// preview beside it, and that a non-admin never gets there at all.
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
    category: 'Applications',
    trigger: 'Sent from the application page in admin.js.',
    alsoAttaches: null,
    source: 'emailNotifications',
    sourceLabel: 'Takes effect on the next send',
    copyKey: 'application-acceptance',
    editable: true,
  },
  {
    key: 'password-reset',
    label: 'Password reset link',
    description: 'Carries the one-time link that starts a password reset.',
    audience: 'Any account',
    category: 'Account',
    trigger: 'Sent from the forgot-password page.',
    alsoAttaches: null,
    source: 'emailNotifications',
    sourceLabel: 'Takes effect on the next send',
    copyKey: 'password-reset',
    editable: true,
  },
  {
    key: 'slot-confirmation',
    label: 'Interview slot confirmed',
    description: 'Confirms the session a candidate picked.',
    audience: 'Candidate',
    category: 'Interview scheduling',
    trigger: 'Sent when a candidate books an interview slot.',
    alsoAttaches: 'A calendar invite (.ics).',
    source: 'interviewSlot',
    sourceLabel: 'Takes effect on notifications queued after the edit',
    copyKey: 'slot-confirmation',
    editable: true,
  },
  {
    key: 'decision-round-1-advanced',
    label: 'Application advanced (decision)',
    description: 'Default wording for an application decision of ADVANCED.',
    audience: 'Candidate',
    category: 'Round decisions',
    trigger: 'Queued by decision processing.',
    alsoAttaches: null,
    source: 'decisionBatch',
    sourceLabel: 'Sets what a new batch starts from; also editable per batch in Master Communications',
    copyKey: 'decision-round-1-advanced',
    editable: true,
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
  'slot-confirmation': {
    ...CATALOG[2],
    subject: "You're confirmed - First Round Interviews",
    html: '<p>Your time is confirmed.</p>',
  },
  'decision-round-1-advanced': {
    ...CATALOG[3],
    subject: "Congratulations! You've advanced to Coffee Chats - Fall 2026",
    html: '<p>Hi Jordan,</p>',
  },
};

const COPY = {
  key: 'application-acceptance',
  mergeFields: ['candidateName', 'cycleName'],
  customized: false,
  updatedAt: null,
  fields: [
    { name: 'heading', label: 'Heading', type: 'line', help: null, default: 'Congratulations!', value: '' },
  ],
};

function mockApi() {
  return vi.spyOn(apiClient, 'get').mockImplementation((path) => {
    if (path === '/admin/email-templates') return Promise.resolve(CATALOG);

    const match = path.match(/^\/admin\/email-templates\/(.+)\/preview$/);
    if (match && PREVIEWS[match[1]]) return Promise.resolve(PREVIEWS[match[1]]);

    if (/^\/admin\/email-templates\/.+\/copy$/.test(path)) return Promise.resolve(COPY);

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
    expect(screen.getByText('Applications')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Interview scheduling')).toBeInTheDocument();
    expect(screen.getByText('Round decisions')).toBeInTheDocument();
  });

  it('says when an edit to each template takes effect', async () => {
    mockApi();
    render(<AdminEmailTemplates />);

    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");
    expect(screen.getByText('Takes effect on the next send')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Application advanced (decision)'));

    await waitFor(() => {
      expect(
        screen.getByText(/Sets what a new batch starts from/)
      ).toBeInTheDocument();
    });
  });

  it('names an attachment the frame cannot show', async () => {
    mockApi();
    render(<AdminEmailTemplates />);
    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");

    // The first template carries no attachment, so no note.
    expect(screen.queryByText(/Not shown below/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Interview slot confirmed'));

    await waitFor(() => {
      expect(
        screen.getByText('Not shown below: A calendar invite (.ics).')
      ).toBeInTheDocument();
    });
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

  it('offers to edit the wording of the template on screen', async () => {
    mockApi();
    render(<AdminEmailTemplates />);
    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");

    await userEvent.click(screen.getByRole('tab', { name: /edit wording/i }));

    expect(await screen.findByLabelText('Heading')).toHaveValue('Congratulations!');
    // The preview frame belongs to the other tab.
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('re-renders the preview once wording is saved', async () => {
    const get = mockApi();
    vi.spyOn(apiClient, 'put').mockResolvedValue({
      ...COPY,
      customized: true,
      fields: [{ ...COPY.fields[0], value: 'You are through' }],
    });

    const { container } = render(<AdminEmailTemplates />);
    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");

    await userEvent.click(screen.getByRole('tab', { name: /edit wording/i }));
    const heading = await screen.findByLabelText('Heading');
    await userEvent.clear(heading);
    await userEvent.type(heading, 'You are through');

    // What the re-rendered preview will return once the save lands.
    PREVIEWS['application-acceptance'].html = '<p>You are through.</p>';
    await userEvent.click(screen.getByRole('button', { name: /save wording/i }));

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/admin/email-templates/application-acceptance/preview')
    );

    await userEvent.click(screen.getByRole('tab', { name: /^preview$/i }));
    await waitFor(() =>
      expect(container.querySelector('iframe').getAttribute('srcdoc')).toBe('<p>You are through.</p>')
    );
  });

  it('goes back to the preview when another template is chosen', async () => {
    mockApi();
    render(<AdminEmailTemplates />);
    await screen.findByText("Congratulations! You've Advanced to Coffee Chats");

    await userEvent.click(screen.getByRole('tab', { name: /edit wording/i }));
    await screen.findByLabelText('Heading');

    await userEvent.click(screen.getByText('Password reset link'));

    await waitFor(() => expect(screen.queryByLabelText('Heading')).toBeNull());
    expect(document.querySelector('iframe')).toBeTruthy();
  });

  it('badges a template somebody has already edited', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((path) => {
      if (path === '/admin/email-templates') {
        return Promise.resolve(CATALOG.map((entry, i) => ({ ...entry, customized: i === 1 })));
      }
      const match = path.match(/^\/admin\/email-templates\/(.+)\/preview$/);
      if (match && PREVIEWS[match[1]]) return Promise.resolve(PREVIEWS[match[1]]);
      return Promise.resolve(COPY);
    });

    render(<AdminEmailTemplates />);

    await screen.findByText('Password reset link');
    expect(screen.getAllByText('Edited')).toHaveLength(1);
  });
});
