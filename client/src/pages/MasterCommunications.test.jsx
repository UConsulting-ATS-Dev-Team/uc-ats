// Master Communications.
//
// This exists because the page shipped broken: a useCallback named in an
// effect's dependency array was declared further down the component body, so
// the dependency array read it during render and threw "Cannot access ... before
// initialization". The build succeeded, every other test passed, and the entire
// page was a blank screen in production.
//
// So the assertion that matters most here is simply that it renders at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MasterCommunications from './MasterCommunications';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', email: 'admin@uc.org' } }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  // Deliberately permissive. This file is a smoke test for "does the page come
  // up at all"; asserting on payload shapes here would make it fail for reasons
  // that have nothing to do with that.
  vi.spyOn(apiClient, 'get').mockResolvedValue({});
});

describe('the page', () => {
  it('renders without throwing', async () => {
    // A temporal-dead-zone reference in a hook dependency array throws here and
    // nowhere else - not at build time, and not in any other test.
    expect(() => render(<MasterCommunications />)).not.toThrow();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
  });

  it('offers a Drafts tab', () => {
    render(<MasterCommunications />);
    expect(screen.getByRole('tab', { name: /Drafts/i })).toBeInTheDocument();
  });

  it('loads drafts on mount, not only when the tab is opened', async () => {
    render(<MasterCommunications />);
    await waitFor(() =>
      expect(apiClient.get.mock.calls.some(([url]) => url.includes('drafts'))).toBe(true)
    );
  });

  it('keeps every channel tab reachable, in order', () => {
    render(<MasterCommunications />);
    // Order matters: two effects used to key off a hard-coded tab index, so
    // inserting a tab silently repointed them at the wrong one. A new tab goes
    // on the end for that reason - Mailing List did, and this list is what
    // catches the next one that does not.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Email', 'Slack', 'iMessage', 'Drafts', 'Templates', 'Logs', 'Scheduled', 'Decisions',
      'Mailing List', 'Unsubscribes',
    ]);
  });

  it('opens the unsubscribe list from its tab', async () => {
    render(<MasterCommunications />);
    await userEvent.click(screen.getByRole('tab', { name: /Unsubscribes/i }));
    expect(await screen.findByText(/These addresses are skipped/)).toBeInTheDocument();
  });

  it('opens the mailing list import from its tab', async () => {
    render(<MasterCommunications />);
    await userEvent.click(screen.getByRole('tab', { name: /Mailing List/i }));
    expect(screen.getByRole('button', { name: /Choose CSV/i })).toBeInTheDocument();
  });

  it('opens straight onto a decision batch when Staging links to one', async () => {
    window.history.pushState({}, '', '/master-communications?tab=decisions&batch=batch-1');
    // Lists come back as lists here: this test waits long enough for the page's
    // other loads to land, and they expect arrays.
    apiClient.get.mockImplementation((url) =>
      Promise.resolve(url.includes('/decision-batches/') ? { id: 'batch-1', roundLabel: 'Final Round Interviews', groups: [] } : [])
    );
    try {
      render(<MasterCommunications />);
      expect(screen.getByRole('tab', { name: 'Decisions' })).toHaveAttribute('aria-selected', 'true');
      await waitFor(() =>
        expect(apiClient.get.mock.calls.some(([url]) => url.endsWith('/decision-batches/batch-1'))).toBe(true)
      );
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
