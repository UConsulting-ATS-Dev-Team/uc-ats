import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useDraftPreview from './useDraftPreview';
import apiClient from '../utils/api';

const render = (key) => ({ key, label: key, subject: 'S', html: `<p>${key}</p>` });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useDraftPreview', () => {
  it('renders the draft for the email asked for', async () => {
    vi.spyOn(apiClient, 'post').mockImplementation((url) => Promise.resolve(render(url.split('/')[3])));
    const { result } = renderHook(() => useDraftPreview('password-reset', { copy: { heading: 'x' } }, { delay: 0 }));

    await waitFor(() => expect(result.current.data?.key).toBe('password-reset'));
  });

  // Two catalog entries can share one editor. The render of the one before
  // must not sit beside the next one's request, or its error, as if it were it.
  it('never shows another email\'s render while switching', async () => {
    let fail = false;
    vi.spyOn(apiClient, 'post').mockImplementation((url) =>
      fail ? Promise.reject(Object.assign(new Error('x'), { serverMessage: 'Could not render' })) : Promise.resolve(render(url.split('/')[3]))
    );
    const { result, rerender } = renderHook(({ key }) => useDraftPreview(key, { copy: {} }, { delay: 0 }), {
      initialProps: { key: 'slot-interviewer-assigned' },
    });
    await waitFor(() => expect(result.current.data?.key).toBe('slot-interviewer-assigned'));

    fail = true;
    rerender({ key: 'slot-interviewer-assigned-self-signup' });

    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.error).toBe('Could not render'));
    expect(result.current.data).toBeNull();
  });

  it('keeps the last render of the same email while the next one loads', async () => {
    vi.spyOn(apiClient, 'post').mockImplementation((url) => Promise.resolve(render(url.split('/')[3])));
    const { result, rerender } = renderHook(({ draft }) => useDraftPreview('password-reset', draft, { delay: 0 }), {
      initialProps: { draft: { copy: { heading: 'a' } } },
    });
    await waitFor(() => expect(result.current.data?.key).toBe('password-reset'));

    rerender({ draft: { copy: { heading: 'ab' } } });
    expect(result.current.data?.key).toBe('password-reset');
  });
});
