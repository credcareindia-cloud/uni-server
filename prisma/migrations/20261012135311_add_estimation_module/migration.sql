-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'ISSUED', 'WON', 'LOST', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('FULL', 'PASS_THROUGH');

-- CreateEnum
CREATE TYPE "TakeoffSource" AS ENUM ('MANUAL', 'DRAWING', 'BIM_MODEL');

-- CreateTable
CREATE TABLE "estimates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" INTEGER,
    "job_number" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client" TEXT,
    "location" TEXT,
    "consultant" TEXT,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "fx_rate" DOUBLE PRECISION NOT NULL DEFAULT 3.67,
    "total_area" DOUBLE PRECISION,
    "overhead_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "margin_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "financing_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "contingency_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "customs_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "corporate_tax_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "design_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "commission_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.07,
    "total_amount" DOUBLE PRECISION,
    "source_file" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_lines" (
    "id" TEXT NOT NULL,
    "estimate_id" TEXT NOT NULL,
    "slNo" TEXT,
    "bill" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mode" "PricingMode" NOT NULL DEFAULT 'FULL',
    "material_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fabrication_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "installation_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prelims_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shipping_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "packaging_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loading_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sell_rate" DOUBLE PRECISION,
    "total_amount" DOUBLE PRECISION,
    "takeoff_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "takeoff_items" (
    "id" TEXT NOT NULL,
    "estimate_id" TEXT NOT NULL,
    "storey" TEXT,
    "description" TEXT NOT NULL,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "area" DOUBLE PRECISION,
    "total_area" DOUBLE PRECISION,
    "total_sqft" DOUBLE PRECISION,
    "source" "TakeoffSource" NOT NULL DEFAULT 'MANUAL',
    "source_ref" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "takeoff_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_items" (
    "id" TEXT NOT NULL,
    "rate_card_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT,
    "unit_rate" DOUBLE PRECISION,
    "sqft_rate" DOUBLE PRECISION,
    "labour_per_sqft" DOUBLE PRECISION,
    "supplier" TEXT,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "estimates_organization_id_idx" ON "estimates"("organization_id");

-- CreateIndex
CREATE INDEX "estimates_project_id_idx" ON "estimates"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "estimates_organization_id_job_number_revision_key" ON "estimates"("organization_id", "job_number", "revision");

-- CreateIndex
CREATE INDEX "estimate_lines_estimate_id_idx" ON "estimate_lines"("estimate_id");

-- CreateIndex
CREATE INDEX "takeoff_items_estimate_id_idx" ON "takeoff_items"("estimate_id");

-- CreateIndex
CREATE INDEX "rate_cards_organization_id_idx" ON "rate_cards"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_organization_id_name_version_key" ON "rate_cards"("organization_id", "name", "version");

-- CreateIndex
CREATE INDEX "rate_items_rate_card_id_idx" ON "rate_items"("rate_card_id");

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_takeoff_item_id_fkey" FOREIGN KEY ("takeoff_item_id") REFERENCES "takeoff_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takeoff_items" ADD CONSTRAINT "takeoff_items_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_items" ADD CONSTRAINT "rate_items_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

