/**
 * Change token for the Staging console.
 *
 * The snapshot read this token guards is expensive (six serialized loaders, ~840KB),
 * so clients poll this instead and fetch the snapshot only when the value moves.
 *
 * The token is bumped by AFTER-STATEMENT triggers on every table the snapshot reads,
 * not by the routes that write them: see the `add_staging_change_token` migration.
 * That matters for correctness rather than convenience — a token that can miss a write
 * would leave the console silently stale forever, which is a worse failure than the
 * polling lag it replaces. Triggers cover the API, the Google Forms sync, and scripts.
 *
 * Note this is a *change* token, not an ordering one: compare it for equality only.
 * `snapshotVersion` (clock_timestamp) is what orders two snapshots against each other,
 * and it cannot do this job because it changes on every read by design.
 *
 * @param {{ $queryRaw: Function }} client Prisma client or transaction client
 * @returns {Promise<string|null>} opaque token, or null if the row is missing
 */
export async function readStagingChangeToken(client) {
  const rows = await client.$queryRaw`
    SELECT "version"::text AS version FROM "staging_change_tokens" WHERE "id" = 'staging'`;
  const version = rows?.[0]?.version;
  // Kept as a string: the column is BIGINT and only ever compared for equality, so
  // there is nothing to gain from a lossy trip through Number.
  return version == null ? null : String(version);
}

export default readStagingChangeToken;
