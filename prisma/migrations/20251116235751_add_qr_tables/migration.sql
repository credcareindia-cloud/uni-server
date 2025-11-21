CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "qr_codes" (
  "id"          TEXT      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "panel_id"    TEXT      NOT NULL,
  "project_id"  INTEGER   NOT NULL,
  "is_active"   BOOLEAN   NOT NULL DEFAULT true,
  "expires_at"  TIMESTAMP,
  "scan_count"  INTEGER   NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "qr_codes_panel_id_unique" UNIQUE ("panel_id")
);

CREATE INDEX "qr_codes_project_id_idx" ON "qr_codes" ("project_id");
CREATE INDEX "qr_codes_is_active_idx" ON "qr_codes" ("is_active");

CREATE TABLE "qr_scans" (
  "id"          TEXT      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "qr_code_id"  TEXT      NOT NULL,
  "scanned_at"  TIMESTAMP NOT NULL DEFAULT now(),
  "user_agent"  TEXT,
  "ip_address"  TEXT,
  CONSTRAINT "qr_scans_qr_code_id_fkey"
    FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes" ("id")
    ON DELETE CASCADE
);

CREATE INDEX "qr_scans_qr_code_id_idx" ON "qr_scans" ("qr_code_id");
CREATE INDEX "qr_scans_scanned_at_idx" ON "qr_scans" ("scanned_at");
