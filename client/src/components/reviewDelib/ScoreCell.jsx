import { useEffect, useState } from 'react';
import { Box, Button, Chip, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { score, signed } from '../../utils/reviewDelib';

// One grader's score on one document. An outlier or split is marked with how
// far it sits from the other graders; an admin running the session can set an
// override, which shows beside the grade it replaces ("was 4 → 8") and can be
// cleared to put the grade back.

const TONES = {
  outlier: { bg: 'rgba(211, 47, 47, 0.08)', border: 'error.main', label: 'Outlier', color: 'error' },
  split: { bg: 'rgba(237, 108, 2, 0.08)', border: 'warning.main', label: 'Split', color: 'warning' }
};

export default function ScoreCell({ row, max, canEdit, saving, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(null);

  useEffect(() => {
    if (!editing) setInvalid(null);
  }, [editing]);

  const tone = TONES[row.flag];
  const overridden = row.admin !== null && row.admin !== undefined;
  const resolved = !row.flag && row.rawFlag && overridden;

  const begin = () => {
    setDraft(String(overridden ? row.admin : row.overall ?? ''));
    setEditing(true);
  };

  const save = async () => {
    const value = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(value) || value < 0 || value > max) {
      setInvalid(`Enter a score from 0 to ${score(max)}`);
      return;
    }
    if (await onSave(value)) setEditing(false);
  };

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 1,
        border: 1,
        borderColor: tone ? tone.border : 'divider',
        bgcolor: tone ? tone.bg : 'transparent',
        borderLeftWidth: tone ? 4 : 1
      }}
      data-testid={`score-${row.scoreId}`}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap data-no-track>
            {row.evaluatorName}
          </Typography>
          {!row.onTeam && <Typography variant="caption" color="text.secondary">not on team</Typography>}
        </Box>

        {!editing && (
          <Stack direction="row" alignItems="center" spacing={0.5}>
            {overridden && (
              <Tooltip title={`Graded ${score(row.overall)}; overridden by an admin`}>
                <Typography variant="body2" color="text.secondary" sx={{ textDecoration: 'line-through' }}>
                  {score(row.overall)}
                </Typography>
              </Tooltip>
            )}
            {overridden && <Typography variant="body2" color="text.secondary" aria-hidden="true">→</Typography>}
            <Typography variant="h6" component="span" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {score(row.effective)}
            </Typography>
            <Typography variant="body2" color="text.secondary">/ {score(max)}</Typography>
            {canEdit && (
              <IconButton size="small" onClick={begin} aria-label={`Override ${row.evaluatorName}'s score`}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            )}
          </Stack>
        )}
      </Stack>

      {!editing && (tone || resolved || overridden) && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
          {tone && <Chip size="small" color={tone.color} label={tone.label} />}
          {tone && row.deviation !== null && (
            <Typography variant="caption" color="text.secondary">
              {signed(row.deviation)} vs others’ {score(row.othersMean)}
            </Typography>
          )}
          {resolved && <Chip size="small" color="success" variant="outlined" label="Resolved by override" />}
          {overridden && !resolved && !tone && <Chip size="small" variant="outlined" label="Overridden" />}
        </Stack>
      )}

      {editing && (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <TextField
            size="small"
            type="number"
            label={`Override (0–${score(max)})`}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setInvalid(null); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') setEditing(false);
            }}
            error={Boolean(invalid)}
            helperText={invalid || `Graded ${score(row.overall)}`}
            inputProps={{ min: 0, max, step: 0.5, 'aria-label': `Override score for ${row.evaluatorName}` }}
            autoFocus
          />
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="contained" onClick={save} disabled={saving}>Save</Button>
            {overridden && (
              <Button size="small" color="inherit" disabled={saving} onClick={async () => { if (await onSave(null)) setEditing(false); }}>
                Clear override
              </Button>
            )}
            <Button size="small" color="inherit" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </Stack>
        </Stack>
      )}
    </Box>
  );
}
