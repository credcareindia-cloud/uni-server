/*
  Warnings:

  - The values [UPLOADED] on the enum `ModelStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `custom_status_id` on the `panels` table. All the data in the column will be lost.
  - You are about to drop the column `group_id` on the `panels` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `panels` table. All the data in the column will be lost.
  - You are about to drop the `custom_statuses` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `panel_custom_statuses` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `panel_status_history` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ModelStatus_new" AS ENUM ('PROCESSING', 'READY', 'FAILED');
ALTER TABLE "models" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "models" ALTER COLUMN "status" TYPE "ModelStatus_new" USING ("status"::text::"ModelStatus_new");
ALTER TYPE "ModelStatus" RENAME TO "ModelStatus_old";
ALTER TYPE "ModelStatus_new" RENAME TO "ModelStatus";
DROP TYPE "ModelStatus_old";
ALTER TABLE "models" ALTER COLUMN "status" SET DEFAULT 'READY';
COMMIT;

-- DropForeignKey
ALTER TABLE "custom_statuses" DROP CONSTRAINT "custom_statuses_project_id_fkey";

-- DropForeignKey
ALTER TABLE "panel_custom_statuses" DROP CONSTRAINT "panel_custom_statuses_assigned_by_fkey";

-- DropForeignKey
ALTER TABLE "panel_custom_statuses" DROP CONSTRAINT "panel_custom_statuses_custom_status_id_fkey";

-- DropForeignKey
ALTER TABLE "panel_custom_statuses" DROP CONSTRAINT "panel_custom_statuses_panel_id_fkey";

-- DropForeignKey
ALTER TABLE "panel_status_history" DROP CONSTRAINT "panel_status_history_changed_by_fkey";

-- DropForeignKey
ALTER TABLE "panel_status_history" DROP CONSTRAINT "panel_status_history_panel_id_fkey";

-- DropForeignKey
ALTER TABLE "panels" DROP CONSTRAINT "panels_custom_status_id_fkey";

-- DropForeignKey
ALTER TABLE "panels" DROP CONSTRAINT "panels_group_id_fkey";

-- DropIndex
DROP INDEX "panels_project_id_custom_status_id_idx";

-- DropIndex
DROP INDEX "panels_project_id_group_id_idx";

-- DropIndex
DROP INDEX "panels_project_id_status_idx";

-- AlterTable
ALTER TABLE "panels" DROP COLUMN "custom_status_id",
DROP COLUMN "group_id",
DROP COLUMN "status";

-- DropTable
DROP TABLE "custom_statuses";

-- DropTable
DROP TABLE "panel_custom_statuses";

-- DropTable
DROP TABLE "panel_status_history";

-- DropEnum
DROP TYPE "PanelStatus";

-- CreateTable
CREATE TABLE "statuses" (
    "id" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'circle',
    "color" TEXT NOT NULL DEFAULT '#3B82F6',
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_statuses" (
    "id" TEXT NOT NULL,
    "panel_id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT,

    CONSTRAINT "panel_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_groups" (
    "id" TEXT NOT NULL,
    "panel_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT,

    CONSTRAINT "panel_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" TEXT NOT NULL,
    "panel_id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "notes" TEXT,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "statuses_project_id_idx" ON "statuses"("project_id");

-- CreateIndex
CREATE INDEX "statuses_project_id_order_idx" ON "statuses"("project_id", "order");

-- CreateIndex
CREATE INDEX "panel_statuses_panel_id_idx" ON "panel_statuses"("panel_id");

-- CreateIndex
CREATE INDEX "panel_statuses_status_id_idx" ON "panel_statuses"("status_id");

-- CreateIndex
CREATE UNIQUE INDEX "panel_statuses_panel_id_status_id_key" ON "panel_statuses"("panel_id", "status_id");

-- CreateIndex
CREATE INDEX "panel_groups_panel_id_idx" ON "panel_groups"("panel_id");

-- CreateIndex
CREATE INDEX "panel_groups_group_id_idx" ON "panel_groups"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "panel_groups_panel_id_group_id_key" ON "panel_groups"("panel_id", "group_id");

-- CreateIndex
CREATE INDEX "status_history_panel_id_idx" ON "status_history"("panel_id");

-- CreateIndex
CREATE INDEX "status_history_status_id_idx" ON "status_history"("status_id");

-- CreateIndex
CREATE INDEX "groups_project_id_idx" ON "groups"("project_id");

-- CreateIndex
CREATE INDEX "panels_project_id_idx" ON "panels"("project_id");

-- AddForeignKey
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_statuses" ADD CONSTRAINT "panel_statuses_panel_id_fkey" FOREIGN KEY ("panel_id") REFERENCES "panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_statuses" ADD CONSTRAINT "panel_statuses_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_statuses" ADD CONSTRAINT "panel_statuses_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_groups" ADD CONSTRAINT "panel_groups_panel_id_fkey" FOREIGN KEY ("panel_id") REFERENCES "panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_groups" ADD CONSTRAINT "panel_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_groups" ADD CONSTRAINT "panel_groups_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_panel_id_fkey" FOREIGN KEY ("panel_id") REFERENCES "panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
