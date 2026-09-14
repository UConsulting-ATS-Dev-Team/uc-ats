import React from 'react';
import { Box, Container, Paper, Typography } from '@mui/material';
import InterviewStaffingSignup from '../components/interviews/InterviewStaffingSignup';

/**
 * Telling recruitment when you can interview.
 *
 * Split out from My Interviews on purpose. The two pages answer questions at
 * opposite ends of the process and at opposite times: this one is "when am I
 * free", asked of everybody before any schedule exists, and My Interviews is
 * "what am I running", which only has an answer once recruitment has built the
 * day. Stacking them meant a member opening My Interviews to conduct an
 * interview scrolled past a form they had already filled in weeks earlier.
 */
export default function InterviewRSVP() {
  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>
          Interview RSVP
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Tell recruitment when you can interview. They build the day from these answers — which hours run,
          how many interviews go at once, and who is in each one.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <InterviewStaffingSignup />
      </Paper>
    </Container>
  );
}
