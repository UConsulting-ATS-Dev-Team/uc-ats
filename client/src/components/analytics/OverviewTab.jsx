import { Alert, AlertTitle, Box, Button, Stack } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { fmtMs, fmtNum, fmtPct, fmtWhen, ROLE_LABELS, ROLES, roleColors } from './formatters';
import { SectionTitle, SortableTable, StatTile, TrendChart } from './parts';

const SEVERITY = { error: 'error', warning: 'warning', info: 'info' };

function Attention({ items, onOpenTab }) {
  if (!items.length) {
    return <Alert severity="success">Nothing needs attention: no new server errors, failing routes, slowdowns or critical security events.</Alert>;
  }
  return (
    <Stack spacing={1}>
      {items.map((item, i) => (
        <Alert
          key={`${item.type}-${i}`}
          severity={SEVERITY[item.severity] || 'info'}
          action={
            item.tab && item.tab !== 'overview' ? (
              <Button color="inherit" size="small" onClick={() => onOpenTab(item.tab)}>
                Open
              </Button>
            ) : null
          }
        >
          <AlertTitle sx={{ mb: item.detail || item.at ? 0.5 : 0 }}>{item.label}</AlertTitle>
          {item.detail}
          {item.at && `Last seen ${fmtWhen(item.at)}`}
        </Alert>
      ))}
    </Stack>
  );
}

export default function OverviewTab({ data, onOpenTab }) {
  const theme = useTheme();
  const colors = roleColors(theme);
  const all = data.tiles.ALL || {};
  const y = all.yesterday || {};
  const p = all.previous || {};
  const t = all.today || {};

  const roleRows = ROLES.map((role) => {
    const tile = data.tiles[role] || {};
    return { role, today: tile.today || {}, yesterday: tile.yesterday || {} };
  }).filter((r) => r.today.apiRequests || r.yesterday.apiRequests || r.today.sessions || r.yesterday.sessions);

  const usersSeries = data.series.map((d) => ({ day: d.day, partial: d.partial, ...d.activeUsers }));
  const errorSeries = data.series.map((d) => ({
    day: d.day,
    partial: d.partial,
    errors5xx: d.errors5xx,
    serverErrors: d.serverErrors,
    jsErrors: d.jsErrors,
  }));

  return (
    <Box>
      <SectionTitle subtitle="Recomputed on every load from the last 24 hours and the last full day.">Needs attention</SectionTitle>
      <Attention items={data.attention} onOpenTab={onOpenTab} />

      <SectionTitle subtitle="The last full day, compared with the day before. Today so far is underneath.">Yesterday</SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
        <StatTile label="Active users" value={fmtNum(y.activeUsers)} after={y.activeUsers} before={p.activeUsers} caption={`Today so far: ${fmtNum(t.activeUsers)}`} />
        <StatTile label="Page views" value={fmtNum(y.pageViews)} after={y.pageViews} before={p.pageViews} caption={`Today so far: ${fmtNum(t.pageViews)}`} />
        <StatTile
          label="API p95"
          value={fmtMs(y.apiP95Ms)}
          after={y.apiP95Ms}
          before={p.apiP95Ms}
          lowerIsBetter
          caption={`Today so far: ${fmtMs(t.apiP95Ms)}`}
        />
        <StatTile
          label="Server error rate"
          value={fmtPct(y.errorRate, 2)}
          after={y.errorRate}
          before={p.errorRate}
          lowerIsBetter
          caption={`${fmtNum(y.errors5xx)} of ${fmtNum(y.apiRequests)} requests`}
        />
        <StatTile
          label="Security flags"
          value={fmtNum(y.securityFlags)}
          after={y.securityFlags}
          before={p.securityFlags}
          lowerIsBetter
          caption={`Today so far: ${fmtNum(t.securityFlags)}`}
        />
      </Stack>

      <SectionTitle subtitle="Signed-out visitors have no account, so they count as sessions rather than users.">By user type</SectionTitle>
      <SortableTable
        rowKey={(r) => r.role}
        initialSort="yesterdayRequests"
        empty="No traffic recorded yet."
        rows={roleRows.map((r) => ({
          role: r.role,
          yesterdayUsers: r.yesterday.activeUsers ?? 0,
          yesterdaySessions: r.yesterday.sessions ?? 0,
          yesterdayRequests: r.yesterday.apiRequests ?? 0,
          yesterdayP95: r.yesterday.apiP95Ms ?? null,
          yesterdayErrorRate: r.yesterday.errorRate ?? null,
          todayUsers: r.today.activeUsers ?? 0,
        }))}
        columns={[
          { key: 'role', label: 'User type', render: (r) => ROLE_LABELS[r.role] },
          { key: 'yesterdayUsers', label: 'Users', align: 'right', render: (r) => fmtNum(r.yesterdayUsers) },
          { key: 'yesterdaySessions', label: 'Sessions', align: 'right', render: (r) => fmtNum(r.yesterdaySessions) },
          { key: 'yesterdayRequests', label: 'API requests', align: 'right', render: (r) => fmtNum(r.yesterdayRequests) },
          { key: 'yesterdayP95', label: 'API p95', align: 'right', render: (r) => fmtMs(r.yesterdayP95) },
          { key: 'yesterdayErrorRate', label: '5xx rate', align: 'right', render: (r) => fmtPct(r.yesterdayErrorRate, 2) },
          { key: 'todayUsers', label: 'Users today', align: 'right', render: (r) => fmtNum(r.todayUsers) },
        ]}
      />

      <SectionTitle>Active users by type</SectionTitle>
      <TrendChart
        data={usersSeries}
        series={ROLES.filter((r) => r !== 'ANON').map((role) => ({ key: role, label: ROLE_LABELS[role], color: colors[role] }))}
      />

      <SectionTitle>Errors per day</SectionTitle>
      <TrendChart
        data={errorSeries}
        series={[
          { key: 'errors5xx', label: 'API 5xx responses', color: theme.palette.error.main },
          { key: 'serverErrors', label: 'Server errors logged', color: theme.palette.warning.main },
          { key: 'jsErrors', label: 'Browser errors', color: theme.palette.info.main },
        ]}
      />
    </Box>
  );
}
