import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminAssignedInterviews from './AdminAssignedInterviews';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children
}));

vi.mock('../components/AuthenticatedImage', () => ({
  default: () => null
}));

vi.mock('../components/DocumentPreviewModal', () => ({
  default: () => null
}));

function renderWithRouter(element) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe('AdminAssignedInterviews create flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    apiClient.token = 'test-token';

    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/interviews') return Promise.resolve([]);
      if (endpoint === '/admin/users?role=INTERVIEWER') return Promise.resolve([]);
      if (endpoint === '/admin/users?role=ADMIN') return Promise.resolve([]);
      if (endpoint === '/admin/applications') return Promise.resolve([]);
      if (endpoint === '/admin/cycles/active') return Promise.resolve({ id: 'cycle-1', name: 'Test Cycle' });
      if (endpoint === '/admin/profile') return Promise.resolve({ id: 'admin-1', fullName: 'Test Admin', role: 'ADMIN' });
      return Promise.resolve([]);
    });

    apiClient.post = vi.fn();
    apiClient.put = vi.fn();
    apiClient.patch = vi.fn();
    apiClient.delete = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an interview and closes the modal on success', async () => {
    const created = {
      id: 'iv-1',
      title: 'Coffee Chat 1',
      interviewType: 'COFFEE_CHAT',
      startDate: '',
      endDate: '',
      location: '',
      dresscode: '',
      description: '{}'
    };
    apiClient.post.mockResolvedValue(created);

    renderWithRouter(<AdminAssignedInterviews />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Interview' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Interview' }));

    const titleLabel = screen.getByText('Title');
    const titleInput = titleLabel.nextElementSibling;
    expect(titleInput).toBeTruthy();
    fireEvent.change(titleInput, { target: { value: 'Coffee Chat 1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interviews', expect.objectContaining({
        title: 'Coffee Chat 1',
        cycleId: 'cycle-1'
      }));
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
      expect(screen.queryByText('Creating...')).not.toBeInTheDocument();
      expect(screen.getByText('Coffee Chat 1')).toBeInTheDocument();
    });

    expect(alert).not.toHaveBeenCalled();
  });

  it('exits the loading state when create fails', async () => {
    apiClient.post.mockRejectedValue(new Error('Server error'));

    renderWithRouter(<AdminAssignedInterviews />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Interview' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Interview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const createButton = screen.getByRole('button', { name: 'Create' });
      expect(createButton).not.toBeDisabled();
      expect(screen.queryByText('Creating...')).not.toBeInTheDocument();
    });

    expect(alert).toHaveBeenCalled();
  });

  it('uses the authoritative committed config and preserves unrelated interview config', async () => {
    const interview = {
      id: 'iv-1',
      title: 'Coffee Chat',
      interviewType: 'COFFEE_CHAT',
      startDate: new Date().toISOString(),
      endDate: new Date().toISOString(),
      location: 'Zoom',
      dresscode: 'Casual',
      description: JSON.stringify({
        memberGroups: [{ id: 'keep', name: 'Keep Group' }],
        applicationGroups: [],
        groupAssignments: { g1: ['a1'] },
      }),
    };

    apiClient.get.mockImplementation((endpoint) => {
      if (endpoint === '/admin/interviews') return Promise.resolve([interview]);
      if (endpoint === '/admin/cycles/active') return Promise.resolve({ id: 'cycle-1', name: 'Test Cycle' });
      if (endpoint === '/admin/profile') return Promise.resolve({ id: 'admin-1', fullName: 'Test Admin', role: 'ADMIN' });
      if (endpoint === '/review-teams') return Promise.resolve([{ id: 'group-1', name: 'Team Alpha', applications: [{ id: 'app-1' }, { id: 'app-2' }] }]);
      if (endpoint === '/admin/applications') return Promise.resolve([]);
      if (endpoint.startsWith('/admin/users')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const preview = {
      additionCount: 2,
      duplicateCount: 0,
      skippedCount: 0,
      additions: [
        { applicationId: 'app-1', name: 'Alice Anderson', email: 'alice@example.com' },
        { applicationId: 'app-2', name: 'Bob Baker', email: 'bob@example.com' },
      ],
      duplicates: [],
      skipped: [],
      destinationGroup: { id: 'new-group', name: 'Team Alpha', existingApplicationCount: 0, isNew: true },
    };

    const committedConfig = {
      memberGroups: [{ id: 'keep', name: 'Keep Group' }],
      applicationGroups: [{
        id: 'new-group',
        name: 'Team Alpha',
        applicationIds: ['app-1', 'app-2'],
        copiedFromGroupId: 'group-1',
        copiedByUserId: 'admin-1',
        copiedAt: new Date().toISOString(),
      }],
      groupAssignments: { g1: ['a1'] },
    };

    const commitResult = {
      interview: { id: 'iv-1', title: 'Coffee Chat', cycleId: 'cycle-1' },
      destinationGroup: { id: 'new-group', name: 'Team Alpha', applicationIds: ['app-1', 'app-2'] },
      additionCount: 2,
      duplicateCount: 0,
      skippedCount: 0,
      config: committedConfig,
    };

    apiClient.post
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(commitResult);

    renderWithRouter(<AdminAssignedInterviews />);

    await waitFor(() => {
      expect(screen.getByText('Coffee Chat')).toBeInTheDocument();
    });

    // Expand the interview card to reveal the Copy button.
    fireEvent.click(screen.getByTitle('Expand'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(screen.getByText('Copy Candidate Group')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Source Candidate Group'), { target: { value: 'group-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(screen.getByText('2 addition(s)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy Candidates' }));

    await waitFor(() => {
      expect(apiClient.patch).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith('Copied 2 candidate(s) into Team Alpha');
    });

    // Unrelated member group and the newly copied application group are both rendered.
    expect(screen.getByDisplayValue('Keep Group')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Team Alpha')).toBeInTheDocument();
  });
});
