import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UserManagement from './UserManagement';
import apiClient from '../utils/api';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../components/AccessControl', () => ({
  default: ({ children }) => children,
}));

vi.mock('../components/MemberAvatar', () => ({
  default: function MockMemberAvatar({ member }) {
    return <div data-testid="member-avatar">{member?.fullName}</div>;
  },
}));

import { useAuth } from '../context/AuthContext';

describe('UserManagement profile image upload', () => {
  const adminUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    fullName: 'Admin User',
    profileImage: null,
    role: 'ADMIN',
  };

  const uploadedUser = {
    ...adminUser,
    profileImage: '/api/uploads/profile-images/admin.png',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({
      user: adminUser,
      updateUser: vi.fn(),
    });
    vi.spyOn(apiClient, 'get').mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/admin/users')) {
        return Promise.resolve([adminUser]);
      }
      if (typeof url === 'string' && url.startsWith('/admin/events')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    vi.spyOn(apiClient, 'post').mockResolvedValue({
      message: 'Profile image uploaded successfully',
      user: uploadedUser,
    });
  });

  it('updates the current user avatar in auth state after a successful profile image upload', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Admin User', { selector: 'h6' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Upload'));

    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeInTheDocument();

    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });
    fireEvent.change(fileInput);

    await act(async () => {
      await Promise.resolve();
    });

    const form = screen.getByText('Upload Image').closest('form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(useAuth().updateUser).toHaveBeenCalledWith(uploadedUser);
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      `/users/${adminUser.id}/profile-image`,
      expect.any(FormData)
    );
  });
});
