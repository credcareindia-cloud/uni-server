-- CreateIndex
CREATE INDEX IF NOT EXISTS "model_elements_model_id_global_id_idx" ON "model_elements"("model_id", "global_id");
