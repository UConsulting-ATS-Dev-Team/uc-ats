// A page that is gone (404) and a page that failed to load say different
// things: only the first is fixed by re-uploading it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CasePageImage from './CasePageImage';
import ImageCache from '../../utils/imageCache';

const fail = (status) => Object.assign(new Error(`Failed to load image: ${status}`), { status });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ImageCache, 'getCachedImage').mockReturnValue(null);
});

const draw = () =>
  render(<CasePageImage src="/api/cases/c/pages/p/image" alt="Page 1" errorLabel="Could not load" missingLabel="Missing" />);

describe('CasePageImage', () => {
  it('says the page is missing when the server has no file', async () => {
    vi.spyOn(ImageCache, 'loadImage').mockRejectedValue(fail(404));
    draw();
    expect(await screen.findByText('Missing')).toBeInTheDocument();
  });

  it('says it could not load for any other failure', async () => {
    vi.spyOn(ImageCache, 'loadImage').mockRejectedValue(fail(500));
    draw();
    expect(await screen.findByText('Could not load')).toBeInTheDocument();
  });

  it('treats a network failure, which has no status, as could not load', async () => {
    vi.spyOn(ImageCache, 'loadImage').mockRejectedValue(new TypeError('Failed to fetch'));
    draw();
    expect(await screen.findByText('Could not load')).toBeInTheDocument();
  });
});
