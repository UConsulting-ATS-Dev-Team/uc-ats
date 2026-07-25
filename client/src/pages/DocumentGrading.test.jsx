import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DocumentGrading from './DocumentGrading';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'member-1', role: 'MEMBER', fullName: 'Test Member' },
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
    cycleId: 'cycle-1',
    studentId: 12345,
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
    groupId: 'group-a',
    groupName: 'Team A1B2',
    hasResumeScore: false,
    hasCoverLetterScore: false,
    hasVideoScore: false,
  },
  {
    id: 'app-2',
    candidateId: 'cand-2',
    cycleId: 'cycle-1',
    studentId: 67890,
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
    groupId: 'group-b',
    groupName: 'Team C3D4',
    hasResumeScore: true,
    hasCoverLetterScore: false,
    hasVideoScore: false,
  },
  {
    id: 'app-3',
    candidateId: 'cand-3',
    cycleId: 'cycle-1',
    studentId: 11111,
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
    groupId: null,
    groupName: null,
    hasResumeScore: false,
    hasCoverLetterScore: false,
    hasVideoScore: false,
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

describe('DocumentGrading team filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue(mockApplications);
  });

  it('loads applications and renders the Team filter options', async () => {
    renderWithRouter(<DocumentGrading />);

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/review-teams/member-applications/member-1');
    });

    await waitFor(() => {
      expect(screen.getByText('All Teams')).toBeInTheDocument();
    });

    const trigger = getTeamSelectTrigger();
    fireEvent.mouseDown(trigger);

    expect(screen.getByRole('option', { name: 'All Teams' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Team A1B2' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Team C3D4' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Uncategorized' })).toBeInTheDocument();
  });

  it('filters results by selected team and restoring All Teams shows all results', async () => {
    renderWithRouter(<DocumentGrading />);

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(4);
    });

    selectTeamOption('Team A1B2');

    await waitFor(() => {
      expect(screen.getByText('Student 12345')).toBeInTheDocument();
      expect(screen.queryByText('Student 67890')).not.toBeInTheDocument();
      expect(screen.queryByText('Student 11111')).not.toBeInTheDocument();
    });

    selectTeamOption('All Teams');

    await waitFor(() => {
      expect(screen.getByText('Student 67890')).toBeInTheDocument();
      expect(screen.getByText('Student 11111')).toBeInTheDocument();
    });
  });

  it('handles applications without a team as Uncategorized', async () => {
    renderWithRouter(<DocumentGrading />);

    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(4);
    });

    selectTeamOption('Uncategorized');

    await waitFor(() => {
      expect(screen.getByText('Student 11111')).toBeInTheDocument();
      expect(screen.queryByText('Student 12345')).not.toBeInTheDocument();
      expect(screen.queryByText('Student 67890')).not.toBeInTheDocument();
    });
  });

  it('renders the error state when the API fails', async () => {
    apiClient.get.mockRejectedValue(new Error('Network error'));
    renderWithRouter(<DocumentGrading />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load applications/i)).toBeInTheDocument();
    });
  });
});
