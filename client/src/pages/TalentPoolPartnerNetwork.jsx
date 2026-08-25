import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Paper,
  Stack,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Chip,
  Tooltip,
  Table,
  TableContainer,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  LinearProgress,
} from '@mui/material';
import AccessControl from '../components/AccessControl';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

// The response-breakdown chips double as the roster's filter. Each segment
// knows how to recognise its own rows so the counts and the table can never
// drift apart.
const SEGMENTS = [
  { key: 'in', label: 'Opted in', countKey: 'optedIn', color: 'success', match: (a) => a.talentPoolOptIn === true },
  { key: 'out', label: 'Opted out', countKey: 'optedOut', color: 'default', match: (a) => a.talentPoolOptIn === false },
  {
    key: 'none',
    label: 'No answer',
    countKey: 'noAnswer',
    color: 'default',
    match: (a) => a.talentPoolOptIn === null,
    hint: 'Applications submitted before the question existed, or submitted without answering it.',
  },
  { key: 'all', label: 'All', countKey: 'total', color: 'primary', match: () => true },
];

// Metrics the page is meant to show that have no source of truth yet render as
// this rather than as a zero, so an untracked metric never reads as a measured
// one. See the comment on GET /api/admin/talent-pool/stats.
function NotTrackedYet({ reason }) {
  return (
    <Tooltip title={reason}>
      <Chip label="Not tracked yet" size="small" variant="outlined" color="warning" />
    </Tooltip>
  );
}

function StatCard({ label, value, caption, untrackedReason }) {
  return (
    <Paper sx={{ p: 2, flex: 1, minWidth: 0 }}>
      <Typography variant="subtitle2" color="text.secondary" noWrap>{label}</Typography>
      <Box sx={{ mt: 0.5, mb: caption ? 0.5 : 0 }}>
        {value === null || value === undefined ? (
          <NotTrackedYet reason={untrackedReason} />
        ) : (
          <Typography variant="h4">{value}</Typography>
        )}
      </Box>
      {caption && (
        <Typography variant="body2" color="text.secondary">{caption}</Typography>
      )}
    </Paper>
  );
}

function OptInCell({ value }) {
  if (value === true) return <Chip size="small" label="Opted in" color="success" />;
  if (value === false) return <Chip size="small" label="Opted out" />;
  return <Chip size="small" label="No answer" variant="outlined" />;
}

