import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Candidates from './Candidates';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

const memberUser = { id: 'member-1', role: 'MEMBER' };
const adminUser = { id: 'admin-1', role: 'ADMIN' };

const testApplication = {
  id: 'app-1',
  candidateId: 'cand-1',
  name: 'Candidate One',
  email: 'one@example.com',
  major: 'Computer Science',
  year: '2027',
  gpa: '3.85',
  status: 'SUBMITTED',
  headshotUrl: '',
};

function setupApiMocks() {
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/all-applications') return Promise.resolve([testApplication]);
    if (url === '/member/events') return Promise.resolve([{ id: 'e1', eventName: 'Info Session' }]);
    if (url === `/applications/${testApplication.id}/events`) {
      return Promise.resolve({ events: [{ attendanceStatus: 'Attended', eventName: 'Info Session' }] });
    }
    if (url.startsWith('/review-teams/')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

async function renderCandidates(user) {
  useAuth.mockReturnValue({ user });
  setupApiMocks();
  const result = render(<Candidates />);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/member/all-applications'));
  return result;
}

describe('Candidates member applications view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads applications through member-authorized routes without admin requests', async () => {
    await renderCandidates(memberUser);

    await waitFor(() => {
      const calls = apiClient.get.mock.calls.map(([url]) => url);
      expect(calls).toContain('/member/all-applications');
      expect(calls).toContain('/member/events');
      expect(calls.some((url) => url.startsWith('/admin'))).toBe(false);
    });

    expect(screen.getByText('Candidate One')).toBeInTheDocument();
  });

  it('does not render View Details or an empty actions column for members', async () => {
    const { container } = await renderCandidates(memberUser);

    expect(screen.queryByRole('button', { name: /View Details|Hide Details/ })).not.toBeInTheDocument();

    const headerCells = container.querySelectorAll('thead th');
    expect(headerCells.length).toBe(5);

    const dataRows = container.querySelectorAll('tbody tr.applications-row');
    expect(dataRows.length).toBe(1);
    expect(dataRows[0].querySelectorAll('td').length).toBe(5);
  });

  it('keeps the adjacent table columns and data intact for members', async () => {
    const { container } = await renderCandidates(memberUser);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(`/applications/${testApplication.id}/events`);
    });

    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Applicant', 'Status', 'Major / Year / GPA', 'Attendance', 'Referrals']);

    expect(screen.getByText('Info Session')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });
});

describe('Candidates admin applications view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders View Details and expands the detail row with review-team data', async () => {
    const user = userEvent.setup();
    const { container } = await renderCandidates(adminUser);

    const button = await screen.findByRole('button', { name: 'View Details' });
    expect(button).toBeInTheDocument();

    await user.click(button);

    expect(screen.getByText('Resume')).toBeInTheDocument();
    expect(screen.getByText('Cover Letter')).toBeInTheDocument();
    expect(screen.getByText('Video')).toBeInTheDocument();

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(`/review-teams/resume-scores/${testApplication.candidateId}`);
      expect(apiClient.get).toHaveBeenCalledWith(`/review-teams/cover-letter-scores/${testApplication.candidateId}`);
      expect(apiClient.get).toHaveBeenCalledWith(`/review-teams/video-scores/${testApplication.candidateId}`);
    });

    const detailsRow = container.querySelector('tr.applications-details-row');
    expect(detailsRow).toBeInTheDocument();
    expect(detailsRow.querySelector('td').getAttribute('colspan')).toBe('6');
  });

  it('keeps the actions column in the table header for admins', async () => {
    const { container } = await renderCandidates(adminUser);
    const headerCells = container.querySelectorAll('thead th');
    expect(headerCells.length).toBe(6);
  });
});
