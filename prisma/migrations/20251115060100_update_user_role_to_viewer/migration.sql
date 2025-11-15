-- Drop the default constraint first
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;

-- Add VIEWER to enum (will be added but can't be used yet due to transaction isolation)
ALTER TYPE "UserRole" ADD VALUE 'VIEWER' BEFORE 'USER';

-- Create new enum without USER  
CREATE TYPE "UserRole_new" AS ENUM ('VIEWER', 'MANAGER', 'ADMIN');

-- Convert column type and data in one statement
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING (CASE WHEN "role"::text = 'USER' THEN 'VIEWER'::"UserRole_new" ELSE "role"::text::"UserRole_new" END);

-- Drop the old enum and rename the new one
DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";

-- Set the new default
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'VIEWER'::"UserRole";
