import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Profile from './Profile';
import apiClient from '../utils/api';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../components/MemberAvatar', () => ({
  default: function MockMemberAvatar({ member }) {
    return (
      <div data-testid="member-avatar">
        {member?.profileImage ? 'image:' + member.profileImage : 'fallback:' + member?.fullName}
      </div>
    );
  },
}));

import { useAuth } from '../context/AuthContext';

describe('Profile image replacement', () => {
  const currentUser = {
    id: 'member-1',
    email: 'member@example.com',
    fullName: 'Member User',
    profileImage: '/api/uploads/profile-images/old.png',
    role: 'MEMBER',
  };

  const updatedUser = {
    ...currentUser,
    profileImage: '/api/uploads/profile-images/new.png',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.mockReturnValue({
      user: currentUser,
      updateUser: vi.fn(),
    });
    vi.spyOn(apiClient, 'post').mockResolvedValue({
      message: 'Profile image uploaded successfully',
      user: updatedUser,
    });
  });

  it('replaces the current profile image and updates auth state without logout', async () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );

    expect(screen.getByText('image:/api/uploads/profile-images/old.png')).toBeInTheDocument();

    const fileInput = screen.getByTestId('profile-image-input');
    expect(fileInput).toBeInTheDocument();

    const file = new File(['avatar'], 'new-avatar.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });
    fireEvent.change(fileInput);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.submit(fileInput.closest('form'));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(useAuth().updateUser).toHaveBeenCalledWith(updatedUser);
    });

    expect(apiClient.post).toHaveBeenCalledWith(
      `/users/${currentUser.id}/profile-image`,
      expect.any(FormData)
    );

    expect(screen.getByText('Profile image updated successfully.')).toBeInTheDocument();
  });

  it('shows a validation error when the file is too large', async () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );

    const fileInput = screen.getByTestId('profile-image-input');
    const oversizedFile = new File(['x'.repeat(6 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', {
      value: [oversizedFile],
      configurable: true,
    });
    fireEvent.change(fileInput);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.submit(fileInput.closest('form'));

    await waitFor(() => {
      expect(screen.getByText('File size must be less than 5MB.')).toBeInTheDocument();
    });

    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
