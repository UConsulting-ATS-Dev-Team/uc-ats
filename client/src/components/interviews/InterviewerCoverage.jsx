import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Sms as SmsIcon, Warning as WarningIcon } from '@mui/icons-material';
import apiClient from '../../utils/api';
import { useAuth } from '../../context/AuthContext';
import { formatTime, formatTimeRange } from '../../utils/scheduleFormat';
import ImessageSendDialog from '../communications/ImessageSendDialog';

/**
 * Who can interview when, and what that means for the day.
 *
 * The grid answers the question that has to come first: how many panels can run
 * at 10:00. Until that is known there is no way to decide whether first round
 * needs one room at a time or four, and building the schedule first means
 * discovering the answer when somebody does not turn up.
 *
 * Placement sits underneath. It offers the people who said they could make that
 * time first, because that is usually the right answer - but never only those
 * people. Availability ranks the list; it does not decide who is on it. Plenty
 * of real placements come from somebody saying yes in a meeting, and a picker
 * that cannot express that sends admins back to the spreadsheet.
 */

const fullName = (u) => u?.fullName ?? 'Unknown';

/** How a coverage hour reads at a glance: enough, thin, or nobody. */
const toneFor = (row, wanted) => {
  if (row.availableInterviewers === 0) return { color: 'error', label: 'nobody' };
  if (row.possibleSessions === 0) return { color: 'warning', label: 'not enough for a panel' };
  if (wanted && row.possibleSessions < wanted) return { color: 'warning', label: `${row.possibleSessions} panel${row.possibleSessions === 1 ? '' : 's'}` };
  return { color: 'success', label: `${row.possibleSessions} panel${row.possibleSessions === 1 ? '' : 's'}` };
};

