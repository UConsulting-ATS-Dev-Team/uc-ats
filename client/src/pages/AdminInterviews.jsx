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
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Check as CheckIcon,
  CheckCircle as CheckCircleIcon,
  ContentCopy as CopyIcon,
  ErrorOutline as ErrorIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';
import AccessControl from '../components/AccessControl';
import InterviewRosterGallery from '../components/interviews/InterviewRosterGallery';
import InterviewCreateDialog from '../components/interviews/InterviewCreateDialog';
import InterviewStaffingSignup from '../components/interviews/InterviewStaffingSignup';
import InterviewManageList from '../components/interviews/InterviewManageList';
import InterviewerCoverage from '../components/interviews/InterviewerCoverage';

/**
 * Interviews - one page, two audiences.
 *
 * This used to be two pages that both showed rosters, which left a permanent
 * "which one do I use" question. What you get here follows from your role
 * rather than from a control: an admin sees the whole round - sessions,
 * rosters, waitlists, what candidates see - and a member sees the staffing
 * half, the sessions they can run.
 *
 * An admin who wants to staff a session does it where every member does, on
 * Interview RSVP; this page no longer offers a second way in.
 */

/**
 * Whether the round is ready, as one line: who is in it, what they can book,
 * and whether that is enough. The booking counts appear only once there is
 * something to count, so a round being set up is not a row of zeros.
 */
function RoundReadiness({ stats }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const fits = stats.bookableSessions > 0 && stats.eligible > 0 && stats.seats >= stats.eligible;
  const short = stats.bookableSessions > 0 && stats.seats < stats.eligible;

  const booking = [
    { value: stats.confirmed, label: 'scheduled', color: 'success' },
    { value: stats.unassigned, label: 'not scheduled', color: 'warning', hint: 'In this round, but holding no session' },
    { value: stats.waitlisted, label: 'waitlisted', hint: 'Queued for a preferred session, holding another' },
    { value: stats.needsPlacement, label: 'need placing', color: 'error', hint: 'Signed up when everything was full' },
  ].filter((item) => item.value > 0);

  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="body2" data-testid="round-readiness">
          <strong>{stats.eligible}</strong> in this round · <strong>{stats.seats}</strong> seats in{' '}
          {plural(stats.bookableSessions, 'open session')} · {plural(stats.interviewers, 'interviewer')}
        </Typography>
        {fits && (
          <Chip size="small" color="success" variant="outlined" icon={<CheckCircleIcon />} label="Everyone fits" />
        )}
        {short && (
          <Chip
            size="small"
            color="error"
            variant="outlined"
            icon={<ErrorIcon />}
            label={`${stats.eligible - stats.seats} short`}
          />
        )}
      </Stack>
      {booking.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {booking.map((item) => {
            const chip = (
              <Chip size="small" color={item.color} variant="outlined" label={`${item.value} ${item.label}`} />
            );
            return item.hint ? (
              <Tooltip key={item.label} title={item.hint}>
                {chip}
              </Tooltip>
            ) : (
              <React.Fragment key={item.label}>{chip}</React.Fragment>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Where a candidate books their own time.
 *
 * The same URL the decision emails carry: no round, no token, no per-candidate
 * anything. The page is behind the candidate login and works out which round
 * they are in from their own application, so one link serves everybody and
 * pasting it to somebody who lost their email is safe.
 */
const SIGNUP_URL = `${window.location.origin}/interview-signup`;

export default function AdminInterviews() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const mode = isAdmin ? 'admin' : 'interviewer';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState(0);
  const [view, setView] = useState('sessions');
  const [createOpen, setCreateOpen] = useState(false);
  const [assignFor, setAssignFor] = useState(null);
  const [staff, setStaff] = useState([]);

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

  // The same link the decision emails carry. Candidates sign in and the page
  // works out which round they are in, so there is nothing per-person to build -
  // which is exactly what makes it safe to paste to anyone who says they never
  // got the email.
  // The tooltip carries describeChild so it becomes aria-describedby rather
  // than the button's accessible name - without it a screen reader announces a
  // bare URL instead of what the control does.
  const copySignupLink = async () => {
    try {
      await navigator.clipboard.writeText(SIGNUP_URL);
    } catch {
      // Clipboard is blocked outside a secure context, and on a scheduling page
      // "nothing happened" is worse than a prompt to copy by hand.
      window.prompt('Copy this link:', SIGNUP_URL);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
            {mode === 'admin' && (
              <Tooltip title={SIGNUP_URL} describeChild>
                <Button
                  startIcon={copied ? <CheckIcon /> : <CopyIcon />}
                  color={copied ? 'success' : 'primary'}
                  onClick={copySignupLink}
                >
                  {copied ? 'Copied' : 'Copy signup link'}
                </Button>
              </Tooltip>
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

        {/* What a UC member gets here: staffing signup, no admin chrome.
            Same component the Interview RSVP page renders, so the two cannot
            drift apart. */}
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
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Create one, then add the sessions candidates book into.
                </Typography>
                <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
                  New interview
                </Button>
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

                {/* A round with no interview yet is the normal state early
                    in a cycle, not an error. One message and the thing to do
                    next; the stats, tabs and gallery would all be empty too. */}
                {active && active.interviews.length === 0 && (
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
                    <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
                      Create the interview
                    </Button>
                  </Paper>
                )}

                {active && active.interviews.length > 0 && (
                  <>
                    {/* Setting up the round, in one place: whether everyone
                        fits, and each interview with what you do to it. */}
                    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                      <Stack
                        direction={{ xs: 'column', md: 'row' }}
                        justifyContent="space-between"
                        alignItems={{ xs: 'flex-start', md: 'center' }}
                        spacing={1}
                      >
                        <RoundReadiness stats={active.stats} />
                        <Button startIcon={<AddIcon />} onClick={() => setCreateOpen(true)} sx={{ flexShrink: 0 }}>
                          New interview
                        </Button>
                      </Stack>
                      <Divider sx={{ mt: 1.5 }} />
                      <InterviewManageList round={active} onChanged={load} />
                    </Paper>

                    {/* The invariant recruitment works to: every advancing
                        candidate gets a seat. Checked here rather than
                        discovered by the candidate who finds nothing left. */}
                    {active.stats.bookableSessions > 0 && active.stats.seats < active.stats.eligible && (
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
                        This round has no sessions. Add some above, or, if it was scheduled with the old group
                        editor, convert those groups into sessions to manage them here.
                      </Alert>
                    )}

                    <Tabs value={view} onChange={(e, next) => setView(next)} sx={{ mb: 2 }}>
                      <Tab value="sessions" label="Sessions" />
                      <Tab value="interviewers" label="Interviewers" />
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
                    {view === 'interviewers' && (
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
                    )}
                  </>
                )}
              </>
            )}

            <InterviewCreateDialog
              open={createOpen}
              defaultType={active?.interviewType ?? undefined}
              onClose={() => setCreateOpen(false)}
              onCreated={() => {
                setCreateOpen(false);
                load();
              }}
            />
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
