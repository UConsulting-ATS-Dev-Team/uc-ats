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
    expect(screen.queryByText(/session updated/i)).not.toBeInTheDocument();
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

    it('offers, ticked, to email them when the room changes, and sends notify', async () => {
      apiClient.patch = vi.fn().mockResolvedValue({ notified: { candidates: 2, interviewers: 1, emailsOn: true } });
      openDialog([booked()]);
      await changeRoom();

      const box = screen.getByRole('checkbox', { name: /email the 2 booked candidates and 1 interviewer/i });
      expect(box).toBeChecked();
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          '/admin/interviews/slots/slot-1',
          expect.objectContaining({ location: 'YRL 2', notify: true })
        );
      });
      expect(await screen.findByText(/emailing 2 candidates and 1 interviewer/i)).toBeInTheDocument();
    });

    it('sends no notify when the box is unticked', async () => {
      openDialog([booked()]);
      await changeRoom();
      await userEvent.click(screen.getByRole('checkbox', { name: /email the/i }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
      expect(apiClient.patch.mock.calls[0][1]).not.toHaveProperty('notify');
    });

    it('does not offer it for a seat change', async () => {
      openDialog([booked()]);
      const seats = await screen.findByLabelText(/^seats$/i);
      await userEvent.clear(seats);
      await userEvent.type(seats, '6');

      expect(screen.queryByRole('checkbox', { name: /email the/i })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
      expect(apiClient.patch.mock.calls[0][1]).not.toHaveProperty('notify');
    });

    it('still offers it for a session that was empty when the dialog opened', async () => {
      // Somebody may have booked since; the server reads who is in it on save.
      apiClient.patch = vi.fn().mockResolvedValue({ notified: { candidates: 1, interviewers: 0, emailsOn: true } });
      openDialog([slot({ location: 'Anderson 1234' })]);
      await changeRoom();

      expect(screen.getByRole('checkbox', { name: /email anyone booked into this session/i })).toBeChecked();
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          '/admin/interviews/slots/slot-1',
          expect.objectContaining({ notify: true })
        );
      });
      expect(await screen.findByText(/emailing 1 candidate\./i)).toBeInTheDocument();
    });

    it('says which half could not be emailed', async () => {
      apiClient.patch = vi.fn().mockResolvedValue({
        notified: { candidates: 2, interviewers: 0, failed: ['interviewers'], emailsOn: true },
      });
      openDialog([booked()]);
      await changeRoom();
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(
        await screen.findByText('Session updated. Emailing 2 candidates, but the interviewers could not be emailed. Tell them yourself.')
      ).toBeInTheDocument();
    });

    it('offers it for a new time too', async () => {
      openDialog([booked()]);
      setValue(await screen.findByLabelText(/^start$/i), '08:30');
      expect(await screen.findByRole('checkbox', { name: /email the/i })).toBeChecked();
    });

    it('says so when scheduling emails are switched off', async () => {
      apiClient.patch = vi.fn().mockResolvedValue({ notified: { candidates: 2, interviewers: 1, emailsOn: false } });
      openDialog([booked()]);
      await changeRoom();
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(await screen.findByText(/scheduling emails are switched off, so nobody was emailed/i)).toBeInTheDocument();
    });
  });

  it('will not offer to move a day that has no sessions', async () => {
    openDialog([]);
    await screen.findByText('Sessions (0)');
    expect(screen.getByRole('button', { name: /move every session/i })).toBeDisabled();
    expect(screen.getByText(/has no sessions/i)).toBeInTheDocument();
  });
});
