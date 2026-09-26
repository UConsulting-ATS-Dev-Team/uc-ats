import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { RestartAlt as RestartAltIcon, Save as SaveIcon } from '@mui/icons-material';
import apiClient from '../utils/api';
import useDraftPreview from '../hooks/useDraftPreview';
import EmailPreviewFrame from './EmailPreviewFrame';

/**
 * The look every automatic email shares: brand, logo, colours, font, footer.
 *
 * Saving applies to every email that is Designed. A Plain email uses only the
 * font and the link colour, since it has no header or footer to draw.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const COLOURS = [
  { field: 'headerBackground', label: 'Header background' },
  { field: 'headerTextColor', label: 'Header text' },
  { field: 'accentColor', label: 'Buttons and links' },
];

// Emails worth checking a theme against: one per header style.
const SAMPLE_KEYS = ['application-acceptance', 'meeting-signup-confirmation', 'password-reset', 'slot-confirmation'];

function ColourField({ label, value, onChange }) {
  const valid = HEX.test(value);
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Box
        component="input"
        type="color"
        aria-label={`Pick ${label.toLowerCase()}`}
        value={valid && value.length === 7 ? value : '#000000'}
        onChange={(event) => onChange(event.target.value)}
        sx={{ width: 44, height: 40, mt: 0.5, p: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
      />
      <TextField
        fullWidth
        size="small"
        label={label}
        value={value}
        error={!valid}
        helperText={valid ? undefined : 'Like #0C74C1'}
        onChange={(event) => onChange(event.target.value.trim())}
      />
    </Stack>
  );
}

export default function EmailThemeEditor({ templates = [], onSaved }) {
  const [theme, setTheme] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  const samples = useMemo(() => {
    const byKey = new Map(templates.map((t) => [t.key, t]));
    const picked = SAMPLE_KEYS.map((key) => byKey.get(key)).filter(Boolean);
    return picked.length ? picked : templates.slice(0, 1);
  }, [templates]);
  const [sampleKey, setSampleKey] = useState(null);
  const previewKey = sampleKey ?? samples[0]?.key ?? null;

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/admin/email-templates/theme')
      .then((data) => {
        if (cancelled) return;
        setTheme(data);
        setDraft(data.values);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.serverMessage || 'Failed to load the email theme');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const coloursValid = draft ? COLOURS.every(({ field }) => HEX.test(draft[field] ?? '')) : false;
  const dirty = useMemo(
    () => Boolean(theme && draft) && Object.keys(draft).some((field) => (draft[field] ?? '') !== (theme.values[field] ?? '')),
    [theme, draft]
  );

  // Only preview a draft the server would accept; a half-typed hex would
  // otherwise flash an error on every keystroke.
  const preview = useDraftPreview(previewKey, draft && coloursValid ? { theme: draft } : null);

  const update = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setSaveError('');
  };

  const run = (request, fallback) => {
    setSaving(true);
    setSaveError('');
    request()
      .then((data) => {
        setTheme(data);
        setDraft(data.values);
        setSaved(true);
        onSaved?.(data);
      })
      .catch((err) => setSaveError(err.serverMessage || fallback))
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
  if (!theme || !draft) return null;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(280px, 360px) 1fr' },
        gap: 3,
        alignItems: 'start',
      }}
    >
      <Stack spacing={2.5}>
        <Typography variant="body2" color="text.secondary">
          Every automatic email is drawn in this theme. Colours of individual emails, and whether
          one goes out Designed or Plain, are set on that email&apos;s Style tab.
        </Typography>

        <TextField
          label="Brand name"
          value={draft.brandName ?? ''}
          placeholder="Each email's own (e.g. UConsulting ATS)"
          helperText="Shown in the header. Leave blank to keep each email's own name."
          onChange={(event) => update('brandName', event.target.value)}
        />

        <TextField
          label="Logo URL"
          value={draft.logoUrl ?? ''}
          placeholder="https://…"
          helperText="Optional. An https:// image, shown instead of the brand name. About 48px tall."
          onChange={(event) => update('logoUrl', event.target.value.trim())}
        />

        {COLOURS.map(({ field, label }) => (
          <ColourField key={field} label={label} value={draft[field] ?? ''} onChange={(value) => update(field, value)} />
        ))}

        <TextField select label="Font" value={draft.fontFamily} onChange={(event) => update('fontFamily', event.target.value)}>
          {theme.fonts.map((font) => (
            <MenuItem key={font.id} value={font.id}>
              {font.label}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          label="Footer"
          multiline
          minRows={2}
          value={draft.footerText ?? ''}
          helperText="Plain text at the bottom of every Designed email. Leave blank for no footer."
          onChange={(event) => update('footerText', event.target.value)}
        />

        {saveError && <Alert severity="error">{saveError}</Alert>}
        {saved && !dirty && <Alert severity="success">Saved. Every automatic email now uses this theme.</Alert>}

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={saving || !dirty || !coloursValid}
            onClick={() => run(() => apiClient.put('/admin/email-templates/theme', { theme: draft }), 'Failed to save the theme')}
          >
            Save theme
          </Button>
          <Button
            startIcon={<RestartAltIcon />}
            color="inherit"
            disabled={saving || !theme.customized}
            onClick={() => run(() => apiClient.delete('/admin/email-templates/theme'), 'Failed to restore the original theme')}
          >
            Restore the original
          </Button>
          {saving && <CircularProgress size={20} />}
        </Stack>
      </Stack>

      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        {samples.length > 1 && (
          <TextField
            select
            size="small"
            label="Preview with"
            value={previewKey ?? ''}
            onChange={(event) => setSampleKey(event.target.value)}
            sx={{ maxWidth: 360 }}
          >
            {samples.map((sample) => (
              <MenuItem key={sample.key} value={sample.key}>
                {sample.label}
              </MenuItem>
            ))}
          </TextField>
        )}
        <EmailPreviewFrame preview={preview} />
      </Stack>
    </Box>
  );
}
