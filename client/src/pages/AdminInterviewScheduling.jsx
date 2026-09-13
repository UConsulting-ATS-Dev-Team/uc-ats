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
  Tooltip,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import InterviewRosterGallery from '../components/interviews/InterviewRosterGallery';
import InterviewSlotSetup from '../components/interviews/InterviewSlotSetup';

/**
 * The whole cycle's scheduling, in one place.
 *
 * Grouped by round rather than by interview, because that is how booking
 * behaves: a coffee chat day runs as two Interview rows and a candidate who
 * cannot fit in the morning is placed in the afternoon, so showing them as two
 * separate pages hides the thing an admin most needs to see.
 */

/** One number and what it means. Reads as a sentence, not a dashboard tile. */
function Stat({ label, value, tone, hint }) {
  const chip = (
    <Chip
      size="small"
      color={tone}
      variant={tone ? 'filled' : 'outlined'}
      label={`${value} ${label}`}
      sx={{ fontWeight: 600 }}
    />
  );
  return hint ? <Tooltip title={hint}>{chip}</Tooltip> : chip;
}

export default function AdminInterviewScheduling() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [tab, setTab] = useState(0);
  const [setupFor, setSetupFor] = useState(null);

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await apiClient.get('/admin/scheduling/overview'));
    } catch (e) {
      setError(e.message || 'Failed to load scheduling.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rounds = data?.rounds ?? [];
  const active = rounds[tab] ?? null;

  // The gallery takes one roster. A round's sessions may span sibling
  // interviews, and merging them here is what makes morning and afternoon sit
  // side by side instead of on two different screens.
  const roster = useMemo(
    () => (active ? { interview: { id: active.round, title: active.label }, slots: active.slots, unassigned: active.unassigned } : null),
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
      if (result.promoted > 0) {
        setToast(`Moved. ${result.promoted} promoted off the waitlist.`);
      }
      return result;
    }).catch(() => {});

  const handleRemove = (signup) => {
    const name = `${signup.candidate?.firstName ?? ''} ${signup.candidate?.lastName ?? ''}`.trim();
    if (!window.confirm(`Remove ${name} from this round?`)) return Promise.resolve();
    return run(
      () => apiClient.delete(`/admin/interviews/slot-signups/${signup.id}`),
      'Removed.'
    ).catch(() => {});
  };

  const handlePlace = (application) => {
    const slots = active?.slots?.filter((s) => s.isBookable) ?? [];
    if (slots.length === 0) {
      setError('There are no bookable sessions in this round yet. Add some first.');
      return Promise.resolve();
    }
    const target =
      slots.find(
        (s) => s.candidateCapacity == null || s.confirmedCount < s.candidateCapacity
      ) ?? slots[0];
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
    <AccessControl allowedRoles={['ADMIN']}>
      <Container maxWidth={false} sx={{ py: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
          <Box>
            <Typography variant="h4">Interview Scheduling</Typography>
            <Typography variant="body2" color="text.secondary">
              {data?.cycle?.name ?? 'No active cycle'} — every session, who is in it, and who still needs a time.
            </Typography>
          </Box>
          <Button onClick={load} disabled={busy}>
            Refresh
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {/* Stated plainly rather than hidden in config: the most confusing thing
            possible is a candidate booking and nobody hearing about it. */}
        {data && !data.emailsEnabled && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Scheduling emails are <strong>switched off</strong>. Bookings work normally and everything
            is recorded, but nobody is being emailed
            {suppressed > 0 ? ` — ${suppressed} message${suppressed === 1 ? '' : 's'} held so far` : ''}.
            Set <code>SCHEDULING_EMAILS=on</code> to turn them on.
          </Alert>
        )}
        {failed > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {failed} scheduling email{failed === 1 ? '' : 's'} failed to send.
          </Alert>
        )}

        {rounds.length === 0 && (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>
              No interviews to schedule
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Create a Coffee Chat or First Round interview for this cycle, then set up its sessions here.
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

                <InterviewRosterGallery
                  roster={roster}
                  busy={busy}
                  onMove={handleMove}
                  onRemove={handleRemove}
                  onPlace={handlePlace}
                />
              </>
            )}
          </>
        )}

        <Snackbar open={Boolean(toast)} autoHideDuration={5000} onClose={() => setToast('')} message={toast} />
      </Container>
    </AccessControl>
  );
}
