import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';

import AccessControl from '../components/AccessControl';
import EmailTab from '../components/analytics/EmailTab';
import EngagementTab from '../components/analytics/EngagementTab';
import ErrorsTab from '../components/analytics/ErrorsTab';
import SecurityTab from '../components/analytics/SecurityTab';
import OverviewTab from '../components/analytics/OverviewTab';
import PerformanceTab from '../components/analytics/PerformanceTab';
import { fmtDay, ROLE_LABELS, ROLES } from '../components/analytics/formatters';
import apiClient from '../utils/api';

// Site Analytics: how the ATS is performing and being used, and what is
// failing. Finished days come from a nightly rollup (02:15 Los Angeles);
// today is computed live from the raw tables on every load.

export const TABS = [
  { key: 'overview', label: 'Overview', endpoint: 'overview' },
  { key: 'performance', label: 'Performance', endpoint: 'performance', byRole: true },
  { key: 'errors', label: 'Errors', endpoint: 'errors' },
  { key: 'engagement', label: 'Engagement', endpoint: 'engagement', byRole: true },
  { key: 'email', label: 'Email', endpoint: 'email' },
  { key: 'security', label: 'Security', endpoint: 'security' },
];

// The Security tab's access-log filters, as URL parameters (sec_ prefixed so
// they never collide with the page's own `role`).
const SECURITY_PARAMS = { kind: 'sec_kind', role: 'sec_role', ip: 'sec_ip', page: 'sec_page', execPage: 'sec_exec_page' };

export function describeRollup(days) {
  if (days.length <= 2) return days.map(fmtDay).join(' and ');
  return `${days.length} days (${fmtDay(days.at(-1))} to ${fmtDay(days[0])})`;
}

const RANGES = [7, 30, 90];

function tabIndex(key) {
  const i = TABS.findIndex((t) => t.key === key);
  return i === -1 ? 0 : i;
}

// The data hooks live below the role gate, so a non-admin who opens the URL
// never calls the admin endpoints.
export default function AdminAnalytics() {
  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <AnalyticsDashboard />
    </AccessControl>
  );
}

function AnalyticsDashboard() {
  const [params, setParams] = useSearchParams();
  const tab = TABS[tabIndex(params.get('tab'))];
  const days = RANGES.includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const role = ROLES.includes(params.get('role')) ? params.get('role') : 'ALL';
  const securityKey = Object.values(SECURITY_PARAMS)
    .map((p) => params.get(p) || '')
    .join('|');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rollup, setRollup] = useState({ running: false, message: '', severity: 'info' });

  const setParam = (key, value, fallback) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, String(value));
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    if (!tab.endpoint) {
      setData(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ days: String(days) });
      if (tab.byRole && role !== 'ALL') query.set('role', role);
      if (tab.key === 'security') {
        for (const [name, param] of Object.entries(SECURITY_PARAMS)) {
          if (params.get(param)) query.set(name, params.get(param));
        }
      }
      setData({ tab: tab.key, payload: await apiClient.get(`/admin/analytics/${tab.endpoint}?${query}`) });
    } catch (e) {
      setError(e.serverMessage || e.message || 'Could not load analytics');
      setData(null);
    } finally {
      setLoading(false);
    }
    // securityKey stands in for the security params, so other URL changes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key, tab.endpoint, tab.byRole, days, role, securityKey]);

  const onSecurityFilter = (changes) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      const param = SECURITY_PARAMS[name];
      const isFirstPage = (name === 'page' || name === 'execPage') && Number(value) === 0;
      if (value === null || value === undefined || value === '' || isFirstPage) next.delete(param);
      else next.set(param, String(value));
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    load();
  }, [load]);

  const runRollup = async () => {
    setRollup({ running: true, message: '', severity: 'info' });
    try {
      const result = await apiClient.post('/admin/analytics/rollup', {});
      setRollup({
        running: false,
        severity: 'success',
        message: `Rolled up ${describeRollup(result.days)} in ${result.ms} ms.`,
      });
      load();
    } catch (e) {
      setRollup({ running: false, severity: 'error', message: e.serverMessage || 'Rollup failed' });
    }
  };

  // Only render the payload that belongs to the tab on screen, never the
  // previous tab's while the next one loads.
  const payload = data && data.tab === tab.key ? data.payload : null;
  const dataThrough = payload?.dataThrough;

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1400, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} spacing={2} sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h4">Site Analytics</Typography>
          <Typography variant="body2" color="text.secondary">
            {dataThrough ? `Rolled up through ${fmtDay(dataThrough)}; today is live.` : 'Nothing rolled up yet; today is live.'}{' '}
            Updated nightly at 2:15 AM Pacific.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <ToggleButtonGroup size="small" exclusive value={days} onChange={(e, v) => v && setParam('days', v, 30)} aria-label="Date range">
            {RANGES.map((d) => (
              <ToggleButton key={d} value={d}>
                {d} days
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          {tab.byRole && (
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="analytics-role">User type</InputLabel>
              <Select labelId="analytics-role" label="User type" value={role} onChange={(e) => setParam('role', e.target.value, 'ALL')}>
                {['ALL', ...ROLES].map((r) => (
                  <MenuItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Button variant="outlined" onClick={load} disabled={loading}>
            Refresh
          </Button>
          <Button variant="outlined" onClick={runRollup} disabled={rollup.running}>
            {rollup.running ? 'Rolling up…' : 'Run rollup now'}
          </Button>
        </Stack>
      </Stack>

      {rollup.message && (
        <Alert severity={rollup.severity} sx={{ mb: 2 }} onClose={() => setRollup((r) => ({ ...r, message: '' }))}>
          {rollup.message}
        </Alert>
      )}

      <Paper sx={{ px: 2, mb: 2 }}>
        <Tabs
          value={tabIndex(tab.key)}
          onChange={(e, i) => setParam('tab', TABS[i].key, 'overview')}
          variant="scrollable"
          scrollButtons="auto"
        >
          {TABS.map((t) => (
            <Tab key={t.key} label={t.label} />
          ))}
        </Tabs>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>
          {error}
        </Alert>
      )}


      {tab.endpoint && loading && !payload && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {payload && tab.key === 'overview' && <OverviewTab data={payload} onOpenTab={(key) => setParam('tab', key, 'overview')} />}
      {payload && tab.key === 'performance' && <PerformanceTab data={payload} />}
      {payload && tab.key === 'errors' && <ErrorsTab data={payload} />}
      {payload && tab.key === 'engagement' && <EngagementTab data={payload} />}
      {payload && tab.key === 'email' && <EmailTab data={payload} />}
      {payload && tab.key === 'security' && <SecurityTab data={payload} onFilter={onSecurityFilter} />}
    </Box>
  );
}
