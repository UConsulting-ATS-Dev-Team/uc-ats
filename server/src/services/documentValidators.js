// Validators (RFC 9110 §8.8) for a document streamed from Drive.
//
// A response is cached for an hour (routes/files.js). After that the browser
// still holds the bytes and, given a validator, asks "has it changed?" instead of
// asking for them again; the answer is a 304 with no body. That matters most for
// a resume or cover letter, whose URL carries no signed link and so stays the
// same across opens for good. A validator also lets the browser check that the
// ranges of a video it pieces together all came from the same version.
//
// Drive gives each file an md5Checksum and a modifiedTime, so the validator costs
// nothing beyond the metadata read the route already makes.

/** `{ etag, lastModified }` for Drive metadata; either may be null. */
export function documentValidators(meta) {
  const etag = typeof meta?.md5Checksum === 'string' && /^[0-9a-f]+$/i.test(meta.md5Checksum)
    ? `"${meta.md5Checksum}"`
    : null;
  const modified = meta?.modifiedTime ? new Date(meta.modifiedTime) : null;
  const lastModified = modified && !Number.isNaN(modified.getTime()) ? modified.toUTCString() : null;
  return { etag, lastModified };
}

/**
 * Does the request's `If-None-Match` name this ETag? Weak comparison, as the RFC
 * requires for If-None-Match, and `*` matches any representation.
 */
export function etagMatches(ifNoneMatch, etag) {
  if (!etag || typeof ifNoneMatch !== 'string') return false;
  const bare = (tag) => tag.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
}
