import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AdminPanelSettings as AdminIcon,
  RecordVoiceOver as InterviewerIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import InterviewRosterGallery from '../components/interviews/InterviewRosterGallery';
import InterviewSlotSetup from '../components/interviews/InterviewSlotSetup';
import CandidateSchedulingPreview from '../components/interviews/CandidateSchedulingPreview';
import InterviewStaffingSignup from '../components/interviews/InterviewStaffingSignup';
import InterviewManageList from '../components/interviews/InterviewManageList';

/**
 * Interviews - one page, two jobs.
 *
 * This used to be two pages that both showed rosters, which left a permanent
 * "which one do I use" question. The split that actually matters is not
 * scheduling versus running, it is which hat you are wearing: an admin runs the
 * round, and the same person also sits in interviews like everyone else.
 *
 * So there is one page with a toggle. Admin is the whole round - sessions,
 * rosters, waitlists, what candidates see. Interviewer is what a UC member
 * sees - the sessions you can staff and the ones you are on.
 *
 * Members only ever get the interviewer half; the toggle is not offered to them.
 */

const MODE_KEY = 'uc-ats:interviews-mode';

/** One number and what it means. Reads as a sentence, not a dashboard tile. */
function Stat({ label, value, tone, hint }) {
  const chip = (
    <Chip size="small" color={tone} variant={tone ? 'filled' : 'outlined'} label={`${value} ${label}`} sx={{ fontWeight: 600 }} />
  );
  return hint ? <Tooltip title={hint}>{chip}</Tooltip> : chip;
}

