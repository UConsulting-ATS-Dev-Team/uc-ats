// Focus view: the interviewer's full-screen case, guides included, beside their
// notes, and never on screen together with the candidate view.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import CaseViewer from './CaseViewer';
import apiClient from '../../utils/api';

vi.mock('./CasePageImage', () => ({
  default: ({ alt }) => <div data-testid="case-page">{alt}</div>,
}));

const CASE = {
  id: 'case-1',
  title: 'Hopper',
  description: null,
  status: 'ACTIVE',
  pageCount: 3,
  pages: [
    { id: 'p1', pageNumber: 1, pageType: 'NORMAL', exhibitLabel: null, width: 1600, height: 900 },
    { id: 'p2', pageNumber: 2, pageType: 'INTERVIEWER_ONLY', exhibitLabel: null, width: 1600, height: 900 },
    { id: 'p3', pageNumber: 3, pageType: 'EXHIBIT', exhibitLabel: 'Exhibit 1', width: 1600, height: 900 },
  ],
};

const renderViewer = async (props = {}) => {
  render(
    <CaseViewer
      interviewId="interview-1"
      applicationId="app-1"
      assignment={{ id: 'a1', caseId: 'case-1', caseTitle: 'Hopper' }}
      canManage={false}
      activeCases={[]}
      {...props}
    />
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Focus view' })).toBeInTheDocument());
};

const openFocus = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Focus view' }));
  return screen.getByRole('dialog', { name: /Hopper, focus view/ });
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
  apiClient.get = vi.fn(() => Promise.resolve(CASE));
});

describe('the jump bar', () => {
  it('groups guides as numbered buttons', async () => {
    await renderViewer();

    expect(screen.getByText('Guides')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Guide, page 2' }));
    expect(screen.getByText('Page 2 / 3')).toBeInTheDocument();
  });
});

describe('focus view', () => {
  it('opens the deck full screen, guides included', async () => {
    await renderViewer();
    const dialog = openFocus();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Guide, page 2' }));

    expect(within(dialog).getByText(/Interviewer only/)).toBeInTheDocument();
    expect(within(dialog).getByTestId('case-page')).toHaveTextContent('Page 2');
    expect(within(dialog).getByText('Page 2 / 3')).toBeInTheDocument();
  });

  it('shows the notes the page passes in beside the case', async () => {
    await renderViewer({ renderNotes: () => <textarea aria-label="Framework notes" defaultValue="" /> });
    const dialog = openFocus();

    const notes = within(dialog).getByRole('complementary', { name: 'Interviewer notes' });
    expect(within(notes).getByLabelText('Framework notes')).toBeInTheDocument();
  });

  it('moves with the arrow keys and closes on Escape', async () => {
    await renderViewer();
    openFocus();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(within(screen.getByRole('dialog')).getByText('Page 2 / 3')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('leaves arrow keys to a note being typed', async () => {
    await renderViewer({ renderNotes: () => <textarea aria-label="Framework notes" defaultValue="" /> });
    const dialog = openFocus();

    const note = within(dialog).getByLabelText('Framework notes');
    note.focus();
    fireEvent.keyDown(note, { key: 'ArrowRight' });

    expect(within(dialog).getByText('Page 1 / 3')).toBeInTheDocument();
  });

  it('closes when the candidate view opens, so guides are never left on screen', async () => {
    await renderViewer();
    openFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Candidate View' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Interviewer only/)).not.toBeInTheDocument();
  });
});
