import { describe, it, expect } from 'vitest';
import {
  projectAssignment,
  resolveResumeSource,
  isViewable,
  searchableFields,
  pdfUrlForAssignment,
  VISIBILITY_LEVELS
} from './clientVisibility.js';

const DRIVE_REAL = 'drive-file-id-real-resume';
const DRIVE_BLIND = 'drive-file-id-blind-resume';

const applicantAssignment = (overrides = {}) => ({
  id: 'assign-1',
  assignedAt: new Date('2026-08-01T00:00:00.000Z'),
  application: {
    id: 'app-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@ucla.edu',
    phoneNumber: '+1-310-555-0100',
    studentId: '123456789',
    graduationYear: '2030',
    major1: 'Business Economics',
    major2: null,
    gender: 'Female',
    cumulativeGpa: '3.85',
    majorGpa: '3.92',
    resumeUrl: DRIVE_REAL,
    blindResumeUrl: DRIVE_BLIND,
    ...overrides
  },
  memberResume: null
});

const memberAssignment = (overrides = {}) => ({
  id: 'assign-2',
  assignedAt: new Date('2026-08-02T00:00:00.000Z'),
  application: null,
  memberResume: {
    id: 'mr-1',
    storagePath: 'member-resumes/mr-1/resume.pdf',
    graduationYear: '2027',
    major1: 'Statistics',
    major2: 'Economics',
    gender: 'Other',
    member: { fullName: 'Alex Rivera Cruz', email: 'alex@uconsulting.org' },
    ...overrides
  }
});

describe('projectAssignment - never leaks a file id', () => {
  it('omits resumeUrl, blindResumeUrl and studentId at every visibility level', () => {
    for (const visibility of VISIBILITY_LEVELS) {
      const dto = projectAssignment(applicantAssignment(), visibility);
      const serialized = JSON.stringify(dto);

      expect(serialized).not.toContain(DRIVE_REAL);
      expect(serialized).not.toContain(DRIVE_BLIND);
      expect(serialized).not.toContain('/api/files/');
      expect(dto).not.toHaveProperty('resumeUrl');
      expect(dto).not.toHaveProperty('blindResumeUrl');
      expect(dto).not.toHaveProperty('studentId');
    }
  });

  it('never leaks a member storage path either', () => {
    for (const visibility of ['BASIC', 'FULL']) {
      const dto = projectAssignment(memberAssignment(), visibility);
      expect(JSON.stringify(dto)).not.toContain('member-resumes/');
      expect(dto).not.toHaveProperty('storagePath');
    }
  });

  it('hands out an assignment-scoped proxy URL instead', () => {
    const dto = projectAssignment(applicantAssignment(), 'FULL');
    expect(dto.pdfUrl).toBe('/api/client/resumes/assign-1/pdf');
    expect(pdfUrlForAssignment('x')).toBe('/api/client/resumes/x/pdf');
  });
});

describe('projectAssignment - BLIND', () => {
  it('omits identity keys entirely rather than nulling them', () => {
    const dto = projectAssignment(applicantAssignment(), 'BLIND');

    for (const key of ['firstName', 'lastName', 'gender', 'email', 'phoneNumber', 'cumulativeGpa', 'majorGpa']) {
      expect(dto).not.toHaveProperty(key);
    }
  });

  it('still exposes the non-identifying fields the client filtered on', () => {
    const dto = projectAssignment(applicantAssignment(), 'BLIND');
    expect(dto.graduationYear).toBe('2030');
    expect(dto.major1).toBe('Business Economics');
    expect(dto.available).toBe(true);
  });

  it('marks an applicant with no blind resume unavailable', () => {
    const dto = projectAssignment(applicantAssignment({ blindResumeUrl: null }), 'BLIND');
    expect(dto.available).toBe(false);
  });

  it('marks every member resume unavailable', () => {
    const dto = projectAssignment(memberAssignment(), 'BLIND');
    expect(dto.available).toBe(false);
  });
});

describe('projectAssignment - BASIC and FULL', () => {
  it('BASIC adds name and gender but withholds contact details and GPA', () => {
    const dto = projectAssignment(applicantAssignment(), 'BASIC');
    expect(dto.firstName).toBe('Jane');
    expect(dto.lastName).toBe('Doe');
    expect(dto.gender).toBe('Female');
    expect(dto).not.toHaveProperty('email');
    expect(dto).not.toHaveProperty('phoneNumber');
    expect(dto).not.toHaveProperty('cumulativeGpa');
  });

  it('FULL adds contact details and GPA as strings', () => {
    const dto = projectAssignment(applicantAssignment(), 'FULL');
    expect(dto.email).toBe('jane@ucla.edu');
    expect(dto.phoneNumber).toBe('+1-310-555-0100');
    expect(dto.cumulativeGpa).toBe('3.85');
    expect(typeof dto.cumulativeGpa).toBe('string');
  });

  it('gives a member row the same key set as an applicant row so one component renders both', () => {
    const applicant = projectAssignment(applicantAssignment(), 'FULL');
    const member = projectAssignment(memberAssignment(), 'FULL');
    expect(Object.keys(member).sort()).toEqual(Object.keys(applicant).sort());
  });

  it('splits a member full name and nulls the fields members do not supply', () => {
    const dto = projectAssignment(memberAssignment(), 'FULL');
    expect(dto.firstName).toBe('Alex');
    expect(dto.lastName).toBe('Rivera Cruz');
    expect(dto.phoneNumber).toBeNull();
    expect(dto.cumulativeGpa).toBeNull();
  });
});

describe('resolveResumeSource', () => {
  it('serves the blind file to a BLIND client and the real one otherwise', () => {
    expect(resolveResumeSource(applicantAssignment(), 'BLIND')).toEqual({
      kind: 'drive',
      fileId: DRIVE_BLIND
    });
    for (const visibility of ['BASIC', 'FULL']) {
      expect(resolveResumeSource(applicantAssignment(), visibility)).toEqual({
        kind: 'drive',
        fileId: DRIVE_REAL
      });
    }
  });

  it('refuses rather than falling back to the real file when no blind version exists', () => {
    expect(resolveResumeSource(applicantAssignment({ blindResumeUrl: null }), 'BLIND')).toBeNull();
    expect(resolveResumeSource(applicantAssignment({ blindResumeUrl: '' }), 'BLIND')).toBeNull();
  });

  it('refuses a member resume for a BLIND client', () => {
    expect(resolveResumeSource(memberAssignment(), 'BLIND')).toBeNull();
  });

  it('returns the local path for a member resume at BASIC and FULL', () => {
    expect(resolveResumeSource(memberAssignment(), 'BASIC')).toEqual({
      kind: 'local',
      storagePath: 'member-resumes/mr-1/resume.pdf'
    });
  });

  it('returns null for an assignment with neither target', () => {
    expect(resolveResumeSource({ id: 'x' }, 'FULL')).toBeNull();
    expect(isViewable({ id: 'x' }, 'FULL')).toBe(false);
  });
});

describe('searchableFields', () => {
  it('excludes names under BLIND so result counts cannot become a name oracle', () => {
    const fields = searchableFields('BLIND');
    expect(fields).not.toContain('firstName');
    expect(fields).not.toContain('lastName');
    expect(fields).toContain('major1');
  });

  it('includes names once identity is already visible', () => {
    for (const visibility of ['BASIC', 'FULL']) {
      expect(searchableFields(visibility)).toContain('firstName');
    }
  });
});
