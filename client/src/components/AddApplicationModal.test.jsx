import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddApplicationModal from './AddApplicationModal';
import api from '../utils/api';
import { discardApplicationVideo, uploadApplicationVideo } from '../utils/applicationVideoUpload';

vi.mock('../utils/api', () => ({
  default: { post: vi.fn() },
}));

vi.mock('../utils/applicationVideoUpload', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadApplicationVideo: vi.fn(),
  discardApplicationVideo: vi.fn(),
}));

const pdf = (name) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });
const video = (name = 'pitch.mov') => new File(['video'], name, { type: 'video/quicktime' });

const renderModal = () => {
  const props = { isOpen: true, onClose: vi.fn(), onSuccess: vi.fn() };
  const view = render(<AddApplicationModal {...props} />);
  return { ...props, close: () => view.rerender(<AddApplicationModal {...props} isOpen={false} />) };
};

// Everything the form requires except the files.
async function fillRequired(user) {
  await user.type(screen.getByLabelText('First Name *'), 'Jane');
  await user.type(screen.getByLabelText('Last Name *'), 'Doe');
  await user.type(screen.getByLabelText('Email *'), 'jane@ucla.edu');
  await user.type(screen.getByLabelText('Student ID *'), '405123456');
  await user.type(screen.getByLabelText('Phone Number *'), '3105550100');
  const year = screen.getByLabelText('Graduation Year *');
  await user.selectOptions(year, year.querySelectorAll('option')[1].value);
  await user.type(screen.getByLabelText('Cumulative GPA *'), '3.8');
  await user.type(screen.getByLabelText('Primary Major *'), 'Economics');
  await user.type(screen.getByLabelText('Headshot URL *'), 'https://example.com/h.jpg');
}

const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'Create Application' }).closest('form'));

describe('AddApplicationModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({});
    uploadApplicationVideo.mockResolvedValue('doc-1.mov');
  });

  it('takes the resume, blind resume and video as files, not links', () => {
    renderModal();
    expect(screen.getByLabelText('Resume (PDF) *')).toHaveAttribute('type', 'file');
    expect(screen.getByLabelText('Blind Resume (PDF)')).toHaveAttribute('type', 'file');
    expect(screen.getByLabelText(/^Video/)).toHaveAttribute('type', 'file');
    expect(screen.queryByLabelText(/Resume URL/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Video URL')).not.toBeInTheDocument();
  });

  it('sends the files and the pasted short answer with the application', async () => {
    const user = userEvent.setup();
    const props = renderModal();
    await fillRequired(user);
    const resume = pdf('resume.pdf');
    const blind = pdf('blind.pdf');
    await user.upload(screen.getByLabelText('Resume (PDF) *'), resume);
    await user.upload(screen.getByLabelText('Blind Resume (PDF)'), blind);
    await user.type(screen.getByLabelText('Short Answer Response'), 'Because consulting.');
    submit();

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalled());
    const [endpoint, body] = api.post.mock.calls[0];
    expect(endpoint).toBe('/applications/manual');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('resume')).toBe(resume);
    expect(body.get('blindResume')).toBe(blind);
    expect(body.get('shortAnswer')).toBe('Because consulting.');
    expect(body.get('cumulativeGpa')).toBe('3.8');
    expect(body.get('majorGpa')).toBe('0');
    expect(body.has('videoDocumentId')).toBe(false);
    expect(uploadApplicationVideo).not.toHaveBeenCalled();
  });

  it('uploads the video first and names it on the application', async () => {
    const user = userEvent.setup();
    const props = renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    const file = video();
    await user.upload(screen.getByLabelText(/^Video/), file);
    submit();

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalled());
    expect(uploadApplicationVideo).toHaveBeenCalledWith(file, expect.any(Function), expect.any(AbortSignal));
    expect(discardApplicationVideo).not.toHaveBeenCalled();
    expect(api.post.mock.calls[0][1].get('videoDocumentId')).toBe('doc-1.mov');
  });

  it('does not upload the same video again when the save is retried', async () => {
    const user = userEvent.setup();
    const props = renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    await user.upload(screen.getByLabelText(/^Video/), video());
    api.post.mockRejectedValueOnce(new Error('Failed to create application'));
    submit();
    await screen.findByText('Failed to create application');

    submit();
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalled());
    expect(uploadApplicationVideo).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[1][1].get('videoDocumentId')).toBe('doc-1.mov');
  });

  it('does not create the application when the video upload fails', async () => {
    const user = userEvent.setup();
    renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    await user.upload(screen.getByLabelText(/^Video/), video());
    uploadApplicationVideo.mockRejectedValue(new Error('The video upload was interrupted.'));
    submit();

    await screen.findByText('The video upload was interrupted.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not create the application when the form is closed mid-upload', async () => {
    const user = userEvent.setup();
    const modal = renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    await user.upload(screen.getByLabelText(/^Video/), video());
    let finishUpload;
    let signal;
    uploadApplicationVideo.mockImplementation((file, onProgress, uploadSignal) => {
      signal = uploadSignal;
      return new Promise((resolve) => { finishUpload = resolve; });
    });
    submit();
    await waitFor(() => expect(uploadApplicationVideo).toHaveBeenCalled());

    modal.close();
    expect(signal.aborted).toBe(true);
    finishUpload('doc-late.mov');

    await waitFor(() => expect(discardApplicationVideo).toHaveBeenCalledWith('doc-late.mov'));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('discards an uploaded video when the form is closed after a failed save', async () => {
    const user = userEvent.setup();
    const modal = renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    await user.upload(screen.getByLabelText(/^Video/), video());
    api.post.mockRejectedValueOnce(Object.assign(new Error('Failed to create application'), { status: 500 }));
    submit();
    await screen.findByText('Failed to create application');

    modal.close();
    expect(discardApplicationVideo).toHaveBeenCalledWith('doc-1.mov');
  });

  it('keeps the video when the save went unanswered, since it may have gone through', async () => {
    const user = userEvent.setup();
    const modal = renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    await user.upload(screen.getByLabelText(/^Video/), video());
    api.post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    submit();
    await screen.findByText('Failed to fetch');

    modal.close();
    expect(discardApplicationVideo).not.toHaveBeenCalled();
  });

  it('locks the form while it is being sent', async () => {
    const user = userEvent.setup();
    renderModal();
    await fillRequired(user);
    await user.upload(screen.getByLabelText('Resume (PDF) *'), pdf('resume.pdf'));
    await user.upload(screen.getByLabelText(/^Video/), video());
    uploadApplicationVideo.mockImplementation(() => new Promise(() => {}));
    submit();

    await waitFor(() => expect(screen.getByLabelText('Resume (PDF) *')).toBeDisabled());
    expect(screen.getByLabelText('First Name *')).toBeDisabled();
    // Closing is still possible: it is what cancels the upload.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('asks for a resume', async () => {
    const user = userEvent.setup();
    renderModal();
    await fillRequired(user);
    submit();

    await screen.findByText('Please fill in all required fields: resume');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('refuses a resume that is not a PDF', () => {
    renderModal();
    const input = screen.getByLabelText('Resume (PDF) *');
    fireEvent.change(input, { target: { files: [new File(['x'], 'resume.docx', { type: 'application/msword' })] } });
    expect(screen.getByText('The resume must be a PDF')).toBeInTheDocument();
  });

  it('refuses a video in a format it cannot take', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/^Video/), { target: { files: [video('pitch.avi')] } });
    expect(screen.getByText(/The video must be one of/)).toBeInTheDocument();
  });
});
