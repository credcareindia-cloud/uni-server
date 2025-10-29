/*
  Warnings:

  - The values [IFC] on the enum `ModelType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `ifc_schema` on the `models` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[replaced_by_id]` on the table `models` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[current_model_id]` on the table `projects` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ModelType_new" AS ENUM ('FRAG');
ALTER TABLE "models" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "models" ALTER COLUMN "type" TYPE "ModelType_new" USING ("type"::text::"ModelType_new");
ALTER TYPE "ModelType" RENAME TO "ModelType_old";
ALTER TYPE "ModelType_new" RENAME TO "ModelType";
DROP TYPE "ModelType_old";
ALTER TABLE "models" ALTER COLUMN "type" SET DEFAULT 'FRAG';
COMMIT;

-- AlterTable
ALTER TABLE "models" DROP COLUMN "ifc_schema",
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "replaced_by_id" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "type" SET DEFAULT 'FRAG',
ALTER COLUMN "status" SET DEFAULT 'READY',
ALTER COLUMN "processing_progress" SET DEFAULT 100;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "current_model_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "models_replaced_by_id_key" ON "models"("replaced_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_current_model_id_key" ON "projects"("current_model_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_model_id_fkey" FOREIGN KEY ("current_model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
