import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { DECISION_OPTIONS } from '../../utils/decisionOptions';

// Asked when an interviewer presses Save All at the end of a final round: their
// decision on each candidate they just interviewed. The decision used to live only
// in My Interviews -> My Evaluations, where it was easy to forget.
//
// "Later" closes it with nothing changed; the decision can still be set from My
// Evaluations, exactly as before. Only the candidates whose pick changed are saved.

// The interview pages' decision colours (DECISION_OPTIONS -> .decision-label in
// InterviewInterface.css), as MUI palette names: Yes is info, Maybe-Yes success.
const PALETTE = { green: 'info', 'light-green': 'success', orange: 'warning', red: 'error' };
export default function FinalDecisionDialog({ open, candidates, guide, onOpenGuide, onSave, onLater }) {
  const [picks, setPicks] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Start from their current decisions each time it opens. Only on opening: the
  // parent rebuilds `candidates` every render, which would wipe picks mid-choice.
  useEffect(() => {
    if (!open) return;
    setPicks(Object.fromEntries(candidates.map((c) => [c.id, c.decision ?? null])));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const changed = candidates.filter((c) => (picks[c.id] ?? null) !== (c.decision ?? null));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(Object.fromEntries(changed.map((c) => [c.id, picks[c.id]])));
    } catch (e) {
      setError(e.message || 'Could not save your decisions. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onLater} maxWidth="sm" fullWidth aria-labelledby="final-decision-title">
      <DialogTitle id="final-decision-title">Your decision on each candidate</DialogTitle>
      <DialogContent dividers>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2, gap: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Your notes are saved. Record where you landed while it is fresh.
          </Typography>
          {guide && (
            <Button size="small" onClick={onOpenGuide} sx={{ flexShrink: 0, textTransform: 'none' }}>
              What the decisions mean
            </Button>
          )}
        </Stack>
        <Stack spacing={2}>
          {candidates.map((c) => (
            <Box key={c.id} data-no-track>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.75 }}>
                {c.name}
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={picks[c.id] ?? null}
                // Clicking the selected choice again keeps it: a click must never clear a
                // recorded decision. Locked while saving, so what shows is what saves.
                onChange={(_, value) => {
                  if (value !== null) setPicks((prev) => ({ ...prev, [c.id]: value }));
                }}
                disabled={saving}
                aria-label={`Decision for ${c.name}`}
              >
                {DECISION_OPTIONS.map((option) => (
                  <ToggleButton
                    key={option.value}
                    value={option.value}
                    color={PALETTE[option.color] || 'primary'}
                    sx={{ px: 2, textTransform: 'none', '&.Mui-selected': { fontWeight: 700 } }}
                  >
                    {option.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
          ))}
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onLater} disabled={saving}>
          Later
        </Button>
        <Button variant="contained" onClick={save} disabled={saving || changed.length === 0}>
          {saving ? 'Saving…' : 'Save decisions'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
