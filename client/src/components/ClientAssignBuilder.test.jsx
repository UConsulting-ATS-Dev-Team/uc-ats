import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientAssignBuilder from './ClientAssignBuilder';
import apiClient from '../utils/api';

const client = { id: 'partner-1', organization: 'Acme Recruiting', visibility: 'BASIC' };

const FIELDS = [
  { key: 'graduationYear', label: 'Graduation year', pool: 'both', type: 'multiText' },
  { key: 'gender', label: 'Gender', pool: 'both', type: 'multiText' },
  { key: 'cumulativeGpa', label: 'Cumulative GPA', pool: 'applicants', type: 'number' },
];

const OPTIONS = {
  graduationYear: ['2029', '2030'],
  gender: ['Female', 'Male', 'Other'],
};

const previewRows = [
  { key: 'APPLICATION:app-1', kind: 'APPLICANT', name: 'Jane Doe', graduationYear: '2030', major1: 'Econ', gender: 'Female', alreadyAssigned: false },
  { key: 'APPLICATION:app-2', kind: 'APPLICANT', name: 'Ada Lovelace', graduationYear: '2030', major1: 'CS', gender: 'Female', alreadyAssigned: false },
  { key: 'APPLICATION:app-3', kind: 'APPLICANT', name: 'Grace Hopper', graduationYear: '2030', major1: 'Math', gender: 'Female', alreadyAssigned: true },
];

const mockApi = (previewOverrides = {}) => {
  apiClient.get = vi.fn(() => Promise.resolve({ fields: FIELDS, options: OPTIONS }));
  apiClient.post = vi.fn((url) => {
    if (url.includes('/preview')) {
      return Promise.resolve({
        rows: previewRows,
        total: previewRows.length,
        truncated: false,
        excluded: { noOptIn: 4, noBlindResume: 0, memberNoConsent: 0 },
        notes: [],
        visibility: 'BASIC',
        ...previewOverrides,
      });
    }
    return Promise.resolve({ batchId: 'batch-1', created: 2, skipped: [] });
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

const setUpPreview = async () => {
  const user = userEvent.setup();
  render(<ClientAssignBuilder client={client} onDone={vi.fn()} />);

  await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

  await user.click(screen.getByLabelText('Field'));
  await user.click(await screen.findByRole('option', { name: /Graduation year/ }));

  await user.click(screen.getByRole('button', { name: /preview matches/i }));
  await screen.findByText(/3 matches/i);
  return user;
};

describe('ClientAssignBuilder', () => {
  it('posts the filter rows to preview', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ClientAssignBuilder client={client} onDone={vi.fn()} />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    await user.click(screen.getByLabelText('Field'));
    await user.click(await screen.findByRole('option', { name: /Gender/ }));
    await user.click(screen.getByRole('button', { name: /preview matches/i }));

    await waitFor(() => {
      const call = apiClient.post.mock.calls.find(([url]) => url.includes('/preview'));
      expect(call[1].filter.rows[0].field).toBe('gender');
    });
  });

  it('surfaces how many rows the opt-in gate excluded', async () => {
    mockApi();
    await setUpPreview();
    expect(
      screen.getByText(/4 did not opt in to the Talent Partner Network/i)
    ).toBeInTheDocument();
  });

  it('pre-selects eligible rows but not ones already shared', async () => {
    mockApi();
    await setUpPreview();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText(/Already shared/i)).toBeInTheDocument();
  });

  it('sends only the rows left checked, so the trim is what gets assigned', async () => {
    mockApi();
    const user = await setUpPreview();

    // Untick Jane Doe.
    const janeRow = screen.getByText('Jane Doe').closest('tr');
    await user.click(within(janeRow).getByRole('checkbox'));

    await user.click(screen.getByRole('button', { name: /assign 1 resume/i }));

    await waitFor(() => {
      const call = apiClient.post.mock.calls.find(([url]) => url.includes('/assign'));
      expect(call[1].keys).toEqual(['APPLICATION:app-2']);
    });
  });

  it('cannot select a row that is already shared with this client', async () => {
    mockApi();
    await setUpPreview();
    const graceRow = screen.getByText('Grace Hopper').closest('tr');
    expect(within(graceRow).getByRole('checkbox')).toBeDisabled();
  });

  it('shows server notes, such as an applicant-only field against the member pool', async () => {
    mockApi({ notes: ['Member resumes do not record Cumulative GPA, so no member resume can match this filter.'] });
    await setUpPreview();
    expect(screen.getByText(/do not record Cumulative GPA/i)).toBeInTheDocument();
  });
});
