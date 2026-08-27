// The candidate onboarding module.
//
// The assertions worth having are the ones about what the page refuses to ask:
// it must not present the form to an unverified account (which the server would
// reject anyway), and it must not present it to someone whose application
// already answers every question on it. Everything else is a form.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CandidateOnboarding from './CandidateOnboarding';
import apiClient from '../utils/api';
import { MAJOR_OPTIONS } from '../utils/majors';

const navigate = vi.fn();

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../components/UConsultingLogo', () => ({ default: () => <div /> }));

const markOnboardingComplete = vi.fn();
vi.mock('../utils/onboardingStatus', () => ({
  markOnboardingComplete: (...args) => markOnboardingComplete(...args),
}));

const status = (overrides = {}) => ({
  required: true,
  hasApplication: false,
  completed: false,
  emailVerified: true,
  onboarding: null,
  talentPool: { shared: false, consentAt: null, consentRevokedAt: null },
  ...overrides,
});

const mockStatus = (overrides = {}) => {
  vi.spyOn(apiClient, 'get').mockResolvedValue(status(overrides));
};

beforeEach(() => {
  vi.restoreAllMocks();
  navigate.mockClear();
  markOnboardingComplete.mockClear();
});

const pdf = () => new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });

// Six radios in document order: transfer Yes/No, first-generation Yes/No,
// then the Talent Partner Network Yes/No.
const TRANSFER_NO = 1;
const FIRST_GEN_YES = 2;
const TPN_YES = 4;
const TPN_NO = 5;

const fillAndSubmit = async (
  user,
  { optIn = false, resume = pdf(), skipMajor = false, skipGpa = false } = {}
) => {
  await user.type(screen.getByLabelText('Phone number *'), '3105550134');
  if (!skipGpa) await user.type(screen.getByLabelText('Cumulative GPA *'), '3.85');
  if (!skipMajor) {
    await user.click(screen.getByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Economics or Business Economics' }));
  }

  // Required, and an unfilled required control blocks form submission entirely -
  // without this the submit never fires and every assertion below times out.
  await user.click(screen.getByRole('combobox', { name: /Graduation year/ }));
  await user.click(await screen.findByRole('option', { name: '2028' }));

  const radios = screen.getAllByRole('radio');
  await user.click(radios[TRANSFER_NO]);
  await user.click(radios[FIRST_GEN_YES]);

  if (resume) {
    await user.upload(document.querySelector('input[type="file"]'), resume);
  }
  await user.click(screen.getAllByRole('radio')[optIn ? TPN_YES : TPN_NO]);
  await user.click(screen.getByRole('button', { name: /Finish setting up/ }));
};

describe('what the module refuses to ask', () => {
  it('tells an unverified account to check its email instead of showing the form', async () => {
    mockStatus({ emailVerified: false });
    render(<CandidateOnboarding />);

    expect(await screen.findByText(/Check your email for a verification link/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Cumulative GPA/)).not.toBeInTheDocument();
  });

  it('does not ask a candidate who already has an application', async () => {
    mockStatus({ required: false, hasApplication: true });
    render(<CandidateOnboarding />);

    expect(await screen.findByText(/Your profile is already complete/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Cumulative GPA/)).not.toBeInTheDocument();
  });

  it('asks for a resume and nothing else file-wise - no cover letter, no video', async () => {
    mockStatus();
    render(<CandidateOnboarding />);

    await screen.findByLabelText(/Cumulative GPA/);
    expect(screen.queryByText(/cover letter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/video/i)).not.toBeInTheDocument();
  });
});

describe('the talent partner network opt-in', () => {
  it('is asked as a yes/no with neither preselected', async () => {
    mockStatus();
    render(<CandidateOnboarding />);

    await screen.findByLabelText('Cumulative GPA *');
    const radios = screen.getAllByRole('radio');
    // Neither answer may be the default: a preselected "yes" would turn a
    // skipped question into permission to share someone's resume.
    expect(radios[TPN_YES]).not.toBeChecked();
    expect(radios[TPN_NO]).not.toBeChecked();
    expect(screen.getByText(/partner companies/i)).toBeInTheDocument();
  });

  it('reflects a choice already made', async () => {
    mockStatus({
      completed: true,
      talentPool: { shared: true, consentAt: '2026-08-26', consentRevokedAt: null },
    });
    render(<CandidateOnboarding />);

    await waitFor(() => expect(screen.getAllByRole('radio')[TPN_YES]).toBeChecked());
  });

  it('sends nothing until the question is answered', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post');
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Phone number *'), '310-555-0134');
    await user.type(screen.getByLabelText('Cumulative GPA *'), '3.85');
    await user.click(screen.getByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Economics or Business Economics' }));
    await user.click(screen.getByRole('combobox', { name: /Graduation year/ }));
    await user.click(await screen.findByRole('option', { name: '2028' }));
    const radios = screen.getAllByRole('radio');
    await user.click(radios[TRANSFER_NO]);
    await user.click(radios[FIRST_GEN_YES]);
    await user.upload(document.querySelector('input[type=\"file\"]'), pdf());
    await user.click(screen.getByRole('button', { name: /Finish setting up/ }));

    expect(post).not.toHaveBeenCalled();
  });

  it('sends an explicit false rather than omitting the field', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ onboarding: {} });
    render(<CandidateOnboarding />);
    await screen.findByLabelText(/Cumulative GPA/);

    const user = userEvent.setup();
    await fillAndSubmit(user);

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].get('talentPoolOptIn')).toBe('false');
  });

  it('sends true when the box is checked', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ onboarding: {} });
    render(<CandidateOnboarding />);
    await screen.findByLabelText(/Cumulative GPA/);

    const user = userEvent.setup();
    await fillAndSubmit(user, { optIn: true });

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].get('talentPoolOptIn')).toBe('true');
  });
});

