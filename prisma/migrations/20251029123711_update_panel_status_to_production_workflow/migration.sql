/*
  Warnings:

  - The values [PLANNING,DESIGNED,APPROVED,IN_PRODUCTION,MANUFACTURED,QUALITY_CHECK,ON_SITE,INSTALLED,COMPLETED,ON_HOLD,REJECTED] on the enum `PanelStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PanelStatus_new" AS ENUM ('READY_FOR_PRODUCTION', 'PRODUCED', 'PRE_FABRICATED', 'READY_FOR_TRUCK_LOAD', 'SHIPPED', 'EDIT');
ALTER TABLE "panels" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "panels" ALTER COLUMN "status" TYPE "PanelStatus_new" USING ("status"::text::"PanelStatus_new");
ALTER TABLE "panel_status_history" ALTER COLUMN "status" TYPE "PanelStatus_new" USING ("status"::text::"PanelStatus_new");
ALTER TYPE "PanelStatus" RENAME TO "PanelStatus_old";
ALTER TYPE "PanelStatus_new" RENAME TO "PanelStatus";
DROP TYPE "PanelStatus_old";
ALTER TABLE "panels" ALTER COLUMN "status" SET DEFAULT 'EDIT';
COMMIT;

-- AlterTable
ALTER TABLE "panels" ALTER COLUMN "status" SET DEFAULT 'EDIT';
