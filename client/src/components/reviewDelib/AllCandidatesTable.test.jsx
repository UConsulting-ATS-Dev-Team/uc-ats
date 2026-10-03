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
  it('ranks by documents total when rows have no overall, sealed last, and shows decisions and disagreements', () => {
    render(<AllCandidatesTable candidates={candidates} canOpen={false} onOpen={vi.fn()} />);
    expect(names()).toEqual(['Blair HighMath', 'Alex LowEcon', 'Casey Sealed']);
    expect(screen.getByText('1 outlier')).toBeInTheDocument();
    expect(screen.getByText('1 split')).toBeInTheDocument();
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('keeps sealed candidates last when a column sorts ascending', async () => {
    render(<AllCandidatesTable candidates={candidates} canOpen={false} onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Docs total' })); // descending
    await userEvent.click(screen.getByRole('button', { name: 'Docs total' })); // → ascending
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

  it('ranks by the overall Staging uses, beside the documents-only total', async () => {
    const withOverall = [
      { ...candidates[0], participation: 3, overall: 12 },
      { ...candidates[1], total: 11, participation: 0, overall: 11 },
      { ...candidates[0], applicationId: 'a4', name: 'Dana Mid', total: 10, participation: 3, overall: 13 }
    ];
    render(<AllCandidatesTable candidates={withOverall} canOpen={false} onOpen={vi.fn()} />);
    // Participation lifts Dana and Alex past Blair, who leads on documents alone.
    expect(names()).toEqual(['Dana MidEcon', 'Alex LowEcon', 'Blair HighMath']);
    const dana = screen.getByText('Dana Mid').closest('tr');
    expect(within(dana).getByText('10')).toBeInTheDocument();
    expect(within(dana).getByText('13')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Docs total' }));
    expect(names()).toEqual(['Blair HighMath', 'Dana MidEcon', 'Alex LowEcon']);
  });

  it("adds Staging's rank, best first when sorted, unranked and sealed rows last", async () => {
    const ranked = [
      { ...candidates[0], overall: 12, rank: 2 },
      { ...candidates[1], overall: 15, rank: 1 },
      { ...candidates[0], applicationId: 'a4', name: 'Dana None', total: 0, overall: 0, rank: null },
      candidates[2]
    ];
    render(<AllCandidatesTable candidates={ranked} rankedCount={240} canOpen={false} onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rank' }));
    expect(names()).toEqual(['Blair HighMath', 'Alex LowEcon', 'Dana NoneEcon', 'Casey Sealed']);
    expect(screen.getByLabelText('Not scored yet')).toBeInTheDocument();
    // The sealed row still spans every column after the name.
    expect(screen.getByText('Sealed').closest('td')).toHaveAttribute('colspan', '8');

    const rankCell = within(screen.getByText('Blair High').closest('tr')).getAllByRole('cell')[6];
    await userEvent.hover(within(rankCell).getByText('1'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('1st of 240 scored');
  });

  it('keeps unranked and ungraded rows last whichever way a column sorts', async () => {
    const rows = [
      { ...candidates[0], applicationId: 'n1', name: 'Nobody Graded', total: null, overall: null, rank: null, perDoc: { resume: doc(null), coverLetter: doc(null), video: doc(null) } },
      { ...candidates[0], overall: 12, rank: 2 },
      { ...candidates[1], overall: 15, rank: 1 },
      candidates[2]
    ];
    render(<AllCandidatesTable candidates={rows} rankedCount={2} canOpen={false} onOpen={vi.fn()} />);
    const first = ['Blair HighMath', 'Alex LowEcon'];

    for (const column of ['Rank', 'Overall', 'Docs total', 'Resume']) {
      await userEvent.click(screen.getByRole('button', { name: column }));
      const once = names();
      await userEvent.click(screen.getByRole('button', { name: column }));
      const twice = names();
      for (const order of [once, twice]) {
        expect(order.slice(-2)).toEqual(['Nobody GradedEcon', 'Casey Sealed']);
      }
      // The two directions are each other's reverse among the scored rows.
      expect([...once.slice(0, 2)].reverse()).toEqual(twice.slice(0, 2));
      expect([once.slice(0, 2), twice.slice(0, 2)]).toContainEqual(first);
    }
  });
});
