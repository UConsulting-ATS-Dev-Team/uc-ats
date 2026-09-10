import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InterviewInterface from './InterviewInterface';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../components/chat/InterviewChatWidget', () => ({
  default: () => null,
}));

vi.mock('../context/CelebrationContext', () => ({
  useCelebration: () => ({ triggerCelebration: vi.fn() }),
}));

function renderWithRouter(element) {
  return render(
    <MemoryRouter initialEntries={['/admin/interview-interface?interviewId=iv-1&groupIds=g1']}>
      {element}
    </MemoryRouter>
  );
}

const mockUser = { id: 'user-1', fullName: 'Test Admin', role: 'ADMIN' };
const mockInterview = {
  id: 'iv-1',
  title: 'Deliberations A',
  interviewType: 'DELIBERATIONS',
  description: '{}',
};
const mockApplication = {
  id: 'app-1',
  name: 'Taylor Casey',
  major: 'Economics',
  year: '2027',
};

describe('InterviewInterface deliberations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    apiClient.token = 'test-token';

    apiClient.get = vi.fn((endpoint) => {
      if (endpoint === '/admin/profile') return Promise.resolve(mockUser);
      if (endpoint === '/admin/interviews/iv-1') return Promise.resolve(mockInterview);
      if (endpoint === '/admin/interviews/iv-1/applications?groupIds=g1') {
        return Promise.resolve([mockApplication]);
      }
      if (endpoint === '/admin/interviews/iv-1/evaluations') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    apiClient.post = vi.fn(() => Promise.resolve({}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders deliberation guidance with all five InterviewDecision definitions', async () => {
    renderWithRouter(<InterviewInterface />);

    await waitFor(() => {
      expect(screen.getByTestId('deliberation-guidance')).toBeInTheDocument();
    });

    expect(screen.getByTestId('decision-definition-YES')).toBeInTheDocument();
    expect(screen.getByTestId('decision-definition-MAYBE_YES')).toBeInTheDocument();
    expect(screen.getByTestId('decision-definition-UNSURE')).toBeInTheDocument();
    expect(screen.getByTestId('decision-definition-MAYBE_NO')).toBeInTheDocument();
    expect(screen.getByTestId('decision-definition-NO')).toBeInTheDocument();
  });

  it('submits the original enum value unchanged', async () => {
    renderWithRouter(<InterviewInterface />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Maybe-Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/admin/interviews/iv-1/evaluations',
        expect.objectContaining({
          applicationId: 'app-1',
          decision: 'MAYBE_YES',
        })
      );
    });
  });

  it('keeps the existing submission error behavior intact', async () => {
    apiClient.post.mockRejectedValue(new Error('Network error'));

    renderWithRouter(<InterviewInterface />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith('Failed to save evaluation');
    });
  });
});
