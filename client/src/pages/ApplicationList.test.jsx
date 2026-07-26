import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationList from './ApplicationList';

vi.mock('../hooks/useApplications', () => ({
  useApplications: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  default: {
    token: 'test-token',
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../utils/imageCache', () => ({
  default: {
    preloadImages: vi.fn(() => Promise.resolve([])),
    getCachedImage: vi.fn(),
  },
}));

vi.mock('../components/AuthenticatedImage', () => ({
  default: function MockAuthenticatedImage({ src, alt, onError, className, style, title }) {
    React.useEffect(() => {
      if (src === 'error' && onError) {
        onError();
      }
    }, [src, onError]);

    return React.createElement('img', {
      src,
      alt,
      title,
      'data-testid': 'authenticated-image',
      className,
      style,
    });
  },
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN' } }),
}));

vi.mock('../components/AddApplicationModal', () => ({
  default: () => null,
}));

vi.mock('../components/EditApplicationModal', () => ({
  default: () => null,
}));

import { useApplications } from '../hooks/useApplications';
import apiClient from '../utils/api';

function renderWithRouter(element) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

const baseApplicant = {
  id: 'app-1',
  firstName: 'Candidate',
  lastName: 'One',
  major1: 'Computer Science',
  graduationYear: '2027',
  cumulativeGpa: '3.85',
  status: 'SUBMITTED',
  headshotUrl: '/api/uploads/headshots/candidate.png',
  isReturningApplicant: false,
  pastApplicationCount: 0,
};

describe('ApplicationList review team avatars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApplications.mockReturnValue({
      applications: [],
      pagination: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    apiClient.get.mockResolvedValue([]);
  });

  it('renders member profile images when reviewTeam members have profileImage', () => {
    useApplications.mockReturnValue({
      applications: [
        {
          ...baseApplicant,
          reviewTeam: {
            id: 'team-1',
            name: 'Team Alpha',
            members: [
              { id: 'm1', fullName: 'Alice Anderson', profileImage: '/api/uploads/profile-images/alice.png' },
              { id: 'm2', fullName: 'Bob Baker', profileImage: '/api/uploads/profile-images/bob.png' },
            ],
          },
        },
      ],
      pagination: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<ApplicationList />);

    expect(screen.getByTitle('Alice Anderson')).toBeInTheDocument();
    expect(screen.getByTitle('Bob Baker')).toBeInTheDocument();
    const images = screen.getAllByTestId('authenticated-image');
    expect(images.length).toBeGreaterThanOrEqual(2);
  });

  it('renders initials fallback for members missing or with failed profileImage', async () => {
    useApplications.mockReturnValue({
      applications: [
        {
          ...baseApplicant,
          reviewTeam: {
            id: 'team-1',
            name: 'Team Alpha',
            members: [
              { id: 'm1', fullName: 'Alice Anderson', profileImage: '/api/uploads/profile-images/alice.png' },
              { id: 'm2', fullName: 'Bob Baker' },
              { id: 'm3', fullName: 'Charlie Chen', profileImage: 'error' },
            ],
          },
        },
      ],
      pagination: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<ApplicationList />);

    await waitFor(() => {
      expect(screen.getByText('BB')).toBeInTheDocument();
      expect(screen.getByText('CC')).toBeInTheDocument();
    });

    expect(screen.queryByText('AA')).not.toBeInTheDocument();
  });

  it('does not crash when reviewTeam or members are missing', () => {
    useApplications.mockReturnValue({
      applications: [
        { ...baseApplicant, reviewTeam: null },
        { ...baseApplicant, reviewTeam: { id: 'team-2', name: 'Team Beta', members: [] } },
      ],
      pagination: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<ApplicationList />);

    expect(screen.getAllByText('Candidate One').length).toBe(2);
    expect(screen.queryByText('Review team')).not.toBeInTheDocument();
  });

  it('preserves candidate avatar rendering alongside member avatars', () => {
    useApplications.mockReturnValue({
      applications: [
        {
          ...baseApplicant,
          reviewTeam: {
            id: 'team-1',
            name: 'Team Alpha',
            members: [{ id: 'm1', fullName: 'Alice Anderson', profileImage: '/api/uploads/profile-images/alice.png' }],
          },
        },
      ],
      pagination: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<ApplicationList />);

    const images = screen.getAllByTestId('authenticated-image');
    expect(images.length).toBe(2);
    expect(screen.getByText('Candidate One')).toBeInTheDocument();
    expect(screen.getByTitle('Alice Anderson')).toBeInTheDocument();
  });
});
