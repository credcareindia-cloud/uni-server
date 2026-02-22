-- Migration: fix_panel_fk_on_delete_set_null
-- Changes Panel.modelId and Panel.elementId FK constraints from RESTRICT (default)
-- to SET NULL, so that deleting a Model or ModelElement automatically nullifies
-- the reference on Panel rows instead of blocking the delete with a FK violation.
-- This is a safe, non-destructive schema change (no data is modified).

-- Drop old FK constraints on panels
ALTER TABLE "panels" DROP CONSTRAINT IF EXISTS "panels_model_id_fkey";
ALTER TABLE "panels" DROP CONSTRAINT IF EXISTS "panels_element_id_fkey";

-- Re-add FK constraints with ON DELETE SET NULL
ALTER TABLE "panels"
  ADD CONSTRAINT "panels_model_id_fkey"
  FOREIGN KEY ("model_id")
  REFERENCES "models"("id")
  ON DELETE SET NULL;

ALTER TABLE "panels"
  ADD CONSTRAINT "panels_element_id_fkey"
  FOREIGN KEY ("element_id")
  REFERENCES "model_elements"("id")
  ON DELETE SET NULL;
