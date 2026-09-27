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
import SendTestButton from './SendTestButton';

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
const DEFAULT_SIGNATURE = '__default__';

const defaultSignature = (signatures) => signatures?.find((s) => s.isDefault) ?? null;

// A stored id whose signature was deleted behaves as unset on the server, so
// it is shown and saved as unset here too - saving it back would be refused.
const liveSignatureId = (id, signatures) =>
  id && id !== 'OWN' && signatures && !signatures.some((s) => s.id === id) ? null : id ?? null;

function signatureHelp(signatureId, signatures) {
  if (signatureId === 'OWN') return 'Ends with the sign-off in its wording (Edit wording tab).';
  if (signatureId && signatures && !signatures.some((s) => s.id === signatureId)) {
    return 'That signature was deleted, so this email uses the default.';
  }
  return 'Manage signatures in the Signatures tab at the top of the page.';
}
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export default function EmailStyleEditor({ templateKey, previewKey, onSaved }) {
  const [style, setStyle] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  // null until loaded, so "not loaded" and "none exist" stay different.
  const [signatures, setSignatures] = useState(null);

  // The picker's options. A failure only costs the list; the email's own
  // sign-off and the default stay choosable.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/admin/email-templates/signatures')
      .then((data) => {
        if (!cancelled) setSignatures(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    () =>
      Boolean(style && draft) &&
      (draft.format !== style.values.format ||
        draft.banner !== style.values.banner ||
        (draft.signatureId ?? null) !== (style.values.signatureId ?? null)),
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
      () =>
        apiClient.put(`/admin/email-templates/${encodeURIComponent(templateKey)}/style`, {
          style: { ...draft, signatureId: liveSignatureId(draft.signatureId, signatures) },
        }),
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
        // Beside the controls from a laptop width up, at near phone width.
        gridTemplateColumns: { xs: '1fr', lg: 'minmax(260px, 300px) 1fr' },
        gap: 3,
        alignItems: 'start',
      }}
    >
      <Stack spacing={2.5} sx={{ maxWidth: { xs: 440, lg: 'none' } }}>
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

        {style.takesSignature ? (
          <TextField
            select
            fullWidth
            label="Signature"
            value={liveSignatureId(draft.signatureId, signatures) ?? DEFAULT_SIGNATURE}
            onChange={(event) =>
              update({ signatureId: event.target.value === DEFAULT_SIGNATURE ? null : event.target.value })
            }
            helperText={signatureHelp(draft.signatureId, signatures)}
          >
            <MenuItem value={DEFAULT_SIGNATURE}>
              {defaultSignature(signatures) ? `Default (${defaultSignature(signatures).name})` : 'Default (none set yet: its own sign-off)'}
            </MenuItem>
            <MenuItem value="OWN">This email&apos;s own sign-off</MenuItem>
            {(signatures ?? []).map((signature) => (
              <MenuItem key={signature.id} value={signature.id}>
                {signature.name}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Typography variant="caption" color="text.secondary">
            This email&apos;s closing is part of its wording, so signatures do not apply to it.
          </Typography>
        )}

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

      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        <EmailPreviewFrame preview={preview} />
        <SendTestButton
          key={previewKey}
          previewKey={previewKey}
          draft={dirty && customValid ? { style: { ...draft, signatureId: liveSignatureId(draft.signatureId, signatures) } } : null}
          blockedReason={customValid ? null : 'Fix the header colour to send a test of these changes.'}
        />
      </Stack>
    </Box>
  );
}
