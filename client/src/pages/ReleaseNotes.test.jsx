import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReleaseNotes from './ReleaseNotes';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

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

function isoToday(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

const notes = [
  {
    id: 'note-recent',
    releaseDate: isoToday(),
    title: 'Admin release notes page',
    summary: 'Summary two',
    details: 'Detailed two',
    category: 'feature',
    affectedArea: 'Admin experience',
    status: 'new',
    links: [{ label: 'Issue #114', url: 'https://github.com/UConsulting-ATS-Dev-Team/uc-ats/issues/114' }],
  },
  {
    id: 'note-old',
    releaseDate: isoToday(-30),
    title: 'Older note',
    summary: 'Summary one',
    details: 'Detailed one',
    category: 'fix',
    affectedArea: 'Grading',
    status: 'resolved',
    links: [],
  },
];

describe('ReleaseNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAuth.mockReturnValue({ user: adminUser });
  });

  it('renders a loading state', () => {
    apiClient.get.mockImplementation(() => new Promise(() => {}));
    render(<ReleaseNotes />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading release notes/i);
  });

  it('renders release notes in reverse chronological order', async () => {
    apiClient.get.mockResolvedValue(notes);
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Admin release notes page')).toBeInTheDocument();
    });

    const titles = screen.getAllByRole('heading', { level: 2 });
    expect(titles[0]).toHaveTextContent('Admin release notes page');
    expect(titles[1]).toHaveTextContent('Older note');
  });

  it('renders category, status, affected area, and links', async () => {
    apiClient.get.mockResolvedValue(notes);
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Feature')).toBeInTheDocument();
    });

    expect(screen.getByText('Fix')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: New')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: Resolved')).toBeInTheDocument();
    expect(screen.getByText(/Admin experience/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /Show details/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Issue #114')).toBeInTheDocument();
    });
  });

  it('shows an empty state when no release notes exist', async () => {
    apiClient.get.mockResolvedValue([]);
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('No release notes yet')).toBeInTheDocument();
    });
  });

  it('shows an error state when the API fails', async () => {
    apiClient.get.mockRejectedValue(new Error('Network error'));
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Network error/i);
    });
  });

  it('expands details when Show details is clicked', async () => {
    apiClient.get.mockResolvedValue(notes);
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Admin release notes page')).toBeInTheDocument();
    });

    const toggle = screen.getAllByRole('button', { name: /Show details/i })[0];
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText('Detailed two')).toBeInTheDocument();
    });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a New badge for recent unread notes and lets the user mark as read', async () => {
    apiClient.get.mockResolvedValue(notes);
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByLabelText('New release')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Mark .* as read/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText('New release')).not.toBeInTheDocument();
    });
  });

  it('marks all notes as read', async () => {
    apiClient.get.mockResolvedValue(notes);
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Admin release notes page')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Mark all read/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText('New release')).not.toBeInTheDocument();
    });
  });

  it('denies access to non-admin users', async () => {
    apiClient.get.mockResolvedValue(notes);
    useAuth.mockReturnValue({ user: memberUser });
    render(<ReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });
  });
});
