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

  it('surfaces a partial calendar failure even when the invite was sent', async () => {
    apiClient.post.mockResolvedValue({
      id: 'iv-2',
      title: 'Coffee Chat 2',
      interviewType: 'COFFEE_CHAT',
      startDate: '',
      endDate: '',
      location: '',
      dresscode: '',
      description: '{}',
      calendarSync: {
        status: 'SYNCED',
        calendarEventId: 'ucatsiv2',
        error: 'Calendar sync state could not be saved; reload to see the current status.'
      }
    });

    renderWithRouter(<AdminAssignedInterviews />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Interview' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Interview' }));
    const titleInput = screen.getByText('Title').nextElementSibling;
    fireEvent.change(titleInput, { target: { value: 'Coffee Chat 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
    });

    // The row must also carry the returned sync state, not just the nested calendarSync object.
    await waitFor(() => {
      expect(screen.getByText(/could not be saved/)).toBeInTheDocument();
    });
  });

  it('persists edited interview details and applies the returned calendar sync', async () => {
    const interview = {
      id: 'iv-3',
      title: 'Round One',
      interviewType: 'ROUND_ONE',
      startDate: '2026-02-14T17:00:00.000Z',
      endDate: '2026-02-14T19:30:00.000Z',
      location: 'Anderson 121',
      dresscode: 'Business',
      description: '{}',
      calendarSyncStatus: 'SYNCED'
    };
    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/interviews') return Promise.resolve([interview]);
      if (endpoint === '/admin/cycles/active') return Promise.resolve({ id: 'cycle-1', name: 'Test Cycle' });
      if (endpoint === '/admin/profile') return Promise.resolve({ id: 'admin-1', fullName: 'Test Admin', role: 'ADMIN' });
      return Promise.resolve([]);
    });
    apiClient.patch.mockResolvedValue({
      ...interview,
      location: 'Kerckhoff 200',
      calendarSync: { status: 'FAILED', calendarEventId: 'ucatsiv3', error: 'Google Calendar quota exceeded.' }
    });

    renderWithRouter(<AdminAssignedInterviews />);

    await waitFor(() => {
      expect(screen.getByTitle('Edit Interview')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle('Edit Interview'));

    const locationInput = screen.getByPlaceholderText('Location');
    fireEvent.change(locationInput, { target: { value: 'Kerckhoff 200' } });
    fireEvent.click(screen.getByTitle('Save Changes'));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/admin/interviews/iv-3', expect.objectContaining({
        location: 'Kerckhoff 200',
        startDate: interview.startDate,
        endDate: interview.endDate
      }));
    });

    await waitFor(() => {
      expect(screen.getByText('Kerckhoff 200')).toBeInTheDocument();
      expect(screen.getByText('Google Calendar quota exceeded.')).toBeInTheDocument();
    });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('quota exceeded'));
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
});
