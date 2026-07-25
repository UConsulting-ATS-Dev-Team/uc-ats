import React, { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

function base64ToBlob(base64, contentType) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

export default function CycleOfferLetterPreviewDialog({ cycleId, open, onClose }) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null);

  const [form, setForm] = useState({
    sampleFirstName: 'Sample',
    sampleLastName: 'Candidate',
    position: '',
    startDate: '',
    responseDeadline: ''
  });

  useEffect(() => {
    if (!open || !cycleId) return;
    let cancelled = false;
    setLoading(true);
    apiClient
      .get(`/admin/cycles/${cycleId}/offer-letter-template`)
      .then((data) => {
        if (!cancelled) {
          setTemplate(data);
          setForm((prev) => ({
            ...prev,
            responseDeadline: data.responseDeadline || prev.responseDeadline
          }));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load template');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cycleId, open]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setError('');
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setError('');
    try {
      const { pdf } = await apiClient.post(`/admin/cycles/${cycleId}/offer-letter-preview`, {
        position: form.position.trim(),
        startDate: form.startDate.trim(),
        responseDeadline: form.responseDeadline.trim(),
        sampleFirstName: form.sampleFirstName.trim(),
        sampleLastName: form.sampleLastName.trim()
      });
      const blob = base64ToBlob(pdf, 'application/pdf');
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e.message || 'Failed to generate preview');
    } finally {
      setPreviewing(false);
    }
  };

  const handleClose = () => {
    if (previewing) return;
    setPreviewUrl(null);
    setError('');
    onClose?.();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Preview Offer Letter
        <IconButton
          aria-label="close"
          onClick={handleClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
          disabled={previewing}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}
        {loading ? (
          <Typography color="text.secondary">Loading template...</Typography>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction="row" spacing={2}>
              <TextField
                label="Sample First Name"
                value={form.sampleFirstName}
                onChange={handleChange('sampleFirstName')}
                fullWidth
              />
              <TextField
                label="Sample Last Name"
                value={form.sampleLastName}
                onChange={handleChange('sampleLastName')}
                fullWidth
              />
            </Stack>
            <TextField
              label="Position"
              value={form.position}
              onChange={handleChange('position')}
              fullWidth
            />
            <TextField
              label="Start Date"
              value={form.startDate}
              onChange={handleChange('startDate')}
              fullWidth
            />
            <TextField
              label="Response Deadline"
              value={form.responseDeadline}
              onChange={handleChange('responseDeadline')}
              fullWidth
            />
            <Button
              variant="contained"
              onClick={handlePreview}
              disabled={previewing}
            >
              {previewing ? 'Generating Preview...' : 'Generate Preview'}
            </Button>
            {previewUrl && (
              <iframe
                src={previewUrl}
                title="Offer Letter Preview"
                style={{ width: '100%', height: '500px', border: '1px solid #e5e7eb', borderRadius: '8px' }}
              />
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={previewing}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
