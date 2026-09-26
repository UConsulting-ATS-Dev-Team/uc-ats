// Named sign-offs for the automatic emails.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailSignaturesEditor from './EmailSignaturesEditor';
import apiClient from '../utils/api';

const TEAM = { id: 'sig-team', name: 'Recruitment Team', body: 'The Recruitment Team', imageUrl: null, isDefault: true };

let stored;

beforeEach(() => {
  vi.restoreAllMocks();
  stored = [TEAM];
  vi.spyOn(apiClient, 'get').mockImplementation(() => Promise.resolve(stored));
  vi.spyOn(apiClient, 'post').mockImplementation((url, body) => {
    if (url.endsWith('/preview')) return Promise.resolve({ key: 'password-reset', label: 'Password reset', subject: 'S', html: '<p>x</p>' });
    const created = { id: 'sig-new', ...body.signature };
    stored = [...stored, created];
    return Promise.resolve(created);
  });
  vi.spyOn(apiClient, 'delete').mockImplementation(() => {
    stored = [];
    return Promise.resolve({ deleted: 'sig-team' });
  });
});

describe('EmailSignaturesEditor', () => {
  it('lists signatures and marks the default', async () => {
    render(<EmailSignaturesEditor />);
    expect(await screen.findByText('Recruitment Team')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('creates one, previewing it at the end of a real email first', async () => {
    render(<EmailSignaturesEditor />);
    await screen.findByText('Recruitment Team');

    await userEvent.type(screen.getByLabelText('Name'), 'External VP');
    await userEvent.type(screen.getByLabelText('Signature'), 'Best, Ryan');

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/email-templates/password-reset/preview', {
        signature: { body: 'Best, Ryan', imageUrl: null },
      }),
      // The preview is debounced (350ms); leave room for a busy test run.
      { timeout: 3000 }
    );

    await userEvent.click(screen.getByRole('button', { name: /create signature/i }));
    expect(apiClient.post).toHaveBeenCalledWith('/admin/email-templates/signatures', {
      signature: { name: 'External VP', body: 'Best, Ryan', imageUrl: null, isDefault: false },
    });
  });

  it('asks before deleting, and says what happens to emails that used it', async () => {
    render(<EmailSignaturesEditor />);
    await userEvent.click(await screen.findByText('Recruitment Team'));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(screen.getByText(/will end with the default signature instead/i)).toBeInTheDocument();
    expect(apiClient.delete).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole('button', { name: /^delete$/i });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(apiClient.delete).toHaveBeenCalledWith('/admin/email-templates/signatures/sig-team');
  });

  it('says every email keeps its own sign-off while there are none', async () => {
    stored = [];
    render(<EmailSignaturesEditor />);
    expect(await screen.findByText(/every email ends with its own sign-off/i)).toBeInTheDocument();
  });
});
