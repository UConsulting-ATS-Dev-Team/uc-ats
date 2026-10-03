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

let sessionDead;

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
  sessionDead = false;
  globalThis.fetch = vi.fn((url) => {
    if (url === '/api/auth/verify') return Promise.resolve(jsonResponse(200, { user: admin }));
    if (sessionDead) {
      return Promise.resolve(jsonResponse(401, { error: 'Invalid token', code: 'SESSION_INVALID' }));
    }
    return Promise.resolve(jsonResponse(200, {}));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  apiClient.setToken(null);
  vi.restoreAllMocks();
});

describe('AuthProvider, when the server ends the session', () => {
  it('lands on the login page and says why', async () => {
    await renderSignedInAt('/staging');

    sessionDead = true;
    await act(async () => {
      await apiClient.get('/live-votes/active').catch(() => {});
    });

    expect(await screen.findByText('Your session expired. Sign in again to continue.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(window.history.state?.usr).toEqual({ sessionExpired: true });
    expect(localStorage.getItem('token')).toBeNull();
    expect(apiClient.token).toBeNull();
  });

  it('keeps an ordinary 401 from signing anyone out', async () => {
    await renderSignedInAt('/staging');

    globalThis.fetch.mockImplementation(() => Promise.resolve(jsonResponse(401, { error: 'Invalid token' })));
    await act(async () => {
      await apiClient.get('/live-votes/active').catch(() => {});
    });

    expect(screen.getByText('staging')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe('live-token');
  });

  it('shows no notice after an ordinary sign out', async () => {
    await renderSignedInAt('/staging');

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });
});
