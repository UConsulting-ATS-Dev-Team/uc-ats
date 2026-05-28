import React from 'react';
import { Box } from '@mui/material';
import AccessControl from '../components/AccessControl';

export default function RecruitmentResources() {
  return (
    <AccessControl allowedRoles={['ADMIN', 'MEMBER']}>
      <Box sx={{ p: { xs: 2, md: 4 } }}>
      <h1>Recruitment Resources and Timeline</h1>
      <p>This page will contain the recruitment resources and timeline interface for UC members.</p>
      <p>Features will include:</p>
      <ul>
        <li>Detailed recruitment timeline</li>
        <li>Resource library</li>
        <li>Important dates and deadlines</li>
        <li>Training materials</li>
      </ul>
    </Box>
    </AccessControl>
  );
}
