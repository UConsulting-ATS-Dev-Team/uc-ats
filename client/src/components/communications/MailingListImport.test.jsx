// The Mailing List tab.
//
// The admin's decision here is "is this the right column, and do these numbers
// look like my list" - so what matters is that the counts and the dropped rows
// are actually shown, and that a file whose column could not be detected offers
// a way forward rather than a dead end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MailingListImport from './MailingListImport';
import apiClient from '../../utils/api';

const csvFile = (name = 'list.csv') =>
  new File(['Email\nnew@ucla.edu\n'], name, { type: 'text/csv' });

const deduped = {
  fileName: 'list.csv',
  headers: ['Name', 'Email'],
  emailColumn: 'Email',
  rows: 6,
  knownAddresses: 4,
  keptCount: 2,
  summary: {
    total: 6,
    counts: {
      kept: 2, 'already-in-system': 3, 'duplicate-in-file': 1, 'invalid-email': 0, 'missing-email': 0,
    },
    bySource: { user: 2, candidate: 1 },
  },
  dropped: [
    { line: 3, email: 'known@ucla.edu', raw: 'known@ucla.edu', outcome: 'already-in-system', sources: ['user'] },
    { line: 4, email: 'dupe@ucla.edu', raw: 'dupe@ucla.edu', outcome: 'duplicate-in-file', firstSeenAt: 2 },
  ],
  csv: 'Name,Email\r\nNew,new@ucla.edu\r\n',
};

const pickFile = async (user, file = csvFile()) => {
  const input = document.querySelector('input[type="file"]');
  await user.upload(input, file);
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a file that deduped cleanly', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'post').mockResolvedValue(deduped);
  });

  it('sends the file as form data, not as JSON', async () => {
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const [url, body] = apiClient.post.mock.calls[0];
    expect(url).toBe('/master-communications/mailing-list/dedupe');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBeInstanceOf(File);
  });

  it('shows the counts the admin has to check the run against', async () => {
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    expect(await screen.findByText(/6 rows read/)).toBeInTheDocument();
    expect(screen.getByText(/Email column: Email/)).toBeInTheDocument();
    expect(screen.getByText(/4 known addresses in the ATS/)).toBeInTheDocument();
    expect(screen.getByText('Kept (not in the ATS)')).toBeInTheDocument();
  });

  it('says which tables the known addresses matched', async () => {
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    expect(await screen.findByText(/user 2, candidate 1/)).toBeInTheDocument();
    // The caveat matters: one address can sit in several tables, so these do
    // not sum to the dropped count shown just above them.
    expect(screen.getByText(/do not sum to the dropped count/)).toBeInTheDocument();
  });

  it('accounts for every dropped row, with its line number and reason', async () => {
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    await user.click(await screen.findByRole('button', { name: /Show 2 dropped rows/i }));

    expect(screen.getByText('known@ucla.edu')).toBeInTheDocument();
    expect(screen.getByText(/already in the ATS \(user\)/)).toBeInTheDocument();
    expect(screen.getByText(/repeat of line 2/)).toBeInTheDocument();
  });

  it('offers the survivors as a download', async () => {
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    expect(await screen.findByRole('button', { name: /Download 2 rows/i })).toBeInTheDocument();
  });
});

describe('a file whose email column could not be found', () => {
  it('offers the headers to pick from instead of failing', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({
      fileName: 'list.csv', headers: ['Name', 'Contact'], emailColumn: null, rows: 2, overrideMissed: false,
    });
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    expect(await screen.findByText(/Which column holds the email address/)).toBeInTheDocument();
  });

  it('re-sends the same file with the column the admin picked', async () => {
    const post = vi.spyOn(apiClient, 'post')
      .mockResolvedValueOnce({
        fileName: 'list.csv', headers: ['Name', 'Contact'], emailColumn: null, rows: 2, overrideMissed: false,
      })
      .mockResolvedValueOnce({ ...deduped, emailColumn: 'Contact' });

    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    await user.click(await screen.findByRole('combobox', { name: /Email column/i }));
    await user.click(await screen.findByRole('option', { name: 'Contact' }));
    await user.click(screen.getByRole('button', { name: /Use this column/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    // The same file, not a second prompt to choose one.
    expect(post.mock.calls[1][1].get('file')).toBeInstanceOf(File);
    expect(post.mock.calls[1][1].get('emailColumn')).toBe('Contact');
  });
});

describe('when nothing survives', () => {
  it('warns instead of offering an empty download, because a wrong column looks the same', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({
      ...deduped,
      keptCount: 0,
      summary: { ...deduped.summary, counts: { ...deduped.summary.counts, kept: 0 } },
    });
    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user);

    expect(await screen.findByText(/No rows survived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Download/i })).not.toBeInTheDocument();
  });
});

describe('when the server refuses the file', () => {
  it('shows the reason rather than a blank panel', async () => {
    const err = new Error('Mailing list must be a .csv file (Status: 400)');
    err.serverMessage = 'Mailing list must be a .csv file';
    vi.spyOn(apiClient, 'post').mockRejectedValue(err);

    const user = userEvent.setup();
    render(<MailingListImport />);
    await pickFile(user, csvFile('list.pdf'));

    expect(await screen.findByText('Mailing list must be a .csv file')).toBeInTheDocument();
  });
});
