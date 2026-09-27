import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TablePagination,
  TextField,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

import { fmtNum, fmtWhen, ROLE_LABELS, ROLES } from './formatters';
import { EmptyState, SectionTitle, SortableTable, TrendChart } from './parts';

export const KIND_LABELS = {
  GUARD_BYPASS_SUSPECT: 'Reached a route it should not',
  BRUTE_FORCE: 'Password guessing',
  PATH_PROBE: 'Vulnerability scan',
  CORS_DENIED: 'Request from another website',
  RATE_LIMITED: 'Rate limited',
  ROLE_DENIED: 'Refused: wrong user type',
  RECORD_LOCKED: 'Refused: sealed record',
  AUTH_DENIED: 'Refused: expired or invalid sign-in',
  LOGIN_FAILED: 'Failed sign-in',
  LOGIN_OK: 'Signed in',
};
const kindLabel = (k) => KIND_LABELS[k] || k;

const SEVERITY_COLOR = { CRITICAL: 'error', WARN: 'warning', INFO: 'default' };

const POSTURE_ICON = {
  FAIL: <ErrorIcon color="error" />,
  WARN: <WarningAmberIcon color="warning" />,
  UNKNOWN: <HelpOutlineIcon color="disabled" />,
  INFO: <InfoOutlinedIcon color="info" />,
  PASS: <CheckCircleIcon color="success" />,
};

const EXEC_ACTIONS = {
  UNLOCK_OK: 'Unlocked sealed records (30 min)',
  UNLOCK_RECORD: 'Unsealed a record',
  UNLOCK_FAILED: 'Wrong executive password',
  UNLOCK_RATE_LIMITED: 'Locked out after repeated failures',
  PASSWORD_SET: 'Changed the executive password',
};

