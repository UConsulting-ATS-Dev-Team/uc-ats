import { Box, Chip, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { fmtMs, fmtNum, ROLE_LABELS, ROLES, roleColors } from './formatters';
import { EmptyState, SectionTitle, SortableTable, StatTile, TrendChart } from './parts';

export default function EngagementTab({ data }) {
  const theme = useTheme();
  const colors = roleColors(theme);
  const roleLabel = ROLE_LABELS[data.role] || 'Everyone';
  const totals = data.perDay.reduce(
    (t, d) => ({ sessions: t.sessions + d.sessions, pageViews: t.pageViews + d.pageViews, clicks: t.clicks + d.clicks }),
    { sessions: 0, pageViews: 0, clicks: 0 }
  );

  return (
    <Box>
      <SectionTitle subtitle="Distinct signed-in people who used the site. Signed-out visitors have no account, so they appear only as sessions.">
        Reach by user type
      </SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
        {data.reach
          .filter((r) => r.role !== 'ANON')
          .map((r) => (
            <StatTile key={r.role} label={ROLE_LABELS[r.role]} value={fmtNum(r.week)} caption={`last 7 days · ${fmtNum(r.month)} in 30`} />
          ))}
      </Stack>

      <SectionTitle>Daily active users</SectionTitle>
      <TrendChart
        data={data.perDay}
        series={ROLES.filter((r) => r !== 'ANON').map((role) => ({ key: role, label: ROLE_LABELS[role], color: colors[role] }))}
      />

      <SectionTitle subtitle={`${roleLabel}, over the range.`}>Activity</SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
        <StatTile label="Sessions" value={fmtNum(totals.sessions)} caption="One per browser tab" />
        <StatTile label="Page views" value={fmtNum(totals.pageViews)} />
        <StatTile
          label="Pages per session"
          value={totals.sessions ? (totals.pageViews / totals.sessions).toFixed(1) : '—'}
          caption="How far people get"
        />
        <StatTile label="Clicks" value={fmtNum(totals.clicks)} />
      </Stack>
      <Box sx={{ mt: 2 }}>
        <TrendChart
          data={data.perDay}
          series={[
            { key: 'sessions', label: 'Sessions', color: theme.palette.primary.main },
            { key: 'pageViews', label: 'Page views', color: theme.palette.secondary.main },
          ]}
        />
      </Box>

      <SectionTitle subtitle={`${roleLabel}. The pages people open most, and how long they stay.`}>Most used pages</SectionTitle>
      <SortableTable
        rows={data.topPages}
        rowKey={(r) => r.path}
        initialSort="views"
        empty="No page views in this range."
        columns={[
          { key: 'path', label: 'Page', mono: true },
          { key: 'views', label: 'Views', align: 'right', render: (r) => fmtNum(r.views) },
          { key: 'p50DwellMs', label: 'Median time on page', align: 'right', render: (r) => fmtMs(r.p50DwellMs) },
        ]}
      />

      <SectionTitle
        subtitle={`${roleLabel}. Links show where they go; buttons whose text could be someone's name show only as "(button)" unless the code gives them a data-track label.`}
      >
        Most clicked
      </SectionTitle>
      <SortableTable
        rows={data.topButtons}
        rowKey={(r) => `${r.path}|${r.name}`}
        initialSort="count"
        empty="No clicks in this range."
        columns={[
          { key: 'name', label: 'Button or link' },
          { key: 'path', label: 'On page', mono: true },
          { key: 'count', label: 'Clicks', align: 'right', render: (r) => fmtNum(r.count) },
        ]}
      />

      <SectionTitle subtitle="Pages the app has that nobody opened in this range: candidates to promote, fix or retire. Includes redirects and pages only reachable from an email.">
        Pages nobody opened
      </SectionTitle>
      {data.unusedPages.length ? (
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          {data.unusedPages.map((p) => (
            <Chip key={p} label={p} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} />
          ))}
        </Stack>
      ) : (
        <EmptyState>Every page was opened at least once.</EmptyState>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        {fmtNum(data.unusedPages.length)} page{data.unusedPages.length === 1 ? '' : 's'}.
      </Typography>
    </Box>
  );
}
