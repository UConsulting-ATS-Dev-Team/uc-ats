import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomEmailsPanel from './CustomEmailsPanel';
import TriggerFields from './TriggerFields';
import apiClient from '../../utils/api';

const OPTIONS = {
  triggers: [
    { id: 'APPLICATION_STATUS', label: 'An application reaches a status' },
    { id: 'RECORD_CREATED', label: 'Something is created' },
    { id: 'EVENT_TIME', label: 'Before or after an event a candidate RSVPed to' },
    { id: 'INTERVIEW_TIME', label: "Before or after a candidate's interview" },
    { id: 'CYCLE_DATE', label: 'Before or after a cycle date, to a saved audience' },
  ],
  records: [{ id: 'ACCOUNT', label: 'An account is created' }],
  cycleDates: [{ id: 'applicationDeadline', label: 'Application deadline' }],
  statuses: ['WAITLISTED', 'REJECTED'],
  savedAudiences: [{ id: 'aud-1', name: 'Started but not applied' }],
};

const EMAIL = {
  id: 'ae1',
  name: 'Waitlist note',
  enabled: false,
  trigger: 'APPLICATION_STATUS',
  triggerConfig: { status: 'WAITLISTED' },
  triggerSummary: 'When an application becomes Waitlisted',
  subject: 'An update',
  body: 'Hi {{firstName}}',
  marketing: false,
  format: 'DESIGNED',
  banner: 'brand',
  signatureId: null,
  stats: { SENT: 4 },
  recent: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockImplementation((url) => {
    if (url === '/admin/automatic-emails') return Promise.resolve([EMAIL]);
    if (url === '/admin/automatic-emails/options') return Promise.resolve(OPTIONS);
    if (url === '/admin/email-templates/signatures') return Promise.resolve([]);
    if (url === '/admin/automatic-emails/ae1') return Promise.resolve(EMAIL);
    return Promise.reject(new Error(url));
  });
  vi.spyOn(apiClient, 'post').mockImplementation((url) => {
    if (url.endsWith('/merge-fields')) return Promise.resolve({ mergeFields: ['firstName', 'cycleName', 'status'] });
    if (url.endsWith('/preview')) return Promise.resolve({ subject: 'An update', html: '<p>x</p>', text: 'x' });
    if (url.endsWith('/dry-run')) return Promise.resolve({ kind: 'status', alreadyInStatus: 12, note: '12 application(s) are in this status now. They will not be emailed.' });
    if (url.endsWith('/test')) return Promise.resolve({ sentTo: 'admin@example.com' });
    return Promise.resolve({ ...EMAIL, id: 'new' });
  });
  vi.spyOn(apiClient, 'put').mockImplementation((url, body) => Promise.resolve({ ...EMAIL, enabled: body.enabled }));
});

describe('the list', () => {
  it('shows each email with its trigger in words and how many it has sent', async () => {
    render(<CustomEmailsPanel />);
    expect(await screen.findByText('Waitlist note')).toBeInTheDocument();
    expect(screen.getByText(/When an application becomes Waitlisted/)).toBeInTheDocument();
    expect(screen.getByText(/4 sent/)).toBeInTheDocument();
  });

  it('shows who it reaches, and only turns it on once confirmed', async () => {
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByLabelText('Turn on Waitlist note'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/12 application\(s\) are in this status now/)).toBeInTheDocument();
    expect(apiClient.put).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(apiClient.put).toHaveBeenCalledWith('/admin/automatic-emails/ae1/enabled', { enabled: true });
  });

  it('does nothing when the admin backs out', async () => {
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByLabelText('Turn on Waitlist note'));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Not yet' }));
    expect(apiClient.put).not.toHaveBeenCalled();
  });
});

