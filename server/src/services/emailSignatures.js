import prisma from '../prismaClient.js';
import { assertSafeMarkdown } from './emailTemplateCopy.js';
import { currentEmailDraft } from './emailDrafts.js';

/**
 * Named sign-offs an admin can put on any automatic email.
 *
 * Which one an email uses is part of its style (EmailTemplateStyle.signatureId):
 *   - null:  the default signature, or the email's own sign-off if none is default
 *   - 'OWN': always the email's own sign-off
 *   - an id: that signature (the default if it has since been deleted)
 *
 * A signature replaces an email's sign-off; it is never added beside one. An
 * email without a separate sign-off - the decision letters, whose closing is
 * part of the letter an admin writes - is not affected by any of this.
 *
 * Nothing exists until an admin creates one, so on day one every email still
 * ends the way it always has, including any sign-off an admin already edited.
 */

export const OWN_SIGN_OFF = 'OWN';

const LIMITS = { name: 60, body: 1000, imageUrl: 500 };

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/** Validates a signature an admin submitted. Throws 400 with a readable message. */
export function normalizeSignature(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail(400, 'Signature must be an object', 'INVALID_SIGNATURE');
  }
  const name = trimmed(input.name);
  const body = trimmed(input.body);
  const imageUrl = trimmed(input.imageUrl);

  if (!name) throw fail(400, 'Give the signature a name', 'INVALID_SIGNATURE');
  if (!body) throw fail(400, 'The signature is empty', 'INVALID_SIGNATURE');
  for (const [field, value] of Object.entries({ name, body, imageUrl })) {
    if (value.length > LIMITS[field]) throw fail(400, `The ${field} is over ${LIMITS[field]} characters`, 'INVALID_SIGNATURE');
  }
  if (/[<>]/.test(name)) throw fail(400, 'The name cannot contain < or >', 'INVALID_SIGNATURE');
  assertSafeMarkdown('The signature', body);

  if (imageUrl) {
    let url;
    try {
      url = new URL(imageUrl);
    } catch {
      throw fail(400, 'The image must be a full https:// address', 'INVALID_SIGNATURE');
    }
    if (url.protocol !== 'https:') throw fail(400, 'The image must be a full https:// address', 'INVALID_SIGNATURE');
  }

  return { name, body, imageUrl: imageUrl || null, isDefault: input.isDefault === true };
}

const shape = (row) => ({
  id: row.id,
  name: row.name,
  body: row.body,
  imageUrl: row.imageUrl ?? null,
  isDefault: row.isDefault,
  updatedAt: row.updatedAt ?? null,
});

// Read on the send path, where the table may not exist yet. A failed read
// means "no signatures", which is every email's own sign-off.
let warnedAboutStore = false;

async function readAll(client) {
  try {
    return await client.emailSignature.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  } catch (error) {
    if (!warnedAboutStore) {
      warnedAboutStore = true;
      console.error('[emailSignatures] falling back to each email\'s own sign-off:', error?.message ?? error);
    }
    return [];
  }
}

export async function listEmailSignatures({ client = prisma } = {}) {
  return (await readAll(client)).map(shape);
}

/**
 * The signature an email should end with, or null for its own sign-off.
 * A preview with an unsaved signature (the Signatures editor) uses that.
 */
export async function resolveSignature(signatureId, { client = prisma } = {}) {
  const draft = currentEmailDraft()?.signature;
  if (draft) return draft;
  if (signatureId === OWN_SIGN_OFF) return null;

  const all = await readAll(client);
  const chosen = signatureId ? all.find((row) => row.id === signatureId) : null;
  const picked = chosen ?? all.find((row) => row.isDefault) ?? null;
  return picked ? { body: picked.body, imageUrl: picked.imageUrl ?? null } : null;
}

/** Whether a stored signatureId still points at something. For validation. */
export async function signatureExists(id, { client = prisma } = {}) {
  if (!id || id === OWN_SIGN_OFF) return true;
  return Boolean(await client.emailSignature.findUnique({ where: { id }, select: { id: true } }));
}

// Setting a default clears the old one in the same transaction, so there is
// never a moment with two. The partial unique index backs this up against a
// concurrent save.
async function writeSignature(client, { id, data, user }) {
  try {
    return await client.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.emailSignature.updateMany({
          where: { isDefault: true, ...(id ? { NOT: { id } } : {}) },
          data: { isDefault: false },
        });
      }
      const fields = { ...data, updatedById: user?.id ?? null };
      return id
        ? tx.emailSignature.update({ where: { id }, data: fields })
        : tx.emailSignature.create({ data: fields });
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      throw fail(409, 'Another signature already has that name, or another was made default at the same moment', 'SIGNATURE_CONFLICT');
    }
    if (error?.code === 'P2025') throw fail(404, 'That signature no longer exists', 'UNKNOWN_SIGNATURE');
    throw error;
  }
}

export async function createEmailSignature({ client = prisma, signature, user }) {
  return shape(await writeSignature(client, { data: normalizeSignature(signature), user }));
}

export async function updateEmailSignature({ client = prisma, id, signature, user }) {
  return shape(await writeSignature(client, { id, data: normalizeSignature(signature), user }));
}

/**
 * Deleting a signature an email uses sends that email to the default (or its
 * own sign-off). Stored style rows keep the dead id; resolveSignature treats it
 * as unset, so there is nothing to clean up and nothing that can fail midway.
 */
export async function deleteEmailSignature({ client = prisma, id }) {
  const { count } = await client.emailSignature.deleteMany({ where: { id } });
  if (count === 0) throw fail(404, 'That signature no longer exists', 'UNKNOWN_SIGNATURE');
  return { deleted: id };
}
