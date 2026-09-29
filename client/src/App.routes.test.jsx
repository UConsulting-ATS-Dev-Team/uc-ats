// The admin application pages through the real route table: ProtectedRoute, then the
// admin-only guard. Only the pages on either side of the redirect and the
// staff layout are stubbed.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let auth;
vi.mock('./context/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => auth
}));
vi.mock('./analytics', () => ({ trackRouteChange: () => {} }));
vi.mock('./components/Layout', () => ({ default: ({ children }) => <>{children}</> }));
vi.mock('./pages/ApplicationList', () => ({ default: () => <div>admin application queue</div> }));
vi.mock('./pages/ApplicationDetail', () => ({ default: () => <div>application detail</div> }));
vi.mock('./pages/Staging', () => ({ default: () => <div>staging</div> }));
vi.mock('./pages/ReviewTeams', () => ({ default: () => <div>review teams</div> }));
vi.mock('./pages/Candidates', () => ({ default: () => <div>member applications</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>admin dashboard</div> }));
vi.mock('./pages/MemberDashboard', () => ({ default: () => <div>member dashboard</div> }));

const { AppRoutes } = await import('./App');

const renderAt = (path, user) => {
  auth = { user, loading: false };
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
};

describe('admin-only application pages', () => {
  it('shows the admin queue to an admin', () => {
    renderAt('/application-list', { id: 1, role: 'ADMIN' });
    expect(screen.getByText('admin application queue')).toBeInTheDocument();
  });

  it('sends a member to their own applications page', () => {
    renderAt('/application-list', { id: 2, role: 'MEMBER' });
    expect(screen.getByText('member applications')).toBeInTheDocument();
    expect(screen.queryByText('admin application queue')).not.toBeInTheDocument();
  });

  it('sends a member arriving by the old /candidate-management link the same way', () => {
    renderAt('/candidate-management', { id: 2, role: 'MEMBER' });
    expect(screen.getByText('member applications')).toBeInTheDocument();
  });

  it('shows an application detail page to an admin', () => {
    renderAt('/application/app-1', { id: 1, role: 'ADMIN' });
    expect(screen.getByText('application detail')).toBeInTheDocument();
  });

  it('sends a member away from an application detail page', () => {
    renderAt('/application/app-1', { id: 2, role: 'MEMBER' });
    expect(screen.getByText('member applications')).toBeInTheDocument();
    expect(screen.queryByText('application detail')).not.toBeInTheDocument();
  });

  it.each([
    ['/staging', 'staging'],
    ['/review-teams', 'review teams'],
  ])('shows %s to an admin and sends a member away', (path, page) => {
    renderAt(path, { id: 1, role: 'ADMIN' });
    expect(screen.getByText(page)).toBeInTheDocument();
    cleanup();

    renderAt(path, { id: 2, role: 'MEMBER' });
    expect(screen.getByText('member applications')).toBeInTheDocument();
    expect(screen.queryByText(page)).not.toBeInTheDocument();
  });

  it('lands a member on their dashboard at /dashboard, where login now sends them', () => {
    renderAt('/dashboard', { id: 2, role: 'MEMBER' });
    expect(screen.getByText('member dashboard')).toBeInTheDocument();
  });
});
