import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { RestartAlt as RestartAltIcon, Save as SaveIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

/**
 * The wording of one automatic email, in boxes an admin can type into.
 *
 * Each box starts holding the words that email actually uses today - the
 * shipped sentence, or whatever somebody wrote over it. Editing the real text
 * is the only version of this that works: an empty box beside a "default"
 * label makes an admin retype a paragraph to change one word in it.
 *
 * What that costs is that a save arrives carrying every field, including the
 * ones nobody touched. The server drops any field that still matches the
 * shipped wording, so "customized" keeps meaning somebody changed it, and a
 * sentence reworded in the code still reaches the templates nobody has edited.
 */

const FIELD_ROWS = { signoff: 2, block: 4 };

export default function EmailTemplateEditor({ templateKey, onSaved }) {
  const [copy, setCopy] = useState(null);
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  const effective = (field) => field.value || field.default;

  const fill = (data) =>
    Object.fromEntries(data.fields.map((field) => [field.name, effective(field)]));

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setLoadError('');
    setSaveError('');
    setSaved(false);

    apiClient
      .get(`/admin/email-templates/${encodeURIComponent(templateKey)}/copy`)
      .then((data) => {
        // A slow read for the template an admin has already clicked away from
        // must not land in the boxes. Without this, its fields would fill the
        // editor for a different email, and Save would post them under the new
        // template's key - rewording the wrong email.
        if (cancelled) return;
        setCopy(data);
        setDraft(fill(data));
      })
      .catch((err) => {
        if (cancelled) return;
        setCopy(null);
        setLoadError(err.serverMessage || 'Failed to load this template for editing');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `fill` closes over nothing that changes between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey]);

  const dirty = useMemo(() => {
    if (!copy) return false;
    return copy.fields.some((field) => (draft[field.name] ?? '') !== effective(field));
  }, [copy, draft]);

  const setField = (name, value) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setSaved(false);
    setSaveError('');
  };

  const finish = (data) => {
    setCopy(data);
    setDraft(fill(data));
    setSaved(true);
    onSaved?.(data);
  };

  const save = () => {
    setSaving(true);
    setSaveError('');
    apiClient
      .put(`/admin/email-templates/${encodeURIComponent(templateKey)}/copy`, { copy: draft })
      .then(finish)
      .catch((err) => setSaveError(err.serverMessage || 'Failed to save this wording'))
      .finally(() => setSaving(false));
  };

  const resetAll = () => {
    setSaving(true);
    setSaveError('');
    apiClient
      .delete(`/admin/email-templates/${encodeURIComponent(templateKey)}/copy`)
      .then(finish)
      .catch((err) => setSaveError(err.serverMessage || 'Failed to restore the original wording'))
      .finally(() => setSaving(false));
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (loadError) return <Alert severity="error">{loadError}</Alert>;
  if (!copy) return null;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="body2" color="text.secondary">
          Change what this email says. The layout, the boxes built from a candidate&apos;s own
          details, the buttons and any attachment are drawn by the ATS and are not editable
          here — so an edit can change the words and cannot stop the email working.
        </Typography>
        {copy.mergeFields.length > 0 && (
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5, mt: 0.4 }}>
              Fill-ins you can use:
            </Typography>
            {copy.mergeFields.map((name) => (
              <Chip
                key={name}
                size="small"
                variant="outlined"
                label={`{{${name}}}`}
                sx={{ fontFamily: 'monospace' }}
              />
            ))}
          </Stack>
        )}
      </Box>

      {copy.fields.map((field) => {
        const value = draft[field.name] ?? '';
        const changed = value.trim() !== field.default.trim();

        return (
          <Box key={field.name}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2">{field.label}</Typography>
              {changed && <Chip size="small" color="warning" variant="outlined" label="Changed" />}
              {changed && (
                <Button
                  size="small"
                  onClick={() => setField(field.name, field.default)}
                  sx={{ minWidth: 0 }}
                >
                  Undo
                </Button>
              )}
            </Stack>
            <TextField
              fullWidth
              multiline={field.type !== 'line'}
              minRows={FIELD_ROWS[field.type] ?? 1}
              value={value}
              onChange={(event) => setField(field.name, event.target.value)}
              helperText={field.help || undefined}
              slotProps={{ htmlInput: { 'aria-label': field.label } }}
            />
          </Box>
        );
      })}

      {saveError && <Alert severity="error">{saveError}</Alert>}
      {saved && !dirty && (
        <Alert severity="success">
          Saved. The preview above now shows what this email will say.
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={saving || !dirty}
          onClick={save}
        >
          Save wording
        </Button>
        <Button
          startIcon={<RestartAltIcon />}
          color="inherit"
          disabled={saving || !copy.customized}
          onClick={resetAll}
        >
          Restore the original
        </Button>
        {saving && <CircularProgress size={20} />}
        {copy.customized && !saving && (
          <Typography variant="caption" color="text.secondary">
            Edited{copy.updatedAt ? ` on ${new Date(copy.updatedAt).toLocaleDateString()}` : ''}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
