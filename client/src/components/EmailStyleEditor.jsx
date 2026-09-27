import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { RestartAlt as RestartAltIcon, Save as SaveIcon } from '@mui/icons-material';
import apiClient from '../utils/api';
import useDraftPreview from '../hooks/useDraftPreview';
import EmailPreviewFrame from './EmailPreviewFrame';

/**
 * How one automatic email looks: Designed or Plain, and its header colour.
 *
 * The preview beside the controls renders the draft on the server, through
 * the same layout the send path uses, so what an admin sees here is what
 * would go out - not a client-side imitation of it.
 */

const TONE_LABELS = {
  brand: 'Theme header',
  success: 'Green',
  danger: 'Red',
  warning: 'Orange',
  info: 'Blue',
};

const CUSTOM = 'custom';
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export default function EmailStyleEditor({ templateKey, previewKey, onSaved }) {
  const [style, setStyle] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    apiClient
      .get(`/admin/email-templates/${encodeURIComponent(templateKey)}/style`)
      .then((data) => {
        if (cancelled) return;
        setStyle(data);
        setDraft(data.values);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.serverMessage || 'Failed to load this email style');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateKey]);

  const dirty = useMemo(
    () => Boolean(style && draft) && (draft.format !== style.values.format || draft.banner !== style.values.banner),
    [style, draft]
  );

  const bannerIsCustom = draft && !(style?.tones ?? []).includes(draft.banner);
  const customValid = !bannerIsCustom || HEX.test(draft?.banner ?? '');

  const preview = useDraftPreview(previewKey, draft && customValid ? { style: draft } : null);

  const update = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    setSaveError('');
  };

  const finish = (data) => {
    setStyle(data);
    setDraft(data.values);
    setSaved(true);
    onSaved?.(data);
  };

  const run = (request, fallback) => {
    setSaving(true);
    setSaveError('');
    request()
      .then(finish)
      .catch((err) => setSaveError(err.serverMessage || fallback))
      .finally(() => setSaving(false));
  };

  const save = () =>
    run(
      () => apiClient.put(`/admin/email-templates/${encodeURIComponent(templateKey)}/style`, { style: draft }),
      'Failed to save this style'
    );

  const reset = () =>
    run(
      () => apiClient.delete(`/admin/email-templates/${encodeURIComponent(templateKey)}/style`),
      'Failed to restore the original style'
    );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (loadError) return <Alert severity="error">{loadError}</Alert>;
  if (!style || !draft) return null;

  const plain = draft.format === 'PLAIN';

  return (
    <Box
      sx={{
        display: 'grid',
        // This sits inside the detail panel, beside the template list, so it
        // only has room for the email next to the controls on a wide screen.
        gridTemplateColumns: { xs: '1fr', xl: 'minmax(260px, 300px) 1fr' },
        gap: 3,
        alignItems: 'start',
      }}
    >
      <Stack spacing={2.5} sx={{ maxWidth: 440 }}>
        <FormControl>
          <FormLabel id="email-format-label">Format</FormLabel>
          <RadioGroup
            aria-labelledby="email-format-label"
            value={draft.format}
            onChange={(event) => update({ format: event.target.value })}
          >
            <FormControlLabel
              value="DESIGNED"
              sx={{ alignItems: 'flex-start' }}
              control={<Radio sx={{ pt: 0.25 }} />}
              label={
                <Box>
                  <Typography variant="body2">Designed</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Header, coloured detail boxes, buttons and footer
                  </Typography>
                </Box>
              }
            />
            <FormControlLabel
              value="PLAIN"
              control={<Radio sx={{ pt: 0.25 }} />}
              sx={{ mt: 1, alignItems: 'flex-start' }}
              label={
                <Box>
                  <Typography variant="body2">Plain</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Reads like a normal email from a person. Same details, as lines of text
                  </Typography>
                </Box>
              }
            />
          </RadioGroup>
        </FormControl>

        <Box>
          <TextField
            select
            fullWidth
            label="Header colour"
            value={bannerIsCustom ? CUSTOM : draft.banner}
            disabled={plain}
            helperText={plain ? 'Plain emails have no header.' : undefined}
            onChange={(event) =>
              update({ banner: event.target.value === CUSTOM ? '#042742' : event.target.value })
            }
          >
            {style.tones.map((tone) => (
              <MenuItem key={tone} value={tone}>
                {TONE_LABELS[tone] ?? tone}
                {tone === style.defaults.banner ? ' (original)' : ''}
              </MenuItem>
            ))}
            <MenuItem value={CUSTOM}>Custom colour…</MenuItem>
          </TextField>

          {bannerIsCustom && !plain && (
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1.5 }}>
              <Box
                component="input"
                type="color"
                aria-label="Pick header colour"
                value={HEX.test(draft.banner) && draft.banner.length === 7 ? draft.banner : '#042742'}
                onChange={(event) => update({ banner: event.target.value })}
                sx={{ width: 44, height: 40, p: 0, border: 'none', background: 'none', cursor: 'pointer' }}
              />
              <TextField
                size="small"
                label="Hex"
                value={draft.banner}
                error={!customValid}
                helperText={customValid ? undefined : 'Like #0C74C1'}
                onChange={(event) => update({ banner: event.target.value.trim() })}
                slotProps={{ htmlInput: { 'aria-label': 'Header colour hex' } }}
              />
            </Stack>
          )}
        </Box>

        <Typography variant="caption" color="text.secondary">
          Brand, logo, fonts and footer are shared by every email. Change them in the Theme tab
          at the top of the page.
        </Typography>

        {saveError && <Alert severity="error">{saveError}</Alert>}
        {saved && !dirty && <Alert severity="success">Saved. The next one of these emails goes out like this.</Alert>}

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={saving || !dirty || !customValid}
            onClick={save}
          >
            Save style
          </Button>
          <Button
            startIcon={<RestartAltIcon />}
            color="inherit"
            disabled={saving || !style.customized}
            onClick={reset}
          >
            Restore the original
          </Button>
          {saving && <CircularProgress size={20} />}
        </Stack>
      </Stack>

      <EmailPreviewFrame preview={preview} />
    </Box>
  );
}
