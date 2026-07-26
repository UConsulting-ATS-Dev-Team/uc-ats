import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MemberAvatar, {
  getInitials,
  getMemberDisplayName,
  getMemberImageUrl,
} from './MemberAvatar';

vi.mock('./AuthenticatedImage', () => ({
  default: function MockAuthenticatedImage({ src, alt, onError, className, style }) {
    React.useEffect(() => {
      if (src === 'error' && onError) {
        onError();
      }
    }, [src, onError]);

    return React.createElement('img', {
      src,
      alt,
      'data-testid': 'member-image',
      className,
      style,
    });
  },
}));

describe('MemberAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an image for a valid profileImage', () => {
    render(
      <MemberAvatar
        member={{
          id: 'member-1',
          fullName: 'Alice Anderson',
          profileImage: '/api/uploads/profile-images/alice.png',
        }}
      />
    );

    expect(screen.getByTestId('member-image')).toBeInTheDocument();
    expect(screen.queryByText('AA')).not.toBeInTheDocument();
  });

  it('renders initials fallback when profileImage is missing', () => {
    render(
      <MemberAvatar
        member={{
          id: 'member-2',
          fullName: 'Bob Baker',
        }}
      />
    );

    expect(screen.getByText('BB')).toBeInTheDocument();
    expect(screen.queryByTestId('member-image')).not.toBeInTheDocument();
  });

  it('renders initials fallback when profileImage is blank', () => {
    render(
      <MemberAvatar
        member={{
          id: 'member-3',
          fullName: 'Carol Clark',
          profileImage: '   ',
        }}
      />
    );

    expect(screen.getByText('CC')).toBeInTheDocument();
    expect(screen.queryByTestId('member-image')).not.toBeInTheDocument();
  });

  it('renders initials fallback when profileImage is not a string', () => {
    render(
      <MemberAvatar
        member={{
          id: 'member-4',
          fullName: 'Dan Davis',
          profileImage: 123,
        }}
      />
    );

    expect(screen.getByText('DD')).toBeInTheDocument();
    expect(screen.queryByTestId('member-image')).not.toBeInTheDocument();
  });

  it('switches to initials after an image error', async () => {
    render(
      <MemberAvatar
        member={{
          id: 'member-5',
          fullName: 'Eve Evans',
          profileImage: 'error',
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('EE')).toBeInTheDocument();
      expect(screen.queryByTestId('member-image')).not.toBeInTheDocument();
    });
  });

  it('renders a fallback when member is undefined', () => {
    const { container } = render(<MemberAvatar />);

    expect(container.querySelector('.member-avatar-fallback')).toBeInTheDocument();
  });

  it('does not crash when member name is missing', () => {
    const { container } = render(<MemberAvatar member={{ id: 'member-6' }} />);

    expect(container.querySelector('.member-avatar-fallback')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('handles non-string name values without crashing', () => {
    render(
      <MemberAvatar
        member={{
          id: 'member-7',
          fullName: 42,
        }}
      />
    );

    expect(screen.getByText('4')).toBeInTheDocument();
  });
});

describe('getInitials', () => {
  it('computes uppercase initials from first and last name', () => {
    expect(getInitials('john doe')).toBe('JD');
  });

  it('returns a single initial for one name', () => {
    expect(getInitials('madonna')).toBe('M');
  });

  it('returns an empty string for missing names', () => {
    expect(getInitials(null)).toBe('');
  });

  it('safely handles non-string name values', () => {
    expect(getInitials(42)).toBe('4');
  });
});

describe('member avatar helpers', () => {
  it('getMemberDisplayName prefers fullName, then name, then fallback', () => {
    expect(getMemberDisplayName({ fullName: 'Alice A' })).toBe('Alice A');
    expect(getMemberDisplayName({ name: 'Bob B' })).toBe('Bob B');
    expect(getMemberDisplayName({ displayName: 'Carol C' })).toBe('Carol C');
    expect(getMemberDisplayName(null)).toBe('Member');
  });

  it('getMemberImageUrl prefers profileImage, then avatar', () => {
    expect(getMemberImageUrl({ profileImage: '/img.png' })).toBe('/img.png');
    expect(getMemberImageUrl({ avatar: '/img.png' })).toBe('/img.png');
    expect(getMemberImageUrl({})).toBe('');
  });
});

describe('MemberAvatar size and className', () => {
  it('renders a fallback with the requested size and className', () => {
    const { container } = render(
      <MemberAvatar
        member={{ fullName: 'Sam Smith' }}
        size={48}
        className="custom-avatar"
      />
    );

    const fallback = container.querySelector('.member-avatar-fallback');
    expect(fallback).toBeInTheDocument();
    expect(fallback.classList.contains('custom-avatar')).toBe(true);
    expect(fallback.style.width).toBe('48px');
    expect(fallback.style.height).toBe('48px');
  });

  it('renders an image with the requested size and className', () => {
    render(
      <MemberAvatar
        member={{ fullName: 'Sam Smith', profileImage: '/img.png' }}
        size={48}
        className="custom-avatar"
      />
    );

    const image = screen.getByTestId('member-image');
    expect(image.classList.contains('custom-avatar')).toBe(true);
    expect(image.classList.contains('member-avatar')).toBe(true);
    expect(image.style.width).toBe('48px');
    expect(image.style.height).toBe('48px');
  });

  it('uses avatar and name keys when fullName/profileImage are absent', () => {
    render(
      <MemberAvatar
        member={{ name: 'Alex Archer', avatar: '/avatar.png' }}
        size={40}
      />
    );

    const image = screen.getByTestId('member-image');
    expect(image).toBeInTheDocument();
    expect(image.src).toContain('/avatar.png');
    expect(image.alt).toBe('Alex Archer');
  });
});
