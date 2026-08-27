import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicantInformation from './ApplicantInformation';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../components/DocumentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/ResumeReuploadSection', () => ({
  default: ({ applicationId }) => <div data-testid="resume-section">{applicationId}</div>,
}));

const APPLICATION = {
  id: 'app-1',
  email: 'cand@example.com',
  studentId: '405123456',
  firstName: 'Cand',
  lastName: 'Idate',
  phoneNumber: '860-555-0100',
  graduationYear: '2028',
  major1: 'Finance',
  major2: null,
  cumulativeGpa: 3.85,
  majorGpa: null,
  isTransferStudent: false,
  priorCollegeYears: null,
  gender: null,
  isFirstGeneration: false,
  status: 'SUBMITTED',
  currentRound: '1',
  submittedAt: '2026-09-01T12:00:00.000Z',
  cycle: { id: 'cycle-1', name: 'Fall 2026', isActive: true },
};

const renderPage = () => render(<MemoryRouter><ApplicantInformation /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/applications/my-applications') {
      return Promise.resolve([{ id: 'app-1', submittedAt: APPLICATION.submittedAt, cycle: APPLICATION.cycle }]);
    }
    if (endpoint === '/applicant-info/applications/app-1') return Promise.resolve({ ...APPLICATION });
    return Promise.resolve([]);
  });
  apiClient.patch = vi.fn(() =>
    Promise.resolve({ message: 'Your information has been updated.', application: { ...APPLICATION, phoneNumber: '860-555-0199' } })
  );
});

describe('ApplicantInformation', () => {
  it('loads the applicant details into the form', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/First name/)).toHaveValue('Cand'));
    expect(screen.getByLabelText(/Phone number/)).toHaveValue('860-555-0100');
    expect(screen.getByLabelText(/Cumulative GPA/)).toHaveValue(3.85);
  });

  it('shows email and student ID as read-only text, not inputs', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('cand@example.com')).toBeInTheDocument());
    expect(screen.getByText('405123456')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Student ID/)).not.toBeInTheDocument();
  });

  it('keeps save disabled until something actually changes', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/First name/)).toBeInTheDocument());
    const save = screen.getByRole('button', { name: /Save changes/ });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '860-555-0199' } });
    expect(save).toBeEnabled();
  });

  it('sends only the fields that changed', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Phone number/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '860-555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith(
      '/applicant-info/applications/app-1',
      { phoneNumber: '860-555-0199' }
    ));
  });

  it('confirms a successful save and re-disables the button', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Phone number/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '860-555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(screen.getByText(/Your information has been updated/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled();
  });

  it('restores the loaded values when changes are discarded', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Phone number/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '860-555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: /Discard changes/ }));

    expect(screen.getByLabelText(/Phone number/)).toHaveValue('860-555-0100');
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('surfaces a rejection from the server without losing what was typed', async () => {
    apiClient.patch = vi.fn(() => Promise.reject(new Error('Phone number must be 40 characters or fewer.')));
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Phone number/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Phone number/), { target: { value: '860-555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(screen.getByText(/40 characters or fewer/)).toBeInTheDocument());
    expect(screen.getByLabelText(/Phone number/)).toHaveValue('860-555-0199');
  });

  // The number input carries max="5", so an out-of-range GPA is stopped by the
  // browser and never reaches the server. The server validates it anyway.
  it('bounds the GPA inputs client-side', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Cumulative GPA/)).toBeInTheDocument());
    expect(screen.getByLabelText(/Cumulative GPA/)).toHaveAttribute('max', '5');
    expect(screen.getByLabelText(/Major GPA/)).toHaveAttribute('max', '5');
  });

  // Only asked of transfer students, so it should not be on screen otherwise.
  it('reveals prior college years only for a transfer student', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/First name/)).toBeInTheDocument());
    expect(screen.queryByLabelText(/Years at your prior college/)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('radio', { name: 'Yes' })[0]);
    expect(screen.getByLabelText(/Years at your prior college/)).toBeInTheDocument();
  });

  it('renders the resume section for the selected application', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('resume-section')).toHaveTextContent('app-1'));
  });

  it('shows an empty state when the candidate has no application', async () => {
    apiClient.get = vi.fn((url) =>
      url.includes('onboarding')
        ? Promise.resolve({ onboarding: null })
        : Promise.reject(new Error('User not found or no studentId associated'))
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/do not have an application yet/)).toBeInTheDocument());
  });
});

