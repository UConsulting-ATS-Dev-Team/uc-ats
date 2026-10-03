import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AllCandidatesTable from './AllCandidatesTable';

const doc = (avg, extra = {}) => ({ has: true, avg, n: 3, outliers: 0, split: false, overridden: false, ...extra });
const candidates = [
  {
    applicationId: 'a1', name: 'Alex Low', major: 'Econ', locked: false, total: 9, outlierCount: 1, splitDocs: 0,
    resumeDecision: null, perDoc: { resume: doc(6, { overridden: true }), coverLetter: doc(2), video: doc(1) }
  },
  {
    applicationId: 'a2', name: 'Blair High', major: 'Math', locked: false, total: 15, outlierCount: 0, splitDocs: 1,
    resumeDecision: 'yes', perDoc: { resume: doc(11), coverLetter: doc(3), video: doc(1) }
  },
  { applicationId: 'a3', name: 'Casey Sealed', locked: true }
];

const names = () => screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent);

describe('AllCandidatesTable', () => {
  it('ranks by total, sealed last, and shows decisions and disagreements', () => {
    render(<AllCandidatesTable candidates={candidates} canOpen={false} onOpen={vi.fn()} />);
    expect(names()).toEqual(['Blair HighMath', 'Alex LowEcon', 'Casey Sealed']);
    expect(screen.getByText('1 outlier')).toBeInTheDocument();
    expect(screen.getByText('1 split')).toBeInTheDocument();
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('keeps sealed candidates last when a column sorts ascending', async () => {
    render(<AllCandidatesTable candidates={candidates} canOpen={false} onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Total' })); // descending → ascending
    expect(names()).toEqual(['Alex LowEcon', 'Blair HighMath', 'Casey Sealed']);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(names().at(-1)).toBe('Casey Sealed');
  });

  it('lets an admin open a candidate for the room, but not a sealed one', async () => {
    const onOpen = vi.fn();
    render(<AllCandidatesTable candidates={candidates} canOpen onOpen={onOpen} />);
    await userEvent.click(screen.getByText('Alex Low'));
    expect(onOpen).toHaveBeenCalledWith('a1');
    await userEvent.click(screen.getByText('Casey Sealed'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a member clicks, and highlights the row the admin opened', async () => {
    const onOpen = vi.fn();
    render(<AllCandidatesTable candidates={candidates} currentApplicationId="a2" canOpen={false} onOpen={onOpen} />);
    await userEvent.click(screen.getByText('Alex Low'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Blair High').closest('tr')).toHaveAttribute('aria-selected', 'true');
  });
});
