-- CreateEnum
CREATE TYPE "NotificationRole" AS ENUM ('ADMIN', 'MANAGER', 'VIEWER', 'BOTH', 'ALL');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "organization_id" TEXT,
ADD COLUMN "recipient_role" "NotificationRole" NOT NULL DEFAULT 'ADMIN';

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "notifications_organization_id_idx" ON "notifications"("organization_id");
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");
