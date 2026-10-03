// Each viewer moves around a deliberation on their own. What matters: the
// step and candidate come from this viewer's URL, never from the session, so
// a new version from the server does not move anyone; members get the same
// navigation as admins; an admin's threshold change only moves a viewer whose
// outlier it dropped; and an ended session shows everyone the summary.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ReviewDelib from './ReviewDelib';
import useReviewDelibSession from '../hooks/useReviewDelibSession';

vi.mock('../hooks/useReviewDelibSession', () => ({ default: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'm1', role: 'MEMBER' } }) }));
vi.mock('../context/ReviewDelibContext', () => ({ useReviewDelibs: () => ({ refresh: vi.fn() }) }));
vi.mock('../components/reviewDelib/DocumentPanel', () => ({ default: () => null }));
// The overview's numbers are its own tests' business.
vi.mock('../components/reviewDelib/OverviewStep', () => ({ default: () => null }));

const doc = { has: false, max: 13, categories: [], avg: null, rows: [] };
const row = (applicationId, extra = {}) => ({
  applicationId, candidateId: `c-${applicationId}`, name: `Cand ${applicationId}`, locked: false, total: 9, overall: 9, rank: 1,
  outlierCount: 0, splitDocs: 0, resumeDecision: null, perDoc: { resume: { has: true, avg: 9, n: 2 }, coverLetter: { has: false, avg: null, n: 0 }, video: { has: false, avg: null, n: 0 } },
  ...extra
});

let session;
function setSession({ version = 1, status = 'ACTIVE', outliers = ['app1', 'app2'], sealed = [] } = {}) {
  session = {
    state: {
      version,
      now: Date.now(),
      session: {
        id: 's1', groupId: 'g1', groupName: 'Team Alpha', cycleId: 'cycle-1', status, thresholdPct: 0.3,
        outlierApplicationIds: outliers, createdByName: 'Ada Admin', startedAt: new Date().toISOString(), endedAt: status === 'ENDED' ? new Date().toISOString() : null
      },
      viewer: { userId: 'm1', isAdmin: false, isHost: false },
      participants: [],
      changeCount: 0
    },
    team: {
      candidates: ['app1', 'app2', 'app3'].map((id) => row(id, { locked: sealed.includes(id) })),
      rankedCount: 3,
      counts: {}, flags: [], insights: [], graders: [], comparison: {}, members: []
    },
    card: null,
    cardError: null,
    changes: { total: 0, changes: [] },
    changesError: null,
    pending: new Set(),
    busy: false,
    connected: true,
    error: null,
    reloadTeam: vi.fn(),
    reloadChanges: vi.fn(),
    setThreshold: vi.fn(),
    override: vi.fn(),
    decide: vi.fn(),
    end: vi.fn()
  };
}

// The card the hook would hand back for whichever candidate the page asked for.
const lastAsked = () => useReviewDelibSession.mock.calls.at(-1)[1];

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.search}</div>;
}

// The router keeps its own history across a rerender: initialEntries is read once.
const page = (search = '') => (
  <MemoryRouter initialEntries={[`/review-delib/s1${search}`]}>
    <Routes>
      <Route path="/review-delib/:sessionId" element={<><ReviewDelib /><Where /></>} />
    </Routes>
  </MemoryRouter>
);
const renderAt = (search) => render(page(search));

beforeEach(() => {
  vi.clearAllMocks();
  setSession();
  useReviewDelibSession.mockImplementation((sessionId, { applicationId }) => ({
    ...session,
    card: applicationId ? { applicationId, name: `Cand ${applicationId}`, total: 9, docs: { resume: doc, coverLetter: doc, video: doc } } : null
  }));
});

describe('ReviewDelib: every viewer moves on their own', () => {
  it('opens on the overview and gives a member the steps, previous and next', async () => {
    renderAt();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Outlier at')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Outliers (2)' }));
    expect(screen.getByText('Outlier 1 of 2')).toBeInTheDocument();
    expect(lastAsked().applicationId).toBe('app1');

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Outlier 2 of 2')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('?step=outliers&c=app2');
  });

  it('lets a member open any candidate from the list', async () => {
    renderAt('?step=all');
    expect(screen.getByText('Click a candidate to open it.')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Cand app3'));
    expect(lastAsked().applicationId).toBe('app3');
    expect(screen.getByTestId('where')).toHaveTextContent('?step=all&c=app3');
  });

  it('restores the place from the URL, and reads an unknown step as the overview', () => {
    const { unmount } = renderAt('?step=all&c=app2');
    expect(lastAsked()).toMatchObject({ step: 'ALL', applicationId: 'app2' });
    expect(screen.getByRole('heading', { name: 'Cand app2' })).toBeInTheDocument();
    unmount();

    renderAt('?step=sideways&c=app2');
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastAsked().applicationId).toBe(null);
  });

  it('is not moved by a new version from the server', () => {
    const { rerender } = renderAt('?step=all&c=app2');
    setSession({ version: 9 });
    rerender(page());
    expect(screen.getByTestId('where')).toHaveTextContent('?step=all&c=app2');
    expect(lastAsked().applicationId).toBe('app2');
  });

  it('moves a viewer off an outlier the threshold just dropped, and leaves one on the list alone', async () => {
    const { rerender } = renderAt('?step=outliers&c=app1');
    expect(screen.getByText('Outlier 1 of 2')).toBeInTheDocument();

    setSession({ version: 2, outliers: ['app2'] });
    await act(async () => { rerender(page()); });
    expect(screen.getByTestId('where')).toHaveTextContent('?step=outliers&c=app2');
    expect(screen.getByText('Outlier 1 of 1')).toBeInTheDocument();
  });

  it('skips a sealed candidate in the walkthrough', async () => {
    setSession({ outliers: ['app1', 'app2', 'app3'], sealed: ['app2'] });
    renderAt('?step=outliers');
    expect(screen.getByTestId('where')).toHaveTextContent('c=app1');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('where')).toHaveTextContent('c=app3');
  });

  it('shows everyone the summary once the session has ended', () => {
    setSession({ status: 'ENDED' });
    renderAt('?step=all&c=app2');
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cand app2' })).not.toBeInTheDocument();
  });

  it('gives an admin running it the threshold and End as well', () => {
    setSession();
    session.state.viewer = { userId: 'a1', isAdmin: true, isHost: true };
    renderAt();
    expect(screen.getByLabelText('Outlier at')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End' })).toBeInTheDocument();
  });
});
