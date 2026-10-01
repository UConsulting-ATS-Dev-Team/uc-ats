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

  describe('saving and closing', () => {
    const renderWith = (props) => render(
      <DocumentGradingModal open application={application} documentType="video" {...props} />
    );
    const typeFour = async () => {
      fireEvent.change(await screen.findByLabelText('Presence on camera'), { target: { value: '4' } });
    };
    const saveFour = async () => {
      await typeFour();
      fireEvent.click(screen.getByRole('button', { name: /save score/i }));
      await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
      await act(async () => {});
    };
    const closeButton = () => screen.getByRole('button', { name: /^close$/i });

    it('reports the save at once, naming what was graded, then closes itself', async () => {
      mockServer();
      const onClose = vi.fn();
      const onSaved = vi.fn();
      renderWith({ onClose, onSaved });
      await saveFour();

      expect(onSaved).toHaveBeenCalledWith({ application, documentType: 'video' });
      expect(onClose).not.toHaveBeenCalled();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it('closed by hand during the success message, does not close again later', async () => {
      mockServer();
      const onClose = vi.fn();
      renderWith({ onClose, onSaved: vi.fn() });
      await saveFour();

      fireEvent.click(closeButton());
      expect(onClose).toHaveBeenCalledTimes(1);

      // By now the grader may have opened another row; a second close would shut it.
      await act(() => new Promise((resolve) => setTimeout(resolve, 1700)));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closed while the save is in flight, still reports it but leaves the next form alone', async () => {
      mockServer();
      let answer;
      apiClient.post.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      const onClose = vi.fn();
      const onSaved = vi.fn();
      renderWith({ onClose, onSaved });
      await typeFour();
      fireEvent.click(screen.getByRole('button', { name: /save score/i }));
      await waitFor(() => expect(apiClient.post).toHaveBeenCalled());

      fireEvent.click(closeButton());
      // The grader starts on the next row in the same modal before the first save answers.
      fireEvent.change(screen.getByLabelText('Presence on camera'), { target: { value: '2' } });
      await act(async () => answer({}));

      expect(onSaved).toHaveBeenCalledWith({ application, documentType: 'video' });
      await act(() => new Promise((resolve) => setTimeout(resolve, 1700)));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('Presence on camera')).toHaveValue('2');
      expect(screen.queryByText(/saved successfully/i)).not.toBeInTheDocument();
    });

    it('closed without a save, reports none', async () => {
      mockServer();
      const onClose = vi.fn();
      const onSaved = vi.fn();
      renderWith({ onClose, onSaved });
      await screen.findByLabelText('Presence on camera');

      fireEvent.click(closeButton());
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();
    });
  });
});

// When a preview cannot load, the grader is told why and can still open the
// document in a new tab. A new tab sends no Authorization header, so the button
// signs a link first; it used to be a bare link that answered 401 for everyone.
describe('a document preview that fails', () => {
  const withResume = { ...application, resumeUrl: '/api/files/abc/pdf' };
  const renderWithResume = () => render(
    <DocumentGradingModal open onClose={vi.fn()} application={withResume} documentType="resume" />
  );

  const previewFails = (response) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response)));
  };
  const notFound = {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: () => Promise.resolve(JSON.stringify({ error: 'Failed to serve PDF' })),
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    mockServer();
  });

  it('says what the server answered', async () => {
    previewFails(notFound);
    renderWithResume();
    expect(await screen.findByText('Failed to load preview')).toBeInTheDocument();
    expect(screen.getByText('The server answered 404: Failed to serve PDF')).toBeInTheDocument();
  });

  it('says when the download stopped part way', async () => {
    previewFails({ ok: true, blob: () => Promise.reject(new TypeError('network error')) });
    renderWithResume();
    expect(
      await screen.findByText('The download stopped before the file finished (network error)')
    ).toBeInTheDocument();
  });

  it('opens the document in a new tab through a signed link', async () => {
    previewFails(notFound);
    const tab = { location: { href: '' }, close: vi.fn(), opener: 'page' };
    vi.spyOn(window, 'open').mockReturnValue(tab);
    apiClient.post.mockResolvedValue({ access: 'tok.en' });

    renderWithResume();
    fireEvent.click(await screen.findByRole('button', { name: /open resume in new tab/i }));

    // The tab opens inside the click, before the await, or a popup blocker eats it.
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('/api/files/abc/pdf?access=tok.en'));
    expect(apiClient.post).toHaveBeenCalledWith('/files/abc/link');
    expect(tab.opener).toBeNull();
  });

  it('closes the tab and says why when the link cannot be signed', async () => {
    previewFails(notFound);
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab);
    apiClient.post.mockRejectedValue(Object.assign(new Error('Forbidden (Status: 403)'), { serverMessage: 'Forbidden' }));

    renderWithResume();
    fireEvent.click(await screen.findByRole('button', { name: /open resume in new tab/i }));

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });

  it('asks for pop-ups when the browser blocks the tab', async () => {
    previewFails(notFound);
    vi.spyOn(window, 'open').mockReturnValue(null);
    apiClient.post.mockResolvedValue({ access: 'tok.en' });

    renderWithResume();
    fireEvent.click(await screen.findByRole('button', { name: /open resume in new tab/i }));

    expect(await screen.findByText(/allow pop-ups for this site/i)).toBeInTheDocument();
  });
});

// A video is never downloaded whole: Vercel's proxy cut that off part way. The
// <video> streams it in ranges from a signed link.
describe('the video preview', () => {
  const withVideo = { ...application, videoUrl: '/api/files/vid/pdf' };
  const renderWithVideo = () => render(
    <DocumentGradingModal open onClose={vi.fn()} application={withVideo} documentType="video" />
  );
  const videoElement = () => document.querySelector('video');

  beforeEach(() => {
    vi.unstubAllGlobals();
    mockServer();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('a video must not be fetched whole'))));
  });

  it('streams from a signed link instead of downloading the file', async () => {
    apiClient.post.mockResolvedValue({ access: 'tok.en' });
    renderWithVideo();

    await waitFor(() => expect(videoElement()).not.toBeNull());
    expect(videoElement().getAttribute('src')).toBe('/api/files/vid/pdf?access=tok.en');
    expect(apiClient.post).toHaveBeenCalledWith('/files/vid/link');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says why when the link cannot be signed', async () => {
    apiClient.post.mockRejectedValue(Object.assign(new Error('Forbidden (Status: 403)'), { serverMessage: 'Forbidden' }));
    renderWithVideo();
    expect(await screen.findByText('Could not open the video: Forbidden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open video in new tab/i })).toBeInTheDocument();
  });

  it('re-signs an expired link once and resumes where it was', async () => {
    apiClient.post.mockResolvedValueOnce({ access: 'first' }).mockResolvedValueOnce({ access: 'second' });
    renderWithVideo();
    await waitFor(() => expect(videoElement()).not.toBeNull());

    const video = videoElement();
    Object.defineProperty(video, 'currentTime', { value: 42, writable: true });
    fireEvent.error(video);

    await waitFor(() => expect(video.src).toContain('/api/files/vid/pdf?access=second'));
    expect(video.currentTime).toBe(42);
  });

  it('reports a video that still will not play', async () => {
    apiClient.post.mockResolvedValue({ access: 'tok.en' });
    renderWithVideo();
    await waitFor(() => expect(videoElement()).not.toBeNull());

    fireEvent.error(videoElement());
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    fireEvent.error(videoElement());

    expect(await screen.findByText(/could not be played here/i)).toBeInTheDocument();
  });
});
