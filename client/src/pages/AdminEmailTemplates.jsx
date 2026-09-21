import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  Chip,
  List,
  ListItemButton,
  ListItemText,
  CircularProgress,
  Alert,
  Divider,
  Tab,
  Tabs,
} from '@mui/material';
import {
  MarkEmailRead as MarkEmailReadIcon,
  AttachFile as AttachFileIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import EmailTemplateEditor from '../components/EmailTemplateEditor';

const AUDIENCE_COLORS = {
  Candidate: 'primary',
  Member: 'info',
  Admin: 'warning',
  'Any account': 'default',
  'Talent portal': 'secondary',
};

function AdminEmailTemplatesContent() {
  const [templates, setTemplates] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [tab, setTab] = useState('preview');
  // Bumped on every save, which is what re-runs the preview fetch below: the
  // whole point of editing here is seeing the email you just changed.
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    apiClient
      .get('/admin/email-templates')
      .then((data) => {
        if (cancelled) return;
        setTemplates(data);
        setSelectedKey((current) => current ?? data[0]?.key ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.serverMessage || 'Failed to load email templates');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedKey) return undefined;

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');

    apiClient
      .get(`/admin/email-templates/${encodeURIComponent(selectedKey)}/preview`)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(err.serverMessage || 'Failed to render this template');
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedKey, previewNonce]);

  // Grouped for scanning: an admin looking for "the email we send when someone
  // cancels" thinks in terms of what part of recruitment it belongs to.
  const grouped = useMemo(() => {
    const byCategory = new Map();
    for (const template of templates) {
      if (!byCategory.has(template.category)) byCategory.set(template.category, []);
      byCategory.get(template.category).push(template);
    }
    return [...byCategory.entries()];
  }, [templates]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <MarkEmailReadIcon color="primary" />
        <Typography variant="h4">Automatic emails</Typography>
      </Stack>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3, maxWidth: 760 }}>
        Every email the ATS sends on its own, rendered exactly as a recipient receives it,
        and editable. Names, dates and links below are stand-ins for preview only — nothing
        here is sent, and opening or editing a template emails nobody.
      </Typography>

      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: 'flex-start',
          gap: 3,
        }}
      >
        <Paper
          sx={{
            width: { xs: '100%', md: 320 },
            flexShrink: 0,
            maxHeight: { md: '72vh' },
            overflowY: 'auto',
          }}
        >
          {grouped.map(([category, entries], index) => (
            <Box key={category}>
              {index > 0 && <Divider />}
              <Typography
                variant="overline"
                sx={{ px: 2, pt: 2, display: 'block', color: 'text.secondary' }}
              >
                {category}
              </Typography>
              <List dense disablePadding>
                {entries.map((template) => (
                  <ListItemButton
                    key={template.key}
                    selected={template.key === selectedKey}
                    onClick={() => {
                      setSelectedKey(template.key);
                      setTab('preview');
                    }}
                  >
                    <ListItemText
                      primary={template.label}
                      secondary={template.audience}
                      slotProps={{ primary: { variant: 'body2' } }}
                    />
                    {template.customized && (
                      <Chip size="small" color="warning" variant="outlined" label="Edited" />
                    )}
                  </ListItemButton>
                ))}
              </List>
            </Box>
          ))}
        </Paper>

        <Paper sx={{ flex: 1, minWidth: 0, p: 3, width: { xs: '100%', md: 'auto' } }}>
          {previewLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
              <CircularProgress />
            </Box>
          )}

          {!previewLoading && previewError && <Alert severity="error">{previewError}</Alert>}

          {!previewLoading && !previewError && preview && (
            <Stack spacing={2}>
              <Box>
                <Stack
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  flexWrap="wrap"
                  useFlexGap
                  sx={{ mb: 0.5 }}
                >
                  <Typography variant="h6">{preview.label}</Typography>
                  <Chip
                    size="small"
                    label={preview.audience}
                    color={AUDIENCE_COLORS[preview.audience] || 'default'}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {preview.description}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {preview.trigger}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={preview.editable ? 'success' : 'default'}
                  label={preview.sourceLabel}
                  sx={{ mt: 1 }}
                />
              </Box>

              {preview.editable && (
                <Tabs
                  value={tab}
                  onChange={(event, next) => setTab(next)}
                  sx={{ borderBottom: 1, borderColor: 'divider' }}
                >
                  <Tab value="preview" label="Preview" />
                  <Tab value="edit" label="Edit wording" />
                </Tabs>
              )}

              {tab === 'edit' && preview.editable && (
                <EmailTemplateEditor
                  // Keyed, so switching templates builds a new editor rather
                  // than reusing this one. A save still in flight then lands on
                  // a component nobody is looking at, instead of putting one
                  // email's wording into another's boxes.
                  key={preview.copyKey}
                  templateKey={preview.copyKey}
                  onSaved={() => {
                    setPreviewNonce((n) => n + 1);
                    // The list carries an "Edited" badge per template, so it has
                    // to hear about a save as well as the preview does.
                    apiClient.get('/admin/email-templates').then(setTemplates).catch(() => {});
                  }}
                />
              )}

              {/*
                A builder returns subject and HTML only. Anything the send path
                bolts on afterwards, such as a calendar invite, cannot appear in
                the frame below, so the page says so rather than letting the
                preview imply the email arrives bare.
              */}
              {tab === 'preview' && preview.alsoAttaches && (
                <Alert severity="info" icon={<AttachFileIcon fontSize="inherit" />}>
                  Not shown below: {preview.alsoAttaches}
                </Alert>
              )}

              {tab === 'preview' && (
                <Box sx={{ bgcolor: 'action.hover', borderRadius: 1, p: 1.5 }}>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Subject line
                  </Typography>
                  <Typography variant="body1" sx={{ fontWeight: 500, wordBreak: 'break-word' }}>
                    {preview.subject}
                  </Typography>
                </Box>
              )}

              {/*
                An iframe, not dangerouslySetInnerHTML: these are whole email
                documents whose styles would otherwise bleed into the admin app.
                `sandbox` with no permissions blocks scripts and navigation,
                which also matches how a mail client treats the same markup.
              */}
              {tab === 'preview' && (
                <Box
                  component="iframe"
                  title={`${preview.label} preview`}
                  srcDoc={preview.html}
                  sandbox=""
                  sx={{
                    width: '100%',
                    height: { xs: 480, md: '58vh' },
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    bgcolor: '#ffffff',
                  }}
                />
              )}
            </Stack>
          )}
        </Paper>
      </Box>
    </Box>
  );
}

export default function AdminEmailTemplates() {
  return (
    <AccessControl allowedRoles={['ADMIN']}>
      <AdminEmailTemplatesContent />
    </AccessControl>
  );
}
