import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  CalendarMonth as CalendarIcon,
  Delete as DeleteIcon,
  EditCalendar as EditIcon,
  Groups as GroupsIcon,
  HelpOutline as QuestionIcon,
  LocationOn as LocationIcon,
  PlayArrow as PlayIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import InterviewCreateDialog from './InterviewCreateDialog';
import InterviewEditDialog from './InterviewEditDialog';
import { formatDateTime, formatTimeRange } from '../../utils/scheduleFormat';

/**
 * Creating interviews and running them.
 *
 * The other half of the Interviews page. Rosters and times are handled by the
 * Sessions view; this is the paperwork - make an interview exist, start one
 * today, set its questions.
 */

const TYPE_LABEL = {
  COFFEE_CHAT: 'Coffee Chat',
  ROUND_ONE: 'First Round',
  ROUND_TWO: 'Final Round',
  FINAL_ROUND: 'Final Round',
  DELIBERATIONS: 'Deliberations',
};

/// Where a live session of each type runs. These routes and their ?groupIds=
/// contract are what the interview interfaces read; unchanged.
const INTERFACE_FOR_TYPE = {
  ROUND_ONE: '/member/first-round-interview',
  FINAL_ROUND: '/admin/final-round-interview',
  ROUND_TWO: '/admin/final-round-interview',
};
const DEFAULT_INTERFACE = '/admin/interview-interface';

