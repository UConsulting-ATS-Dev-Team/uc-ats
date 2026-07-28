import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Container,
} from '@mui/material';
import UConsultingLogo from '../components/UConsultingLogo';
import ThemeToggle from '../components/ThemeToggle';

const PausedLanding = () => {
  return (
    <Box
        sx={{
          minHeight: '100vh',
          backgroundColor: 'background.default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 2,
        position: 'relative',
        }}
      >
        <ThemeToggle
          sx={{
            position: 'absolute',
            top: { xs: 8, sm: 16 },
            right: { xs: 8, sm: 16 },
          }}
        />
        <Container maxWidth="sm">
          <Box sx={{ mb: 4, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <UConsultingLogo size="large" style={{ marginBottom: '2rem' }} />
          </Box>
          
          <Paper sx={{ p: 5, maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
            <Typography 
              variant="h3" 
              sx={{ 
                mb: 3,
                color: 'primary.main',
                fontWeight: 700,
              }}
            >
              Recruitment Currently Paused
            </Typography>

            <Typography 
              variant="h6" 
              sx={{ 
                mb: 4,
                color: 'text.secondary',
                fontWeight: 400,
                lineHeight: 1.6,
              }}
            >
              We are currently not in an active recruitment cycle.
            </Typography>

            <Box
              sx={{
                backgroundColor: 'info.light',
                borderRadius: '0.75rem',
                p: 3,
                mb: 4,
                border: '1px solid',
                borderColor: 'info.main',
              }}
            >
              <Typography 
                variant="body1" 
                sx={{ 
                  color: 'text.primary',
                  fontWeight: 500,
                  fontSize: '1.125rem',
                  mb: 2,
                }}
              >
                Check back in <strong>Fall 2026</strong> to reapply to UConsulting.
              </Typography>
            </Box>

            <Typography 
              variant="body2" 
              sx={{ 
                color: 'text.secondary',
                fontStyle: 'italic',
              }}
            >
              Thank you for your interest in joining our team.
            </Typography>
          </Paper>
        </Container>
      </Box>
  );
};

export default PausedLanding;
