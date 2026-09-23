import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CoffeeChatsPublic from './CoffeeChatsPublic';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), setToken: vi.fn() }
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

// GET responses by URL; `mine` is the signed-in user's signups.
const mockGets = ({ mine, slots = [slot] }) => {
  api.get.mockImplementation((url) => {
    if (url === '/active-cycle') return Promise.resolve({ cycle });
    if (url === '/meeting-signups/mine') return Promise.resolve(typeof mine === 'function' ? mine() : mine);
    return Promise.resolve(slots);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGets({ mine: [] });
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

const otherSlot = {
  id: 'slot-2',
  location: 'Bruin Cafe',
  startTime: '2026-10-05T18:00:00.000Z',
  endTime: '2026-10-05T18:30:00.000Z',
  capacity: 2,
  remaining: 1,
  member: { fullName: 'Sam Patel' }
};

const booking = (overrides = {}) => ({
  id: 'signup-1',
  slotId: 'slot-2',
  fullName: 'Jordan Rivera',
  email: 'jordan@ucla.edu',
  createdAt: '2026-09-20T00:00:00.000Z',
  slot: {
    id: 'slot-2',
    startTime: otherSlot.startTime,
    endTime: otherSlot.endTime,
    location: otherSlot.location,
    member: { fullName: 'Sam Patel', email: 'sam@ucla.edu' }
  },
  ...overrides
});

const signedIn = () => auth({ user: { fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', studentId: '123456789' } });

describe('one booking per cycle', () => {
  it('shows the booked meeting instead of the slot gallery', async () => {
    signedIn();
    mockGets({ mine: [booking()], slots: [slot, otherSlot] });
    render(<CoffeeChatsPublic />);

    expect(await screen.findByText('Your meeting')).toBeInTheDocument();
    expect(screen.getByText('Sam Patel')).toBeInTheDocument();
    expect(screen.queryByText('Available Meeting Slots')).not.toBeInTheDocument();
    expect(screen.queryByText('Kerckhoff Patio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change time' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel meeting' })).toBeEnabled();
  });

  it('still shows every slot to a logged-out visitor', async () => {
    auth();
    mockGets({ mine: [booking()], slots: [slot, otherSlot] });
    render(<CoffeeChatsPublic />);

    expect(await screen.findByText('Kerckhoff Patio')).toBeInTheDocument();
    expect(screen.getByText('Bruin Cafe')).toBeInTheDocument();
    expect(screen.queryByText('Your meeting')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/meeting-signups/mine');
  });

  it('moves the booking with PUT when the user changes the time', async () => {
    signedIn();
    let mine = [booking()];
    mockGets({ mine: () => mine, slots: [slot, otherSlot] });
    api.put.mockImplementation(async () => {
      mine = [booking({ slotId: 'slot-1', slot: { ...booking().slot, id: 'slot-1', startTime: slot.startTime, location: slot.location, member: { fullName: 'Avery Chen' } } })];
      return { success: true, message: 'Your meeting has been moved.' };
    });
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);

    await user.click(await screen.findByRole('button', { name: 'Change time' }));
    expect(screen.getByText('Pick a new time')).toBeInTheDocument();
    // The current slot is not offered as a new time.
    expect(screen.queryByRole('button', { name: /Select This Slot/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Select This Slot/ })).toHaveLength(1);

    await pickSlot(user);
    await user.click(screen.getByRole('button', { name: 'Confirm New Time' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/meeting-signups/signup-1', { slotId: 'slot-1' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText('Your meeting has been moved.')).toBeInTheDocument();
    expect(await screen.findByText('Avery Chen')).toBeInTheDocument();
    expect(screen.getByText('Your meeting')).toBeInTheDocument();
  });

  it('keeps the current time when the user backs out', async () => {
    signedIn();
    mockGets({ mine: [booking()], slots: [slot, otherSlot] });
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);

    await user.click(await screen.findByRole('button', { name: 'Change time' }));
    await user.click(screen.getByRole('button', { name: 'Keep my current time' }));

    expect(screen.getByText('Your meeting')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('shows the server error when the new slot filled up and keeps the booking', async () => {
    signedIn();
    mockGets({ mine: [booking()], slots: [slot, otherSlot] });
    api.put.mockRejectedValue(Object.assign(new Error('That slot is full. (Status: 409)'), { status: 409, serverMessage: 'That slot is full.' }));
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);

    await user.click(await screen.findByRole('button', { name: 'Change time' }));
    await pickSlot(user);
    await user.click(screen.getByRole('button', { name: 'Confirm New Time' }));

    expect(await screen.findByText('That slot is full.')).toBeInTheDocument();
  });

  it('cancels after confirmation and shows the slots again', async () => {
    signedIn();
    let mine = [booking()];
    mockGets({ mine: () => mine, slots: [slot, otherSlot] });
    api.delete.mockImplementation(async () => {
      mine = [];
      return { success: true };
    });
    window.confirm = vi.fn(() => true);
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);

    await user.click(await screen.findByRole('button', { name: 'Cancel meeting' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/meeting-signups/signup-1'));
    expect(await screen.findByText('Available Meeting Slots')).toBeInTheDocument();
    expect(screen.queryByText('Your meeting')).not.toBeInTheDocument();
  });

  it('does nothing when the user declines to cancel', async () => {
    signedIn();
    mockGets({ mine: [booking()], slots: [slot, otherSlot] });
    window.confirm = vi.fn(() => false);
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);

    await user.click(await screen.findByRole('button', { name: 'Cancel meeting' }));
    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.getByText('Your meeting')).toBeInTheDocument();
  });

  it('locks change and cancel inside the 12-hour cutoff', async () => {
    signedIn();
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    mockGets({ mine: [booking({ slot: { ...booking().slot, startTime: soon } })], slots: [slot, otherSlot] });
    render(<CoffeeChatsPublic />);

    expect(await screen.findByText(/Changes close 12 hours before your meeting/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change time' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel meeting' })).toBeDisabled();
  });

  it('switches to the booked view when booking answers 409 ALREADY_BOOKED', async () => {
    signedIn();
    let mine = [];
    mockGets({ mine: () => mine, slots: [slot, otherSlot] });
    api.post.mockImplementation(async () => {
      mine = [booking()];
      throw Object.assign(new Error('You already have a meeting this cycle. (Status: 409)'), {
        status: 409,
        code: 'ALREADY_BOOKED',
        serverMessage: 'You already have a meeting this cycle.'
      });
    });
    const user = userEvent.setup();
    render(<CoffeeChatsPublic />);

    await pickSlot(user);
    await user.click(screen.getByRole('button', { name: 'Confirm Signup' }));

    expect(await screen.findByText('Your meeting')).toBeInTheDocument();
    expect(screen.getByText('You already have a meeting this cycle.')).toBeInTheDocument();
    expect(screen.queryByText('Available Meeting Slots')).not.toBeInTheDocument();
  });
});
