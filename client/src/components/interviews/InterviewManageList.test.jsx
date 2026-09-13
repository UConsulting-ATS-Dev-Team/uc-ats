import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import InterviewManageList from './InterviewManageList';
import apiClient from '../../utils/api';

// Replaces AdminAssignedInterviews.test.jsx. That page folded into the
// Interviews page and its create flow moved here; the coverage moves with it.

const cycle = { id: 'cycle-1', name: 'Test Cycle' };

const renderList = () =>
  render(
    <MemoryRouter>
      <InterviewManageList cycle={cycle} />
    </MemoryRouter>
  );

const roster = (slots = []) => ({ slots, unassigned: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/admin/interviews') return Promise.resolve([]);
    if (endpoint.includes('/roster')) return Promise.resolve(roster());
    return Promise.resolve([]);
  });
  apiClient.post = vi.fn().mockResolvedValue({});
  apiClient.patch = vi.fn().mockResolvedValue({});
  apiClient.delete = vi.fn().mockResolvedValue({});
});

describe('InterviewManageList', () => {
  it('says what to do when the cycle has no interviews', async () => {
    renderList();
    expect(await screen.findByText(/no interviews in this cycle yet/i)).toBeInTheDocument();
  });

  it('creates an interview and closes the dialog', async () => {
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: /new interview/i }));

    await userEvent.type(screen.getByLabelText(/^title/i), 'W27 Coffee Chats');
    fireChange(screen.getByLabelText(/^starts/i), '2027-01-10T09:00');
    fireChange(screen.getByLabelText(/^ends/i), '2027-01-10T11:00');
    await userEvent.type(screen.getByLabelText(/^location/i), 'Covel');

    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/admin/interviews',
        expect.objectContaining({ title: 'W27 Coffee Chats', location: 'Covel', cycleId: 'cycle-1' })
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^create$/i })).not.toBeInTheDocument();
    });
  });

  it('keeps the dialog open and surfaces the error when create fails', async () => {
    // The failure that matters: a dialog that closes on error looks like it
    // worked, and the admin only finds out when the interview is not there.
    apiClient.post = vi.fn().mockRejectedValue(new Error('Title already used (Status: 409)'));
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: /new interview/i }));

    await userEvent.type(screen.getByLabelText(/^title/i), 'Duplicate');
    fireChange(screen.getByLabelText(/^starts/i), '2027-01-10T09:00');
    fireChange(screen.getByLabelText(/^ends/i), '2027-01-10T11:00');
    await userEvent.type(screen.getByLabelText(/^location/i), 'Covel');
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/title already used/i)).toBeInTheDocument();
  });

  it('will not create without the fields the server requires', async () => {
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: /new interview/i }));
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDisabled();
  });

  it('shows counts per interview and blocks running one with no sessions', async () => {
    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/interviews') {
        return Promise.resolve([
          { id: 'iv1', title: 'Coffee Chats', interviewType: 'COFFEE_CHAT', cycleId: 'cycle-1', startDate: '2027-01-10T17:00:00Z', location: 'Covel' },
        ]);
      }
      if (endpoint.includes('/roster')) return Promise.resolve(roster());
      return Promise.resolve([]);
    });
    renderList();

    expect(await screen.findByText('Coffee Chats')).toBeInTheDocument();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run a session/i })).toBeDisabled();
  });
});

/** MUI date/time inputs ignore userEvent.type; set the value directly. */
function fireChange(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
