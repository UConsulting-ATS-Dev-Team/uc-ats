-- Admin-editable wording and score ranges for the document grading rubrics.
-- No row, or no table, means the rubric the code ships - readers fall back to
-- it rather than failing, so a deploy can reach grading before anyone has run
-- this.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "document_rubrics" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rubric" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_rubrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_rubrics_type_key" ON "document_rubrics"("type");
