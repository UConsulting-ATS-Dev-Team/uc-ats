// Monotonic version stamp for read-only snapshot responses.
//
// The version is the time the snapshot finished being read, so a larger version
// always means the payload was read from the database no earlier than a smaller
// one: a client can therefore drop a snapshot that is older than the one it has
// already applied. Values are forced strictly increasing so two snapshots read
// inside the same millisecond stay ordered.
//
// Scope: ordering holds per server process. Behind several instances the stamps
// are only as consistent as the hosts' clocks, which is sufficient for dropping
// stale reads but is not a transactional database version.
let lastIssued = 0;

export function nextSnapshotVersion(now = Date.now()) {
  lastIssued = now > lastIssued ? now : lastIssued + 1;
  return lastIssued;
}

export default nextSnapshotVersion;
