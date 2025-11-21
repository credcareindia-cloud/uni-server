-- /*
--   Warnings:

--   - Made the column `organization_id` on table `notifications` required. This step will fail if there are existing NULL values in that column.

-- */
-- -- DropForeignKey
-- ALTER TABLE "qr_scans" DROP CONSTRAINT "qr_scans_qr_code_id_fkey";

-- -- AlterTable
-- ALTER TABLE "notifications" ALTER COLUMN "organization_id" SET NOT NULL;

-- -- AlterTable
-- ALTER TABLE "qr_codes" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
-- ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
-- ALTER COLUMN "updated_at" DROP DEFAULT,
-- ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- -- AlterTable
-- ALTER TABLE "qr_scans" ALTER COLUMN "id" DROP DEFAULT,
-- ALTER COLUMN "scanned_at" SET DATA TYPE TIMESTAMP(3);

-- -- AlterTable
-- ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'ADMIN';

-- -- AddForeignKey
-- ALTER TABLE "qr_scans" ADD CONSTRAINT "qr_scans_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -- RenameIndex
-- ALTER INDEX "qr_codes_panel_id_unique" RENAME TO "qr_codes_panel_id_key";
