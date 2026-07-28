import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../utils/api';
import UConsultingLogo from '../components/UConsultingLogo';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Container,
} from '@mui/material';

export default function FeedbackForm() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cycleName, setCycleName] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const validate = async () => {
      try {
        const data = await api.get(`/feedback/${token}`);
        if (!cancelled) {
          setCycleName(data.cycleName || '');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'This feedback link is invalid or has already been used.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    validate();
    return () => { cancelled = true; };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post(`/feedback/${token}`, { content });
      setSuccess(true);
    } catch (e) {
      setError(e.message || 'Failed to submit feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (success) {
    return (
      <Container maxWidth="sm" sx={{ pt: 8 }}>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <UConsultingLogo size="medium" />
          <Typography variant="h5" sx={{ mt: 3, mb: 2 }}>
            Thank You
          </Typography>
          <Typography color="text.secondary">
            Your anonymous feedback has been submitted.
          </Typography>
        </Paper>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm" sx={{ pt: 8, pb: 4 }}>
      <Paper sx={{ p: 4 }}>
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <UConsultingLogo size="medium" />
          <Typography variant="h5" sx={{ mt: 2 }}>
            Anonymous Feedback
          </Typography>
          {cycleName && (
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              {cycleName}
            </Typography>
          )}
        </Box>

        {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}

        {!error && (
          <form onSubmit={handleSubmit}>
            <TextField
              label="Your feedback"
              multiline
              rows={6}
              fullWidth
              value={content}
              onChange={(e) => setContent(e.target.value)}
              inputProps={{ maxLength: 5000 }}
              helperText={`${content.length}/5000 characters`}
              sx={{ mb: 3 }}
              required
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={submitting || !content.trim()}
            >
              {submitting ? <CircularProgress size={24} /> : 'Submit Feedback'}
            </Button>
          </form>
        )}
      </Paper>
    </Container>
  );
}
