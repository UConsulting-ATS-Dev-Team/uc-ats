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
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  InputAdornment,
} from '@mui/material';
import {
  MarkEmailRead as MarkEmailReadIcon,
  AttachFile as AttachFileIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import EmailTemplateEditor from '../components/EmailTemplateEditor';
import EmailStyleEditor from '../components/EmailStyleEditor';
import EmailThemeEditor from '../components/EmailThemeEditor';
import EmailSignaturesEditor from '../components/EmailSignaturesEditor';
import SendTestButton from '../components/SendTestButton';

const AUDIENCE_COLORS = {
  Candidate: 'primary',
  Member: 'info',
  Admin: 'warning',
  'Any account': 'default',
  'Password signups': 'default',
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
  // 'emails' is the per-email list; 'theme' is the look they all share.
  const [section, setSection] = useState('emails');
  // Bumped on every save, which is what re-runs the preview fetch below: the
  // whole point of editing here is seeing the email you just changed.
  const [previewNonce, setPreviewNonce] = useState(0);
  const [query, setQuery] = useState('');
  // How the Preview tab shows the email: at desktop width, at phone width, or
  // as the text/plain part a text-only client would show.
  const [view, setView] = useState('desktop');

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

  // A save anywhere on the page can change the "Edited" badges and the email
  // on screen, so both are refreshed together.
  const refresh = () => {
    setPreviewNonce((n) => n + 1);
    apiClient.get('/admin/email-templates').then(setTemplates).catch(() => {});
  };

  // Grouped for scanning: an admin looking for "the email we send when someone
  // cancels" thinks in terms of what part of recruitment it belongs to.
  const grouped = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (template) => {
      const haystack = `${template.label} ${template.audience} ${template.category} ${template.description ?? ''}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    };
    const byCategory = new Map();
    for (const template of templates.filter(matches)) {
      if (!byCategory.has(template.category)) byCategory.set(template.category, []);
      byCategory.get(template.category).push(template);
    }
    return [...byCategory.entries()];
  }, [templates, query]);


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
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2, maxWidth: 760 }}>
        Every email the ATS sends on its own, rendered exactly as a recipient receives it,
        and editable. Names, dates and links below are stand-ins for preview only — nothing
        here is sent, and opening or editing a template emails nobody.
      </Typography>

      <Tabs
        value={section}
        onChange={(event, next) => setSection(next)}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="emails" label="Emails" />
        <Tab value="theme" label="Theme" />
        <Tab value="signatures" label="Signatures" />
      </Tabs>

      {section === 'signatures' && (
        <Paper sx={{ p: 3 }}>
          <EmailSignaturesEditor onSaved={refresh} />
        </Paper>
      )}

      {section === 'theme' && (
        <Paper sx={{ p: 3 }}>
          <EmailThemeEditor templates={templates} onSaved={refresh} />
        </Paper>
      )}

      {section === 'emails' && (
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
            <Box sx={{ p: 1.5, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper' }}>
              <TextField
                fullWidth
                size="small"
                placeholder="Search emails"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                slotProps={{
                  htmlInput: { 'aria-label': 'Search emails' },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  },
                }}
              />
            </Box>
            {grouped.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
                No email matches &quot;{query}&quot;.
              </Typography>
            )}
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
                    {preview.format === 'PLAIN' && (
                      <Chip size="small" variant="outlined" label="Plain" />
                    )}
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

                <Tabs
                  value={tab}
                  onChange={(event, next) => setTab(next)}
                  sx={{ borderBottom: 1, borderColor: 'divider' }}
                >
                  <Tab value="preview" label="Preview" />
                  {preview.editable && <Tab value="edit" label="Edit wording" />}
                  {preview.editable && <Tab value="style" label="Style" />}
                </Tabs>

                {tab === 'style' && preview.editable && (
                  <EmailStyleEditor
                    // Keyed for the same reason as the wording editor below.
                    key={`style-${preview.copyKey}`}
                    templateKey={preview.copyKey}
                    previewKey={preview.key}
                    onSaved={refresh}
                  />
                )}

                {tab === 'edit' && preview.editable && (
                  <EmailTemplateEditor
                    // Keyed, so switching templates builds a new editor rather
                    // than reusing this one. A save still in flight then lands on
                    // a component nobody is looking at, instead of putting one
                    // email's wording into another's boxes.
                    key={preview.copyKey}
                    templateKey={preview.copyKey}
                    previewKey={preview.key}
                    // The list carries an "Edited" badge per template, so it has to
                    // hear about a save as well as the preview does.
                    onSaved={refresh}
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
                  <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={view}
                      onChange={(event, next) => next && setView(next)}
                      aria-label="Preview as"
                    >
                      <ToggleButton value="desktop">Desktop</ToggleButton>
                      <ToggleButton value="mobile">Phone</ToggleButton>
                      <ToggleButton value="text">Plain text</ToggleButton>
                    </ToggleButtonGroup>
                    <Box sx={{ flex: 1 }} />
                    {/* Keyed so a result for one email is not left showing on the next. */}
                    <SendTestButton key={preview.key} previewKey={preview.key} />
                  </Stack>
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
                {tab === 'preview' && view !== 'text' && (
                  <Box
                    component="iframe"
                    title={`${preview.label} preview`}
                    srcDoc={preview.html}
                    sandbox=""
                    sx={{
                      // 375px is an iPhone's width, which is where most of
                      // these are read.
                      width: view === 'mobile' ? 375 : '100%',
                      maxWidth: '100%',
                      alignSelf: view === 'mobile' ? 'center' : 'stretch',
                      height: { xs: 480, md: '58vh' },
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      bgcolor: '#ffffff',
                    }}
                  />
                )}

                {tab === 'preview' && view === 'text' && (
                  <Box
                    component="pre"
                    aria-label="Plain text version"
                    sx={{
                      m: 0,
                      p: 2,
                      height: { xs: 480, md: '58vh' },
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'monospace',
                      fontSize: 13,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                    }}
                  >
                    {preview.text}
                  </Box>
                )}
              </Stack>
            )}
          </Paper>
        </Box>
      )}
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
