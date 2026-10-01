import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  EditCalendar as EditIcon,
  HelpOutline as QuestionIcon,
  MoreVert as MoreIcon,
  PlayArrow as PlayIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import InterviewEditDialog from './InterviewEditDialog';
import InterviewSlotSetup from './InterviewSlotSetup';
import { formatDateTime, formatTimeRange } from '../../utils/scheduleFormat';
import { useTutorialGate } from '../TutorialGate';
import { tutorialCategoryForInterviewType } from '../../utils/tutorialCategories';

/**
 * The interviews in one round, and everything you do to set one up or run it.
 *
 * Scoped to the round tab it sits under. It used to list every round's
 * interviews beneath whichever round was selected, which made the tab above it
 * look like it meant nothing.
 *
 * Sessions come from the round's own overview data rather than a roster fetch
 * per interview: the page already has them.
 */

/// Where a live session of each type runs. These routes and their ?groupIds=
/// contract are what the interview interfaces read; unchanged.
const INTERFACE_FOR_TYPE = {
  ROUND_ONE: '/member/first-round-interview',
  FINAL_ROUND: '/admin/final-round-interview',
  ROUND_TWO: '/admin/final-round-interview',
};
const DEFAULT_INTERFACE = '/admin/interview-interface';

const sessionHeading = (slot) => slot.label || formatTimeRange(slot.startTime, slot.endTime);

export default function InterviewManageList({ round, onChanged }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The round's tutorials, once a cycle, before an admin runs their first session of it.
  const tutorialGate = useTutorialGate();

  const [setupFor, setSetupFor] = useState(null);
  const [menu, setMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const [startFor, setStartFor] = useState(null);
  const [chosenSessions, setChosenSessions] = useState([]);
  const [questionsFor, setQuestionsFor] = useState(null);
  const [questionSession, setQuestionSession] = useState('');
  const [questions, setQuestions] = useState([]);

  // The overview carries id, title, date and status. Editing needs location,
  // dress code and end date too, so the full records come from one list call.
  const load = useCallback(async () => {
    try {
      const list = await apiClient.get('/admin/interviews');
      setDetails(Object.fromEntries((list || []).map((i) => [i.id, i])));
    } catch (e) {
      setError(e.message || 'Failed to load interviews.');
    }
  }, []);

  // Refetched whenever the page reloads its overview, so a Refresh picks up an
  // edit someone else made to location or dress code as well.
  useEffect(() => {
    load();
  }, [load, round]);

  // The overview is the fresher of the two for what it carries, so it wins.
  const interviews = useMemo(
    () => (round?.interviews ?? []).map((i) => ({ ...details[i.id], ...i, loaded: Boolean(details[i.id]) })),
    [round, details]
  );

  const sessionsOf = useCallback(
    (interviewId) => (round?.slots ?? []).filter((slot) => slot.interviewId === interviewId),
    [round]
  );

  const changed = async () => {
    await load();
    onChanged?.();
  };

  const deleteInterview = async (interview) => {
    if (!window.confirm(`Delete "${interview.title}"? Its sessions and rosters go with it.`)) return;
    setBusy(true);
    try {
      await apiClient.delete(`/admin/interviews/${interview.id}`);
      await changed();
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
          .map((q) => q.text ?? q.questionText ?? q)
      );
    } catch {
      setQuestions([]);
    }
  };

  const openQuestions = async (interview) => {
    const first = sessionsOf(interview.id)[0]?.id ?? '';
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
        config: {
          behavioralQuestions: true,
          groupId: questionSession,
          questions: questions.filter((q) => q.trim() !== ''),
        },
      });
      setQuestionsFor(null);
    } catch (e) {
      setError(e.message || 'Failed to save those questions.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Stack divider={<Divider />}>
        {interviews.map((interview) => {
          const sessions = sessionsOf(interview.id);
          return (
            <Box key={interview.id} sx={{ py: 1.5 }} data-testid={`interview-row-${interview.id}`}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', md: 'center' }}
                spacing={1}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="subtitle1" fontWeight={700} noWrap>
                      {interview.title}
                    </Typography>
                    {interview.status && <Chip size="small" variant="outlined" label={interview.status} />}
                    {sessions.length === 0 && <Chip size="small" color="warning" label="No sessions yet" />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {[
                      formatDateTime(interview.startDate),
                      interview.location,
                      `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                </Box>

                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => setSetupFor(setupFor === interview.id ? null : interview.id)}
                  >
                    Add sessions
                  </Button>
                  {/* Waits for the full record: the dialog saves location and
                      dress code back, and opened on overview data alone it
                      would save them as blank. */}
                  <Button
                    size="small"
                    startIcon={<EditIcon />}
                    disabled={!interview.loaded}
                    onClick={() => setEditing(interview)}
                  >
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
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<PlayIcon />}
                    disabled={sessions.length === 0}
                    onClick={() =>
                      // The overview rows carry no type until the full list loads; the
                      // round's own type is the same and always there.
                      tutorialGate.run(() => {
                        setStartFor(interview);
                        setChosenSessions([]);
                      }, tutorialCategoryForInterviewType(interview.interviewType ?? round?.interviewType))
                    }
                  >
                    Run a session
                  </Button>
                  <IconButton
                    size="small"
                    aria-label={`More actions for ${interview.title}`}
                    onClick={(e) => setMenu({ anchor: e.currentTarget, interview })}
                  >
                    <MoreIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Stack>

              {setupFor === interview.id && (
                <Box sx={{ mt: 2 }}>
                  <InterviewSlotSetup
                    interviewId={interview.id}
                    interviewType={interview.interviewType ?? round?.interviewType}
                    onCreated={async () => {
                      setSetupFor(null);
                      await changed();
                    }}
                  />
                </Box>
              )}
            </Box>
          );
        })}
      </Stack>

      <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}>
        <MenuItem
          disabled={busy}
          sx={{ color: 'error.main' }}
          onClick={() => {
            const { interview } = menu;
            setMenu(null);
            deleteInterview(interview);
          }}
        >
          Delete interview
        </MenuItem>
      </Menu>

      <InterviewEditDialog
        open={Boolean(editing)}
        interview={editing}
        onClose={() => setEditing(null)}
        onSaved={changed}
      />

      {/* Run a session ------------------------------------------------ */}
      <Dialog open={Boolean(startFor)} onClose={() => setStartFor(null)} fullWidth maxWidth="sm">
        <DialogTitle>Which session are you running?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Pick up to three. You will see those candidates in the interview interface.
          </Typography>
          <Stack divider={<Divider />}>
            {(startFor ? sessionsOf(startFor.id) : []).map((slot) => {
              const checked = chosenSessions.includes(slot.id);
              const count = slot.signups.filter((s) => s.status === 'CONFIRMED').length;
              const interviewers = slot.interviewers ?? [];
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
                      {sessionHeading(slot)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {count} candidate{count === 1 ? '' : 's'}
                      {interviewers.length > 0 ? ` · ${interviewers.map((i) => i.user.fullName).join(', ')}` : ''}
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
            {(questionsFor ? sessionsOf(questionsFor.id) : []).map((slot) => (
              <MenuItem key={slot.id} value={slot.id}>
                {sessionHeading(slot)}
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

      {tutorialGate.dialog}
    </Box>
  );
}
