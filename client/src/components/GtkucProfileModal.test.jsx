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
    linkedinUrl: 'https://www.linkedin.com/in/member-one',
    candidateVisible: true,
  },
  profileImage: 'https://example.com/photo.jpg',
  activeCycle: { id: 'cycle-2026', name: 'Fall 2026' },
  taxonomy: {
    industries: ['Consulting', 'Technology'],
    interests: ['Case prep', 'Networking'],
    maxIndustries: 5,
    maxInterests: 8,
    interestMaxLength: 40,
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

  it('blocks submission until industries and interests are both present', () => {
    const empty = { ...state, profile: { industries: [], interests: [] } };
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
        linkedinUrl: 'https://www.linkedin.com/in/member-one',
        candidateVisible: true,
      })
    );
    expect(onSaved).toHaveBeenCalledWith({ confirmationRequired: false });
  });

  it('prefills the LinkedIn link and sends an edited one', async () => {
    api.put.mockResolvedValue({ confirmationRequired: false });
    render(<GtkucProfileModal open state={state} />);

    const field = screen.getByLabelText('LinkedIn profile');
    expect(field).toHaveValue('https://www.linkedin.com/in/member-one');

    await userEvent.clear(field);
    await userEvent.type(field, 'linkedin.com/in/new-handle');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        '/member/gtkuc-profile',
        expect.objectContaining({ linkedinUrl: 'linkedin.com/in/new-handle' })
      )
    );
  });

  it('accepts an interest that is not in the suggested list', async () => {
    api.put.mockResolvedValue({ confirmationRequired: false });
    render(<GtkucProfileModal open state={state} />);

    const field = screen.getByLabelText('Interests');
    await userEvent.type(field, 'Formula 1{enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        '/member/gtkuc-profile',
        expect.objectContaining({ interests: ['Case prep', 'Formula 1'] })
      )
    );
  });

  it('surfaces a save failure and keeps the dialog open', async () => {
    api.put.mockRejectedValue(new Error('Enter a LinkedIn profile URL'));
    const onSaved = vi.fn();
    render(<GtkucProfileModal open state={state} required onSaved={onSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm profile' }));

    expect(await screen.findByText('Enter a LinkedIn profile URL')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
