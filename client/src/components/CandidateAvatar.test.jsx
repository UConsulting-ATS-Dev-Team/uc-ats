import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CandidateAvatar, { getInitials, getDisplayName } from './CandidateAvatar';

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

  it('resets error state when the candidate/src changes', async () => {
    const { rerender } = render(
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
    });

    rerender(
      <CandidateAvatar
        applicant={{
          headshotUrl: '/api/uploads/eve.png',
          firstName: 'Eve',
          lastName: 'Evans',
        }}
      />
    );

    expect(screen.getByTestId('candidate-image')).toBeInTheDocument();
    expect(screen.queryByText('EE')).not.toBeInTheDocument();
  });

  it('handles missing first and last name without crashing', () => {
    const { container } = render(<CandidateAvatar applicant={{ headshotUrl: null }} />);

    expect(container.querySelector('.candidate-avatar-fallback')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Candidate avatar');
    expect(container.querySelector('svg')).toBeInTheDocument();
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

  it('shows a neutral person icon when names produce only punctuation or symbols', () => {
    const { container } = render(
      <CandidateAvatar
        applicant={{
          headshotUrl: null,
          firstName: '???',
          lastName: '...',
        }}
      />
    );

    expect(screen.queryByText('?')).not.toBeInTheDocument();
    expect(container.querySelector('.candidate-avatar-fallback')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      '??? ...'
    );
  });

  it('derives name and headshot from a nested application record', () => {
    render(
      <CandidateAvatar
        applicant={{
          applications: [
            {
              headshotUrl: '/api/uploads/headshot.png',
              firstName: 'Grace',
              lastName: 'Garcia',
            },
          ],
        }}
      />
    );

    expect(screen.getByTestId('candidate-image')).toBeInTheDocument();
    expect(screen.queryByText('GG')).not.toBeInTheDocument();
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

  it('returns an empty string for punctuation-only names', () => {
    expect(getInitials('???', '...')).toBe('');
  });

  it('returns a single initial for one name', () => {
    expect(getInitials('madonna', '')).toBe('M');
  });
});

describe('getDisplayName', () => {
  it('joins first and last name', () => {
    expect(getDisplayName('john', 'doe')).toBe('john doe');
  });

  it('falls back to a generic label when names are missing', () => {
    expect(getDisplayName(null, undefined)).toBe('Candidate avatar');
  });
});
