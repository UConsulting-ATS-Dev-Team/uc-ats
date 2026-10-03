import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Paper, Stack, Tab, Tabs, Typography } from '@mui/material';
import apiClient from '../../utils/api';
import useDocumentPreview from '../../hooks/useDocumentPreview';
import { DOC_LABELS, DOC_TYPES } from '../../utils/reviewDelib';

// The candidate's documents beside their scores. Which tab is open and where a
// video is are each viewer's own, like the step and candidate they are on.

const HEIGHT = { xs: 480, md: 'calc(100vh - 320px)' };

function ShortAnswer({ text, cycleId }) {
  const [prompt, setPrompt] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setPrompt(null);
    apiClient.get(cycleId ? `/review-teams/question-prompts/${cycleId}` : '/review-teams/question-prompts')
      .then((response) => { if (!cancelled) setPrompt(response?.shortAnswer || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cycleId]);

  return (
    <Paper variant="outlined" sx={{ p: 3, height: HEIGHT, overflowY: 'auto' }}>
      {prompt && (
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2 }}>{prompt}</Typography>
      )}
      <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{text}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        {text.split(/\s+/).filter(Boolean).length} words
      </Typography>
    </Paper>
  );
}

function FilePreview({ url, kind, title }) {
  const preview = useDocumentPreview({ url, kind });

  if (preview.loading) {
    return (
      <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ height: HEIGHT }}>
        <CircularProgress />
        <Typography color="text.secondary">Loading {title.toLowerCase()}…</Typography>
      </Stack>
    );
  }
  if (preview.previewUrl) {
    return kind === 'video' ? (
      <Box
        component="video"
        src={preview.previewUrl}
        controls
        preload="auto"
        onError={preview.onVideoError}
        onLoadedData={preview.onVideoLoaded}
        sx={{ width: '100%', height: HEIGHT, bgcolor: 'common.black', borderRadius: 1 }}
      />
    ) : (
      <Box
        component="iframe"
        src={preview.previewUrl}
        title={title}
        sx={{ width: '100%', height: HEIGHT, border: 1, borderColor: 'divider', borderRadius: 1 }}
      />
    );
  }
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ height: HEIGHT, textAlign: 'center' }}>
      <Typography color="text.secondary">{preview.error ? 'Could not show the preview' : 'Nothing to preview'}</Typography>
      {preview.error && <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420 }}>{preview.error}</Typography>}
      <Button variant="outlined" onClick={preview.openInNewTab}>Open in a new tab</Button>
      {preview.openTabError && <Alert severity="error">{preview.openTabError}</Alert>}
    </Stack>
  );
}

export default function DocumentPanel({ card }) {
  const available = {
    resume: Boolean(card.resumeUrl),
    coverLetter: Boolean(card.shortAnswer?.trim() || card.coverLetterUrl),
    video: Boolean(card.videoUrl)
  };
  const firstAvailable = DOC_TYPES.find((type) => available[type]) || 'resume';
  const [tab, setTab] = useState(firstAvailable);

  // A new candidate opens on their first document.
  useEffect(() => { setTab(firstAvailable); }, [card.applicationId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box>
      <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ mb: 1.5 }} aria-label="Documents">
        {DOC_TYPES.map((type) => (
          <Tab
            key={type}
            value={type}
            disabled={!available[type]}
            label={type === 'coverLetter' && card.shortAnswer?.trim() ? 'Short answer' : DOC_LABELS[type]}
          />
        ))}
      </Tabs>
      {tab === 'resume' && available.resume && <FilePreview url={card.resumeUrl} kind="pdf" title="Resume" />}
      {tab === 'coverLetter' && available.coverLetter && (
        card.shortAnswer?.trim()
          ? <ShortAnswer text={card.shortAnswer} cycleId={card.cycleId} />
          : <FilePreview url={card.coverLetterUrl} kind="pdf" title="Cover letter" />
      )}
      {tab === 'video' && available.video && <FilePreview url={card.videoUrl} kind="video" title="Video" />}
      {!available[tab] && <Typography color="text.secondary">No documents on this application.</Typography>}
    </Box>
  );
}
