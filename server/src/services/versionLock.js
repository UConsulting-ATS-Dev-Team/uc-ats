// Serializing changes to one live session row (a live vote, a review team
// deliberation).
//
// The first statement of the transaction bumps the row's `version`. That is what
// takes the row lock, so every other change to the same session waits until this
// one commits, and it rolls back with everything else if `fn` throws. Clients
// poll and compare the version, so the bump is also how they learn something
// changed.

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

const notFound = (message) => Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' });

/**
 * Runs `fn(tx, row)` holding the row lock on `delegate` (a Prisma model name
 * such as 'liveVoteSession') and returns `{ result, version }`.
 *
 * `bump: false` takes the same lock without moving the version, for a change
 * that must be serialized with the others but that clients need not refetch
 * for at once (a vote: the tally is re-read within the state cache's TTL).
 */
export async function withVersionLock(client, delegate, id, fn, { notFoundMessage = 'Not found', bump = true } = {}) {
  return client.$transaction(async (tx) => {
    let row;
    try {
      row = await tx[delegate].update({
        where: { id },
        data: { version: { increment: bump ? 1 : 0 } }
      });
    } catch (error) {
      if (error?.code === 'P2025') throw notFound(notFoundMessage);
      throw error;
    }
    const result = await fn(tx, row);
    return { result, version: row.version };
  }, TX_OPTIONS);
}
