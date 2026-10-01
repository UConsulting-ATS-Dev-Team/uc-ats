import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  Stack,
  Typography,
} from '@mui/material';
import apiClient from '../utils/api';
import { getVideoEmbedUrl } from '../utils/videoEmbed';

// The tutorials someone must sit through before their first piece of `category` work
// in a cycle. The server decides whether they still have to (see
// server/src/services/tutorialGate.js); this only asks and shows them.
//
//   const gate = useTutorialGate('DOCUMENT_GRADING', 'Start grading');
//   const handleGrade = (app) => gate.run(() => openGradingModal(app));
//   ...
//   {gate.dialog}
//
// `run` performs the action straight away once the gate is clear, and after the
// tutorials are finished otherwise. A failed status check lets the action through:
// a missed tutorial is recoverable, a grader who cannot grade is not.
export function useTutorialGate(category, continueLabel = 'Continue') {
  const [gate, setGate] = useState(null);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const statusRef = useRef(null);
  const pendingActionRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const request = apiClient
      .get(`/member/help/tutorial-gates/${category}`)
      .then((data) => (data && data.required ? data : { required: false }))
      .catch(() => ({ required: false }));
    statusRef.current = request;
    request.then((data) => {
      if (!cancelled) setGate(data);
    });
    return () => {
      cancelled = true;
    };
  }, [category]);

  const run = useCallback(async (action) => {
    const status = await statusRef.current;
    if (!status?.required) {
      action();
      return;
    }
    pendingActionRef.current = action;
    setError(null);
    setOpen(true);
  }, []);

  const complete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post(`/member/help/tutorial-gates/${category}/complete`);
      const cleared = { required: false };
      statusRef.current = Promise.resolve(cleared);
      setGate(cleared);
      setOpen(false);
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      action?.();
    } catch (e) {
      setError(e.message || 'Could not save that you finished the tutorial. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const dialog = (
    <TutorialGateDialog
      open={open}
      tutorials={gate?.tutorials || []}
      continueLabel={continueLabel}
      submitting={submitting}
      error={error}
      onComplete={complete}
    />
  );

  return { run, dialog };
}

// Unskippable on purpose: no close button, and Escape and backdrop clicks do nothing.
// The only way out is confirming the tutorial was watched.
export function TutorialGateDialog({
  open,
  tutorials,
  continueLabel,
  submitting,
  error,
  onComplete,
}) {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) setConfirmed(false);
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={() => {}}
      disableEscapeKeyDown
      maxWidth="md"
      fullWidth
      aria-labelledby="tutorial-gate-title"
    >
      <DialogTitle id="tutorial-gate-title">Before you start</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          Watch this once each cycle before you grade. You can find it again later under
          Help &amp; Tutorials.
        </Typography>

        <Stack spacing={3} divider={<Divider flexItem />}>
          {tutorials.map((tutorial) => (
            <TutorialContent key={tutorial.id} tutorial={tutorial} />
          ))}
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions
        sx={{
          px: 3,
          py: 2,
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: 1,
        }}
      >
        <FormControlLabel
          sx={{ flex: 1, mr: 0 }}
          control={
            <Checkbox
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={submitting}
            />
          }
          label={
            tutorials.length > 1
              ? 'I watched all of these tutorials'
              : 'I watched the whole tutorial'
          }
        />
        <Button
          variant="contained"
          onClick={onComplete}
          disabled={!confirmed || submitting}
        >
          {submitting ? 'Saving…' : continueLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TutorialContent({ tutorial }) {
  const embedUrl = getVideoEmbedUrl(tutorial.videoUrl);
  const hasBody = Boolean(tutorial.body && tutorial.body.trim());

  return (
    <Box>
      <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
        {tutorial.title}
      </Typography>
      {tutorial.description && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {tutorial.description}
        </Typography>
      )}

      {embedUrl && (
        <Box sx={{ mt: 2 }}>
          <Box
            sx={{
              position: 'relative',
              paddingBottom: '56.25%',
              height: 0,
              overflow: 'hidden',
              borderRadius: 1,
              bgcolor: 'background.default',
            }}
          >
            <iframe
              src={embedUrl}
              title={tutorial.title}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                border: 0,
              }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </Box>
          <Link
            href={tutorial.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="body2"
            sx={{ display: 'inline-block', mt: 1 }}
          >
            Video not loading? Open it in a new tab
          </Link>
        </Box>
      )}

      {hasBody && (
        <Typography variant="body1" sx={{ mt: 2, whiteSpace: 'pre-line' }}>
          {tutorial.body}
        </Typography>
      )}
    </Box>
  );
}
