// The admin half: an inherited field stays empty so it keeps inheriting, the
// wording it inherits is visible as a placeholder, saving sends what is on
// screen, and Reset is only offered where there is something of its own to drop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import decisionGuideApi from '../../utils/decisionGuideApi';
import DecisionGuideEditorDialog from './DecisionGuideEditorDialog';

vi.mock('../../utils/decisionGuideApi', () => ({
  default: { all: vi.fn(), save: vi.fn(), reset: vi.fn() }
}));

const decisions = (criteria = {}) => [
  { value: 'YES', label: 'Yes', criteria: criteria.YES ?? 'Default yes.', source: 'default' },
  { value: 'MAYBE_YES', label: 'Maybe-Yes', criteria: criteria.MAYBE_YES ?? 'Default maybe-yes.', source: 'default' },
  { value: 'MAYBE_NO', label: 'Maybe-No', criteria: criteria.MAYBE_NO ?? 'Default maybe-no.', source: 'default' },
  { value: 'NO', label: 'No', criteria: criteria.NO ?? 'Default no.', source: 'default' }
];

const payload = ({ customized = false, stored = null } = {}) => ({
  phases: ['general', 'resume', 'coffee', 'firstRound', 'final'],
  guides: {
    general: { phase: 'general', phaseLabel: 'All rounds', intro: 'Shipped note.', introSource: 'default', decisions: decisions(), customized: false, stored: null },
    resume: { phase: 'resume', phaseLabel: 'Resume Review', intro: 'Shipped note.', introSource: 'default', decisions: decisions(), customized: false, stored: null },
    coffee: { phase: 'coffee', phaseLabel: 'Coffee Chat', intro: 'Shipped note.', introSource: 'default', decisions: decisions(), customized: false, stored: null },
    firstRound: {
      phase: 'firstRound',
      phaseLabel: 'First Round',
      intro: 'Shipped note.',
      introSource: 'default',
      decisions: decisions(),
      customized,
      stored
    },
    final: { phase: 'final', phaseLabel: 'Final Round', intro: 'Shipped note.', introSource: 'default', decisions: decisions(), customized: false, stored: null }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  decisionGuideApi.all.mockResolvedValue(payload());
  decisionGuideApi.save.mockResolvedValue(payload({ customized: true, stored: { intro: 'Ours.', criteria: {} } }));
  decisionGuideApi.reset.mockResolvedValue(payload());
});

const open = (props = {}) => render(
  <DecisionGuideEditorDialog open phase="firstRound" onClose={vi.fn()} onSaved={vi.fn()} {...props} />
);

it('opens on the round the admin was looking at', async () => {
  open();
  expect(await screen.findByText(/has no wording of its own/)).toHaveTextContent('First Round');
});

// The bug this guards: seeding an inherited field with the text it inherits
// means the first save copies that text into the round, and later edits to
// "All rounds" stop reaching it.
it('leaves an inherited round\'s fields empty so they keep inheriting', async () => {
  open();
  await screen.findByText(/has no wording of its own/);

  const fields = screen.getAllByRole('textbox');
  expect(fields).toHaveLength(5);
  for (const field of fields) expect(field).toHaveValue('');
});

it('shows the inherited wording as a placeholder so it is not invisible', async () => {
  open();
  await screen.findByText(/has no wording of its own/);

  expect(screen.getByPlaceholderText('Shipped note.')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Default yes.')).toBeInTheDocument();
});

it('saves an untouched inherited round as blanks, not as a frozen copy', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByText(/has no wording of its own/);
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(decisionGuideApi.save).toHaveBeenCalledTimes(1));
  const [, body] = decisionGuideApi.save.mock.calls[0];
  expect(body.intro).toBe('');
  expect(Object.values(body.criteria)).toEqual(['', '', '', '']);
});

it('copies the inherited wording in when the admin asks for it', async () => {
  const user = userEvent.setup();
  open();
  await screen.findByText(/has no wording of its own/);
  await user.click(screen.getByTestId('copy-inherited'));

  expect(screen.getByDisplayValue('Shipped note.')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Default yes.')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(decisionGuideApi.save).toHaveBeenCalled());
  expect(decisionGuideApi.save.mock.calls[0][1].intro).toBe('Shipped note.');
});

it('seeds a round that does have its own wording from what it stores', async () => {
  decisionGuideApi.all.mockResolvedValue(payload({
    customized: true,
    stored: { intro: 'Ours.', criteria: { YES: 'Our yes.', MAYBE_YES: '', MAYBE_NO: '', NO: '' } }
  }));
  open();

  expect(await screen.findByDisplayValue('Ours.')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Our yes.')).toBeInTheDocument();
  // The three it never overrode stay empty and keep inheriting.
  expect(screen.getByPlaceholderText('Default no.')).toHaveValue('');
});

it('sends the edited copy for the selected round only', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  open({ onSaved });

  await screen.findByText(/has no wording of its own/);
  await user.type(screen.getByPlaceholderText('Shipped note.'), 'Our note.');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(decisionGuideApi.save).toHaveBeenCalledTimes(1));
  const [phase, body] = decisionGuideApi.save.mock.calls[0];
  expect(phase).toBe('firstRound');
  expect(body.intro).toBe('Our note.');
  expect(Object.keys(body.criteria)).toEqual(['YES', 'MAYBE_YES', 'MAYBE_NO', 'NO']);
  expect(onSaved).toHaveBeenCalled();
});

it('offers Reset only once a round has wording of its own', async () => {
  open();
  await screen.findByText(/has no wording of its own/);
  expect(screen.queryByRole('button', { name: /Reset/ })).not.toBeInTheDocument();

  decisionGuideApi.all.mockResolvedValue(payload({ customized: true, stored: { intro: 'Ours.', criteria: {} } }));
  open();
  expect(await screen.findByRole('button', { name: /Reset/ })).toBeInTheDocument();
});

it('drops a round back to inheriting', async () => {
  decisionGuideApi.all.mockResolvedValue(payload({ customized: true, stored: { intro: 'Ours.', criteria: {} } }));
  const user = userEvent.setup();
  open();

  await user.click(await screen.findByRole('button', { name: /Reset/ }));
  await waitFor(() => expect(decisionGuideApi.reset).toHaveBeenCalledWith('firstRound'));
});

it('blocks a save that is over the length the server accepts', async () => {
  const user = userEvent.setup();
  open();

  await screen.findByText(/has no wording of its own/);
  // Typing 2001 characters takes far too long; paste instead.
  await user.click(screen.getByPlaceholderText('Shipped note.'));
  await user.paste('x'.repeat(2001));

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(decisionGuideApi.save).not.toHaveBeenCalled();
});

it('surfaces a failed save instead of pretending it worked', async () => {
  decisionGuideApi.save.mockRejectedValue(Object.assign(new Error('nope'), { serverMessage: 'Not allowed' }));
  const user = userEvent.setup();
  const onSaved = vi.fn();
  open({ onSaved });

  await screen.findByText(/has no wording of its own/);
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Not allowed')).toBeInTheDocument();
  expect(onSaved).not.toHaveBeenCalled();
});
