-- AlterTable
ALTER TABLE "panels" ADD COLUMN     "custom_status_id" TEXT;

-- CreateTable
CREATE TABLE "custom_statuses" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'circle',
    "color" TEXT NOT NULL DEFAULT '#3B82F6',
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_statuses_project_id_idx" ON "custom_statuses"("project_id");

-- CreateIndex
CREATE INDEX "panels_project_id_custom_status_id_idx" ON "panels"("project_id", "custom_status_id");

-- CreateIndex
CREATE INDEX "panels_element_id_idx" ON "panels"("element_id");

-- AddForeignKey
ALTER TABLE "custom_statuses" ADD CONSTRAINT "custom_statuses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panels" ADD CONSTRAINT "panels_custom_status_id_fkey" FOREIGN KEY ("custom_status_id") REFERENCES "custom_statuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
