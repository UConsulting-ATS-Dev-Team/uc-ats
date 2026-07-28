import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  TextField,
  Typography,
  Paper,
  Alert,
  Container,
} from '@mui/material';
import UConsultingLogo from '../components/UConsultingLogo';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();
      console.log(data); // optional: to verify response
      setSubmitted(true);
    } catch (err) {
      console.error('Error sending reset request:', err);
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
              Reset Your Password
            </Typography>
          </Box>
          
          <Paper sx={{ p: 4, maxWidth: 400, mx: 'auto' }}>
            <Typography variant="h4" sx={{ mb: 4 }}>
              Forgot Password
            </Typography>

            {submitted ? (
              <Alert severity="success" sx={{ mb: 2 }}>
                If an account with that email exists, a reset link will be sent.
              </Alert>
            ) : (
              <Box component="form" onSubmit={handleSubmit}>
                <TextField
                  fullWidth
                  label="Email Address"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  sx={{ mb: 4 }}
                />

                <Button type="submit" fullWidth variant="contained" size="large" sx={{ mb: 3 }}>
                  Send Reset Link
                </Button>

                <Box sx={{ textAlign: 'center' }}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    Remember your password?{' '}
                    <Button
                      onClick={() => navigate('/login')}
                      variant="text"
                      size="small"
                      sx={{ minWidth: 'auto', p: 0, textTransform: 'none' }}
                    >
                      Sign in here
                    </Button>
                  </Typography>
                </Box>
              </Box>
            )}
          </Paper>
        </Container>
      </Box>
  );
}