describe('submitting', () => {
  it('refuses to submit without a resume, without asking the server', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post');
    render(<CandidateOnboarding />);
    await screen.findByLabelText(/Cumulative GPA/);

    const user = userEvent.setup();
    await fillAndSubmit(user, { resume: null });

    expect(await screen.findByText(/Attach your resume as a PDF/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('marks onboarding done before navigating, so the gate does not bounce back here', async () => {
    mockStatus();
    vi.spyOn(apiClient, 'post').mockResolvedValue({ onboarding: {} });
    render(<CandidateOnboarding />);
    await screen.findByLabelText(/Cumulative GPA/);

    const user = userEvent.setup();
    await fillAndSubmit(user);

    // Regression: the gate used to hold its own stale "required" answer, so a
    // successful submit navigated to the dashboard and was redirected straight
    // back into this form with the resume selection lost.
    await waitFor(() => expect(markOnboardingComplete).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    expect(markOnboardingComplete.mock.invocationCallOrder[0])
      .toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });

  it('surfaces a server error instead of navigating away', async () => {
    mockStatus();
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('Enter your major.'));
    render(<CandidateOnboarding />);
    await screen.findByLabelText(/Cumulative GPA/);

    const user = userEvent.setup();
    await fillAndSubmit(user);

    expect(await screen.findByText('Enter your major.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('the major dropdowns', () => {
  it('offers the same categories the application form does, plus Other', async () => {
    mockStatus();
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Major/ }));

    for (const option of MAJOR_OPTIONS) {
      expect(await screen.findByRole('option', { name: option })).toBeInTheDocument();
    }
    expect(await screen.findByRole('option', { name: 'Other' })).toBeInTheDocument();
  });

  it('reveals a text field when Other is chosen, and submits what was typed', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ onboarding: {} });
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));
    await user.type(await screen.findByLabelText('Your major *'), 'Marine Biology');

    await fillAndSubmit(user, { skipMajor: true });

    await waitFor(() => expect(post).toHaveBeenCalled());
    // The sentinel must never be what gets stored - it would file a real major
    // under a label no partner filter can match.
    expect(post.mock.calls[0][1].get('major1')).toBe('Marine Biology');
  });

  it('sends nothing when Other is chosen but left blank', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post');
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Major/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));
    await fillAndSubmit(user, { skipMajor: true });

    // The revealed field is `required`, so the browser stops the submit before
    // the handler's own guard is reached. Either way nothing reaches the server,
    // which is the part worth pinning down - a blank major must never be stored.
    expect(post).not.toHaveBeenCalled();
  });

  it('puts a stored free-text major back into Other rather than losing it', async () => {
    mockStatus({
      onboarding: {
        phoneNumber: '310-555-0134',
        graduationYear: '2028',
        cumulativeGpa: '3.85',
        major1: 'Marine Biology',
        major2: null,
        gender: null,
        isTransferStudent: false,
        isFirstGeneration: true,
      },
    });
    render(<CandidateOnboarding />);

    expect(await screen.findByLabelText('Your major *')).toHaveValue('Marine Biology');
  });
});

describe('the GPA field', () => {
  it('tells a first-year what to enter when they have no college GPA yet', async () => {
    mockStatus();
    render(<CandidateOnboarding />);

    await screen.findByLabelText('Cumulative GPA *');
    expect(screen.getByText(/high school GPA/i)).toBeInTheDocument();
  });
});


describe('field validation', () => {
  it('formats a phone number as it is typed', async () => {
    mockStatus();
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Phone number *'), '3105550134');

    expect(screen.getByLabelText('Phone number *')).toHaveValue('(310) 555-0134');
  });

  it('submits the digits, not the formatting shown in the field', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ onboarding: {} });
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await fillAndSubmit(user);

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].get('phoneNumber')).toBe('3105550134');
  });

  it('flags an incomplete phone number while typing', async () => {
    mockStatus();
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Phone number *'), '310555');

    expect(await screen.findByText(/10-digit phone number/)).toBeInTheDocument();
  });

  it('flags a GPA with three decimals', async () => {
    mockStatus();
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Cumulative GPA *'), '3.456');

    expect(await screen.findByText(/at most two decimal places/)).toBeInTheDocument();
  });

  it('accepts a weighted high-school GPA above 4.00', async () => {
    mockStatus();
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Cumulative GPA *'), '4.83');

    expect(screen.queryByText(/at most two decimal places/)).not.toBeInTheDocument();
    expect(screen.queryByText(/4\.0 scale/)).not.toBeInTheDocument();
  });

  it('does not send a form with a flagged field', async () => {
    mockStatus();
    const post = vi.spyOn(apiClient, 'post');
    render(<CandidateOnboarding />);
    await screen.findByLabelText('Cumulative GPA *');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Cumulative GPA *'), '3.456');
    await fillAndSubmit(user, { skipGpa: true });

    expect(post).not.toHaveBeenCalled();
  });

  it('shows a stored phone number formatted rather than as raw digits', async () => {
    mockStatus({
      onboarding: {
        phoneNumber: '3105550134',
        graduationYear: '2028',
        cumulativeGpa: '3.85',
        major1: 'Life Sciences',
        major2: null,
        gender: null,
        isTransferStudent: false,
        isFirstGeneration: true,
      },
    });
    render(<CandidateOnboarding />);

    await waitFor(() =>
      expect(screen.getByLabelText('Phone number *')).toHaveValue('(310) 555-0134')
    );
  });
});
