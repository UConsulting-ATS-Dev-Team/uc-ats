import React, { useEffect, useRef, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { GRADUATION_YEARS } from '../utils/graduationYears';
import {
  discardApplicationVideo,
  uploadApplicationVideo,
  videoProblem,
  VIDEO_ACCEPT,
  MAX_VIDEO_BYTES
} from '../utils/applicationVideoUpload';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const megabytes = (bytes) => Math.round(bytes / (1024 * 1024));

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  email: '',
  studentId: '',
  phoneNumber: '',
  graduationYear: '',
  isTransferStudent: false,
  priorCollegeYears: '',
  cumulativeGpa: '',
  majorGpa: '',
  major1: '',
  major2: '',
  gender: '',
  isFirstGeneration: false,
  headshotUrl: '',
  coverLetterUrl: '',
  shortAnswer: ''
};

const EMPTY_FILES = { resume: null, blindResume: null, video: null };

export default function AddApplicationModal({ isOpen, onClose, onSuccess }) {
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [files, setFiles] = useState(EMPTY_FILES);
  // Fraction of the video sent so far; null when no upload is running.
  const [videoProgress, setVideoProgress] = useState(null);
  // The video already in storage, so a retry after a failed save does not send
  // the same file again.
  const uploadedVideoRef = useRef(null);
  // Aborted when the form closes, so a submit still uploading does not go on
  // to create the application.
  const submitRef = useRef(null);

  // A video whose save went unanswered is left in storage: the application may
  // have been created after all, and would then name a file this just removed.
  const discardUploadedVideo = () => {
    const uploaded = uploadedVideoRef.current;
    if (uploaded && !uploaded.saveUnanswered) discardApplicationVideo(uploaded.documentId);
    uploadedVideoRef.current = null;
  };
  const [loading, setLoading] = useState(false);
  // True while the application itself is being created. That request cannot be
  // taken back, so the form cannot be closed until it answers.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Closing unmounts the file inputs, so they come back empty. Forget the files
  // with them, or a reopened form would send one its inputs no longer show.
  // That includes a video already uploaded for a save that then failed.
  useEffect(() => {
    if (isOpen) return;
    submitRef.current?.abort();
    setFiles(EMPTY_FILES);
    discardUploadedVideo();
  }, [isOpen]);

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleFileChange = (e) => {
    const { name } = e.target;
    const file = e.target.files?.[0] || null;
    setError(null);

    let problem = null;
    if (file && name === 'video') {
      problem = videoProblem(file);
    } else if (file) {
      const label = name === 'resume' ? 'The resume' : 'The blind resume';
      if (file.type !== 'application/pdf') problem = `${label} must be a PDF`;
      else if (file.size > MAX_PDF_BYTES) problem = `${label} must be smaller than ${megabytes(MAX_PDF_BYTES)}MB`;
    }

    if (problem) {
      setError(problem);
      e.target.value = '';
    }
    setFiles(prev => ({ ...prev, [name]: problem ? null : file }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const submit = new AbortController();
    submitRef.current = submit;

    try {
      // Validate required fields
      const requiredFields = ['firstName', 'lastName', 'email', 'studentId', 'phoneNumber', 'graduationYear', 'cumulativeGpa', 'major1', 'headshotUrl'];
      const missingFields = requiredFields.filter(field => {
        const value = formData[field];
        return !value || (typeof value === 'string' && value.trim() === '') || (typeof value === 'number' && isNaN(value));
      });
      
      if (!files.resume) missingFields.push('resume');

      if (missingFields.length > 0) {
        setError(`Please fill in all required fields: ${missingFields.join(', ')}`);
        setLoading(false);
        return;
      }

      // Additional validation for GPA
      if (isNaN(parseFloat(formData.cumulativeGpa)) || parseFloat(formData.cumulativeGpa) < 0 || parseFloat(formData.cumulativeGpa) > 4) {
        setError('Cumulative GPA must be a number between 0 and 4');
        setLoading(false);
        return;
      }

      // The video goes to storage first, straight from the browser; the
      // application then names it.
      let videoDocumentId = null;
      if (files.video) {
        if (uploadedVideoRef.current?.file !== files.video) {
          // A different video than the one uploaded for an earlier attempt.
          discardUploadedVideo();
          setVideoProgress(0);
          const documentId = await uploadApplicationVideo(files.video, setVideoProgress, submit.signal);
          if (submit.signal.aborted) {
            // Closed just as the upload finished.
            discardApplicationVideo(documentId);
            return;
          }
          uploadedVideoRef.current = { file: files.video, documentId };
          setVideoProgress(null);
        }
        videoDocumentId = uploadedVideoRef.current.documentId;
      } else {
        discardUploadedVideo();
      }

      const body = new FormData();
      Object.entries(formData).forEach(([key, value]) => body.append(key, value));
      body.set('cumulativeGpa', parseFloat(formData.cumulativeGpa));
      // Major GPA is sent as 0.00 when left empty
      body.set('majorGpa', formData.majorGpa !== '' ? parseFloat(formData.majorGpa) : 0.00);
      body.append('responseID', `manual-${Date.now()}`); // Generate unique response ID
      body.append('resume', files.resume);
      if (files.blindResume) body.append('blindResume', files.blindResume);
      if (videoDocumentId) body.append('videoDocumentId', videoDocumentId);

      setSaving(true);
      try {
        await apiClient.post('/applications/manual', body);
      } catch (err) {
        // Only the server's own answer says the application was not created. A
        // dropped connection or a proxy's 502/504 says nothing either way.
        const refused = err.status && (err.status < 502 || err.code);
        if (!refused && uploadedVideoRef.current) uploadedVideoRef.current.saveUnanswered = true;
        throw err;
      }
      // The application names the video now; closing must not discard it.
      uploadedVideoRef.current = null;
      onSuccess();
      onClose();

      // Reset form
      setFormData(EMPTY_FORM);
      setFiles(EMPTY_FILES);
    } catch (err) {
      // Closing the form is what aborts an upload; there is nobody to tell.
      if (err.name !== 'AbortError') setError(err.message || 'Failed to create application');
    } finally {
      setSaving(false);
      setLoading(false);
      setVideoProgress(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Add New Application</h2>
          <button className="close-btn" onClick={onClose} disabled={saving}>
            <XMarkIcon className="close-icon" />
          </button>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="application-form">
          {/* Nothing can be edited while it is being sent: the submit already
              holds the values and files it started with. */}
          <fieldset disabled={loading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="form-section">
            <h3>Personal Information</h3>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="firstName">First Name *</label>
                <input
                  type="text"
                  id="firstName"
                  name="firstName"
                  value={formData.firstName}
                  onChange={handleInputChange}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="lastName">Last Name *</label>
                <input
                  type="text"
                  id="lastName"
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleInputChange}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="email">Email *</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="studentId">Student ID *</label>
                <input
                  type="text"
                  id="studentId"
                  name="studentId"
                  value={formData.studentId}
                  onChange={handleInputChange}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="phoneNumber">Phone Number *</label>
                <input
                  type="tel"
                  id="phoneNumber"
                  name="phoneNumber"
                  value={formData.phoneNumber}
                  onChange={handleInputChange}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="graduationYear">Graduation Year *</label>
                <select
                  id="graduationYear"
                  name="graduationYear"
                  value={formData.graduationYear}
                  onChange={handleInputChange}
                  required
                >
                  <option value="">Select Year</option>
                  {GRADUATION_YEARS.map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="gender">Gender</label>
                <select
                  id="gender"
                  name="gender"
                  value={formData.gender}
                  onChange={handleInputChange}
                >
                  <option value="">Select Gender</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="form-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="isTransferStudent"
                    checked={formData.isTransferStudent}
                    onChange={handleInputChange}
                  />
                  Transfer Student
                </label>
              </div>
            </div>

            {formData.isTransferStudent && (
              <div className="form-group">
                <label htmlFor="priorCollegeYears">Prior College Years</label>
                <input
                  type="text"
                  id="priorCollegeYears"
                  name="priorCollegeYears"
                  value={formData.priorCollegeYears}
                  onChange={handleInputChange}
                  placeholder="e.g., 2 years"
                />
              </div>
            )}

            <div className="form-group checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="isFirstGeneration"
                  checked={formData.isFirstGeneration}
                  onChange={handleInputChange}
                />
                First Generation Student
              </label>
            </div>
          </div>

          <div className="form-section">
            <h3>Academic Information</h3>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="cumulativeGpa">Cumulative GPA *</label>
                <input
                  type="number"
                  id="cumulativeGpa"
                  name="cumulativeGpa"
                  value={formData.cumulativeGpa}
                  onChange={handleInputChange}
                  min="0"
                  max="4"
                  step="0.01"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="majorGpa">Major GPA</label>
                <input
                  type="number"
                  id="majorGpa"
                  name="majorGpa"
                  value={formData.majorGpa}
                  onChange={handleInputChange}
                  min="0"
                  max="4"
                  step="0.01"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="major1">Primary Major *</label>
                <input
                  type="text"
                  id="major1"
                  name="major1"
                  value={formData.major1}
                  onChange={handleInputChange}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="major2">Secondary Major</label>
                <input
                  type="text"
                  id="major2"
                  name="major2"
                  value={formData.major2}
                  onChange={handleInputChange}
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <h3>Application Materials</h3>
            <div className="form-group">
              <label htmlFor="resume">Resume (PDF) *</label>
              <input
                type="file"
                id="resume"
                name="resume"
                accept="application/pdf"
                onChange={handleFileChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="blindResume">Blind Resume (PDF)</label>
              <input
                type="file"
                id="blindResume"
                name="blindResume"
                accept="application/pdf"
                onChange={handleFileChange}
              />
            </div>

            <div className="form-group">
              <label htmlFor="headshotUrl">Headshot URL *</label>
              <input
                type="url"
                id="headshotUrl"
                name="headshotUrl"
                value={formData.headshotUrl}
                onChange={handleInputChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="coverLetterUrl">Cover Letter URL</label>
              <input
                type="url"
                id="coverLetterUrl"
                name="coverLetterUrl"
                value={formData.coverLetterUrl}
                onChange={handleInputChange}
              />
            </div>

            <div className="form-group">
              <label htmlFor="shortAnswer">Short Answer Response</label>
              <textarea
                id="shortAnswer"
                name="shortAnswer"
                rows={5}
                value={formData.shortAnswer}
                onChange={handleInputChange}
                placeholder="Paste the applicant's response"
              />
            </div>

            <div className="form-group">
              <label htmlFor="video">Video (up to {megabytes(MAX_VIDEO_BYTES)}MB)</label>
              <input
                type="file"
                id="video"
                name="video"
                accept={VIDEO_ACCEPT}
                onChange={handleFileChange}
              />
              {videoProgress !== null && (
                <progress
                  value={videoProgress}
                  max={1}
                  aria-label="Video upload progress"
                  style={{ width: '100%', marginTop: '0.5rem' }}
                />
              )}
            </div>
          </div>

          </fieldset>

          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={saving} className="cancel-btn">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="submit-btn">
              {videoProgress !== null && videoProgress < 1
                ? `Uploading video ${Math.round(videoProgress * 100)}%`
                : loading ? 'Creating...' : 'Create Application'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
