import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CoffeeChatThreads, { threadTitle } from './CoffeeChatThreads';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../../utils/api', () => ({
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args)
  }
}));
vi.mock('../../supabaseClient', () => ({ supabase: null }));
vi.mock('../MemberAvatar', () => ({ default: () => null }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'me', fullName: 'Me', role: 'MEMBER' } })
}));

const person = (id, fullName, session = 'Morning') => ({
  id,
  fullName,
  role: 'MEMBER',
  sessions: session ? [{ label: session }] : []
});
const PEOPLE = [person('a', 'Ana'), person('b', 'Ben', 'Afternoon'), person('c', 'Cal'), person('d', 'Dee'), { id: 'z', fullName: 'Zed', role: 'ADMIN', sessions: [] }];
const thread = (id, people, extra = {}) => ({ id, people, lastMessage: null, unreadCount: 0, ...extra });

// Each open window loads its conversation and messages through the API.
function serveConversations(threads) {
  mockGet.mockImplementation((url) => {
    if (url.endsWith('/threads')) return Promise.resolve({ people: PEOPLE, threads: threads() });
    const messages = url.match(/^\/conversations\/([^/]+)\/messages$/);
    if (messages) return Promise.resolve([]);
    const id = url.match(/^\/conversations\/([^/]+)$/)?.[1];
    return Promise.resolve({ id, participants: [{ userId: 'me', lastReadAt: null }] });
  });
  mockPost.mockResolvedValue({ ok: true });
}

describe('CoffeeChatThreads', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('names a thread by the other people in it', () => {
    expect(threadTitle([{ fullName: 'Ana' }])).toBe('Ana');
    expect(threadTitle([{ fullName: 'Ana' }, { fullName: 'Ben' }])).toBe('Ana & Ben');
    expect(threadTitle([{ fullName: 'Ana' }, { fullName: 'Ben' }, { fullName: 'Cal' }])).toBe('Ana, Ben +1');
  });

  it("shows the unread total on the launcher and lists the user's chats", async () => {
    serveConversations(() => [
      thread('t1', [PEOPLE[0]], { unreadCount: 2, lastMessage: { body: 'table 3 needs you', sender: { id: 'a' } } }),
      thread('t2', [PEOPLE[1], PEOPLE[2]], { unreadCount: 1 })
    ]);
    render(<CoffeeChatThreads interviewId="cc-1" />);

    const launcher = await screen.findByRole('button', { name: 'Open chats' });
    await waitFor(() => expect(within(launcher).getByText('3')).toBeInTheDocument());

    await userEvent.click(launcher);
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('table 3 needs you')).toBeInTheDocument();
    expect(screen.getByText('Ben & Cal')).toBeInTheDocument();
  });

  it('starts a group chat with the people picked and opens it', async () => {
    let threads = [];
    serveConversations(() => threads);
    mockPost.mockImplementation((url) => {
      if (url.endsWith('/threads')) {
        threads = [thread('t-new', [PEOPLE[0], PEOPLE[1]])];
        return Promise.resolve({ id: 't-new', participants: [] });
      }
      return Promise.resolve({ ok: true });
    });
    render(<CoffeeChatThreads interviewId="cc-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open chats' }));
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Ana/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Ben/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start group chat (3)' }));

    expect(mockPost).toHaveBeenCalledWith('/conversations/interviews/cc-1/threads', { userIds: ['a', 'b'] });
    expect(await screen.findByRole('dialog', { name: 'Chat with Ana & Ben' })).toBeInTheDocument();
  });

  it('finds people by session', async () => {
    serveConversations(() => []);
    render(<CoffeeChatThreads interviewId="cc-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open chats' }));
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search people' }), 'afternoon');

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: /Ben/ })).toBeInTheDocument();
  });

  it('keeps several chats open at once, up to three, dropping the oldest', async () => {
    serveConversations(() => PEOPLE.slice(0, 4).map((p, i) => thread(`t${i}`, [p])));
    render(<CoffeeChatThreads interviewId="cc-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open chats' }));
    for (const name of ['Ana', 'Ben', 'Cal']) {
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
    }
    await waitFor(() => expect(screen.getAllByRole('dialog', { name: /^Chat with/ })).toHaveLength(3));

    await userEvent.click(screen.getByRole('button', { name: /^Dee/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chat with Ana' })).not.toBeInTheDocument());
    expect(screen.getAllByRole('dialog', { name: /^Chat with/ })).toHaveLength(3);

    await userEvent.click(within(screen.getByRole('dialog', { name: 'Chat with Ben' })).getByRole('button', { name: 'Close this chat' }));
    expect(screen.getAllByRole('dialog', { name: /^Chat with/ })).toHaveLength(2);
  });

  it('stops picking at five others', async () => {
    serveConversations(() => []);
    mockGet.mockImplementation((url) =>
      Promise.resolve({ people: Array.from({ length: 7 }, (_, i) => person(`p${i}`, `Person ${i}`)), threads: [] })
    );
    render(<CoffeeChatThreads interviewId="cc-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open chats' }));
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes.slice(0, 5)) await userEvent.click(box);

    expect(boxes[5]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start group chat (6)' })).toBeEnabled();
  });
});
