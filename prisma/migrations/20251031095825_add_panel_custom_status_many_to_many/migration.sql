-- CreateTable
CREATE TABLE "panel_custom_statuses" (
    "id" TEXT NOT NULL,
    "panel_id" TEXT NOT NULL,
    "custom_status_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT,

    CONSTRAINT "panel_custom_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "panel_custom_statuses_panel_id_idx" ON "panel_custom_statuses"("panel_id");

-- CreateIndex
CREATE INDEX "panel_custom_statuses_custom_status_id_idx" ON "panel_custom_statuses"("custom_status_id");

-- CreateIndex
CREATE UNIQUE INDEX "panel_custom_statuses_panel_id_custom_status_id_key" ON "panel_custom_statuses"("panel_id", "custom_status_id");

-- AddForeignKey
ALTER TABLE "panel_custom_statuses" ADD CONSTRAINT "panel_custom_statuses_panel_id_fkey" FOREIGN KEY ("panel_id") REFERENCES "panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_custom_statuses" ADD CONSTRAINT "panel_custom_statuses_custom_status_id_fkey" FOREIGN KEY ("custom_status_id") REFERENCES "custom_statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_custom_statuses" ADD CONSTRAINT "panel_custom_statuses_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
