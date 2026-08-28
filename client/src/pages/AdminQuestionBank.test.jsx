import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import AdminQuestionBank from './AdminQuestionBank';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

const adminUser = { id: 'admin-1', fullName: 'Admin User', role: 'ADMIN' };
const memberUser = { id: 'member-1', fullName: 'Member User', role: 'MEMBER' };

const cycles = [{ id: 'cycle-1', name: 'Fall 2026' }];

const questions = [
  {
    id: 'q-1',
    cycleId: 'cycle-1',
    prompt: 'Walk me through a time you led a team.',
    guidance: 'Look for ownership.',
    round: 'ROUND_ONE',
    category: 'Behavioral',
    status: 'PUBLISHED',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'q-2',
    cycleId: 'cycle-1',
    prompt: 'Size the market for electric scooters in LA.',
    guidance: null,
    round: 'ROUND_TWO',
    category: 'Casing',
    status: 'DRAFT',
    updatedAt: '2026-08-21T00:00:00.000Z',
  },
];

const facets = { categories: ['Behavioral', 'Casing'], rounds: ['ROUND_ONE', 'ROUND_TWO'] };

function mockGets({ questionList = questions } = {}) {
  apiClient.get.mockImplementation((url) => {
    if (url === '/admin/cycles') return Promise.resolve(cycles);
    if (url === '/admin/cycles/active') return Promise.resolve({ id: 'cycle-1', name: 'Fall 2026' });
    if (url.startsWith('/admin/interview-questions/facets')) return Promise.resolve(facets);
    if (url.startsWith('/admin/interview-questions')) return Promise.resolve(questionList);
    return Promise.resolve([]);
  });
}

describe('AdminQuestionBank', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({ user: adminUser });
    mockGets();
  });

  it('blocks non-admins', () => {
    useAuth.mockReturnValue({ user: memberUser });
    render(<AdminQuestionBank />);
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByText('Question Bank')).not.toBeInTheDocument();
  });

  it('lists questions for the active cycle and labels rounds readably', async () => {
    render(<AdminQuestionBank />);

    await waitFor(() => {
      expect(screen.getByText('Walk me through a time you led a team.')).toBeInTheDocument();
    });
    expect(screen.getByText('Size the market for electric scooters in LA.')).toBeInTheDocument();
    expect(screen.getByText('Round 1')).toBeInTheDocument();
    expect(screen.getByText('Round 2')).toBeInTheDocument();

    // The cycle is resolved before the list is fetched, so the request is scoped.
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/admin/interview-questions?cycleId=cycle-1')
      );
    });
  });

  it('reports how many questions interviewers can actually see', async () => {
    render(<AdminQuestionBank />);
    await waitFor(() => {
      expect(screen.getByText(/1 visible to interviewers/)).toBeInTheDocument();
    });
  });

  it('filters client-side on search without refetching', async () => {
    render(<AdminQuestionBank />);
    await waitFor(() => {
      expect(screen.getByText('Walk me through a time you led a team.')).toBeInTheDocument();
    });

    const callsBefore = apiClient.get.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText(/Search prompt/i), {
      target: { value: 'scooters' },
    });

    await waitFor(() => {
      expect(screen.queryByText('Walk me through a time you led a team.')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Size the market for electric scooters in LA.')).toBeInTheDocument();
    expect(apiClient.get.mock.calls.length).toBe(callsBefore);
  });

  it('creates a question against the selected cycle', async () => {
    apiClient.post.mockResolvedValue({ id: 'q-3' });
    render(<AdminQuestionBank />);
    await waitFor(() => expect(screen.getByText('Round 1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New question/i }));

    fireEvent.change(screen.getByLabelText(/Prompt/i), {
      target: { value: 'Why consulting?' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: /Round/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Coffee Chat' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/admin/interview-questions', {
        prompt: 'Why consulting?',
        guidance: null,
        round: 'COFFEE_CHAT',
        category: null,
        cycleId: 'cycle-1',
        status: 'DRAFT',
      });
    });
  });

  it('refuses to save without a prompt', async () => {
    render(<AdminQuestionBank />);
    await waitFor(() => expect(screen.getByText('Round 1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New question/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByText('Prompt is required.')).toBeInTheDocument();
    });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('moves status through the dedicated status endpoint, not the edit endpoint', async () => {
    apiClient.patch.mockResolvedValue({ ...questions[1], status: 'PUBLISHED' });
    render(<AdminQuestionBank />);
    await waitFor(() => expect(screen.getByText('Draft')).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText('Draft'));
    fireEvent.click(await screen.findByRole('option', { name: 'Published' }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/admin/interview-questions/q-2/status', {
        status: 'PUBLISHED',
      });
    });
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('warns that deleting keeps past interview copies, and deletes on confirm', async () => {
    apiClient.delete.mockResolvedValue({ success: true });
    render(<AdminQuestionBank />);
    await waitFor(() => expect(screen.getByText('Round 1')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    expect(await screen.findByText('Delete this question?')).toBeInTheDocument();
    expect(screen.getByText(/keep their own copy of the wording/i)).toBeInTheDocument();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/admin/interview-questions/q-1');
    });
  });

  it('surfaces a load failure instead of rendering an empty bank', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/admin/cycles') return Promise.resolve(cycles);
      if (url === '/admin/cycles/active') return Promise.resolve({ id: 'cycle-1' });
      if (url.startsWith('/admin/interview-questions/facets')) return Promise.resolve(facets);
      return Promise.reject(new Error('Failed to fetch interview questions (Status: 500)'));
    });

    render(<AdminQuestionBank />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch interview questions/)).toBeInTheDocument();
    });
  });
});
