import prisma from '../../prismaClient.js';
import { createBuffer } from './buffer.js';

// The four raw analytics tables, each behind its own buffer.

export const serverErrors = createBuffer({
  name: 'server errors',
  write: (rows) => prisma.serverErrorLog.createMany({ data: rows }),
});

// Rows another buffer had to drop are themselves worth a server error row: a
// gap in the charts should explain itself on the Errors tab.
const reportDropped = (count, name) =>
  serverErrors.push({
    source: 'console',
    message: `Analytics dropped ${count} ${name} row(s): the database was unreachable or rows arrived faster than they could be written`,
    fingerprint: `analytics-dropped:${name}`,
    at: new Date(),
  });

export const requestSamples = createBuffer({
  name: 'request samples',
  write: (rows) => prisma.analyticsRequestSample.createMany({ data: rows }),
  onDropped: reportDropped,
});

export const clientEvents = createBuffer({
  name: 'client events',
  write: (rows) => prisma.analyticsClientEvent.createMany({ data: rows }),
  onDropped: reportDropped,
});

export const securityEvents = createBuffer({
  name: 'security events',
  write: (rows) => prisma.securityEvent.createMany({ data: rows }),
  onDropped: reportDropped,
});
