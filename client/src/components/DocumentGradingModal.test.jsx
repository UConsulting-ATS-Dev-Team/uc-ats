// The grader's side of configurable rubrics: the modal grades against the
// rubric the server sends, not one baked into the page, holds a score to that
// rubric's range, and never turns a blank into a zero or a zero into a blank.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import DocumentGradingModal from './DocumentGradingModal';
import apiClient from '../utils/api';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'member-1', role: 'MEMBER' }, token: 't' })
}));
vi.mock('../hooks/useResponsive', () => ({ useIsMobile: () => false }));
vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), token: 't' }
}));

const video = {
  type: 'video',
  aggregation: 'single',
  customized: true,
  minOverall: 0,
  maxOverall: 5,
  rubric: {
    categories: [{
      id: 'scoreOne',
      title: 'Presence on camera',
      description: 'How the candidate comes across',
      min: 0,
      max: 5,
      criteria: [
        { label: '0-1', text: 'Flat' },
        { label: '2-3', text: 'Engaged' },
        { label: '4-5', text: 'Magnetic' }
      ]
    }]
  }
};

const rubricsResponse = {
  rubrics: { video, resume: { ...video, type: 'resume' }, coverLetter: { ...video, type: 'coverLetter' } },
  participationMax: 3,
  stagingMax: 18
};

const application = { candidateId: 'cand-1', cycleId: 'cycle-1', groupId: 'g-1', studentId: '123', major: 'Econ', year: '2029' };

function mockServer({ existing = null } = {}) {
  apiClient.get.mockImplementation((url) => {
    if (url === '/document-rubrics') return Promise.resolve(rubricsResponse);
    if (url.startsWith('/review-teams/video-score/')) return Promise.resolve(existing);
    return Promise.resolve(null);
  });
  apiClient.post.mockResolvedValue({});
}

const renderModal = () => render(
  <DocumentGradingModal open onClose={vi.fn()} application={application} documentType="video" />
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DocumentGradingModal', () => {
  it('shows the configured rubric and its range', async () => {
    mockServer();
    renderModal();
    expect(await screen.findByText('Presence on camera')).toBeInTheDocument();
    expect(screen.getByText('Score 0–5')).toBeInTheDocument();
    expect(screen.getByText('Magnetic')).toBeInTheDocument();
    expect(screen.getByText('Overall 0 / 5')).toBeInTheDocument();
  });

  it('flags a score outside the range and will not save it', async () => {
    mockServer();
    renderModal();
    const input = await screen.findByLabelText('Presence on camera');
    fireEvent.change(input, { target: { value: '7' } });
    expect(screen.getByText('Enter a whole number from 0 to 5.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save score/i })).toBeDisabled();
    // Said beside the disabled button too, and the bad score is not counted.
    expect(screen.getByText('A score is outside its range. Fix it to save.')).toBeInTheDocument();
    expect(screen.getByText('Overall 0 / 5')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '4' } });
    expect(screen.queryByText('Enter a whole number from 0 to 5.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save score/i })).toBeEnabled();
  });

  it('saves a real zero as 0 and leaves unused columns null', async () => {
    mockServer();
    renderModal();
    const input = await screen.findByLabelText('Presence on camera');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save score/i }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    expect(apiClient.post).toHaveBeenCalledWith('/review-teams/video-score', expect.objectContaining({
      scoreOne: 0,
      scoreTwo: null,
      scoreThree: null
    }));
  });

  it('reloads a saved zero as 0, not as a blank', async () => {
    mockServer({ existing: { scoreOne: 0, scoreTwo: null, scoreThree: null, notes: '' } });
    renderModal();
    await waitFor(() => expect(screen.getByLabelText('Presence on camera')).toHaveValue('0'));
  });

  describe('closing', () => {
    const renderWith = (onClose) => render(
      <DocumentGradingModal open onClose={onClose} application={application} documentType="video" />
    );
    const saveFour = async () => {
      fireEvent.change(await screen.findByLabelText('Presence on camera'), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: /save score/i }));
      await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
      await act(async () => {});
    };

    it('reports a save by itself, naming what was graded', async () => {
      mockServer();
      const onClose = vi.fn();
      renderWith(onClose);
      await saveFour();

      await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 3000 });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(true, { application, documentType: 'video' });
    });

    it('closed by hand during the success message, reports the save once and never again', async () => {
      mockServer();
      const onClose = vi.fn();
      renderWith(onClose);
      await saveFour();

      fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(true, { application, documentType: 'video' });

      // The timer must not fire a second close: by now the grader may have opened another row.
      await act(() => new Promise((resolve) => setTimeout(resolve, 1700)));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closed without a save, reports none', async () => {
      mockServer();
      const onClose = vi.fn();
      renderWith(onClose);
      await screen.findByLabelText('Presence on camera');

      fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
      expect(onClose).toHaveBeenCalledWith(false, undefined);
    });
  });
});
