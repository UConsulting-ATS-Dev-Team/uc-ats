// A sealed recruiting record answers 423 with this code; list endpoints instead
// return the row cut down to identity and marked `locked: true`. See
// server/src/utils/lockedRecords.js.
export const RECORD_LOCKED_CODE = 'RECORD_LOCKED';

export const isRecordLockedError = (error) =>
  error?.status === 423 && error?.code === RECORD_LOCKED_CODE;
