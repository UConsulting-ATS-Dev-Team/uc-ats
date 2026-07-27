import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Typography,
  Container,
} from '@mui/material';
import UConsultingLogo from '../components/UConsultingLogo';

export default function NotFound() {
  const navigate = useNavigate();

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
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <UConsultingLogo size="large" style={{ marginBottom: '2rem' }} />
            <Typography variant="h1" sx={{ fontSize: '6rem', fontWeight: 700, color: 'primary.main', mb: 2 }}>
              404
            </Typography>
            <Typography variant="h5" sx={{ color: 'text.primary', mb: 1 }}>
              Page Not Found
            </Typography>
            <Typography variant="body1" sx={{ color: 'text.secondary', mb: 4 }}>
              The page you're looking for doesn't exist or has been moved.
            </Typography>
            <Button
              variant="contained"
              size="large"
              onClick={() => navigate('/')}
              sx={{ minWidth: 200 }}
            >
              Go to Dashboard
            </Button>
          </Box>
        </Container>
      </Box>
  );
}
