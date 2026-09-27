import { Box, Chip, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { fmtMs, fmtNum, fmtPct, fmtVital, ROLE_LABELS, ROLES, roleColors, VITAL_LABELS, vitalRating } from './formatters';
import { SectionTitle, SortableTable, StatTile, TrendChart } from './parts';

const VITAL_ORDER = ['LCP', 'INP', 'CLS', 'TTFB'];

export default function PerformanceTab({ data }) {
  const theme = useTheme();
  const colors = roleColors(theme);
  const roleLabel = ROLE_LABELS[data.role] || 'Everyone';
  const vitals = VITAL_ORDER.map((name) => data.vitals.find((v) => v.name === name) || { name, samples: 0, p50: null, p95: null });

  return (
    <Box>
      <SectionTitle subtitle="How long the server takes to answer each type of user, over the whole range. p95 is the time 95% of requests beat.">
        Speed by user type
      </SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
        {data.byRole
          .filter((r) => r.requests > 0)
          .map((r) => (
            <StatTile
              key={r.role}
              label={ROLE_LABELS[r.role]}
              value={fmtMs(r.p95Ms)}
              caption={`p50 ${fmtMs(r.p50Ms)} · ${fmtNum(r.requests)} requests · ${fmtNum(r.errors5xx)} 5xx`}
            />
          ))}
      </Stack>

      <SectionTitle>API p95 per day</SectionTitle>
      <TrendChart
        data={data.p95Series}
        format={fmtMs}
        series={ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role], color: colors[role] }))}
      />

      <SectionTitle
        subtitle={`${roleLabel}. Measured in real browsers. Green is Google's "good" threshold, amber "needs improvement".`}
      >
        Page experience
      </SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
        {vitals.map((v) => (
          <Box key={v.name} sx={{ flex: 1, minWidth: 180, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
            <Typography variant="subtitle2" color="text.secondary">
              {VITAL_LABELS[v.name]}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <Typography variant="h5">{fmtVital(v.name, v.p50)}</Typography>
              {v.samples > 0 && <Chip size="small" color={vitalRating(v.name, v.p50)} label="median" variant="outlined" />}
            </Box>
            <Typography variant="caption" color="text.secondary">
              p95 {fmtVital(v.name, v.p95)} · {fmtNum(v.samples)} samples
            </Typography>
          </Box>
        ))}
      </Stack>

      <SectionTitle subtitle="Slowest routes with at least five requests in the range.">Slowest API routes</SectionTitle>
      <SortableTable
        rows={data.slowest}
        rowKey={(r) => r.route}
        initialSort="p95Ms"
        empty="No route has enough traffic yet."
        columns={[
          { key: 'route', label: 'Route', mono: true },
          { key: 'count', label: 'Requests', align: 'right', render: (r) => fmtNum(r.count) },
          { key: 'p50Ms', label: 'p50', align: 'right', render: (r) => fmtMs(r.p50Ms) },
          { key: 'p95Ms', label: 'p95', align: 'right', render: (r) => fmtMs(r.p95Ms) },
          { key: 'maxMs', label: 'Max', align: 'right', render: (r) => fmtMs(r.maxMs) },
        ]}
      />

      <SectionTitle
        subtitle={`${roleLabel}. Over more than one day, p50 and p95 are request-weighted averages of each day's figure.`}
      >
        Every API route
      </SectionTitle>
      <SortableTable
        rows={data.routes}
        rowKey={(r) => r.route}
        initialSort="count"
        maxRows={100}
        empty="No requests recorded yet."
        columns={[
          { key: 'route', label: 'Route', mono: true },
          { key: 'count', label: 'Requests', align: 'right', render: (r) => fmtNum(r.count) },
          { key: 'errorPct', label: '5xx', align: 'right', render: (r) => (r.errors5xx ? `${fmtNum(r.errors5xx)} (${fmtPct(r.errorPct)})` : '0') },
          { key: 'p50Ms', label: 'p50', align: 'right', render: (r) => fmtMs(r.p50Ms) },
          { key: 'p95Ms', label: 'p95', align: 'right', render: (r) => fmtMs(r.p95Ms) },
          { key: 'maxMs', label: 'Max', align: 'right', render: (r) => fmtMs(r.maxMs) },
        ]}
      />

      <SectionTitle subtitle="Median time a page stayed open before the next navigation.">Pages</SectionTitle>
      <SortableTable
        rows={data.pages}
        rowKey={(r) => r.path}
        initialSort="views"
        empty="No page views recorded yet."
        columns={[
          { key: 'path', label: 'Page', mono: true },
          { key: 'views', label: 'Views', align: 'right', render: (r) => fmtNum(r.views) },
          { key: 'p50DwellMs', label: 'Median time on page', align: 'right', render: (r) => fmtMs(r.p50DwellMs) },
        ]}
      />
    </Box>
  );
}
