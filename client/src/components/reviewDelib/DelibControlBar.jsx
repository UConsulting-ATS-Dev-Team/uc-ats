import {
  Box,
  Button,
  ButtonGroup,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { STEPS, THRESHOLD_OPTIONS, percent, walkthroughNeighbour } from '../../utils/reviewDelib';

// How each viewer gets around the session: the steps and, on Outliers, previous
// and next. Everyone has these, and moving only moves you. An admin running it
// also gets the threshold and End, which change the session for everyone.
// Sticks to the bottom of the window so it is in reach from anywhere on a long card.

export default function DelibControlBar({ state, step, applicationId, canShow, isHost, busy, onStep, onOutlier, onThreshold, onEnd }) {
  const { session } = state;
  const order = session.outlierApplicationIds;
  const position = order.indexOf(applicationId);
  const previous = walkthroughNeighbour(order, applicationId, -1, canShow);
  const next = walkthroughNeighbour(order, applicationId, 1, canShow);

  return (
    <Paper
      elevation={6}
      sx={{
        position: 'sticky',
        bottom: { xs: 8, md: 16 },
        mt: 3,
        p: 1.5,
        zIndex: 2,
        borderRadius: 2
      }}
    >
      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }} justifyContent="space-between">
        <ButtonGroup size="small" aria-label="Steps" sx={{ flexWrap: 'wrap' }}>
          {STEPS.map((entry) => (
            <Button
              key={entry.id}
              variant={step === entry.id ? 'contained' : 'outlined'}
              aria-pressed={step === entry.id}
              onClick={() => step !== entry.id && onStep(entry.id)}
            >
              {entry.id === 'OUTLIERS' ? `${entry.label} (${order.length})` : entry.label}
            </Button>
          ))}
        </ButtonGroup>

        {step === 'OUTLIERS' && order.length > 0 && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              size="small"
              startIcon={<ChevronLeftIcon />}
              disabled={!previous}
              onClick={() => onOutlier(previous)}
            >
              Previous
            </Button>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'center' }}>
              {position === -1 ? '–' : position + 1} of {order.length}
            </Typography>
            <Button
              size="small"
              variant="contained"
              endIcon={<ChevronRightIcon />}
              onClick={() => (next ? onOutlier(next) : onStep('ALL'))}
            >
              {next ? 'Next' : 'All candidates'}
            </Button>
          </Stack>
        )}

        {isHost && (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel id="delib-threshold-label">Outlier at</InputLabel>
              <Select
                labelId="delib-threshold-label"
                label="Outlier at"
                value={session.thresholdPct}
                disabled={busy}
                onChange={(event) => onThreshold(Number(event.target.value))}
              >
                {THRESHOLD_OPTIONS.map((value) => (
                  <MenuItem key={value} value={value}>{percent(value)} of max</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box>
              <Button color="error" variant="outlined" size="small" disabled={busy} onClick={onEnd}>
                End
              </Button>
            </Box>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
