import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material';
import { Close as CloseIcon, Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import apiClient from '../utils/api';

function base64ToBlob(base64, contentType) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: contentType });
}

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
    confidentialityLabel: 'STRICTLY CONFIDENTIAL',
    signaturePath: ''
  };
}

function isTemplateReady(template) {
  return Boolean(
    template &&
      template.presidentName?.trim() &&
      template.signaturePath?.trim() &&
      template.terms &&
      template.terms.length > 0 &&
      template.terms.every((t) => t.trim())
  );
}

function statusLabel(status) {
  if (status === 'sent') return 'Sent';
  if (status === 'pending') return 'In progress';
  if (status === 'failed') return 'Failed';
  return 'Not sent';
}

export default function CycleOfferLetterDialog({ cycleId, open, onClose }) {
  const [tab, setTab] = useState(0);
  const [template, setTemplate] = useState(emptyTemplate());
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [signatureFile, setSignatureFile] = useState(null);
  const [signaturePreview, setSignaturePreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Preview tab state
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewForm, setPreviewForm] = useState({
    sampleFirstName: 'Sample',
    sampleLastName: 'Candidate',
    responseDeadline: ''
  });

  // Send tab state
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [sending, setSending] = useState(false);
  const [sendForm, setSendForm] = useState({
    position: '',
    startDate: '',
    responseDeadline: ''
  });
  const [force, setForce] = useState(false);

  const resetDialog = () => {
    setTab(0);
    setTemplate(emptyTemplate());
    setTemplateLoaded(false);
    setSignatureFile(null);
    setSignaturePreview(null);
    setError('');
    setSuccess('');
    setPreviewUrl(null);
    setPreviewForm({ sampleFirstName: 'Sample', sampleLastName: 'Candidate', responseDeadline: '' });
    setCandidates([]);
    setSelected(new Set());
    setSendForm({ position: '', startDate: '', responseDeadline: '' });
    setForce(false);
  };

  const fetchTemplate = async () => {
    if (!cycleId) return;
    const data = await apiClient.get(`/admin/cycles/${cycleId}/offer-letter-template`);
    const merged = { ...emptyTemplate(), ...data };
    setTemplate(merged);
    setTemplateLoaded(true);
    setPreviewForm((prev) => ({
      ...prev,
      responseDeadline: merged.responseDeadline || prev.responseDeadline
    }));
    setSendForm((prev) => ({
      ...prev,
      responseDeadline: merged.responseDeadline || prev.responseDeadline
    }));
    if (merged.signaturePath) {
      try {
        const sig = await apiClient.get(`/admin/cycles/${cycleId}/offer-letter-template/signature`);
        setSignaturePreview(sig.signedUrl);
      } catch (e) {
        console.warn('Failed to load persisted signature preview:', e);
        setSignaturePreview(null);
      }
    } else {
      setSignaturePreview(null);
    }
  };

  useEffect(() => {
    if (!open || !cycleId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSuccess('');
    fetchTemplate()
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Failed to load offer letter template');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId, open]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleChange = (field) => (e) => {
    setTemplate((prev) => ({ ...prev, [field]: e.target.value }));
    setError('');
    setSuccess('');
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
    setSuccess('');
  };

  const handleRemoveSignature = () => {
    setSignatureFile(null);
    setSignaturePreview(null);
    setTemplate((prev) => ({ ...prev, signaturePath: '' }));
    setSuccess('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      let nextSignaturePath = template.signaturePath;
      if (signatureFile) {
        const formData = new FormData();
        formData.append('signature', signatureFile);
        const upload = await apiClient.post(`/admin/cycles/${cycleId}/offer-letter-template/signature`, formData);
        nextSignaturePath = upload.path;
      }
      const payload = {
        ...template,
        terms: template.terms.filter(Boolean),
        checklist: template.checklist.filter(Boolean),
        signaturePath: nextSignaturePath
      };
      await apiClient.post(`/admin/cycles/${cycleId}/offer-letter-template`, payload);

      // Refetch to confirm persistence before closing/switching tabs.
      await fetchTemplate();
      setSignatureFile(null);
      setSuccess('Template saved successfully. Preview and Send are now available.');
    } catch (e) {
      setError(e.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setError('');
    try {
      const { pdf } = await apiClient.post(`/admin/cycles/${cycleId}/offer-letter-preview`, {
        responseDeadline: previewForm.responseDeadline.trim() || template.responseDeadline,
        sampleFirstName: previewForm.sampleFirstName.trim(),
        sampleLastName: previewForm.sampleLastName.trim()
      });
      const blob = base64ToBlob(pdf, 'application/pdf');
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e.message || 'Failed to generate preview');
    } finally {
      setPreviewing(false);
    }
  };

  const fetchCandidates = async () => {
    try {
      const data = await apiClient.get(`/admin/cycles/${cycleId}/offer-letter-candidates`);
      setCandidates(data.candidates || []);
      setSelected(new Set());
    } catch (e) {
      setError(e.message || 'Failed to load candidates');
    }
  };

  const toggleSelect = (applicationId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === candidates.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(candidates.map((c) => c.applicationId)));
    }
  };

  const handleSend = async () => {
    setError('');
    setSuccess('');
    if (selected.size === 0) {
      setError('Select at least one candidate');
      return;
    }
    if (!sendForm.position.trim() || !sendForm.responseDeadline.trim()) {
      setError('Position and response deadline are required');
      return;
    }
    setSending(true);
    try {
      const { results } = await apiClient.post(`/admin/cycles/${cycleId}/send-offer-letters`, {
        applicationIds: Array.from(selected),
        position: sendForm.position.trim(),
        startDate: sendForm.startDate.trim(),
        responseDeadline: sendForm.responseDeadline.trim(),
        force
      });
      const sent = results.filter((r) => r.success).length;
      const alreadySent = results.filter((r) => r.alreadySent).length;
      const failed = results.filter((r) => !r.success && !r.alreadySent).length;
      setSuccess(`Sent: ${sent}, Already sent/skipped: ${alreadySent}, Failed: ${failed}`);
      await fetchCandidates();
      setSelected(new Set());
    } catch (e) {
      setError(e.message || 'Failed to send offer letters');
    } finally {
      setSending(false);
    }
  };

  const handleTabChange = async (event, newValue) => {
    setError('');
    setSuccess('');
    if (newValue === 2) {
      // Refresh candidates when switching to Send tab.
      setLoading(true);
      try {
        await fetchCandidates();
      } finally {
        setLoading(false);
      }
    }
    setTab(newValue);
  };

  const handleClose = () => {
    if (saving || sending || previewing) return;
    resetDialog();
    onClose?.();
  };

  const ready = isTemplateReady(template);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        Offer Letters
        <IconButton aria-label="close" onClick={handleClose} sx={{ position: 'absolute', right: 8, top: 8 }} disabled={saving || sending || previewing}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
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
        {loading && !templateLoaded ? (
          <Typography color="text.secondary">Loading template...</Typography>
        ) : (
          <>
            <Tabs value={tab} onChange={handleTabChange} sx={{ mb: 2 }}>
              <Tab label="Configure" />
              <Tab label="Preview" disabled={!ready} />
              <Tab label="Send" disabled={!ready} />
            </Tabs>

            {tab === 0 && (
              <Stack spacing={2}>
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
                  {template.signaturePath && !signatureFile && (
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                      <Chip label="Saved" color="success" size="small" />
                      {signaturePreview && (
                        <img
                          src={signaturePreview}
                          alt="President signature"
                          style={{ maxWidth: 200, maxHeight: 80, objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 4 }}
                        />
                      )}
                    </Stack>
                  )}
                  {signatureFile && signaturePreview && (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip label="New upload (not saved)" color="warning" size="small" />
                      <img
                        src={signaturePreview}
                        alt="New signature preview"
                        style={{ maxWidth: 200, maxHeight: 80, objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 4 }}
                      />
                    </Stack>
                  )}
                  <Stack direction="row" spacing={1}>
                    <Button variant="outlined" component="label" size="small">
                      {template.signaturePath ? 'Replace' : 'Upload'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        onChange={handleSignatureChange}
                      />
                    </Button>
                    {(template.signaturePath || signatureFile) && (
                      <Button variant="outlined" color="error" size="small" onClick={handleRemoveSignature}>
                        Remove
                      </Button>
                    )}
                  </Stack>
                </Stack>
              </Stack>
            )}

            {tab === 1 && (
              <Stack spacing={2}>
                {!ready && (
                  <Alert severity="warning">
                    Complete the Configure tab with president name, signature, and at least one term before previewing.
                  </Alert>
                )}
                <Stack direction="row" spacing={2}>
                  <TextField
                    label="Sample First Name"
                    value={previewForm.sampleFirstName}
                    onChange={(e) => setPreviewForm((prev) => ({ ...prev, sampleFirstName: e.target.value }))}
                    fullWidth
                  />
                  <TextField
                    label="Sample Last Name"
                    value={previewForm.sampleLastName}
                    onChange={(e) => setPreviewForm((prev) => ({ ...prev, sampleLastName: e.target.value }))}
                    fullWidth
                  />
                </Stack>
                <TextField
                  label="Response Deadline"
                  value={previewForm.responseDeadline}
                  onChange={(e) => setPreviewForm((prev) => ({ ...prev, responseDeadline: e.target.value }))}
                  fullWidth
                />
                <Button
                  variant="contained"
                  onClick={handlePreview}
                  disabled={previewing || !ready}
                >
                  {previewing ? 'Generating Preview...' : 'Generate Preview'}
                </Button>
                {previewUrl && (
                  <iframe
                    src={previewUrl}
                    title="Offer Letter Preview"
                    style={{ width: '100%', height: '500px', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                  />
                )}
              </Stack>
            )}

            {tab === 2 && (
              <Stack spacing={2}>
                {!ready && (
                  <Alert severity="warning">
                    Complete the Configure tab with president name, signature, and at least one term before sending.
                  </Alert>
                )}
                <TextField
                  label="Position"
                  value={sendForm.position}
                  onChange={(e) => setSendForm((prev) => ({ ...prev, position: e.target.value }))}
                  fullWidth
                />
                <TextField
                  label="Start Date"
                  value={sendForm.startDate}
                  onChange={(e) => setSendForm((prev) => ({ ...prev, startDate: e.target.value }))}
                  fullWidth
                />
                <TextField
                  label="Response Deadline"
                  value={sendForm.responseDeadline}
                  onChange={(e) => setSendForm((prev) => ({ ...prev, responseDeadline: e.target.value }))}
                  fullWidth
                />

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                    />
                  }
                  label="Force resend to candidates who already received an offer letter"
                />

                <Typography variant="subtitle2">Final Round Accepted Candidates</Typography>

                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={candidates.length > 0 && selected.size === candidates.length}
                          indeterminate={selected.size > 0 && selected.size < candidates.length}
                          onChange={toggleSelectAll}
                        />
                      </TableCell>
                      <TableCell>Name</TableCell>
                      <TableCell>Email</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Sent At</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {candidates.map((c) => (
                      <TableRow key={c.applicationId} hover>
                        <TableCell padding="checkbox">
                          <Checkbox
                            checked={selected.has(c.applicationId)}
                            onChange={() => toggleSelect(c.applicationId)}
                          />
                        </TableCell>
                        <TableCell>{c.firstName}&nbsp;{c.lastName}</TableCell>
                        <TableCell>{c.email}</TableCell>
                        <TableCell>{statusLabel(c.status)}</TableCell>
                        <TableCell>{c.sentAt ? new Date(c.sentAt).toLocaleString() : '-'}</TableCell>
                      </TableRow>
                    ))}
                    {candidates.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} align="center">
                          No Final Round accepted candidates found for this cycle.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Stack>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving || sending || previewing}>
          Close
        </Button>
        {tab === 0 && (
          <Button onClick={handleSave} variant="contained" disabled={saving || loading}>
            {saving ? 'Saving...' : 'Save Template'}
          </Button>
        )}
        {tab === 2 && (
          <Button
            onClick={handleSend}
            variant="contained"
            disabled={sending || !ready || selected.size === 0 || !sendForm.position.trim() || !sendForm.responseDeadline.trim()}
          >
            {sending ? 'Sending...' : `Send to ${selected.size} Selected`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
