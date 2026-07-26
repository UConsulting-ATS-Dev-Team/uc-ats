import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CandidateAvatar, { getInitials } from './CandidateAvatar';

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
      'data-testid': 'candidate-image',
      className,
      style,
    });
  },
}));

describe('CandidateAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an image for a valid headshotUrl', () => {
    render(
      <CandidateAvatar
        applicant={{
          headshotUrl: '/api/uploads/valid.png',
          firstName: 'Alice',
          lastName: 'Anderson',
        }}
      />
    );

    expect(screen.getByTestId('candidate-image')).toBeInTheDocument();
    expect(screen.queryByText('AA')).not.toBeInTheDocument();
  });

  it('renders initials fallback when headshotUrl is missing', () => {
    render(
      <CandidateAvatar
        applicant={{ firstName: 'Bob', lastName: 'Baker' }}
      />
    );

    expect(screen.getByText('BB')).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-image')).not.toBeInTheDocument();
  });

  it('renders initials fallback when headshotUrl is blank', () => {
    render(
      <CandidateAvatar
        applicant={{
          headshotUrl: '   ',
          firstName: 'Carol',
          lastName: 'Clark',
        }}
      />
    );

    expect(screen.getByText('CC')).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-image')).not.toBeInTheDocument();
  });

  it('renders initials fallback when headshotUrl is not a string', () => {
    render(
      <CandidateAvatar
        applicant={{
          headshotUrl: 123,
          firstName: 'Dan',
          lastName: 'Davis',
        }}
      />
    );

    expect(screen.getByText('DD')).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-image')).not.toBeInTheDocument();
  });

  it('switches to initials after an image error', async () => {
    render(
      <CandidateAvatar
        applicant={{
          headshotUrl: 'error',
          firstName: 'Eve',
          lastName: 'Evans',
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('EE')).toBeInTheDocument();
      expect(screen.queryByTestId('candidate-image')).not.toBeInTheDocument();
    });
  });

  it('handles missing first and last name without crashing', () => {
    const { container } = render(<CandidateAvatar applicant={{ headshotUrl: null }} />);

    expect(container.querySelector('.candidate-avatar-fallback')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Candidate avatar');
  });

  it('handles non-string name values without crashing', () => {
    render(
      <CandidateAvatar
        applicant={{
          headshotUrl: null,
          firstName: 42,
          lastName: true,
        }}
      />
    );

    expect(screen.getByText('4T')).toBeInTheDocument();
  });
});

describe('getInitials', () => {
  it('computes uppercase initials from first and last name', () => {
    expect(getInitials('john', 'doe')).toBe('JD');
  });

  it('returns an empty string when both names are missing', () => {
    expect(getInitials(null, undefined)).toBe('');
  });

  it('safely handles non-string name values', () => {
    expect(getInitials(42, true)).toBe('4T');
  });
});