describe('the editor', () => {
  it('creates a new email that stays off', async () => {
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /new automatic email/i }));

    await userEvent.type(screen.getByLabelText('Name'), 'Deadline nudge');
    await userEvent.type(screen.getByLabelText('Subject'), 'Deadline soon');
    await userEvent.click(screen.getByRole('button', { name: /create \(stays off\)/i }));

    const [url, body] = apiClient.post.mock.calls.find(([u]) => u === '/admin/automatic-emails');
    expect(url).toBe('/admin/automatic-emails');
    expect(body.email).toMatchObject({ name: 'Deadline nudge', subject: 'Deadline soon', trigger: 'APPLICATION_STATUS' });
    expect(body.email).not.toHaveProperty('enabled');
  });

  it('goes quiet after saving, even when the server trimmed what was sent', async () => {
    apiClient.put.mockImplementation((url, body) => Promise.resolve({ ...EMAIL, ...body.email, name: body.email.name.trim() }));
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByText('Waitlist note'));

    await userEvent.type(await screen.findByLabelText('Name'), ' v2   ');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/stays off until you turn it on/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Waitlist note v2');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('keeps what the admin typed while a save was still in flight', async () => {
    let finish;
    apiClient.put.mockImplementation((url, body) => new Promise((resolve) => {
      finish = () => resolve({ ...EMAIL, ...body.email });
    }));
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByText('Waitlist note'));
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, ' v2');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await userEvent.type(name, ' and v3');
    finish();

    expect(await screen.findByText(/stays off until you turn it on/)).toBeInTheDocument();
    expect(name).toHaveValue('Waitlist note v2 and v3');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('keeps edits typed while a new email is first saved, and saves the next change over it', async () => {
    let finish;
    apiClient.post.mockImplementation((url, body) => {
      if (url === '/admin/automatic-emails') {
        return new Promise((resolve) => {
          finish = () => resolve({ ...EMAIL, ...body.email, id: 'created-1', recent: [] });
        });
      }
      if (url.endsWith('/merge-fields')) return Promise.resolve({ mergeFields: ['firstName'] });
      return Promise.resolve({ subject: 's', html: '<p/>', text: '' });
    });
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /new automatic email/i }));

    const name = screen.getByLabelText('Name');
    await userEvent.type(name, 'Deadline nudge');
    await userEvent.type(screen.getByLabelText('Subject'), 'Soon');
    await userEvent.click(screen.getByRole('button', { name: /create \(stays off\)/i }));
    await userEvent.type(name, ' v2');
    finish();

    expect(await screen.findByText(/stays off until you turn it on/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Deadline nudge v2');

    // Now it exists, so the next save updates it rather than creating another.
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(apiClient.put).toHaveBeenCalledWith('/admin/automatic-emails/created-1', expect.anything());
  });

  it('ignores a save that returns after another email was opened', async () => {
    const OTHER = { ...EMAIL, id: 'ae2', name: 'Interview reminder', triggerSummary: '1 day before their interview' };
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/automatic-emails') return Promise.resolve([EMAIL, OTHER]);
      if (url === '/admin/automatic-emails/options') return Promise.resolve(OPTIONS);
      if (url === '/admin/email-templates/signatures') return Promise.resolve([]);
      if (url === '/admin/automatic-emails/ae1') return Promise.resolve(EMAIL);
      if (url === '/admin/automatic-emails/ae2') return Promise.resolve(OTHER);
      return Promise.reject(new Error(url));
    });
    let finishA;
    apiClient.put.mockImplementation((url, body) =>
      url.endsWith('/ae1')
        ? new Promise((resolve) => {
            finishA = () => resolve({ ...EMAIL, ...body.email });
          })
        : Promise.resolve({ ...OTHER, ...body.email })
    );
    render(<CustomEmailsPanel />);

    await userEvent.click(await screen.findByText('Waitlist note'));
    await userEvent.type(await screen.findByLabelText('Name'), ' v2');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await userEvent.click(screen.getByText('Interview reminder'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Interview reminder'));
    finishA();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/automatic-emails'));

    // Still B, and B's Save goes to B.
    expect(screen.getByLabelText('Name')).toHaveValue('Interview reminder');
    await userEvent.type(screen.getByLabelText('Name'), '!');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(apiClient.put).toHaveBeenLastCalledWith('/admin/automatic-emails/ae2', expect.anything());
  });

  it('shows the fill-ins the trigger can supply', async () => {
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByText('Waitlist note'));
    expect(await screen.findByText('{{cycleName}}')).toBeInTheDocument();
  });

  it('sends the unsaved draft as a test', async () => {
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByText('Waitlist note'));
    await userEvent.click(await screen.findByRole('button', { name: /send test to me/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/admin/automatic-emails/test', expect.objectContaining({ email: expect.objectContaining({ name: 'Waitlist note' }) })));
    expect(await screen.findByText(/Test sent to admin@example.com/)).toBeInTheDocument();
  });

  it('always marks a send to a saved audience as marketing', async () => {
    render(<CustomEmailsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /new automatic email/i }));
    await userEvent.click(screen.getByLabelText('Trigger'));
    await userEvent.click(within(screen.getByRole('listbox')).getByText(/cycle date/));

    const box = screen.getByRole('checkbox', { name: /marketing email/i });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
  });
});

describe('offsets', () => {
  it('reads and writes "2 days before" as -48 hours', async () => {
    const onChange = vi.fn();
    render(<TriggerFields trigger="EVENT_TIME" config={{ offsetHours: -48 }} options={OPTIONS} onChange={onChange} />);

    expect(screen.getByLabelText('How long')).toHaveValue(2);
    await userEvent.click(screen.getByLabelText('When'));
    await userEvent.click(within(screen.getByRole('listbox')).getByText('after'));
    expect(onChange).toHaveBeenLastCalledWith({ offsetHours: 48 });
  });
});
