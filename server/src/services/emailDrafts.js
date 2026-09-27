import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Unsaved edits, for previewing an email before anyone commits to them.
 *
 * The editors render a draft through the real builders, which read their
 * wording, theme, style and signature from the database. Threading a draft
 * through forty builders would touch every signature; instead a preview runs
 * inside this store and the resolvers look here first.
 *
 * Only the preview service ever enters one. A real send never runs inside it,
 * so nothing a draft holds can reach a recipient.
 *
 * Shape (every key optional):
 *   { theme, styles: { [key]: style }, copy: { [key]: copy }, signature }
 */
const store = new AsyncLocalStorage();

export const withEmailDraft = (draft, fn) => store.run(draft ?? {}, fn);

export const currentEmailDraft = () => store.getStore() ?? null;
