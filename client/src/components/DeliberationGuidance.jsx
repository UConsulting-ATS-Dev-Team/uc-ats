import React from 'react';
import { Alert, AlertTitle, Box, Typography } from '@mui/material';

export const DELIBERATION_GUIDANCE = {
  title: 'Deliberation guidance',
  intro:
    'Deliberation is a space for human discussion. Recorded decisions must reflect approved recruitment policy and the group’s collective judgment. The ATS does not rank, recommend, or finalize candidates.',
  values: {
    YES: {
      label: 'Yes',
      description:
        'The candidate clearly meets the criteria and the group is ready to advance them.',
    },
    MAYBE_YES: {
      label: 'Maybe-Yes',
      description:
        'The candidate mostly meets the criteria, with only minor open questions.',
    },
    UNSURE: {
      label: 'Unsure',
      description:
        'There is not enough information yet; discuss as a group before recording a decision.',
    },
    MAYBE_NO: {
      label: 'Maybe-No',
      description:
        'The candidate likely falls short on important criteria, but a brief discussion may help.',
    },
    NO: {
      label: 'No',
      description:
        'The candidate does not meet the criteria and should not advance.',
    },
  },
};

export default function DeliberationGuidance() {
  const { title, intro, values } = DELIBERATION_GUIDANCE;

  return (
    <Alert
      severity="info"
      role="note"
      tabIndex={0}
      aria-label="Deliberation guidance"
      data-testid="deliberation-guidance"
      sx={{ mb: 2, mt: 2 }}
    >
      <AlertTitle>{title}</AlertTitle>
      <Typography variant="body2" component="div">
        {intro}
      </Typography>
      <Box component="ul" sx={{ pl: 2, mb: 0, mt: 1 }}>
        {Object.entries(values).map(([key, { label, description }]) => (
          <li key={key} data-testid={`decision-definition-${key}`}>
            <strong>{label}</strong> — {description}
          </li>
        ))}
      </Box>
    </Alert>
  );
}
