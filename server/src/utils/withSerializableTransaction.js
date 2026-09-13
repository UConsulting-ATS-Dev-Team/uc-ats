// Serializable transactions with bounded retry.
//
// Capacity is the kind of invariant application code cannot hold on its own: two
// requests for the last seat both read "one seat left" and both insert. Under
// Serializable isolation each insert falls inside the other transaction's
// predicate read, Postgres detects the read-write dependency cycle and aborts one
// with 40001, and Prisma surfaces that as P2034. The retry then re-reads a full
// slot and refuses honestly.
//
// That only works if the whole decision - the read AND the write - happens inside
// the callback. Anything read before the transaction is a stale value the database
// never got the chance to serialise against.
//
// Do not send email or make HTTP calls in here. The callback runs again on a
// serialisation failure, and a retried transaction that sent an email sends it
// twice. Return a plan; act on it after the commit.

import { Prisma } from '@prisma/client';

// P2034: serialisation failure (the expected, healthy outcome of a lost race).
// P2024: could not get a connection from the pool inside maxWait - transient
// under load rather than a real failure, so it is worth one more try.
const RETRYABLE_CODES = new Set(['P2034', 'P2024']);

export class SlotTransactionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'SlotTransactionError';
  }
}

/**
 * Run `fn` in a Serializable transaction, retrying serialisation failures.
 *
 * `maxWait` and `timeout` are passed explicitly rather than inherited from the
 * client's defaults (prismaClient.js sets maxWait: 2000, timeout: 5000, tuned for
 * short pooler queries). Interactive transactions here are longer than that, and
 * a decision email landing in 300 inboxes at once means far more than
 * connection_limit=20 concurrent claims - callers queue, hit maxWait, and raise
 * P2024. Retrying that is right; retrying it on a fixed schedule is not, because
 * every loser backs off by exactly the same amount and collides again. Hence the
 * jitter.
 */
export async function withSerializableTransaction(prisma, fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const timeout = options.timeout ?? 10000;
  const maxWait = options.maxWait ?? 5000;
  // Serialisable by default, because most callers rely on SSI to catch a
  // conflicting write. A caller that takes its own row lock should pass
  // ReadCommitted instead: under Serialisable, a transaction that queues on a
  // lock and then finds the row committed beneath it aborts anyway, so the lock
  // buys contention without buying success. Measured - see
  // scripts/loadtest-slot-signup.js.
  const isolationLevel = options.isolationLevel ?? 'Serializable';

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel, timeout, maxWait });
    } catch (error) {
      lastError = error;
      const code =
        error?.code ||
        (error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null);
      if (!RETRYABLE_CODES.has(code) || attempt === maxRetries) {
        throw error;
      }
      // Full jitter: a random point in [0, 2^attempt * base) rather than the
      // exact backoff, so simultaneous losers spread out instead of retrying in
      // lockstep and re-colliding.
      const ceiling = baseDelayMs * 2 ** attempt;
      const delay = Math.random() * ceiling;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
