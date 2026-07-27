import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CoffeeChatsPublic from './CoffeeChatsPublic';
import api from '../utils/api';

function getHostImg(container) {
  return container.querySelector('img[alt="Alex Host"]');
}

vi.mock('../components/UConsultingLogo', () => ({
  default: function MockUConsultingLogo() {
    return <div data-testid="uconsulting-logo">UConsulting</div>;
  }
}));

describe('CoffeeChatsPublic', () => {
  const activeCycle = {
    id: 'cycle-1',
    name: 'Winter 2026',
    startDate: '2026-01-05T00:00:00.000Z',
    endDate: '2026-01-20T00:00:00.000Z',
    isActive: true
  };

  const slot = {
    id: 'slot-1',
    memberName: 'Alex Host',
    memberProfileImage: '/api/uploads/profile-images/alex.png',
    location: 'Student Union',
    startTime: '2026-01-15T18:00:00.000Z',
    endTime: '2026-01-15T19:00:00.000Z',
    capacity: 2,
    taken: 0,
    remaining: 2
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.innerWidth = 1024;
    window.innerHeight = 768;
  });

  function mockResponses({ cycle = activeCycle, slots = [slot] } = {}) {
    vi.spyOn(api, 'get').mockImplementation((endpoint) => {
      if (endpoint === '/active-cycle') return Promise.resolve(cycle);
      if (endpoint === '/meeting-slots') return Promise.resolve(slots);
      return Promise.resolve([]);
    });
    vi.spyOn(api, 'post').mockResolvedValue({
      message: 'Successfully signed up! You will receive a confirmation email shortly.',
      needsAccount: true
    });
  }

  it('renders eligible meeting slots and shows the host headshot', async () => {
    mockResponses();
    const { container } = render(
      <MemoryRouter>
        <CoffeeChatsPublic />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alex Host')).toBeInTheDocument();
    });

    expect(screen.getByText('Student Union')).toBeInTheDocument();
    expect(getHostImg(container)).toBeInTheDocument();
    expect(screen.getByText('2 spots left')).toBeInTheDocument();
  });

  it('shows an explicit message when there is no active recruiting cycle', async () => {
    mockResponses({ cycle: null, slots: [] });
    const { container } = render(
      <MemoryRouter>
        <CoffeeChatsPublic />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No Active Recruiting Cycle')).toBeInTheDocument();
    });

    expect(screen.getByText('Meeting slots will appear when the next recruiting cycle opens.')).toBeInTheDocument();
    expect(getHostImg(container)).not.toBeInTheDocument();
  });

  it('shows an empty state when the active cycle has no available slots', async () => {
    mockResponses({ slots: [] });
    render(
      <MemoryRouter>
        <CoffeeChatsPublic />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No Meeting Slots Available')).toBeInTheDocument();
    });

    expect(screen.getByText('Check back later for new meeting opportunities.')).toBeInTheDocument();
  });

  it('falls back to initials when the host has no profile image', async () => {
    const noImageSlot = { ...slot, memberProfileImage: null };
    mockResponses({ slots: [noImageSlot] });
    const { container } = render(
      <MemoryRouter>
        <CoffeeChatsPublic />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alex Host')).toBeInTheDocument();
    });

    expect(screen.getByText('AH')).toBeInTheDocument();
    expect(getHostImg(container)).not.toBeInTheDocument();
  });

  it('falls back to initials when the host image fails to load', async () => {
    mockResponses();
    const { container } = render(
      <MemoryRouter>
        <CoffeeChatsPublic />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getHostImg(container)).toBeInTheDocument();
    });

    const img = getHostImg(container);
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.getByText('AH')).toBeInTheDocument();
      expect(getHostImg(container)).not.toBeInTheDocument();
    });
  });

  it('renders without errors in a mobile viewport', async () => {
    window.innerWidth = 375;
    window.innerHeight = 667;
    mockResponses();
    const { container } = render(
      <MemoryRouter>
        <CoffeeChatsPublic />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alex Host')).toBeInTheDocument();
    });

    expect(screen.getByText('Student Union')).toBeInTheDocument();
    expect(getHostImg(container)).toBeInTheDocument();
  });
});
