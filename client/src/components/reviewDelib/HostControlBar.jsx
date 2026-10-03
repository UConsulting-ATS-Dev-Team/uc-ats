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
import { STEPS, THRESHOLD_OPTIONS, percent } from '../../utils/reviewDelib';

// What an admin running the session drives it with. Sticks to the bottom of the
// window so it is in reach from anywhere on a long card.

export default function HostControlBar({ state, busy, onStep, onOutlier, onThreshold, onEnd }) {
  const { session } = state;
  const order = session.outlierApplicationIds;
  const position = order.indexOf(session.currentApplicationId);

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
          {STEPS.map((step) => (
            <Button
              key={step.id}
              variant={session.step === step.id ? 'contained' : 'outlined'}
              disabled={busy}
              onClick={() => session.step !== step.id && onStep(step.id)}
            >
              {step.id === 'OUTLIERS' ? `${step.label} (${order.length})` : step.label}
            </Button>
          ))}
        </ButtonGroup>

        {session.step === 'OUTLIERS' && order.length > 0 && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              size="small"
              startIcon={<ChevronLeftIcon />}
              disabled={busy || position <= 0}
              onClick={() => onOutlier(order[position - 1])}
            >
              Previous
            </Button>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'center' }}>
              {position + 1} of {order.length}
            </Typography>
            <Button
              size="small"
              variant="contained"
              endIcon={<ChevronRightIcon />}
              disabled={busy}
              onClick={() => (position + 1 < order.length ? onOutlier(order[position + 1]) : onStep('ALL'))}
            >
              {position + 1 < order.length ? 'Next' : 'All candidates'}
            </Button>
          </Stack>
        )}

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
      </Stack>
    </Paper>
  );
}
