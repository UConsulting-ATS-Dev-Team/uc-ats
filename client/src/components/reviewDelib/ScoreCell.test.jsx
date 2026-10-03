import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ScoreCell from './ScoreCell';

const row = (overrides = {}) => ({
  scoreId: 's1',
  evaluatorName: 'Mia Member',
  onTeam: true,
  overall: 4,
  admin: null,
  effective: 4,
  flag: 'outlier',
  rawFlag: 'outlier',
  deviation: -5,
  othersMean: 9,
  ...overrides
});

describe('ScoreCell', () => {
  it('marks an outlier with how far it sits from the other graders', () => {
    render(<ScoreCell row={row()} max={13} canEdit={false} onSave={vi.fn()} />);
    expect(screen.getByText('Outlier')).toBeInTheDocument();
    expect(screen.getByText('−5 vs others’ 9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /override/i })).not.toBeInTheDocument();
  });

  it('shows an override beside the grade it replaces, and that it resolved the outlier', () => {
    render(<ScoreCell row={row({ admin: 8, effective: 8, flag: null })} max={13} canEdit={false} onSave={vi.fn()} />);
    expect(screen.getByText('4')).toHaveStyle({ textDecoration: 'line-through' });
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('Resolved by override')).toBeInTheDocument();
  });

  it('lets an admin set an override, and refuses one out of range', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<ScoreCell row={row()} max={13} canEdit onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: "Override Mia Member's score" }));
    const input = screen.getByRole('spinbutton', { name: 'Override score for Mia Member' });
    await userEvent.clear(input);
    await userEvent.type(input, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a score from 0 to 13')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, '8.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(8.5);
  }, 20000);

  it('clears an override by saving null', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<ScoreCell row={row({ admin: 8, effective: 8, flag: null })} max={13} canEdit onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: "Override Mia Member's score" }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear override' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
