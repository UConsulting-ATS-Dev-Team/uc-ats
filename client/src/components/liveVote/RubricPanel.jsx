import { Box, Drawer, IconButton, Paper, Stack, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';

// The session's rubric, beside the vote on wide screens and as a drawer on
// narrow ones. Anyone in the room can open it.

function RubricBody({ rubric, onClose }) {
  return (
    <Box sx={{ p: 2.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h6" fontWeight={700}>Rubric</Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close rubric"><CloseIcon fontSize="small" /></IconButton>
      </Stack>
      <Stack spacing={2.5} component="ol" sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {rubric.map((criterion, index) => (
          <Box component="li" key={criterion.id}>
            <Typography variant="subtitle1" fontWeight={700}>
              {index + 1}. {criterion.title}
            </Typography>
            {criterion.description && (
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-line', mt: 0.5 }}>
                {criterion.description}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export default function RubricPanel({ open, rubric, onClose }) {
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('lg'));

  if (narrow) {
    return (
      <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: 'min(360px, 90vw)' } }}>
        <RubricBody rubric={rubric} onClose={onClose} />
      </Drawer>
    );
  }

  if (!open) return null;
  return (
    <Paper
      variant="outlined"
      sx={{ width: 340, flexShrink: 0, borderRadius: 3, alignSelf: 'flex-start', position: 'sticky', top: 16, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}
    >
      <RubricBody rubric={rubric} onClose={onClose} />
    </Paper>
  );
}
