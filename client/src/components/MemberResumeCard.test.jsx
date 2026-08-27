// The member Talent Partner Network resume form.
//
// The majors are dropdowns now, which introduces the one thing worth pinning
// down: a member whose stored major predates the dropdown must still see their
// answer. Everything else here is the consent rule - a resume must never reach
// a partner on an answer nobody gave.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MemberResumeCard from './MemberResumeCard';
import apiClient from '../utils/api';
import { MAJOR_OPTIONS } from '../utils/majors';

vi.mock('./DocumentPreviewModal', () => ({ default: () => <div /> }));

const load = (resume = null) =>
  vi.spyOn(apiClient, 'get').mockResolvedValue({ resume, genders: ['Male', 'Female', 'Other'] });

beforeEach(() => {
  vi.restoreAllMocks();
});

const stored = (overrides = {}) => ({
  id: 'mr-1',
  originalName: 'resume.pdf',
  fileSize: 1024,
  major1: 'Life Sciences',
  major2: null,
  graduationYear: '2027',
  gender: 'Female',
  shareConsent: false,
  consentAt: null,
  consentRevokedAt: null,
  assignedCount: 0,
  ...overrides,
});

const pdf = () => new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });

// Two radios in document order: consent Yes, then No.
const CONSENT_YES = 0;
const CONSENT_NO = 1;

const chooseYear = async (user, year = '2028') => {
  await user.click(screen.getByRole('combobox', { name: /Graduation year/ }));
  await user.click(await screen.findByRole('option', { name: year }));
};

describe('the major dropdowns', () => {
  it('offers the same categories the application form does, plus Other', async () => {
    load();
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Major/ }));

    for (const option of MAJOR_OPTIONS) {
      expect(await screen.findByRole('option', { name: option })).toBeInTheDocument();
    }
    expect(await screen.findByRole('option', { name: 'Other' })).toBeInTheDocument();
  });

  it('shows a stored category as the selected option', async () => {
    load(stored({ major1: 'Life Sciences' }));
    render(<MemberResumeCard />);
    expect(await screen.findByText('Life Sciences')).toBeInTheDocument();
  });

  it('keeps a free-text major from before the dropdown existed', async () => {
    // Members filled this in as free text until now. Dropping what they typed
    // on load would be a worse bug than the typos the dropdown prevents.
    load(stored({ major1: 'Marine Biology' }));
    render(<MemberResumeCard />);
    expect(await screen.findByDisplayValue('Marine Biology')).toBeInTheDocument();
  });

  it('reveals a text field when Other is chosen', async () => {
    load();
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));

    expect(await screen.findByLabelText(/Your major/)).toBeInTheDocument();
  });

  it('submits what was typed, never the sentinel', async () => {
    load();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ resume: stored() });
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));
    await user.type(await screen.findByLabelText(/Your major/), 'Marine Biology');
    await chooseYear(user);
    await user.click(screen.getAllByRole('radio')[CONSENT_YES]);
    await user.upload(document.querySelector('input[type="file"]'), pdf());
    await user.click(screen.getByRole('button', { name: /Upload resume/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].get('major1')).toBe('Marine Biology');
    expect(post.mock.calls[0][1].get('shareConsent')).toBe('true');
  });

  it('refuses an empty Other without discarding the chosen file', async () => {
    load();
    const post = vi.spyOn(apiClient, 'post');
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));
    await user.upload(document.querySelector('input[type="file"]'), pdf());
    await user.click(screen.getByRole('button', { name: /Upload resume/i }));

    expect(await screen.findByText('Type your major.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    // The file survives, so fixing the major is one step and not two.
    expect(screen.getByText('resume.pdf')).toBeInTheDocument();
  });
});

describe('consent', () => {
  it('is asked as a yes/no with neither answer preselected', async () => {
    load();
    render(<MemberResumeCard />);
    await screen.findByRole('combobox', { name: /^Major/ });

    const radios = screen.getAllByRole('radio');
    // A preselected "yes" would turn a skipped question into permission to
    // send someone's resume to a company.
    expect(radios[CONSENT_YES]).not.toBeChecked();
    expect(radios[CONSENT_NO]).not.toBeChecked();
  });

  it('reflects the answer already on file rather than resetting it', async () => {
    // Regression: this was never read back, so a member who had opted in saw a
    // blank answer and could revoke sharing just by replacing their PDF.
    load(stored({ shareConsent: true }));
    render(<MemberResumeCard />);
    await waitFor(() => expect(screen.getAllByRole('radio')[CONSENT_YES]).toBeChecked());
  });

  it('reflects a stored no as well', async () => {
    load(stored({ shareConsent: false }));
    render(<MemberResumeCard />);
    await waitFor(() => expect(screen.getAllByRole('radio')[CONSENT_NO]).toBeChecked());
  });

  it('sends nothing until the question is answered', async () => {
    load();
    const post = vi.spyOn(apiClient, 'post');
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: MAJOR_OPTIONS[0] }));
    await chooseYear(user);
    await user.upload(document.querySelector('input[type="file"]'), pdf());
    await user.click(screen.getByRole('button', { name: /Upload resume/i }));

    expect(await screen.findByText(/whether we may share your resume/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the required fields', () => {
  it('will not upload without a graduation year', async () => {
    load();
    const post = vi.spyOn(apiClient, 'post');
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: MAJOR_OPTIONS[0] }));
    await user.click(screen.getAllByRole('radio')[CONSENT_YES]);
    await user.upload(document.querySelector('input[type="file"]'), pdf());
    await user.click(screen.getByRole('button', { name: /Upload resume/i }));

    expect(await screen.findByText('Choose your graduation year.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('offers the graduation years as a dropdown, not free text', async () => {
    load();
    render(<MemberResumeCard />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /Graduation year/ }));
    for (const year of ['2027', '2028', '2029', '2030']) {
      expect(await screen.findByRole('option', { name: year })).toBeInTheDocument();
    }
  });

  it('cannot be submitted without a PDF', async () => {
    load();
    render(<MemberResumeCard />);
    await screen.findByRole('combobox', { name: /^Major/ });

    expect(screen.getByRole('button', { name: /Upload resume/i })).toBeDisabled();
  });
});
