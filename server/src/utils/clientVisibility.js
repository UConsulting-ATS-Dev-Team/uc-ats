// The single place that decides what a Talent Partner Network client is allowed
// to see about a resume. Pure - no prisma, no express - so the "never leaks a
// Drive id" property is provable in a unit test.
//
// Two rules that are load-bearing:
//
// 1. Fields above the client's visibility level are OMITTED, not set to null.
//    A null key still tells the client the field exists and invites their code
//    (and their next support request) to try to fill it.
//
// 2. resumeUrl / blindResumeUrl NEVER appear in the output, at any level. Those
//    are Google Drive file ids, and /api/files/* is not reachable by a CLIENT
//    anyway - a DTO carrying one would be a broken UI and a leak at the same
//    time. The client gets an assignment-scoped proxy URL instead, and the
//    assignment id is the security primitive: it is meaningless without a row
//    that ties it to this client.

export const VISIBILITY_LEVELS = ['BLIND', 'BASIC', 'FULL'];

export const pdfUrlForAssignment = (assignmentId) =>
  `/api/client/resumes/${assignmentId}/pdf`;

const showsIdentity = (visibility) => visibility === 'BASIC' || visibility === 'FULL';
const showsContact = (visibility) => visibility === 'FULL';

/**
 * `Application.resumeUrl` does not hold a bare Drive file id - it holds a URL
 * that *wraps* one, and in at least two shapes, because the value was written
 * by different generations of the sync:
 *
 *   /api/files/<id>/pdf                          (236 of 251 opted-in rows)
 *   https://uconsultingats.com/api/files/<id>/pdf (the rest)
 *
 * The Drive SDK takes the id alone, so handing it either of these produces a
 * 404 from Google and a 500 from us. Everything else in the app dodges this by
 * fetching the stored URL directly from the browser; the client portal cannot,
 * because the whole point is that the buyer never learns the Drive id.
 *
 * Returns null rather than a guess when the value is unrecognizable - the
 * caller turns that into "not available", which is the honest answer and keeps
 * an unparsed string from reaching the Drive API.
 */
/**
 * Pull the ResumeUpload id out of a locally-stored applicant resume URL.
 *
 * An applicant who replaces their resume gets `/api/resume-uploads/<id>/file`
 * written to Application.resumeUrl - the file lives in our own storage, not in
 * Drive, so extractDriveFileId() cannot resolve it and must not try.
 */
