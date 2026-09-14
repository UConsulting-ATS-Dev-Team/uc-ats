import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AdminInterviews from './AdminInterviews';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => <>{children}</>,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'a1', role: 'ADMIN', fullName: 'Ryan K' } }),
}));

const overview = {
  cycle: { id: 'c1', name: 'Devin Test Cycle' },
  rounds: [],
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminInterviews />
    </MemoryRouter>
  );

describe('AdminInterviews signup link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue(overview);
    localStorage.setItem('uc-ats:interviews-mode', 'admin');
  });

  it('copies the candidate signup link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /copy signup link/i }));

    // One link for everybody: the page is behind the candidate login and works
    // out their round from their own application, so there is nothing
    // per-candidate to build.
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/interview-signup`);
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('falls back to a prompt when the clipboard is blocked', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /copy signup link/i }));

    // Clipboard access is refused outside a secure context, and silently doing
    // nothing on a scheduling page is worse than asking them to copy by hand.
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith('Copy this link:', `${window.location.origin}/interview-signup`)
    );
    prompt.mockRestore();
  });
});
