import React, { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '../utils/api';
import AccessControl from '../components/AccessControl';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import ResumeReuploadSection from '../components/ResumeReuploadSection';
import OnboardingResumeSection from '../components/OnboardingResumeSection';
import ApplicantTalentPoolSection from '../components/ApplicantTalentPoolSection';
import '../styles/ApplicantInformation.css';

// The fields a candidate may correct themselves, in the order they are shown.
// `email` and `studentId` are absent on purpose — they are the identifiers the
// server matches an application to its applicant on, so they are displayed
// read-only and changed by an admin. The server enforces this independently;
// this list only decides what gets rendered.
const SECTIONS = [
  {
    title: 'Personal details',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', required: true },
      { name: 'lastName', label: 'Last name', type: 'text', required: true },
      { name: 'phoneNumber', label: 'Phone number', type: 'tel', required: true },
      { name: 'gender', label: 'Gender', type: 'text', hint: 'Optional' },
    ],
  },
  {
    title: 'Academic details',
    fields: [
      { name: 'graduationYear', label: 'Graduation year', type: 'text', required: true },
      { name: 'major1', label: 'Primary major', type: 'text', required: true },
      { name: 'major2', label: 'Second major', type: 'text', hint: 'Optional' },
      {
        name: 'cumulativeGpa',
        label: 'Cumulative GPA',
        type: 'number',
        required: true,
        step: '0.01',
        min: '0',
        max: '5',
      },
      {
        name: 'majorGpa',
        label: 'Major GPA',
        type: 'number',
        hint: 'Optional',
        step: '0.01',
        min: '0',
        max: '5',
      },
    ],
  },
  {
    title: 'Background',
    fields: [
      { name: 'isTransferStudent', label: 'Are you a transfer student?', type: 'boolean' },
      {
        name: 'priorCollegeYears',
        label: 'Years at your prior college',
        type: 'text',
        hint: 'Optional',
        // Only meaningful for a transfer student, and the server nulls it out
        // when transfer status is turned off.
        dependsOn: 'isTransferStudent',
      },
      { name: 'isFirstGeneration', label: 'Are you a first-generation college student?', type: 'boolean' },
    ],
  },
];

const EDITABLE_NAMES = SECTIONS.flatMap((section) => section.fields.map((field) => field.name));

// What a candidate who onboarded instead of applying can maintain here.
//
// Their details live on CandidateOnboarding, which stores everything above
// except a name (that is on the Candidate row), a major GPA and prior college
// years — the application form asks for those and the onboarding module does
// not. Rendering a field with nothing behind it would invite an edit that
// silently goes nowhere.
const ONBOARDING_FIELD_NAMES = new Set([
  'phoneNumber',
  'gender',
  'graduationYear',
  'major1',
  'major2',
  'cumulativeGpa',
  'isTransferStudent',
  'isFirstGeneration',
]);

const onboardingSections = () =>
  SECTIONS.map((section) => ({
    ...section,
    fields: section.fields.filter((field) => ONBOARDING_FIELD_NAMES.has(field.name)),
  })).filter((section) => section.fields.length > 0);

// The onboarding record uses the same field names as an application, so the
// existing form state maps straight across.
const onboardingToFormState = (record) => ({
  phoneNumber: record.phoneNumber ?? '',
  gender: record.gender ?? '',
  graduationYear: record.graduationYear ?? '',
  major1: record.major1 ?? '',
  major2: record.major2 ?? '',
  cumulativeGpa: record.cumulativeGpa ?? '',
  isTransferStudent: Boolean(record.isTransferStudent),
  isFirstGeneration: Boolean(record.isFirstGeneration),
});

// Inputs are controlled, so every value has to be a string (or a boolean for the
// yes/no fields) — null would make React treat the input as uncontrolled.
function toFormState(application) {
  const state = {};
  for (const name of EDITABLE_NAMES) {
    const value = application[name];
    state[name] = typeof value === 'boolean' ? value : value === null || value === undefined ? '' : String(value);
  }
  return state;
}

function changedFields(form, baseline) {
  return Object.fromEntries(Object.entries(form).filter(([name, value]) => value !== baseline[name]));
}

