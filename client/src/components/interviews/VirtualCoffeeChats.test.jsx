import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VirtualCoffeeChats from './VirtualCoffeeChats';
import apiClient from '../../utils/api';

const chat = {
  id: 'chat-1',
  slotId: 'slot-v',
  title: 'Virtual Coffee Chat',
  status: 'UPCOMING',
  startTime: '2026-10-10T02:00:00.000Z',
  endTime: '2026-10-10T02:30:00.000Z',
  meetingUrl: 'https://ucla.zoom.us/j/123',
  notes: null,
  applicants: [{ signupId: 'su-1', applicationId: 'a1', firstName: 'Ada', lastName: 'Lovelace', status: 'CONFIRMED' }],
  interviewers: [{ assignmentId: 'as-1', user: { id: 'm1', fullName: 'Grace Hopper' } }],
};

const applicants = [
  { id: 'a1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@ucla.edu', placement: { isVirtual: true, title: 'Virtual Coffee Chat' } },
  { id: 'a2', firstName: 'Alan', lastName: 'Turing', email: 'alan@ucla.edu', placement: { isVirtual: false, label: 'Morning Block' } },
  { id: 'a3', firstName: 'Katherine', lastName: 'Johnson', email: 'kj@ucla.edu', placement: null },
];

const renderPanel = () =>
  render(
    <MemoryRouter>
      <VirtualCoffeeChats />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get = vi.fn((endpoint) => {
    if (endpoint === '/admin/virtual-coffee-chats') return Promise.resolve({ chats: [chat], applicants });
    if (endpoint === '/admin/interviews/staff') return Promise.resolve([{ id: 'm1', fullName: 'Grace Hopper' }]);
    return Promise.resolve({});
  });
  apiClient.post = vi.fn(() => Promise.resolve({ applicants: [{ applicationId: 'a2', outcome: 'MOVED', from: 'Morning Block' }] }));
});

describe('VirtualCoffeeChats', () => {
  it('shows each chat with its link, interviewers and applicants', async () => {
    renderPanel();
    const row = await screen.findByTestId('virtual-chat');
    expect(within(row).getByRole('link', { name: 'https://ucla.zoom.us/j/123' })).toHaveAttribute(
      'href',
      'https://ucla.zoom.us/j/123'
    );
    expect(within(row).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(row).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(row).getByText('1:1')).toBeInTheDocument();
  });

  it('adds applicants in one go, warns about a move, and reports where they came from', async () => {
    renderPanel();
    const row = await screen.findByTestId('virtual-chat');
    // The second "Add" chip is the applicants one.
    fireEvent.click(within(row).getAllByText('Add')[1]);

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Applicants');
    fireEvent.mouseDown(input);
    // Somebody already in the chat is not offered again.
    expect(screen.queryByRole('option', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Alan Turing/ }));
    fireEvent.mouseDown(input);
    fireEvent.click(screen.getByRole('option', { name: /Katherine Johnson/ }));

    expect(within(dialog).getByText(/already scheduled elsewhere and will be moved/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add 2$/ }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/virtual-coffee-chats/chat-1/applicants', {
        applicationIds: ['a2', 'a3'],
      })
    );
    expect(await screen.findByText('1 moved from Morning Block')).toBeInTheDocument();
  });
});
