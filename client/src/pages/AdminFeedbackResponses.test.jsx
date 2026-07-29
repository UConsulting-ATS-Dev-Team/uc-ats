import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminFeedbackResponses from './AdminFeedbackResponses';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('AdminFeedbackResponses', () => {
  const cycles = [{ id: 'cycle-1', name: 'Fall 2026' }];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/cycles')) return Promise.resolve(cycles);
      if (url.startsWith('/admin/feedback-responses')) {
        return Promise.resolve({
          responses: [
            {
              id: 'resp-1',
              cycle: { name: 'Fall 2026' },
              content: 'Great process overall.',
              answers: { q1: 'answer one' },
              questionsSnapshot: [{ id: 'q1', label: 'What went well?' }],
            },
          ],
          total: 1,
        });
      }
      return Promise.resolve([]);
    });
  });

  it('renders the confidential feedback responses with question labels', async () => {
    render(<MemoryRouter><AdminFeedbackResponses /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText('Confidential Feedback Responses')).toBeInTheDocument();
    });

    expect(screen.getByText('Fall 2026')).toBeInTheDocument();
    expect(screen.getByText('What went well?')).toBeInTheDocument();
    expect(screen.getByText('answer one')).toBeInTheDocument();
  });

  it('shows the empty state when no responses are returned', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/cycles')) return Promise.resolve(cycles);
      if (url.startsWith('/admin/feedback-responses')) {
        return Promise.resolve({ responses: [], total: 0 });
      }
      return Promise.resolve([]);
    });

    render(<MemoryRouter><AdminFeedbackResponses /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText(/No feedback responses yet/i)).toBeInTheDocument();
    });
  });

  it('shows an error alert when loading fails', async () => {
    api.get.mockRejectedValue(new Error('Failed to load'));
    render(<MemoryRouter><AdminFeedbackResponses /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/i)).toBeInTheDocument();
    });
  });
});
