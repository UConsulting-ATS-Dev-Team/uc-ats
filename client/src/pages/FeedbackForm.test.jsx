import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import FeedbackForm from './FeedbackForm';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

function renderWithToken(token) {
  return render(
    <MemoryRouter initialEntries={[`/feedback/${token}`]}>
      <Routes>
        <Route path="/feedback/:token" element={<FeedbackForm />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('FeedbackForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders configured questions and the privacy policy', async () => {
    api.get.mockResolvedValue({
      valid: true,
      cycleName: 'Fall 2026',
      prompt: 'We would appreciate your confidential feedback.',
      questions: [
        { id: 'q1', label: 'What went well?', required: true },
        { id: 'q2', label: 'What could improve?', required: false },
      ],
      privacyPolicy: 'Responses are confidential and retained for 365 days.',
      retentionDays: 365,
    });
    api.post.mockResolvedValue({});

    renderWithToken('token-1');

    await waitFor(() => {
      expect(screen.getByText('Feedback')).toBeInTheDocument();
    });

    expect(screen.getByText('Fall 2026')).toBeInTheDocument();
    expect(screen.getByText(/confidential and retained for 365 days/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/What went well/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/What could improve/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/What went well/i), { target: { value: 'The interviews were organized.' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/feedback/token-1', {
        answers: { q1: 'The interviews were organized.' },
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Thank You/i)).toBeInTheDocument();
    });
  });

  it('shows a consumed-token error without duplicate submission', async () => {
    api.get.mockRejectedValue(new Error('Feedback has already been submitted for this link.'));

    renderWithToken('used-token');

    await waitFor(() => {
      expect(screen.getByText(/already been submitted/i)).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /Submit Feedback/i })).toBeNull();
  });

  it('shows a generic error when the token is invalid', async () => {
    api.get.mockRejectedValue(new Error('This feedback link is invalid or has already been used.'));

    renderWithToken('invalid-token');

    await waitFor(() => {
      expect(screen.getByText(/invalid or has already been used/i)).toBeInTheDocument();
    });
  });
});
