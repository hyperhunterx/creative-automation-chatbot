-- Adds normalized brand and tag-derived category fields used by v6 retrieval
-- filters. The existing `vendor` / `productType` / `category` columns are kept
-- for backward compat and display; only the new columns are SQL-filtered on.

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "vendorNormalized" TEXT,
  ADD COLUMN IF NOT EXISTS "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill from anything already indexed. categories backfill is impossible
-- from existing rows (the brand-stripping rule needs the original tag list),
-- so a subsequent bootstrap re-run will populate it.
UPDATE "products"
SET "vendorNormalized" = lower(trim(vendor))
WHERE vendor IS NOT NULL AND "vendorNormalized" IS NULL;

CREATE INDEX IF NOT EXISTS "products_vendorNormalized_idx"
  ON "products" ("vendorNormalized");

CREATE INDEX IF NOT EXISTS "products_categories_gin_idx"
  ON "products" USING GIN ("categories");