export default function AdminInterviews() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [mode, setMode] = useState(() => {
    if (!isAdmin) return 'interviewer';
    try {
      return window.localStorage.getItem(MODE_KEY) || 'admin';
    } catch {
      return 'admin';
    }
  });

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [tab, setTab] = useState(0);
  const [view, setView] = useState('sessions');
  const [setupFor, setSetupFor] = useState(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Remembering the last hat is a convenience, not a requirement.
    }
  }, [mode]);

  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    try {
      setError('');
      setData(await apiClient.get('/admin/scheduling/overview'));
    } catch (e) {
      setError(e.message || 'Failed to load interviews.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const rounds = data?.rounds ?? [];
  const active = rounds[tab] ?? null;

  // The gallery takes one roster. A round's sessions may span sibling
  // interviews, and merging them here is what puts morning and afternoon side
  // by side instead of on two different screens.
  const roster = useMemo(
    () =>
      active
        ? { interview: { id: active.round, title: active.label }, slots: active.slots, unassigned: active.unassigned }
        : null,
    [active]
  );

  const run = async (fn, successMessage) => {
    setBusy(true);
    setError('');
    try {
      const result = await fn();
      if (successMessage) setToast(successMessage);
      await load();
      return result;
    } catch (e) {
      setError(e.message || 'That did not go through.');
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleMove = (signup, slot, { force = false } = {}) =>
    run(async () => {
      const result = await apiClient.post(`/admin/interviews/slot-signups/${signup.id}/move`, {
        toSlotId: slot.id,
        force,
      });
      if (result.promoted > 0) setToast(`Moved. ${result.promoted} promoted off the waitlist.`);
      return result;
    }).catch(() => {});

  const handleRemove = (signup) => {
    const name = `${signup.candidate?.firstName ?? ''} ${signup.candidate?.lastName ?? ''}`.trim();
    if (!window.confirm(`Remove ${name} from this round?`)) return Promise.resolve();
    return run(() => apiClient.delete(`/admin/interviews/slot-signups/${signup.id}`), 'Removed.').catch(() => {});
  };

  const handlePlace = (application) => {
    const slots = active?.slots?.filter((s) => s.isBookable) ?? [];
    if (slots.length === 0) {
      setError('There are no bookable sessions in this round yet. Add some first.');
      return Promise.resolve();
    }
    const target = slots.find((s) => s.candidateCapacity == null || s.confirmedCount < s.candidateCapacity) ?? slots[0];
    return run(
      () =>
        apiClient.post(`/admin/interviews/${target.interviewId}/slot-signups`, {
          slotId: target.id,
          applicationId: application.id,
          force: true,
        }),
      'Scheduled.'
    ).catch(() => {});
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const suppressed = data?.notifications?.SUPPRESSED ?? 0;
  const failed = data?.notifications?.FAILED ?? 0;

  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Container maxWidth={false} sx={{ py: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h4">Interviews</Typography>
            <Typography variant="body2" color="text.secondary">
              {mode === 'admin'
                ? `${data?.cycle?.name ?? 'No active cycle'} — every session, who is in it, and who still needs a time.`
                : 'The sessions you can run, and the ones you are on.'}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            {isAdmin && (
              <ToggleButtonGroup
                exclusive
                size="small"
                value={mode}
                onChange={(e, next) => next && setMode(next)}
              >
                <ToggleButton value="admin">
                  <AdminIcon fontSize="small" sx={{ mr: 0.5 }} /> Admin
                </ToggleButton>
                <ToggleButton value="interviewer">
                  <InterviewerIcon fontSize="small" sx={{ mr: 0.5 }} /> Interviewer
                </ToggleButton>
              </ToggleButtonGroup>
            )}
            {mode === 'admin' && (
              <Button onClick={load} disabled={busy}>
                Refresh
              </Button>
            )}
          </Stack>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {/* Interviewer: exactly what a UC member sees, no admin chrome. */}
        {mode === 'interviewer' && <InterviewStaffingSignup />}

        {mode === 'admin' && (
          <>
            {/* Stated plainly rather than hidden in config: the most confusing
                thing possible is a candidate booking and nobody hearing. */}
            {data && !data.emailsEnabled && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Scheduling emails are <strong>switched off</strong>. Bookings work normally and everything is
                recorded, but nobody is being emailed
                {suppressed > 0 ? ` — ${suppressed} message${suppressed === 1 ? '' : 's'} held so far` : ''}. Set{' '}
                <code>SCHEDULING_EMAILS=on</code> to turn them on.
              </Alert>
            )}
            {failed > 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {failed} scheduling email{failed === 1 ? '' : 's'} failed to send.
              </Alert>
            )}

            {rounds.length === 0 && (
              <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', mb: 3 }}>
                <Typography variant="h6" gutterBottom>
                  No interviews in this cycle yet
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Create one below, then add the sessions candidates book into.
                </Typography>
              </Paper>
            )}

            {rounds.length > 0 && (
              <>
                <Tabs value={tab} onChange={(e, next) => setTab(next)} sx={{ mb: 2 }}>
                  {rounds.map((round) => (
                    <Tab
                      key={round.round}
                      label={
                        <Stack direction="row" spacing={1} alignItems="center">
                          <span>{round.label}</span>
                          {round.stats.needsPlacement > 0 && (
                            <Chip size="small" color="error" label={round.stats.needsPlacement} />
                          )}
                        </Stack>
                      }
                    />
                  ))}
                </Tabs>

                {active && (
                  <>
                    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
                        <Stat label="in this round" value={active.stats.eligible} hint="Candidates whose current round is this one" />
                        <Stat label="scheduled" value={active.stats.confirmed} tone="success" />
                        <Stat
                          label="not scheduled"
                          value={active.stats.unassigned}
                          tone={active.stats.unassigned > 0 ? 'warning' : undefined}
                          hint="In this round, but holding no session"
                        />
                        <Stat label="waitlisted" value={active.stats.waitlisted} hint="Queued for a preferred session, holding another" />
                        {active.stats.needsPlacement > 0 && (
                          <Stat label="need placing" value={active.stats.needsPlacement} tone="error" hint="Signed up when everything was full" />
                        )}
                        <Stat label="seats" value={active.stats.seats} hint="Total capacity across bookable sessions" />
                        <Stat label="sessions" value={active.stats.sessions} />
                        <Stat label="interviewers" value={active.stats.interviewers} />
                      </Stack>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          {active.interviews.length === 1 ? 'Interview:' : 'Interviews in this round:'}
                        </Typography>
                        {active.interviews.map((interview) => (
                          <Chip
                            key={interview.id}
                            size="small"
                            variant="outlined"
                            label={interview.title}
                            onClick={() => setSetupFor(setupFor === interview.id ? null : interview.id)}
                          />
                        ))}
                        <Typography variant="caption" color="text.secondary">
                          (click one to add sessions)
                        </Typography>
                      </Stack>
                    </Paper>

                    {active.stats.bookableSessions === 0 && active.stats.sessions > 0 && (
                      <Alert severity="warning" sx={{ mb: 2 }}>
                        This round has {active.stats.sessions} session{active.stats.sessions === 1 ? '' : 's'} but{' '}
                        <strong>none are open to candidates</strong> — they came from last cycle's groups and have no
                        seat count. Add sessions with capacity before opening signup.
                      </Alert>
                    )}

                    {active.stats.sessions === 0 && (
                      <Alert
                        severity="info"
                        sx={{ mb: 2 }}
                        action={
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              Promise.all(
                                active.interviews.map((i) =>
                                  apiClient.post(`/admin/interviews/${i.id}/adopt-sessions`, {}).catch(() => null)
                                )
                              ).then(() => load())
                            }
                          >
                            Convert groups
                          </Button>
                        }
                      >
                        This round has no sessions. If it was scheduled with the old group editor, convert those
                        groups into sessions to manage it here.
                      </Alert>
                    )}

                    {setupFor && (
                      <Box sx={{ mb: 3 }}>
                        <InterviewSlotSetup
                          interviewId={setupFor}
                          interviewType={active.interviewType}
                          onCreated={() => {
                            setSetupFor(null);
                            load();
                          }}
                        />
                      </Box>
                    )}

                    <Tabs value={view} onChange={(e, next) => setView(next)} sx={{ mb: 2 }}>
                      <Tab value="sessions" label="Sessions" />
                      <Tab value="candidate" label="Candidate view" />
                      <Tab value="manage" label="Manage interviews" />
                    </Tabs>

                    {view === 'sessions' && (
                      <InterviewRosterGallery
                        roster={roster}
                        busy={busy}
                        onMove={handleMove}
                        onRemove={handleRemove}
                        onPlace={handlePlace}
                      />
                    )}
                    {view === 'candidate' && <CandidateSchedulingPreview />}
                    {view === 'manage' && <InterviewManageList cycle={data?.cycle} onChanged={load} />}
                  </>
                )}
              </>
            )}

            {rounds.length === 0 && <InterviewManageList cycle={data?.cycle} onChanged={load} />}
          </>
        )}

        <Snackbar open={Boolean(toast)} autoHideDuration={5000} onClose={() => setToast('')} message={toast} />
      </Container>
    </AccessControl>
  );
}
