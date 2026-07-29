import React, { useState, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  Alert,
  Stack,
  Divider,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import apiClient from '../utils/api';
import MemberAvatar from '../components/MemberAvatar';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const Profile = () => {
  const { user, updateUser } = useAuth();
  const [imageFile, setImageFile] = useState(null);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    setImageFile(file || null);
    setError(null);
    setSuccess(null);
  };

  const handleCancel = () => {
    setImageFile(null);
    setError(null);
    setSuccess(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!imageFile) {
      setError('Please select an image to upload.');
      return;
    }

    if (!imageFile.type.startsWith('image/')) {
      setError('Only image files are allowed.');
      return;
    }

    if (imageFile.size > MAX_FILE_SIZE) {
      setError('File size must be less than 5MB.');
      return;
    }

    const formData = new FormData();
    formData.append('profileImage', imageFile);

    setUploading(true);
    try {
      const response = await apiClient.post(`/users/${user.id}/profile-image`, formData);

      if (response?.user?.id === user?.id) {
        updateUser(response.user);
      }

      setSuccess('Profile image updated successfully.');
      setImageFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      setError(err.message || 'Failed to upload profile image.');
    } finally {
      setUploading(false);
    }
  };

  if (!user) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">Loading profile…</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', p: { xs: 2, md: 3 } }}>
      <Typography variant="h4" component="h1" gutterBottom>
        My Profile
      </Typography>

      <Paper elevation={1} sx={{ p: { xs: 2, md: 3 } }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} alignItems="center" sx={{ mb: 3 }}>
          <MemberAvatar member={user} size={120} />
          <Box>
            <Typography variant="h5" component="h2">
              {user.fullName || 'Unnamed User'}
            </Typography>
            <Typography color="text.secondary">{user.email}</Typography>
            <Typography color="text.secondary" sx={{ textTransform: 'capitalize' }}>
              {user.role?.toLowerCase()}
            </Typography>
          </Box>
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Typography variant="h6" component="h3" gutterBottom>
          Profile Image
        </Typography>

        <Box component="form" onSubmit={handleSubmit}>
          <TextField
            inputRef={fileInputRef}
            fullWidth
            type="file"
            accept="image/*"
            inputProps={{ 'data-testid': 'profile-image-input' }}
            helperText="Max file size: 5MB. Supported formats: JPG, PNG, GIF"
            onChange={handleFileChange}
            sx={{ mb: 2 }}
          />

          {imageFile && (
            <Typography variant="body2" sx={{ mb: 2 }}>
              Selected: {imageFile.name}
            </Typography>
          )}

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {success && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {success}
            </Alert>
          )}

          <Stack direction="row" spacing={2}>
            <Button
              type="submit"
              variant="contained"
              disabled={!imageFile || uploading}
              data-testid="upload-profile-image"
            >
              {uploading ? 'Uploading…' : 'Replace Image'}
            </Button>
            <Button
              variant="outlined"
              onClick={handleCancel}
              disabled={!imageFile || uploading}
            >
              Cancel
            </Button>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
};

export default Profile;
