import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InterviewEditDialog from './InterviewEditDialog';
import apiClient from '../../utils/api';

const interview = {
  id: 'iv1',
  title: 'W27 First Round',
  location: 'Anderson 1234',
  dresscode: 'Business',
  startDate: '2027-01-15T16:00:00Z',
  endDate: '2027-01-15T18:00:00Z',
};

const slot = (over = {}) => ({
  id: 'slot-1',
  label: null,
  startTime: '2027-01-15T17:00:00Z',
  endTime: '2027-01-15T18:00:00Z',
  candidateCapacity: 4,
  interviewerCapacity: 2,
  signups: [],
  interviewers: [],
  ...over,
});

const openDialog = (slots = [slot()]) => {
  apiClient.get = vi.fn().mockResolvedValue({ slots, unassigned: [] });
  return render(
    <InterviewEditDialog open interview={interview} onClose={vi.fn()} onSaved={vi.fn()} />
  );
};

function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
  apiClient.patch = vi.fn().mockResolvedValue({});
  apiClient.post = vi.fn().mockResolvedValue({});
  apiClient.delete = vi.fn().mockResolvedValue({});
});

describe('InterviewEditDialog', () => {
  it('loads the interview and its sessions', async () => {
    openDialog();
    expect(await screen.findByDisplayValue('W27 First Round')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Anderson 1234')).toBeInTheDocument();
    expect(await screen.findByText('Sessions (1)')).toBeInTheDocument();
  });

  it('saves changed details', async () => {
    openDialog();
    const title = await screen.findByDisplayValue('W27 First Round');
    await userEvent.clear(title);
    await userEvent.type(title, 'W27 First Round (moved)');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/admin/interviews/iv1',
        expect.objectContaining({ title: 'W27 First Round (moved)' })
      );
    });
  });

  it('changes the number of seats on a session', async () => {
    // The thing that was impossible before: more people advanced than expected,
    // so a session needs to be bigger.
    openDialog();
    const seats = await screen.findByLabelText(/^seats$/i);
    await userEvent.clear(seats);
    await userEvent.type(seats, '6');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/admin/interviews/slots/slot-1',
        expect.objectContaining({ candidateCapacity: 6 })
      );
    });
  });

  it('gives a session a location of its own', async () => {
    openDialog();
    await screen.findByText('Sessions (1)');
    // The details form has a Location too; the session's is the second.
    const location = screen.getAllByLabelText(/^location$/i)[1];
    expect(location).toHaveAttribute('placeholder', 'Anderson 1234');
    await userEvent.type(location, 'YRL 2');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/admin/interviews/slots/slot-1',
        expect.objectContaining({ location: 'YRL 2' })
      );
    });
  });

  it('leaves location out of a save that did not touch it', async () => {
    // The server refuses any location on a virtual coffee chat, so sending an
    // unchanged one would turn a seat change into an error.
    openDialog([slot({ location: 'Covel' })]);
    const seats = await screen.findByLabelText(/^seats$/i);
    await userEvent.clear(seats);
    await userEvent.type(seats, '6');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(apiClient.patch.mock.calls[0][1]).not.toHaveProperty('location');
  });

  it('loads session times in Pacific, whatever zone the browser is in', async () => {
    // 17:00Z on January 15 is 9 AM PST.
    openDialog();
    expect(await screen.findByLabelText(/^start$/i)).toHaveValue('09:00');
    expect(screen.getByLabelText(/^end$/i)).toHaveValue('10:00');
    expect(screen.getByLabelText(/^day$/i)).toHaveValue('2027-01-15');
  });

  it('saves session times as Pacific', async () => {
    openDialog();
    const seats = await screen.findByLabelText(/^seats$/i);
    await userEvent.clear(seats);
    await userEvent.type(seats, '6');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/admin/interviews/slots/slot-1',
        expect.objectContaining({ startTime: '2027-01-15T17:00:00.000Z', endTime: '2027-01-15T18:00:00.000Z' })
      );
    });
  });

  it('refuses a session with a blank time instead of keeping the old one quietly', async () => {
    openDialog();
    setValue(await screen.findByLabelText(/^start$/i), '');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/give the session a day, a start time and an end time/i)).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(screen.queryByText(/session saved/i)).not.toBeInTheDocument();
  });

  it('will not save a session until something changes', async () => {
    openDialog();
    expect(await screen.findByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('warns when seats are cut below the people already booked', async () => {
    // Nobody is thrown out - the session reads as over capacity instead, which
    // is the honest outcome and visible on the roster.
    openDialog([slot({ candidateCapacity: 4, signups: [
      { id: 's1', status: 'CONFIRMED' }, { id: 's2', status: 'CONFIRMED' }, { id: 's3', status: 'CONFIRMED' },
    ] })]);
    const seats = await screen.findByLabelText(/^seats$/i);
    await userEvent.clear(seats);
    await userEvent.type(seats, '2');

    expect(await screen.findByText(/fewer seats than the people already in it/i)).toBeInTheDocument();
  });

  it('says how many are booked before you delete a session', async () => {
    openDialog([slot({ signups: [{ id: 's1', status: 'CONFIRMED' }] })]);
    await screen.findByText('Sessions (1)');
    await userEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('svg[data-testid="DeleteOutlineIcon"]')));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/1 candidate is in this session/i));
    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/admin/interviews/slots/slot-1?force=true');
    });
  });

  it('adds a session', async () => {
    openDialog();
    await screen.findByText('Sessions (1)');
    await userEvent.click(screen.getByRole('button', { name: /add a session/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/iv1/slots', expect.any(Object));
    });
  });

  it('moves the whole day, keeping each session at its time', async () => {
    openDialog();
    await screen.findByText('Sessions (1)');
    setValue(screen.getByLabelText(/new day/i), '2027-02-01');
    await userEvent.click(screen.getByRole('button', { name: /move every session/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/iv1/reschedule', { day: '2027-02-01' });
    });
  });

  describe('telling the people in a session', () => {
    const booked = () =>
      slot({
        location: 'Anderson 1234',
        signups: [
          { id: 's1', status: 'CONFIRMED' },
          { id: 's2', status: 'CONFIRMED' },
          { id: 's3', status: 'WAITLISTED' },
        ],
        interviewers: [{ id: 'a1' }],
      });

    const changeRoom = async (room = 'YRL 2') => {
      await screen.findByText('Sessions (1)');
      const location = screen.getAllByLabelText(/^location$/i)[1];
      await userEvent.clear(location);
      await userEvent.type(location, room);
    };

    const sendButton = () => screen.queryByRole('button', { name: /send update/i });

    it('saves a room change without emailing anyone, then offers Send update', async () => {
      apiClient.patch = vi.fn().mockResolvedValue({ updatePendingSince: '2027-01-10T00:00:00Z' });
      openDialog([booked()]);
      await changeRoom();
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
      expect(apiClient.patch.mock.calls[0][1]).not.toHaveProperty('notify');
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(await screen.findByText(/nobody has been emailed/i)).toBeInTheDocument();
      expect(screen.getByText(/the 2 booked candidates and 1 interviewer have not been told yet/i)).toBeInTheDocument();
      expect(sendButton()).toBeEnabled();
    });

    it('sends the update when pressed, and the button goes away', async () => {
      apiClient.post = vi.fn().mockResolvedValue({ notified: { candidates: 2, interviewers: 1, emailsOn: true } });
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await userEvent.click(await screen.findByRole('button', { name: /send update/i }));

      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews/slots/slot-1/send-update', {});
      expect(await screen.findByText('Update sent to 2 candidates and 1 interviewer.')).toBeInTheDocument();
      expect(sendButton()).not.toBeInTheDocument();
    });

    it('keeps Send update when the session changed again while it sent', async () => {
      apiClient.post = vi.fn().mockResolvedValue({
        notified: { candidates: 2, interviewers: 1, failed: [], emailsOn: true },
        pending: true,
      });
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await userEvent.click(await screen.findByRole('button', { name: /send update/i }));

      expect(await screen.findByText(/changed again while it sent/i)).toBeInTheDocument();
      expect(sendButton()).toBeEnabled();
    });

    it('shows Send update for a change saved earlier, after reopening', async () => {
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      expect(await screen.findByRole('button', { name: /send update/i })).toBeEnabled();
    });

    it('offers nothing for a seat change', async () => {
      apiClient.patch = vi.fn().mockResolvedValue({ updatePendingSince: null });
      openDialog([booked()]);
      const seats = await screen.findByLabelText(/^seats$/i);
      await userEvent.clear(seats);
      await userEvent.type(seats, '6');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(await screen.findByText('Session saved.')).toBeInTheDocument();
      expect(sendButton()).not.toBeInTheDocument();
    });

    it('asks for unsaved edits to be saved before sending', async () => {
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await changeRoom('Kerckhoff 131');
      expect(sendButton()).toBeDisabled();
      expect(screen.getByText(/save your changes first/i)).toBeInTheDocument();
    });

    it('keeps the button when nothing could be sent', async () => {
      apiClient.post = vi.fn().mockResolvedValue({
        notified: { candidates: 0, interviewers: 0, failed: ['candidates', 'interviewers'], emailsOn: true },
        pending: true,
      });
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await userEvent.click(await screen.findByRole('button', { name: /send update/i }));

      expect(await screen.findByText(/could not be sent. try send update again/i)).toBeInTheDocument();
      expect(sendButton()).toBeEnabled();
    });

    it('says which half could not be emailed', async () => {
      apiClient.post = vi.fn().mockResolvedValue({
        notified: { candidates: 2, interviewers: 0, failed: ['interviewers'], emailsOn: true },
      });
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await userEvent.click(await screen.findByRole('button', { name: /send update/i }));

      expect(
        await screen.findByText('Emailing 2 candidates, but the interviewers could not be emailed. Tell them yourself.')
      ).toBeInTheDocument();
    });

    it('says so when scheduling emails are switched off', async () => {
      apiClient.post = vi.fn().mockResolvedValue({ notified: { candidates: 2, interviewers: 1, emailsOn: false } });
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await userEvent.click(await screen.findByRole('button', { name: /send update/i }));

      expect(await screen.findByText(/scheduling emails are switched off, so nobody was emailed/i)).toBeInTheDocument();
    });

    it('treats an update another admin already sent as done', async () => {
      apiClient.post = vi.fn().mockRejectedValue(Object.assign(new Error('sent'), { code: 'NO_PENDING_UPDATE' }));
      openDialog([{ ...booked(), updatePendingSince: '2027-01-10T00:00:00Z' }]);
      await userEvent.click(await screen.findByRole('button', { name: /send update/i }));

      expect(await screen.findByText(/had already been sent/i)).toBeInTheDocument();
      expect(sendButton()).not.toBeInTheDocument();
    });
  });

  it('drops a Send update another admin already used, when details are saved', async () => {
    const pending = slot({ updatePendingSince: '2027-01-10T00:00:00Z' });
    openDialog([pending]);
    expect(await screen.findByRole('button', { name: /send update/i })).toBeInTheDocument();

    apiClient.get = vi.fn().mockResolvedValue({ slots: [{ ...pending, updatePendingSince: null }], unassigned: [] });
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /send update/i })).not.toBeInTheDocument());
  });

  it('will not move the day over a session with unsaved edits', async () => {
    // The move reloads every session, which would throw the edits away.
    openDialog();
    const seats = await screen.findByLabelText(/^seats$/i);
    await userEvent.clear(seats);
    await userEvent.type(seats, '6');
    setValue(screen.getByLabelText(/new day/i), '2027-02-01');

    expect(screen.getByRole('button', { name: /move every session/i })).toBeDisabled();
    expect(screen.getByText(/save the session you changed first/i)).toBeInTheDocument();
  });

  it('will not offer to move a day that has no sessions', async () => {
    openDialog([]);
    await screen.findByText('Sessions (0)');
    expect(screen.getByRole('button', { name: /move every session/i })).toBeDisabled();
    expect(screen.getByText(/has no sessions/i)).toBeInTheDocument();
  });
});
