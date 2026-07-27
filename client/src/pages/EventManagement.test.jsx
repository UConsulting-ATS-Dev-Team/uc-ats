import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import EventManagement from './EventManagement';
import apiClient from '../utils/api';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { useAuth } from '../context/AuthContext';

describe('EventManagement cycle-portable copy', () => {
  const adminUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    fullName: 'Admin User',
    role: 'ADMIN',
  };

  const memberUser = {
    id: 'member-1',
    email: 'member@example.com',
    fullName: 'Member User',
    role: 'MEMBER',
  };

  const cycles = [
    { id: 'cycle-source', name: 'Fall 2025', isActive: false },
    { id: 'cycle-target', name: 'Fall 2026', isActive: true },
  ];

  let user;

  beforeEach(() => {
    user = userEvent.setup();
    vi.clearAllMocks();
    useAuth.mockReturnValue({ user: adminUser });
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/events') return Promise.resolve([]);
      if (url === '/admin/cycles') return Promise.resolve(cycles);
      return Promise.resolve([]);
    });
    apiClient.post.mockResolvedValue({});
  });

  it('renders the Copy from Cycle button for admins', async () => {
    render(
      <MemoryRouter>
        <EventManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Copy from Cycle')).toBeInTheDocument();
    });
  });

  it('does not render the Copy from Cycle button for members', async () => {
    useAuth.mockReturnValue({ user: memberUser });

    render(
      <MemoryRouter>
        <EventManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByText('Copy from Cycle')).not.toBeInTheDocument();
    });
  });

  it('opens the copy dialog and shows cycle selectors', async () => {
    render(
      <MemoryRouter>
        <EventManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Copy from Cycle')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Copy from Cycle'));

    expect(screen.getByText('Copy Events from Another Cycle')).toBeInTheDocument();
    expect(screen.getByText(/Copy event records only/)).toBeInTheDocument();
    expect(screen.getByLabelText('Source Cycle')).toBeInTheDocument();
    expect(screen.getByLabelText('Target Cycle')).toBeInTheDocument();
  });

  it('requests a preview when cycles are selected', async () => {
    const preview = {
      sourceCycle: { id: 'cycle-source', name: 'Fall 2025' },
      targetCycle: { id: 'cycle-target', name: 'Fall 2026' },
      events: [
        {
          sourceEventId: 'event-1',
          eventName: 'Info Session',
          eventStartDate: '2025-09-01T18:00:00.000Z',
          eventEndDate: '2025-09-01T20:00:00.000Z',
          eventLocation: 'Room A',
          showToCandidates: true,
          rsvpForm: 'https://forms.gle/old-rsvp',
          attendanceForm: '',
          memberRsvpUrl: '',
          alreadyExists: false,
        },
      ],
    };

    apiClient.post.mockImplementation((url) => {
      if (url === '/admin/events/copy-preview') return Promise.resolve(preview);
      return Promise.resolve({});
    });

    render(
      <MemoryRouter>
        <EventManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Copy from Cycle')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Copy from Cycle'));

    await user.selectOptions(screen.getByLabelText('Source Cycle'), 'cycle-source');
    await user.selectOptions(screen.getByLabelText('Target Cycle'), 'cycle-target');

    fireEvent.click(screen.getByText('Preview Events'));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/events/copy-preview', {
        sourceCycleId: 'cycle-source',
        targetCycleId: 'cycle-target',
      });
    });

    expect(screen.getByDisplayValue('Info Session')).toBeInTheDocument();
    expect(screen.getByLabelText(/Start date for Info Session/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Location for Info Session/)).toBeInTheDocument();
  });
});
