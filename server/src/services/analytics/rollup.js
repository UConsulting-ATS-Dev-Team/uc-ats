import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import prisma from '../../prismaClient.js';
import { computeDayAggregates, ts } from './aggregate.js';
import { ANALYTICS_TZ, RETENTION_DAYS, ROLLUP_CRON } from './constants.js';
import { recordServerError } from './errorCapture.js';
import { logError } from './log.js';

// The nightly job: fold finished days into the rollup tables, then delete raw
// rows past their retention. Idempotent - rolling a day up twice replaces it -
// so the manual button and the cron can both run without coordination beyond
// the in-process guard below.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRUNE_CHUNK = 5000;
// A runaway prune (say a year of rows after the job was off) stops here and
// finishes the next night rather than holding the database for minutes.
const PRUNE_MAX_ROUNDS = 200;

/** 'YYYY-MM-DD' of `date` in Los Angeles. */
export const laDay = (date = new Date()) => formatInTimeZone(date, ANALYTICS_TZ, 'yyyy-MM-dd');

/** The calendar day `offset` days from `day`. Pure calendar arithmetic, no time zone involved. */
export function shiftDay(day, offset) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

/** UTC instants bounding a Los Angeles day. 23 or 25 hours long on a DST change. */
export function dayBounds(day) {
  if (!DAY.test(day)) throw Object.assign(new Error(`Not a day: ${day}`), { status: 400 });
  return {
    from: fromZonedTime(`${day}T00:00:00`, ANALYTICS_TZ),
    to: fromZonedTime(`${shiftDay(day, 1)}T00:00:00`, ANALYTICS_TZ),
  };
}

/** A @db.Date column value for `day`. */
export const dayValue = (day) => new Date(`${day}T00:00:00.000Z`);

export async function rollupDay(day, client = prisma) {
  const { summaries, facts } = await computeDayAggregates(dayBounds(day), client);
  const date = dayValue(day);
  const computedAt = new Date();
  await client.$transaction([
    client.analyticsDailySummary.deleteMany({ where: { day: date } }),
    client.analyticsDailyFact.deleteMany({ where: { day: date } }),
    client.analyticsDailySummary.createMany({ data: summaries.map((s) => ({ ...s, day: date, computedAt })) }),
    client.analyticsDailyFact.createMany({ data: facts.map((f) => ({ ...f, day: date })) }),
  ]);
  return { day, summaries: summaries.length, facts: facts.length };
}

// Table names are constants, never input, so building the statement is safe.
const PRUNE_TABLES = [
  ['analytics_request_samples', RETENTION_DAYS.requestSamples],
  ['analytics_client_events', RETENTION_DAYS.clientEvents],
  ['server_error_logs', RETENTION_DAYS.serverErrors],
  ['security_events', RETENTION_DAYS.securityEvents],
];

export async function pruneRaw(now = new Date(), client = prisma) {
  const pruned = {};
  for (const [table, days] of PRUNE_TABLES) {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    let total = 0;
    for (let round = 0; round < PRUNE_MAX_ROUNDS; round += 1) {
      const deleted = await client.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE id IN (SELECT id FROM "${table}" WHERE at < $1::timestamp LIMIT ${PRUNE_CHUNK})`,
        ts(cutoff)
      );
      total += Number(deleted) || 0;
      if (deleted < PRUNE_CHUNK) break;
    }
    pruned[table] = total;
  }
  return pruned;
}

let running = false;

export const isRollupRunning = () => running;

/**
 * The days a run should roll up, newest first: yesterday and the day before
 * (a beacon sent at 23:59 and an error buffered over midnight both land late),
 * plus every day since the last one rolled up, so a server that was down for a
 * week fills the gap on its first night back. Capped at the request-sample
 * retention - older raw rows are gone, so there is nothing left to roll up.
 */
export function daysToRollUp(today, lastRolled) {
  const yesterday = shiftDay(today, -1);
  const floor = shiftDay(today, -RETENTION_DAYS.requestSamples);
  let from = shiftDay(yesterday, -1);
  if (lastRolled && lastRolled < from) from = shiftDay(lastRolled, 1);
  if (from < floor) from = floor;
  const days = [];
  for (let d = yesterday; d >= from; d = shiftDay(d, -1)) days.push(d);
  return days;
}

/** Returns null when a run is already in progress. */
export async function runRollup({ now = new Date(), client = prisma } = {}) {
  if (running) return null;
  running = true;
  const started = Date.now();
  try {
    const latest = await client.analyticsDailySummary.findFirst({ orderBy: { day: 'desc' }, select: { day: true } });
    const days = daysToRollUp(laDay(now), latest ? latest.day.toISOString().slice(0, 10) : null);
    const results = [];
    for (const day of days) results.push(await rollupDay(day, client));
    const pruned = await pruneRaw(now, client);
    return {
      days,
      summaries: results.reduce((sum, r) => sum + r.summaries, 0),
      facts: results.reduce((sum, r) => sum + r.facts, 0),
      pruned,
      ms: Date.now() - started,
    };
  } finally {
    running = false;
  }
}

/** Registered from index.js, inside the runCrons block like every other job. */
export function startAnalyticsJobs(cron) {
  cron.schedule(
    ROLLUP_CRON,
    async () => {
      try {
        const result = await runRollup();
        if (result) console.log(`[analytics] rolled up ${result.days.join(', ')} in ${result.ms}ms`);
      } catch (error) {
        logError('[analytics] nightly rollup failed:', error);
        // Recorded explicitly: logError deliberately bypasses capture.
        recordServerError({ source: 'cron', message: `Nightly analytics rollup failed: ${error?.message}`, stack: error?.stack });
      }
    },
    { timezone: ANALYTICS_TZ }
  );
}