export function PostureChecklist({ checks }) {
  const counts = checks.reduce((c, x) => ({ ...c, [x.status]: (c[x.status] || 0) + 1 }), {});
  return (
    <Paper variant="outlined">
      <Stack direction="row" spacing={1} sx={{ p: 1.5, pb: 0 }} flexWrap="wrap" useFlexGap>
        {['FAIL', 'WARN', 'PASS'].map((s) =>
          counts[s] ? <Chip key={s} size="small" label={`${counts[s]} ${s.toLowerCase()}`} color={{ FAIL: 'error', WARN: 'warning', PASS: 'success' }[s]} variant="outlined" /> : null
        )}
      </Stack>
      <List dense>
        {checks.map((c) => (
          <ListItem key={c.key}>
            <ListItemIcon sx={{ minWidth: 36 }}>{POSTURE_ICON[c.status]}</ListItemIcon>
            <ListItemText primary={c.label} secondary={c.detail} />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

/** A shared link can point past the last page; say so and offer the way back. */
function PastTheEnd({ onBack }) {
  return (
    <Box>
      This page is past the end of the results.{' '}
      <Button size="small" onClick={onBack}>
        Back to the first page
      </Button>
    </Box>
  );
}

const who = (row) => row.user?.email || (row.role ? ROLE_LABELS[row.role] : '—');

export default function SecurityTab({ data, onFilter }) {
  const theme = useTheme();
  const [ipDraft, setIpDraft] = useState(data.filters.ip || '');
  useEffect(() => setIpDraft(data.filters.ip || ''), [data.filters.ip]);

  const critical = data.anomalies.filter((a) => a.severity === 'CRITICAL');
  const warnings = data.anomalies.filter((a) => a.severity !== 'CRITICAL');
  const filters = data.filters;

  return (
    <Box>
      {critical.map((a, i) => (
        <Alert key={`c-${i}`} severity="error" sx={{ mb: 1 }}>
          <AlertTitle>
            {kindLabel(a.kind)} · {fmtNum(a.count)}×
          </AlertTitle>
          {[a.path, a.ip && `from ${a.ip}`, a.role && ROLE_LABELS[a.role], `last ${fmtWhen(a.lastSeen)}`].filter(Boolean).join(' · ')}
          {a.detail?.reason && <Box component="span" sx={{ display: 'block' }}>{a.detail.reason}</Box>}
          {a.kind === 'BRUTE_FORCE' && a.detail?.value && (
            <Box component="span" sx={{ display: 'block' }}>
              {a.detail.failures} failures for {a.detail.by === 'email' ? 'the account' : 'the address'} {a.detail.value} within {a.detail.windowMinutes} minutes
            </Box>
          )}
        </Alert>
      ))}
      {!critical.length && (
        <Alert severity="success" sx={{ mb: 1 }}>
          No critical events in this range: nobody got an answer from a route their user type is barred from, and no
          password-guessing burst was seen.
        </Alert>
      )}

      <SectionTitle subtitle="How this deployment is configured, checked live. Fix failures first.">Configuration</SectionTitle>
      <PostureChecklist checks={data.posture} />

      <SectionTitle subtitle="Scans, cross-site requests and rate limiting, grouped by source.">Suspicious activity</SectionTitle>
      <SortableTable
        rows={warnings}
        rowKey={(r) => `${r.kind}|${r.ip}|${r.path}|${r.role}`}
        initialSort="lastSeen"
        empty="Nothing suspicious in this range."
        columns={[
          { key: 'kind', label: 'What', render: (r) => kindLabel(r.kind) },
          { key: 'path', label: 'Path', mono: true },
          { key: 'ip', label: 'From', mono: true },
          { key: 'count', label: 'Times', align: 'right', render: (r) => fmtNum(r.count) },
          { key: 'lastSeen', label: 'Last', render: (r) => fmtWhen(r.lastSeen) },
        ]}
      />

      <SectionTitle subtitle="The executive unlock is the only sanctioned way past a seal, so every use and every failed attempt is listed.">
        Sealed records
      </SectionTitle>
      <SortableTable
        rows={data.execAccess.rows}
        sortable={false}
        rowKey={(r) => r.id}
        initialSort="createdAt"
        maxRows={data.execAccess.pageSize}
        empty={
          data.execAccess.page > 0 ? (
            <PastTheEnd onBack={() => onFilter({ execPage: 0 })} />
          ) : (
            'No executive unlocks or attempts in this range.'
          )
        }
        columns={[
          {
            key: 'action',
            label: 'What',
            render: (r) => (
              <Chip
                size="small"
                variant="outlined"
                color={r.action.startsWith('UNLOCK_FAILED') || r.action === 'UNLOCK_RATE_LIMITED' ? 'warning' : 'default'}
                label={EXEC_ACTIONS[r.action] || r.action}
              />
            ),
          },
          { key: 'user', label: 'Who', sortValue: (r) => r.user?.email || '', render: (r) => r.user?.email || r.userId || '—' },
          { key: 'ipAddress', label: 'From', mono: true },
          { key: 'createdAt', label: 'When', render: (r) => fmtWhen(r.createdAt) },
        ]}
      />
      {data.execAccess.total > data.execAccess.pageSize && (
        <TablePagination
          component="div"
          count={data.execAccess.total}
          page={Math.min(data.execAccess.page, Math.max(0, Math.ceil(data.execAccess.total / data.execAccess.pageSize) - 1))}
          rowsPerPage={data.execAccess.pageSize}
          rowsPerPageOptions={[data.execAccess.pageSize]}
          onPageChange={(e, execPage) => onFilter({ execPage, asOf: data.asOf })}
        />
      )}

      <SectionTitle>Sign-ins per day</SectionTitle>
      <TrendChart
        data={data.loginsPerDay}
        series={[
          { key: 'ok', label: 'Signed in', color: theme.palette.success.main },
          { key: 'failed', label: 'Failed', color: theme.palette.error.main },
        ]}
      />

      <SectionTitle subtitle="Every refusal and flag, newest first. Filter to follow one address or one kind.">Access log</SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 1.5 }}>
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel id="sec-kind">What</InputLabel>
          <Select labelId="sec-kind" label="What" value={filters.kind || ''} onChange={(e) => onFilter({ kind: e.target.value || null, page: 0 })}>
            <MenuItem value="">Everything</MenuItem>
            {Object.keys(KIND_LABELS)
              .filter((k) => k !== 'LOGIN_OK')
              .map((k) => (
                <MenuItem key={k} value={k}>
                  {kindLabel(k)}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel id="sec-role">User type</InputLabel>
          <Select labelId="sec-role" label="User type" value={filters.role || ''} onChange={(e) => onFilter({ role: e.target.value || null, page: 0 })}>
            <MenuItem value="">Any</MenuItem>
            {ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          size="small"
          label="IP address"
          value={ipDraft}
          onChange={(e) => setIpDraft(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && onFilter({ ip: ipDraft || null, page: 0 })}
          inputProps={{ 'data-no-track': true }}
        />
        <Button variant="outlined" onClick={() => onFilter({ ip: ipDraft || null, page: 0 })}>
          Apply
        </Button>
        {(filters.kind || filters.role || filters.ip) && (
          <Button onClick={() => onFilter({ kind: null, role: null, ip: null, page: 0 })}>Clear</Button>
        )}
      </Stack>
      {data.denied.rows.length ? (
        <Paper variant="outlined">
          <SortableTable
            rows={data.denied.rows}
            sortable={false}
            rowKey={(r) => r.id}
            initialSort="at"
            maxRows={data.denied.pageSize}
            columns={[
              { key: 'at', label: 'When', render: (r) => fmtWhen(r.at) },
              {
                key: 'kind',
                label: 'What',
                render: (r) => <Chip size="small" variant="outlined" color={SEVERITY_COLOR[r.severity]} label={kindLabel(r.kind)} />,
              },
              { key: 'who', label: 'Who', sortValue: who, render: (r) => r.detail?.email || who(r) },
              { key: 'path', label: 'Path', mono: true, render: (r) => (r.method ? `${r.method} ${r.path || ''}` : r.path) },
              {
                key: 'ip',
                label: 'From',
                mono: true,
                render: (r) =>
                  r.ip ? (
                    <Button size="small" sx={{ fontFamily: 'monospace', textTransform: 'none', p: 0, minWidth: 0 }} onClick={() => onFilter({ ip: r.ip, page: 0 })}>
                      {r.ip}
                    </Button>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <TablePagination
            component="div"
            count={data.denied.total}
            page={data.denied.page}
            rowsPerPage={data.denied.pageSize}
            rowsPerPageOptions={[data.denied.pageSize]}
            onPageChange={(e, page) => onFilter({ page, asOf: data.asOf })}
          />
        </Paper>
      ) : (
        <EmptyState>
          {data.denied.page > 0 ? <PastTheEnd onBack={() => onFilter({ page: 0 })} /> : 'Nothing matches.'}
        </EmptyState>
      )}

      <SectionTitle subtitle="Addresses behind the most refusals and flags. Sign-ins that worked are left out.">Top sources</SectionTitle>
      <SortableTable
        rows={data.topIps}
        rowKey={(r) => r.ip}
        initialSort="critical"
        empty="No refusals in this range."
        columns={[
          { key: 'ip', label: 'Address', mono: true },
          { key: 'events', label: 'Events', align: 'right', render: (r) => fmtNum(r.events) },
          { key: 'warn', label: 'Warnings', align: 'right', render: (r) => fmtNum(r.warn) },
          { key: 'critical', label: 'Critical', align: 'right', render: (r) => fmtNum(r.critical) },
          { key: 'kinds', label: 'Kinds', sortValue: (r) => r.kinds.length, render: (r) => r.kinds.map(kindLabel).join(', ') },
          { key: 'lastSeen', label: 'Last', render: (r) => fmtWhen(r.lastSeen) },
        ]}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        Security events are kept 180 days. Brute force is detected and reported here, not blocked: sign-in has no rate
        limit yet.
      </Typography>
    </Box>
  );
}
