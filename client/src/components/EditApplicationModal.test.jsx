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

  it('holds Update and Cancel until an upload in flight has finished', async () => {
    let finish;
    api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { onClose } = renderModal();

    await userEvent.upload(screen.getByLabelText('Resume *'), pdf());
    await userEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));

    expect(screen.getByRole('button', { name: 'Update Application' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    finish({ currentResumeUrl: '/api/resume-uploads/v2/file' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Application' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('refuses a file over 10 MB when it is chosen', async () => {
    renderModal();
    const big = pdf();
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });

    await userEvent.upload(screen.getByLabelText('Resume *'), big);

    expect(screen.getByText('That file is larger than 10 MB.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled();
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
