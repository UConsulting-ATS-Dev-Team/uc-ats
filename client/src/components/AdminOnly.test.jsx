// The admin application queue at /application-list used to render for members,
// and login sent them straight there.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AdminOnly from './AdminOnly';

let auth;
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

const renderAt = (user) => {
  auth = { user, loading: false };
  return render(
    <MemoryRouter initialEntries={['/application-list']}>
      <Routes>
        <Route
          path="/application-list"
          element={
            <AdminOnly memberFallback="/candidates">
              <div>admin queue</div>
            </AdminOnly>
          }
        />
        <Route path="/candidates" element={<div>member applications</div>} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>
  );
};

beforeEach(() => {
  auth = null;
});

describe('AdminOnly', () => {
  it('shows the page to an admin', () => {
    renderAt({ role: 'ADMIN' });
    expect(screen.getByText('admin queue')).toBeInTheDocument();
  });

  it("sends a member to the member page instead", () => {
    renderAt({ role: 'MEMBER' });
    expect(screen.getByText('member applications')).toBeInTheDocument();
    expect(screen.queryByText('admin queue')).not.toBeInTheDocument();
  });

  it('sends a candidate home', () => {
    renderAt({ role: 'USER' });
    expect(screen.getByText('home')).toBeInTheDocument();
    expect(screen.queryByText('admin queue')).not.toBeInTheDocument();
  });
});
