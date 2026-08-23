import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CycleTimelineBootstrapDialog from './CycleTimelineBootstrapDialog';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

// Date/datetime inputs don't accept partial userEvent.type input; set them directly.
const fireChange = (input, value) => fireEvent.change(input, { target: { value } });

const template = {
  stages: [
    {
      key: 'applications_open',
      label: 'Applications open',
      type: 'milestone',
      required: true,
      generatesEvent: false,
      publicFacing: true,
    },
    {
      key: 'info_session',
      label: 'Info session',
      type: 'window',
      required: false,
      generatesEvent: true,
      needsForms: true,
      publicFacing: true,
    },
    {
      key: 'applications_close',
      label: 'Applications close',
      type: 'milestone',
      required: true,
      generatesEvent: false,
      publicFacing: true,
    },
  ],
};

const previewFor = (timeline) => ({
  name: 'Fall 2026',
  valid: true,
  validationErrors: [],
  stages: {},
  events: [
    {
      stageKey: 'info_session',
      eventName: 'Info Session',
      eventStartDate: '2026-09-06T01:00:00.000Z',
      eventEndDate: '2026-09-06T03:00:00.000Z',
      showToCandidates: true,
      needsForms: true,
    },
  ],
  pendingFormCount: 1,
  publishChangeSet: { cycleName: 'Fall 2026', entries: [{ stage: 'applications_open' }] },
  submittedTimeline: timeline,
});

describe('CycleTimelineBootstrapDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue(template);
  });

  const openDialog = async () => {
    render(<CycleTimelineBootstrapDialog open cycles={[]} onClose={vi.fn()} onCommitted={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Applications open date')).toBeInTheDocument());
  };

  it('uses time-bearing inputs for event windows and date-only for milestones', async () => {
    await openDialog();

    expect(screen.getByLabelText('Applications open date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Info session start')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Info session end')).toHaveAttribute('type', 'datetime-local');
  });

  it('carries a same-day window with distinct times through preview into commit', async () => {
    const onCommitted = vi.fn();
    render(<CycleTimelineBootstrapDialog open cycles={[]} onClose={vi.fn()} onCommitted={onCommitted} />);
    await waitFor(() => expect(screen.getByLabelText('Applications open date')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/Cycle name/), 'Fall 2026');
    fireChange(screen.getByLabelText('Applications open date'), '2026-09-01');
    fireChange(screen.getByLabelText('Info session start'), '2026-09-05T18:00');
    fireChange(screen.getByLabelText('Info session end'), '2026-09-05T20:00');
    fireChange(screen.getByLabelText('Applications close date'), '2026-09-20');

    const expectedTimeline = {
      applications_open: { start: '2026-09-01' },
      info_session: { start: '2026-09-05T18:00', end: '2026-09-05T20:00' },
      applications_close: { start: '2026-09-20' },
    };
    apiClient.post.mockResolvedValueOnce(previewFor(expectedTimeline));

    await userEvent.click(screen.getByRole('button', { name: 'Preview events' }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/cycles/bootstrap-preview', {
        name: 'Fall 2026',
        timeline: expectedTimeline,
      })
    );

    // Same-day window survives to the review step with its real times.
    expect(await screen.findByText('Info Session')).toBeInTheDocument();
    expect(screen.getByText('Sep 5, 2026, 6:00 PM')).toBeInTheDocument();
    expect(screen.getByText('Sep 5, 2026, 8:00 PM')).toBeInTheDocument();

    apiClient.post.mockResolvedValueOnce({ cycle: { id: 'cycle-1' }, events: [], pendingFormCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Create cycle & events' }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenLastCalledWith(
        '/admin/cycles/bootstrap-commit',
        expect.objectContaining({ name: 'Fall 2026', timeline: expectedTimeline, activate: false })
      )
    );
    expect(onCommitted).toHaveBeenCalled();
  });

  it('seeds cloned windows with their time of day and milestones with a date', async () => {
    render(
      <CycleTimelineBootstrapDialog
        open
        cycles={[{ id: 'old', name: 'Fall 2025', timelineSnapshot: { version: 1 } }]}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByLabelText('Applications open date')).toBeInTheDocument());

    apiClient.get.mockResolvedValueOnce({
      sourceCycle: { id: 'old', name: 'Fall 2025' },
      shiftYears: 1,
      stages: {
        applications_open: { start: '2026-09-01T09:00', end: null },
        info_session: { start: '2026-09-05T18:00', end: '2026-09-05T20:00' },
      },
    });

    await userEvent.click(screen.getByRole('combobox', { name: /Clone dates from a prior cycle/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Fall 2025' }));

    await waitFor(() => expect(screen.getByLabelText('Applications open date')).toHaveValue('2026-09-01'));
    expect(screen.getByLabelText('Info session start')).toHaveValue('2026-09-05T18:00');
    expect(screen.getByLabelText('Info session end')).toHaveValue('2026-09-05T20:00');
  });

  it('keeps the admin on the timeline step and marks the offending field on a validation error', async () => {
    await openDialog();

    apiClient.post.mockResolvedValueOnce({
      name: '',
      valid: false,
      validationErrors: [
        { stage: 'info_session', field: 'end', message: 'Info session must end after it starts' },
      ],
      events: [],
      pendingFormCount: 0,
      publishChangeSet: { entries: [] },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Preview events' }));

    expect(await screen.findByText('Info session must end after it starts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview events' })).toBeInTheDocument();
  });
});
