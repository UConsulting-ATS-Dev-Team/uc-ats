import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  IconButton,
  Box,
  Typography,
  Alert,
  CircularProgress
} from '@mui/material';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useIsMobile } from '../hooks/useResponsive';
import apiClient from '../utils/api';

const MessageAdminModal = ({ open, onClose }) => {
  const isMobile = useIsMobile();
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!message.trim()) {
      setError('Please enter a message');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      await apiClient.post('/member/message-admin', {
        message: message.trim()
      });
      
      setSuccess(true);
      setMessage('');
      
      // Close modal after 2 seconds
      setTimeout(() => {
        onClose();
        setSuccess(false);
      }, 2000);
      
    } catch (err) {
      setError(err.message || 'Failed to send message. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setMessage('');
      setError('');
      setSuccess(false);
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      fullScreen={isMobile}
      PaperProps={{
        sx: {
          borderRadius: { xs: 0, md: 2 },
          boxShadow: '0 10px 25px rgba(0,0,0,0.1)'
        }
      }}
    >
      <DialogTitle sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        pb: 1
      }}>
        <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
          Message an Admin
        </Typography>
        <IconButton
          onClick={handleClose}
          disabled={loading}
          aria-label="close"
        >
          <XMarkIcon style={{ width: '1.25rem', height: '1.25rem' }} />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Have a question or need help? Send a message to the admin team and we'll get back to you as soon as possible.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {success && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Message sent successfully! We'll get back to you soon.
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            fullWidth
            multiline
            rows={6}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What would you like to ask or discuss with the admin team?"
            variant="outlined"
            disabled={loading}
            sx={{
              '& .MuiOutlinedInput-root': {
                '&:hover fieldset': {
                  borderColor: 'primary.main',
                },
                '&.Mui-focused fieldset': {
                  borderColor: 'primary.main',
                },
              },
            }}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 3, pt: 1 }}>
        <Button
          onClick={handleClose}
          disabled={loading}
          sx={{ mr: 1 }}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={loading || !message.trim()}
          startIcon={loading ? <CircularProgress size={16} /> : null}
          sx={{
            px: 3,
            py: 1,
            borderRadius: 2,
            textTransform: 'none',
            fontWeight: 600
          }}
        >
          {loading ? 'Sending...' : 'Send Message'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default MessageAdminModal;
