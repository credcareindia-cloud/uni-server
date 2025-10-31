/*
  Warnings:

  - The values [READY_FOR_PRODUCTION,PRODUCED,PRE_FABRICATED,READY_FOR_TRUCK_LOAD,EDIT] on the enum `PanelStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `custom_status_id` on the `panels` table. All the data in the column will be lost.
  - You are about to drop the `custom_statuses` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PanelStatus_new" AS ENUM ('PLANNING', 'DESIGNED', 'APPROVED', 'IN_PRODUCTION', 'MANUFACTURED', 'QUALITY_CHECK', 'SHIPPED', 'ON_SITE', 'INSTALLED', 'COMPLETED', 'ON_HOLD', 'REJECTED');
ALTER TABLE "panels" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "panels" ALTER COLUMN "status" TYPE "PanelStatus_new" USING ("status"::text::"PanelStatus_new");
ALTER TABLE "panel_status_history" ALTER COLUMN "status" TYPE "PanelStatus_new" USING ("status"::text::"PanelStatus_new");
ALTER TYPE "PanelStatus" RENAME TO "PanelStatus_old";
ALTER TYPE "PanelStatus_new" RENAME TO "PanelStatus";
DROP TYPE "PanelStatus_old";
ALTER TABLE "panels" ALTER COLUMN "status" SET DEFAULT 'PLANNING';
COMMIT;

-- DropForeignKey
ALTER TABLE "custom_statuses" DROP CONSTRAINT "custom_statuses_project_id_fkey";

-- DropForeignKey
ALTER TABLE "panels" DROP CONSTRAINT "panels_custom_status_id_fkey";

-- DropIndex
DROP INDEX "panels_element_id_idx";

-- DropIndex
DROP INDEX "panels_project_id_custom_status_id_idx";

-- AlterTable
ALTER TABLE "panels" DROP COLUMN "custom_status_id",
ALTER COLUMN "status" SET DEFAULT 'PLANNING';

-- DropTable
DROP TABLE "custom_statuses";