describe('a candidate who onboarded instead of applying', () => {
  const onboarding = {
    id: 'onb-1',
    phoneNumber: '3105550134',
    graduationYear: '2029',
    cumulativeGpa: '3.85',
    major1: 'Life Sciences',
    major2: null,
    gender: 'Female',
    isTransferStudent: false,
    isFirstGeneration: true,
  };

  const mockOnboarded = () => {
    apiClient.get = vi.fn((url) =>
      url.includes('onboarding')
        ? Promise.resolve({ required: false, completed: true, onboarding })
        : Promise.reject(new Error('User not found or no studentId associated'))
    );
  };

  beforeEach(mockOnboarded);

  it('shows what they entered instead of telling them they have nothing', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Primary major/)).toHaveValue('Life Sciences'));
    expect(screen.queryByText(/do not have an application yet/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Graduation year/)).toHaveValue('2029');
  });

  it('hides the fields onboarding does not collect, so no edit goes nowhere', async () => {
    renderPage();
    await screen.findByLabelText(/Primary major/);
    // Major GPA, prior college years and the name fields live on an
    // application, not on the onboarding record.
    expect(screen.queryByLabelText(/Major GPA/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/First name/)).not.toBeInTheDocument();
  });

  it('hides the identity block, which reads application-only fields', async () => {
    renderPage();
    await screen.findByLabelText(/Primary major/);
    expect(screen.queryByText('Identity')).not.toBeInTheDocument();
  });

  it('saves an edit to the onboarding record, not to an application', async () => {
    const patch = vi.fn(() =>
      Promise.resolve({ onboarding: { ...onboarding, major1: 'Social Sciences' }, message: 'Saved.' })
    );
    apiClient.patch = patch;

    renderPage();
    const major = await screen.findByLabelText(/Primary major/);
    fireEvent.change(major, { target: { value: 'Social Sciences' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/candidate/onboarding');
    // Sent whole rather than as a diff - the endpoint validates every field.
    expect(patch.mock.calls[0][1]).toMatchObject({ major1: 'Social Sciences', graduationYear: '2029' });
  });
});

describe('an applicant changing their Talent Partner Network answer', () => {
  it('shows the answer already on file', async () => {
    renderPage();
    await screen.findByLabelText(/Primary major/);
    expect(screen.getByText('Current answer')).toBeInTheDocument();
  });

  it('sends the change and says what turning it off does', async () => {
    const patch = vi.fn(() =>
      Promise.resolve({ talentPoolOptIn: false, message: 'Sharing stopped, and your resume has been withdrawn.' })
    );
    apiClient.patch = patch;

    renderPage();
    await screen.findByLabelText(/Primary major/);
    fireEvent.click(screen.getByRole('button', { name: /No, do not share/ }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/applicant-info/talent-pool');
    expect(patch.mock.calls[0][1]).toEqual({ talentPoolOptIn: false });
    expect(await screen.findByText(/withdrawn/i)).toBeInTheDocument();
  });

  it('is not shown to a candidate who onboarded - they have their own control', async () => {
    apiClient.get = vi.fn((url) =>
      url.includes('onboarding')
        ? Promise.resolve({
            required: false,
            completed: true,
            onboarding: {
              phoneNumber: '3105550134', graduationYear: '2029', cumulativeGpa: '3.85',
              major1: 'Life Sciences', major2: null, gender: null,
              isTransferStudent: false, isFirstGeneration: true,
            },
          })
        : Promise.reject(new Error('User not found or no studentId associated'))
    );

    renderPage();
    await screen.findByLabelText(/Primary major/);
    // Both modes show a Talent Partner Network section, but an onboarded
    // candidate gets the one in OnboardingResumeSection, which saves through a
    // different endpoint. "Current answer" belongs only to the applicant one.
    expect(screen.queryByText('Current answer')).not.toBeInTheDocument();
  });
});
