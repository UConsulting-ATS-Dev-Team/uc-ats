import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Dialog } from '@mui/material';
import DocumentPreviewModal from './DocumentPreviewModal';
import apiClient from '../utils/api';
import { clearDocumentLinks } from '../utils/documentLinks';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));
vi.mock('../utils/api', () => ({ default: { post: vi.fn(), token: 't' } }));

describe('DocumentPreviewModal', () => {
  it('renders on <body>, outside whatever card opened it', () => {
    // A transformed ancestor (a card with a hover lift) would otherwise become the
    // fixed overlay's containing block and pull the preview off-centre.
    const { container } = render(
      <div style={{ transform: 'translateY(-2px)' }}>
        <DocumentPreviewModal kind="text" title="Taylor Kim – Short Answer" text="Hello" onClose={() => {}} />
      </div>
    );

    expect(screen.getByText('Taylor Kim – Short Answer')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Taylor Kim – Short Answer');
  });

  it('takes keyboard focus and Escape from an MUI dialog it opens over', async () => {
    // Staging opens previews from inside a Dialog, whose focus trap would otherwise
    // keep Tab and focus inside the dialog underneath, and whose Escape would close
    // the dialog along with the preview.
    const onPreviewClose = vi.fn();
    const onDialogClose = vi.fn();
    render(
      <Dialog open onClose={onDialogClose}>
        <button>Inside the dialog</button>
        <DocumentPreviewModal kind="text" title="Preview" text="Hello" onClose={onPreviewClose} />
      </Dialog>
    );

    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onPreviewClose).toHaveBeenCalledTimes(1);
    expect(onDialogClose).not.toHaveBeenCalled();
  });

  it('sits above snackbars, as the overlay always did', () => {
    // Staging keeps notifications (Snackbar, 1400) up while a preview opens.
    render(<DocumentPreviewModal kind="text" title="Preview" text="Hello" onClose={() => {}} />);
    const root = document.querySelector('.MuiModal-root');
    expect(Number(getComputedStyle(root).zIndex)).toBe(1500);
  });

  it('colours the short answer from the theme, never a fixed colour', () => {
    // The text inherits the theme's colour, so a fixed background goes unreadable
    // in the other theme: a candidate saw dark mode's near-white text on white.
    // jsdom cannot resolve var(), so check that every colour the modal sets
    // between the answer and the dimmed overlay is a theme token.
    render(<DocumentPreviewModal kind="text" title="Preview" text="My short answer" onClose={() => {}} />);

    let set = 0;
    for (let el = screen.getByText('My short answer'); el.style.position !== 'fixed'; el = el.parentElement) {
      for (const value of [el.style.color, el.style.backgroundColor]) {
        if (!value) continue;
        set += 1;
        expect(value).toMatch(/^var\(--/);
      }
    }
    expect(set).toBeGreaterThanOrEqual(2);
  });

  it('still closes from its button', () => {
    const onClose = vi.fn();
    render(<DocumentPreviewModal kind="text" title="Preview" text="Hello" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  // A video used to be downloaded whole before it could start. It now streams in
  // ranges from a signed link, as the grading modal's does.
  it('streams a video from a signed link instead of downloading it', async () => {
    clearDocumentLinks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('a video must not be fetched whole'))));
    apiClient.post.mockResolvedValue({ access: 'tok.en' });

    render(<DocumentPreviewModal src="https://uconsultingats.com/api/files/vid/pdf" kind="video" title="Video" onClose={() => {}} />);

    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(document.querySelector('video').getAttribute('src')).toBe('/api/files/vid/pdf?access=tok.en');
    expect(apiClient.post).toHaveBeenCalledWith('/files/vid/link');
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
