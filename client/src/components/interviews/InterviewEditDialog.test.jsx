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

  it('will not offer to move a day that has no sessions', async () => {
    openDialog([]);
    await screen.findByText('Sessions (0)');
    expect(screen.getByRole('button', { name: /move every session/i })).toBeDisabled();
    expect(screen.getByText(/has no sessions/i)).toBeInTheDocument();
  });
});
