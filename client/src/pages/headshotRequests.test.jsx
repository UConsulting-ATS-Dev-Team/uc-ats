// Headshots must never be requested by a bare <img src="/api/files/<id>/image">.
//
// An <img> sends no Authorization header, so the server answers 401 to every
// one of them. The members' Applications page drew one per applicant, which is
// how /api/files/:id/image came to answer 41,347 anonymous 401s in a week: a
// few hundred per visit, again whenever a search or filter re-mounted the rows.
// The onError swapped in initials, so on screen it only looked like nobody had
// a photo.
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Candidates from './Candidates';
import apiClient from '../utils/api';
import ImageCache from '../utils/imageCache';
import { useAuth } from '../context/AuthContext';

vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../utils/api', () => ({ default: { get: vi.fn(), token: 'session-token' } }));

const applicants = Array.from({ length: 30 }, (_, i) => ({
  id: `app-${i}`,
  candidateId: `cand-${i}`,
  name: `Applicant ${String.fromCharCode(65 + (i % 26))}${i}`,
  email: `a${i}@ucla.edu`,
  status: 'SUBMITTED',
  headshotUrl: `https://uconsultingats.com/api/files/headshot${i}/image`,
}));

const unauthenticatedImageRequests = (container) =>
  [...container.querySelectorAll('img')]
    .map((img) => img.getAttribute('src') || '')
    .filter((src) => /\/api\/files\/[^/]+\/image/.test(src));

let fetchSpy;

beforeEach(() => {
  vi.clearAllMocks();
  ImageCache.clearCache();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:headshot');
  globalThis.URL.revokeObjectURL = vi.fn();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(new Blob(['x'], { type: 'image/webp' }), { status: 200, headers: { 'Content-Type': 'image/webp' } })
  );
  useAuth.mockReturnValue({ user: { id: 'member-1', role: 'MEMBER' } });
  apiClient.get.mockImplementation((url) => {
    if (url === '/member/all-applications') return Promise.resolve(applicants);
    return Promise.resolve([]);
  });
});

afterEach(() => fetchSpy.mockRestore());

describe("the members' Applications page", () => {
  it('requests no headshot without the session, even after searching re-mounts the rows', async () => {
    const { container } = render(<Candidates />);
    await screen.findByText('Applicant A0');

    // Search narrows the list, then clearing it brings every row back.
    const search = screen.getByPlaceholderText(/search/i);
    await userEvent.type(search, 'Applicant B1');
    await userEvent.clear(search);
    await screen.findByText('Applicant A0');

    expect(unauthenticatedImageRequests(container)).toEqual([]);
  });

  it('fetches each headshot with the session, as the small copy', async () => {
    render(<Candidates />);
    await screen.findByText('Applicant A0');

    await waitFor(() => {
      const headshotFetches = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/image'));
      expect(headshotFetches).toHaveLength(applicants.length);
      for (const [url, init] of headshotFetches) {
        expect(url).toMatch(/^\/api\/files\/headshot\d+\/image\?size=256$/);
        expect(init.headers.Authorization).toBe('Bearer session-token');
      }
    });
  });
});

describe('every page', () => {
  it('draws headshots through AuthenticatedImage or an avatar component, never a bare <img>', () => {
    const root = path.resolve(__dirname, '..');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.jsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8');
          // An <img whose src expression mentions a headshot.
          for (const match of source.matchAll(/<img\b[^>]*?\bsrc=\{[^}]*headshot/gi)) {
            offenders.push(`${path.relative(root, full)}:${source.slice(0, match.index).split('\n').length}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
