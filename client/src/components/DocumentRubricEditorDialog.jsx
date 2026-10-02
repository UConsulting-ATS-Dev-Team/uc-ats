import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  DOCUMENT_TYPE_LABELS,
  documentRubricApi,
  draftMaxOverall,
  formatScore,
  setDocumentRubrics
} from '../utils/documentRubrics';

// Editing the rubrics graders score documents against. Limits and rules match
// the server (normalizeRubric in server/src/services/documentRubrics.js).
//
// Each tab keeps its own draft, so switching tabs loses nothing; Save saves the
// tab in view. A category can be removed while one is left, and a new one
// added into any column (scoreOne/Two/Three) the type has free, so up to three
// per type. A save that would leave this cycle's scores outside the new range
// asks once, then saves - existing scores are never rescaled.

const TYPES = ['resume', 'coverLetter', 'video'];
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 1000;
const CRITERIA_MAX = 12;
const CRITERION_LABEL_MAX = 20;
const CRITERION_TEXT_MAX = 1000;
const SCORE_CEILING = 100;

const AGGREGATION_NOTE = {
  resume: 'The overall resume score is the sum of these categories.',
  coverLetter: 'The overall score is the average of these categories.',
  video: 'The overall video score is the sum of these categories.'
};

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;

/** A server rubric as an editable draft: numbers as strings, criteria rows keyed. */
const toDraft = (rubric) => ({
  categories: rubric.categories.map((category) => ({
    ...category,
    min: String(category.min),
    max: String(category.max),
    criteria: category.criteria.map((row) => ({ ...row, key: rowKey() }))
  }))
});

const fromDraft = (draft) => ({
  categories: draft.categories.map((category) => ({
    id: category.id,
    title: category.title,
    description: category.description,
    min: Number(category.min),
    max: Number(category.max),
    criteria: category.criteria.map(({ label, text }) => ({ label, text }))
  }))
});

/** The first thing wrong with a draft, said the way the server would, or null. */
export function draftProblem(draft) {
  for (const [index, category] of draft.categories.entries()) {
    const name = category.title.trim() || `Category ${index + 1}`;
    if (!category.title.trim()) return `Category ${index + 1} needs a title.`;
    if (category.title.length > TITLE_MAX) return `${name}'s title is over ${TITLE_MAX} characters.`;
    if (category.description.length > DESCRIPTION_MAX) return `${name}'s description is over ${DESCRIPTION_MAX} characters.`;
    if (!/^\d+$/.test(category.min) || !/^\d+$/.test(category.max)) {
      return `${name}'s range must be whole numbers.`;
    }
    const min = Number(category.min);
    const max = Number(category.max);
    if (max > SCORE_CEILING) return `${name}'s maximum can be at most ${SCORE_CEILING}.`;
    if (min >= max) return `${name}'s maximum must be above its minimum.`;
    const filled = category.criteria.filter((row) => row.label.trim() || row.text.trim());
    if (filled.length > CRITERIA_MAX) return `${name} can have at most ${CRITERIA_MAX} criteria.`;
    if (filled.some((row) => !row.label.trim() || !row.text.trim())) {
      return `Every criterion under ${name} needs both a score and a description.`;
    }
    if (filled.some((row) => labelTooLong(row))) {
      return `A score label under ${name} is over ${CRITERION_LABEL_MAX} characters.`;
    }
    if (filled.some((row) => textTooLong(row))) {
      return `A criterion under ${name} is over ${CRITERION_TEXT_MAX} characters.`;
    }
  }
  return null;
}

const labelTooLong = (row) => row.label.trim().length > CRITERION_LABEL_MAX;
const textTooLong = (row) => row.text.trim().length > CRITERION_TEXT_MAX;

/**
 * Criterion labels ("7-10", "3") that name a score outside the category's
 * range - usually wording left over from before the range changed. Not an
 * error: a label is free text, and "10+" or "N/A" are fine to write.
 */
export function labelsOutsideRange(category) {
  const min = Number(category.min);
  const max = Number(category.max);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return [];
  return category.criteria
    .map((row) => row.label.trim())
    .filter((label) => {
      const match = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(label);
      if (!match) return false;
      const low = Number(match[1]);
      const high = match[2] !== undefined ? Number(match[2]) : low;
      return low < min || high > max;
    });
}

const sameRubric = (a, b) => JSON.stringify(fromDraft(a)) === JSON.stringify(fromDraft(b));

