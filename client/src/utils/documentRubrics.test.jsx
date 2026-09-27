// A page opened after another admin edited a rubric must not grade against
// the copy an earlier page cached.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useDocumentRubrics } from './documentRubrics';
import apiClient from './api';

vi.mock('./api', () => ({ default: { get: vi.fn() } }));

const body = (videoMax) => ({
  rubrics: { video: { maxOverall: videoMax, rubric: { categories: [] } } },
  stagingMax: 16 + videoMax
});

function Reader() {
  const { data } = useDocumentRubrics();
  return <div>video max {data?.rubrics?.video?.maxOverall ?? 'loading'}</div>;
}

describe('useDocumentRubrics', () => {
  it('shows the cached copy at once and refetches on every mount', async () => {
    apiClient.get.mockResolvedValueOnce(body(2));
    const first = render(<Reader />);
    await screen.findByText('video max 2');
    first.unmount();

    apiClient.get.mockResolvedValueOnce(body(5));
    render(<Reader />);
    expect(screen.getByText('video max 2')).toBeInTheDocument();
    await screen.findByText('video max 5');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached copy when a refetch fails', async () => {
    apiClient.get.mockRejectedValueOnce(new Error('offline'));
    render(<Reader />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(3));
    expect(screen.getByText('video max 5')).toBeInTheDocument();
  });
});
