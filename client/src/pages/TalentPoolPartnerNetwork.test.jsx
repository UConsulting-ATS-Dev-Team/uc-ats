import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TalentPoolPartnerNetwork from './TalentPoolPartnerNetwork';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../components/TalentPoolClients', () => ({ default: () => null }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));

const applicant = (id, firstName, talentPoolOptIn) => ({
  id,
  firstName,
  lastName: 'Doe',
  email: `${firstName.toLowerCase()}@example.com`,
  major1: 'Econ',
  graduationYear: '2030',
  talentPoolOptIn,
  submittedAt: '2026-08-01T00:00:00.000Z',
  resumeUrl: null,
  cycle: { name: 'Fall 2026' },
});

const STATS = {
  cycles: [{ id: 'cycle-1', name: 'Fall 2026', isActive: true }],
  selectedCycleId: 'cycle-1',
  optIn: { total: 3, optedIn: 1, optedOut: 1, noAnswer: 1 },
  applicants: [
    applicant('app-1', 'Jane', true),
    applicant('app-2', 'Ada', false),
    applicant('app-3', 'Grace', null),
  ],
  deduplicated: false,
  duplicatesCollapsed: 0,
  totalApplications: 3,
  resumesUpdatedRecently: null,
  registeredClients: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
  apiClient.get = vi.fn(() => Promise.resolve(structuredClone(STATS)));
  apiClient.patch = vi.fn((_url, body) =>
    Promise.resolve({ id: 'app-1', talentPoolOptIn: body.talentPoolOptIn })
  );
});

// The roster defaults to the "Opted in" segment.
const showAll = async (user) => {
  await user.click(await screen.findByRole('button', { name: /^All/ }));
};

const rowFor = (name) => screen.getByText(new RegExp(`${name} Doe`)).closest('tr');

const renderPage = async () => {
  const user = userEvent.setup();
  render(<TalentPoolPartnerNetwork />);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
  return user;
};

describe('TalentPoolPartnerNetwork - editing opt-in', () => {
  it('shows the opt-in control on every segment, not just All', async () => {
    await renderPage();
    // Default segment is "Opted in", and the control is present there.
    await waitFor(() => expect(screen.getByText(/Jane Doe/)).toBeInTheDocument());
    expect(
      within(rowFor('Jane')).getByLabelText('Talent Partner Network opt-in')
    ).toBeInTheDocument();
  });

  it('renders each applicant’s current state', async () => {
    const user = await renderPage();
    await showAll(user);

    expect(within(rowFor('Jane')).getByText('Opted in')).toBeInTheDocument();
    expect(within(rowFor('Ada')).getByText('Opted out')).toBeInTheDocument();
    expect(within(rowFor('Grace')).getByText('No answer')).toBeInTheDocument();
  });

  it('saves a change through the admin endpoint', async () => {
    const user = await renderPage();
    await showAll(user);

    await user.click(within(rowFor('Grace')).getByLabelText('Talent Partner Network opt-in'));
    await user.click(await screen.findByRole('option', { name: 'Opted in' }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/admin/talent-pool/applicants/app-3/opt-in',
        { talentPoolOptIn: true }
      )
    );
  });

  // null is a real state, so it has to survive the round trip as null rather
  // than being dropped as a missing field.
  it('can set an applicant back to "No answer"', async () => {
    const user = await renderPage();
    await showAll(user);

    await user.click(within(rowFor('Jane')).getByLabelText('Talent Partner Network opt-in'));
    await user.click(await screen.findByRole('option', { name: 'No answer' }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/admin/talent-pool/applicants/app-1/opt-in',
        { talentPoolOptIn: null }
      )
    );
  });

  it('can mark someone as opted out', async () => {
    const user = await renderPage();
    await showAll(user);

    await user.click(within(rowFor('Grace')).getByLabelText('Talent Partner Network opt-in'));
    await user.click(await screen.findByRole('option', { name: 'Opted out' }));

    await waitFor(() =>
      expect(apiClient.patch.mock.calls[0][1]).toEqual({ talentPoolOptIn: false })
    );
  });

  it('confirms the change', async () => {
    const user = await renderPage();
    await showAll(user);

    await user.click(within(rowFor('Grace')).getByLabelText('Talent Partner Network opt-in'));
    await user.click(await screen.findByRole('option', { name: 'Opted in' }));

    expect(await screen.findByText(/Grace Doe set to "Opted in"/)).toBeInTheDocument();
  });

  // The segment chips are counted off the same array the table renders, so a
  // change has to move the counts too or the two drift apart.
  it('updates the segment counts without refetching', async () => {
    const user = await renderPage();
    await showAll(user);
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    await user.click(within(rowFor('Grace')).getByLabelText('Talent Partner Network opt-in'));
    await user.click(await screen.findByRole('option', { name: 'Opted in' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Opted in: 2/ })).toBeInTheDocument()
    );
    // This chip is Tooltip-wrapped, so its accessible name is the hint text.
    expect(screen.getByText('No answer: 0')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure and leaves the displayed value alone', async () => {
    apiClient.patch = vi.fn(() => Promise.reject(new Error('Failed to update opt-in')));
    const user = await renderPage();
    await showAll(user);

    await user.click(within(rowFor('Grace')).getByLabelText('Talent Partner Network opt-in'));
    await user.click(await screen.findByRole('option', { name: 'Opted in' }));

    expect(await screen.findByText(/Failed to update opt-in/)).toBeInTheDocument();
    expect(within(rowFor('Grace')).getByText('No answer')).toBeInTheDocument();
  });
});
