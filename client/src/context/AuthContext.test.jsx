// Signing out on a dead session, through the real AuthProvider, route table
// and login page.
//
// BrowserRouter on purpose, not MemoryRouter: it applies every navigation as a
// React transition, which is what let ProtectedRoute's own redirect to /login
// overtake ours and drop the session-expired notice.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import apiClient from '../utils/api';
import { AuthProvider, useAuth } from './AuthContext';

vi.mock('../analytics', () => ({ trackRouteChange: () => {} }));
vi.mock('../components/Layout', () => ({ default: ({ children }) => <>{children}</> }));
vi.mock('../pages/Staging', () => ({ default: () => <div>staging</div> }));
vi.mock('../pages/Dashboard', () => ({ default: () => <div>admin dashboard</div> }));
vi.mock('../components/UConsultingLogo', () => ({ default: () => <div /> }));
vi.mock('../utils/googleSignIn', () => ({ GOOGLE_CLIENT_ID: '', googleSignInEnabled: false }));
vi.mock('@react-oauth/google', () => ({ GoogleLogin: () => null }));

const { AppRoutes } = await import('../App');

const admin = { id: 'admin-1', role: 'ADMIN', email: 'a@ucla.edu', fullName: 'Admin' };

const jsonResponse = (status, body) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

// The body the server answers every non-verify call with once the session is
// dead, or null while it is alive.
let deadSession;

const LogoutButton = () => {
  const { logout, user } = useAuth();
  return user ? <button onClick={logout}>sign out</button> : null;
};

const renderSignedInAt = async (path) => {
  window.history.replaceState(null, '', path);
  render(
    <BrowserRouter>
      <AuthProvider>
        <LogoutButton />
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
  await screen.findByText('staging');
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.setItem('token', 'live-token');
  deadSession = null;
  globalThis.fetch = vi.fn((url) => {
    if (url === '/api/auth/verify') return Promise.resolve(jsonResponse(200, { user: admin }));
    if (deadSession) return Promise.resolve(jsonResponse(401, deadSession));
    return Promise.resolve(jsonResponse(200, {}));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  apiClient.setToken(null);
  vi.restoreAllMocks();
});

const EXPIRED = 'Your session expired. Sign in again to continue.';
const INACTIVE = /this account is no longer active/i;

const endSession = async (body) => {
  deadSession = body;
  await act(async () => {
    await apiClient.get('/live-votes/active').catch(() => {});
  });
};

describe('AuthProvider, when the server ends the session', () => {
  it('lands on the login page and says the session expired', async () => {
    await renderSignedInAt('/staging');

    await endSession({ error: 'Invalid token', code: 'SESSION_INVALID', reason: 'expired' });

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(screen.queryByText(INACTIVE)).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(window.history.state?.usr).toEqual({ sessionEnded: 'expired' });
    expect(localStorage.getItem('token')).toBeNull();
    expect(apiClient.token).toBeNull();
  });

  it('reads a missing reason, as an older server sends, as expired', async () => {
    await renderSignedInAt('/staging');

    await endSession({ error: 'Invalid token', code: 'SESSION_INVALID' });

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(window.history.state?.usr).toEqual({ sessionEnded: 'expired' });
  });

  it.each([
    ['deactivated', 'Account deactivated'],
    ['not-found', 'User not found'],
  ])('says the account is no longer active when it was %s', async (reason, error) => {
    await renderSignedInAt('/staging');

    await endSession({ error, code: 'SESSION_INVALID', reason });

    expect(await screen.findByText(INACTIVE)).toBeInTheDocument();
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
    expect(window.history.state?.usr).toEqual({ sessionEnded: 'inactive' });
  });

  it('keeps an ordinary 401 from signing anyone out', async () => {
    await renderSignedInAt('/staging');

    await endSession({ error: 'Invalid token' });

    expect(screen.getByText('staging')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe('live-token');
  });

  it('shows no notice after an ordinary sign out', async () => {
    await renderSignedInAt('/staging');

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
    expect(screen.queryByText(INACTIVE)).not.toBeInTheDocument();
  });
});
