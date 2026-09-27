-- Site analytics: raw request samples, browser events, server errors and
-- security events, plus the nightly rollup tables. See services/analytics/.
--
-- Nothing reads these tables on a request path that must succeed: the writers
-- swallow their own failures, so a deploy that reaches the new code before this
-- has run only loses analytics rows, never a request.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "analytics_request_samples" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "userId" TEXT,
    "ip" TEXT,

    CONSTRAINT "analytics_request_samples_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "analytics_request_samples_at_idx" ON "analytics_request_samples"("at");
CREATE INDEX IF NOT EXISTS "analytics_request_samples_route_at_idx" ON "analytics_request_samples"("route", "at");

CREATE TABLE IF NOT EXISTS "analytics_client_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT,
    "value" DOUBLE PRECISION,
    "meta" JSONB,

    CONSTRAINT "analytics_client_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "analytics_client_events_at_idx" ON "analytics_client_events"("at");
CREATE INDEX IF NOT EXISTS "analytics_client_events_type_at_idx" ON "analytics_client_events"("type", "at");
CREATE INDEX IF NOT EXISTS "analytics_client_events_sessionId_idx" ON "analytics_client_events"("sessionId");

CREATE TABLE IF NOT EXISTS "server_error_logs" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "route" TEXT,
    "status" INTEGER,
    "fingerprint" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "server_error_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "server_error_logs_at_idx" ON "server_error_logs"("at");
CREATE INDEX IF NOT EXISTS "server_error_logs_fingerprint_at_idx" ON "server_error_logs"("fingerprint", "at");

CREATE TABLE IF NOT EXISTS "security_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT NOT NULL,
    "ip" TEXT,
    "path" TEXT,
    "method" TEXT,
    "status" INTEGER,
    "detail" JSONB,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "security_events_at_idx" ON "security_events"("at");
CREATE INDEX IF NOT EXISTS "security_events_kind_at_idx" ON "security_events"("kind", "at");
CREATE INDEX IF NOT EXISTS "security_events_severity_at_idx" ON "security_events"("severity", "at");
CREATE INDEX IF NOT EXISTS "security_events_ip_at_idx" ON "security_events"("ip", "at");

CREATE TABLE IF NOT EXISTS "analytics_daily_summaries" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "role" TEXT NOT NULL,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "pageViews" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "apiRequests" INTEGER NOT NULL DEFAULT 0,
    "apiErrors4xx" INTEGER NOT NULL DEFAULT 0,
    "apiErrors5xx" INTEGER NOT NULL DEFAULT 0,
    "p50Ms" INTEGER,
    "p95Ms" INTEGER,
    "jsErrors" INTEGER NOT NULL DEFAULT 0,
    "serverErrors" INTEGER NOT NULL DEFAULT 0,
    "securityWarn" INTEGER NOT NULL DEFAULT 0,
    "securityCritical" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_daily_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_daily_summaries_day_role_key" ON "analytics_daily_summaries"("day", "role");

CREATE TABLE IF NOT EXISTS "analytics_daily_facts" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "p50Ms" INTEGER,
    "p95Ms" INTEGER,
    "maxMs" INTEGER,

    CONSTRAINT "analytics_daily_facts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_daily_facts_day_kind_role_key_key" ON "analytics_daily_facts"("day", "kind", "role", "key");
CREATE INDEX IF NOT EXISTS "analytics_daily_facts_day_kind_idx" ON "analytics_daily_facts"("day", "kind");
