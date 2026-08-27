import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GRADUATION_YEARS } from '../utils/graduationYears';
import {
  Box,
  TextField,
  Button,
  Typography,
  Paper,
  Alert,
  Container,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import UConsultingLogo from '../components/UConsultingLogo';

const MemberSignUp = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [graduationClass, setGraduationClass] = useState('');
  const [studentId, setStudentId] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { registerMember, user, loading } = useAuth();

  // Check for required token parameter
  const token = searchParams.get('token');
  const requiredToken = 'member-access-2024'; // This should be kept secret

  // Redirect if no valid token
  useEffect(() => {
    if (!token || token !== requiredToken) {
      navigate('/login');
    }
  }, [token, requiredToken, navigate]);

  // Redirect if user is already logged in
  useEffect(() => {
    if (!loading && user) {
      navigate('/');
    }
  }, [user, loading, navigate]);

  // Don't render the signup form if user is already authenticated
  if (loading) {
    return <div>Loading...</div>;
  }

  if (user) {
    return null; // Component will redirect via useEffect
  }

  // Don't render if token is invalid
  if (!token || token !== requiredToken) {
    return null; // Component will redirect via useEffect
  }

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError('');

    if (!email || !password || !fullName || !graduationClass || !studentId) {
      setError('All fields are required');
      return;
    }

    // Validate student ID is exactly 9 digits
    if (!/^\d{9}$/.test(studentId)) {
      setError('Student ID must be exactly 9 digits');
      return;
    }

    const result = await registerMember({
      email,
      password,
      fullName,
      graduationClass,
      studentId: studentId,
      accessToken: token
    });

    if (result.success) {
      navigate('/application-list');
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
              Member Registration Portal
            </Typography>
          </Box>
          
          <Paper sx={{ p: 4, maxWidth: 400, mx: 'auto' }}>
            <Typography variant="h4" sx={{ mb: 4 }}>
              Member Sign Up
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {error}
              </Alert>
            )}

            <Box component="form" onSubmit={handleSignUp}>
              <TextField
                fullWidth
                label="Full Name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                sx={{ mb: 3 }}
              />

              <FormControl fullWidth required sx={{ mb: 3 }}>
                <InputLabel>Graduation Year</InputLabel>
                <Select
                  value={graduationClass}
                  label="Graduation Year"
                  onChange={(e) => setGraduationClass(e.target.value)}
                >
                  {GRADUATION_YEARS.map((year) => (
                    <MenuItem key={year} value={year}>{year}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                fullWidth
                label="Student ID"
                value={studentId}
                onChange={(e) => {
                  // Only allow digits and limit to 9 characters
                  const value = e.target.value.replace(/\D/g, '').slice(0, 9);
                  setStudentId(value);
                }}
                required
                helperText="Enter your 9-digit student ID"
                inputProps={{
                  pattern: '[0-9]{9}',
                  maxLength: 9
                }}
                sx={{ mb: 3 }}
              />

              <TextField
                fullWidth
                label="Email"
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                sx={{ mb: 4 }}
              />

              <Button type="submit" fullWidth variant="contained" size="large" sx={{ mb: 3 }}>
                Register as Member
              </Button>

              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Already have an account?{' '}
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
          </Paper>
        </Container>
      </Box>
  );
};

export default MemberSignUp;
