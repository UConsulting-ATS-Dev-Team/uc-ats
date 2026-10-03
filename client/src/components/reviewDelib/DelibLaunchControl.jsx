import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack
} from '@mui/material';
import GroupsIcon from '@mui/icons-material/Groups';
import usePolling from '../../hooks/usePolling';
import reviewDelibApi from '../../utils/reviewDelibApi';
import { useReviewDelibs } from '../../context/ReviewDelibContext';
import { THRESHOLD_OPTIONS, percent, plural } from '../../utils/reviewDelib';

// Review Teams' side of the deliberations: each team's status, and the button
// that starts (or reopens) its session.

const POLL_MS = 15000;

/**
 * Every team's delib status in the admin cycle, keyed by team id. Admin only.
 *
 * Refetched whenever the set of running sessions changes. That set comes from
 * ReviewDelibProvider, which already listens on the 'review-delibs' channel;
 * subscribing here too would fail, because Supabase hands back the same
 * channel for the same name and a channel can only be subscribed once.
 */
export function useDelibStatuses(enabled) {
  const [byGroup, setByGroup] = useState({});
  const { sessions } = useReviewDelibs();
  const fetcher = useCallback((signal) => reviewDelibApi.groups({ signal }), []);
  const { refresh } = usePolling({
    fetcher,
    enabled,
    interval: POLL_MS,
    pauseWhenHidden: true,
    onData: (payload) => setByGroup(Object.fromEntries((payload?.groups || []).map((entry) => [entry.groupId, entry])))
  });

  const running = sessions.map((session) => session.id).sort().join(',');
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, running]); // eslint-disable-line react-hooks/exhaustive-deps

  return { byGroup, refresh };
}

export function DelibStatusChip({ status }) {
  if (status?.open) {
    return <Chip size="small" color="warning" label="Delib live" />;
  }
  if (status?.last) {
    const date = new Date(status.last.endedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return (
      <Chip
        size="small"
        variant="outlined"
        color="success"
        label={`Delib held ${date} · ${plural(status.last.changeCount, 'change')}`}
      />
    );
  }
  return <Chip size="small" variant="outlined" label="Delib not held" />;
}

export default function DelibLaunchControl({ team, status, onChanged }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState(0.3);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState(null);

  if (status?.open) {
    return (
      <Button size="small" variant="contained" color="warning" startIcon={<GroupsIcon />} onClick={() => navigate(`/review-delib/${status.open.id}`)}>
        Open delib
      </Button>
    );
  }

  const launch = async () => {
    setLaunching(true);
    setError(null);
    try {
      const { session } = await reviewDelibApi.launch(team.id, threshold);
      onChanged?.();
      navigate(`/review-delib/${session.id}`);
    } catch (e) {
      if (e?.code === 'DELIB_ACTIVE' && e.body?.sessionId) {
        navigate(`/review-delib/${e.body.sessionId}`);
        return;
      }
      setError(e?.serverMessage || e?.message || 'Could not start the deliberation');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <>
      <Button size="small" variant="outlined" startIcon={<GroupsIcon />} onClick={() => setOpen(true)}>
        Start delib
      </Button>
      <Dialog open={open} onClose={() => !launching && setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Start {team.name} deliberation</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5}>
            <DialogContentText>
              The team gets a prompt to join. You go through the overview, every outlier, then the full list, and everyone sees what you see.
            </DialogContentText>
            <FormControl fullWidth size="small">
              <InputLabel id="delib-launch-threshold">Count a grade as an outlier at</InputLabel>
              <Select
                labelId="delib-launch-threshold"
                label="Count a grade as an outlier at"
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              >
                {THRESHOLD_OPTIONS.map((value) => (
                  <MenuItem key={value} value={value}>{percent(value)} of the document’s max away from the other graders</MenuItem>
                ))}
              </Select>
            </FormControl>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={launching}>Cancel</Button>
          <Button variant="contained" onClick={launch} disabled={launching}>
            {launching ? 'Starting…' : 'Start and join'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
