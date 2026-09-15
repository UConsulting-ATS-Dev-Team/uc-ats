import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LockIcon from '@mui/icons-material/Lock';
import HowToVoteIcon from '@mui/icons-material/HowToVote';
import Headshot from '../liveVote/Headshot';
import RubricEditorDialog from './RubricEditorDialog';
import liveVoteApi from '../../utils/liveVoteApi';
import {
  DECISION_COLORS,
  decisionLabel,
  filterBySearch,
  idsWithDecision,
  sortForSession
} from '../../utils/liveVoteSelection';

// Choosing who a live vote covers. The candidates are the ones on the Staging
// tab it was opened from; the order shown is the order they will be voted on.

const REJECTION_REASONS = {
  SEALED: 'sealed record',
  NOT_IN_CYCLE: 'not in the current cycle',
  OWN_RECORD: 'your own application'
};

export default function StagingLiveVoteSetupDialog({
  open,
  phase,
  phaseLabel,
  candidates,
  decisions = {},
  activeSession,
  onClose,
  onLaunched,
  onOpenSession,
  onEndSession
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [defaultRubric, setDefaultRubric] = useState([]);
  const [sessionRubric, setSessionRubric] = useState(null);
  const [rubricEditorOpen, setRubricEditorOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setSelected(new Set());
    setSessionRubric(null);
    setError(null);

    let cancelled = false;
    liveVoteApi.rubrics()
      .then(({ rubrics }) => !cancelled && setDefaultRubric(rubrics?.[phase]?.criteria || []))
      .catch(() => !cancelled && setDefaultRubric([]));
    return () => { cancelled = true; };
  }, [open, phase]);

  const ordered = useMemo(() => sortForSession(candidates, decisions), [candidates, decisions]);
  const visible = useMemo(() => filterBySearch(ordered, query), [ordered, query]);
  const rubric = sessionRubric?.criteria ?? defaultRubric;

  const countWith = (values) => idsWithDecision(candidates, decisions, values).length;

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const selectAllVisible = () => setSelected((current) => {
    const next = new Set(current);
    visible.filter((candidate) => !candidate.locked).forEach((candidate) => next.add(candidate.id));
    return next;
  });

  const selectDecisions = (values) => setSelected(new Set(idsWithDecision(candidates, decisions, values)));

  const nameOf = (id) => {
    const candidate = candidates.find((row) => row.id === id);
    return candidate ? `${candidate.firstName} ${candidate.lastName}` : 'Unknown candidate';
  };

  const launch = async () => {
    const applicationIds = ordered.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id);
    if (!applicationIds.length) return;
    setLaunching(true);
    setError(null);
    try {
      const { session } = await liveVoteApi.launch({
        phase,
        applicationIds,
        ...(sessionRubric
          ? { rubricCriteria: sessionRubric.criteria, saveRubricAsDefault: sessionRubric.saveAsDefault }
          : {})
      });
      onLaunched(session.id);
    } catch (err) {
      if (err.body?.rejected?.length) {
        setError({
          message: "These candidates can't be included:",
          items: err.body.rejected.map((row) =>
            `${row.name || nameOf(row.applicationId)} (${REJECTION_REASONS[row.reason] || row.reason})`)
        });
        setSelected((current) => {
          const next = new Set(current);
          err.body.rejected.forEach((row) => next.delete(row.applicationId));
          return next;
        });
      } else if (err.code === 'LIVE_VOTE_ACTIVE') {
        setError({ message: 'Another live vote started while you were setting this one up.', sessionId: err.body?.sessionId });
      } else {
        setError({ message: err.serverMessage || 'Could not start the live vote.' });
      }
    } finally {
      setLaunching(false);
    }
  };

  const quickActions = [
    { label: 'Select all', onClick: selectAllVisible },
    { label: 'Select none', onClick: () => setSelected(new Set()) },
    { label: `Maybe Yes (${countWith(['maybe_yes'])})`, onClick: () => selectDecisions(['maybe_yes']) },
    { label: `Maybe No (${countWith(['maybe_no'])})`, onClick: () => selectDecisions(['maybe_no']) },
    { label: `All maybes (${countWith(['maybe_yes', 'maybe_no'])})`, onClick: () => selectDecisions(['maybe_yes', 'maybe_no']) }
  ];

  return (
    <>
      <Dialog open={open} onClose={launching ? undefined : onClose} maxWidth="md" fullWidth scroll="paper">
        <DialogTitle sx={{ pb: 1 }}>
          Start a live vote
          <Typography variant="body2" color="text.secondary">{phaseLabel}</Typography>
        </DialogTitle>

        <DialogContent dividers sx={{ pt: 2 }}>
          {activeSession ? (
            <Alert
              severity="info"
              action={
                <Stack direction="row" spacing={1}>
                  <Button color="inherit" size="small" onClick={() => onOpenSession(activeSession.id)}>Open</Button>
                  <Button color="inherit" size="small" onClick={() => onEndSession(activeSession.id)}>End it</Button>
                </Stack>
              }
            >
              A {activeSession.phaseLabel} live vote is already running. Only one can run at a time.
            </Alert>
          ) : (
            <>
              {error && (
                <Alert
                  severity="error"
                  sx={{ mb: 2 }}
                  action={error.sessionId
                    ? <Button color="inherit" size="small" onClick={() => onOpenSession(error.sessionId)}>Open existing</Button>
                    : undefined}
                >
                  {error.message}
                  {error.items && (
                    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                      {error.items.map((item) => <li key={item}>{item}</li>)}
                    </Box>
                  )}
                </Alert>
              )}

              <TextField
                fullWidth
                size="small"
                placeholder="Search by name, email or major"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
                autoFocus
              />

              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ my: 1.5 }}>
                {quickActions.map((action) => (
                  <Chip key={action.label} label={action.label} onClick={action.onClick} variant="outlined" clickable />
                ))}
              </Stack>

              <Typography variant="caption" color="text.secondary">
                {selected.size} of {candidates.length} selected · voted on in the order shown
              </Typography>

              <List dense sx={{ maxHeight: 380, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 2, mt: 0.5 }}>
                {visible.length === 0 && (
                  <Typography color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>
                    {candidates.length ? 'No candidates match your search.' : 'No candidates on this tab.'}
                  </Typography>
                )}
                {visible.map((candidate) => {
                  const name = `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();
                  const decision = decisions[candidate.id];
                  const details = [candidate.major, candidate.graduationYear].filter(Boolean).join(' · ');
                  return (
                    <ListItemButton
                      key={candidate.id}
                      onClick={() => toggle(candidate.id)}
                      disabled={candidate.locked}
                      selected={selected.has(candidate.id)}
                    >
                      <ListItemIcon sx={{ minWidth: 40 }}>
                        <Checkbox
                          edge="start"
                          checked={selected.has(candidate.id)}
                          tabIndex={-1}
                          disableRipple
                          inputProps={{ 'aria-label': `Include ${name}` }}
                        />
                      </ListItemIcon>
                      <Headshot src={candidate.headshotUrl} name={name} size={32} sx={{ mr: 1.5 }} />
                      <ListItemText primary={name} secondary={candidate.locked ? 'Sealed record' : details || candidate.email} />
                      {candidate.locked ? (
                        <LockIcon fontSize="small" color="disabled" />
                      ) : (
                        <Chip
                          size="small"
                          label={decisionLabel(decision)}
                          color={DECISION_COLORS[decision] || 'default'}
                          variant={decision ? 'filled' : 'outlined'}
                        />
                      )}
                    </ListItemButton>
                  );
                })}
              </List>

              <Accordion disableGutters variant="outlined" sx={{ mt: 2, borderRadius: 2, '&:before': { display: 'none' } }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography fontWeight={600}>
                    Rubric · {rubric.length ? `${rubric.length} criteria` : 'none set'}
                    {sessionRubric ? ' (edited for this session)' : ''}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  {rubric.length ? (
                    <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
                      {rubric.map((criterion) => (
                        <li key={criterion.id}>
                          <Typography variant="body2">{criterion.title}</Typography>
                        </li>
                      ))}
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No rubric for {phaseLabel} yet. The vote works without one.
                    </Typography>
                  )}
                  <Button size="small" sx={{ mt: 1 }} onClick={() => setRubricEditorOpen(true)}>
                    Edit for this session
                  </Button>
                </AccordionDetails>
              </Accordion>
            </>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={onClose} disabled={launching}>Cancel</Button>
          {!activeSession && (
            <Button
              variant="contained"
              startIcon={launching ? <CircularProgress size={18} color="inherit" /> : <HowToVoteIcon />}
              disabled={launching || selected.size === 0}
              onClick={launch}
            >
              Launch live vote ({selected.size})
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <RubricEditorDialog
        open={rubricEditorOpen}
        phase={phase}
        phaseLabel={phaseLabel}
        mode="session"
        initialCriteria={rubric}
        onClose={() => setRubricEditorOpen(false)}
        onSaved={setSessionRubric}
      />
    </>
  );
}
