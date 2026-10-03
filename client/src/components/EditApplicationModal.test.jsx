import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditApplicationModal from './EditApplicationModal';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { post: vi.fn(), put: vi.fn() },
}));

const application = {
  id: 'app-1',
  firstName: 'Jane',
  lastName: 'Bruin',
  email: 'jane@ucla.edu',
  studentId: '405123456',
  phoneNumber: '3105550100',
  graduationYear: '2027',
  cumulativeGpa: 3.8,
  major1: 'Economics',
  resumeUrl: '/api/files/drive-1/pdf',
  blindResumeUrl: '/api/files/blind-1/pdf',
  headshotUrl: '/api/files/head-1/image',
  status: 'SUBMITTED',
};

const pdf = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'fixed.pdf', { type: 'application/pdf' });

const renderModal = (props = {}) => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  render(
    <EditApplicationModal isOpen application={application} onClose={onClose} onSuccess={onSuccess} {...props} />
  );
  return { onClose, onSuccess };
};

describe('EditApplicationModal resume upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads a chosen PDF and points the application at it', async () => {
    api.post.mockResolvedValue({ currentResumeUrl: '/api/resume-uploads/v2/file' });
    renderModal();

    await userEvent.upload(screen.getByLabelText('Resume *'), pdf());
    await userEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));

    await waitFor(() => expect(screen.getByText(/resume replaced/i)).toBeInTheDocument());

    const [endpoint, body] = api.post.mock.calls[0];
    expect(endpoint).toBe('/resume-uploads/applications/app-1');
    expect(body.get('resume').name).toBe('fixed.pdf');

    expect(screen.getByLabelText('Or paste a link')).toHaveValue('/api/resume-uploads/v2/file');
    // The blind copy was made from the old resume, so it goes with it.
    expect(screen.getByLabelText('Blind Resume URL')).toHaveValue('');
  });

  it('refreshes the list when closed after an upload, without pressing Update', async () => {
    api.post.mockResolvedValue({ currentResumeUrl: '/api/resume-uploads/v2/file' });
    const { onClose, onSuccess } = renderModal();

    await userEvent.upload(screen.getByLabelText('Resume *'), pdf());
    await userEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));
    await waitFor(() => expect(screen.getByText(/resume replaced/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('does not refresh the list when closed with nothing uploaded', async () => {
    const { onClose, onSuccess } = renderModal();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the server\'s reason when an upload is refused and keeps the old link', async () => {
    api.post.mockRejectedValue(new Error('That file is not a readable PDF'));
    renderModal();

    await userEvent.upload(screen.getByLabelText('Resume *'), pdf());
    await userEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));

    await waitFor(() => expect(screen.getByText('That file is not a readable PDF')).toBeInTheDocument());
    expect(screen.getByLabelText('Or paste a link')).toHaveValue('/api/files/drive-1/pdf');
  });
});
