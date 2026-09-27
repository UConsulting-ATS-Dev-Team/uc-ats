// The Engagement, Email and Security tabs lay out what the server decided;
// these check the decisions reach the screen: setup notices when tracking is
// not wired up, critical security events above everything else, and filters
// handed back to the page.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import EmailTab from './EmailTab';
import EngagementTab from './EngagementTab';
import SecurityTab from './SecurityTab';

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ResponsiveContainer: ({ children }) => <div style={{ width: 800, height: 260 }}>{children}</div> };
});

const EMAIL = {
  trackingActive: false,
  deliveryReporting: true,
  categories: [
    {
      category: 'INTERVIEW_SLOT',
      sent: 100,
      delivered: 90,
      bounced: 8,
      complained: 0,
      failed: 2,
      opened: 40,
      clicked: 30,
      deliveryRate: 0.9,
      bounceRate: 0.08,
      complaintRate: 0,
      clickRate: 0.333,
    },
  ],
  topLinks: [],
  bots: { count: 0, topUserAgents: [] },
  perDay: [],
};

describe('EmailTab', () => {
  it('explains how to turn click tracking on until SES reports any', () => {
    render(<EmailTab data={EMAIL} />);
    expect(screen.getByText('Click tracking is not reporting')).toBeInTheDocument();
    expect(screen.getByText('Interview scheduling')).toBeInTheDocument();
  });

  it('drops the notice once clicks arrive, and flags a bounce rate SES would review', () => {
    render(<EmailTab data={{ ...EMAIL, trackingActive: true }} />);
    expect(screen.queryByText('Click tracking is not reporting')).not.toBeInTheDocument();
    const chip = screen.getAllByText('8.0%').map((el) => el.closest('.MuiChip-root')).find(Boolean);
    expect(chip).toHaveClass('MuiChip-colorError');
  });

  it('warns when delivery events are not arriving at all', () => {
    render(<EmailTab data={{ ...EMAIL, deliveryReporting: false }} />);
    expect(screen.getByText(/SES delivery events are not reaching the server/)).toBeInTheDocument();
  });
});

const SECURITY = {
  filters: { kind: null, role: null, ip: null, page: 0 },
  posture: [
    { key: 'jwt_secret', label: 'JWT signing secret', status: 'FAIL', detail: 'Set to a placeholder value.' },
    { key: 'helmet', label: 'Security headers', status: 'PASS', detail: 'helmet() is applied.' },
  ],
  anomalies: [
    { kind: 'GUARD_BYPASS_SUSPECT', severity: 'CRITICAL', ip: '9.9.9.9', path: '/api/admin/stats', role: 'MEMBER', count: 2, lastSeen: '2026-09-27T10:00:00Z', detail: { reason: 'MEMBER got 200 from a /api/admin route' } },
    { kind: 'PATH_PROBE', severity: 'WARN', ip: '5.5.5.5', path: '/wp-login.php', role: 'ANON', count: 40, lastSeen: '2026-09-27T09:00:00Z' },
  ],
  denied: {
    rows: [{ id: 'e1', at: '2026-09-27T10:00:00Z', kind: 'LOGIN_FAILED', severity: 'INFO', role: 'ANON', ip: '5.5.5.5', path: '/api/auth/login', method: 'POST', detail: { email: 'target@ucla.edu' } }],
    total: 1,
    page: 0,
    pageSize: 50,
  },
  execAccess: {
    rows: [{ id: 'x1', action: 'UNLOCK_FAILED', userId: 'u1', user: { email: 'member@ucla.edu' }, ipAddress: '7.7.7.7', createdAt: '2026-09-27T09:30:00Z' }],
    total: 1,
    page: 0,
    pageSize: 50,
  },
  loginsPerDay: [],
  topIps: [],
};

describe('SecurityTab', () => {
  it('puts a critical event above everything, with its reason', () => {
    render(<SecurityTab data={SECURITY} onFilter={vi.fn()} />);
    expect(screen.getByText(/Reached a route it should not/)).toBeInTheDocument();
    expect(screen.getByText('MEMBER got 200 from a /api/admin route')).toBeInTheDocument();
    expect(screen.queryByText(/No critical events/)).not.toBeInTheDocument();
  });

  it('shows the configuration checklist with failures', () => {
    render(<SecurityTab data={SECURITY} onFilter={vi.fn()} />);
    expect(screen.getByText('JWT signing secret')).toBeInTheDocument();
    expect(screen.getByText('1 fail')).toBeInTheDocument();
  });

  it('shows which account a failed sign-in targeted, and filters by address on click', async () => {
    const onFilter = vi.fn();
    render(<SecurityTab data={SECURITY} onFilter={onFilter} />);
    expect(screen.getByText('target@ucla.edu')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: '5.5.5.5' })[0]);
    expect(onFilter).toHaveBeenCalledWith({ ip: '5.5.5.5', page: 0 });
  });

  it('lists failed executive unlocks with who tried', () => {
    render(<SecurityTab data={SECURITY} onFilter={vi.fn()} />);
    expect(screen.getByText('Wrong executive password')).toBeInTheDocument();
    expect(screen.getByText('member@ucla.edu')).toBeInTheDocument();
  });

  it('offers a way back from a shared link past the last page', async () => {
    const onFilter = vi.fn();
    render(
      <SecurityTab
        data={{ ...SECURITY, filters: { ...SECURITY.filters, page: 9 }, denied: { rows: [], total: 1, page: 9, pageSize: 50 } }}
        onFilter={onFilter}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back to the first page' }));
    expect(onFilter).toHaveBeenCalledWith({ page: 0 });
  });

  it('keeps the paged access log in server order, with no sort controls', () => {
    render(<SecurityTab data={SECURITY} onFilter={vi.fn()} />);
    const header = screen.getAllByRole('columnheader', { name: 'When' }).at(-1);
    expect(header.querySelector('.MuiTableSortLabel-root')).toBeNull();
  });

  it('says so when nothing critical happened', () => {
    render(<SecurityTab data={{ ...SECURITY, anomalies: [] }} onFilter={vi.fn()} />);
    expect(screen.getByText(/No critical events in this range/)).toBeInTheDocument();
  });
});

describe('EngagementTab', () => {
  it('lists pages nobody opened and the most clicked controls', () => {
    render(
      <EngagementTab
        data={{
          role: 'ALL',
          perDay: [{ day: '2026-09-27', partial: true, sessions: 4, pageViews: 10, clicks: 3, MEMBER: 2 }],
          reach: [{ role: 'MEMBER', week: 12, month: 30 }],
          topPages: [{ path: '/dashboard', views: 10, p50DwellMs: 4000 }],
          topButtons: [{ path: '/dashboard', name: 'Open interview', count: 3 }],
          unusedPages: ['/talent-pool'],
        }}
      />
    );
    expect(screen.getByText('/talent-pool')).toBeInTheDocument();
    expect(screen.getByText('Open interview')).toBeInTheDocument();
    expect(screen.getByText('2.5')).toBeInTheDocument();
  });
});
