import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  Typography,
  Alert,
  CircularProgress,
  Stack,
} from '@mui/material';
import { XMarkIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const FeatureRequestModal = ({ open, onClose }) => {
  const location = useLocation();
  const fileInputRef = useRef(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [screenshotFile, setScreenshotFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [issueUrl, setIssueUrl] = useState('');

  useEffect(() => {
    if (!screenshotFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(screenshotFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshotFile]);

  const resetAll = () => {
    setTitle('');
    setDescription('');
    setCategory('');
    setScreenshotFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setError('');
    setSuccess(false);
    setIssueUrl('');
  };

  const handleScreenshotChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) {
      setScreenshotFile(null);
      return;
    }
    if (f.size > MAX_SCREENSHOT_BYTES) {
      setError('Screenshot must be 5MB or smaller');
      e.target.value = '';
      setScreenshotFile(null);
      return;
    }
    setError('');
    setScreenshotFile(f);
  };

  const clearScreenshot = () => {
    setScreenshotFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!title.trim() || !description.trim()) {
      setError('Please enter a title and description');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess(false);
    setIssueUrl('');

    const appPath = `${location.pathname}${location.search || ''}`;

    const formData = new FormData();
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    if (category.trim()) {
      formData.append('category', category.trim());
    }
    formData.append('appPath', appPath);
    if (screenshotFile) {
      formData.append('screenshot', screenshotFile);
    }

    try {
      const data = await apiClient.post('/feature-requests', formData);

      setTitle('');
      setDescription('');
      setCategory('');
      setScreenshotFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setSuccess(true);
      setIssueUrl(data.issueUrl || '');

      setTimeout(() => {
        onClose();
        setSuccess(false);
        setIssueUrl('');
      }, 2500);
    } catch (err) {
      if (err.contactEmail) {
        setError(
          `We couldn't submit this to GitHub right now. Please email ${err.contactEmail} with your feature idea and we'll track it manually.`
        );
      } else {
        setError(err.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      resetAll();
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2,
          boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
          Request a feature
        </Typography>
        <Button
          onClick={handleClose}
          disabled={loading}
          sx={{
            minWidth: 'auto',
            p: 1,
            '&:hover': { backgroundColor: 'grey.100' },
          }}
        >
          <XMarkIcon style={{ width: '1.25rem', height: '1.25rem' }} />
        </Button>
      </DialogTitle>

      <DialogContent sx={{ pt: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Suggest an improvement to the ATS. Your request is filed on our GitHub repo for the team to
          review.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {success && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {issueUrl ? (
              <>
                Thanks — your request was submitted.{' '}
                <a href={issueUrl} target="_blank" rel="noopener noreferrer">
                  View the issue
                </a>
                .
              </>
            ) : (
              'Thanks — your request was submitted.'
            )}
          </Alert>
        )}

        <Box component="form" id="feature-request-form" onSubmit={handleSubmit}>
          <TextField
            fullWidth
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            variant="outlined"
            disabled={loading}
            required
            sx={{ mb: 2 }}
            inputProps={{ maxLength: 200 }}
            helperText={`${title.length}/200`}
          />
          <TextField
            fullWidth
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            variant="outlined"
            disabled={loading}
            required
            multiline
            minRows={4}
            sx={{ mb: 2 }}
            inputProps={{ maxLength: 10000 }}
            helperText={`${description.length}/10000`}
          />
          <TextField
            fullWidth
            label="Category (optional)"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            variant="outlined"
            disabled={loading}
            sx={{ mb: 2 }}
            inputProps={{ maxLength: 120 }}
            placeholder="e.g. interviews, applications, UI"
          />

          <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
            Screenshot (optional)
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            PNG, JPEG, GIF, or WebP, up to 5MB. The image is hosted on the ATS server and linked from
            the GitHub issue.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: previewUrl ? 2 : 0 }}>
            <Button variant="outlined" component="label" disabled={loading} sx={{ textTransform: 'none' }}>
              Choose image
              <input
                ref={fileInputRef}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
                onChange={handleScreenshotChange}
              />
            </Button>
            {screenshotFile && (
              <Button variant="text" size="small" onClick={clearScreenshot} disabled={loading}>
                Remove
              </Button>
            )}
          </Stack>
          {previewUrl && (
            <Box
              sx={{
                mt: 1,
                borderRadius: 1,
                overflow: 'hidden',
                border: '1px solid',
                borderColor: 'divider',
                maxHeight: 220,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'grey.50',
              }}
            >
              <Box
                component="img"
                src={previewUrl}
                alt="Screenshot preview"
                sx={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain' }}
              />
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 3, pt: 1 }}>
        <Button onClick={handleClose} disabled={loading} sx={{ mr: 1 }}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="feature-request-form"
          variant="contained"
          disabled={loading || !title.trim() || !description.trim()}
          startIcon={loading ? <CircularProgress size={16} /> : null}
          sx={{
            px: 3,
            py: 1,
            borderRadius: 2,
            textTransform: 'none',
            fontWeight: 600,
          }}
        >
          {loading ? 'Submitting…' : 'Submit request'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default FeatureRequestModal;
