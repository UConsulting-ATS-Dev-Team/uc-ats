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
export const isViewable = (assignment, visibility) => {
  if (assignment?.application) {
    // Deliberately the same predicate the stream handler uses: a row whose
    // stored URL we cannot parse into a file id is not viewable, and saying so
    // in the list beats a card that opens onto a 404.
    const stored =
      visibility === 'BLIND'
        ? assignment.application.blindResumeUrl
        : assignment.application.resumeUrl;
    return Boolean(extractDriveFileId(stored));
  }
  // No redacted variant of an uploaded PDF exists, for a member or a student.
  if (assignment?.memberResume || assignment?.externalResume) {
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
    const fileId = extractDriveFileId(stored);
    if (!fileId) return null;
    return { kind: 'drive', fileId };
  }
  const uploaded = assignment?.memberResume || assignment?.externalResume;
  if (uploaded) {
    if (visibility === 'BLIND') return null;
    if (!uploaded.storagePath) return null;
    return { kind: 'local', storagePath: uploaded.storagePath };
  }
  return null;
};

/**
 * Project one assignment row (with `application`, `memberResume` or
 * `externalResume` included) into the DTO a client receives.
 *
 * The two uploaded-resume pools - members and self-registered students - are
 * projected identically. They differ only in `kind`, which the client uses as a
 * label, and in nothing the visibility rules act on: both are one PDF with no
 * redacted variant, both carry their owner's name on the related User rather
 * than on the resume row, and neither supplies a GPA or a phone number.
 */
export const projectAssignment = (assignment, visibility) => {
  const isApplicant = Boolean(assignment.application);
  const isExternal = !isApplicant && Boolean(assignment.externalResume);
  const source = isApplicant
    ? assignment.application
    : assignment.memberResume || assignment.externalResume;

  // For an uploaded resume the person's name and email live on the related
  // User, not on the resume row.
  const owner = isApplicant
    ? null
    : assignment.memberResume?.member || assignment.externalResume?.user || null;

  const dto = {
    assignmentId: assignment.id,
    kind: isApplicant ? 'APPLICANT' : isExternal ? 'EXTERNAL' : 'MEMBER',
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
      dto.firstName = owner?.fullName ? owner.fullName.split(' ')[0] : null;
      dto.lastName = owner?.fullName
        ? owner.fullName.split(' ').slice(1).join(' ') || null
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
      // Neither members nor students supply contact details or a GPA with an
      // uploaded resume. The keys stay present so the client renders one
      // component for all three kinds.
      dto.email = owner?.email ?? null;
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
