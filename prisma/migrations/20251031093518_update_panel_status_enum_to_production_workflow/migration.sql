/*
  Warnings:

  - The values [PLANNING,DESIGNED,APPROVED,IN_PRODUCTION,MANUFACTURED,QUALITY_CHECK,ON_SITE,INSTALLED,COMPLETED,ON_HOLD,REJECTED] on the enum `PanelStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum with data migration
BEGIN;
CREATE TYPE "PanelStatus_new" AS ENUM ('READY_FOR_PRODUCTION', 'PRODUCED', 'PRE_FABRICATED', 'READY_FOR_TRUCK_LOAD', 'SHIPPED', 'EDIT');

-- Migrate existing panel status data
ALTER TABLE "panels" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "panels" ALTER COLUMN "status" TYPE "PanelStatus_new" USING (
  CASE 
    WHEN "status"::text IN ('PLANNING', 'DESIGNED', 'APPROVED') THEN 'READY_FOR_PRODUCTION'
    WHEN "status"::text IN ('IN_PRODUCTION', 'MANUFACTURED', 'QUALITY_CHECK') THEN 'PRODUCED'
    WHEN "status"::text = 'SHIPPED' THEN 'SHIPPED'
    WHEN "status"::text IN ('ON_SITE', 'INSTALLED') THEN 'PRE_FABRICATED'
    WHEN "status"::text IN ('COMPLETED', 'ON_HOLD', 'REJECTED') THEN 'EDIT'
    ELSE 'READY_FOR_PRODUCTION'
  END::"PanelStatus_new"
);

-- Migrate panel status history
ALTER TABLE "panel_status_history" ALTER COLUMN "status" TYPE "PanelStatus_new" USING (
  CASE 
    WHEN "status"::text IN ('PLANNING', 'DESIGNED', 'APPROVED') THEN 'READY_FOR_PRODUCTION'
    WHEN "status"::text IN ('IN_PRODUCTION', 'MANUFACTURED', 'QUALITY_CHECK') THEN 'PRODUCED'
    WHEN "status"::text = 'SHIPPED' THEN 'SHIPPED'
    WHEN "status"::text IN ('ON_SITE', 'INSTALLED') THEN 'PRE_FABRICATED'
    WHEN "status"::text IN ('COMPLETED', 'ON_HOLD', 'REJECTED') THEN 'EDIT'
    ELSE 'READY_FOR_PRODUCTION'
  END::"PanelStatus_new"
);

ALTER TYPE "PanelStatus" RENAME TO "PanelStatus_old";
ALTER TYPE "PanelStatus_new" RENAME TO "PanelStatus";
DROP TYPE "PanelStatus_old";
ALTER TABLE "panels" ALTER COLUMN "status" SET DEFAULT 'READY_FOR_PRODUCTION';
COMMIT;

-- AlterTable
ALTER TABLE "panels" ADD COLUMN     "custom_status_id" TEXT,
ALTER COLUMN "status" SET DEFAULT 'READY_FOR_PRODUCTION';

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

-- AddForeignKey
ALTER TABLE "panels" ADD CONSTRAINT "panels_custom_status_id_fkey" FOREIGN KEY ("custom_status_id") REFERENCES "custom_statuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_statuses" ADD CONSTRAINT "custom_statuses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
