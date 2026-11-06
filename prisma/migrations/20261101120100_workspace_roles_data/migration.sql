-- Manager is now Designer. Empty permission lists keep the role defaults.
UPDATE "users" SET "role" = 'DESIGNER' WHERE "role" = 'MANAGER';

UPDATE "users"
SET "permissions" = ARRAY['projects.view','projects.edit','viewer','drawings','panels','alerts']::TEXT[]
WHERE "role" = 'DESIGNER' AND cardinality("permissions") = 0;

UPDATE "users"
SET "permissions" = ARRAY['projects.view','viewer','drawings','alerts']::TEXT[]
WHERE "role" = 'VIEWER' AND cardinality("permissions") = 0;

UPDATE "users"
SET "permissions" = ARRAY['projects.view','projects.edit','viewer','drawings','panels','estimate.view','estimate.edit','logistics','production','alerts','admin']::TEXT[]
WHERE "role" = 'ADMIN' AND cardinality("permissions") = 0;
