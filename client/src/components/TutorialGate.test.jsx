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

    // The next document opens straight away.
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(2));
    expect(apiClient.get).toHaveBeenCalledTimes(1);
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
