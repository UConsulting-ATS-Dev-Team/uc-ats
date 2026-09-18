import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import decisionGuideApi from '../../utils/decisionGuideApi';
import { DECISION_OPTIONS } from '../../utils/decisionOptions';

// Editing what each decision means. Limits match the server (normalizeGuide in
// server/src/services/decisionGuides.js).
//
// A round starts out inheriting - from "All rounds" if an admin wrote one,
// otherwise from the copy shipped with the app. The fields below are seeded
// with whatever the round currently *shows*, so an admin editing an inherited
// round starts from the real words rather than a blank box. Saving is what
// turns that into the round's own wording; Reset puts it back to inheriting.

const INTRO_MAX = 2000;
const CRITERIA_MAX = 2000;

const emptyCriteria = () => Object.fromEntries(DECISION_OPTIONS.map(({ value }) => [value, '']));

/** Where the text in the form came from, said plainly. */
function InheritanceNote({ guide }) {
  if (!guide || guide.customized) return null;
  const from = guide.introSource === 'general' ? 'the "All rounds" guide' : 'the built-in default';
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      {guide.phaseLabel} has no wording of its own and is showing {from}. Saving here gives this round its
      own copy; other rounds are unaffected.
    </Alert>
  );
}

export default function DecisionGuideEditorDialog({ open, phase, onClose, onSaved }) {
  const [guides, setGuides] = useState(null);
  const [selectedPhase, setSelectedPhase] = useState(phase || 'general');
  const [intro, setIntro] = useState('');
  const [criteria, setCriteria] = useState(emptyCriteria);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const current = guides?.guides?.[selectedPhase] || null;

  useEffect(() => {
    if (!open) return undefined;
    setError(null);
    setSelectedPhase(phase || 'general');

    let cancelled = false;
    setLoading(true);
    decisionGuideApi.all()
      .then((data) => !cancelled && setGuides(data))
      .catch((err) => !cancelled && setError(err.serverMessage || 'Could not load the decision guide.'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, phase]);

  // Seed the form from what this phase stores, falling back to what it shows.
  useEffect(() => {
    if (!current) return;
    const stored = current.stored;
    setIntro(stored?.intro || current.intro || '');
    setCriteria(Object.fromEntries(DECISION_OPTIONS.map(({ value }) => {
      const shown = current.decisions?.find((entry) => entry.value === value);
      return [value, stored?.criteria?.[value] || shown?.criteria || ''];
    })));
  }, [current]);

  const phaseOptions = useMemo(
    () => (guides?.phases || []).map((value) => ({
      value,
      label: guides.guides?.[value]?.phaseLabel || value,
      customized: Boolean(guides.guides?.[value]?.customized)
    })),
    [guides]
  );

  const tooLong = intro.length > INTRO_MAX
    || DECISION_OPTIONS.some(({ value }) => (criteria[value] || '').length > CRITERIA_MAX);

  const runSave = async (action) => {
    setSaving(true);
    setError(null);
    try {
      setGuides(await action());
      onSaved?.();
    } catch (err) {
      setError(err.serverMessage || 'Could not save the decision guide.');
    } finally {
      setSaving(false);
    }
  };

  const save = () => runSave(() => decisionGuideApi.save(selectedPhase, { intro, criteria }));
  const reset = () => runSave(() => decisionGuideApi.reset(selectedPhase));

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Decision guide</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
        ) : (
          <Stack spacing={2.5}>
            {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}

            <Typography variant="body2" color="text.secondary">
              What reviewers see beside the decision buttons after an interview. Pick "All rounds" to set the
              wording everywhere, or a single round to override it there.
            </Typography>

            <TextField
              select
              label="Round"
              value={selectedPhase}
              onChange={(event) => setSelectedPhase(event.target.value)}
              size="small"
              sx={{ maxWidth: 320 }}
            >
              {phaseOptions.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                  {!option.customized && option.value !== 'general' && (
                    <Chip label="inherited" size="small" variant="outlined" sx={{ ml: 1 }} />
                  )}
                </MenuItem>
              ))}
            </TextField>

            <InheritanceNote guide={current} />

            <TextField
              label="About deliberation"
              helperText={`Shown above the candidates. ${intro.length}/${INTRO_MAX}`}
              value={intro}
              onChange={(event) => setIntro(event.target.value)}
              error={intro.length > INTRO_MAX}
              multiline
              minRows={3}
              fullWidth
            />

            {DECISION_OPTIONS.map(({ value, label }) => {
              const text = criteria[value] || '';
              return (
                <TextField
                  key={value}
                  label={`When to pick "${label}"`}
                  helperText={`${text.length}/${CRITERIA_MAX}`}
                  value={text}
                  onChange={(event) => setCriteria((prev) => ({ ...prev, [value]: event.target.value }))}
                  error={text.length > CRITERIA_MAX}
                  multiline
                  minRows={2}
                  fullWidth
                />
              );
            })}

            <Typography variant="caption" color="text.secondary">
              Leaving a field empty makes it fall back to the level below, so a round can change one decision
              without restating the rest.
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        {current?.customized && (
          <Button color="inherit" onClick={reset} disabled={saving}>
            Reset to inherited
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} disabled={saving}>Close</Button>
        <Button variant="contained" onClick={save} disabled={saving || loading || tooLong}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
