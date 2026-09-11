// The read-only embed used for a returning applicant's past cycle: it must show
// that cycle's comments, scores and interview feedback, scope the score reads to
// that cycle, and offer nothing that writes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from '../utils/api';
import ApplicationDetail from './ApplicationDetail';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', fullName: 'Test Admin' } }),
}));
vi.mock('../context/ExecUnlockContext', () => ({ useExecUnlock: () => ({ version: 0 }) }));
vi.mock('../components/AuthenticatedImage', () => ({ default: () => null }));
vi.mock('../components/DocumentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/OfferLetterSection', () => ({ default: () => <div>Offer letter section</div> }));
vi.mock('../components/RecordSealControl', () => ({ default: () => <div>Seal control</div> }));

const PAST_CYCLE_ID = 'cycle-fall-2025';

const pastApplication = {
  id: 'app-past',
  candidateId: 'cand-1',
  cycleId: PAST_CYCLE_ID,
  cycle: { id: PAST_CYCLE_ID, name: 'Fall 2025' },
  firstName: 'Dana',
  lastName: 'Rivera',
  email: 'dana@example.com',
  phoneNumber: '555-0100',
  studentId: '123456789',
  status: 'REJECTED',
  submittedAt: '2025-09-01T00:00:00.000Z',
  testFor: 'Leadership',
  pastApplications: [],
};

const resumeScore = {
  id: 'rs-1',
  overallScore: 11,
  notes: 'Strong internship progression',
  evaluator: { id: 'm-1', fullName: 'Grader One' },
  createdAt: '2025-09-12T00:00:00.000Z',
};

function mockEndpoints() {
  apiClient.get.mockImplementation((url) => {
    if (url === '/applications/app-past') return Promise.resolve(pastApplication);
    if (url === '/applications/current-user/id') return Promise.resolve({ userId: 'admin-1' });
    if (url.includes('/grades/average')) return Promise.resolve({ resume: 11, video: 1, cover_letter: 2, total: 14, count: 1 });
    if (url.includes('/comments')) {
      return Promise.resolve([
        { id: 'c-1', content: 'Cut after resume review', createdAt: '2025-09-20T00:00:00.000Z', user: { fullName: 'Reviewer Two' } },
      ]);
    }
    if (url.includes('/review-teams/resume-scores/')) return Promise.resolve([resumeScore]);
    if (url.includes('/review-teams/cover-letter-scores/')) return Promise.resolve([]);
    if (url.includes('/review-teams/video-scores/')) return Promise.resolve([]);
    if (url.includes('/events')) return Promise.resolve({ events: [], totalPoints: 0 });
    if (url.includes('/referral')) return Promise.resolve(null);
    if (url.includes('/interview-evaluations')) {
      return Promise.resolve([
        {
          id: 'ev-1',
          decision: 'NO',
          notes: 'Struggled with the case',
          interview: { id: 'int-1', title: 'Coffee Chat', interviewType: 'COFFEE_CHAT' },
          evaluator: { fullName: 'Interviewer Three' },
          rubricScores: [],
        },
      ]);
    }
    return Promise.resolve([]);
  });
}

const renderDetail = (props) =>
  render(
    <MemoryRouter>
      <ApplicationDetail applicationId="app-past" embedded {...props} />
    </MemoryRouter>
  );

describe('ApplicationDetail read-only past-cycle embed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mockEndpoints();
  });
  afterEach(cleanup);

  it('shows the past cycle’s comments, scores and interview feedback', async () => {
    renderDetail({ readOnly: true });

    expect(await screen.findByText('Cut after resume review')).toBeInTheDocument();
    expect(screen.getByText('Reviewer Two')).toBeInTheDocument();
    expect(screen.getByText('Grader One')).toBeInTheDocument();
    expect(screen.getByText(/Struggled with the case/)).toBeInTheDocument();
  });

  it('reads scores scoped to that application’s cycle', async () => {
    renderDetail({ readOnly: true });

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith(`/review-teams/resume-scores/cand-1?cycleId=${PAST_CYCLE_ID}`));
    expect(apiClient.get).toHaveBeenCalledWith(`/review-teams/cover-letter-scores/cand-1?cycleId=${PAST_CYCLE_ID}`);
    expect(apiClient.get).toHaveBeenCalledWith(`/review-teams/video-scores/cand-1?cycleId=${PAST_CYCLE_ID}`);
  });

  it('offers nothing that writes to a past record', async () => {
    renderDetail({ readOnly: true });
    await screen.findByText('Cut after resume review');

    expect(screen.queryByPlaceholderText('Type your comment here...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Referral' })).not.toBeInTheDocument();
    expect(screen.queryByText('Seal control')).not.toBeInTheDocument();
    expect(screen.queryByText('Offer letter section')).not.toBeInTheDocument();
  });

  it('still allows commenting on the live record', async () => {
    renderDetail({ readOnly: false });
    await screen.findByText('Cut after resume review');

    expect(screen.getByPlaceholderText('Type your comment here...')).toBeInTheDocument();
    expect(screen.getByText('Offer letter section')).toBeInTheDocument();
  });
});
