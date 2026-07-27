import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PublicHostAvatar from './PublicHostAvatar';

function getImg(container) {
  return container.querySelector('img.public-host-avatar');
}

vi.mock('./MemberAvatar', () => ({
  getInitials: (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) || '';
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return `${first}${last}`.toUpperCase();
  }
}));

describe('PublicHostAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the host profile image for a safe public URL', () => {
    const { container } = render(
      <PublicHostAvatar
        name="Alex Host"
        profileImage="/api/uploads/profile-images/alex.png"
      />
    );

    const img = getImg(container);
    expect(img).toBeInTheDocument();
    expect(img.src).toContain('/api/uploads/profile-images/alex.png');
    expect(img).toHaveAttribute('alt', 'Alex Host');
  });

  it('renders initials fallback when profileImage is missing', () => {
    const { container } = render(<PublicHostAvatar name="Alex Host" />);

    expect(screen.getByText('AH')).toBeInTheDocument();
    expect(getImg(container)).not.toBeInTheDocument();
  });

  it('renders initials fallback for a blank profileImage', () => {
    const { container } = render(<PublicHostAvatar name="Alex Host" profileImage="   " />);

    expect(screen.getByText('AH')).toBeInTheDocument();
    expect(getImg(container)).not.toBeInTheDocument();
  });

  it('renders a person icon fallback when neither image nor initials are available', () => {
    render(<PublicHostAvatar name="" profileImage="bad" />);

    const fallback = screen.getByRole('img');
    expect(fallback).toBeInTheDocument();
    expect(screen.queryByText('AH')).not.toBeInTheDocument();
  });

  it('falls back to initials when the image fails to load', () => {
    const { container } = render(
      <PublicHostAvatar
        name="Alex Host"
        profileImage="/api/uploads/profile-images/alex.png"
      />
    );

    const img = getImg(container);
    fireEvent.error(img);

    expect(screen.getByText('AH')).toBeInTheDocument();
    expect(getImg(container)).not.toBeInTheDocument();
  });

  it('rejects unsafe profileImage URLs and falls back to initials', () => {
    const { container } = render(
      <PublicHostAvatar
        name="Alex Host"
        profileImage="javascript:alert(1)"
      />
    );

    expect(screen.getByText('AH')).toBeInTheDocument();
    expect(getImg(container)).not.toBeInTheDocument();
  });

  it('supports external public image URLs', () => {
    const { container } = render(
      <PublicHostAvatar
        name="Alex Host"
        profileImage="https://example.com/alex.png"
      />
    );

    const img = getImg(container);
    expect(img.src).toBe('https://example.com/alex.png');
  });

  it('applies custom size and className', () => {
    const { container } = render(
      <PublicHostAvatar
        name="Alex Host"
        profileImage="/api/uploads/profile-images/alex.png"
        size={48}
        className="custom-avatar"
      />
    );

    const img = getImg(container);
    expect(img.classList.contains('custom-avatar')).toBe(true);
    expect(img.style.width).toBe('48px');
    expect(img.style.height).toBe('48px');
  });

  it('retries image rendering when the profileImage source changes after an error', () => {
    const { container, rerender } = render(
      <PublicHostAvatar name="Alex Host" profileImage="/api/uploads/profile-images/bad.png" />
    );

    const badImg = getImg(container);
    fireEvent.error(badImg);
    expect(getImg(container)).not.toBeInTheDocument();
    expect(screen.getByText('AH')).toBeInTheDocument();

    rerender(
      <PublicHostAvatar name="Alex Host" profileImage="/api/uploads/profile-images/alex.png" />
    );

    expect(getImg(container)).toBeInTheDocument();
    expect(screen.queryByText('AH')).not.toBeInTheDocument();
  });
});
