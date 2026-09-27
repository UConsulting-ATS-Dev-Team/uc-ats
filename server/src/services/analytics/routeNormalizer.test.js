import { describe, it, expect } from 'vitest';

import { normalizeRoute } from './routeNormalizer.js';
import { roleOf } from './roles.js';

describe('normalizeRoute', () => {
  it('replaces UUIDs and numeric ids', () => {
    expect(normalizeRoute('/api/applications/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/comments/42')).toBe(
      '/api/applications/:id/comments/:id'
    );
  });

  it('replaces long opaque tokens and email addresses', () => {
    expect(normalizeRoute('/api/unsubscribe/eyJhbGciOiJIUzI1NiJ9abcdefgh')).toBe('/api/unsubscribe/:token');
    expect(normalizeRoute('/api/users/by-email/joe%40ucla.edu')).toBe('/api/users/by-email/:email');
  });

  it('drops the query string and fragment, which is where reset tokens live', () => {
    expect(normalizeRoute('/reset-password?token=abc123#x')).toBe('/reset-password');
  });

  it('collapses repeated slashes and a trailing slash', () => {
    expect(normalizeRoute('/api//admin/stats/')).toBe('/api/admin/stats');
  });

  it('leaves ordinary words alone', () => {
    expect(normalizeRoute('/api/admin/cycles/active')).toBe('/api/admin/cycles/active');
  });

  it('caps the length', () => {
    expect(normalizeRoute(`/${Array(100).fill('abc').join('/')}`)).toHaveLength(120);
  });

  it('never returns an empty route', () => {
    expect(normalizeRoute('')).toBe('/');
    expect(normalizeRoute(undefined)).toBe('/');
  });
});

describe('roleOf', () => {
  it.each([
    [null, 'ANON'],
    [{ role: 'ADMIN' }, 'ADMIN'],
    [{ role: 'MEMBER' }, 'MEMBER'],
    [{ role: 'CLIENT' }, 'CLIENT'],
    [{ role: 'USER', isExternalTalent: false }, 'CANDIDATE'],
    [{ role: 'USER', isExternalTalent: true }, 'TALENT'],
  ])('%o is %s', (user, role) => {
    expect(roleOf(user)).toBe(role);
  });
});
