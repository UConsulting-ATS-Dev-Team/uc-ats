import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import api from '../../utils/api';
import SlotContactDialog from './SlotContactDialog';

vi.mock('../../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const slot = {
  id: 'slot-1',
  startTime: '2026-10-14T18:30:00.000Z',
  location: 'Ackerman Union',
};

const contacts = [
  { signupId: 'su-1', fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', phoneNumber: '+13105551234' },
  { signupId: 'su-2', fullName: 'Sam Patel', email: 'sam@ucla.edu', phoneNumber: '+13105555678' },
  { signupId: 'su-3', fullName: 'Lee Kim', email: 'lee@ucla.edu', phoneNumber: null },
];

let hrefs;
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ contacts });
  api.post.mockResolvedValue({ logged: 2 });
  hrefs = [];
  // jsdom cannot navigate to sms: or mailto:, so capture where it was sent.
  delete window.location;
  window.location = {
    set href(value) { hrefs.push(value); },
    get href() { return hrefs[hrefs.length - 1] || ''; },
  };
});

afterEach(() => {
  window.location = originalLocation;
});

const renderDialog = () =>
  render(<SlotContactDialog open onClose={() => {}} slot={slot} hostName="Avery Chen" />);

describe('SlotContactDialog', () => {
  it('drafts a message to everyone asking the host for the exact spot', async () => {
    renderDialog();
    const box = await screen.findByLabelText('Message');
    expect(box.value).toMatch(/^Hi Jordan, Sam and Lee! This is Avery/);
    expect(box.value).toContain('Where to meet: Ackerman Union, [exact spot');
    expect(api.get).toHaveBeenCalledWith('/member/meeting-slots/slot-1/contacts');
  });

  it('says who will be left out of the group iMessage', async () => {
    renderDialog();
    expect(await screen.findByText(/Lee Kim has no phone number on file/)).toBeInTheDocument();
  });

  it('opens one group iMessage with every number and logs it', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Group iMessage \(2\)/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(hrefs[0]).toMatch(/^sms:\/\/open\?addresses=\+13105551234,\+13105555678&body=Hi%20Jordan/);
    expect(api.post).toHaveBeenCalledWith('/member/meeting-slots/slot-1/contacts/log', {
      channel: 'imessage',
      body: expect.stringMatching(/^Hi Jordan/),
      signupIds: ['su-1', 'su-2'],
    });
  });

  it('opens one Gmail compose tab to everyone, including people with no number', async () => {
    const tab = { opener: window };
    const open = vi.spyOn(window, 'open').mockImplementation(() => tab);
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Email \(3\)/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, target] = open.mock.calls[0];
    const compose = new URL(url);
    expect(compose.origin + compose.pathname).toBe('https://mail.google.com/mail/');
    expect(compose.searchParams.get('to')).toBe('jordan@ucla.edu,sam@ucla.edu,lee@ucla.edu');
    expect(compose.searchParams.get('su')).toBe('Get to Know UC - where to meet');
    expect(target).toBe('_blank');
    // Gmail cannot reach back into the ATS tab, which stays where it is.
    expect(tab.opener).toBeNull();
    expect(hrefs).toEqual([]);
    expect(api.post.mock.calls[0][1]).toMatchObject({ channel: 'email', signupIds: ['su-1', 'su-2', 'su-3'] });
    open.mockRestore();
  });

  it('logs nothing when the browser blocks the Gmail tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Email \(3\)/ }));

    expect(await screen.findByText(/blocked the Gmail tab/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByText('Opened in Gmail.')).not.toBeInTheDocument();
    open.mockRestore();
  });

  it('sends what the host edited, not the draft', async () => {
    renderDialog();
    const box = await screen.findByLabelText('Message');
    fireEvent.change(box, { target: { value: 'Meet at the Kerckhoff patio, I am in a blue jacket' } });
    fireEvent.click(screen.getByRole('button', { name: /Group iMessage/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(hrefs[0]).toContain('body=Meet%20at%20the%20Kerckhoff%20patio');
  });

  it('warns that the group sees each other\'s details', async () => {
    renderDialog();
    expect(await screen.findByText(/Everyone in the group sees each other/)).toBeInTheDocument();
  });

  it('drops the previous slot\'s people when the next slot fails to load', async () => {
    const { rerender } = renderDialog();
    await screen.findByRole('button', { name: /Email \(3\)/ });

    api.get.mockRejectedValue(new Error('Server error'));
    rerender(<SlotContactDialog open onClose={() => {}} slot={{ ...slot, id: 'slot-2' }} hostName="Avery Chen" />);

    expect(await screen.findByText('Server error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Email \(0\)/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Group iMessage \(0\)/ })).toBeDisabled();
  });

  it('turns the iMessage button off when nobody has a number', async () => {
    api.get.mockResolvedValue({ contacts: [contacts[2]] });
    renderDialog();
    expect(await screen.findByText(/Nobody here has a phone number on file/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Group iMessage \(0\)/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Email \(1\)/ })).toBeEnabled();
  });
});
