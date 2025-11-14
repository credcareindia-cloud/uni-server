-- CreateEnum
CREATE TYPE "ModelCategory" AS ENUM ('STRUCTURE', 'MEP', 'ELECTRICAL', 'OTHER');

-- AlterTable
ALTER TABLE "models" ADD COLUMN     "category" "ModelCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "file_index" INTEGER,
ADD COLUMN     "is_multi_file" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "multi_file_job_id" TEXT;
