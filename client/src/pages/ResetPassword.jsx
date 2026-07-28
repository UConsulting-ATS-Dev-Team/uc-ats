import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Button,
  Paper,
  TextField,
  Typography,
  Alert,
  Container,
} from '@mui/material';
import UConsultingLogo from '../components/UConsultingLogo';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) {
      navigate('/404');
    }
  }, [token, navigate]);

  const clearErrors = () => {
    setError('');
    setConfirmError('');
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    clearErrors();

    if (!newPassword.trim() || !confirmPassword.trim()) {
      const message = 'Both password fields are required';
      setError(message);
      setConfirmError(message);
      return;
    }

    if (newPassword !== confirmPassword) {
      const message = 'Passwords do not match';
      setError(message);
      setConfirmError(message);
      return;
    }

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Reset failed');
      } else {
        setSuccess('Password updated successfully!');
        setTimeout(() => navigate('/login'), 2500);
      }
    } catch (err) {
      console.error(err);
      setError('Something went wrong');
    }
  };

  return (
    <Box
        sx={{
          minHeight: '100vh',
          backgroundColor: 'background.default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 2,
        }}
      >
        <Container maxWidth="sm">
          <Box sx={{ mb: 4, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <UConsultingLogo size="large" style={{ marginBottom: '1rem' }} />
            <Typography variant="h6" sx={{ color: 'text.secondary' }}>
              Set Your New Password
            </Typography>
          </Box>

          <Paper sx={{ p: 4, maxWidth: 400, mx: 'auto' }}>
            <Typography variant="h4" sx={{ mb: 4 }}>
              Reset Password
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {error}
              </Alert>
            )}
            {success && (
              <Alert severity="success" sx={{ mb: 3 }}>
                {success}
              </Alert>
            )}

            <Box component="form" onSubmit={handleResetPassword} data-testid="reset-password-form">
              <TextField
                fullWidth
                label="New Password"
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (confirmError || error) clearErrors();
                }}
                required
                sx={{ mb: 2 }}
              />
              <TextField
                fullWidth
                label="Confirm New Password"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (confirmError || error) clearErrors();
                }}
                error={Boolean(confirmError)}
                helperText={confirmError}
                required
                sx={{ mb: 4 }}
              />
              <Button type="submit" fullWidth variant="contained" size="large">
                Update Password
              </Button>
            </Box>
          </Paper>
        </Container>
      </Box>
  );
}
