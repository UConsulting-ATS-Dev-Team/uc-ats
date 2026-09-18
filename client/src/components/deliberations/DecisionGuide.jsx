import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Button, Chip, Drawer, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import decisionGuideApi from '../../utils/decisionGuideApi';
import { DECISION_OPTIONS } from '../../utils/decisionOptions';

// In-context guidance for a reviewer recording a decision: a short note on what
// deliberation is for, always visible above the candidates, and a side panel
// describing each of the four decisions.
//
// The copy is admin-editable and comes from GET /api/decision-guides/:phase
// already resolved - the page never has to know which layer answered. Fetching
// is best-effort: if it fails the reviewer still gets their form, just without
// the help, because blocking an interview on a paragraph of copy would be a bad
// trade.

/** MUI colors for the decision chips, matching the radio buttons' CSS classes. */
const CHIP_COLOR = {
  YES: 'success',
  MAYBE_YES: 'success',
  MAYBE_NO: 'warning',
  NO: 'error'
};

/**
 * Loads the guide for `phase` and owns whether the panel is open.
 *
 * Returns `guide: null` until it arrives and if it never does, which every
 * component below treats as "render nothing".
 */
export function useDecisionGuide(phase) {
  const [guide, setGuide] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!phase) return undefined;
    let cancelled = false;
    decisionGuideApi.forPhase(phase)
      .then((data) => !cancelled && setGuide(data?.guide || null))
      .catch(() => !cancelled && setGuide(null));
    return () => { cancelled = true; };
  }, [phase]);

  return {
    guide,
    open,
    openGuide: useCallback(() => setOpen(true), []),
    closeGuide: useCallback(() => setOpen(false), [])
  };
}

/** The standing note above the candidates. Explains the point of the exercise. */
export function DeliberationNotice({ guide, onOpen }) {
  if (!guide?.intro) return null;

  return (
    <Alert
      severity="info"
      role="note"
      aria-label="About deliberation"
      data-testid="deliberation-notice"
      // The action slot is a narrow flex column by default, which stacks this
      // label one word per line once the note runs to a few lines.
      sx={{ mb: 2, mt: 2, '& .MuiAlert-action': { alignItems: 'center', pt: 0 } }}
      action={onOpen && (
        <Button
          color="inherit"
          size="small"
          onClick={onOpen}
          data-testid="open-decision-guide"
          sx={{ whiteSpace: 'nowrap' }}
        >
          What the decisions mean
        </Button>
      )}
    >
      <AlertTitle>About deliberation</AlertTitle>
      <Typography variant="body2" component="div">{guide.intro}</Typography>
    </Alert>
  );
}

/** The help affordance beside a single candidate's decision picker. */
export function DecisionGuideButton({ onClick, guide }) {
  if (!guide) return null;

  return (
    <Tooltip title="What the decisions mean">
      <IconButton
        size="small"
        onClick={onClick}
        aria-label="What the decisions mean"
        data-testid="decision-guide-button"
      >
        <HelpOutlineIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

/**
 * The criteria, one block per decision, in a right-hand drawer.
 *
 * A drawer rather than a column, so it costs the interview pages no layout.
 * They are hand-rolled CSS grids that a sticky sidebar would have to fight, and
 * a drawer already works on a phone.
 */
export function DecisionGuidePanel({ open, guide, onClose }) {
  if (!guide) return null;

  const byValue = new Map((guide.decisions || []).map((entry) => [entry.value, entry]));

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      aria-label="Decision guide"
      PaperProps={{ sx: { width: 'min(420px, 92vw)' } }}
      data-testid="decision-guide-panel"
    >
      <Box sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6" fontWeight={700}>Decision guide</Typography>
          <IconButton size="small" onClick={onClose} aria-label="Close decision guide">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
          {guide.phaseLabel}
        </Typography>

        {guide.intro && (
          <Typography variant="body2" sx={{ mb: 3 }}>{guide.intro}</Typography>
        )}

        <Stack spacing={2.5} component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {DECISION_OPTIONS.map(({ value, label }) => {
            const entry = byValue.get(value);
            if (!entry?.criteria) return null;
            return (
              <Box component="li" key={value} data-testid={`decision-criteria-${value}`}>
                <Chip
                  label={entry.label || label}
                  size="small"
                  color={CHIP_COLOR[value]}
                  variant="outlined"
                  sx={{ mb: 0.75, fontWeight: 700 }}
                />
                <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
                  {entry.criteria}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      </Box>
    </Drawer>
  );
}
