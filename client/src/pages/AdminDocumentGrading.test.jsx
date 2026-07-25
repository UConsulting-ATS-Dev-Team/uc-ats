import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminDocumentGrading from './AdminDocumentGrading';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'ADMIN', fullName: 'Test Admin' },
  }),
}));

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    setToken: vi.fn(),
    token: '',
  },
}));

const mockApplications = [
  {
    id: 'app-1',
    candidateId: 'cand-1',
    name: 'Alice Anderson',
    major: 'Computer Science',
    year: '2027',
    gpa: '3.85',
    status: 'SUBMITTED',
    email: 'alice@example.com',
    submittedAt: '2026-07-20T00:00:00Z',
    gender: 'Female',
    isFirstGeneration: false,
    isTransferStudent: false,
    resumeUrl: 'https://example.com/resume1.pdf',
    coverLetterUrl: 'https://example.com/cover1.pdf',
    videoUrl: 'https://example.com/video1.mp4',
    headshotUrl: null,
    groupId: 'group-a',
    groupName: 'Team A1B2',
    hasResumeScore: false,
    hasCoverLetterScore: false,
    hasVideoScore: false,
    resumeMissingGrades: 0,
    coverLetterMissingGrades: 0,
    videoMissingGrades: 0,
    resumeTotalMembers: 0,
    coverLetterTotalMembers: 0,
    videoTotalMembers: 0,
    groupMembers: [],
    resumeCompletedEvaluators: [],
    coverLetterCompletedEvaluators: [],
    videoCompletedEvaluators: [],
    resumeFlagged: null,
    coverLetterFlagged: null,
    videoFlagged: null,
  },
  {
    id: 'app-2',
    candidateId: 'cand-2',
    name: 'Ben Baker',
    major: 'Economics',
    year: '2026',
    gpa: '3.60',
    status: 'SUBMITTED',
    email: 'ben@example.com',
    submittedAt: '2026-07-21T00:00:00Z',
    gender: 'Male',
    isFirstGeneration: true,
    isTransferStudent: false,
    resumeUrl: 'https://example.com/resume2.pdf',
    coverLetterUrl: 'https://example.com/cover2.pdf',
    videoUrl: 'https://example.com/video2.mp4',
    headshotUrl: null,
    groupId: 'group-b',
    groupName: 'Team C3D4',
    hasResumeScore: true,
    hasCoverLetterScore: true,
    hasVideoScore: true,
    resumeMissingGrades: 0,
    coverLetterMissingGrades: 0,
    videoMissingGrades: 0,
    resumeTotalMembers: 0,
    coverLetterTotalMembers: 0,
    videoTotalMembers: 0,
    groupMembers: [],
    resumeCompletedEvaluators: [],
    coverLetterCompletedEvaluators: [],
    videoCompletedEvaluators: [],
    resumeFlagged: null,
    coverLetterFlagged: null,
    videoFlagged: null,
  },
  {
    id: 'app-3',
    candidateId: 'cand-3',
    name: 'Casey Chen',
    major: 'Mathematics',
    year: '2027',
    gpa: '3.90',
    status: 'SUBMITTED',
    email: 'casey@example.com',
    submittedAt: '2026-07-22T00:00:00Z',
    gender: 'Other',
    isFirstGeneration: false,
    isTransferStudent: true,
    resumeUrl: 'https://example.com/resume3.pdf',
    coverLetterUrl: null,
    videoUrl: null,
    headshotUrl: null,
    groupId: null,
    groupName: 'Unknown Team',
    hasResumeScore: false,
    hasCoverLetterScore: false,
    hasVideoScore: false,
    resumeMissingGrades: 0,
    coverLetterMissingGrades: 0,
    videoMissingGrades: 0,
    resumeTotalMembers: 0,
    coverLetterTotalMembers: 0,
    videoTotalMembers: 0,
    groupMembers: [],
    resumeCompletedEvaluators: [],
    coverLetterCompletedEvaluators: [],
    videoCompletedEvaluators: [],
    resumeFlagged: null,
    coverLetterFlagged: null,
    videoFlagged: null,
  },
];

function renderWithRouter(element) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

function getTeamSelectTrigger() {
  const label = screen.getByText('Team', { selector: 'label' });
  const formControl = label.closest('.MuiFormControl-root');
  return formControl.querySelector('.MuiSelect-select');
}

function selectTeamOption(name) {
  const trigger = getTeamSelectTrigger();
  fireEvent.mouseDown(trigger);
  const option = screen.getByRole('option', { name });
  fireEvent.click(option);
}

describe('AdminDocumentGrading team filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((endpoint) => {
      if (endpoint === '/admin/cycles/active') {
        return Promise.resolve(null);
      }
      if (endpoint === '/admin/applications') {
        return Promise.resolve(mockApplications);
      }
      if (endpoint.startsWith('/review-teams/member-applications/')) {
        return Promise.resolve(mockApplications);
      }
      return Promise.resolve([]);
    });
  });

  it('loads applications and renders the Team filter options', async () => {
    renderWithRouter(<AdminDocumentGrading />);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/admin/applications');
    });

    await waitFor(() => {
      expect(screen.getByText('All Teams')).toBeInTheDocument();
    });

    const trigger = getTeamSelectTrigger();
    fireEvent.mouseDown(trigger);

    expect(screen.getByRole('option', { name: 'All Teams' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Team A1B2' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Team C3D4' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unknown Team' })).toBeInTheDocument();
  });

  it('filters results by selected team and restoring All Teams shows all results', async () => {
    renderWithRouter(<AdminDocumentGrading />);

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(4);
    });

    selectTeamOption('Team A1B2');

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson')).toBeInTheDocument();
      expect(screen.queryByText('Ben Baker')).not.toBeInTheDocument();
      expect(screen.queryByText('Casey Chen')).not.toBeInTheDocument();
    });

    selectTeamOption('All Teams');

    await waitFor(() => {
      expect(screen.getByText('Ben Baker')).toBeInTheDocument();
      expect(screen.getByText('Casey Chen')).toBeInTheDocument();
    });
  });

  it('handles applications without a team as Unknown Team', async () => {
    renderWithRouter(<AdminDocumentGrading />);

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(4);
    });

    selectTeamOption('Unknown Team');

    await waitFor(() => {
      expect(screen.getByText('Casey Chen')).toBeInTheDocument();
      expect(screen.queryByText('Alice Anderson')).not.toBeInTheDocument();
      expect(screen.queryByText('Ben Baker')).not.toBeInTheDocument();
    });
  });

  it('renders the error state when the API fails', async () => {
    apiClient.get.mockImplementation((endpoint) => {
      if (endpoint === '/admin/cycles/active') {
        return Promise.resolve(null);
      }
      if (endpoint === '/admin/applications') {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve([]);
    });
    renderWithRouter(<AdminDocumentGrading />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load applications/i)).toBeInTheDocument();
    });
  });
});
