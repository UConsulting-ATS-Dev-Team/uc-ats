import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DocumentGrading from './DocumentGrading';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'me', role: 'MEMBER', fullName: 'Me' } })
}));
vi.mock('../components/TutorialGate', () => ({
  useTutorialGate: () => ({ run: (fn) => fn(), dialog: null })
}));
vi.mock('../components/FlagDocumentModal', () => ({ default: () => null }));
// The modal's own save is not under test: these buttons stand in for it.
vi.mock('../components/DocumentGradingModal', () => ({
  default: ({ open, onClose }) =>
    open ? (
      <div>
        <button onClick={() => onClose(true)}>modal-saved</button>
        <button onClick={() => onClose(false)}>modal-cancelled</button>
      </div>
    ) : null
}));
vi.mock('../utils/api', () => ({ default: { get: vi.fn(), setToken: vi.fn(), token: '' } }));

const app = (id, studentId, hasResumeScore = false) => ({
  id,
  candidateId: `cand-${id}`,
  cycleId: 'cycle-1',
  studentId,
  major: 'Math',
  year: '2027',
  email: `${id}@ucla.edu`,
  gender: 'N/A',
  submittedAt: '2026-09-01T00:00:00Z',
  resumeUrl: 'https://example.com/r.pdf',
  groupId: 'group-1',
  groupMembers: [{ id: 'me' }, { id: 'teammate' }],
  hasResumeScore,
  hasCoverLetterScore: false,
  hasVideoScore: false,
  resumeTotalMembers: 2,
  resumeMissingGrades: hasResumeScore ? 1 : 2,
  resumeCompletedEvaluators: hasResumeScore ? ['me'] : []
});

const statusOf = (studentId) => {
  const row = screen.getByText(`Student ${studentId}`).closest('tr');
  return within(row).getByText(/Grade Now|Completed/).textContent;
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function renderLoaded(rows) {
  apiClient.get.mockResolvedValueOnce(rows);
  render(<MemoryRouter><DocumentGrading /></MemoryRouter>);
  await screen.findByText(`Student ${rows[0].studentId}`);
}

const openResume = (studentId) => {
  const row = screen.getByText(`Student ${studentId}`).closest('tr');
  fireEvent.click(within(row).getByRole('button', { name: /Resume/ }));
};

describe('DocumentGrading after a grade is saved', () => {
  beforeEach(() => {
    apiClient.get.mockReset();
  });

  it('marks the row graded at once and keeps the table on screen while it refetches', async () => {
    await renderLoaded([app('a1', 111), app('a2', 222)]);
    const refetch = deferred();
    apiClient.get.mockReturnValueOnce(refetch.promise);

    openResume(111);
    fireEvent.click(screen.getByText('modal-saved'));

    // The refetch has not answered, yet the row is already done and no spinner replaced the table.
    expect(statusOf(111)).toBe('Completed');
    expect(statusOf(222)).toBe('Grade Now');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(apiClient.get).toHaveBeenCalledTimes(2);

    await act(async () => refetch.resolve([app('a1', 111, true), app('a2', 222)]));
    expect(statusOf(111)).toBe('Completed');
  });

  it('does not refetch when the modal closes without a save', async () => {
    await renderLoaded([app('a1', 111)]);
    openResume(111);
    fireEvent.click(screen.getByText('modal-cancelled'));

    expect(statusOf(111)).toBe('Grade Now');
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('ignores a refetch that lands after a later save started its own', async () => {
    await renderLoaded([app('a1', 111), app('a2', 222)]);
    const first = deferred();
    const second = deferred();
    apiClient.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    openResume(111);
    fireEvent.click(screen.getByText('modal-saved'));
    openResume(222);
    fireEvent.click(screen.getByText('modal-saved'));

    // The first refetch was read before the second grade existed; applying it would undo that grade.
    await act(async () => first.resolve([app('a1', 111, true), app('a2', 222)]));
    expect(statusOf(222)).toBe('Completed');

    await act(async () => second.resolve([app('a1', 111, true), app('a2', 222, true)]));
    expect(statusOf(111)).toBe('Completed');
    expect(statusOf(222)).toBe('Completed');
  });

  it('keeps the rows on screen when the background refetch fails', async () => {
    await renderLoaded([app('a1', 111)]);
    apiClient.get.mockRejectedValueOnce(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    openResume(111);
    fireEvent.click(screen.getByText('modal-saved'));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
    expect(statusOf(111)).toBe('Completed');
    expect(screen.queryByText(/Failed to load applications/)).toBeNull();
  });
});
