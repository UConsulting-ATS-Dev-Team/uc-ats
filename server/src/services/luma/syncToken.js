// The bearer token the hourly Luma sync routine authenticates with.
//
// It started life as LUMA_SYNC_TOKEN in the environment, which meant setting up
// the sync needed a Render dashboard and a redeploy. It is generated from Event
// Management instead now, and the environment variable is still honoured so an
// existing deployment does not stop syncing the moment this ships.
//
// **Stored in plain text, deliberately.** An admin has to be able to read it
// back: it goes into the routine's prompt, which is pasted into Claude by hand,
// so there is no flow in which a hash would do. That is a real trade - anyone
// with database access, or with admin in the ATS, can read it - and it is
// accepted because of what the token can actually do. It reaches three
// endpoints that relay guest lists for events an admin already linked; it is
// not a login, it grants nothing against Luma, and rotating it is one click.
import crypto from 'node:crypto';

import prisma from '../../prismaClient.js';

const SETTING_ID = 'singleton';

// A generated token is 32 random bytes in base64url, so 43 characters. The
// minimum is what the endpoints will accept at all, and exists to refuse a
// short value somebody typed in by hand as the placeholder it almost certainly
// is; it is checked against the environment variable too.
export const MIN_TOKEN_LENGTH = 32;
const TOKEN_BYTES = 32;

// Prisma's code for "the table is not there". This project applies migrations by
// hand (CLAUDE.md), so the code can reach a database that has not had this one
// run yet. A read falls back to the environment rather than throwing, so the
// sync a deployment already had keeps working until the migration lands.
const MISSING_TABLE = 'P2021';

export const generateSyncToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

async function readSetting() {
  try {
    return await prisma.lumaSyncSetting.findUnique({
      where: { id: SETTING_ID },
      select: { token: true, tokenSetAt: true, updatedAt: true, updatedById: true }
    });
  } catch (error) {
    if (error?.code === MISSING_TABLE) {
      console.error(
        '[luma] luma_sync_settings is missing — run the migration. '
        + 'Falling back to LUMA_SYNC_TOKEN in the environment.'
      );
      return null;
    }
    throw error;
  }
}

const usable = (value) => (typeof value === 'string' && value.length >= MIN_TOKEN_LENGTH ? value : null);

/**
 * Every token a request may present, newest first.
 *
 * Both the stored token and the environment one are accepted rather than one
 * winning. They are two ways of configuring the same thing, and a deployment
 * mid-migration legitimately has both: preferring either would silently break
 * whichever routine is using the other.
 */
export async function acceptedSyncTokens() {
  const [stored, fromEnv] = [usable((await readSetting())?.token), usable(process.env.LUMA_SYNC_TOKEN)];
  return [stored, fromEnv].filter(Boolean);
}

/** What the admin screen shows: the token itself, and where it came from. */
export async function getSyncTokenState() {
  const row = await readSetting();
  const stored = usable(row?.token);
  const fromEnv = usable(process.env.LUMA_SYNC_TOKEN);
  return {
    token: stored,
    tokenSetAt: stored ? (row?.tokenSetAt ?? null) : null,
    updatedById: stored ? (row?.updatedById ?? null) : null,
    // Reported so the panel can say that syncing works without a generated
    // token, and that generating one does not turn the old one off.
    envTokenSet: Boolean(fromEnv),
    configured: Boolean(stored || fromEnv)
  };
}

/**
 * Generate a new token, replacing any stored one.
 *
 * The previous stored token stops working the moment this returns, which is the
 * point of having it — but it also means a routine still holding it starts
 * failing with 401 until its prompt is updated. The panel says so; nothing here
 * can soften it, because a rotation that left the old token working would not
 * be a rotation.
 */
export async function rotateSyncToken(userId) {
  const token = generateSyncToken();
  await prisma.lumaSyncSetting.upsert({
    where: { id: SETTING_ID },
    update: { token, tokenSetAt: new Date(), updatedById: userId ?? null },
    create: { id: SETTING_ID, token, tokenSetAt: new Date(), updatedById: userId ?? null }
  });
  return getSyncTokenState();
}

/** Forget the stored token. Does not touch LUMA_SYNC_TOKEN in the environment. */
export async function clearSyncToken(userId) {
  await prisma.lumaSyncSetting.upsert({
    where: { id: SETTING_ID },
    update: { token: null, tokenSetAt: null, updatedById: userId ?? null },
    create: { id: SETTING_ID, token: null, tokenSetAt: null, updatedById: userId ?? null }
  });
  return getSyncTokenState();
}
