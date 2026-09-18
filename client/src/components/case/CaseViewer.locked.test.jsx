// The viewer's side of the case book time restriction: what a member sees while
// a case is still locked, and that a slow reply for a case they have already
// switched away from cannot overwrite the one they are looking at.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CaseViewer from './CaseViewer';
import apiClient from '../../utils/api';

vi.mock('./CasePageImage', () => ({
  default: ({ alt }) => <div data-testid="case-page">{alt}</div>,
}));

const lockedError = (unlocksAt) =>
  Object.assign(new Error('This case unlocks closer to the interview. (Status: 423)'), {
    status: 423,
    code: 'CASE_LOCKED',
    body: { code: 'CASE_LOCKED', unlocksAt },
  });

const openCase = (id, title) => ({
  id,
  title,
  description: null,
  status: 'ACTIVE',
  pageCount: 1,
  pages: [{ id: `${id}-page-1`, pageNumber: 1, pageType: 'NORMAL', exhibitLabel: null }],
});

const viewer = (assignment) => (
  <CaseViewer
    interviewId="interview-1"
    applicationId="app-1"
    assignment={assignment}
    canManage={false}
    activeCases={[]}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
});

describe('a locked case', () => {
  it('says when it opens instead of showing an error', async () => {
    const unlocksAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    apiClient.get = vi.fn(() => Promise.reject(lockedError(unlocksAt)));

    render(viewer({ id: 'a1', caseId: 'case-1', caseTitle: 'Widget Co.' }));

    await waitFor(() =>
      expect(screen.getByText(/Case opens closer to the interview/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/in about 3 hours/i)).toBeInTheDocument();
  });

  it('shows no case pages while it is locked', async () => {
    apiClient.get = vi.fn(() =>
      Promise.reject(lockedError(new Date(Date.now() + 3600000).toISOString()))
    );

    render(viewer({ id: 'a1', caseId: 'case-1', caseTitle: 'Widget Co.' }));

    await waitFor(() =>
      expect(screen.getByText(/Case opens closer to the interview/i)).toBeInTheDocument()
    );
    expect(screen.queryByTestId('case-page')).not.toBeInTheDocument();
  });

  it('still reports a real failure as an error', async () => {
    apiClient.get = vi.fn(() =>
      Promise.reject(Object.assign(new Error('Server Error (500)'), { status: 500 }))
    );

    render(viewer({ id: 'a1', caseId: 'case-1', caseTitle: 'Widget Co.' }));

    await waitFor(() => expect(screen.getByText(/Server Error/i)).toBeInTheDocument());
    expect(screen.queryByText(/Case opens closer to the interview/i)).not.toBeInTheDocument();
  });
});

describe('switching cases while a request is in flight', () => {
  it('does not let a late locked reply wipe out the case now on screen', async () => {
    // The first case is locked and answers slowly; the second is open and answers
    // at once. Without a guard the late 423 clears the case already displayed.
    let rejectFirst;
    const slowLocked = new Promise((_, reject) => {
      rejectFirst = reject;
    });

    apiClient.get = vi.fn((path) =>
      path.endsWith('/cases/case-1') ? slowLocked : Promise.resolve(openCase('case-2', 'Second Case'))
    );

    const { rerender } = render(viewer({ id: 'a1', caseId: 'case-1', caseTitle: 'First Case' }));

    // Switch to the second case before the first replies.
    rerender(viewer({ id: 'a2', caseId: 'case-2', caseTitle: 'Second Case' }));
    // The page appears in both the main stage and the thumbnail strip.
    await waitFor(() => expect(screen.getAllByTestId('case-page').length).toBeGreaterThan(0));

    // Now the first request finally fails with a lock.
    rejectFirst(lockedError(new Date(Date.now() + 7200000).toISOString()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText(/Case opens closer to the interview/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('case-page').length).toBeGreaterThan(0);
  });
});
