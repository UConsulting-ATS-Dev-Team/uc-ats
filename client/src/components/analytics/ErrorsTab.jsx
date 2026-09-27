import { useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { fmtMs, fmtNum, fmtPct, fmtWhen, ROLE_LABELS } from './formatters';
import { EmptyState, SectionTitle, SortableTable, TrendChart } from './parts';

const SOURCE_LABELS = {
  console: 'Logged by a route',
  request: 'Uncaught in a route',
  unhandled: 'Crashed the server',
  cron: 'Scheduled job',
};

function ServerErrors({ rows }) {
  const [open, setOpen] = useState(null);
  if (!rows.length) return <EmptyState>No server errors in this range.</EmptyState>;
  return (
    <Box>
      {rows.map((row) => (
        <Accordion
          key={row.fingerprint}
          disableGutters
          variant="outlined"
          expanded={open === row.fingerprint}
          onChange={() => setOpen(open === row.fingerprint ? null : row.fingerprint)}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
              <Chip size="small" color="error" label={`${fmtNum(row.count)}×`} />
              <Typography noWrap sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 13 }}>
                {row.sample.message || '(no message)'}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap', display: { xs: 'none', md: 'block' } }}>
                last {fmtWhen(row.lastSeen)}
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
              {row.sample.source && <Chip size="small" variant="outlined" label={SOURCE_LABELS[row.sample.source] || row.sample.source} />}
              {row.sample.route && <Chip size="small" variant="outlined" label={row.sample.route} />}
              {row.sample.status && <Chip size="small" variant="outlined" label={`HTTP ${row.sample.status}`} />}
              <Chip size="small" variant="outlined" label={`First ${fmtWhen(row.firstSeen)}`} />
            </Stack>
            <Typography sx={{ fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {row.sample.message}
            </Typography>
            {row.sample.stack && (
              <Box
                component="pre"
                sx={{ mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, overflowX: 'auto', maxHeight: 320 }}
              >
                {row.sample.stack}
              </Box>
            )}
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}

const roles = (list) => (list || []).map((r) => ROLE_LABELS[r] || r).join(', ');

export default function ErrorsTab({ data }) {
  const theme = useTheme();
  return (
    <Box>
      <SectionTitle>Errors per day</SectionTitle>
      <TrendChart
        data={data.perDay}
        series={[
          { key: 'errors5xx', label: 'API 5xx responses', color: theme.palette.error.main },
          { key: 'serverErrors', label: 'Server errors logged', color: theme.palette.warning.main },
          { key: 'jsErrors', label: 'Browser errors', color: theme.palette.info.main },
        ]}
      />

      <SectionTitle
        subtitle={`Grouped when the message matches apart from ids and numbers. Kept ${data.retentionDays.server} days.`}
      >
        Server errors
      </SectionTitle>
      <ServerErrors rows={data.server} />

      <SectionTitle subtitle={`Routes that answered 5xx. Kept ${data.retentionDays.requests} days.`}>Failing routes</SectionTitle>
      <SortableTable
        rows={data.failingRoutes}
        rowKey={(r) => r.route}
        initialSort="count5xx"
        empty="No route answered 5xx in this range."
        columns={[
          { key: 'route', label: 'Route', mono: true },
          { key: 'count5xx', label: '5xx', align: 'right', render: (r) => fmtNum(r.count5xx) },
          { key: 'total', label: 'Requests', align: 'right', render: (r) => fmtNum(r.total) },
          { key: 'rate', label: 'Rate', align: 'right', sortValue: (r) => r.count5xx / r.total, render: (r) => fmtPct(r.count5xx / r.total) },
          { key: 'lastSeen', label: 'Last', render: (r) => fmtWhen(r.lastSeen) },
        ]}
      />

      <SectionTitle subtitle="Errors thrown in people's browsers that nothing caught, including pages that crashed.">
        Browser errors
      </SectionTitle>
      <SortableTable
        rows={data.client}
        rowKey={(r) => `${r.name}|${r.path}`}
        initialSort="count"
        empty="No browser errors in this range."
        columns={[
          { key: 'name', label: 'Message', mono: true },
          { key: 'path', label: 'Page', mono: true },
          { key: 'count', label: 'Times', align: 'right', render: (r) => fmtNum(r.count) },
          { key: 'sessions', label: 'Sessions', align: 'right', render: (r) => fmtNum(r.sessions) },
          { key: 'roles', label: 'Who', sortValue: (r) => roles(r.roles), render: (r) => roles(r.roles) },
          { key: 'lastSeen', label: 'Last', render: (r) => fmtWhen(r.lastSeen) },
        ]}
      />

      <SectionTitle subtitle="Requests the app made that failed, as the browser saw them. Status 0 means no answer at all (offline or dropped).">
        Failed requests from the app
      </SectionTitle>
      <SortableTable
        rows={data.api}
        rowKey={(r) => `${r.status}|${r.path}`}
        initialSort="count"
        empty="No failed requests in this range."
        columns={[
          { key: 'status', label: 'Status', render: (r) => <Chip size="small" label={r.status} color={Number(r.status) >= 500 || r.status === '0' ? 'error' : 'default'} /> },
          { key: 'path', label: 'Endpoint', mono: true },
          { key: 'count', label: 'Times', align: 'right', render: (r) => fmtNum(r.count) },
          { key: 'roles', label: 'Who', sortValue: (r) => roles(r.roles), render: (r) => roles(r.roles) },
          { key: 'lastSeen', label: 'Last', render: (r) => fmtWhen(r.lastSeen) },
        ]}
      />

      <SectionTitle subtitle="Calls that took longer than two seconds in the browser.">Slow requests</SectionTitle>
      <SortableTable
        rows={data.slowApi}
        rowKey={(r) => r.path}
        initialSort="count"
        empty="No call took longer than two seconds."
        columns={[
          { key: 'path', label: 'Endpoint', mono: true },
          { key: 'count', label: 'Times', align: 'right', render: (r) => fmtNum(r.count) },
          { key: 'avgMs', label: 'Average', align: 'right', render: (r) => fmtMs(r.avgMs) },
          { key: 'maxMs', label: 'Slowest', align: 'right', render: (r) => fmtMs(r.maxMs) },
        ]}
      />
    </Box>
  );
}
