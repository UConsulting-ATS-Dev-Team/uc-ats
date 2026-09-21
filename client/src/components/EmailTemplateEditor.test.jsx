// The wording editor for one automatic email.
//
// What it promises is small enough to pin down: the boxes start holding the
// words the email uses today, Save is only offered once something differs, and
// what goes back to the server is what is in the boxes. The server decides what
// is worth storing; this file checks the editor does not lie about what will be
// sent.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailTemplateEditor from './EmailTemplateEditor';
import apiClient from '../utils/api';

const COPY = {
  key: 'rsvp-confirmation',
  mergeFields: ['candidateName', 'eventName'],
  customized: false,
  updatedAt: null,
  fields: [
    { name: 'subject', label: 'Subject', type: 'line', help: null, default: 'RSVP Confirmation - {{eventName}}', value: '' },
    { name: 'heading', label: 'Heading', type: 'line', help: null, default: 'RSVP Confirmation', value: '' },
    { name: 'intro', label: 'Before the event details', type: 'block', help: null, default: 'Thank you for your RSVP!', value: '' },
    { name: 'signOff', label: 'Sign-off', type: 'signoff', help: 'One line per line of the sign-off.', default: 'Best regards,\nUConsulting ATS Team', value: '' },
  ],
};

const withValue = (name, value) => ({
  ...COPY,
  customized: true,
  fields: COPY.fields.map((field) => (field.name === name ? { ...field, value } : field)),
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockResolvedValue(COPY);
  vi.spyOn(apiClient, 'put').mockResolvedValue(withValue('heading', 'You are on the list'));
  vi.spyOn(apiClient, 'delete').mockResolvedValue(COPY);
});

const heading = () => screen.getByLabelText('Heading');

describe('EmailTemplateEditor', () => {
  it('fills each box with the words the email uses today', async () => {
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    expect(screen.getByLabelText('Subject')).toHaveValue('RSVP Confirmation - {{eventName}}');
    expect(screen.getByLabelText('Before the event details')).toHaveValue('Thank you for your RSVP!');
  });

  it('shows an edit already saved, not the wording it replaced', async () => {
    apiClient.get.mockResolvedValue(withValue('heading', 'You are on the list'));

    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('You are on the list'));
  });

  it('lists the fill-ins this email can supply', async () => {
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(screen.getByText('{{candidateName}}')).toBeInTheDocument());
    expect(screen.getByText('{{eventName}}')).toBeInTheDocument();
  });

  it('does not offer Save until something differs', async () => {
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    expect(screen.getByRole('button', { name: /save wording/i })).toBeDisabled();

    await userEvent.clear(heading());
    await userEvent.type(heading(), 'You are on the list');

    expect(screen.getByRole('button', { name: /save wording/i })).toBeEnabled();
  });

  it('sends every box, so the server can tell an edit from the shipped wording', async () => {
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    await userEvent.clear(heading());
    await userEvent.type(heading(), 'You are on the list');
    await userEvent.click(screen.getByRole('button', { name: /save wording/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
    const [path, body] = apiClient.put.mock.calls[0];
    expect(path).toBe('/admin/email-templates/rsvp-confirmation/copy');
    expect(body.copy.heading).toBe('You are on the list');
    expect(body.copy.intro).toBe('Thank you for your RSVP!');
  });

  it('tells the page it saved, so the preview can catch up', async () => {
    const onSaved = vi.fn();
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" onSaved={onSaved} />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    await userEvent.clear(heading());
    await userEvent.type(heading(), 'Changed');
    await userEvent.click(screen.getByRole('button', { name: /save wording/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('marks a changed box and offers to undo it, without going near the server', async () => {
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    await userEvent.clear(heading());
    await userEvent.type(heading(), 'Changed');

    expect(screen.getByText('Changed', { selector: '.MuiChip-label' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /undo/i }));

    expect(heading()).toHaveValue('RSVP Confirmation');
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('only offers to restore the original once there is an edit to undo', async () => {
    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    expect(screen.getByRole('button', { name: /restore the original/i })).toBeDisabled();
  });

  it('restores the original wording', async () => {
    apiClient.get.mockResolvedValue(withValue('heading', 'You are on the list'));

    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('You are on the list'));
    await userEvent.click(screen.getByRole('button', { name: /restore the original/i }));

    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith(
      '/admin/email-templates/rsvp-confirmation/copy'
    ));
    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
  });

  it('shows why a save was refused and leaves the text in the box', async () => {
    apiClient.put.mockRejectedValue({
      serverMessage: 'Heading uses {{memberName}}, which this email cannot fill in',
    });

    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(heading()).toHaveValue('RSVP Confirmation'));
    await userEvent.clear(heading());
    await userEvent.type(heading(), 'Hi there');
    await userEvent.click(screen.getByRole('button', { name: /save wording/i }));

    await waitFor(() =>
      expect(screen.getByText(/which this email cannot fill in/)).toBeInTheDocument()
    );
    expect(heading()).toHaveValue('Hi there');
  });

  it('says so when the wording cannot be loaded', async () => {
    apiClient.get.mockRejectedValue({ serverMessage: 'Nope' });

    render(<EmailTemplateEditor templateKey="rsvp-confirmation" />);

    await waitFor(() => expect(screen.getByText('Nope')).toBeInTheDocument());
  });
});
