import React, { useState, useEffect } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Box,
  TextField,
  Button,
  Typography,
  Paper,
  Alert,
  Container,
  Divider,
  Link,
} from '@mui/material';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';
import UConsultingLogo from '../components/UConsultingLogo';
import { googleSignInEnabled } from '../utils/googleSignIn';
import { postLoginDestination } from '../utils/postLoginDestination';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login, loginWithGoogle, user, loading } = useAuth();

  // Redirect if user is already logged in
  useEffect(() => {
    if (!loading && user) {
      navigate(postLoginDestination(user));
    }
  }, [user, loading, navigate]);

  // Don't render the login form if user is already authenticated
  if (loading) {
    return <div>Loading...</div>;
  }

  if (user) {
    return null; // Component will redirect via useEffect
  }

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }

    const result = await login(email, password);

    if (result.success) {
      navigate(postLoginDestination(result.user));
    } else {
      setError(result.error);
    }
  };

  const handleGoogleSuccess = async (credentialResponse) => {
    setError('');

    const result = await loginWithGoogle(credentialResponse?.credential);

    if (result.success) {
      navigate(postLoginDestination(result.user));
    } else {
      setError(result.error);
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
              Application Tracking System
            </Typography>
          </Box>
          
          <Paper sx={{ p: 4, maxWidth: 400, mx: 'auto' }}>
            <Typography variant="h4" sx={{ mb: 4 }}>
              Sign In
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {error}
              </Alert>
            )}

            <Box component="form" onSubmit={handleLogin}>
              <TextField
                fullWidth
                label="Email"
                variant="outlined"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                sx={{ mb: 3 }}
              />

              <TextField
                fullWidth
                label="Password"
                type="password"
                variant="outlined"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                sx={{ mb: 4 }}
              />

              <Button type="submit" fullWidth variant="contained" size="large" sx={{ mb: 3 }}>
                Sign In
              </Button>

              {/* GoogleLogin renders a div[role=button], not a submit button,
                  so it is safe inside the form. No useOneTap: it prompts on its
                  own, and a stray click there would silently create an account. */}
              {googleSignInEnabled && (
                <>
                  <Divider sx={{ mb: 3 }}>or</Divider>
                  <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={() => setError('Google sign-in was cancelled or failed. Try again.')}
                      text="continue_with"
                      width="336"
                    />
                  </Box>
                </>
              )}

              <Box sx={{ textAlign: 'center', mb: 2 }}>
                <Button 
                  onClick={() => navigate('/forgot-password')}
                  variant="text" 
                  size="small"
                >
                  Forgot password?
                </Button>
              </Box>

              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Don't have an account?{' '}
                  <Button
                    onClick={() => navigate('/signup')}
                    variant="text"
                    size="small"
                    sx={{ minWidth: 'auto', p: 0, textTransform: 'none' }}
                  >
                    Sign up here
                  </Button>
                </Typography>
              </Box>
            </Box>
          </Paper>

          {/* Reachable from the app, not only by direct URL - Google checks
              that when reviewing the consent screen, and anyone deciding
              whether to sign in with Google should be able to find it. */}
          <Typography variant="body2" align="center" sx={{ mt: 3, color: 'text.secondary' }}>
            <Link component={RouterLink} to="/privacy" color="inherit" underline="hover">
              Privacy Policy
            </Link>
          </Typography>
        </Container>
      </Box>
  );
};

export default Login;
