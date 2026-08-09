# Page polling and sync

`client/src/hooks/usePolling.js` is the shared mechanism for keeping a page converged on
server state without hand-rolled intervals. The Staging page (`client/src/pages/Staging.jsx`)
is the first consumer.

## What it guarantees

| Concern | Behaviour |
| --- | --- |
| Bounded interval | One timer per hook instance, scheduled *after* the previous request settles, so slow responses cannot stack up. |
| Hidden pages | Polling stops on `visibilitychange` when the document is hidden and does one immediate fetch when it becomes visible again. |
| Inactive pages | `enabled: false` stops polling and aborts the in-flight request. Staging uses this while an editing dialog is open so a poll cannot overwrite pending input. |
| Single flight | Overlapping triggers are dropped while a request is in flight. |
| Cancellation | Every call receives an `AbortSignal`, aborted on unmount, on disable, on tab hide, and on manual refresh. |
| Backoff | Failures retry at `interval * 2^consecutiveFailures`, capped at `maxInterval` (5 min on Staging), and reset on the first success. |
| Visible state | `status` is one of `idle`, `loading`, `live`, `paused`, `error`, plus `error` and `lastSyncAt`. Staging renders this as a chip next to the cycle name. |
| Stale writes | A response is discarded if a newer one has already been applied — by arrival order, or by `getVersion(payload)` when the resource exposes a server `updatedAt`/version. |
| Request ownership | Ownership of the single-flight slot is per run: a superseded request (aborted by `refresh()`, hide, or disable) settling late can neither release the slot nor arm the timer on behalf of the replacement still in flight. |
| Instrumentation | `metrics` counts `requests`, `failures`, `discarded`, `consecutiveFailures` and records `lastLatencyMs`. Only counters and messages are surfaced; response payloads are never logged. |

## Usage

```js
const { status, error, lastSyncAt, metrics, refresh } = usePolling({
  fetcher: (signal) => apiClient.get('/admin/things', { signal }),
  interval: 60 * 1000,
  maxInterval: 5 * 60 * 1000,
  enabled: !dialogOpen,
  immediate: true,
  getVersion: (payload) => Date.parse(payload.updatedAt),
  onData: applyPayload,
  onError: (err) => console.error('things sync failed:', err.message)
});
```

`fetcher` must forward the signal to `apiClient` (`apiClient.get(url, { signal })`) or the
request cannot be cancelled. `onData` runs only for accepted (non-stale) responses.

## What Staging polls

One combined snapshot every 60s while the tab is visible and no dialog is open:
`/admin/staging/candidates`, `/admin/cycles/active`, `/admin/applications`, `/admin/events`,
`/admin/review-teams`, `/admin/existing-decisions`. The snapshot is written to the existing
in-memory `stagingCache`, which still serves the first paint after a remount so navigating
back does not refetch.

Cycle portability: nothing is keyed to a specific cycle. The endpoints resolve the active
`RecruitingCycle` server-side, so the same mechanism carries over to future cycles.

## Server snapshot version

`GET /admin/staging/candidates` returns `{ candidates, snapshotVersion }`. `snapshotVersion`
(`server/src/utils/snapshotVersion.js`) is the strictly increasing time at which the read
finished, so a larger version always means the payload was read from the database no earlier
than a smaller one. Staging passes it to `getVersion`, and the hook drops any snapshot whose
version is below the one already applied — the case arrival order alone cannot detect, since
request order says nothing about how old the data behind each response is.

The stamp covers the candidate read, and the other five resources are fetched in the same
poll, so it orders whole Staging snapshots against each other. Two caveats:

- ordering holds per server process; behind several instances it is only as consistent as
  the hosts' clocks. That is enough to drop stale reads, not a transactional DB version.
- the six resources are separate reads, so a snapshot can still interleave writes that
  landed between them. Making them atomic needs one endpoint reading in a transaction.

A read failure must stay a failure: `/admin/staging/candidates` returns 500 rather than an
empty 200, so a database error leaves the last good snapshot on screen and in `stagingCache`
and surfaces as the visible error/backoff path instead of an empty candidate table.

## When to prefer realtime over polling

Polling is right for dashboards that tolerate tens of seconds of lag and are read-mostly:
Staging, event attendance, review-team overviews.

Use Supabase realtime (see `useConversation.js`) instead when:

- users expect sub-second propagation, e.g. interview chat or live interview questions;
- several people edit the same record concurrently and a lost update is user-visible;
- the payload is large enough that repeated full-snapshot fetches are wasteful — realtime
  can push the delta.

Keep polling as the fallback path for those pages: realtime channels drop, and a bounded
poll is what makes recovery automatic.
