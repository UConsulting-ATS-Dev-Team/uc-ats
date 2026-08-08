import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GtkucProfileModal from './GtkucProfileModal';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { put: vi.fn() },
}));

const state = {
  profile: {
    industries: ['Consulting'],
    interests: ['Case prep'],
    relevance: 'Happy to talk recruiting timelines.',
    candidateVisible: true,
  },
  profileImage: 'https://example.com/photo.jpg',
  activeCycle: { id: 'cycle-2026', name: 'Fall 2026' },
  taxonomy: {
    industries: ['Consulting', 'Technology'],
    interests: ['Case prep', 'Networking'],
    maxIndustries: 5,
    maxInterests: 8,
    relevanceMaxLength: 500,
  },
};

describe('GtkucProfileModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a hard gate when required: no cancel and no dismiss handler', () => {
    const onClose = vi.fn();
    render(<GtkucProfileModal open state={state} required onClose={onClose} />);

    expect(screen.getByText('Confirm your Get to Know UC profile')).toBeInTheDocument();
    expect(screen.getByText(/once per\s+recruiting cycle \(Fall 2026\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is dismissible in edit mode', async () => {
    const onClose = vi.fn();
    render(<GtkucProfileModal open state={state} onClose={onClose} />);

    expect(screen.getByText('Edit your Get to Know UC profile')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('blocks submission until industries, interests, and a blurb are all present', () => {
    const empty = { ...state, profile: { industries: [], interests: [], relevance: '' } };
    render(<GtkucProfileModal open state={empty} required />);

    expect(screen.getByRole('button', { name: 'Confirm profile' })).toBeDisabled();
  });

  it('saves the profile and hands the new state back', async () => {
    api.put.mockResolvedValue({ confirmationRequired: false });
    const onSaved = vi.fn();
    render(<GtkucProfileModal open state={state} required onSaved={onSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm profile' }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/member/gtkuc-profile', {
        industries: ['Consulting'],
        interests: ['Case prep'],
        relevance: 'Happy to talk recruiting timelines.',
        candidateVisible: true,
      })
    );
    expect(onSaved).toHaveBeenCalledWith({ confirmationRequired: false });
  });

  it('surfaces a save failure and keeps the dialog open', async () => {
    api.put.mockRejectedValue(new Error('Add a short blurb'));
    const onSaved = vi.fn();
    render(<GtkucProfileModal open state={state} required onSaved={onSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm profile' }));

    expect(await screen.findByText('Add a short blurb')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
