-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING';
