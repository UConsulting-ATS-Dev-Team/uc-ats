import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import liveVoteApi from '../../utils/liveVoteApi';

// Editing a round's deliberation rubric: criteria with a title and a note on
// what strong and weak look like. Limits match the server
// (normalizeCriteria in server/src/services/liveVotes.js).
//
// mode "default" saves the round's rubric. mode "session" edits the copy for
// one live vote about to launch and hands it back, optionally flagged to be
// saved as the round's default too.

export const MAX_CRITERIA = 20;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random()}`);

export function validateCriteria(criteria) {
  if (criteria.length > MAX_CRITERIA) return `A rubric can have at most ${MAX_CRITERIA} criteria.`;
  const index = criteria.findIndex((criterion) => !criterion.title.trim());
  if (index !== -1) return `Criterion ${index + 1} needs a title.`;
  return null;
}

function CriterionCard({ criterion, index, onChange, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: criterion.id });

  return (
    <Paper
      ref={setNodeRef}
      variant="outlined"
      sx={{
        p: 2,
        borderRadius: 2,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        bgcolor: 'background.paper'
      }}
    >
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <IconButton
          size="small"
          {...attributes}
          {...listeners}
          aria-label={`Reorder criterion ${index + 1}`}
          sx={{ cursor: 'grab', mt: 1 }}
        >
          <DragIndicatorIcon fontSize="small" />
        </IconButton>
        <Stack spacing={1.5} sx={{ flex: 1 }}>
          <TextField
            label={`Criterion ${index + 1}`}
            placeholder="e.g. Leadership"
            value={criterion.title}
            onChange={(event) => onChange({ ...criterion, title: event.target.value })}
            inputProps={{ maxLength: TITLE_MAX }}
            size="small"
            fullWidth
          />
          <TextField
            label="What strong and weak look like"
            placeholder={'Strong: …\nWeak: …'}
            value={criterion.description}
            onChange={(event) => onChange({ ...criterion, description: event.target.value })}
            inputProps={{ maxLength: DESCRIPTION_MAX }}
            size="small"
            multiline
            minRows={2}
            fullWidth
          />
        </Stack>
        <Tooltip title="Remove">
          <IconButton size="small" onClick={onRemove} aria-label={`Remove criterion ${index + 1}`} sx={{ mt: 1 }}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Paper>
  );
}

export default function RubricEditorDialog({
  open,
  phase,
  phaseLabel,
  mode = 'default',
  initialCriteria,
  onClose,
  onSaved
}) {
  const [criteria, setCriteria] = useState([]);
  const [saveAsDefault, setSaveAsDefault] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!open) return undefined;
    setError(null);
    setSaveAsDefault(true);

    const fill = (list) => setCriteria((list || []).map((item) => ({
      id: item.id || newId(),
      title: item.title || '',
      description: item.description || ''
    })));

    if (initialCriteria) {
      fill(initialCriteria);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    liveVoteApi.rubrics()
      .then(({ rubrics }) => !cancelled && fill(rubrics?.[phase]?.criteria))
      .catch((err) => !cancelled && setError(err.serverMessage || 'Could not load the rubric.'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, phase, initialCriteria]);

  const update = (id, next) => setCriteria((list) => list.map((item) => (item.id === id ? next : item)));
  const remove = (id) => setCriteria((list) => list.filter((item) => item.id !== id));
  const add = () => setCriteria((list) => [...list, { id: newId(), title: '', description: '' }]);

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setCriteria((list) => {
      const from = list.findIndex((item) => item.id === active.id);
      const to = list.findIndex((item) => item.id === over.id);
      return arrayMove(list, from, to);
    });
  };

  const save = async () => {
    const problem = validateCriteria(criteria);
    if (problem) {
      setError(problem);
      return;
    }
    const cleaned = criteria.map((item) => ({
      id: item.id,
      title: item.title.trim(),
      description: item.description.trim()
    }));

    if (mode === 'session') {
      onSaved?.({ criteria: cleaned, saveAsDefault });
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await liveVoteApi.saveRubric(phase, cleaned);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err.serverMessage || 'Could not save the rubric.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {mode === 'session' ? 'Rubric for this live vote' : 'Deliberation rubric'}
        <Typography variant="body2" color="text.secondary">
          {phaseLabel} · shown beside the vote to everyone in the room
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading ? (
          <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>
        ) : (
          <>
            {criteria.length === 0 && (
              <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary" gutterBottom>No criteria yet.</Typography>
              </Box>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={criteria.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack spacing={1.5}>
                  {criteria.map((criterion, index) => (
                    <CriterionCard
                      key={criterion.id}
                      criterion={criterion}
                      index={index}
                      onChange={(next) => update(criterion.id, next)}
                      onRemove={() => remove(criterion.id)}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
            <Button
              startIcon={<AddIcon />}
              onClick={add}
              disabled={criteria.length >= MAX_CRITERIA}
              sx={{ mt: 2 }}
            >
              Add criterion
            </Button>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, justifyContent: mode === 'session' ? 'space-between' : 'flex-end' }}>
        {mode === 'session' && (
          <FormControlLabel
            control={<Checkbox checked={saveAsDefault} onChange={(event) => setSaveAsDefault(event.target.checked)} />}
            label={`Also save as the default for ${phaseLabel}`}
          />
        )}
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={saving || loading}>
            {saving ? <CircularProgress size={18} color="inherit" /> : mode === 'session' ? 'Use this rubric' : 'Save rubric'}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
