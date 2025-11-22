-- CreateTable
CREATE TABLE "user_panel_views" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "panel_id" TEXT NOT NULL,
    "last_viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_viewed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_panel_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_panel_views_user_id_panel_id_key" ON "user_panel_views"("user_id", "panel_id");

-- CreateIndex
CREATE INDEX "user_panel_views_user_id_idx" ON "user_panel_views"("user_id");

-- CreateIndex
CREATE INDEX "user_panel_views_panel_id_idx" ON "user_panel_views"("panel_id");

-- AddForeignKey
ALTER TABLE "user_panel_views" ADD CONSTRAINT "user_panel_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
