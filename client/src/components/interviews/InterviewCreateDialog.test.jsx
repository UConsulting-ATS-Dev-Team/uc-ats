import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterviewCreateDialog from './InterviewCreateDialog';
import apiClient from '../../utils/api';

// Replaces the create-flow tests from AdminAssignedInterviews.test.jsx. The
// dialog moved here and gained session planning, so the coverage moves with it.

const open = (props = {}) =>
  render(<InterviewCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} {...props} />);

/** MUI date/time inputs ignore userEvent.type; set the value directly. */
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const fillBasics = async () => {
  await userEvent.type(screen.getByLabelText(/^title/i), 'W27 Coffee Chats');
  setValue(screen.getByLabelText('Day'), '2027-01-15');
  await userEvent.type(screen.getByLabelText(/^location/i), 'Covel');
};

const chooseRound = async (label) => {
  await userEvent.click(screen.getByLabelText(/^round/i));
  await userEvent.click(await screen.findByRole('option', { name: label }));
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.post = vi.fn().mockResolvedValue({ id: 'iv1' });
});

describe('InterviewCreateDialog', () => {
  it('offers coffee chats two named sessions by default', () => {
    // The shape recruitment actually uses: a morning and an afternoon sitting
    // that candidates recognise by name.
    open();
    expect(screen.getByDisplayValue('Morning Session')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Afternoon Session')).toBeInTheDocument();
    expect(screen.getByText('2 sessions')).toBeInTheDocument();
  });

  it('switches to a day schedule when the round is first round', async () => {
    open();
    await chooseRound('First Round');

    // 08:00-17:00 hourly with a 12-13 lunch is eight sittings, not nine.
    expect(await screen.findByText('8 sessions')).toBeInTheDocument();
    expect(screen.getByText('32 candidate seats')).toBeInTheDocument();
    expect(screen.getByText('8:00 AM–9:00 AM')).toBeInTheDocument();
    // The break is skipped rather than scheduled through.
    expect(screen.queryByText('12:00 PM–1:00 PM')).not.toBeInTheDocument();
    expect(screen.getByText('1:00 PM–2:00 PM')).toBeInTheDocument();
  });

  it('previews the schedule before anything is created', async () => {
    open();
    await chooseRound('First Round');
    const before = screen.getByText('8 sessions');
    expect(before).toBeInTheDocument();

    // Shorten the day; the preview follows immediately.
    setValue(screen.getByLabelText(/day ends/i), '12:00');
    expect(await screen.findByText('4 sessions')).toBeInTheDocument();
  });

  it('adds and removes named sessions', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: /add a session/i }));
    expect(await screen.findByText('3 sessions')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /remove session 3/i }));
    expect(await screen.findByText('2 sessions')).toBeInTheDocument();
  });

  it('sends the interview and its sessions in one request', async () => {
    const onCreated = vi.fn();
    open({ onCreated });
    await fillBasics();

    await userEvent.click(screen.getByRole('button', { name: /create with 2 sessions/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/admin/interviews/with-sessions',
        expect.objectContaining({
          title: 'W27 Coffee Chats',
          interviewType: 'COFFEE_CHAT',
          location: 'Covel',
          day: '2027-01-15',
          sessions: expect.objectContaining({
            blocks: expect.arrayContaining([expect.objectContaining({ label: 'Morning Session' })]),
          }),
        })
      );
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it('will not create without the fields the server requires', async () => {
    open();
    expect(screen.getByRole('button', { name: /^create with/i })).toBeDisabled();
  });

  it('will not create a schedule that produces nothing', async () => {
    open();
    await chooseRound('First Round');
    await fillBasics();

    // Day ends before a single session could finish.
    setValue(screen.getByLabelText(/day starts/i), '09:00');
    setValue(screen.getByLabelText(/day ends/i), '09:30');

    expect(await screen.findByText('Nothing to create')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create with 0 sessions/i })).toBeDisabled();
  });

  it('keeps the dialog open and shows why when the server refuses', async () => {
    // A dialog that closes on error looks like it worked, and the admin only
    // finds out when the interview is not there.
    apiClient.post = vi.fn().mockRejectedValue(new Error('That schedule produces no sessions. (Status: 400)'));
    open();
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /create with 2 sessions/i }));

    expect(await screen.findByText(/produces no sessions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create with 2 sessions/i })).toBeInTheDocument();
  });
});
