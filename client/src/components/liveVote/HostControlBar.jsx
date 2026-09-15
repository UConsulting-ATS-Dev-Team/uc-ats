import {
  Box,
  Button,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { DECISION_COLORS, DECISION_LABELS, DECISION_OPTIONS } from '../../utils/liveVoteSelection';

const spinnerOr = (busy, icon) => (busy ? <CircularProgress size={16} color="inherit" /> : icon);

export default function HostControlBar({ state, pendingAction, onPrev, onNext, onClose, onReopen, onDecide, onEnd }) {
  const { session, current } = state;
  const ballot = current?.ballot;
  const open = ballot?.status === 'OPEN';
  const busy = Boolean(pendingAction);
  const isFirst = session.currentIndex <= 0;
  const isLast = session.currentIndex >= session.candidateCount - 1;
  const decisionDisabled = busy || open || !current || current.candidate.locked;

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'sticky',
        bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        mt: 3,
        p: 1.5,
        borderRadius: 3,
        zIndex: 2
      }}
    >
      <Stack
        direction={{ xs: 'column', lg: 'row' }}
        spacing={1.5}
        alignItems="center"
        justifyContent="space-between"
        divider={<Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', lg: 'block' } }} />}
      >
        <Stack direction="row" spacing={1}>
          <Tooltip title="Previous candidate (←)">
            <span>
              <Button startIcon={<NavigateBeforeIcon />} disabled={busy || isFirst} onClick={onPrev}>Prev</Button>
            </span>
          </Tooltip>
          {open ? (
            <Tooltip title="Close voting and reveal results (C)">
              <span>
                <Button
                  variant="contained"
                  color="warning"
                  startIcon={spinnerOr(pendingAction === 'close', <LockIcon />)}
                  disabled={busy}
                  onClick={onClose}
                >
                  Close voting
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Tooltip title="Vote on this candidate again (O)">
              <span>
                <Button
                  variant="outlined"
                  startIcon={spinnerOr(pendingAction === 'reopen', <LockOpenIcon />)}
                  disabled={busy || !current || current.candidate.locked}
                  onClick={onReopen}
                >
                  {ballot ? 'Re-open voting' : 'Open voting'}
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
          <Typography variant="body2" color="text.secondary">
            {open ? 'Close voting to decide' : 'Decision'}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={current?.decision || null}
            onChange={(event, value) => value && onDecide(value)}
            disabled={decisionDisabled}
            aria-label="Set decision"
          >
            {DECISION_OPTIONS.map((option, index) => (
              <Tooltip key={option} title={`Shortcut: ${index + 1}`} describeChild>
                <ToggleButton
                  value={option}
                  color={DECISION_COLORS[option]}
                  sx={{ px: 1.5, textTransform: 'none', fontWeight: 600 }}
                >
                  {DECISION_LABELS[option]}
                </ToggleButton>
              </Tooltip>
            ))}
          </ToggleButtonGroup>
          <Box sx={{ width: 20 }}>{pendingAction === 'decide' && <CircularProgress size={16} />}</Box>
        </Stack>

        <Stack direction="row" spacing={1}>
          <Tooltip title={isLast ? 'This is the last candidate' : 'Next candidate (→)'}>
            <span>
              <Button
                variant="contained"
                endIcon={spinnerOr(pendingAction === 'navigate', <NavigateNextIcon />)}
                disabled={busy || isLast}
                onClick={onNext}
              >
                Next
              </Button>
            </span>
          </Tooltip>
          <Button color="error" startIcon={<StopCircleIcon />} disabled={busy} onClick={onEnd}>
            End session
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
