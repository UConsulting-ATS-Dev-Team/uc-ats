import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResumeReuploadSection from './ResumeReuploadSection';
import api from '../utils/api';

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const MAX_BYTES = 10 * 1024 * 1024;

const openState = {
  applicationId: 'app-1',
  currentResumeUrl: '/api/files/drive-1/pdf',
  maxBytes: MAX_BYTES,
  canReplace: true,
  reason: null,
  deadline: '2026-10-04T23:59:59.999Z',
  deadlineLabel: '2026-10-04',
  versions: [
    {
      id: null,
      url: '/api/files/drive-1/pdf',
      originalName: null,
      sizeBytes: null,
      uploadedAt: '2026-09-01T12:00:00.000Z',
      replacedByCandidate: false,
      isCurrent: true,
    },
  ],
};

const pdf = (name = 'new-resume.pdf') =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, { type: 'application/pdf' });

describe('ResumeReuploadSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue(openState);
  });

  it('offers an upload with the deadline spelled out when the window is open', async () => {
    render(<ResumeReuploadSection applicationId="app-1" />);

    await waitFor(() => expect(screen.getByText(/You can make changes until/)).toBeInTheDocument());
    expect(screen.getByText(/October 4, 2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload new resume' })).toBeDisabled();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('explains why replacement is closed instead of showing a file picker', async () => {
    api.get.mockResolvedValue({
      ...openState,
      canReplace: false,
      reason: 'The resume deadline for Fall 2026 has passed.',
    });

    render(<ResumeReuploadSection applicationId="app-1" />);

    await waitFor(() =>
      expect(screen.getByText('The resume deadline for Fall 2026 has passed.')).toBeInTheDocument()
    );
    expect(screen.queryByLabelText('Choose a new resume PDF')).not.toBeInTheDocument();
  });

  it('uploads the chosen PDF and hands the new URL back to the parent', async () => {
    const onReplaced = vi.fn();
    api.post.mockResolvedValue({
      message: 'Your resume has been updated.',
      currentResumeUrl: '/api/resume-uploads/v2/file',
      versions: [
        { ...openState.versions[0], id: 'v1', isCurrent: false },
        {
          id: 'v2',
          url: '/api/resume-uploads/v2/file',
          originalName: 'new-resume.pdf',
          sizeBytes: 1024,
          uploadedAt: '2026-09-20T12:00:00.000Z',
          replacedByCandidate: true,
          isCurrent: true,
        },
      ],
    });

    render(<ResumeReuploadSection applicationId="app-1" onReplaced={onReplaced} />);
    await waitFor(() => expect(screen.getByLabelText('Choose a new resume PDF')).toBeInTheDocument());

    await userEvent.upload(screen.getByLabelText('Choose a new resume PDF'), pdf());
    await userEvent.click(screen.getByRole('button', { name: 'Upload new resume' }));

    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith('/api/resume-uploads/v2/file'));
    expect(api.post).toHaveBeenCalledWith('/resume-uploads/applications/app-1', expect.any(FormData));
    expect(screen.getByText('Your resume has been updated.')).toBeInTheDocument();
    expect(screen.getByText('new-resume.pdf')).toBeInTheDocument();
  });

  it('rejects a non-PDF before it reaches the server', async () => {
    render(<ResumeReuploadSection applicationId="app-1" />);
    await waitFor(() => expect(screen.getByLabelText('Choose a new resume PDF')).toBeInTheDocument());

    // Fired directly rather than through userEvent.upload: that helper honours
    // the `accept` attribute, but a real browser lets someone pick "All files"
    // and hand the input anything, which is exactly what this guard is for.
    fireEvent.change(screen.getByLabelText('Choose a new resume PDF'), {
      target: { files: [new File(['x'], 'resume.png', { type: 'image/png' })] },
    });

    expect(screen.getByText('Your resume must be a PDF.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload new resume' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('surfaces an upload failure without clearing the history', async () => {
    api.post.mockRejectedValue(new Error('The resume deadline for Fall 2026 has passed. (Status: 403)'));

    render(<ResumeReuploadSection applicationId="app-1" />);
    await waitFor(() => expect(screen.getByLabelText('Choose a new resume PDF')).toBeInTheDocument());

    await userEvent.upload(screen.getByLabelText('Choose a new resume PDF'), pdf());
    await userEvent.click(screen.getByRole('button', { name: 'Upload new resume' }));

    await waitFor(() => expect(screen.getByText(/deadline for Fall 2026 has passed/)).toBeInTheDocument());
    expect(screen.getByText('Current')).toBeInTheDocument();
  });
});
