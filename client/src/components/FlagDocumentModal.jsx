import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Typography,
  Alert
} from '@mui/material';
import { Flag as FlagIcon } from '@mui/icons-material';
import { useIsMobile } from '../hooks/useResponsive';
import apiClient from '../utils/api';

const FLAG_REASONS = [
  'Inappropriate content',
  'Poor quality/formatting',
  'Missing information',
  'Suspicious content',
  'Technical issues',
  'Other'
];

export default function FlagDocumentModal({ 
  open, 
  onClose, 
  application, 
  documentType 
}) {
  const isMobile = useIsMobile();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async () => {
    if (!reason) {
      setError('Please select a reason for flagging');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await apiClient.post('/member/flag-document', {
        applicationId: application.id,
        documentType,
        reason,
        message: message.trim() || null
      });

      setSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch (err) {
      console.error('Error flagging document:', err);
      setError(err.response?.data?.error || 'Failed to flag document');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setReason('');
    setMessage('');
    setError(null);
    setSuccess(false);
    onClose();
  };

  const getDocumentTypeLabel = (type) => {
    switch (type) {
      case 'resume': return 'Resume';
      case 'coverLetter': return 'Cover Letter';
      case 'video': return 'Video';
      default: return type;
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      fullScreen={isMobile}
    >
      <DialogTitle>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FlagIcon color="error" />
          <Typography variant="h6">
            Flag {getDocumentTypeLabel(documentType)}
          </Typography>
        </Box>
      </DialogTitle>
      
      <DialogContent>
        {success ? (
          <Alert severity="success" sx={{ mb: 2 }}>
            Document flagged successfully!
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Flagging {application?.name}'s {getDocumentTypeLabel(documentType).toLowerCase()} for review.
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <FormControl fullWidth sx={{ mb: 3 }}>
              <InputLabel>Reason for flagging *</InputLabel>
              <Select
                value={reason}
                label="Reason for flagging *"
                onChange={(e) => setReason(e.target.value)}
              >
                {FLAG_REASONS.map((flagReason) => (
                  <MenuItem key={flagReason} value={flagReason}>
                    {flagReason}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              fullWidth
              multiline
              rows={4}
              label="Additional details (optional)"
              placeholder="Provide any additional context about why this document should be flagged..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              sx={{ mb: 2 }}
            />
          </>
        )}
      </DialogContent>
      
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          {success ? 'Close' : 'Cancel'}
        </Button>
        {!success && (
          <Button
            onClick={handleSubmit}
            variant="contained"
            color="error"
            disabled={loading || !reason}
            startIcon={<FlagIcon />}
          >
            {loading ? 'Flagging...' : 'Flag Document'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