export const extractResumeUploadId = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/\/api\/resume-uploads\/([^/?#]+)\/file/);
  return match ? decodeURIComponent(match[1]) : null;
};

export const extractDriveFileId = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Our own proxy route, relative or absolute.
  const proxied = trimmed.match(/\/api\/files\/([^/?#]+)/);
  if (proxied) return decodeURIComponent(proxied[1]);

  // Drive's own share links, in case a value is ever pasted in by hand.
  const driveFile = trimmed.match(/\/file\/d\/([^/?#]+)/);
  if (driveFile) return driveFile[1];
  const driveQuery = trimmed.match(/[?&]id=([^&#]+)/);
  if (driveQuery) return decodeURIComponent(driveQuery[1]);

  // Already a bare id.
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;

  return null;
};

/**
 * Whether a resume can actually be rendered for this visibility level. Drives
 * the `available` flag so the UI can say "not available" instead of handing the
 * viewer a PDF pane that 404s.
 */
// The storage path behind a locally-stored applicant resume, or null when the
// URL is not one of ours / the row was not included / the row has no file.
const localApplicantStoragePath = (application, stored) => {
  const uploadId = extractResumeUploadId(stored);
  if (!uploadId) return null;
  const upload = (application?.resumeUploads || []).find((u) => u.id === uploadId);
  return upload?.storagePath || null;
};

export const isViewable = (assignment, visibility) => {
  if (assignment?.application) {
    // Deliberately the same predicate the stream handler uses: a row whose
    // stored URL we cannot parse into a file id is not viewable, and saying so
    // in the list beats a card that opens onto a 404.
    const stored =
      visibility === 'BLIND'
        ? assignment.application.blindResumeUrl
        : assignment.application.resumeUrl;
    if (localApplicantStoragePath(assignment.application, stored)) return true;
    return Boolean(extractDriveFileId(stored));
  }
  if (assignment?.memberResume) {
    // No redacted variant of a member-uploaded PDF exists.
    return visibility !== 'BLIND';
  }
  return false;
};

/**
 * Resolve which stored file this assignment should stream for a given
 * visibility. Server-side only - the return value must never be serialized into
 * a response.
 *
 * @returns {{ kind: 'drive', fileId: string } | { kind: 'local', storagePath: string } | null}
 */
export const resolveResumeSource = (assignment, visibility) => {
  if (assignment?.application) {
    const app = assignment.application;
    const stored = visibility === 'BLIND' ? app.blindResumeUrl : app.resumeUrl;

    // A replaced resume lives in our storage. Checked first: its URL is not a
    // Drive reference and never resolves to a file id.
    //
    // Note this can only ever match the FULL/BASIC branch. Replacing a resume
    // nulls blindResumeUrl (there is no redacted variant of the new file), so a
    // BLIND client still correctly gets nothing.
    const storagePath = localApplicantStoragePath(app, stored);
    if (storagePath) return { kind: 'local', storagePath };

    const fileId = extractDriveFileId(stored);
    if (!fileId) return null;
    return { kind: 'drive', fileId };
  }
  if (assignment?.memberResume) {
    if (visibility === 'BLIND') return null;
    if (!assignment.memberResume.storagePath) return null;
    return { kind: 'local', storagePath: assignment.memberResume.storagePath };
  }
  return null;
};

/**
 * Project one assignment row (with `application` or `memberResume` included)
 * into the DTO a client receives.
 */
export const projectAssignment = (assignment, visibility) => {
  const isApplicant = Boolean(assignment.application);
  const source = isApplicant ? assignment.application : assignment.memberResume;

  const dto = {
    assignmentId: assignment.id,
    kind: isApplicant ? 'APPLICANT' : 'MEMBER',
    assignedAt: assignment.assignedAt,
    pdfUrl: pdfUrlForAssignment(assignment.id),
    available: isViewable(assignment, visibility),
    graduationYear: source?.graduationYear ?? null,
    major1: source?.major1 ?? null,
    major2: source?.major2 ?? null
  };

  if (showsIdentity(visibility)) {
    dto.gender = source?.gender ?? null;
    if (isApplicant) {
      dto.firstName = source?.firstName ?? null;
      dto.lastName = source?.lastName ?? null;
    } else {
      // Member name lives on the related User, not on the resume row.
      const member = assignment.memberResume?.member;
      dto.firstName = member?.fullName ? member.fullName.split(' ')[0] : null;
      dto.lastName = member?.fullName
        ? member.fullName.split(' ').slice(1).join(' ') || null
        : null;
    }
  }

  if (showsContact(visibility)) {
    if (isApplicant) {
      dto.email = source?.email ?? null;
      dto.phoneNumber = source?.phoneNumber ?? null;
      // Decimal comes back as a Prisma Decimal; string keeps the precision the
      // column was chosen for.
      dto.cumulativeGpa = source?.cumulativeGpa != null ? String(source.cumulativeGpa) : null;
      dto.majorGpa = source?.majorGpa != null ? String(source.majorGpa) : null;
    } else {
      // Members supply no contact details or GPA with an uploaded resume. The
      // keys stay present so the client renders one component for both kinds.
      dto.email = assignment.memberResume?.member?.email ?? null;
      dto.phoneNumber = null;
      dto.cumulativeGpa = null;
      dto.majorGpa = null;
    }
  }

  return dto;
};

/**
 * Which fields a free-text search may look at for a given visibility.
 *
 * Under BLIND this must exclude names. If a blind client could search by name
 * and read the result count, they would have a yes/no oracle for "is this
 * person in my set" - which is deanonymization by another route, and it would
 * make the whole blind mode theatre.
 */
export const searchableFields = (visibility) => {
  const base = ['graduationYear', 'major1', 'major2'];
  if (showsIdentity(visibility)) {
    return [...base, 'firstName', 'lastName'];
  }
  return base;
};
