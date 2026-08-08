import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CycleManagement from './CycleManagement';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let currentUser = { id: 'admin-1', role: 'ADMIN' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: currentUser }),
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/cycles']}>
      <CycleManagement />
    </MemoryRouter>
  );

describe('CycleManagement access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue([]);
  });

  it('lets an admin reach the timeline bootstrap surface', async () => {
    currentUser = { id: 'admin-1', role: 'ADMIN' };

    renderPage();

    expect(await screen.findByRole('button', { name: 'New Cycle from Timeline' })).toBeInTheDocument();
  });

  // Every endpoint behind this page is requireAdmin, so a member navigating
  // straight to /cycles must not even see the controls.
  it('denies a member who navigates directly to the page', async () => {
    currentUser = { id: 'member-1', role: 'MEMBER' };

    renderPage();

    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Cycle from Timeline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Cycle (dates only)' })).not.toBeInTheDocument();
    expect(screen.queryByText('Cycle Management')).not.toBeInTheDocument();
    await waitFor(() => expect(apiClient.get).not.toHaveBeenCalledWith('/admin/cycles'));
  });

  it('denies a candidate account as well', async () => {
    currentUser = { id: 'user-1', role: 'USER' };

    renderPage();

    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
  });
});