const TalentPoolPartnerNetwork = () => {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [cycleId, setCycleId] = useState('');
  const [segment, setSegment] = useState('in');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [openingResumeId, setOpeningResumeId] = useState(null);

  const load = useCallback(async (targetCycleId) => {
    setLoading(true);
    setError('');
    try {
      const query = targetCycleId ? `?cycleId=${encodeURIComponent(targetCycleId)}` : '';
      const result = await apiClient.get(`/admin/talent-pool/stats${query}`);
      setData(result);
      setCycleId(result.selectedCycleId);
    } catch (e) {
      setError(e.message || 'Failed to load Talent Pool Partner Network data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Resume URLs point at /api/files/:id/pdf, which is JWT-protected. A plain
  // link navigates without the Authorization header and comes back
  // "Authentication required", so fetch the file as a blob and hand the tab
  // an object URL instead - the same approach the grading modals use.
  const openResume = useCallback(async (applicant) => {
    // The tab has to be opened synchronously; opening it after the await
    // reads as a popup and gets blocked.
    const tab = window.open('', '_blank');
    setOpeningResumeId(applicant.id);
    setError('');
    try {
      const resp = await fetch(applicant.resumeUrl, {
        headers: {
          Authorization: `Bearer ${token || apiClient.token || localStorage.getItem('token')}`,
        },
      });
      if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}`);
      }
      const blobUrl = URL.createObjectURL(await resp.blob());
      if (tab) {
        tab.location = blobUrl;
      } else {
        window.open(blobUrl, '_blank', 'noopener,noreferrer');
      }
      // Revoked on a delay so the new tab has finished loading it first.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (e) {
      if (tab) tab.close();
      setError(`Could not open resume for ${applicant.firstName} ${applicant.lastName}: ${e.message}`);
    } finally {
      setOpeningResumeId(null);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const optIn = data?.optIn;
  // Opt-in rate is measured against applicants who actually saw the question,
  // so cycles that predate it do not drag the percentage down.
  const answered = optIn ? optIn.optedIn + optIn.optedOut : 0;
  const optInRate = answered ? Math.round((optIn.optedIn / answered) * 100) : null;

  const activeSegment = SEGMENTS.find((s) => s.key === segment) || SEGMENTS[0];
  const inSegment = (data?.applicants || []).filter(activeSegment.match);
  const rows = inSegment.filter((a) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [a.firstName, a.lastName, a.email, a.major1, a.graduationYear]
      .filter(Boolean)
      .some((f) => String(f).toLowerCase().includes(q));
  });

  const showCycle = data?.deduplicated;

  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <Box sx={{ maxWidth: 1200, mx: 'auto', p: 0 }}>
        <Box sx={{ mb: 3 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            justifyContent="space-between"
            spacing={2}
            mb={1}
          >
            <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: 'primary.dark' }}>
              Talent Pool Partner Network
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel id="tpn-cycle-label">Cycle</InputLabel>
                <Select
                  labelId="tpn-cycle-label"
                  label="Cycle"
                  value={cycleId}
                  onChange={(e) => load(e.target.value)}
                >
                  <MenuItem value="all">All cycles</MenuItem>
                  {(data?.cycles || []).map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {c.name}{c.isActive ? ' (active)' : ''}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button variant="outlined" onClick={() => load(cycleId)} disabled={loading}>
                Refresh
              </Button>
            </Stack>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Applicants who opted in to being shared with verified partner employers for
            internship, part-time, and early-career opportunities.
          </Typography>
        </Box>

        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
        {loading && <LinearProgress sx={{ mb: 2 }} />}

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} mb={4}>
          <StatCard
            label="Opted in"
            value={optIn?.optedIn}
            caption={
              optInRate === null
                ? 'No responses yet'
                : `${optInRate}% of ${answered} who answered`
            }
          />
          <StatCard
            label="Resumes updated recently"
            value={data ? data.resumesUpdatedRecently : undefined}
            untrackedReason={
              'Applications store the resume submitted with the application and have no ' +
              '"last updated" timestamp, so there is nothing to count yet.'
            }
          />
          <StatCard
            label="Registered clients"
            value={data ? data.registeredClients : undefined}
            untrackedReason={
              'There is no client user role yet — accounts are USER, MEMBER, or ADMIN.'
            }
          />
        </Stack>

        {optIn && (
          <Paper sx={{ p: 2, mb: 4 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Response breakdown — select one to filter the list below
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {SEGMENTS.map((s) => {
                const selected = s.key === segment;
                const label = `${s.key === 'all' && data.deduplicated ? 'Unique applicants' : s.label}: ${optIn[s.countKey]}`;
                const chip = (
                  <Chip
                    key={s.key}
                    label={label}
                    color={selected ? (s.color === 'default' ? 'primary' : s.color) : 'default'}
                    variant={selected ? 'filled' : 'outlined'}
                    onClick={() => setSegment(s.key)}
                    aria-pressed={selected}
                  />
                );
                return s.hint ? <Tooltip key={s.key} title={s.hint}>{chip}</Tooltip> : chip;
              })}
            </Stack>
            {data.deduplicated && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                Showing unique people across all cycles: {data.totalApplications} applications
                collapsed to {optIn.total} applicants
                {data.duplicatesCollapsed > 0
                  ? `, keeping each person's most recent application and resume.`
                  : '.'}
              </Typography>
            )}
          </Paper>
        )}

        <Paper sx={{ p: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
            spacing={2}
            mb={2}
          >
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {activeSegment.key === 'all'
                ? `All applicants${data ? ` (${rows.length})` : ''}`
                : `${activeSegment.label}${data ? ` (${rows.length})` : ''}`}
            </Typography>
            <TextField
              size="small"
              placeholder="Search name, email, major…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ minWidth: 260 }}
            />
          </Stack>

          {loading && !data ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              {inSegment.length
                ? 'No applicants match that search.'
                : `No applicants in "${activeSegment.label}" for this cycle.`}
            </Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Major</TableCell>
                    <TableCell>Grad year</TableCell>
                    {activeSegment.key === 'all' && <TableCell>TPN</TableCell>}
                    {showCycle && <TableCell>Latest cycle</TableCell>}
                    <TableCell>Submitted</TableCell>
                    <TableCell align="right">Resume</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((a) => (
                    <TableRow key={a.id} hover>
                      <TableCell>{a.firstName} {a.lastName}</TableCell>
                      <TableCell>{a.email}</TableCell>
                      <TableCell>{a.major1 || '—'}</TableCell>
                      <TableCell>{a.graduationYear || '—'}</TableCell>
                      {activeSegment.key === 'all' && (
                        <TableCell><OptInCell value={a.talentPoolOptIn} /></TableCell>
                      )}
                      {showCycle && (
                        <TableCell>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <span>{a.cycle?.name || '—'}</span>
                            {a.priorApplications > 0 && (
                              <Tooltip
                                title={`Also applied in ${a.priorApplications} earlier ${a.priorApplications === 1 ? 'cycle' : 'cycles'}. Showing the most recent application.`}
                              >
                                <Chip size="small" variant="outlined" label={`+${a.priorApplications}`} />
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                      )}
                      <TableCell>
                        {a.submittedAt ? new Date(a.submittedAt).toLocaleDateString() : '—'}
                      </TableCell>
                      <TableCell align="right">
                        {a.resumeUrl ? (
                          <Button
                            size="small"
                            onClick={() => openResume(a)}
                            disabled={openingResumeId === a.id}
                          >
                            {openingResumeId === a.id ? 'Opening…' : 'View'}
                          </Button>
                        ) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Box>
    </AccessControl>
  );
};

export default TalentPoolPartnerNetwork;
