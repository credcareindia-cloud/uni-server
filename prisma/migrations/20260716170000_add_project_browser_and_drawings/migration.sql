-- CreateEnum
CREATE TYPE "DrawingKind" AS ENUM ('VIEW', 'SHEET');

-- CreateTable
CREATE TABLE "project_browser_revisions" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "publish_job_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_browser_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_drawings" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "publish_job_id" TEXT NOT NULL,
    "stable_key" TEXT NOT NULL,
    "kind" "DrawingKind" NOT NULL,
    "name" TEXT NOT NULL,
    "sheet_number" TEXT,
    "view_type" TEXT,
    "revit_element_id" INTEGER,
    "dxf_storage_key" TEXT,
    "dwg_storage_key" TEXT,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_drawings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_browser_revisions_publish_job_id_key" ON "project_browser_revisions"("publish_job_id");

-- CreateIndex
CREATE INDEX "project_browser_revisions_project_id_idx" ON "project_browser_revisions"("project_id");

-- CreateIndex
CREATE INDEX "project_drawings_project_id_idx" ON "project_drawings"("project_id");

-- CreateIndex
CREATE INDEX "project_drawings_publish_job_id_idx" ON "project_drawings"("publish_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_drawings_publish_job_id_stable_key_key" ON "project_drawings"("publish_job_id", "stable_key");

-- AddForeignKey
ALTER TABLE "project_browser_revisions" ADD CONSTRAINT "project_browser_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_drawings" ADD CONSTRAINT "project_drawings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
