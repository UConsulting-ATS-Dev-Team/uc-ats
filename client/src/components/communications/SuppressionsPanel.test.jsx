// The Unsubscribes tab. What matters: an admin can see who is held back, add
// someone with a note, put a resubscribed person back on the list, and is told
// when any of that failed rather than left looking at an unchanged list.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SuppressionsPanel from './SuppressionsPanel';
import apiClient from '../../utils/api';

const active = {
  id: 's1', email: 'gone@ucla.edu', reason: 'UNSUBSCRIBED', source: 'LINK',
  detail: null, updatedAt: '2026-09-01T00:00:00Z', resubscribedAt: null,
};
const resubscribed = {
  id: 's2', email: 'back@ucla.edu', reason: 'BOUNCED', source: 'SES',
  detail: '550 mailbox not found', updatedAt: '2026-08-01T00:00:00Z', resubscribedAt: '2026-09-10T00:00:00Z',
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockResolvedValue({
    rows: [active, resubscribed], total: 2, activeByReason: { UNSUBSCRIBED: 1 },
  });
});

describe('the unsubscribe list', () => {
  it('shows who is held back and why', async () => {
    render(<SuppressionsPanel />);
    expect(await screen.findByText('gone@ucla.edu')).toBeInTheDocument();
    expect(screen.getByText('Unsubscribed: 1')).toBeInTheDocument();
    expect(screen.getByText('550 mailbox not found')).toBeInTheDocument();
  });

  it('adds an address with the note the admin typed', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ suppression: {} });
    const user = userEvent.setup();
    render(<SuppressionsPanel />);
    await user.type(screen.getByLabelText('Add an address'), 'new@ucla.edu');
    await user.type(screen.getByLabelText('Note (optional)'), 'asked by email');
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));

    expect(post).toHaveBeenCalledWith('/master-communications/suppressions', {
      email: 'new@ucla.edu', note: 'asked by email',
    });
    expect(await screen.findByText(/new@ucla.edu will no longer get marketing sends/)).toBeInTheDocument();
  });

  it('keeps the error on screen when adding fails', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('email is required'));
    const user = userEvent.setup();
    render(<SuppressionsPanel />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Add an address'), 'x@');
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));

    expect(await screen.findByText('email is required')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('puts a resubscribed person back on the list', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ suppression: {} });
    vi.spyOn(window, 'prompt').mockReturnValue('  ');
    const user = userEvent.setup();
    render(<SuppressionsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe again' }));

    // A blank note is sent as none, so the row keeps its earlier detail.
    expect(post).toHaveBeenCalledWith('/master-communications/suppressions', {
      email: 'back@ucla.edu', note: null,
    });
  });

  it('does nothing when the admin cancels unsubscribing again', async () => {
    const post = vi.spyOn(apiClient, 'post');
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const user = userEvent.setup();
    render(<SuppressionsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe again' }));
    expect(post).not.toHaveBeenCalled();
  });
});
