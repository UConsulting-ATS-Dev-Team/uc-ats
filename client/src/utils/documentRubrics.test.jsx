// A page opened after another admin edited a rubric must not grade against
// the copy an earlier page cached.
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { aggregationText, draftMaxOverall, setDocumentRubrics, useDocumentRubrics } from './documentRubrics';
import apiClient from './api';

vi.mock('./api', () => ({ default: { get: vi.fn() } }));

const body = (videoMax) => ({
  rubrics: { video: { maxOverall: videoMax, rubric: { categories: [] } } },
  stagingMax: 16 + videoMax
});

function Reader() {
  const { data, refreshError } = useDocumentRubrics();
  return (
    <>
      <div>video max {data?.rubrics?.video?.maxOverall ?? 'loading'}</div>
      {refreshError && <div>refresh failed: {refreshError}</div>}
    </>
  );
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

  it('keeps the cached copy when a refetch fails, and says it is stale', async () => {
    apiClient.get.mockRejectedValueOnce(new Error('offline'));
    render(<Reader />);
    expect(await screen.findByText('refresh failed: offline')).toBeInTheDocument();
    expect(screen.getByText('video max 5')).toBeInTheDocument();
  });

  it('does not let a fetch that started before a save overwrite it', async () => {
    let answer;
    apiClient.get.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    render(<Reader />);
    // An admin saves while that GET is still out.
    act(() => setDocumentRubrics(body(9)));
    expect(screen.getByText('video max 9')).toBeInTheDocument();

    await act(async () => { answer(body(5)); });
    expect(screen.getByText('video max 9')).toBeInTheDocument();
  });
});

describe('a video rubric with an added category', () => {
  const rubric = {
    categories: [
      { id: 'scoreOne', title: 'Video', min: 0, max: 2 },
      { id: 'scoreTwo', title: 'Presence', min: 0, max: 3 }
    ]
  };

  it('is worth the sum of its categories, as the server scores it', () => {
    expect(draftMaxOverall('video', rubric)).toBe(5);
  });

  it('says so', () => {
    expect(aggregationText('video', rubric)).toBe('Sum of Video (0–2) and Presence (0–3)');
  });
});
