import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
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
import InterviewerCoverage from '../components/interviews/InterviewerCoverage';

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
  const [assignFor, setAssignFor] = useState(null);
  const [staff, setStaff] = useState([]);

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

  // Loaded once, lazily: the assign picker is the only thing that needs it.
  const openAssign = async (slot) => {
    setAssignFor(slot);
    if (staff.length === 0) {
      try {
        setStaff(await apiClient.get('/admin/interviews/staff'));
      } catch {
        setStaff([]);
      }
    }
  };

  const assignInterviewer = (userId) =>
    run(
      () => apiClient.post(`/admin/interviews/slots/${assignFor.id}/interviewers`, { userId }),
      'Assigned.'
    )
      .then(() => setAssignFor(null))
      .catch(() => {});

  const setGroupSize = (slot, value) =>
    run(
      () =>
        apiClient.patch(`/admin/interviews/slots/${slot.id}`, {
          groupSize: value === '' ? null : Number(value),
        }),
      value === '' ? 'Grouping turned off.' : `Groups of ${value}.`
    ).catch(() => {});

  // Rebalancing renumbers everyone, so it is a button rather than something
  // that happens on its own. Labels are what candidates are told.
  const regroup = (slot) => {
    if (
      !window.confirm(
        'Rebalance this session into fresh groups? Everyone gets a new label, so do not do this once candidates have been told theirs.'
      )
    ) {
      return Promise.resolve();
    }
    return run(() => apiClient.post(`/admin/interviews/slots/${slot.id}/groups`, {}), 'Regrouped.').catch(() => {});
  };

  // "She is on the morning waitlist and I want her in the morning" - which the
  // move action cannot express, because her row is already on that session.
  const promote = (signup) => {
    const name = `${signup.candidate?.firstName ?? ''} ${signup.candidate?.lastName ?? ''}`.trim();
    return run(
      () => apiClient.post(`/admin/interviews/slot-signups/${signup.id}/promote`, {}),
      `${name} moved off the waitlist.`
    ).catch((e) => {
      if (!String(e?.message ?? '').includes('OVER_CAPACITY')) return;
      if (!window.confirm(`That session is already full. Give ${name} a place anyway?`)) return;
      return run(
        () => apiClient.post(`/admin/interviews/slot-signups/${signup.id}/promote`, { force: true }),
        `${name} added over capacity.`
      ).catch(() => {});
    });
  };

  const changeGroup = (signup) => {
    const next = window.prompt(
      `Group for ${signup.candidate?.firstName ?? 'this candidate'} — a number and a letter, like 1A. Leave blank to remove them from a group.`,
      signup.groupLabel ?? ''
    );
    if (next === null) return Promise.resolve();
    return run(
      () => apiClient.patch(`/admin/interviews/slot-signups/${signup.id}/group`, { groupLabel: next }),
      'Group updated.'
    ).catch(() => {});
  };

  const removeInterviewer = (interviewer) =>
    run(() => apiClient.delete(`/admin/interviews/slot-assignments/${interviewer.id}`), 'Removed.').catch(() => {});

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

        {/* Interviewer: exactly what a UC member sees, no admin chrome. An
            admin conducting an interview is a member conducting an interview,
            so the start-interview flow is the same page rather than a second
            implementation that can drift from it. */}
        {mode === 'interviewer' && (
          <>
            <Alert
              severity="info"
              sx={{ mb: 2 }}
              action={
                <Button size="small" component={RouterLink} to="/assigned-interviews">
                  Go to my interviews
                </Button>
              }
            >
              To run an interview and fill in evaluations, use <strong>My Interviews</strong> — pick the
              groups you are interviewing and the evaluation module opens.
            </Alert>
            <InterviewStaffingSignup />
          </>
        )}

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

                    {/* The invariant recruitment works to: every advancing
                        candidate gets a seat. Checked here rather than
                        discovered by the candidate who finds nothing left. */}
                    {active.interviews.length > 0 && active.stats.bookableSessions > 0 && active.stats.seats < active.stats.eligible && (
                      <Alert severity="error" sx={{ mb: 2 }}>
                        <AlertTitle>Not enough seats for this round</AlertTitle>
                        {active.stats.seats} seat{active.stats.seats === 1 ? '' : 's'} across{' '}
                        {active.stats.bookableSessions} open session
                        {active.stats.bookableSessions === 1 ? '' : 's'}, but{' '}
                        <strong>{active.stats.eligible} candidates</strong> are in this round.{' '}
                        {active.stats.eligible - active.stats.seats} will have nowhere to book and will be
                        told recruitment has been notified. Add sessions or raise the seat counts before
                        sending the decision emails.
                      </Alert>
                    )}
                    {active.interviews.length > 0 &&
                      active.stats.bookableSessions > 0 &&
                      active.stats.seats >= active.stats.eligible &&
                      active.stats.eligible > 0 && (
                        <Alert severity="success" sx={{ mb: 2 }} icon={false}>
                          <strong>Everyone fits.</strong> {active.stats.seats} seats for{' '}
                          {active.stats.eligible} candidates. Nobody will be left without a session —
                          a full first choice just means a spot in another one plus a place on its
                          waitlist.
                        </Alert>
                      )}

                    {active.interviews.length > 0 && active.stats.bookableSessions === 0 && active.stats.sessions > 0 && (
                      <Alert severity="warning" sx={{ mb: 2 }}>
                        This round has {active.stats.sessions} session{active.stats.sessions === 1 ? '' : 's'} but{' '}
                        <strong>none are open to candidates</strong> — they came from last cycle's groups and have no
                        seat count. Add sessions with capacity before opening signup.
                      </Alert>
                    )}

                    {/* A round with no interview yet is the normal state early
                        in a cycle, not an error. Offer the thing to do next. */}
                    {active.interviews.length === 0 && (
                      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', mb: 2 }}>
                        <Typography variant="h6" gutterBottom>
                          No {active.label.toLowerCase()} yet
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          {active.stats.eligible > 0
                            ? `${active.stats.eligible} candidate${active.stats.eligible === 1 ? ' is' : 's are'} already in this round.`
                            : 'Nobody is in this round yet, but you can set it up now.'}{' '}
                          Create the interview and its sessions, and candidates will be able to book when
                          they reach it.
                        </Typography>
                        <Button variant="contained" onClick={() => setView('manage')}>
                          Create the interview
                        </Button>
                      </Paper>
                    )}

                    {active.interviews.length > 0 && active.stats.sessions === 0 && (
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
                      <Tab value="interviewers" label="Interviewers" />
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
                        onAssignInterviewer={openAssign}
                        onRemoveInterviewer={removeInterviewer}
                        selfService={active.stats.bookableSessions > 0}
                        onChangeGroup={changeGroup}
                        onPromote={promote}
                        onSetGroupSize={setGroupSize}
                        onRegroup={regroup}
                      />
                    )}
                    {view === 'interviewers' &&
                      (active.interviews.length === 0 ? (
                        <Alert severity="info">
                          Create the interview first — availability is collected against it, and there is
                          nothing to collect against yet.
                        </Alert>
                      ) : (
                        <Stack spacing={3}>
                          {active.interviews.map((interview) => (
                            <Box key={interview.id}>
                              {active.interviews.length > 1 && (
                                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                  {interview.title}
                                </Typography>
                              )}
                              <InterviewerCoverage interviewId={interview.id} onChanged={load} />
                            </Box>
                          ))}
                        </Stack>
                      ))}
                    {view === 'candidate' && <CandidateSchedulingPreview />}
                    {view === 'manage' && <InterviewManageList cycle={data?.cycle} onChanged={load} />}
                  </>
                )}
              </>
            )}

            {rounds.length === 0 && <InterviewManageList cycle={data?.cycle} onChanged={load} />}
          </>
        )}

        {/* Who runs a session. For first round this is the whole point: an
            interviewer assigned here sees these candidates and no others. */}
        <Dialog open={Boolean(assignFor)} onClose={() => setAssignFor(null)} fullWidth maxWidth="xs">
          <DialogTitle>Assign an interviewer</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {assignFor?.label || 'This session'} — they will see only the candidates in the sessions
              they are on.
            </Typography>
            <List dense>
              {staff
                .filter((person) => !(assignFor?.interviewers ?? []).some((i) => i.user.id === person.id))
                .map((person) => (
                  <ListItemButton key={person.id} onClick={() => assignInterviewer(person.id)}>
                    <ListItemText primary={person.fullName} secondary={person.role} />
                  </ListItemButton>
                ))}
            </List>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAssignFor(null)}>Close</Button>
          </DialogActions>
        </Dialog>

        <Snackbar open={Boolean(toast)} autoHideDuration={5000} onClose={() => setToast('')} message={toast} />
      </Container>
    </AccessControl>
  );
}
