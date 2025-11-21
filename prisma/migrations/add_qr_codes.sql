-- -- CreateTable
-- CREATE TABLE "qr_codes" (
--     "id" TEXT NOT NULL,
--     "panel_id" TEXT NOT NULL,
--     "project_id" INTEGER NOT NULL,
--     "is_active" BOOLEAN NOT NULL DEFAULT true,
--     "expires_at" TIMESTAMP(3),
--     "scan_count" INTEGER NOT NULL DEFAULT 0,
--     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
--     "updated_at" TIMESTAMP(3) NOT NULL,

--     CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
-- );

-- -- CreateTable
-- CREATE TABLE "qr_scans" (
--     "id" TEXT NOT NULL,
--     "qr_code_id" TEXT NOT NULL,
--     "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
--     "user_agent" TEXT,
--     "ip_address" TEXT,

--     CONSTRAINT "qr_scans_pkey" PRIMARY KEY ("id")
-- );

-- -- CreateIndex
-- CREATE UNIQUE INDEX "qr_codes_panel_id_key" ON "qr_codes"("panel_id");

-- -- CreateIndex
-- CREATE INDEX "qr_codes_project_id_idx" ON "qr_codes"("project_id");

-- -- CreateIndex
-- CREATE INDEX "qr_codes_is_active_idx" ON "qr_codes"("is_active");

-- -- CreateIndex
-- CREATE INDEX "qr_scans_qr_code_id_idx" ON "qr_scans"("qr_code_id");

-- -- CreateIndex
-- CREATE INDEX "qr_scans_scanned_at_idx" ON "qr_scans"("scanned_at");

-- -- AddForeignKey
-- ALTER TABLE "qr_scans" ADD CONSTRAINT "qr_scans_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
