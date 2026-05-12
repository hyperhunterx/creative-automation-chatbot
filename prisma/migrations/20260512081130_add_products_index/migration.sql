-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Products table
CREATE TABLE "products" (
  "id"                TEXT PRIMARY KEY,
  "handle"            TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "vendor"            TEXT,
  "productType"       TEXT,
  "category"          TEXT,
  "tags"              TEXT[] NOT NULL DEFAULT '{}',
  "description"       TEXT,
  "priceMin"          DECIMAL(12,2),
  "priceMax"          DECIMAL(12,2),
  "currency"          TEXT,
  "imageUrl"          TEXT,
  "available"         BOOLEAN NOT NULL DEFAULT true,
  "specs"             JSONB NOT NULL DEFAULT '{}'::jsonb,
  "variants"          JSONB NOT NULL DEFAULT '[]'::jsonb,
  "shopifyUpdatedAt"  TIMESTAMPTZ,
  "searchTsv"         tsvector,
  "embedding"         vector(1024),
  "deletedAt"         TIMESTAMPTZ,
  "indexedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: updatedAt is managed by Prisma client (@updatedAt). Direct SQL
  -- inserts/updates must set it explicitly — there is no DB-level ON UPDATE.
);
-- NOTE: embedding column is vector(1024) — matches Voyage voyage-3-lite output

-- Btree indexes for filter columns
CREATE INDEX "products_handle_idx"     ON "products" ("handle");
CREATE INDEX "products_vendor_idx"     ON "products" ("vendor");
CREATE INDEX "products_category_idx"   ON "products" ("category");
CREATE INDEX "products_deletedAt_idx"  ON "products" ("deletedAt");

-- GIN index for full-text search on searchTsv
CREATE INDEX "products_search_tsv_idx" ON "products" USING GIN ("searchTsv");

-- GIN index for jsonb specs containment queries
CREATE INDEX "products_specs_idx"      ON "products" USING GIN ("specs");

-- HNSW index for vector cosine similarity
CREATE INDEX "products_embedding_idx"  ON "products"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Auto-update searchTsv from title + vendor + tags + description + variant SKUs.
-- If a future column is added to the searchable text set, extend BOTH this
-- function body AND the trigger's `OF` clause below.
CREATE OR REPLACE FUNCTION products_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."searchTsv" :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.vendor, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'B')
    || setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'C')
    || setweight(to_tsvector('simple',
         coalesce(
           (SELECT string_agg(v->>'sku', ' ')
              -- Guard against non-array variants payloads (e.g. webhook sends {})
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(NEW.variants) = 'array'
                     THEN NEW.variants
                     ELSE '[]'::jsonb
                END
              ) v
              WHERE v ? 'sku'),
           ''
         )), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_tsv_trigger
  BEFORE INSERT OR UPDATE OF title, vendor, tags, description, variants
  ON "products"
  FOR EACH ROW EXECUTE FUNCTION products_search_tsv_update();
