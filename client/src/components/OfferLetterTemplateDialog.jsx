import React, { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import { Close as CloseIcon, Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

function emptyTemplate() {
  return {
    introText: '',
    terms: [],
    closingText: '',
    checklist: [],
    presidentName: '',
    presidentTitle: 'President, UConsulting',
    responseDeadline: '',
    signatureLabel: 'Signature',
    printedNameLabel: 'Printed Name',
    officialOfferLabel: 'OFFICIAL OFFER LETTER',
    confidentialityLabel: 'U C STRICTLY CONFIDENTIAL',
    signaturePath: ''
  };
}

export default function OfferLetterTemplateDialog({ cycleId, open, onClose }) {
  const [template, setTemplate] = useState(emptyTemplate());
  const [signatureFile, setSignatureFile] = useState(null);
  const [signaturePreview, setSignaturePreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !cycleId) return;
    let cancelled = false;
    setLoading(true);
    apiClient
      .get(`/admin/cycles/${cycleId}/offer-letter-template`)
      .then((data) => {
        if (!cancelled) {
          setTemplate({ ...emptyTemplate(), ...data });
          if (data.signatureUrl) setSignaturePreview(data.signatureUrl);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load template');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cycleId, open]);

  const handleChange = (field) => (e) => {
    setTemplate((prev) => ({ ...prev, [field]: e.target.value }));
    setError('');
  };

  const updateArrayItem = (field, index, value) => {
    setTemplate((prev) => ({
      ...prev,
      [field]: prev[field].map((item, i) => (i === index ? value : item))
    }));
  };

  const addArrayItem = (field) => {
    setTemplate((prev) => ({ ...prev, [field]: [...prev[field], ''] }));
  };

  const removeArrayItem = (field, index) => {
    setTemplate((prev) => ({
      ...prev,
      [field]: prev[field].filter((_, i) => i !== index)
    }));
  };

  const handleSignatureChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSignatureFile(file);
    setSignaturePreview(URL.createObjectURL(file));
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      let signaturePath = template.signaturePath;
      if (signatureFile) {
        const formData = new FormData();
        formData.append('signature', signatureFile);
        const upload = await apiClient.post(`/admin/cycles/${cycleId}/offer-letter-template/signature`, formData);
        signaturePath = upload.path;
      }
      const payload = {
        ...template,
        terms: template.terms.filter(Boolean),
        checklist: template.checklist.filter(Boolean),
        signaturePath
      };
      await apiClient.post(`/admin/cycles/${cycleId}/offer-letter-template`, payload);
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (saving) return;
    setTemplate(emptyTemplate());
    setSignatureFile(null);
    setSignaturePreview(null);
    setError('');
    onClose?.();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Offer Letter Template
        <IconButton
          aria-label="close"
          onClick={handleClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
          disabled={saving}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}
        {loading ? (
          <Typography color="text.secondary">Loading template...</Typography>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="President Name"
              value={template.presidentName}
              onChange={handleChange('presidentName')}
              fullWidth
            />
            <TextField
              label="President Title"
              value={template.presidentTitle}
              onChange={handleChange('presidentTitle')}
              fullWidth
            />
            <TextField
              label="Response Deadline"
              value={template.responseDeadline}
              onChange={handleChange('responseDeadline')}
              fullWidth
              placeholder="e.g. Friday, January 23rd at 11:59 PM"
            />
            <TextField
              label="Introduction"
              value={template.introText}
              onChange={handleChange('introText')}
              fullWidth
              multiline
              rows={5}
              helperText="Use {{candidateName}}, {{position}}, {{cycleName}}, {{startDate}}, and {{responseDeadline}} as placeholders."
            />

            <Typography variant="subtitle2">Expectations / Terms</Typography>
            {template.terms.map((term, idx) => (
              <Stack key={idx} direction="row" spacing={1} alignItems="center">
                <TextField
                  value={term}
                  onChange={(e) => updateArrayItem('terms', idx, e.target.value)}
                  fullWidth
                  placeholder={`Term ${idx + 1}`}
                />
                <IconButton onClick={() => removeArrayItem('terms', idx)} color="error">
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button startIcon={<AddIcon />} onClick={() => addArrayItem('terms')} size="small">
              Add Term
            </Button>

            <TextField
              label="Closing Instructions"
              value={template.closingText}
              onChange={handleChange('closingText')}
              fullWidth
              multiline
              rows={3}
              helperText="Use {{candidateName}}, {{position}}, {{cycleName}}, {{startDate}}, and {{responseDeadline}} as placeholders."
            />

            <Typography variant="subtitle2">Checklist Items</Typography>
            {template.checklist.map((item, idx) => (
              <Stack key={idx} direction="row" spacing={1} alignItems="center">
                <TextField
                  value={item}
                  onChange={(e) => updateArrayItem('checklist', idx, e.target.value)}
                  fullWidth
                  placeholder={`Checklist item ${idx + 1}`}
                />
                <IconButton onClick={() => removeArrayItem('checklist', idx)} color="error">
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button startIcon={<AddIcon />} onClick={() => addArrayItem('checklist')} size="small">
              Add Checklist Item
            </Button>

            <Stack direction="row" spacing={2} alignItems="center">
              <TextField
                label="Official Offer Label"
                value={template.officialOfferLabel}
                onChange={handleChange('officialOfferLabel')}
              />
              <TextField
                label="Confidentiality Label"
                value={template.confidentialityLabel}
                onChange={handleChange('confidentialityLabel')}
              />
            </Stack>

            <Stack direction="row" spacing={2} alignItems="center">
              <TextField
                label="Signature Label"
                value={template.signatureLabel}
                onChange={handleChange('signatureLabel')}
              />
              <TextField
                label="Printed Name Label"
                value={template.printedNameLabel}
                onChange={handleChange('printedNameLabel')}
              />
            </Stack>

            <Stack spacing={1}>
              <Typography variant="subtitle2">President Signature</Typography>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleSignatureChange}
              />
              {signaturePreview && (
                <img
                  src={signaturePreview}
                  alt="President signature preview"
                  style={{ maxWidth: 200, maxHeight: 80, objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 4 }}
                />
              )}
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} variant="contained" disabled={saving || loading}>
          {saving ? 'Saving...' : 'Save Template'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
