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

describe('UserManagement graduation class filter', () => {
  const MISSING_GRADUATION_CLASS = '__UNKNOWN_GRADUATION_CLASS__';

  const adminUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    fullName: 'Admin User',
    role: 'ADMIN',
    graduationClass: null,
    createdAt: '2025-01-01T00:00:00Z',
    _count: { comments: 0, evaluations: 0 }
  };

  const allUsers = [
    {
      id: 'u1',
      email: 'alice@example.com',
      fullName: 'Alice Anderson',
      role: 'MEMBER',
      graduationClass: 'Spring 2025',
      createdAt: '2025-01-01T00:00:00Z',
      _count: { comments: 0, evaluations: 0 }
    },
    {
      id: 'u2',
      email: 'bob@example.com',
      fullName: 'Bob Baker',
      role: 'MEMBER',
      graduationClass: '',
      createdAt: '2025-01-01T00:00:00Z',
      _count: { comments: 0, evaluations: 0 }
    },
    {
      id: 'u3',
      email: 'carol@example.com',
      fullName: 'Carol Chen',
      role: 'USER',
      graduationClass: 'Fall 2024',
      createdAt: '2025-01-01T00:00:00Z',
      _count: { comments: 0, evaluations: 0 }
    }
  ];

  function getClassSelectTrigger() {
    const label = screen.getByText('Filter by Class', { selector: 'label' });
    const formControl = label.closest('.MuiFormControl-root');
    return formControl.querySelector('.MuiSelect-select');
  }

  function selectClassOption(name) {
    const trigger = getClassSelectTrigger();
    fireEvent.mouseDown(trigger);
    const option = screen.getByRole('option', { name });
    fireEvent.click(option);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAuth.mockReturnValue({
      user: adminUser,
      updateUser: vi.fn()
    });
    vi.spyOn(apiClient, 'get').mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/admin/users')) {
        const params = new URLSearchParams(url.split('?')[1] || '');
        const role = params.get('role');
        const cls = params.get('graduationClass');
        let result = allUsers;
        if (role) result = result.filter((u) => u.role === role);
        if (cls) {
          if (cls === MISSING_GRADUATION_CLASS) {
            result = result.filter((u) => !u.graduationClass || u.graduationClass.trim() === '');
          } else {
            result = result.filter((u) => u.graduationClass === cls);
          }
        }
        return Promise.resolve(result);
      }
      if (typeof url === 'string' && url.startsWith('/admin/events')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  it('renders the class filter with All, Unknown, and sorted class options', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });

    const trigger = getClassSelectTrigger();
    fireEvent.mouseDown(trigger);

    expect(screen.getByRole('option', { name: 'All Classes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unknown / No class' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Fall 2024' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Spring 2025' })).toBeInTheDocument();
  });

  it('filters by an unknown or blank graduation class and shows an active chip with count', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });

    selectClassOption('Unknown / No class');

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/admin/users?graduationClass=' + encodeURIComponent(MISSING_GRADUATION_CLASS))
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Bob Baker', { selector: 'h6' })).toBeInTheDocument();
    });
    expect(screen.queryByText('Alice Anderson', { selector: 'h6' })).not.toBeInTheDocument();

    expect(screen.getByText('Class: Unknown / No class')).toBeInTheDocument();
    expect(screen.getByText('1 user')).toBeInTheDocument();
  });

  it('filters by a known graduation class', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });

    selectClassOption('Spring 2025');

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/admin/users?graduationClass=Spring+2025')
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });
    expect(screen.queryByText('Bob Baker', { selector: 'h6' })).not.toBeInTheDocument();
    expect(screen.queryByText('Carol Chen', { selector: 'h6' })).not.toBeInTheDocument();
  });

  it('composes graduation class filter with role filter', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });

    selectClassOption('Spring 2025');

    const roleLabel = screen.getByText('Filter by Role', { selector: 'label' });
    const roleControl = roleLabel.closest('.MuiFormControl-root');
    const roleTrigger = roleControl.querySelector('.MuiSelect-select');
    fireEvent.mouseDown(roleTrigger);
    fireEvent.click(screen.getByRole('option', { name: 'Member' }));

    await waitFor(() => {
      const calls = apiClient.get.mock.calls.filter((call) =>
        typeof call[0] === 'string' && call[0].startsWith('/admin/users')
      );
      expect(calls.some((call) => call[0].includes('role=MEMBER') && call[0].includes('graduationClass=Spring+2025'))).toBe(true);
    });
  });

  it('composes graduation class filter with the search input', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });

    selectClassOption('Spring 2025');

    await waitFor(() => {
      expect(screen.getByText('1 user')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText('Search Users');
    fireEvent.change(searchInput, { target: { value: 'zzz' } });

    await waitFor(() => {
      expect(screen.getByText('No users found')).toBeInTheDocument();
      expect(screen.getByText('Try adjusting your search or filter criteria.')).toBeInTheDocument();
    });
  });

  it('clears the class filter when the active chip is deleted', async () => {
    render(
      <MemoryRouter>
        <UserManagement />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });

    selectClassOption('Fall 2024');

    await waitFor(() => {
      expect(screen.queryByText('Alice Anderson', { selector: 'h6' })).not.toBeInTheDocument();
    });

    const chipRoot = screen.getByText('Class: Fall 2024').closest('.MuiChip-root');
    fireEvent.click(chipRoot.querySelector('.MuiChip-deleteIcon'));

    await waitFor(() => {
      expect(screen.getByText('Alice Anderson', { selector: 'h6' })).toBeInTheDocument();
    });
    expect(screen.getByText('3 users')).toBeInTheDocument();
  });
});
