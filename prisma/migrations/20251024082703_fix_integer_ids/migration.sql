/*
  Warnings:

  - The primary key for the `projects` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `projects` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `project_id` on the `groups` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `project_id` on the `models` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "groups" DROP CONSTRAINT "groups_project_id_fkey";

-- DropForeignKey
ALTER TABLE "models" DROP CONSTRAINT "models_project_id_fkey";

-- AlterTable
ALTER TABLE "groups" DROP COLUMN "project_id",
ADD COLUMN     "project_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "models" DROP COLUMN "project_id",
ADD COLUMN     "project_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "projects" DROP CONSTRAINT "projects_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
