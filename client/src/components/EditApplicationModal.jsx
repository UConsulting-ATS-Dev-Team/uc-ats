import React, { useState, useEffect } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { GRADUATION_YEARS } from '../utils/graduationYears';

export default function EditApplicationModal({ isOpen, onClose, onSuccess, application }) {
  const [formData, setFormData] = useState({
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
    resumeUrl: '',
    headshotUrl: '',
    coverLetterUrl: '',
    videoUrl: '',
    blindResumeUrl: '',
    status: 'SUBMITTED'
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (application && isOpen) {
      setFormData({
        firstName: application.firstName || '',
        lastName: application.lastName || '',
        email: application.email || '',
        studentId: application.studentId || '',
        phoneNumber: application.phoneNumber || '',
        graduationYear: application.graduationYear || '',
        isTransferStudent: application.isTransferStudent || false,
        priorCollegeYears: application.priorCollegeYears || '',
        cumulativeGpa: application.cumulativeGpa?.toString() || '',
        majorGpa: application.majorGpa?.toString() || '',
        major1: application.major1 || '',
        major2: application.major2 || '',
        gender: application.gender || '',
        isFirstGeneration: application.isFirstGeneration || false,
        resumeUrl: application.resumeUrl || '',
        headshotUrl: application.headshotUrl || '',
        coverLetterUrl: application.coverLetterUrl || '',
        videoUrl: application.videoUrl || '',
        blindResumeUrl: application.blindResumeUrl || '',
        status: application.status || 'SUBMITTED'
      });
    }
  }, [application, isOpen]);

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Validate required fields
      const requiredFields = ['firstName', 'lastName', 'email', 'studentId', 'phoneNumber', 'graduationYear', 'cumulativeGpa', 'major1', 'resumeUrl', 'headshotUrl'];
      const missingFields = requiredFields.filter(field => {
        const value = formData[field];
        return !value || (typeof value === 'string' && value.trim() === '') || (typeof value === 'number' && isNaN(value));
      });
      
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

      // Prepare update data
      const updateData = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        studentId: formData.studentId,
        phoneNumber: formData.phoneNumber,
        graduationYear: formData.graduationYear,
        isTransferStudent: formData.isTransferStudent,
        priorCollegeYears: formData.priorCollegeYears || null,
        cumulativeGpa: parseFloat(formData.cumulativeGpa),
        majorGpa: formData.majorGpa && formData.majorGpa !== '' ? parseFloat(formData.majorGpa) : null,
        major1: formData.major1,
        major2: formData.major2 || null,
        gender: formData.gender || null,
        isFirstGeneration: formData.isFirstGeneration,
        resumeUrl: formData.resumeUrl,
        headshotUrl: formData.headshotUrl,
        coverLetterUrl: formData.coverLetterUrl || null,
        videoUrl: formData.videoUrl || null,
        blindResumeUrl: formData.blindResumeUrl || null,
        status: formData.status
      };

      await apiClient.put(`/admin/candidates/${application.id}`, updateData);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to update application');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !application) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Edit Application</h2>
          <button className="close-btn" onClick={onClose}>
            <XMarkIcon className="close-icon" />
          </button>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="application-form">
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
                <label htmlFor="status">Status *</label>
                <select
                  id="status"
                  name="status"
                  value={formData.status}
                  onChange={handleInputChange}
                  required
                >
                  <option value="SUBMITTED">Submitted</option>
                  <option value="UNDER_REVIEW">Under Review</option>
                  <option value="ACCEPTED">Accepted</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="WAITLISTED">Waitlisted</option>
                </select>
              </div>
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
            </div>

            <div className="form-row">
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
              <label htmlFor="resumeUrl">Resume URL *</label>
              <input
                type="url"
                id="resumeUrl"
                name="resumeUrl"
                value={formData.resumeUrl}
                onChange={handleInputChange}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="blindResumeUrl">Blind Resume URL</label>
              <input
                type="url"
                id="blindResumeUrl"
                name="blindResumeUrl"
                value={formData.blindResumeUrl}
                onChange={handleInputChange}
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
              <label htmlFor="videoUrl">Video URL</label>
              <input
                type="url"
                id="videoUrl"
                name="videoUrl"
                value={formData.videoUrl}
                onChange={handleInputChange}
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="button" onClick={onClose} className="cancel-btn">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="submit-btn">
              {loading ? 'Updating...' : 'Update Application'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

