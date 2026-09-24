// The filter builder. It is controlled - the page owns the tree - so these
// check what it hands back: an edit always detaches from a saved audience, and
// picking one loads its filters and id together.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AudienceBuilder from './AudienceBuilder';
import apiClient from '../../utils/api';
import { emptyTree, makeGroup, makeRule } from './audienceRules';

const SAVED = {
  id: 'aud-1',
  name: 'Kickoff list',
  description: 'Everyone for the kickoff',
  filters: { version: 2, root: { kind: 'group', op: 'AND', children: [{ kind: 'rule', type: 'mailingList', params: {} }] } },
  lastUsedAt: '2026-09-01T00:00:00Z',
  lastUsedCount: 312,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockImplementation(async (url) =>
    url.includes('audience-options') ? { campaigns: [], mailingListImports: [] } : { audiences: [SAVED] }
  );
});

const pickOption = async (user, label, option) => {
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole('option', { name: option }));
};

describe('AudienceBuilder', () => {
  it('adds a rule and detaches from any saved audience', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AudienceBuilder tree={emptyTree()} savedAudienceId={null} onChange={onChange} />);

    await pickOption(user, 'Add filter', 'On the mailing list');

    const { tree, savedAudienceId } = onChange.mock.calls.at(-1)[0];
    expect(savedAudienceId).toBeNull();
    expect(tree.root.children).toEqual([expect.objectContaining({ kind: 'rule', type: 'mailingList' })]);
  });

  it('loads a saved audience with its id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AudienceBuilder tree={emptyTree()} savedAudienceId={null} onChange={onChange} />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/master-communications/audiences'));
    await user.click(screen.getByLabelText('Saved audience'));
    await user.click(await screen.findByRole('option', { name: /Kickoff list/ }));

    const { tree, savedAudienceId } = onChange.mock.calls.at(-1)[0];
    expect(savedAudienceId).toBe('aud-1');
    expect(tree.root.children[0]).toMatchObject({ type: 'mailingList' });
  });

  it('flips a rule to "is not"', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const tree = { version: 2, root: makeGroup('AND', [makeRule('transfer')]) };
    render(<AudienceBuilder tree={tree} savedAudienceId={null} onChange={onChange} />);

    await pickOption(user, 'Include or exclude', 'Is not');
    expect(onChange.mock.calls.at(-1)[0].tree.root.children[0].negate).toBe(true);
  });

  it('saves the current tree without editor ids', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ audience: { id: 'aud-2' } });
    const tree = { version: 2, root: makeGroup('AND', [makeRule('mailingList')]) };
    render(<AudienceBuilder tree={tree} savedAudienceId={null} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Save as new' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Spring list');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/master-communications/audiences');
    expect(body.name).toBe('Spring list');
    expect(JSON.stringify(body.filters)).not.toContain('"id"');
    await waitFor(() => expect(onChange.mock.calls.at(-1)[0].savedAudienceId).toBe('aud-2'));
  });

  it('cannot save an audience with no filters', () => {
    render(<AudienceBuilder tree={emptyTree()} savedAudienceId={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeDisabled();
  });
});
