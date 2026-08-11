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
| Stale writes | A response is discarded if a newer one has already been applied — by arrival order, or by `getVersion(payload)` when the resource exposes a server `updatedAt`/version. `initialVersion` seeds that comparison with the version of data the caller has already painted (a cached snapshot), so a fresh hook instance cannot accept a read older than what is on screen. |
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
  initialVersion: cachedVersion, // version of the already-rendered snapshot, if any
  onData: applyPayload,
  onError: (err) => console.error('things sync failed:', err.message)
});
```

`fetcher` must forward the signal to `apiClient` (`apiClient.get(url, { signal })`) or the
request cannot be cancelled. `onData` runs only for accepted (non-stale) responses.

## What Staging polls

One request every 60s while the tab is visible and no dialog is open:
`GET /admin/staging/snapshot`. It returns every resource the page renders — candidates,
active cycle, applications, events, review teams, per-round decisions — read together, so
the page never assembles a screen out of six independently-timed responses. The payload is
written to the in-memory `stagingCache` (`client/src/utils/stagingCache.js`), which still
serves the first paint after a remount so navigating back does not refetch.

Cycle portability: nothing is keyed to a specific cycle. The endpoint resolves the active
`RecruitingCycle` server-side, so the same mechanism carries over to future cycles.

## Snapshot version

`GET /admin/staging/snapshot` (`server/src/services/stagingSnapshot.js`) reads all six
resources inside one `prisma.$transaction` at `RepeatableRead`, and its `snapshotVersion` is
the database's own `clock_timestamp()` read as the first statement of that transaction
(`server/src/utils/snapshotVersion.js`).

Both halves are what make the version mean something:

- repeatable read fixes the transaction's database snapshot at its first statement, so the
  version describes *all six* resources as of one committed state, not a stamp on the
  candidate read with five unrelated reads alongside it;
- the clock is the database's, so `a.snapshotVersion < b.snapshotVersion` means b's state
  includes every commit a could see — regardless of which API instance served either read.
  A process-local counter or an app-server clock cannot promise that across instances or
  restarts.

Staging passes it to `getVersion` and, on a remount that painted from `stagingCache`, as
`initialVersion`. The hook drops any snapshot whose version is below the one already
applied — the case arrival order cannot detect, since request order says nothing about how
old the data behind each response is.

Cost: six reads serialized on one connection is slower than six parallel requests. The
transaction is given a 30s timeout, on the view that an admin console tolerates a slow
refresh better than an incoherent one.

A read failure must stay a failure: the endpoint returns 500 rather than an empty 200 (and
so does `/admin/staging/candidates`), so a database error leaves the last good snapshot on
screen and in `stagingCache` and surfaces as the visible error/backoff path instead of an
empty candidate table.

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
