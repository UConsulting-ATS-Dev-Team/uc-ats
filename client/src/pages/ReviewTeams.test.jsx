import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ReviewTeams from './ReviewTeams';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }) => children,
  closestCenter: () => null,
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: (...sensors) => sensors,
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }) => children,
  useSortable: () => ({
    setNodeRef: () => {},
    attributes: {},
    listeners: {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
  arrayMove: (arr) => arr,
  sortableKeyboardCoordinates: () => null,
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}));

function renderWithRouter(element) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

const adminUser = { id: 'admin-1', role: 'ADMIN' };
const memberUser = { id: 'member-1', role: 'MEMBER' };

const mockTeams = [
  {
    id: 'team-1',
    name: 'Team Alpha',
    members: [{ id: 'member-1', name: 'Alice Smith', email: 'alice@example.com' }],
    applications: [],
  },
];

const mockContributions = [
  {
    groupId: 'team-1',
    members: [
      {
        id: 'member-1',
        completed: { resume: 0, coverLetter: 0, video: 0 },
        eligible: { resume: 1, coverLetter: 1, video: 1 },
        completedTotal: 0,
        expectedTotal: 3,
        completionPercent: 0,
      },
    ],
  },
];

function mockApiClient(getOverrides = {}) {
  apiClient.token = 'test-token';
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/review-teams') return Promise.resolve(mockTeams);
    if (endpoint === '/review-teams/available-applications') return Promise.resolve([]);
    if (endpoint === '/review-teams/users') return Promise.resolve([]);
    if (endpoint === '/review-teams/contributions') return Promise.resolve(mockContributions);
    return Promise.resolve(getOverrides[endpoint] ?? []);
  });
  apiClient.post = vi.fn();
  apiClient.put = vi.fn();
  apiClient.delete = vi.fn();
}

describe('ReviewTeams reminder button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({ user: adminUser });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the Send reminder button for admins and hides it for members', async () => {
    mockApiClient();

    renderWithRouter(<ReviewTeams />);

    await waitFor(() => {
      expect(screen.getByText('Team Alpha')).toBeInTheDocument();
    });

    // Expand the team to reveal member cards
    const expandButton = screen.getByRole('button', { name: /expand team/i });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
    });

    cleanup();

    // Switch to member role and re-render
    useAuth.mockReturnValue({ user: memberUser });
    renderWithRouter(<ReviewTeams />);

    await waitFor(() => {
      expect(screen.getByText('Team Alpha')).toBeInTheDocument();
    });

    const memberExpandButton = screen.getByRole('button', { name: /expand team/i });
    fireEvent.click(memberExpandButton);

    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Send reminder' })).not.toBeInTheDocument();
  });

  it('sends a reminder and shows success feedback', async () => {
    mockApiClient();
    apiClient.post.mockResolvedValue({ message: 'Reminder sent successfully' });

    renderWithRouter(<ReviewTeams />);

    await waitFor(() => {
      expect(screen.getByText('Team Alpha')).toBeInTheDocument();
    });

    const expandButton = screen.getByRole('button', { name: /expand team/i });
    fireEvent.click(expandButton);

    const reminderButton = await screen.findByRole('button', { name: 'Send reminder' });
    fireEvent.click(reminderButton);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/review-teams/team-1/reviewers/member-1/reminder');
    });

    await waitFor(() => {
      expect(screen.getByText('Reminder sent')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Send reminder' })).not.toBeDisabled();
  });

  it('disables the button while the reminder request is pending and prevents duplicate clicks', async () => {
    mockApiClient();
    let resolvePost;
    apiClient.post.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));

    renderWithRouter(<ReviewTeams />);

    await waitFor(() => {
      expect(screen.getByText('Team Alpha')).toBeInTheDocument();
    });

    const expandButton = screen.getByRole('button', { name: /expand team/i });
    fireEvent.click(expandButton);

    const reminderButton = await screen.findByRole('button', { name: 'Send reminder' });
    fireEvent.click(reminderButton);

    await waitFor(() => {
      expect(reminderButton).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Sending...' })).toBeInTheDocument();
    });

    fireEvent.click(reminderButton);

    expect(apiClient.post).toHaveBeenCalledTimes(1);

    resolvePost({ message: 'Reminder sent successfully' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send reminder' })).not.toBeDisabled();
    });
  });

  it('shows actionable error feedback when the reminder request fails and allows retry', async () => {
    mockApiClient();
    apiClient.post.mockRejectedValue(new Error('Mail provider error'));

    renderWithRouter(<ReviewTeams />);

    await waitFor(() => {
      expect(screen.getByText('Team Alpha')).toBeInTheDocument();
    });

    const expandButton = screen.getByRole('button', { name: /expand team/i });
    fireEvent.click(expandButton);

    const reminderButton = await screen.findByRole('button', { name: 'Send reminder' });
    fireEvent.click(reminderButton);

    await waitFor(() => {
      expect(screen.getByText(/Mail provider error/i)).toBeInTheDocument();
    });

    expect(reminderButton).not.toBeDisabled();

    apiClient.post.mockResolvedValue({ message: 'Reminder sent successfully' });
    fireEvent.click(reminderButton);

    await waitFor(() => {
      expect(screen.getByText('Reminder sent')).toBeInTheDocument();
    });
  });
});
