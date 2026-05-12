-- Add last-shown retrieval state to Conversation for v6 query understanding.
ALTER TABLE "Conversation"
  ADD COLUMN "lastShownCategory" TEXT,
  ADD COLUMN "lastShownBrands"   TEXT[] NOT NULL DEFAULT '{}';
