-- CreateEnum
CREATE TYPE "ProjectDeletionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "project_deletions" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "project_name" TEXT NOT NULL,
    "status" "ProjectDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "deleted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "project_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_deletions_project_id_idx" ON "project_deletions"("project_id");

-- CreateIndex
CREATE INDEX "project_deletions_status_idx" ON "project_deletions"("status");

-- CreateIndex
CREATE INDEX "project_deletions_deleted_by_idx" ON "project_deletions"("deleted_by");
