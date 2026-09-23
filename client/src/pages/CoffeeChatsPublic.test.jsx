import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CoffeeChatsPublic from './CoffeeChatsPublic';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), setToken: vi.fn() }
}));

vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }));

const slot = {
  id: 'slot-1',
  location: 'Kerckhoff Patio',
  startTime: '2026-09-28T16:30:00.000Z',
  endTime: '2026-09-28T17:00:00.000Z',
  capacity: 2,
  remaining: 2,
  member: { fullName: 'Avery Chen' }
};

const cycle = { id: 'c1', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-12-01T00:00:00.000Z' };

const auth = (overrides = {}) => {
  const value = { user: null, login: vi.fn(), register: vi.fn(), ...overrides };
  useAuth.mockReturnValue(value);
  return value;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => Promise.resolve(url === '/active-cycle' ? { cycle } : [slot]));
  api.post.mockResolvedValue({ success: true, message: 'Successfully signed up!' });
});

const pickSlot = async (user) => {
  await user.click(await screen.findByText('Kerckhoff Patio'));
};

describe('booking a Get to Know UC slot', () => {
  it('no longer offers free-text name and email fields', async () => {
    auth();
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);
    await pickSlot(user);

    expect(screen.queryByLabelText(/Full Name/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Email Address/)).not.toBeInTheDocument();
    expect(screen.getByText(/log in or create an account to confirm/)).toBeInTheDocument();
  });

  it('sends a guest to log in instead of booking', async () => {
    auth();
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);
    await pickSlot(user);

    await user.click(screen.getByRole('button', { name: 'Log in & Confirm Signup' }));

    expect(await screen.findByText('Log in to confirm')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('finishes the booking once the guest logs in', async () => {
    const { login } = auth();
    login.mockImplementation(async () => {
      localStorage.setItem('token', 'fresh-token');
      return { success: true, user: { fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', studentId: '123456789' } };
    });
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);
    await pickSlot(user);
    await user.click(screen.getByRole('button', { name: 'Log in & Confirm Signup' }));

    await user.type(await screen.findByLabelText(/Email Address/), 'jordan@ucla.edu');
    await user.type(screen.getByLabelText(/Password/), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Log in & book' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/meeting-slots/slot-1/signup', {}));
    expect(login).toHaveBeenCalledWith('jordan@ucla.edu', 'hunter22');
    expect(api.setToken).toHaveBeenCalledWith('fresh-token');
  });

  it('asks an account with no student ID for one instead of booking blind', async () => {
    const { login } = auth();
    login.mockResolvedValue({ success: true, user: { fullName: 'Old Account', email: 'old@ucla.edu', studentId: null } });
    const user = userEvent.setup();
    const { rerender } = render(<CoffeeChatsPublic />);
    await pickSlot(user);
    await user.click(screen.getByRole('button', { name: 'Log in & Confirm Signup' }));
    await user.type(await screen.findByLabelText(/Email Address/), 'old@ucla.edu');
    await user.type(screen.getByLabelText(/Password/), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Log in & book' }));

    expect(await screen.findByText('Add your UCLA student ID to finish booking.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    // Signed in now: the form asks for the ID, and holds it to nine digits.
    auth({ user: { fullName: 'Old Account', email: 'old@ucla.edu', studentId: null } });
    rerender(<CoffeeChatsPublic />);
    await user.type(await screen.findByLabelText(/UCLA Student ID/), '123');
    await user.click(await screen.findByRole('button', { name: 'Confirm Signup' }));
    expect(await screen.findByText('Student ID must be exactly 9 digits.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/UCLA Student ID/), '456789');
    await user.click(screen.getByRole('button', { name: 'Confirm Signup' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/meeting-slots/slot-1/signup', { studentId: '123456789' })
    );
  });

  it('books straight away for a signed-in account, showing who is booking', async () => {
    auth({ user: { fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', studentId: '123456789' } });
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);
    await pickSlot(user);

    expect(screen.getByText('Jordan Rivera')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm Signup' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/meeting-slots/slot-1/signup', {}));
  });
});
