import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RubricEditorDialog, { validateCriteria } from './RubricEditorDialog';
import liveVoteApi from '../../utils/liveVoteApi';

vi.mock('../../utils/liveVoteApi', () => ({ default: { rubrics: vi.fn(), saveRubric: vi.fn() } }));

beforeEach(() => {
  liveVoteApi.rubrics.mockReset().mockResolvedValue({
    rubrics: { coffee: { criteria: [{ id: 'c1', title: 'Curiosity', description: 'Strong: asks follow-ups' }] } }
  });
  liveVoteApi.saveRubric.mockReset().mockResolvedValue({ phase: 'coffee', criteria: [] });
});

describe('RubricEditorDialog', () => {
  it("loads the round's rubric, adds a criterion and saves it", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<RubricEditorDialog open phase="coffee" phaseLabel="Coffee Chats" onClose={onClose} onSaved={onSaved} />);

    expect(await screen.findByDisplayValue('Curiosity')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /add criterion/i }));
    await userEvent.type(screen.getByLabelText('Criterion 2'), '  Communication ');
    await userEvent.click(screen.getByRole('button', { name: /save rubric/i }));

    await waitFor(() => expect(liveVoteApi.saveRubric).toHaveBeenCalled());
    const [phase, criteria] = liveVoteApi.saveRubric.mock.calls[0];
    expect(phase).toBe('coffee');
    expect(criteria.map((c) => c.title)).toEqual(['Curiosity', 'Communication']);
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses to save a criterion without a title', async () => {
    render(<RubricEditorDialog open phase="coffee" phaseLabel="Coffee Chats" onClose={vi.fn()} />);
    await screen.findByDisplayValue('Curiosity');
    await userEvent.click(screen.getByRole('button', { name: /add criterion/i }));
    await userEvent.click(screen.getByRole('button', { name: /save rubric/i }));
    expect(await screen.findByText('Criterion 2 needs a title.')).toBeInTheDocument();
    expect(liveVoteApi.saveRubric).not.toHaveBeenCalled();
  });

  it('in session mode hands the edit back instead of saving', async () => {
    const onSaved = vi.fn();
    render(
      <RubricEditorDialog
        open
        mode="session"
        phase="coffee"
        phaseLabel="Coffee Chats"
        initialCriteria={[{ id: 'c1', title: 'Curiosity', description: '' }]}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /remove criterion 1/i }));
    await userEvent.click(screen.getByLabelText(/also save as the default/i));
    await userEvent.click(screen.getByRole('button', { name: /use this rubric/i }));
    expect(onSaved).toHaveBeenCalledWith({ criteria: [], saveAsDefault: false });
    expect(liveVoteApi.rubrics).not.toHaveBeenCalled();
    expect(liveVoteApi.saveRubric).not.toHaveBeenCalled();
  });
});

describe('validateCriteria', () => {
  it('caps the rubric at twenty criteria', () => {
    expect(validateCriteria(Array.from({ length: 21 }, () => ({ title: 'x' })))).toMatch(/at most 20/);
    expect(validateCriteria([{ title: 'ok' }])).toBeNull();
  });
});
