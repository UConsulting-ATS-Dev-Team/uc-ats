import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ResetPassword from './ResetPassword';

vi.mock('../components/UConsultingLogo', () => ({
  default: () => <div data-testid="logo">UConsulting Logo</div>,
}));

function renderWithToken(token = 'test-token') {
  return render(
    <MemoryRouter initialEntries={[`/reset-password?token=${token}`]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/404" element={<div>Not Found</div>} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ResetPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders new-password and confirm-new-password fields', () => {
    renderWithToken();
    expect(screen.getByLabelText(/^New Password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Confirm New Password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update password/i })).toBeInTheDocument();
  });

  it('redirects to 404 when no token is present', () => {
    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/404" element={<div>Not Found</div>} />
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('Not Found')).toBeInTheDocument();
  });

  it('does not submit when passwords do not match and shows an accessible inline error', async () => {
    renderWithToken();
    const newInput = screen.getByLabelText(/^New Password/i);
    const confirmInput = screen.getByLabelText(/^Confirm New Password/i);
    const form = screen.getByTestId('reset-password-form');

    fireEvent.change(newInput, { target: { value: 'password1' } });
    fireEvent.change(confirmInput, { target: { value: 'password2' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('Passwords do not match', { selector: 'p' })).toBeInTheDocument();
    });
    expect(confirmInput).toHaveAttribute('aria-invalid', 'true');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not submit when the confirmation password is empty', async () => {
    renderWithToken();
    const newInput = screen.getByLabelText(/^New Password/i);
    const form = screen.getByTestId('reset-password-form');

    fireEvent.change(newInput, { target: { value: 'password1' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('Both password fields are required', { selector: 'p' })).toBeInTheDocument();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not submit when the new password is empty', async () => {
    renderWithToken();
    const confirmInput = screen.getByLabelText(/^Confirm New Password/i);
    const form = screen.getByTestId('reset-password-form');

    fireEvent.change(confirmInput, { target: { value: 'password1' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('Both password fields are required', { selector: 'p' })).toBeInTheDocument();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits matching passwords and displays success', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'Password reset successful' }),
    });

    renderWithToken();
    const newInput = screen.getByLabelText(/^New Password/i);
    const confirmInput = screen.getByLabelText(/^Confirm New Password/i);
    const form = screen.getByTestId('reset-password-form');

    fireEvent.change(newInput, { target: { value: 'matchingPass123' } });
    fireEvent.change(confirmInput, { target: { value: 'matchingPass123' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/auth/reset-password', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'test-token', newPassword: 'matchingPass123' }),
      }));
    });

    await waitFor(() => {
      expect(screen.getByText('Password updated successfully!')).toBeInTheDocument();
    });
  });

  it('displays the server error message when the reset request fails', async () => {
    fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Invalid or expired token' }),
    });

    renderWithToken();
    const newInput = screen.getByLabelText(/^New Password/i);
    const confirmInput = screen.getByLabelText(/^Confirm New Password/i);
    const form = screen.getByTestId('reset-password-form');

    fireEvent.change(newInput, { target: { value: 'password1' } });
    fireEvent.change(confirmInput, { target: { value: 'password1' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('Invalid or expired token')).toBeInTheDocument();
    });
  });
});