export default function ApplicantInformation() {
  const [applications, setApplications] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [record, setRecord] = useState(null);
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [preview, setPreview] = useState({ open: false, src: '', title: '' });
  // 'application' when editing a submitted application, 'onboarding' when the
  // candidate never applied and is maintaining what they gave us at signup.
  const [mode, setMode] = useState('application');

  /**
   * Load what this candidate gave us at signup, for someone with no application.
   *
   * Their details should stay theirs to keep current whether or not they ever
   * applied - before this the page simply told them they had nothing here, even
   * though they had filled the whole module in.
   */
  const loadOnboarding = useCallback(async () => {
    try {
      const data = await apiClient.get('/candidate/onboarding/status');
      if (data?.onboarding) {
        setMode('onboarding');
        setRecord(data.onboarding);
        const initial = onboardingToFormState(data.onboarding);
        setForm(initial);
        setBaseline(initial);
      }
    } catch {
      // Leave the empty state as it was. Someone with neither an application nor
      // an onboarding record genuinely has nothing to edit here.
    } finally {
      setLoading(false);
    }
  }, []);

  // Which application to edit. A candidate can have one per cycle, so prefer the
  // one still open, then the most recent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.get('/applications/my-applications');
        if (cancelled) return;
        const list = data?.applications || data || [];
        setApplications(list);
        const active = list.find((a) => a.cycle?.isActive);
        const newest = [...list].sort(
          (a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)
        )[0];
        setSelectedId((active || newest)?.id ?? null);
        if (list.length === 0) await loadOnboarding();
      } catch (e) {
        if (cancelled) return;
        // A candidate with no application yet gets a 404 from this endpoint;
        // that is an empty state, not a failure.
        const noApplication =
          e.message?.includes('User not found or no studentId associated') ||
          e.message?.includes('Candidate not found for this user');
        if (!noApplication) setLoadError(e.message || 'Failed to load your applications');
        setApplications([]);
        await loadOnboarding();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOnboarding]);

  const loadRecord = useCallback(async (applicationId) => {
    setLoading(true);
    setLoadError('');
    setConfirmation('');
    setSaveError('');
    try {
      const data = await apiClient.get(`/applicant-info/applications/${applicationId}`);
      setRecord(data);
      const initial = toFormState(data);
      setForm(initial);
      setBaseline(initial);
    } catch (e) {
      setLoadError(e.message || 'Failed to load your information');
      setRecord(null);
      setForm(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadRecord(selectedId);
  }, [selectedId, loadRecord]);

  const dirty = useMemo(
    () => (form && baseline ? Object.keys(changedFields(form, baseline)).length > 0 : false),
    [form, baseline]
  );

  const setField = (name, value) => {
    setConfirmation('');
    setSaveError('');
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!dirty || saving) return;

    setSaving(true);
    setSaveError('');
    setConfirmation('');
    try {
      if (mode === 'onboarding') {
        // Sent whole rather than as a diff: the onboarding endpoint validates
        // every field together, the way the module itself does, so a partial
        // body would fail on the fields that were not touched.
        const result = await apiClient.patch('/candidate/onboarding', form);
        const updated = result.onboarding;
        setRecord(updated);
        const next = onboardingToFormState(updated);
        setForm(next);
        setBaseline(next);
        setConfirmation(result.message || 'Your information has been updated.');
        return;
      }

      const result = await apiClient.patch(
        `/applicant-info/applications/${selectedId}`,
        changedFields(form, baseline)
      );
      const updated = result.application;
      setRecord(updated);
      const next = toFormState(updated);
      setForm(next);
      setBaseline(next);
      setConfirmation(result.message || 'Your information has been updated.');
    } catch (e) {
      setSaveError(e.message || 'Failed to update your information');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setForm(baseline);
    setSaveError('');
    setConfirmation('');
  };

  const renderField = (field) => {
    const value = form[field.name];

    if (field.type === 'boolean') {
      return (
        <div className="applicant-field" key={field.name}>
          <span className="applicant-label">{field.label}</span>
          <div className="applicant-radio-group" role="radiogroup" aria-label={field.label}>
            {[
              { label: 'Yes', selected: value === true },
              { label: 'No', selected: value === false },
            ].map((option) => (
              <label key={option.label} className="applicant-radio">
                <input
                  type="radio"
                  name={field.name}
                  checked={option.selected}
                  onChange={() => setField(field.name, option.label === 'Yes')}
                  disabled={saving}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      );
    }

    // Prior college years is only asked of transfer students.
    if (field.dependsOn && form[field.dependsOn] !== true) return null;

    return (
      <div className="applicant-field" key={field.name}>
        <label className="applicant-label" htmlFor={`field-${field.name}`}>
          {field.label}
          {field.required && <span className="applicant-required" aria-hidden="true"> *</span>}
          {field.hint && <span className="applicant-hint"> ({field.hint})</span>}
        </label>
        <input
          id={`field-${field.name}`}
          className="applicant-input"
          type={field.type}
          value={value}
          step={field.step}
          min={field.min}
          max={field.max}
          required={field.required}
          disabled={saving}
          onChange={(e) => setField(field.name, e.target.value)}
        />
      </div>
    );
  };

  return (
    <AccessControl allowedRoles={['USER']}>
      <div className="applicant-info-container">
        <header className="applicant-info-header">
          <h1>Update Applicant Information</h1>
          <p>
            Keep your application details current. Changes are visible to the recruitment team
            straight away.
          </p>
        </header>

        {applications.length > 1 && (
          <div className="applicant-cycle-picker">
            <label className="applicant-label" htmlFor="application-select">
              Application
            </label>
            <select
              id="application-select"
              className="applicant-input"
              value={selectedId || ''}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={saving}
            >
              {applications.map((application) => (
                <option key={application.id} value={application.id}>
                  {application.cycle?.name || 'Application'}
                  {application.cycle?.isActive ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {loading && <p className="applicant-note">Loading your information…</p>}
        {!loading && loadError && <p className="applicant-error">{loadError}</p>}
        {!loading && !loadError && applications.length === 0 && mode === 'onboarding' && (
          <p className="applicant-note">
            You have not applied yet. This is the information you gave us when you signed up —
            keeping it current means partner organizations see the right details.
          </p>
        )}

        {!loading && !loadError && applications.length === 0 && mode !== 'onboarding' && (
          <p className="applicant-note">
            You do not have an application yet. Once you apply, you can update your details here.
          </p>
        )}

        {!loading && !loadError && record && form && (
          <>
            <form className="applicant-card" onSubmit={handleSubmit}>
              {mode !== 'onboarding' && (
              <section className="applicant-section">
                <h2 className="applicant-section-title">Identity</h2>
                <p className="applicant-note">
                  Your email and student ID identify your application to the recruitment team and
                  cannot be changed here. Contact us if either one is wrong.
                </p>
                <div className="applicant-grid">
                  <div className="applicant-field">
                    <span className="applicant-label">Email</span>
                    <span className="applicant-readonly">{record.email}</span>
                  </div>
                  <div className="applicant-field">
                    <span className="applicant-label">Student ID</span>
                    <span className="applicant-readonly">{record.studentId}</span>
                  </div>
                </div>
              </section>
              )}

              {mode !== 'onboarding' && (
                <ApplicantTalentPoolSection
                  optedIn={record.talentPoolOptIn ?? null}
                  onChanged={(next) => setRecord((r) => ({ ...r, talentPoolOptIn: next }))}
                />
              )}

              {(mode === 'onboarding' ? onboardingSections() : SECTIONS).map((section) => (
                <section className="applicant-section" key={section.title}>
                  <h2 className="applicant-section-title">{section.title}</h2>
                  <div className="applicant-grid">{section.fields.map(renderField)}</div>
                </section>
              ))}

              {saveError && <p className="applicant-error">{saveError}</p>}
              {confirmation && <p className="applicant-success">{confirmation}</p>}

              <div className="applicant-actions">
                <button type="submit" className="applicant-save" disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  type="button"
                  className="applicant-cancel"
                  onClick={handleReset}
                  disabled={!dirty || saving}
                >
                  Discard changes
                </button>
              </div>
            </form>

            <div className="applicant-card">
              <section className="applicant-section">
                <h2 className="applicant-section-title">Resume</h2>
                {mode === 'onboarding' ? (
                  <OnboardingResumeSection
                    record={record}
                    onPreview={(src, title) => setPreview({ open: true, src, title })}
                    onReplaced={(updated) => setRecord(updated)}
                  />
                ) : (
                  <ResumeReuploadSection
                    applicationId={selectedId}
                    onPreview={(src, title) => setPreview({ open: true, src, title })}
                  />
                )}
              </section>
            </div>
          </>
        )}

        {preview.open && (
          <DocumentPreviewModal
            src={preview.src}
            kind="pdf"
            title={preview.title}
            onClose={() => setPreview({ open: false, src: '', title: '' })}
          />
        )}
      </div>
    </AccessControl>
  );
}
