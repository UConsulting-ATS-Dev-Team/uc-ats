import React, { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import UConsultingLogo from '../components/UConsultingLogo';

// Public signup for the UConsulting Talent Network - open to any UCLA student,
// with no application and no prior contact with UConsulting required.
//
// Deliberately not /signup, which is for applicants tracking an application and
// asks for a student ID it then writes to a Candidate row. This form asks for
// the four things the talent profile actually needs and nothing else; major and
// resume come after the email is verified.

// Mirrors UCLA_EMAIL_PATTERN on the server. Duplicated rather than shared
// because there is no shared module between client and server here - the server
// is the one that decides, this only saves a round trip on an obvious typo.
const UCLA_EMAIL_PATTERN = /^[^\s@]+@(?:[a-z0-9-]+\.)*ucla\.edu$/i;
const MIN_PASSWORD_LENGTH = 10;

const TalentSignUp = () => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [graduationYear, setGraduationYear] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { registerExternal, user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      navigate('/talent/profile');
    }
  }, [user, loading, navigate]);

  if (loading) return <div>Loading...</div>;
  if (user) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!fullName.trim() || !email.trim() || !password || !graduationYear.trim()) {
      setError('All fields are required');
      return;
    }
    if (!UCLA_EMAIL_PATTERN.test(email.trim())) {
      setError('Use your UCLA email address, ending in ucla.edu.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!/^(19|20)\d{2}$/.test(graduationYear.trim())) {
      setError('Enter your graduation year as four digits, for example 2027.');
      return;
    }

    setSubmitting(true);
    const result = await registerExternal({
      fullName: fullName.trim(),
      email: email.trim(),
      password,
      graduationYear: graduationYear.trim(),
    });
    setSubmitting(false);

    if (result.success) {
      navigate('/talent/profile');
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
        py: 6,
      }}
    >
      <Container maxWidth="sm">
        <Paper elevation={3} sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
            <UConsultingLogo />
            <Typography variant="h5" component="h1" align="center">
              Join the Talent Network
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              UConsulting shares student resumes with partner organizations hiring interns and
              early-career talent. Open to any UCLA student - you do not need to have applied to
              UConsulting.
            </Typography>
          </Stack>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}

          <Box component="form" onSubmit={handleSubmit}>
            <Stack spacing={2}>
              <TextField
                fullWidth
                required
                label="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
              />
              <TextField
                fullWidth
                required
                type="email"
                label="UCLA email"
                placeholder="you@g.ucla.edu"
                helperText="We send a verification link here. Only ucla.edu addresses are accepted."
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <TextField
                fullWidth
                required
                type="password"
                label="Password"
                helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <TextField
                fullWidth
                required
                label="Graduation year"
                placeholder="2027"
                value={graduationYear}
                onChange={(e) => setGraduationYear(e.target.value)}
              />

              <Button type="submit" variant="contained" size="large" disabled={submitting}>
                {submitting ? 'Creating account...' : 'Create account'}
              </Button>
            </Stack>
          </Box>

          <Typography variant="body2" align="center" sx={{ mt: 3 }}>
            Already have an account?{' '}
            <Link component={RouterLink} to="/login">
              Sign in
            </Link>
          </Typography>
        </Paper>
      </Container>
    </Box>
  );
};

export default TalentSignUp;