export default function InterviewManageList({ cycle, onChanged }) {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState([]);
  const [rostersById, setRostersById] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [startFor, setStartFor] = useState(null);
  const [chosenSessions, setChosenSessions] = useState([]);
  const [questionsFor, setQuestionsFor] = useState(null);
  const [questionSession, setQuestionSession] = useState('');
  const [questions, setQuestions] = useState([]);

  const load = useCallback(async () => {
    try {
      setError('');
      const list = await apiClient.get('/admin/interviews');
      const scoped = (list || []).filter((i) => !cycle?.id || i.cycleId === cycle.id);
      setInterviews(scoped);

      // One roster per interview, so each card can say how many sessions and
      // candidates it has without anything needing to be opened.
      const rosters = await Promise.all(
        scoped.map((interview) =>
          apiClient
            .get(`/admin/interviews/${interview.id}/roster`)
            .then((roster) => [interview.id, roster])
            .catch(() => [interview.id, null])
        )
      );
      setRostersById(Object.fromEntries(rosters));
    } catch (e) {
      setError(e.message || 'Failed to load interviews.');
    } finally {
      setLoading(false);
    }
  }, [cycle?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const byRound = useMemo(() => {
    const groups = new Map();
    for (const interview of interviews) {
      const label = TYPE_LABEL[interview.interviewType] ?? 'Other';
      groups.set(label, [...(groups.get(label) ?? []), interview]);
    }
    return [...groups.entries()];
  }, [interviews]);

  const deleteInterview = async (interview) => {
    if (!window.confirm(`Delete "${interview.title}"? Its sessions and rosters go with it.`)) return;
    setBusy(true);
    try {
      await apiClient.delete(`/admin/interviews/${interview.id}`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Failed to delete that interview.');
    } finally {
      setBusy(false);
    }
  };

  const startSession = async () => {
    const interview = startFor;
    if (!interview || chosenSessions.length === 0) return;
    setBusy(true);
    try {
      await apiClient.post(`/admin/interviews/${interview.id}/start`, {}).catch(() => {});
      const base = INTERFACE_FOR_TYPE[interview.interviewType] ?? DEFAULT_INTERFACE;
      navigate(`${base}?interviewId=${interview.id}&groupIds=${chosenSessions.join(',')}`);
    } catch (e) {
      setError(e.message || 'Failed to start that session.');
      setBusy(false);
    }
  };

  const loadQuestions = async (interviewId, sessionId) => {
    try {
      const config = await apiClient.get(`/admin/interviews/${interviewId}/config?groupIds=${sessionId}`);
      setQuestions(
        Object.values(config.behavioralQuestions || {})
          .flat()
          .map((q) => q.questionText ?? q)
      );
    } catch {
      setQuestions([]);
    }
  };

  const openQuestions = async (interview) => {
    const first = rostersById[interview.id]?.slots?.[0]?.id ?? '';
    setQuestionsFor(interview);
    setQuestionSession(first);
    setQuestions([]);
    if (first) await loadQuestions(interview.id, first);
  };

  const saveQuestions = async () => {
    setBusy(true);
    try {
      await apiClient.patch(`/admin/interviews/${questionsFor.id}/config`, {
        type: 'behavioral_questions',
        config: { groupId: questionSession, questions: questions.filter((q) => q.trim() !== '') },
        behavioralQuestions: true,
      });
      setQuestionsFor(null);
    } catch (e) {
      setError(e.message || 'Failed to save those questions.');
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

  return (
    <Box>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          New interview
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {interviews.length === 0 && (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <CalendarIcon color="disabled" sx={{ fontSize: 44, mb: 1 }} />
            <Typography variant="h6" gutterBottom>
              No interviews in this cycle yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Create one, then add the sessions candidates book into from the Sessions view.
            </Typography>
          </CardContent>
        </Card>
      )}

      {byRound.map(([label, group]) => (
        <Box key={label} sx={{ mb: 4 }}>
          <Typography variant="overline" color="text.secondary">
            {label}
          </Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {group.map((interview) => {
              const sessions = rostersById[interview.id]?.slots ?? [];
              const candidates = sessions.reduce(
                (n, s) => n + s.signups.filter((x) => x.status === 'CONFIRMED').length,
                0
              );
              const interviewers = sessions.reduce((n, s) => n + s.interviewers.length, 0);
              const unscheduled = rostersById[interview.id]?.unassigned?.length ?? 0;

              return (
                <Card key={interview.id} variant="outlined">
                  <CardContent>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                          <Typography variant="h6">{interview.title}</Typography>
                          <Chip size="small" variant="outlined" label={TYPE_LABEL[interview.interviewType]} />
                          {interview.status && <Chip size="small" label={interview.status} />}
                        </Stack>
                        <Typography variant="body2" color="text.secondary">
                          {formatDateTime(interview.startDate)}
                        </Typography>
                        {interview.location && (
                          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                            <LocationIcon fontSize="small" color="disabled" />
                            <Typography variant="body2" color="text.secondary">
                              {interview.location}
                            </Typography>
                          </Stack>
                        )}
                      </Box>
                      <IconButton size="small" onClick={() => deleteInterview(interview)} disabled={busy}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>

                    <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', gap: 1 }}>
                      <Chip size="small" icon={<CalendarIcon />} label={`${sessions.length} sessions`} />
                      <Chip size="small" icon={<GroupsIcon />} label={`${candidates} candidates`} />
                      <Chip size="small" label={`${interviewers} interviewers`} />
                      {unscheduled > 0 && <Chip size="small" color="warning" label={`${unscheduled} not scheduled`} />}
                      {sessions.length === 0 && <Chip size="small" color="warning" label="No sessions yet" />}
                    </Stack>
                  </CardContent>
                  <CardActions sx={{ px: 2, pb: 2, gap: 1, flexWrap: 'wrap' }}>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<PlayIcon />}
                      disabled={sessions.length === 0}
                      onClick={() => {
                        setStartFor(interview);
                        setChosenSessions([]);
                      }}
                    >
                      Run a session
                    </Button>
                    <Button size="small" startIcon={<EditIcon />} onClick={() => setEditing(interview)}>
                      Edit times &amp; seats
                    </Button>
                    <Button
                      size="small"
                      startIcon={<QuestionIcon />}
                      disabled={sessions.length === 0}
                      onClick={() => openQuestions(interview)}
                    >
                      Questions
                    </Button>
                  </CardActions>
                </Card>
              );
            })}
          </Stack>
        </Box>
      ))}

      <InterviewEditDialog
        open={Boolean(editing)}
        interview={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await load();
          onChanged?.();
        }}
      />

      <InterviewCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await load();
          onChanged?.();
        }}
      />

      {/* Run a session ------------------------------------------------ */}
      <Dialog open={Boolean(startFor)} onClose={() => setStartFor(null)} fullWidth maxWidth="sm">
        <DialogTitle>Which session are you running?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Pick up to three. You will see those candidates in the interview interface.
          </Typography>
          <Stack divider={<Divider />}>
            {(rostersById[startFor?.id]?.slots ?? []).map((slot) => {
              const checked = chosenSessions.includes(slot.id);
              const count = slot.signups.filter((s) => s.status === 'CONFIRMED').length;
              return (
                <Stack
                  key={slot.id}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{ py: 0.5, cursor: 'pointer' }}
                  onClick={() =>
                    setChosenSessions((current) =>
                      checked
                        ? current.filter((id) => id !== slot.id)
                        : current.length >= 3
                          ? current
                          : [...current, slot.id]
                    )
                  }
                >
                  <Checkbox checked={checked} size="small" />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600}>
                      {slot.label || formatTimeRange(slot.startTime, slot.endTime)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {count} candidate{count === 1 ? '' : 's'}
                      {slot.interviewers.length > 0
                        ? ` · ${slot.interviewers.map((i) => i.user.fullName).join(', ')}`
                        : ''}
                    </Typography>
                  </Box>
                </Stack>
              );
            })}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStartFor(null)}>Cancel</Button>
          <Button variant="contained" disabled={busy || chosenSessions.length === 0} onClick={startSession}>
            Start
          </Button>
        </DialogActions>
      </Dialog>

      {/* Questions ---------------------------------------------------- */}
      <Dialog open={Boolean(questionsFor)} onClose={() => setQuestionsFor(null)} fullWidth maxWidth="sm">
        <DialogTitle>Behavioural questions</DialogTitle>
        <DialogContent>
          <TextField
            select
            size="small"
            label="Session"
            value={questionSession}
            onChange={(e) => {
              setQuestionSession(e.target.value);
              loadQuestions(questionsFor.id, e.target.value);
            }}
            fullWidth
            sx={{ mt: 1, mb: 2 }}
          >
            {(rostersById[questionsFor?.id]?.slots ?? []).map((slot) => (
              <MenuItem key={slot.id} value={slot.id}>
                {slot.label || formatTimeRange(slot.startTime, slot.endTime)}
              </MenuItem>
            ))}
          </TextField>
          <Stack spacing={1}>
            {questions.map((q, index) => (
              <TextField
                key={index}
                size="small"
                value={q}
                onChange={(e) => setQuestions((current) => current.map((item, i) => (i === index ? e.target.value : item)))}
                fullWidth
              />
            ))}
            <Button size="small" onClick={() => setQuestions((current) => [...current, ''])}>
              Add a question
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setQuestionsFor(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuestions} disabled={busy || !questionSession}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
