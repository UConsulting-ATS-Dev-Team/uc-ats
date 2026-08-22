import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CycleOfferLetterDialog from './CycleOfferLetterDialog';
import apiClient from '../utils/api';

const baseTemplate = {
  introText: '',
  terms: ['Term 1'],
  closingText: '',
  checklist: [],
  presidentName: '',
  presidentTitle: 'President, UConsulting',
  responseDeadline: 'Friday, January 23rd at 11:59 PM',
  signatureLabel: 'Signature',
  printedNameLabel: 'Printed Name',
  officialOfferLabel: 'OFFICIAL OFFER LETTER',
  confidentialityLabel: 'U C STRICTLY CONFIDENTIAL',
  signaturePath: ''
};

const persistedTemplate = {
  ...baseTemplate,
  presidentName: 'President Name',
  signaturePath: 'cycle-1/signature.png'
};

describe('CycleOfferLetterDialog', () => {
  let getCallCount = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    getCallCount = 0;
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:mock-signature'),
      revokeObjectURL: vi.fn()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setupApi(initialTemplate = baseTemplate) {
    apiClient.get = vi.fn(async (endpoint) => {
      if (endpoint.includes('/offer-letter-template/signature')) {
        return { signedUrl: 'https://mock-signed-url.example/sig.png' };
      }
      if (endpoint.includes('/offer-letter-template')) {
        getCallCount++;
        // First call returns the initial template; later calls return the persisted template.
        if (getCallCount === 1) return Promise.resolve(initialTemplate);
        return Promise.resolve(persistedTemplate);
      }
      return Promise.reject(new Error('Unexpected GET'));
    });

    apiClient.post = vi.fn(async (endpoint, body) => {
      if (endpoint.includes('/offer-letter-template/signature')) {
        return { path: 'cycle-1/signature.png' };
      }
      if (endpoint.includes('/offer-letter-template')) {
        return persistedTemplate;
      }
      return Promise.reject(new Error('Unexpected POST'));
    });
  }

  it('persists signaturePath after multipart upload and enables Preview/Send tabs', async () => {
    setupApi(baseTemplate);
    render(<CycleOfferLetterDialog cycleId="cycle-1" open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Configure' })).toBeInTheDocument());

    const previewTab = screen.getByRole('tab', { name: 'Preview' });
    const sendTab = screen.getByRole('tab', { name: 'Send' });
    expect(previewTab).toBeDisabled();
    expect(sendTab).toBeDisabled();

    // Fill in required template fields.
    fireEvent.change(screen.getByLabelText(/President Name/i), { target: { value: 'President Name' } });

    // Select a signature file.
    const fileInput = document.querySelector('input[type="file"]');
    const file = new File(['test-signature'], 'sig.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/New upload \(not saved\)/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Save Template/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));

    // Multipart upload request.
    const uploadCall = apiClient.post.mock.calls.find(([endpoint]) => endpoint.includes('/offer-letter-template/signature'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall[1] instanceof FormData).toBe(true);

    // Save template request should include the persisted signaturePath.
    const saveCall = apiClient.post.mock.calls.find(([endpoint]) => endpoint.endsWith('/offer-letter-template'));
    expect(saveCall).toBeDefined();
    expect(saveCall[1].signaturePath).toBe('cycle-1/signature.png');

    // After refetch the persisted state is shown.
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());

    // Preview and Send tabs should now be enabled.
    await waitFor(() => expect(previewTab).not.toBeDisabled());
    expect(sendTab).not.toBeDisabled();
  });

  it('renders tabs and keeps Preview/Send disabled when the template is not ready', async () => {
    setupApi({ ...baseTemplate, terms: [] });
    render(<CycleOfferLetterDialog cycleId="cycle-1" open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Configure' })).toBeInTheDocument());

    expect(screen.getByRole('tab', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Send' })).toBeDisabled();
  });
});
