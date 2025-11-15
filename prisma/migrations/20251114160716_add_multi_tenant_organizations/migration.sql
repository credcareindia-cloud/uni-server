/*
  Multi-tenant organization system migration
  This migration:
  1. Creates organizations table
  2. Creates a default organization for existing data
  3. Assigns all existing users and projects to the default organization
  4. Changes default user role to ADMIN for new signups
*/

-- Step 1: Create organizations table
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- Step 2: Create unique index for organization slug
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- Step 3: Insert default organization for existing data
INSERT INTO "organizations" ("id", "name", "slug", "description", "created_at", "updated_at")
VALUES ('default-org-id', 'Default Organization', 'default', 'Default organization for existing data', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Step 4: Add organization_id column to users table with default value
ALTER TABLE "users" ADD COLUMN "organization_id" TEXT DEFAULT 'default-org-id';

-- Step 5: Update all existing users to belong to default organization
UPDATE "users" SET "organization_id" = 'default-org-id' WHERE "organization_id" IS NULL;

-- Step 6: Make organization_id NOT NULL and change default user role
ALTER TABLE "users" ALTER COLUMN "organization_id" SET NOT NULL,
ALTER COLUMN "organization_id" DROP DEFAULT,
ALTER COLUMN "role" SET DEFAULT 'ADMIN';

-- Step 7: Add organization_id column to projects table with default value
ALTER TABLE "projects" ADD COLUMN "organization_id" TEXT DEFAULT 'default-org-id';

-- Step 8: Update all existing projects to belong to default organization
UPDATE "projects" SET "organization_id" = 'default-org-id' WHERE "organization_id" IS NULL;

-- Step 9: Make organization_id NOT NULL for projects
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL,
ALTER COLUMN "organization_id" DROP DEFAULT;

-- Step 10: Add foreign key constraints
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