export default function InterviewerCoverage({ interviewId, onChanged }) {
  const [data, setData] = useState(null);
  const [minutes, setMinutes] = useState(60);
  const [per, setPer] = useState(2);
  const [wanted, setWanted] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState('');
  const [moving, setMoving] = useState(null);
  // The session whose interviewers are being messaged, if any.
  const [texting, setTexting] = useState(null);
  // /admin/interviews is reachable by MEMBER, but both iMessage endpoints are
  // requireAdmin. Without this the button opens a dialog that 403s.
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await apiClient.get(`/admin/interviews/${interviewId}/availability?minutes=${minutes}&per=${per}`));
    } catch (e) {
      setError(e.message || 'Failed to load availability.');
    } finally {
      setLoading(false);
    }
  }, [interviewId, minutes, per]);

  useEffect(() => {
    load();
  }, [load]);

  // Defaults to chasing only the people who have not answered, so pressing it
  // twice does not nag everybody who already did their bit.
  const askForAvailability = async (everyone) => {
    setBusy(true);
    setError('');
    setAsked('');
    try {
      const result = await apiClient.post(`/admin/interviews/${interviewId}/request-availability`, { everyone });
      setAsked(
        result.queued === 0
          ? result.message || 'Nobody to email.'
          : `Asked ${result.queued} ${result.queued === 1 ? 'person' : 'people'}.` +
            (result.emailsEnabled === false ? ' Scheduling emails are switched off, so these are being held.' : '')
      );
      await load();
    } catch (e) {
      setError(e.message || 'Failed to send that request.');
    } finally {
      setBusy(false);
    }
  };

  const place = async (slotId, userId) => {
    setBusy(true);
    setError('');
    try {
      await apiClient.post(`/admin/interviews/slots/${slotId}/interviewers`, { userId });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to place that interviewer.');
    } finally {
      setBusy(false);
    }
  };

  const move = async (assignmentId, slotId) => {
    setBusy(true);
    setError('');
    setAsked('');
    try {
      const result = await apiClient.post(`/admin/interviews/slot-assignments/${assignmentId}/move`, { slotId });
      // Double-booking is allowed - an admin may know something we do not - but
      // it is never silent.
      if (result.clash) {
        setAsked(
          `Moved. Heads up: they are also on ${result.clash.label || formatTimeRange(result.clash.startTime, result.clash.endTime)}, which overlaps.`
        );
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to move that interviewer.');
    } finally {
      setBusy(false);
      setMoving(null);
    }
  };

  const remove = async (assignmentId) => {
    setBusy(true);
    try {
      await apiClient.delete(`/admin/interviews/slot-assignments/${assignmentId}`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to remove that interviewer.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }
  if (!data) return null;

  const nobodyYet = data.interviewers.length === 0;
  // A coffee chat runs as named sittings that everybody rotates through, so
  // "how many panels could run at 10:00" is not a question about it. Sizing the
  // day that way belongs to first round, where sessions are small and parallel.
  const sizesTheDay = data.interview.interviewType !== 'COFFEE_CHAT';
  // Coverage rows carry user ids; names live on the roster. One lookup rather
  // than a find() per person per hour.
  const byId = new Map((data.staff ?? []).map((u) => [u.id, u]));
  const conflicts = (data.placements ?? []).filter((p) => p.conflict === 'OUTSIDE_AVAILABILITY');

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Button variant="contained" size="small" disabled={busy} onClick={() => askForAvailability(false)}>
          Ask members for availability
        </Button>
        {data.interviewers.length > 0 && (
          <Button size="small" disabled={busy} onClick={() => askForAvailability(true)}>
            Ask everyone again
          </Button>
        )}
        {asked && (
          <Typography variant="caption" color="text.secondary">
            {asked}
          </Typography>
        )}
      </Stack>

      {nobodyYet && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>Nobody has said when they are free yet.</strong> Send the request above; members fill it
          in from My Interviews. You can still place anyone onto a session in the meantime — availability
          only decides who gets suggested first.
        </Alert>
      )}

      {sizesTheDay && (
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="subtitle2">If sessions were</Typography>
        <TextField
          size="small"
          select
          label="this long"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          sx={{ width: 140 }}
        >
          {[20, 30, 45, 60, 90].map((m) => (
            <MenuItem key={m} value={m}>
              {m} minutes
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          select
          label="with this many interviewers"
          value={per}
          onChange={(e) => setPer(Number(e.target.value))}
          sx={{ width: 210 }}
        >
          {[1, 2, 3, 4].map((n) => (
            <MenuItem key={n} value={n}>
              {n} each
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          type="number"
          label="panels you want"
          value={wanted}
          onChange={(e) => setWanted(e.target.value)}
          sx={{ width: 150 }}
          helperText="optional"
        />
      </Stack>
      )}

      {/* The hour, and who is in it.
          This is where first round gets built: recruitment reads an hour, sees
          who said they can be there, and drops those people into the groups
          sitting at that hour. Names, not a headcount - "6 free" cannot be
          acted on, and an admin who has to cross-reference a number against a
          list further down the page is back to doing it on paper. */}
      {sizesTheDay && (
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="overline" color="text.secondary">
          Who is free, hour by hour
        </Typography>
        {data.coverage.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This interview has no time range to lay out yet.
          </Typography>
        ) : (
          <Stack spacing={1.25} sx={{ mt: 1.5 }}>
            {data.coverage.map((row) => {
              const tone = toneFor(row, Number(wanted) || null);
              // The groups sitting in this hour. A group counts as in the hour
              // if it overlaps it at all, so a 90-minute group shows up in both
              // hours it touches rather than falling between them.
              const groupsHere = data.sessions.filter(
                (session) =>
                  new Date(session.startTime) < new Date(row.endTime) &&
                  new Date(session.endTime) > new Date(row.startTime)
              );
              const free = (row.userIds ?? []).map(
                (id) => byId.get(id) ?? { id, fullName: 'Unknown' }
              );

              return (
                <Paper
                  key={row.startTime}
                  variant="outlined"
                  sx={{ p: 1.5, borderColor: `${tone.color}.main`, borderWidth: tone.color === 'success' ? 1 : 2 }}
                >
                  <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1 }}>
                    <Typography variant="body2" fontWeight={700}>
                      {formatTime(row.startTime)} – {formatTime(row.endTime)}
                    </Typography>
                    <Typography variant="caption" color={`${tone.color}.main`}>
                      {row.availableInterviewers} free · {tone.label}
                    </Typography>
                  </Stack>

                  {free.length === 0 ? (
                    <Typography variant="caption" color="text.secondary">
                      Nobody has said they can make this hour.
                    </Typography>
                  ) : groupsHere.length === 0 ? (
                    <>
                      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 0.75 }}>
                        {free.map((u) => (
                          <Chip key={u.id} size="small" variant="outlined" label={fullName(u)} />
                        ))}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        No groups at this hour yet — add one under Sessions, then place these people into it.
                      </Typography>
                    </>
                  ) : (
                    <Stack spacing={0.5}>
                      {free.map((u) => {
                        // Where this person already is in this hour, if anywhere.
                        const already = groupsHere.find((session) =>
                          session.assigned.some((a) => a.id === u.id)
                        );
                        return (
                          <Stack
                            key={u.id}
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ flexWrap: 'wrap', gap: 0.5 }}
                          >
                            <Typography variant="body2" sx={{ minWidth: 170 }}>
                              {fullName(u)}
                            </Typography>
                            {already ? (
                              <Chip
                                size="small"
                                color="success"
                                variant="outlined"
                                label={`In ${already.label || formatTimeRange(already.startTime, already.endTime)}`}
                              />
                            ) : (
                              <TextField
                                select
                                size="small"
                                value=""
                                disabled={busy}
                                label="Add to…"
                                onChange={(e) => place(e.target.value, u.id)}
                                sx={{ minWidth: 200 }}
                              >
                                {groupsHere.map((session) => (
                                  <MenuItem key={session.id} value={session.id}>
                                    {session.label || formatTimeRange(session.startTime, session.endTime)}
                                    {session.interviewerCapacity != null
                                      ? ` (${session.assigned.length}/${session.interviewerCapacity})`
                                      : ''}
                                  </MenuItem>
                                ))}
                              </TextField>
                            )}
                          </Stack>
                        );
                      })}
                    </Stack>
                  )}
                </Paper>
              );
            })}
          </Stack>
        )}
      </Paper>
      )}

      {conflicts.length > 0 && (
        <Alert severity="warning" icon={<WarningIcon />} sx={{ mb: 3 }}>
          {conflicts.length} interviewer{conflicts.length === 1 ? ' is' : 's are'} placed outside the times
          they gave: {conflicts.map((c) => fullName(c.user)).join(', ')}. That is allowed — just check they
          know.
        </Alert>
      )}

      {/* Placement, offering the people who said they could make it. */}
      {data.sessions.length > 0 && (
        <>
          <Typography variant="overline" color="text.secondary">
            Place interviewers
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 1, mb: 3 }}>
            {data.sessions.map((session) => {
              const able = data.interviewers.filter((i) => session.canCover.includes(i.user.id));
              const assignedIds = session.assigned.map((u) => u.id);
              const free = able.filter((i) => !assignedIds.includes(i.user.id));
              const short =
                session.interviewerCapacity != null && session.assigned.length < session.interviewerCapacity;

              return (
                <Paper key={session.id} variant="outlined" sx={{ p: 1.75 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1, gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body2" fontWeight={700}>
                      {session.label || formatTimeRange(session.startTime, session.endTime)}
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      {isAdmin && (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<SmsIcon fontSize="small" />}
                        onClick={() => setTexting(session)}
                      >
                        Send iMessage to interviewers
                      </Button>
                      )}
                      <Chip
                        size="small"
                        color={short ? 'warning' : 'default'}
                        variant={short ? 'filled' : 'outlined'}
                        label={`${session.assigned.length}${session.interviewerCapacity != null ? ` / ${session.interviewerCapacity}` : ''} interviewers`}
                      />
                    </Stack>
                  </Stack>

                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                    {session.assigned.map((user) => {
                      const placement = data.placements.find(
                        (p) => p.slotId === session.id && p.user.id === user.id
                      );
                      return (
                        <Chip
                          key={user.id}
                          size="small"
                          color={placement?.conflict === 'OUTSIDE_AVAILABILITY' ? 'warning' : 'default'}
                          variant={placement?.conflict ? 'filled' : 'outlined'}
                          label={fullName(user)}
                          disabled={busy}
                          // The whole chip opens the menu: moving somebody is at
                          // least as common as taking them off, and a bare X
                          // offers only the destructive half.
                          onClick={(e) =>
                            setMoving({
                              anchor: e.currentTarget,
                              assignmentId: placement?.assignmentId,
                              fromId: session.id,
                              name: fullName(user),
                            })
                          }
                        />
                      );
                    })}
                    {session.assigned.length === 0 && (
                      <Typography variant="caption" color="text.secondary">
                        Nobody yet
                      </Typography>
                    )}
                  </Stack>

                  <Divider sx={{ my: 1 }} />
                  {free.length > 0 && (
                    <>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                        Said they can make this time:
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                        {free.map((i) => (
                          <Chip
                            key={i.user.id}
                            size="small"
                            variant="outlined"
                            label={fullName(i.user)}
                            onClick={() => place(session.id, i.user.id)}
                            disabled={busy}
                          />
                        ))}
                      </Stack>
                    </>
                  )}

                  {/* Anybody at all. The list above is a shortcut, not the rule:
                      people who never answered are still on the roster, and exec
                      who were always going to be there never fill the form in. */}
                  <Autocomplete
                    size="small"
                    options={(data.staff ?? []).filter((u) => !assignedIds.includes(u.id))}
                    getOptionLabel={(u) => fullName(u)}
                    groupBy={(u) =>
                      session.canCover.includes(u.id)
                        ? 'Free at this time'
                        : u.responded
                          ? 'Said they are busy then'
                          : 'Never sent availability'
                    }
                    value={null}
                    blurOnSelect
                    disabled={busy}
                    onChange={(_, picked) => picked && place(session.id, picked.id)}
                    renderOption={(props, u) => (
                      <li {...props} key={u.id}>
                        <ListItemText primary={fullName(u)} secondary={u.email} />
                      </li>
                    )}
                    renderInput={(params) => (
                      <TextField {...params} placeholder="Add anyone else…" variant="outlined" />
                    )}
                    sx={{ maxWidth: 320 }}
                  />
                </Paper>
              );
            })}
          </Stack>
        </>
      )}

      {/* One menu for the whole section: move somebody to any other session, or
          take them off. Moving is an update in place server-side, so it keeps
          their history and sends one email instead of two contradictory ones. */}
      <Menu anchorEl={moving?.anchor} open={Boolean(moving)} onClose={() => setMoving(null)}>
        <MenuItem disabled>
          <Typography variant="caption" color="text.secondary">
            {moving?.name}
          </Typography>
        </MenuItem>
        <Divider />
        {data.sessions
          .filter((s) => s.id !== moving?.fromId)
          .map((s) => (
            <MenuItem key={s.id} onClick={() => move(moving.assignmentId, s.id)}>
              Move to {s.label || formatTimeRange(s.startTime, s.endTime)}
            </MenuItem>
          ))}
        {data.sessions.length <= 1 && (
          <MenuItem disabled>
            <Typography variant="caption">Nowhere else to move them</Typography>
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          onClick={() => {
            remove(moving.assignmentId);
            setMoving(null);
          }}
          sx={{ color: 'error.main' }}
        >
          Take off this session
        </MenuItem>
      </Menu>

      <ImessageSendDialog
        open={Boolean(texting)}
        onClose={() => setTexting(null)}
        title="Send iMessage to interviewers"
        subtitle={
          texting
            ? `${data.interview.title} · ${texting.label || formatTimeRange(texting.startTime, texting.endTime)}`
            : ''
        }
        initialMemberIds={texting?.assigned.map((u) => u.id) ?? []}
        cycleId={data.interview.cycleId}
        onSent={setAsked}
      />

      {/* What everybody actually said, because a grid hides the exceptions. */}
      {data.interviewers.length > 0 && (
        <>
          <Typography variant="overline" color="text.secondary">
            What people said ({data.interviewers.length})
          </Typography>
          <Stack spacing={0.75} sx={{ mt: 1 }}>
            {data.interviewers.map(({ user, windows }) => (
              <Stack
                key={user.id}
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ flexWrap: 'wrap', gap: 0.5 }}
              >
                <Typography variant="body2" sx={{ minWidth: 180 }}>
                  {fullName(user)}
                </Typography>
                {windows.map((w) => (
                  <Chip
                    key={w.id}
                    size="small"
                    variant="outlined"
                    label={formatTimeRange(w.startTime, w.endTime)}
                  />
                ))}
                {windows.filter((w) => w.note).map((w) => (
                  <Typography key={`${w.id}-note`} variant="caption" color="text.secondary">
                    — {w.note}
                  </Typography>
                ))}
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}
