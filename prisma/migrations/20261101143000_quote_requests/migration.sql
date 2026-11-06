CREATE TYPE "QuoteSource" AS ENUM ('WEB', 'MANUAL');
CREATE TYPE "QuoteStatus" AS ENUM ('NEW', 'IN_REVIEW', 'STARTED');

CREATE TABLE "quote_requests" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "project_name" TEXT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "drawing_key" TEXT,
  "drawing_name" TEXT,
  "model_key" TEXT,
  "model_name" TEXT,
  "source" "QuoteSource" NOT NULL DEFAULT 'WEB',
  "status" "QuoteStatus" NOT NULL DEFAULT 'NEW',
  "project_id" INTEGER,
  "estimate_id" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "quote_requests_organization_id_idx" ON "quote_requests"("organization_id");
CREATE INDEX "quote_requests_project_id_idx" ON "quote_requests"("project_id");

ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
