import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OfferLetterSection from './OfferLetterSection';
import apiClient from '../utils/api';

const baseApplication = {
  id: 'app-1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  status: 'ACCEPTED',
  finalRoundDecision: 'yes',
  currentRound: '5',
  cycleId: 'cycle-1'
};

const defaultTemplate = {
  responseDeadline: 'Friday, January 23rd at 11:59 PM',
  signaturePath: 'cycle-1/signature.png',
  terms: ['Term 1']
};

const sentComment = {
  id: 'c-1',
  content: '[OFFER_LETTER_SENT] Offer letter sent to jane@example.com for position Associate.',
  createdAt: '2026-07-20T10:00:00.000Z',
  user: { fullName: 'Admin User' }
};

describe('OfferLetterSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get = vi.fn().mockResolvedValue(defaultTemplate);
    apiClient.post = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not render for non-admin users', () => {
    render(<OfferLetterSection application={baseApplication} comments={[]} isAdmin={false} />);
    expect(screen.queryByText('Offer Letter')).not.toBeInTheDocument();
  });

  it('does not render when the candidate is not Final Round accepted', () => {
    const application = { ...baseApplication, status: 'UNDER_REVIEW', finalRoundDecision: null };
    render(<OfferLetterSection application={application} comments={[]} isAdmin />);
    expect(screen.queryByText('Offer Letter')).not.toBeInTheDocument();
  });

  it('shows send status and a send button for an admin with a Final Round accepted candidate', async () => {
    render(<OfferLetterSection application={baseApplication} comments={[]} isAdmin />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/cycles/cycle-1/offer-letter-template'));
    expect(screen.getByText('Offer Letter')).toBeInTheDocument();
    expect(screen.getByText('No offer letter has been sent yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Offer Letter' })).toBeInTheDocument();
  });

  it('shows the last sent timestamp when an offer letter has already been sent', async () => {
    render(<OfferLetterSection application={baseApplication} comments={[sentComment]} isAdmin />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(screen.getByText(/Offer letter sent on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend Offer Letter' })).toBeInTheDocument();
  });

  it('sends an offer letter with required fields and calls onSent on success', async () => {
    const onSent = vi.fn();
    apiClient.post.mockResolvedValue({ success: true, messageId: 'msg-123' });

    render(<OfferLetterSection application={baseApplication} comments={[]} isAdmin onSent={onSent} />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Send Offer Letter' }));

    fireEvent.change(screen.getByLabelText(/Position/i), { target: { value: 'Associate' } });
    fireEvent.change(screen.getByLabelText(/Response Deadline/i), { target: { value: 'August 15, 2026' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send Offer Letter' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/admin/applications/app-1/send-offer-letter',
        expect.objectContaining({
          position: 'Associate',
          responseDeadline: 'August 15, 2026'
        })
      );
    });

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(screen.getByText('Offer letter sent successfully.')).toBeInTheDocument();
  });

  it('validates required fields before sending', async () => {
    render(<OfferLetterSection application={baseApplication} comments={[]} isAdmin />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Send Offer Letter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Offer Letter' }));

    await waitFor(() => {
      expect(screen.getByText('Position is required')).toBeInTheDocument();
    });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('displays an error when the backend reports a duplicate send', async () => {
    apiClient.post.mockRejectedValue(new Error('Offer letter has already been sent'));

    render(<OfferLetterSection application={baseApplication} comments={[sentComment]} isAdmin />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Resend Offer Letter' }));

    fireEvent.change(screen.getByLabelText(/Position/i), { target: { value: 'Associate' } });
    fireEvent.change(screen.getByLabelText(/Response Deadline/i), { target: { value: 'August 15, 2026' } });

    fireEvent.click(screen.getByRole('button', { name: 'Resend Offer Letter' }));

    await waitFor(() => {
      expect(screen.getByText(/already been sent/)).toBeInTheDocument();
    });
  });

  it('warns when no president signature is configured', async () => {
    apiClient.get.mockResolvedValue({ ...defaultTemplate, signaturePath: '' });
    render(<OfferLetterSection application={baseApplication} comments={[]} isAdmin />);
    await waitFor(() =>
      expect(screen.getByText(/No president signature is configured/)).toBeInTheDocument()
    );
  });
});
