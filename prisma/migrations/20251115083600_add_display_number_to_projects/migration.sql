-- Add display_number column to projects table
ALTER TABLE "projects" ADD COLUMN "display_number" INTEGER NOT NULL DEFAULT 0;

-- Backfill display_number with sequential numbers per organization
WITH ranked_projects AS (
  SELECT 
    id, 
    organization_id,
    ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at ASC, id ASC) as seq_number
  FROM "projects"
)
UPDATE "projects" p
SET display_number = rp.seq_number
FROM ranked_projects rp
WHERE p.id = rp.id;

-- Add unique constraint on (organization_id, display_number)
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_display_number_key" UNIQUE ("organization_id", "display_number");

-- Add index on organization_id for faster queries
CREATE INDEX "projects_organization_id_idx" ON "projects"("organization_id");

-- Remove the default now that we've backfilled
ALTER TABLE "projects" ALTER COLUMN "display_number" DROP DEFAULT;
