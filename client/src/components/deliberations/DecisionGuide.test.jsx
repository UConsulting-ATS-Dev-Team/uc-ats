// The reviewer's half of the decision guide: the note is visible without
// asking, the criteria are one click away, and a guide that fails to load never
// takes the interview form down with it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import decisionGuideApi from '../../utils/decisionGuideApi';
import { DecisionGuideButton, DecisionGuidePanel, DeliberationNotice, useDecisionGuide } from './DecisionGuide';

vi.mock('../../utils/decisionGuideApi', () => ({
  default: { forPhase: vi.fn() }
}));

const guide = {
  phase: 'firstRound',
  phaseLabel: 'First Round',
  intro: 'Deliberation is a discussion, not a calculation.',
  decisions: [
    { value: 'YES', label: 'Yes', criteria: 'You would advance them as they stand.', source: 'default' },
    { value: 'MAYBE_YES', label: 'Maybe-Yes', criteria: 'You lean toward advancing.', source: 'default' },
    { value: 'MAYBE_NO', label: 'Maybe-No', criteria: 'You lean toward not advancing.', source: 'general' },
    { value: 'NO', label: 'No', criteria: 'You would not advance them.', source: 'firstRound' }
  ],
  customized: true
};

// Stands in for an interview page: loads the guide, shows the note, and opens
// the panel from either the note or the icon beside the picker.
function Harness({ phase = 'firstRound' }) {
  const { guide: loaded, open, openGuide, closeGuide } = useDecisionGuide(phase);
  return (
    <>
      <DeliberationNotice guide={loaded} onOpen={openGuide} />
      <DecisionGuideButton guide={loaded} onClick={openGuide} />
      <DecisionGuidePanel open={open} guide={loaded} onClose={closeGuide} />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  decisionGuideApi.forPhase.mockResolvedValue({ guide });
});

describe('DeliberationNotice', () => {
  it('shows the note for the round without being asked', async () => {
    render(<Harness />);

    expect(await screen.findByTestId('deliberation-notice')).toHaveTextContent(
      'Deliberation is a discussion, not a calculation.'
    );
    expect(decisionGuideApi.forPhase).toHaveBeenCalledWith('firstRound');
  });

  it('asks for nothing until the page knows which round it is', () => {
    render(<Harness phase={null} />);
    expect(decisionGuideApi.forPhase).not.toHaveBeenCalled();
    expect(screen.queryByTestId('deliberation-notice')).not.toBeInTheDocument();
  });

  it('leaves the page alone when the guide cannot be loaded', async () => {
    decisionGuideApi.forPhase.mockRejectedValue(new Error('offline'));
    render(<Harness />);

    await waitFor(() => expect(decisionGuideApi.forPhase).toHaveBeenCalled());
    expect(screen.queryByTestId('deliberation-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-guide-button')).not.toBeInTheDocument();
  });
});

describe('DecisionGuidePanel', () => {
  it('opens from the note and describes all four decisions', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByTestId('open-decision-guide'));

    const panel = await screen.findByTestId('decision-guide-panel');
    expect(panel).toHaveTextContent('First Round');
    for (const { value, label, criteria } of guide.decisions) {
      expect(screen.getByTestId(`decision-criteria-${value}`)).toHaveTextContent(label);
      expect(screen.getByTestId(`decision-criteria-${value}`)).toHaveTextContent(criteria);
    }
  });

  it('opens from the icon beside the picker too', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByTestId('decision-guide-button'));
    expect(await screen.findByTestId('decision-guide-panel')).toBeInTheDocument();
  });

  it('says nothing about decisions the picker does not offer', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByTestId('open-decision-guide'));
    await screen.findByTestId('decision-guide-panel');
    expect(screen.queryByTestId('decision-criteria-UNSURE')).not.toBeInTheDocument();
  });

  it('skips a decision an admin left blank rather than showing an empty heading', async () => {
    decisionGuideApi.forPhase.mockResolvedValue({
      guide: { ...guide, decisions: guide.decisions.map((d) => (d.value === 'MAYBE_NO' ? { ...d, criteria: '' } : d)) }
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByTestId('open-decision-guide'));
    await screen.findByTestId('decision-guide-panel');
    expect(screen.queryByTestId('decision-criteria-MAYBE_NO')).not.toBeInTheDocument();
    expect(screen.getByTestId('decision-criteria-YES')).toBeInTheDocument();
  });

  it('closes again', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(await screen.findByTestId('open-decision-guide'));
    await user.click(await screen.findByLabelText('Close decision guide'));

    await waitFor(() => expect(screen.queryByTestId('decision-guide-panel')).not.toBeInTheDocument());
  });
});
