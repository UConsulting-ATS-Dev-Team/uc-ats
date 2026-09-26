import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CandidateGTKUC from './CandidateGTKUC';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), setToken: vi.fn() }
}));

vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }));

const cycle = { id: 'c1', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-12-01T00:00:00.000Z' };

// Slots as GET /meeting-slots answers them.
const slotA = {
  id: 'slot-1',
  memberName: 'Avery Chen',
  location: 'Kerckhoff Patio',
  startTime: '2026-10-28T16:30:00.000Z',
  endTime: '2026-10-28T17:00:00.000Z',
  remaining: 2
};
const slotB = {
  id: 'slot-2',
  memberName: 'Sam Patel',
  location: 'Bruin Cafe',
  startTime: '2026-11-05T18:00:00.000Z',
  endTime: '2026-11-05T18:30:00.000Z',
  remaining: 1
};

// A signup as GET /my-meeting-signups answers it (no slot id).
const signupIn = (slot, overrides = {}) => ({
  id: 'signup-1',
  memberName: slot.memberName,
  memberProfile: null,
  location: slot.location,
  startTime: slot.startTime,
  endTime: slot.endTime,
  canModify: true,
  modifyCutoffHours: 12,
  ...overrides
});

const mockGets = (mine) => {
  api.get.mockImplementation((url) => {
    if (url === '/active-cycle') return Promise.resolve({ cycle });
    if (url === '/my-meeting-signups') return Promise.resolve(typeof mine === 'function' ? mine() : mine);
    return Promise.resolve([slotA, slotB]);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { role: 'USER', email: 'jordan@ucla.edu' } });
});

describe('CandidateGTKUC one booking per cycle', () => {
  it('shows the slots when the candidate has no booking', async () => {
    mockGets([]);
    render(<CandidateGTKUC />);
    expect(await screen.findByText('Available Meeting Slots')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign Up' })).toHaveLength(2);
  });

  it('hides the slots behind the booked meeting', async () => {
    mockGets([signupIn(slotB)]);
    render(<CandidateGTKUC />);
    expect(await screen.findByText('Your meeting')).toBeInTheDocument();
    expect(screen.getByText('Sam Patel')).toBeInTheDocument();
    expect(screen.queryByText('Available Meeting Slots')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
  });

  it('moves the booking with PUT and returns to the booked view', async () => {
    let mine = [signupIn(slotB)];
    mockGets(() => mine);
    api.put.mockImplementation(async () => {
      mine = [signupIn(slotA)];
      return { success: true, message: 'Your meeting has been moved.' };
    });
    const user = userEvent.setup();
    render(<CandidateGTKUC />);

    await user.click(await screen.findByRole('button', { name: 'Change time' }));
    expect(screen.getByText('Pick a new time')).toBeInTheDocument();
    // Only the other slot is offered.
    const moveButtons = screen.getAllByRole('button', { name: 'Move to this time' });
    expect(moveButtons).toHaveLength(1);

    await user.click(moveButtons[0]);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/meeting-signups/signup-1', { slotId: 'slot-1' }));
    expect(api.delete).not.toHaveBeenCalled();
    expect(await screen.findByText('Your meeting has been moved.')).toBeInTheDocument();
    expect(screen.getByText('Your meeting')).toBeInTheDocument();
    expect(screen.getByText('Avery Chen')).toBeInTheDocument();
  });

  it('goes back to the booked view on "Keep my current time"', async () => {
    mockGets([signupIn(slotB)]);
    const user = userEvent.setup();
    render(<CandidateGTKUC />);
    await user.click(await screen.findByRole('button', { name: 'Change time' }));
    await user.click(screen.getByRole('button', { name: 'Keep my current time' }));
    expect(screen.getByText('Your meeting')).toBeInTheDocument();
  });

  it('cancels after confirmation and shows the slots again', async () => {
    let mine = [signupIn(slotB)];
    mockGets(() => mine);
    api.delete.mockImplementation(async () => {
      mine = [];
      return { success: true };
    });
    window.confirm = vi.fn(() => true);
    const user = userEvent.setup();
    render(<CandidateGTKUC />);

    await user.click(await screen.findByRole('button', { name: 'Cancel meeting' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/my-meeting-signups/signup-1'));
    expect(await screen.findByText('Available Meeting Slots')).toBeInTheDocument();
  });

  it('locks change and cancel inside the cutoff', async () => {
    mockGets([signupIn(slotB, { canModify: false })]);
    render(<CandidateGTKUC />);
    expect(await screen.findByText(/Changes close 12 hours before your meeting/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change time' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel meeting' })).toBeDisabled();
  });

  it('switches to the booked view when booking answers 409 ALREADY_BOOKED', async () => {
    let mine = [];
    mockGets(() => mine);
    api.post.mockImplementation(async () => {
      mine = [signupIn(slotB)];
      throw Object.assign(new Error('Already booked (Status: 409)'), {
        status: 409,
        code: 'ALREADY_BOOKED',
        serverMessage: 'You already have a meeting this cycle.'
      });
    });
    const user = userEvent.setup();
    render(<CandidateGTKUC />);

    await user.click((await screen.findAllByRole('button', { name: 'Sign Up' }))[0]);
    expect(await screen.findByText('Your meeting')).toBeInTheDocument();
    expect(screen.getByText('You already have a meeting this cycle.')).toBeInTheDocument();
  });
});
