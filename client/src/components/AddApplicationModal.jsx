import React, { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import apiClient from '../utils/api';
import { GRADUATION_YEARS } from '../utils/graduationYears';

export default function AddApplicationModal({ isOpen, onClose, onSuccess }) {
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
    videoUrl: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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

      // Convert GPA to decimal format
      const applicationData = {
        ...formData,
        cumulativeGpa: parseFloat(formData.cumulativeGpa),
        responseID: `manual-${Date.now()}`, // Generate unique response ID
        rawResponses: {} // Empty object for manual applications
      };

      // Handle majorGpa - send 0.00 if empty, otherwise parse the value
      if (formData.majorGpa && formData.majorGpa !== '') {
        applicationData.majorGpa = parseFloat(formData.majorGpa);
      } else {
        applicationData.majorGpa = 0.00;
      }

      await apiClient.post('/applications/manual', applicationData);
      onSuccess();
      onClose();
      
      // Reset form
      setFormData({
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
        videoUrl: ''
      });
    } catch (err) {
      setError(err.message || 'Failed to create application');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Add New Application</h2>
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
              {loading ? 'Creating...' : 'Create Application'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
