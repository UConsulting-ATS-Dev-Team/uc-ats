// Whether the Google Form event sync sends confirmation emails of its own.
//
// It used to, unconditionally. Sign-ups now happen on Luma, which sends its own
// confirmation and calendar invite the moment somebody registers, so an ATS
// email on top of that is a second message about the same sign-up arriving up
// to five minutes later. The sending code is kept and switched off rather than
// deleted, because the Google Forms path is still there (plan Phase 4 retires
// it) and a move back should be one toggle, not a revert.
//
// **Off by default**, including when the row has never been written: the
// default has to be the safe direction, and an unexpected duplicate email to
// every person who signs up is worse than an expected missing one. That means
// the column default, the fallback here and the migration all say false; keep
// the three in step.
import prisma from '../prismaClient.js';

const SETTING_ID = 'singleton';

export const DEFAULT_SEND_SIGNUP_CONFIRMATIONS = false;

// Prisma's code for "the table is not there". This project applies migrations by
// hand (see CLAUDE.md), so the code can reach a database that has not had this
// one run yet. Reads fall back to the default rather than taking the whole event
// sync down; writes still fail, loudly, because a setting that cannot be saved
// must not look saved.
const MISSING_TABLE = 'P2021';

async function readSetting() {
  try {
    return await prisma.eventEmailSetting.findUnique({
      where: { id: SETTING_ID },
      select: { sendSignupConfirmations: true, updatedAt: true, updatedById: true }
    });
  } catch (error) {
    if (error?.code === MISSING_TABLE) {
      console.error(
        '[eventEmailSettings] event_email_settings is missing — run the migration. '
        + 'Treating signup confirmations as off until it exists.'
      );
      return null;
    }
    throw error;
  }
}

/** The one question the sync asks. */
export async function sendSignupConfirmations() {
  const row = await readSetting();
  return row?.sendSignupConfirmations ?? DEFAULT_SEND_SIGNUP_CONFIRMATIONS;
}

export async function getEventEmailSetting() {
  const row = await readSetting();
  return {
    sendSignupConfirmations: row?.sendSignupConfirmations ?? DEFAULT_SEND_SIGNUP_CONFIRMATIONS,
    updatedAt: row?.updatedAt ?? null,
    updatedById: row?.updatedById ?? null
  };
}

/** Throws on a value the admin UI should have rejected; the route makes it a 400. */
export async function setSendSignupConfirmations(enabled, userId) {
  if (typeof enabled !== 'boolean') {
    const error = new Error('sendSignupConfirmations must be true or false');
    error.code = 'INVALID_EVENT_EMAIL_SETTING';
    throw error;
  }
  return prisma.eventEmailSetting.upsert({
    where: { id: SETTING_ID },
    update: { sendSignupConfirmations: enabled, updatedById: userId ?? null },
    create: { id: SETTING_ID, sendSignupConfirmations: enabled, updatedById: userId ?? null },
    select: { sendSignupConfirmations: true, updatedAt: true, updatedById: true }
  });
}
