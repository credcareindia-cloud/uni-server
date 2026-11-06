-- CreateEnum
CREATE TYPE "ProjectStage" AS ENUM ('TENDER', 'PROJECT');

-- AlterTable
-- Existing projects were all created through model upload, so they are already
-- past tendering; the default backfills them correctly.
ALTER TABLE "projects" ADD COLUMN "stage" "ProjectStage" NOT NULL DEFAULT 'PROJECT';
