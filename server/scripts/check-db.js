#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

function enhanceDatabaseUrl(url) {
  if (!url) return url;
  const urlObj = new URL(url);
  urlObj.searchParams.set('connection_limit', '1');
  urlObj.searchParams.set('pool_timeout', '10');
  urlObj.searchParams.set('connect_timeout', '5');
  urlObj.searchParams.set('pgbouncer', 'true');
  return urlObj.toString();
}

function parseConnection(urlStr) {
  try {
    const url = new URL(urlStr);
    return {
      host: url.hostname,
      port: url.port || '5432',
      user: url.username,
      db: url.pathname.replace(/^\//, '') || 'postgres',
      isPooler: url.hostname.includes('pooler.supabase.com'),
      isDirect: url.hostname.startsWith('db.') && url.hostname.endsWith('.supabase.co'),
      portNum: parseInt(url.port || '5432', 10),
      hasProjectRefInUser: url.username.includes('.')
    };
  } catch (e) {
    return null;
  }
}

function classifyError(error, info) {
  const message = (error && error.message) || String(error);

  if (message.includes('Environment variable not found: DATABASE_URL')) {
    return { level: 'error', summary: 'DATABASE_URL is not set.' };
  }

  if (message.includes('P1013') || message.includes('scheme is not recognized') || message.includes('invalid database connection string')) {
    return { level: 'error', summary: 'DATABASE_URL is not a valid PostgreSQL connection string.' };
  }

  if (message.includes('no tenant identifier provided') || message.includes('ENOIDENTIFIER')) {
    return {
      level: 'error',
      summary: 'The Supabase pooler could not identify the project.',
      detail: `Use a username like \`postgres.<project-ref>\` instead of \`${info.user}\`. See the README "Database connection" section.`
    };
  }

  if (message.includes("Can't reach database server") || message.includes('Network is unreachable') || message.includes('EAI_AGAIN') || message.includes('ETIMEDOUT')) {
    if (info.portNum === 6543) {
      return {
        level: 'error',
        summary: 'Port 6543 is the Supabase transaction pooler and breaks Prisma migrations.',
        detail: 'Switch to port 5432 (session pooler). See the README "Database connection" section.'
      };
    }
    if (info.isDirect || info.host.startsWith('db.')) {
      return {
        level: 'error',
        summary: `The direct Supabase host ${info.host} is IPv6-only and this environment has no IPv6 route.`,
        detail: 'Use the IPv4 session pooler (aws-1-us-east-2.pooler.supabase.com:5432) with username postgres.<project-ref>. See the README "Database connection" section.'
      };
    }
    return {
      level: 'error',
      summary: `Cannot reach the database server at ${info.host}:${info.port}.`,
      detail: 'Check the hostname, port, and network access. If using Supabase, use the session pooler on port 5432.'
    };
  }

  if (message.includes('Authentication failed')) {
    if (info.isPooler && !info.hasProjectRefInUser) {
      return {
        level: 'error',
        summary: `Authentication failed, and the username \`${info.user}\` is missing the project reference.`,
        detail: 'For the Supabase pooler, use a username like `postgres.<project-ref>` and verify the password.'
      };
    }
    return {
      level: 'error',
      summary: 'Authentication failed.',
      detail: 'Verify the password and username in DATABASE_URL. If using the Supabase pooler, use `postgres.<project-ref>`.'
    };
  }

  if (message.includes('database') && message.includes('does not exist')) {
    return {
      level: 'error',
      summary: `Database "${info.db}" does not exist on ${info.host}:${info.port}.`,
      detail: 'Check the database name in the connection string.'
    };
  }

  if (message.includes('ECONNREFUSED')) {
    return {
      level: 'error',
      summary: `Connection refused at ${info.host}:${info.port}.`,
      detail: 'The host is reachable but nothing is listening on that port.'
    };
  }

  return {
    level: 'error',
    summary: 'Unexpected database connection error.',
    detail: message
  };
}

async function check(label, urlStr) {
  if (!urlStr) {
    console.error(`[${label}] not set.`);
    return false;
  }

  const info = parseConnection(urlStr);
  if (!info) {
    console.error(`[${label}] is not a valid PostgreSQL URL.`);
    return false;
  }

  console.log(`[${label}] Checking ${info.user}@${info.host}:${info.port}/${info.db} ...`);

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: enhanceDatabaseUrl(urlStr)
      }
    },
    log: []
  });

  try {
    await prisma.$queryRaw`SELECT 1 as one`;
    console.log(`[${label}] OK — connected to ${info.host}:${info.port}.`);
    return true;
  } catch (error) {
    const result = classifyError(error, info);
    console.error(`[${label}] ${result.summary}`);
    if (result.detail) {
      console.error(`[${label}] ${result.detail}`);
    }
    return false;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  const databaseOk = await check('DATABASE_URL', process.env.DATABASE_URL);

  if (process.env.DIRECT_URL) {
    await check('DIRECT_URL', process.env.DIRECT_URL);
  } else {
    console.log('[DIRECT_URL] not set. Prisma migrations and introspection require it; set it to the same session pooler or to a direct host if your environment has IPv6.');
  }

  process.exit(databaseOk ? 0 : 1);
}

main();