/** A type's score columns from the server, or failing that the ones its saved rubric and draft use. */
const SLOT_ORDER = ['scoreOne', 'scoreTwo', 'scoreThree'];
const slotsFor = (info, draft) => info?.slots
  || SLOT_ORDER.filter((id) => [...(info?.rubric?.categories || []), ...draft.categories].some((c) => c.id === id));

const blankCategory = (id) => ({ id, title: '', description: '', min: '1', max: '3', criteria: [] });

function CategoryEditor({ category, index, onChange, onRemove }) {
  const set = (field) => (event) => onChange({ ...category, [field]: event.target.value });
  const setRow = (key, field, value) => onChange({
    ...category,
    criteria: category.criteria.map((row) => (row.key === key ? { ...row, [field]: value } : row))
  });
  const removeRow = (key) => onChange({ ...category, criteria: category.criteria.filter((row) => row.key !== key) });
  const addRow = () => onChange({ ...category, criteria: [...category.criteria, { key: rowKey(), label: '', text: '' }] });

  const rangeInvalid = !/^\d+$/.test(category.min) || !/^\d+$/.test(category.max)
    || Number(category.min) >= Number(category.max) || Number(category.max) > SCORE_CEILING;
  const staleLabels = rangeInvalid ? [] : labelsOutsideRange(category);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="overline" color="text.secondary">Category {index + 1}</Typography>
        <Tooltip title={onRemove ? 'Remove category' : 'A rubric needs at least one category'}>
          <span>
            <IconButton
              aria-label={`Remove ${category.title.trim() || `category ${index + 1}`}`}
              onClick={onRemove}
              disabled={!onRemove}
              size="small"
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Stack spacing={2} sx={{ mt: 0.5 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            label="Title"
            value={category.title}
            onChange={set('title')}
            error={!category.title.trim() || category.title.length > TITLE_MAX}
            size="small"
            fullWidth
          />
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            <TextField
              label="Min"
              value={category.min}
              onChange={set('min')}
              error={rangeInvalid}
              size="small"
              inputProps={{ inputMode: 'numeric' }}
              sx={{ width: 80 }}
            />
            <TextField
              label="Max"
              value={category.max}
              onChange={set('max')}
              error={rangeInvalid}
              size="small"
              inputProps={{ inputMode: 'numeric' }}
              sx={{ width: 80 }}
            />
          </Stack>
        </Stack>

        <TextField
          label="Description"
          value={category.description}
          onChange={set('description')}
          error={category.description.length > DESCRIPTION_MAX}
          size="small"
          multiline
          minRows={2}
          fullWidth
        />

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Scoring criteria</Typography>
          {staleLabels.length > 0 && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {staleLabels.map((label) => `"${label}"`).join(', ')}{' '}
              {staleLabels.length === 1 ? 'is' : 'are'} outside the {category.min}–{category.max} range.
              Update the criteria so graders are not pointed at scores they cannot give.
            </Alert>
          )}
          <Stack spacing={1}>
            {category.criteria.map((row, rowIndex) => (
              <Stack key={row.key} direction="row" spacing={1} alignItems="flex-start">
                <TextField
                  label="Score"
                  placeholder="4-6"
                  value={row.label}
                  onChange={(event) => setRow(row.key, 'label', event.target.value)}
                  error={(!row.label.trim() && Boolean(row.text.trim())) || labelTooLong(row)}
                  size="small"
                  inputProps={{ 'aria-label': `Criterion ${rowIndex + 1} score`, maxLength: CRITERION_LABEL_MAX }}
                  sx={{ width: 96, flexShrink: 0 }}
                />
                <TextField
                  label="What this score looks like"
                  value={row.text}
                  onChange={(event) => setRow(row.key, 'text', event.target.value)}
                  error={(!row.text.trim() && Boolean(row.label.trim())) || textTooLong(row)}
                  helperText={textTooLong(row) ? `${row.text.trim().length}/${CRITERION_TEXT_MAX}` : undefined}
                  size="small"
                  multiline
                  fullWidth
                  inputProps={{ 'aria-label': `Criterion ${rowIndex + 1} description` }}
                />
                <Tooltip title="Remove criterion">
                  <IconButton aria-label={`Remove criterion ${rowIndex + 1}`} onClick={() => removeRow(row.key)} size="small" sx={{ mt: 0.5 }}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={addRow}
            disabled={category.criteria.length >= CRITERIA_MAX}
            sx={{ mt: 1 }}
          >
            Add criterion
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}

export default function DocumentRubricEditorDialog({ open, onClose }) {
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [type, setType] = useState('resume');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  /**
   * A preview that found scores outside the new range, waiting on "Save anyway".
   * Holds what it previewed - which tab, save or reset, and the exact rubric -
   * so confirming acts on that and nothing typed or selected since.
   */
  const [pendingWarning, setPendingWarning] = useState(null);

  const adoptAll = (next) => {
    setData(next);
    setDrafts(Object.fromEntries(TYPES.map((key) => [key, toDraft(next.rubrics[key].rubric)])));
    setDocumentRubrics(next);
  };

  // A save answers with every rubric, but only the saved one's draft is
  // replaced: the other tabs keep whatever the admin has typed there.
  const adoptOne = (next, key) => {
    setData(next);
    setDrafts((prev) => ({ ...prev, [key]: toDraft(next.rubrics[key].rubric) }));
    setDocumentRubrics(next);
  };

  useEffect(() => {
    if (!open) return undefined;
    setError(null);
    setSaved(null);
    setPendingWarning(null);
    let cancelled = false;
    setLoading(true);
    documentRubricApi.all()
      .then((next) => { if (!cancelled) adoptAll(next); })
      .catch((err) => { if (!cancelled) setError(err.serverMessage || 'Could not load the rubrics.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const draft = drafts[type];
  const current = data?.rubrics?.[type];
  const dirty = (key) => Boolean(drafts[key] && data && !sameRubric(drafts[key], toDraft(data.rubrics[key].rubric)));
  const anyDirty = TYPES.some(dirty);
  const problem = draft ? draftProblem(draft) : null;

  // Staging adds the three documents' overall scores (plus participation), so
  // a type's maximum is also its weight in the ranking. Say so as it changes.
  const weight = useMemo(() => {
    if (!data || !draft) return null;
    const draftMax = problem ? current.maxOverall : draftMaxOverall(type, fromDraft(draft));
    const others = TYPES.filter((key) => key !== type).reduce((sum, key) => sum + data.rubrics[key].maxOverall, 0);
    return { draftMax, total: draftMax + others + data.participationMax };
  }, [data, draft, type, problem, current]);

  const editCategories = (change) => {
    if (saving) return;
    setSaved(null);
    setPendingWarning(null);
    setDrafts((prev) => ({ ...prev, [type]: { categories: change(prev[type].categories) } }));
  };

  const updateCategory = (index, next) =>
    editCategories((categories) => categories.map((category, i) => (i === index ? next : category)));

  const removeCategory = (index) => editCategories((categories) => categories.filter((_, i) => i !== index));

  // Saved categories this draft leaves out: what a save would remove.
  const removedTitles = draft && current
    ? current.rubric.categories.filter((saved) => !draft.categories.some((c) => c.id === saved.id)).map((c) => c.title)
    : [];

  // A category removed but not yet saved comes back as it was; otherwise blank.
  const freeSlots = draft ? slotsFor(current, draft).filter((id) => !draft.categories.some((c) => c.id === id)) : [];
  const addCategory = () => {
    const [id] = freeSlots;
    const savedCategory = current.rubric.categories.find((category) => category.id === id);
    const added = savedCategory ? toDraft({ categories: [savedCategory] }).categories[0] : blankCategory(id);
    const order = slotsFor(current, draft);
    editCategories((categories) => [...categories, added]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
  };

  /**
   * Save or reset one tab. Everything it acts on is fixed when it starts:
   * `key` and `rubric` are captured here, not read from state afterwards, so
   * switching tabs while it runs cannot point it at another rubric. Tabs and
   * fields are also locked while `saving`.
   */
  const run = async ({ action, key, rubric, confirmed = false }) => {
    setSaving(true);
    setError(null);
    setSaved(null);
    setPendingWarning(null);
    const label = DOCUMENT_TYPE_LABELS[key];
    try {
      if (!confirmed) {
        const preview = action === 'reset'
          ? await documentRubricApi.previewReset(key)
          : await documentRubricApi.preview(key, rubric);
        if (preview?.outOfRange?.count > 0) {
          setPendingWarning({ action, key, rubric, outOfRange: preview.outOfRange });
          return;
        }
      }
      if (action === 'reset') {
        adoptOne(await documentRubricApi.reset(key), key);
        setSaved(`${label} rubric is back to the default.`);
      } else {
        adoptOne(await documentRubricApi.save(key, rubric), key);
        setSaved(`${label} rubric saved. Graders see it the next time they open a document.`);
      }
    } catch (err) {
      setError(err.serverMessage || `Could not ${action === 'reset' ? 'reset' : 'save'} the rubric.`);
    } finally {
      setSaving(false);
    }
  };

  const save = () => run({ action: 'save', key: type, rubric: fromDraft(draft) });
  const reset = () => run({ action: 'reset', key: type });
  const confirmPending = () => run({ ...pendingWarning, confirmed: true });

  const close = () => {
    if (anyDirty && !window.confirm('Discard your unsaved rubric changes?')) return;
    onClose();
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : close} maxWidth="md" fullWidth>
      <DialogTitle>Document grading rubrics</DialogTitle>
      <Tabs
        value={type}
        onChange={(_, value) => {
          if (saving) return;
          setType(value);
          setSaved(null);
          setPendingWarning(null);
          setError(null);
        }}
        sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        {TYPES.map((key) => (
          <Tab key={key} value={key} disabled={saving && key !== type} label={`${DOCUMENT_TYPE_LABELS[key]}${dirty(key) ? ' •' : ''}`} />
        ))}
      </Tabs>
      <DialogContent>
        {loading || !draft ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
          </Box>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              What graders see beside the document. {AGGREGATION_NOTE[type]}
              {!current.customized && ' This rubric has not been edited and is using the default.'}
            </Typography>

            {weight && (
              <Alert severity="info" icon={false}>
                {DOCUMENT_TYPE_LABELS[type]} counts for up to <strong>{formatScore(weight.draftMax)}</strong> of
                the <strong>{formatScore(weight.total)}</strong>-point overall in Staging&apos;s Resume Review ranking,
                which adds the three documents&apos; scores and up to {data.participationMax} participation points.
                Raising a range gives this document more weight there.
              </Alert>
            )}

            {removedTitles.length > 0 && (
              <Alert severity="warning">
                Removing {removedTitles.join(' and ')}: graders stop seeing it, and new grades leave it out of the
                overall. Documents already graded keep the overall they were given until someone re-saves them.
              </Alert>
            )}

            {draft.categories.map((category, index) => (
              <CategoryEditor
                key={category.id}
                category={category}
                index={index}
                onChange={(next) => updateCategory(index, next)}
                onRemove={draft.categories.length > 1 ? () => removeCategory(index) : undefined}
              />
            ))}

            {freeSlots.length > 0 && (
              <Box>
                <Button startIcon={<AddIcon />} onClick={addCategory} disabled={saving}>
                  Add category
                </Button>
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>
      {/* Outcome of the last action, kept in view: the form scrolls, these must not. */}
      {draft && !loading && (error || saved || pendingWarning) && (
        <Stack spacing={1} sx={{ px: 3, pt: 2 }}>
          {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
          {saved && <Alert severity="success" onClose={() => setSaved(null)}>{saved}</Alert>}
          {pendingWarning && (
            <Alert
              severity="warning"
              action={(
                <Button color="inherit" size="small" onClick={confirmPending} disabled={saving} sx={{ whiteSpace: 'nowrap' }}>
                  {pendingWarning.action === 'reset' ? 'Reset anyway' : 'Save anyway'}
                </Button>
              )}
            >
              {pendingWarning.outOfRange.count} {DOCUMENT_TYPE_LABELS[pendingWarning.key].toLowerCase()}{' '}
              {pendingWarning.outOfRange.count === 1 ? 'score' : 'scores'}
              {pendingWarning.outOfRange.cycleName ? ` in ${pendingWarning.outOfRange.cycleName}` : ''} fall outside
              {pendingWarning.action === 'reset' ? " the default's range." : ' the new range.'}
              They keep the values they were graded with; nothing is rescaled.
            </Alert>
          )}
        </Stack>
      )}
      <DialogActions sx={{ px: 3, py: 2, gap: 1 }}>
        {current?.customized && (
          <Button color="inherit" onClick={reset} disabled={saving}>
            Reset to default
          </Button>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {problem && draft && (
            <Typography variant="caption" color="error">{problem}</Typography>
          )}
        </Box>
        <Button onClick={close} disabled={saving}>Close</Button>
        <Button
          variant="contained"
          onClick={save}
          disabled={saving || loading || !draft || Boolean(problem) || !dirty(type) || Boolean(pendingWarning)}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
