// The login page, with Google sign-in on it.
//
// What is worth pinning is the routing: the server can hand back any kind of
// account from one Google button, and sending a partner or a talent account to
// the application list means a visible bounce through a page they cannot see.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate
}));

const login = vi.fn();
const loginWithGoogle = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login, loginWithGoogle, user: null, loading: false })
}));

vi.mock('../utils/googleSignIn', () => ({
  GOOGLE_CLIENT_ID: 'test-client-id',
  googleSignInEnabled: true
}));

// Stands in for the real GSI button, which needs Google's script and an iframe.
// Firing onSuccess is the whole contract this page depends on.
vi.mock('@react-oauth/google', () => ({
  GoogleLogin: ({ onSuccess, onError }) => (
    <div>
      <button onClick={() => onSuccess({ credential: 'fake-id-token' })}>Continue with Google</button>
      <button onClick={onError}>Fail Google</button>
    </div>
  )
}));

vi.mock('../components/UConsultingLogo', () => ({ default: () => <div /> }));

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );

const clickGoogle = async () => {
  await userEvent.click(screen.getByRole('button', { name: /continue with google/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Login, signing in with Google', () => {
  it('hands the credential from the button straight to the server', async () => {
    loginWithGoogle.mockResolvedValue({ success: true, user: { role: 'USER' } });

    renderLogin();
    await clickGoogle();

    expect(loginWithGoogle).toHaveBeenCalledWith('fake-id-token');
  });

  it('sends a brand-new talent account to its profile, not the application list', async () => {
    loginWithGoogle.mockResolvedValue({
      success: true,
      isNewAccount: true,
      user: { role: 'USER', isExternalTalent: true }
    });

    renderLogin();
    await clickGoogle();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/talent/profile'));
  });

  it('sends a partner to the one page they can see', async () => {
    loginWithGoogle.mockResolvedValue({ success: true, user: { role: 'CLIENT' } });

    renderLogin();
    await clickGoogle();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/partner/resumes'));
  });

  it('sends a candidate to their own dashboard, not the review queue', async () => {
    // /application-list is the admin and member queue and denies a candidate.
    // Every non-CLIENT account used to be sent there.
    loginWithGoogle.mockResolvedValue({
      success: true,
      user: { role: 'USER', isExternalTalent: false }
    });

    renderLogin();
    await clickGoogle();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboard'));
  });

  it('sends staff to the review queue', async () => {
    loginWithGoogle.mockResolvedValue({ success: true, user: { role: 'ADMIN' } });

    renderLogin();
    await clickGoogle();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/application-list'));
  });

  it("shows the server's own words when Google sign-in is refused", async () => {
    loginWithGoogle.mockResolvedValue({
      success: false,
      error: 'Your Google account has not verified that email address.',
      code: 'GOOGLE_EMAIL_UNVERIFIED'
    });

    renderLogin();
    await clickGoogle();

    expect(await screen.findByText(/has not verified that email address/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says so when the Google button itself fails', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /fail google/i }));

    expect(await screen.findByText(/cancelled or failed/i)).toBeInTheDocument();
  });
});

describe('Login, signing in with a password', () => {
  it('still works, and routes the same way', async () => {
    login.mockResolvedValue({ success: true, user: { role: 'MEMBER' } });

    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'member@ucla.edu');
    await userEvent.type(screen.getByLabelText(/password/i), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/application-list'));
  });

  it('sends a candidate to their dashboard too, which it never used to', async () => {
    login.mockResolvedValue({ success: true, user: { role: 'USER', isExternalTalent: false } });

    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'candidate@ucla.edu');
    await userEvent.type(screen.getByLabelText(/password/i), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboard'));
  });

  it('surfaces the "this account uses Google" refusal', async () => {
    login.mockResolvedValue({
      success: false,
      error: 'This account signs in with Google. Use "Continue with Google", or use Forgot password to set one.'
    });

    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'joski@g.ucla.edu');
    await userEvent.type(screen.getByLabelText(/password/i), 'guessing');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/signs in with Google/i)).toBeInTheDocument();
  });
});
