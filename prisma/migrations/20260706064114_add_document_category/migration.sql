-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('DRAWINGS', 'LOGISTICS', 'CNC');

-- AlterTable
ALTER TABLE "project_documents" ADD COLUMN     "category" "DocumentCategory" NOT NULL DEFAULT 'DRAWINGS';

-- CreateIndex
CREATE INDEX "project_documents_project_id_category_idx" ON "project_documents"("project_id", "category");
