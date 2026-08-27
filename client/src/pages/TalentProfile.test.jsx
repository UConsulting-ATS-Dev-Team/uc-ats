// The talent profile page.
//
// The assertion worth having here is the verification gate as the user
// experiences it: an unverified account is told what to do and cannot reach the
// upload controls at all, so a resume never gets as far as a 403 they would
// have to interpret.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TalentProfile from './TalentProfile';
import apiClient from '../utils/api';

const logout = vi.fn();
const refreshUser = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'talent-1', email: 'joski@g.ucla.edu', isExternalTalent: true },
    logout,
    refreshUser,
  }),
}));

vi.mock('../components/DocumentPreviewModal', () => ({
  default: ({ src }) => <div data-testid="preview">{src}</div>,
}));

vi.mock('../components/UConsultingLogo', () => ({ default: () => <div /> }));

const profile = (overrides = {}) => ({
  fullName: 'Joski Bruin',
  email: 'joski@g.ucla.edu',
  graduationYear: '2027',
  emailVerified: true,
  emailVerifiedAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

const resume = (overrides = {}) => ({
  id: 'er-1',
  originalName: 'resume.pdf',
  fileSize: 1024,
  major1: 'Economics',
  major2: null,
  graduationYear: '2027',
  gender: 'Female',
  shareConsent: true,
  consentAt: '2026-08-21T00:00:00.000Z',
  consentRevokedAt: null,
  uploadedAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
  assignedCount: 3,
  ...overrides,
});

const mockMe = (body) => {
  apiClient.get = vi.fn(() => Promise.resolve({ genders: ['Male', 'Female', 'Other'], ...body }));
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
  apiClient.post = vi.fn(() => Promise.resolve({}));
  apiClient.patch = vi.fn(() => Promise.resolve({ resume: resume() }));
  apiClient.delete = vi.fn(() => Promise.resolve({ ok: true }));
  mockMe({ profile: profile(), resume: null });
});

describe('unverified account', () => {
  beforeEach(() => {
    mockMe({ profile: profile({ emailVerified: false, emailVerifiedAt: null }), resume: null });
  });

  it('says which address to check rather than just "unverified"', async () => {
    render(<TalentProfile />);
    // Appears twice: the header subtitle and the warning banner.
    await waitFor(() => expect(screen.getAllByText(/joski@g\.ucla\.edu/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/verification link/i)).toBeInTheDocument();
  });

  it('disables the upload controls, so the gate is visible before it is hit', async () => {
    const { container } = render(<TalentProfile />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /upload resume/i })).toBeDisabled()
    );
    expect(screen.getByRole('checkbox')).toBeDisabled();
    // The file input specifically: MUI renders the "Choose PDF" control as a
    // <label>, and a disabled label still forwards its click to the input
    // inside. Disabling the Button alone would open the picker anyway.
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
  });

  it('resends the verification email on request', async () => {
    const user = userEvent.setup();
    render(<TalentProfile />);
    await waitFor(() => expect(screen.getByRole('button', { name: /resend/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /resend/i }));
    expect(apiClient.post).toHaveBeenCalledWith('/auth/resend-verification', {
      email: 'joski@g.ucla.edu',
    });
  });

  it('still allows a name fix before the link arrives', async () => {
    render(<TalentProfile />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save details/i })).toBeEnabled()
    );
  });
});

describe('verified account with a shared resume', () => {
  beforeEach(() => {
    mockMe({ profile: profile(), resume: resume() });
  });

  it('shows how many organizations can actually see it', async () => {
    render(<TalentProfile />);
    await waitFor(() =>
      expect(screen.getByText(/3 organization\(s\) can see it/i)).toBeInTheDocument()
    );
  });

  it('warns before a withdrawal that pulls the resume back from partners', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TalentProfile />);
    await waitFor(() => expect(screen.getByRole('button', { name: /stop sharing/i })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: /stop sharing/i }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/3 partner organization/i));
    // Declining the confirm must not send the request.
    expect(apiClient.patch).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('withdraws when the warning is accepted', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TalentProfile />);
    await waitFor(() => expect(screen.getByRole('button', { name: /stop sharing/i })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: /stop sharing/i }));

    expect(apiClient.patch).toHaveBeenCalledWith('/talent/resume/consent', {
      shareConsent: false,
    });
    confirm.mockRestore();
  });
});

describe('a first upload', () => {
  it('prefills the resume year from the one given at signup', async () => {
    mockMe({ profile: profile({ graduationYear: '2029' }), resume: null });
    render(<TalentProfile />);
    await waitFor(() => {
      const years = screen.getAllByLabelText(/graduation year/i);
      // Both the details form and the resume form carry it.
      expect(years.every((input) => input.value === '2029')).toBe(true);
    });
  });

  it('keeps upload disabled until a file is chosen', async () => {
    mockMe({ profile: profile(), resume: null });
    render(<TalentProfile />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /upload resume/i })).toBeDisabled()
    );
  });
});
