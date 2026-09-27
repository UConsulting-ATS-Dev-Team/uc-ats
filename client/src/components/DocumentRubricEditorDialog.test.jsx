// The admin's side: the editor says what a range change does to the Staging
// ranking, warns before leaving this cycle's scores out of range, and saves
// only once the admin says so.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import DocumentRubricEditorDialog, { draftProblem, labelsOutsideRange } from './DocumentRubricEditorDialog';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }
}));

const category = (id, title, min, max) => ({
  id, title, description: '', min, max, criteria: [{ label: String(min), text: 'Low' }]
});

const response = (resumeMax = 10) => {
  const resume = { categories: [category('scoreOne', 'Content', 1, resumeMax), category('scoreTwo', 'Structure', 1, 3)] };
  return {
    rubrics: {
      resume: { type: 'resume', rubric: resume, maxOverall: resumeMax + 3, customized: false },
      coverLetter: {
        type: 'coverLetter',
        rubric: { categories: ['scoreOne', 'scoreTwo', 'scoreThree'].map((id) => category(id, id, 1, 3)) },
        maxOverall: 3,
        customized: false
      },
      video: { type: 'video', rubric: { categories: [category('scoreOne', 'Video', 0, 2)] }, maxOverall: 2, customized: false }
    },
    participationMax: 3,
    stagingMax: resumeMax + 3 + 3 + 2 + 3
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockResolvedValue(response());
});

const openEditor = async () => {
  render(<DocumentRubricEditorDialog open onClose={vi.fn()} />);
  await screen.findByDisplayValue('Content');
};

const contentMax = () => screen.getAllByLabelText('Max')[0];

describe('DocumentRubricEditorDialog', () => {
  it('shows how much of the Staging total the document is worth, as the range changes', async () => {
    await openEditor();
    const info = screen.getByText(/counts for up to/);
    expect(info).toHaveTextContent('Resume counts for up to 13 of the 21-point overall');

    fireEvent.change(contentMax(), { target: { value: '20' } });
    expect(screen.getByText(/counts for up to/)).toHaveTextContent('up to 23 of the 31-point overall');
  });

  it('warns about out-of-range scores and saves only on "Save anyway"', async () => {
    apiClient.post.mockResolvedValue({ outOfRange: { count: 4, cycleName: 'Fall 2026' } });
    apiClient.put.mockResolvedValue(response(8));
    await openEditor();

    fireEvent.change(contentMax(), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const warning = await screen.findByText(/fall outside the new range/);
    expect(warning).toHaveTextContent('4 resume scores in Fall 2026 fall outside the new range');
    expect(apiClient.put).not.toHaveBeenCalled();

    fireEvent.click(within(warning.closest('[role="alert"]')).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith(
      '/document-rubrics/resume',
      { rubric: expect.objectContaining({ categories: expect.arrayContaining([expect.objectContaining({ id: 'scoreOne', max: 8 })]) }) }
    ));
    expect(await screen.findByText(/Resume rubric saved/)).toBeInTheDocument();
  });

  it('saves straight away when nothing falls out of range', async () => {
    apiClient.post.mockResolvedValue({ outOfRange: { count: 0, cycleName: 'Fall 2026' } });
    apiClient.put.mockResolvedValue(response(12));
    await openEditor();

    fireEvent.change(contentMax(), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalled());
  });

  it('keeps Save off until something changes', async () => {
    await openEditor();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('labelsOutsideRange', () => {
  const rows = (...labels) => labels.map((label) => ({ label, text: 'x' }));

  it('names criteria left over from a wider range', () => {
    expect(labelsOutsideRange({ min: '1', max: '8', criteria: rows('1-3', '4-6', '7-10') })).toEqual(['7-10']);
    expect(labelsOutsideRange({ min: '1', max: '3', criteria: rows('0', '2') })).toEqual(['0']);
  });

  it('leaves free-text labels alone', () => {
    expect(labelsOutsideRange({ min: '1', max: '3', criteria: rows('N/A', 'Top marks') })).toEqual([]);
  });
});

describe('draftProblem', () => {
  const draft = (changes) => ({
    categories: [{ id: 'scoreOne', title: 'Video', description: '', min: '0', max: '2', criteria: [], ...changes }]
  });

  it('accepts a valid draft', () => {
    expect(draftProblem(draft({}))).toBeNull();
  });

  it('names what is wrong', () => {
    expect(draftProblem(draft({ max: '0' }))).toMatch(/maximum must be above its minimum/);
    expect(draftProblem(draft({ max: '2.5' }))).toMatch(/whole numbers/);
    expect(draftProblem(draft({ title: ' ' }))).toMatch(/needs a title/);
    expect(draftProblem(draft({ criteria: [{ label: '1', text: '' }] }))).toMatch(/both a score and a description/);
  });
});
