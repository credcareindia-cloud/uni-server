/*
  Warnings:

  - The values [SHIPPED,READY_FOR_PRODUCTION,PRE_FABRICATED] on the enum `GroupStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "PanelStatus" AS ENUM ('PLANNING', 'DESIGNED', 'APPROVED', 'IN_PRODUCTION', 'MANUFACTURED', 'QUALITY_CHECK', 'SHIPPED', 'ON_SITE', 'INSTALLED', 'COMPLETED', 'ON_HOLD', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "GroupStatus_new" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD');
ALTER TABLE "groups" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "groups" ALTER COLUMN "status" TYPE "GroupStatus_new" USING ("status"::text::"GroupStatus_new");
ALTER TYPE "GroupStatus" RENAME TO "GroupStatus_old";
ALTER TYPE "GroupStatus_new" RENAME TO "GroupStatus";
DROP TYPE "GroupStatus_old";
ALTER TABLE "groups" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- CreateTable
CREATE TABLE "panels" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "model_id" TEXT,
    "element_id" TEXT,
    "name" TEXT NOT NULL,
    "tag" TEXT,
    "object_type" TEXT,
    "dimensions" TEXT,
    "location" TEXT,
    "material" TEXT,
    "weight" DOUBLE PRECISION,
    "area" DOUBLE PRECISION,
    "status" "PanelStatus" NOT NULL DEFAULT 'PLANNING',
    "group_id" TEXT,
    "production_date" TIMESTAMP(3),
    "shipping_date" TIMESTAMP(3),
    "installation_date" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_status_history" (
    "id" TEXT NOT NULL,
    "panel_id" TEXT NOT NULL,
    "status" "PanelStatus" NOT NULL,
    "notes" TEXT,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "panels_project_id_status_idx" ON "panels"("project_id", "status");

-- CreateIndex
CREATE INDEX "panels_project_id_group_id_idx" ON "panels"("project_id", "group_id");

-- CreateIndex
CREATE INDEX "panels_model_id_idx" ON "panels"("model_id");

-- AddForeignKey
ALTER TABLE "panels" ADD CONSTRAINT "panels_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panels" ADD CONSTRAINT "panels_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panels" ADD CONSTRAINT "panels_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "model_elements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panels" ADD CONSTRAINT "panels_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_status_history" ADD CONSTRAINT "panel_status_history_panel_id_fkey" FOREIGN KEY ("panel_id") REFERENCES "panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_status_history" ADD CONSTRAINT "panel_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
