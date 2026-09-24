// The page a footer link opens. Opening it must never unsubscribe anyone -
// mail scanners open every link - so only the button does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Unsubscribe from './Unsubscribe';

vi.mock('../components/UConsultingLogo', () => ({ default: () => null }));

const respond = (body, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

beforeEach(() => {
  global.fetch = vi.fn((url, opts = {}) => {
    if (!opts.method || opts.method === 'GET') return respond({ email: 'joe@ucla.edu', unsubscribed: false });
    if (url.endsWith('/resubscribe')) return respond({ email: 'joe@ucla.edu', unsubscribed: false });
    return respond({ email: 'joe@ucla.edu', unsubscribed: true });
  });
});

const renderAt = (search) =>
  render(
    <MemoryRouter initialEntries={[`/unsubscribe${search}`]}>
      <Unsubscribe />
    </MemoryRouter>
  );

describe('Unsubscribe', () => {
  it('only reads on open', async () => {
    renderAt('?t=abc.def');
    expect(await screen.findByText('joe@ucla.edu')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('unsubscribes on the button, and offers to undo it', async () => {
    const user = userEvent.setup();
    renderAt('?t=abc.def');
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    expect(global.fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ t: 'abc.def' }) });
    expect(await screen.findByText("You're unsubscribed")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resubscribe me/ })).toBeInTheDocument();
  });

  it('explains when mail stays paused after resubscribing', async () => {
    global.fetch = vi.fn((url, opts = {}) => {
      if (!opts.method || opts.method === 'GET') return respond({ email: 'joe@ucla.edu', unsubscribed: true, heldBack: true });
      return respond({ email: 'joe@ucla.edu', unsubscribed: false, heldBack: true });
    });
    const user = userEvent.setup();
    renderAt('?t=abc.def');
    expect(await screen.findByText(/resubscribing here will not start them again/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /resubscribe me/ }));
    expect(await screen.findByText(/won't get them for now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument();
  });

  it('explains a link with no token', async () => {
    renderAt('');
    expect(await screen.findByText(/incomplete/)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
