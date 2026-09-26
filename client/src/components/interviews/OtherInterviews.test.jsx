import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OtherInterviews from './OtherInterviews';
import apiClient from '../../utils/api';

// Deliberations belong to no scheduling round, so the round tabs never show
// them. This is where they stay reachable.

const list = [
  { id: 'cc', title: 'W27 Coffee Chats', interviewType: 'COFFEE_CHAT', cycleId: 'c1' },
  { id: 'dl', title: 'W27 Deliberations', interviewType: 'DELIBERATIONS', cycleId: 'c1', location: 'Kerckhoff' },
  { id: 'old', title: 'S26 Deliberations', interviewType: 'DELIBERATIONS', cycleId: 'c0' },
];

const renderOthers = (ids = 'cc') =>
  render(
    <MemoryRouter>
      <OtherInterviews cycleId="c1" roundInterviewIds={ids} refreshKey={1} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/admin/interviews') return Promise.resolve(list);
    if (endpoint === '/admin/interviews/dl/roster') {
      return Promise.resolve({ slots: [{ id: 's1', label: 'Room A', signups: [], interviewers: [] }] });
    }
    return Promise.resolve({ slots: [] });
  });
});

describe('OtherInterviews', () => {
  it("lists this cycle's interviews that no round tab shows", async () => {
    renderOthers();

    expect(await screen.findByText('W27 Deliberations')).toBeInTheDocument();
    expect(screen.queryByText('W27 Coffee Chats')).not.toBeInTheDocument();
    expect(screen.queryByText('S26 Deliberations')).not.toBeInTheDocument();
    // Its sessions come from its own roster, so it can still be run.
    expect(await screen.findByText(/1 session\b/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run a session/i })).toBeEnabled();
  });

  it('renders nothing when every interview is in a round', async () => {
    const { container } = renderOthers('cc,dl');
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/admin/interviews'));
    expect(container).toBeEmptyDOMElement();
  });
});
