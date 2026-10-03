// The guard table raises CRITICAL alarms, so both directions matter: every
// out-of-place success must be caught, and no legitimate one may be.
import { describe, it, expect } from 'vitest';

import { GUARD_TABLE, evaluateGuardBypass, isStaffOnlyPath } from './guardBypass.js';

const ok = (role, path, extra = {}) => evaluateGuardBypass({ method: 'GET', path, status: 200, role, ...extra });

describe('evaluateGuardBypass', () => {
  it.each([
    ['MEMBER', '/api/admin/stats'],
    ['CANDIDATE', '/api/admin/stats'],
    ['ADMIN', '/api/client/me'],
    ['CANDIDATE', '/api/talent/me'],
    ['TALENT', '/api/candidate/onboarding/status'],
    ['TALENT', '/api/my-interview-signups'],
    ['CANDIDATE', '/api/exec-access/status'],
    ['CANDIDATE', '/api/live-votes/active'],
    ['TALENT', '/api/review-delibs/active'],
    ['CLIENT', '/api/decision-guides'],
    ['ANON', '/api/document-rubrics'],
    ['CANDIDATE', '/api/review-teams/member-applications/1'],
    ['CANDIDATE', '/api/conversations'],
    ['MEMBER', '/api/master-communications/templates'],
    ['MEMBER', '/api/admin/email-health'],
    ['CANDIDATE', '/api/admin/email-health/test'],
  ])('flags %s getting 200 from %s as CRITICAL', (role, path) => {
    expect(ok(role, path)?.severity).toBe('CRITICAL');
  });

  it.each([
    ['ADMIN', '/api/admin/stats'],
    ['CLIENT', '/api/client/me'],
    ['TALENT', '/api/talent/me'],
    ['CANDIDATE', '/api/candidate/onboarding/status'],
    ['CANDIDATE', '/api/my-interview-signups/options'],
    ['MEMBER', '/api/exec-access/status'],
    ['ADMIN', '/api/live-votes/active'],
    ['MEMBER', '/api/review-delibs/active'],
    ['MEMBER', '/api/document-rubrics'],
    ['ADMIN', '/api/master-communications/templates'],
    ['ADMIN', '/api/admin/email-health'],
  ])('accepts %s getting 200 from %s', (role, path) => {
    expect(ok(role, path)).toBeNull();
  });

  it('treats the mixed-gate routers as anonymous-only', () => {
    // routes/member.js serves candidates on bare requireAuth.
    expect(ok('CANDIDATE', '/api/member/events')).toBeNull();
    expect(ok('ANON', '/api/member/events')?.severity).toBe('WARN');
    expect(ok('ANON', '/api/cases/:id')?.severity).toBe('WARN');
  });

  it('ignores prefixes with public routes', () => {
    expect(ok('ANON', '/api/applications/test-google-api')).toBeNull();
    expect(ok('ANON', '/api/auth/login')).toBeNull();
    expect(ok('ANON', '/api/interview-resources')).toBeNull();
  });

  it('only looks at successes', () => {
    expect(ok('MEMBER', '/api/admin/stats', { status: 403 })).toBeNull();
    expect(ok('MEMBER', '/api/admin/stats', { status: 500 })).toBeNull();
    expect(ok('MEMBER', '/api/admin/stats', { status: 304 })).toBeNull();
  });

  it('ignores preflights', () => {
    expect(ok('ANON', '/api/admin/stats', { method: 'OPTIONS', status: 204 })).toBeNull();
    expect(ok('ANON', '/api/admin/stats', { method: 'HEAD' })).toBeNull();
  });

  it('does not match a longer word sharing a prefix', () => {
    expect(ok('ANON', '/api/administer')).toBeNull();
    expect(ok('ANON', '/api/membership')).toBeNull();
  });

  it('answers the email-health router from its own row, not /api/admin', () => {
    expect(ok('MEMBER', '/api/admin/email-health/test').detail.prefix).toBe('/api/admin/email-health');
  });

  it('explains itself', () => {
    expect(ok('MEMBER', '/api/admin/stats').detail).toMatchObject({ prefix: '/api/admin', allowed: ['ADMIN'] });
  });
});

describe('isStaffOnlyPath', () => {
  it('is true for staff routers and false for everything else', () => {
    expect(isStaffOnlyPath('/api/admin/x')).toBe(true);
    expect(isStaffOnlyPath('/api/live-votes/x')).toBe(true);
    expect(isStaffOnlyPath('/api/review-delibs/x')).toBe(true);
    expect(isStaffOnlyPath('/api/client/me')).toBe(false);
    expect(isStaffOnlyPath('/api/member/events')).toBe(false);
    expect(isStaffOnlyPath('/api/auth/login')).toBe(false);
  });
});

describe('GUARD_TABLE', () => {
  it('has no duplicate prefixes', () => {
    const prefixes = GUARD_TABLE.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
