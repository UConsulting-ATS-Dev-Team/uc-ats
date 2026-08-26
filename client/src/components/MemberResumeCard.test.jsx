// The member's own resume card. What is worth pinning down here is the split
// this branch introduced: details save on their own, and neither saving details
// nor replacing the PDF may change the sharing answer by accident.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MemberResumeCard from './MemberResumeCard';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('./DocumentPreviewModal', () => ({
  default: () => null,
}));

const resume = (overrides = {}) => ({
  id: 'mr-1',
  originalName: 'resume.pdf',
  fileSize: 1024,
  major1: 'Statistics',
  major2: null,
  graduationYear: '2027',
  gender: 'Other',
  shareConsent: true,
  assignedCount: 3,
  ...overrides,
});

const loadWith = (value) => {
  api.get.mockResolvedValue({ resume: value, genders: ['Male', 'Female', 'Other'] });
};

const renderCard = async () => {
  render(<MemberResumeCard />);
  await screen.findByText('Talent Partner Network resume');
};

describe('MemberResumeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadWith(resume());
  });

  it('saves details on their own, with no PDF attached', async () => {
    api.patch.mockResolvedValue({ resume: resume({ graduationYear: '2028' }) });
    await renderCard();

    const year = screen.getByTestId('member-resume-graduation-year');
    await userEvent.clear(year);
    await userEvent.type(year, '2028');
    await userEvent.click(screen.getByTestId('member-resume-save-details'));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith(
      '/member/resume',
      expect.objectContaining({ graduationYear: '2028', major1: 'Statistics' })
    );
    // The correction must not go through the upload route, which would
    // supersede the row and strand the partners already holding the resume.
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
  });

  it('offers nothing to save until something actually changed', async () => {
    await renderCard();
    expect(screen.getByTestId('member-resume-save-details')).toBeDisabled();

    await userEvent.type(screen.getByTestId('member-resume-major1'), 'x');
    expect(screen.getByTestId('member-resume-save-details')).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByTestId('member-resume-major1')).toHaveValue('Statistics');
    expect(screen.getByTestId('member-resume-save-details')).toBeDisabled();
  });

  it('shows the sharing answer on file rather than defaulting to unticked', async () => {
    await renderCard();
    // Defaulting to false made replacing a PDF read as a withdrawal to anyone
    // who looked at the form before submitting it.
    expect(screen.getByTestId('member-resume-consent')).toBeChecked();
  });

  it('starts a member with no resume unticked and with nothing to withdraw', async () => {
    loadWith(null);
    await renderCard();

    expect(screen.getByTestId('member-resume-consent')).not.toBeChecked();
    expect(screen.queryByTestId('member-resume-save-details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove resume' })).not.toBeInTheDocument();
    expect(screen.getByTestId('member-resume-upload')).toHaveTextContent('Upload resume');
  });

  it('names the number of partners before withdrawing, and only then withdraws', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderCard();

    await userEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

    expect(confirm.mock.calls[0][0]).toMatch(/3 partner organization\(s\)/);
    expect(api.patch).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('removes the resume through the delete route once confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.delete.mockResolvedValue({ ok: true });
    await renderCard();

    await userEvent.click(screen.getByRole('button', { name: 'Remove resume' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/member/resume'));
    expect(confirm.mock.calls[0][0]).toMatch(/3 partner organization\(s\)/);
    expect(await screen.findByText('Resume removed.')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('surfaces a rejected edit instead of leaving the form looking saved', async () => {
    api.patch.mockRejectedValue(new Error('Enter your graduation year as four digits, for example 2027.'));
    await renderCard();

    const year = screen.getByTestId('member-resume-graduation-year');
    await userEvent.clear(year);
    await userEvent.type(year, '27');
    await userEvent.click(screen.getByTestId('member-resume-save-details'));

    expect(await screen.findByText(/four digits/)).toBeInTheDocument();
    expect(screen.getByTestId('member-resume-save-details')).toBeEnabled();
  });
});
