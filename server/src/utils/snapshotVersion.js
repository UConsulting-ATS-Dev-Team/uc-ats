/**
 * Version of a read, taken from the database rather than from this process.
 *
 * `clock_timestamp()` is evaluated by PostgreSQL when the statement runs, so every
 * API instance stamps its reads from one clock: versions stay comparable across
 * instances and across restarts, which a process-local counter cannot promise.
 * Call it as the first statement of a repeatable-read transaction and the value also
 * dates the database snapshot the rest of that transaction sees.
 *
 * @param {{ $queryRaw: Function }} client Prisma client or transaction client
 * @returns {Promise<number|null>} milliseconds since the epoch, from the database
 */
export async function readSnapshotVersion(client) {
  const rows = await client.$queryRaw`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS version`;
  const version = rows?.[0]?.version;
  return version == null ? null : Number(version);
}

export default readSnapshotVersion;
