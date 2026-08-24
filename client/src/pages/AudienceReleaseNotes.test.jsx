import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MemberReleaseNotes from './MemberReleaseNotes';
import CandidateReleaseNotes from './CandidateReleaseNotes';

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

const memberUser = {
  id: 'member-1',
  email: 'member@example.com',
  fullName: 'Member User',
  role: 'MEMBER',
};

const candidateUser = {
  id: 'candidate-1',
  email: 'candidate@example.com',
  fullName: 'Candidate User',
  role: 'USER',
};

const note = {
  id: 'note-1',
  releaseDate: new Date().toISOString().split('T')[0],
  title: 'Audience release notes',
  summary: 'Summary',
  category: 'feature',
  affectedArea: 'Experience',
  status: 'new',
  links: [],
};

describe('MemberReleaseNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAuth.mockReturnValue({ user: memberUser });
  });

  it('fetches and renders member release notes', async () => {
    apiClient.get.mockResolvedValue([note]);
    render(<MemberReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Audience release notes')).toBeInTheDocument();
    });

    expect(apiClient.get).toHaveBeenCalledWith('/member/release-notes');
  });

  it('denies access to non-member users', async () => {
    apiClient.get.mockResolvedValue([note]);
    useAuth.mockReturnValue({ user: candidateUser });
    render(<MemberReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });
  });
});

describe('CandidateReleaseNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAuth.mockReturnValue({ user: candidateUser });
  });

  it('fetches and renders candidate release notes', async () => {
    apiClient.get.mockResolvedValue([note]);
    render(<CandidateReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Audience release notes')).toBeInTheDocument();
    });

    expect(apiClient.get).toHaveBeenCalledWith('/candidate/release-notes');
  });

  it('denies access to non-candidate users', async () => {
    apiClient.get.mockResolvedValue([note]);
    useAuth.mockReturnValue({ user: memberUser });
    render(<CandidateReleaseNotes />);

    await waitFor(() => {
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });
  });
});
