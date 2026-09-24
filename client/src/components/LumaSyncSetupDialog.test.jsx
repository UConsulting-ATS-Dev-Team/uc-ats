// The Luma sync setup dialog.
//
// The admin's decision here is "is the sync configured, and what do I paste" —
// so what matters is that an unconfigured sync says so, that the prompt and the
// token are actually readable rather than masked, and that replacing a working
// token warns before it breaks the running routine.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LumaSyncSetupDialog from './LumaSyncSetupDialog';
import apiClient from '../utils/api';

const TOKEN = 'generated-token-long-enough-to-be-real-00';

const state = (over = {}) => ({
  token: TOKEN,
  tokenSetAt: '2026-09-24T12:00:00.000Z',
  updatedById: 'admin-1',
  envTokenSet: false,
  configured: true,
  prompt: `You are the UConsulting ATS event sync.\n\n  Authorization: Bearer ${TOKEN}\n`,
  ...over,
});

const unconfigured = state({ token: null, tokenSetAt: null, configured: false, prompt: 'no token yet' });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('before a token exists', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(unconfigured);
  });

  it('says nothing syncs, rather than showing an empty box', async () => {
    render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByText(/No sync token exists/i)).toBeInTheDocument();
    expect(screen.getByText(/answers 503/i)).toBeInTheDocument();
  });

  it('offers to generate one, with no rotation warning to dismiss first', async () => {
    render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: /generate token/i })).toBeInTheDocument();
    expect(screen.queryByText(/stops working immediately/i)).not.toBeInTheDocument();
  });

  it('generates on click and shows what came back', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'post').mockResolvedValue(state());
    render(<LumaSyncSetupDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /generate token/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/admin/luma/sync-token'));
    expect(await screen.findByDisplayValue(TOKEN)).toBeInTheDocument();
  });
});

describe('with a token', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(state());
  });

  // The token is readable on purpose: it has to be pasted into a routine.
  it('shows the token in full', async () => {
    render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByDisplayValue(TOKEN)).toBeInTheDocument();
  });

  it('shows the prompt carrying it, and warns that it is a secret', async () => {
    render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByDisplayValue(/Authorization: Bearer/)).toBeInTheDocument();
    expect(screen.getByText(/contains the token/i)).toBeInTheDocument();
  });

  it('copies the prompt to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // After setup(), which installs a clipboard stub of its own, and defined
    // rather than assigned because jsdom makes it getter-only.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<LumaSyncSetupDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /copy prompt/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(TOKEN)));
  });

  // Rotating breaks the running routine until its prompt is replaced, so it
  // asks first rather than doing it on one click.
  it('warns before replacing a working token', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'post').mockResolvedValue(state());
    render(<LumaSyncSetupDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /generate a new one/i }));

    expect(screen.getByText(/stops working immediately/i)).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('only rotates once the warning is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'post').mockResolvedValue(state());
    render(<LumaSyncSetupDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /generate a new one/i }));
    await user.click(screen.getByRole('button', { name: /replace it/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/admin/luma/sync-token'));
  });
});

describe('when the environment already has a token', () => {
  it('says the existing routine keeps working', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(
      state({ token: null, tokenSetAt: null, envTokenSet: true })
    );
    render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByText(/keeps working/i)).toBeInTheDocument();
    expect(screen.queryByText(/No sync token exists/i)).not.toBeInTheDocument();
  });
});

describe('when it cannot be loaded', () => {
  it('reports the failure instead of showing a blank panel', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue({ response: { data: { error: 'nope' } } });
    render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  // The dialog stays mounted between opens, so a failed reload must not leave
  // the previous token on screen: it may since have been rotated elsewhere, and
  // offering it to be copied hands over a credential that no longer works.
  it('drops the token it was showing rather than offering a stale one', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(state());
    const { rerender } = render(<LumaSyncSetupDialog open onClose={() => {}} />);
    expect(await screen.findByDisplayValue(TOKEN)).toBeInTheDocument();

    rerender(<LumaSyncSetupDialog open={false} onClose={() => {}} />);
    get.mockRejectedValue({ response: { data: { error: 'gone' } } });
    rerender(<LumaSyncSetupDialog open onClose={() => {}} />);

    expect(await screen.findByText('gone')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy prompt/i })).not.toBeInTheDocument();
  });
});
