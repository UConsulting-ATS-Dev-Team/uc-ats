// The grading tutorial gate from the grader's side: the first document they open
// waits behind the tutorial, the popup cannot be dismissed, and finishing it opens
// the document they clicked. A gate the server says is clear, or cannot answer
// for, never gets in the way.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useTutorialGate } from './TutorialGate';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), token: 't' }
}));

const TUTORIAL = {
  id: 'tut-1',
  title: 'How we grade resumes',
  description: 'Ten minutes on the rubric',
  videoUrl: 'https://www.loom.com/share/abc123',
  body: ''
};

function GradingPage({ onOpenDocument }) {
  const gate = useTutorialGate('DOCUMENT_GRADING', 'Start grading');
  return (
    <>
      <button onClick={() => gate.run(onOpenDocument)}>Resume</button>
      {gate.dialog}
    </>
  );
}

const renderPage = () => {
  const onOpenDocument = vi.fn();
  render(<GradingPage onOpenDocument={onOpenDocument} />);
  return onOpenDocument;
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.post.mockResolvedValue({ completed: true });
});

describe('useTutorialGate', () => {
  it('holds the first document behind the tutorial, then opens it once finished', async () => {
    apiClient.get.mockResolvedValue({ required: true, cycleId: 'c1', tutorials: [TUTORIAL] });
    const onOpenDocument = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('How we grade resumes')).toBeInTheDocument();
    expect(screen.getByTitle('How we grade resumes')).toHaveAttribute(
      'src',
      'https://www.loom.com/embed/abc123'
    );
    expect(onOpenDocument).not.toHaveBeenCalled();

    const start = screen.getByRole('button', { name: 'Start grading' });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I watched the whole tutorial'));
    fireEvent.click(start);

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith(
      '/member/help/tutorial-gates/DOCUMENT_GRADING/complete'
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Once the server says it is done, the next document opens straight away.
    apiClient.get.mockResolvedValue({ required: false, cycleId: 'c1', tutorials: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks again on every click, so a new cycle gates a page left open', async () => {
    apiClient.get.mockResolvedValue({ required: false, cycleId: 'c1', tutorials: [] });
    const onOpenDocument = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1));

    // An admin activates the next cycle while the page stays open.
    apiClient.get.mockResolvedValue({ required: true, cycleId: 'c2', tutorials: [TUTORIAL] });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(onOpenDocument).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('opens the latest document clicked when an earlier check is still pending', async () => {
    let answerFirst;
    apiClient.get
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce({ required: false, cycleId: 'c1', tutorials: [] });
    const openA = vi.fn();
    const openB = vi.fn();
    function TwoDocuments() {
      const gate = useTutorialGate('DOCUMENT_GRADING', 'Start grading');
      return (
        <>
          <button onClick={() => gate.run(openA)}>A</button>
          <button onClick={() => gate.run(openB)}>B</button>
          {gate.dialog}
        </>
      );
    }
    render(<TwoDocuments />);

    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    await waitFor(() => expect(openB).toHaveBeenCalledTimes(1));

    answerFirst({ required: false, cycleId: 'c1', tutorials: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(openA).not.toHaveBeenCalled();
  });

  it('links to a tutorial that is not a known video host instead of framing it', async () => {
    apiClient.get.mockResolvedValue({
      required: true,
      cycleId: 'c1',
      tutorials: [{ ...TUTORIAL, videoUrl: 'https://docs.google.com/document/d/abc' }]
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const link = await screen.findByRole('link', { name: 'Open the tutorial in a new tab' });
    expect(link).toHaveAttribute('href', 'https://docs.google.com/document/d/abc');
    expect(screen.queryByTitle('How we grade resumes')).not.toBeInTheDocument();
  });

  it('cannot be dismissed with Escape', async () => {
    apiClient.get.mockResolvedValue({ required: true, cycleId: 'c1', tutorials: [TUTORIAL] });
    const onOpenDocument = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenDocument).not.toHaveBeenCalled();
  });

  it('stays open and says so when saving the completion fails', async () => {
    apiClient.get.mockResolvedValue({ required: true, cycleId: 'c1', tutorials: [TUTORIAL] });
    apiClient.post.mockRejectedValue(new Error('Network down'));
    const onOpenDocument = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    fireEvent.click(await screen.findByLabelText('I watched the whole tutorial'));
    fireEvent.click(screen.getByRole('button', { name: 'Start grading' }));

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenDocument).not.toHaveBeenCalled();
  });

  it('opens the document straight away when the gate is already clear', async () => {
    apiClient.get.mockResolvedValue({ required: false, cycleId: 'c1', tutorials: [] });
    const onOpenDocument = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lets the document through when the gate cannot be checked', async () => {
    apiClient.get.mockRejectedValue(new Error('500'));
    const onOpenDocument = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// My Interviews and Run a session start interviews of every round from one page, so
// the category arrives with each click rather than with the hook.
function InterviewsPage({ onStart }) {
  const gate = useTutorialGate();
  return (
    <>
      <button onClick={() => gate.run(() => onStart('coffee'), 'COFFEE_CHATS')}>Coffee chat</button>
      <button onClick={() => gate.run(() => onStart('final'), 'FINAL_ROUND')}>Final round</button>
      <button onClick={() => gate.run(() => onStart('delibs'), null)}>Deliberations</button>
      {gate.dialog}
    </>
  );
}

describe('useTutorialGate with a category per click', () => {
  it("gates each round on that round's tutorials and records that round", async () => {
    apiClient.get.mockResolvedValue({
      required: true,
      cycleId: 'c1',
      tutorials: [{ ...TUTORIAL, title: 'Running a Coffee Chat' }],
    });
    const onStart = vi.fn();
    render(<InterviewsPage onStart={onStart} />);

    fireEvent.click(screen.getByRole('button', { name: 'Coffee chat' }));
    expect(await screen.findByText(/before you run a coffee chat/)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/member/help/tutorial-gates/COFFEE_CHATS');

    fireEvent.click(screen.getByLabelText('I watched the whole tutorial'));
    fireEvent.click(screen.getByRole('button', { name: 'Start the interview' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith('coffee'));
    expect(apiClient.post).toHaveBeenCalledWith('/member/help/tutorial-gates/COFFEE_CHATS/complete');
  });

  it('asks about the round that was clicked', async () => {
    apiClient.get.mockResolvedValue({ required: false, cycleId: 'c1', tutorials: [] });
    const onStart = vi.fn();
    render(<InterviewsPage onStart={onStart} />);

    fireEvent.click(screen.getByRole('button', { name: 'Final round' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith('final'));
    expect(apiClient.get).toHaveBeenLastCalledWith('/member/help/tutorial-gates/FINAL_ROUND');
  });

  it('lets an interview with no tutorial category straight through, without asking', async () => {
    const onStart = vi.fn();
    render(<InterviewsPage onStart={onStart} />);

    fireEvent.click(screen.getByRole('button', { name: 'Deliberations' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith('delibs'));
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});
